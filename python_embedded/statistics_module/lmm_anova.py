"""
Linear mixed model ANOVA backend.
"""

from __future__ import annotations

import itertools
import math
import re
import warnings
from dataclasses import dataclass
from typing import Any, Dict, Sequence

import numpy as np
import pandas as pd
from patsy import build_design_matrices
from scipy import optimize, stats
from statsmodels.formula.api import mixedlm
from statsmodels.stats.libqsturng import psturng, qsturng
from statsmodels.stats.multitest import multipletests

from .adjustment_utils import get_method_label
from .lmm_inference_core import (
    contract_cov_jacobian,
    effective_rank,
    infer_1d_from_df,
    infer_md_from_df,
    quad_form_vec,
    satterthwaite_df_1d,
    satterthwaite_df_md,
)
from .lmm_inference_kr import build_kr_inference_bundle, infer_kr_1d, infer_kr_md
from .lmm_inference_satterthwaite import numerical_cov_beta_jacobian
from .lmm_parameterization import (
    _numerical_hessian,
    cov_beta_from_finite_df_varpar,
    extract_finite_df_varpar_spec,
    finite_df_negloglike_from_varpar,
)
from .lmm_type3 import build_type3_contrasts_from_matrices
from .utils import format_number


ALLOWED_ADJUSTMENTS = {
    "tukey",
    "bonferroni",
    "holm",
    "holm-sidak",
    "sidak",
    "dunnett",
    "fdr_bh",
}
ALLOWED_DF_METHODS = {"satterthwaite", "kenward_roger", "asymptotic", "residual"}
SINGULAR_TOL = 1e-8
NEAR_ZERO_VAR_TOL = 1e-6
ASYMPTOTIC_DF = 1e9
MIN_STRATIFIED_SUBJECTS = 3
MIN_STRATIFIED_ROWS = 4
# Default release mode mirrors lmm_anova_test.R subgroup models. Set this True
# only for future explicit pooled/comparative compound-panel validation.
_ENABLE_POOLED_COMPOUND_PANELS = False


@dataclass(frozen=True)
class PredictorMeta:
    original_name: str
    internal_name: str
    predictor_type: str
    labels: list[str] | None = None

    @property
    def is_categorical(self) -> bool:
        return self.predictor_type == "categorical"

    @property
    def is_continuous(self) -> bool:
        return self.predictor_type == "continuous"


def _error(message: str, trajectory_roles: Dict[str, Any] | None = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {"success": False, "error": message}
    if trajectory_roles is not None and isinstance(trajectory_roles, dict):
        result["trajectory_roles"] = trajectory_roles
    return result


def _normalize_adjustment(value: str | None) -> str:
    method = str(value or "tukey").strip().lower()
    return method if method in ALLOWED_ADJUSTMENTS else "tukey"


def _normalize_q(posthoc_q: float | None, alpha: float) -> float:
    try:
        q_value = float(posthoc_q) if posthoc_q is not None else float(alpha)
    except Exception:
        q_value = float(alpha)
    if q_value <= 0 or q_value > 1:
        q_value = float(alpha)
    return q_value


def _normalize_df_method(value: str | None) -> str:
    normalized = str(value or "satterthwaite").strip().lower()
    return normalized if normalized in ALLOWED_DF_METHODS else "satterthwaite"


def _validate_df_method(value: str | None) -> str | None:
    normalized = str(value or "satterthwaite").strip().lower()
    if normalized in ALLOWED_DF_METHODS:
        return None
    return (
        f"Unsupported df_method '{value}'. "
        f"Allowed values: {', '.join(sorted(ALLOWED_DF_METHODS))}."
    )


def _normalize_stratify_by(value: Sequence[Any] | None) -> list[str]:
    if not value:
        return []
    normalized: list[str] = []
    for item in value:
        name = str(item).strip()
        if name and name not in normalized:
            normalized.append(name)
    return normalized


def _normalize_time_value_label(value: Any) -> str:
    try:
        numeric = float(value)
    except Exception:
        return str(value)
    if math.isfinite(numeric) and float(numeric).is_integer():
        return str(int(numeric))
    return str(format_number(numeric))


def _safe_name(value: str, taken: set[str]) -> str:
    base = re.sub(r"[^0-9A-Za-z_]+", "_", value.strip()) or "predictor"
    if not re.match(r"[A-Za-z_]", base):
        base = f"p_{base}"
    candidate = base
    counter = 1
    while candidate in taken:
        counter += 1
        candidate = f"{base}_{counter}"
    taken.add(candidate)
    return candidate


def _decode_categorical_values(values: Sequence[Any], labels: Sequence[Any] | None) -> pd.Series:
    series = pd.Series(values)
    if labels:
        label_list = [str(label) for label in labels]
        try:
            numeric = pd.to_numeric(series, errors="raise")
            if (numeric % 1 == 0).all():
                indices = numeric.astype(int)
                if indices.between(0, len(label_list) - 1).all():
                    return indices.map(lambda idx: label_list[idx]).astype(str)
        except Exception:
            pass
    return series.astype(str)


def _prepare_categorical_series(values: Sequence[Any], labels: Sequence[Any] | None) -> pd.Categorical:
    decoded = _decode_categorical_values(values, labels).astype(str)
    if labels:
        categories = [str(label) for label in labels if str(label) in set(decoded)]
    else:
        categories = list(dict.fromkeys(decoded.tolist()))
    return pd.Categorical(decoded, categories=categories, ordered=True)


def _infer_predictor_type(values: Sequence[Any]) -> str:
    series = pd.Series(values)
    numeric = pd.to_numeric(series, errors="coerce")
    return "continuous" if numeric.notna().all() else "categorical"


def _normalize_predictor_type(value: str | None, values: Sequence[Any]) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"continuous", "numeric"}:
        return "continuous"
    if normalized in {"categorical", "factor"}:
        return "categorical"
    return _infer_predictor_type(values)


def _build_predictor_metas(
    predictors: Dict[str, Sequence[Any]],
    predictor_types: Dict[str, str],
    factor_level_labels: Dict[str, Sequence[Any]],
) -> list[PredictorMeta]:
    taken = {"DV", "subject"}
    metas = []
    for name, values in predictors.items():
        metas.append(
            PredictorMeta(
                original_name=name,
                internal_name=_safe_name(name, taken),
                predictor_type=_normalize_predictor_type(predictor_types.get(name), values),
                labels=[str(label) for label in factor_level_labels.get(name, [])] or None,
            )
        )
    return metas


def _subset_values(values: Sequence[Any], indices: Sequence[int]) -> list[Any]:
    return [values[index] for index in indices]


def _format_stratum_label(stratum: Dict[str, Any], ordered_keys: Sequence[str]) -> str:
    return " | ".join(f"{key}={stratum[key]}" for key in ordered_keys if key in stratum)


def _build_compound_panel_payload(
    panel_filter: Dict[str, str],
    color_factor: str,
    panel_factors: list[str],
    group_factor: str,
    time_factor: str,
    dependent: list[Any],
    subject: list[Any],
    panel_predictors: Dict[str, list[Any]],
    predictor_types: Dict[str, str],
    alpha: float,
    reml: bool,
    random_effects_config: Dict[str, Any],
    simple_effects_config: list[dict[str, str]],
    factor_level_labels: Dict[str, Any],
    posthoc_adjustment: str,
    control_levels: Dict[str, Any] | None,
    posthoc_q: float | None,
    interaction_depth: int | None,
    df_method: str,
) -> tuple[Dict[str, Any] | None, str | None]:
    """
    Fit a single pooled LMM on all data within a compound panel (identified by
    panel_filter, e.g. {"Strain": "B6"}) with colorFactor retained as a fixed
    predictor. Derive trajectory rows and stats from this pooled model.

    Statistical rationale: EMMs and their SEs must be estimated from one fitted
    model; combining outputs of separately fit subgroup models produces SEs with
    different variance-covariance structures and no statistical basis for
    averaging. Using a pooled model borrows strength across strata and yields
    more efficient (lower-variance) SE estimates.
    References:
      - Lenth (emmeans): https://rvlenth.github.io/emmeans/articles/xplanations.html
      - BMJ subgroup analysis best practice: https://www.bmj.com/content/349/bmj.g4539

    Returns (payload, error_msg). On failure: (None, reason). On success: (payload, None).
    """
    if len(dependent) < 4:
        return None, "insufficient data (< 4 observations)"

    # Build effective control levels filtered to predictors present in the pooled panel.
    effective_control_levels: Dict[str, Any] = {
        k: v for k, v in (control_levels or {}).items() if k in panel_predictors
    }

    # Dunnett requires a control level for every categorical predictor. When the colorFactor
    # (e.g. sex) is added to panel_predictors, it becomes a new categorical predictor whose
    # control was never part of the user's config (users only specify controls for group/time).
    # Auto-derive a default control (first sorted decoded level) for any categorical predictor
    # in panel_predictors that has no user-supplied entry. This mirrors the intent of the
    # user's Dunnett setup while satisfying the internal validation gate.
    if posthoc_adjustment == "dunnett":
        panel_pred_types = {k: v for k, v in predictor_types.items() if k in panel_predictors}
        for pred_name, pred_values in panel_predictors.items():
            if _normalize_predictor_type(panel_pred_types.get(pred_name), pred_values) != "continuous":
                if pred_name not in effective_control_levels:
                    decoded = _decode_categorical_values(pred_values, factor_level_labels.get(pred_name))
                    unique_sorted = sorted(decoded.dropna().unique())
                    if unique_sorted:
                        effective_control_levels[pred_name] = unique_sorted[0]

    pooled_result = lmm_anova(
        dependent=dependent,
        subject=subject,
        predictors=panel_predictors,
        # Only pass predictor_types / factor_level_labels / control_levels for predictors
        # that are present in panel_predictors — stratify-only keys are absent here.
        predictor_types={k: v for k, v in predictor_types.items() if k in panel_predictors},
        alpha=alpha,
        reml=reml,
        random_effects_config=random_effects_config,
        simple_effects_config=simple_effects_config,
        factor_level_labels={k: v for k, v in factor_level_labels.items() if k in panel_predictors},
        posthoc_adjustment=posthoc_adjustment,
        control_levels=effective_control_levels,
        posthoc_q=posthoc_q,
        interaction_depth=interaction_depth,
        df_method=df_method,
        stratify_by=None,
    )
    if not pooled_result.get("success"):
        error_msg = pooled_result.get("error", "unknown pooled fit failure")
        return None, f"pooled lmm_anova failed: {error_msg}"

    estimated_means = pooled_result.get("estimated_means", [])
    if not estimated_means:
        return None, "pooled model returned no estimated_means"

    # Build trajectory rows from per-cell pooled-model estimates.
    # Each row corresponds to one (group × color × time) cell with SE from the pooled model.
    trajectory_rows = []
    for cell in estimated_means:
        factors = cell["factors"]
        if group_factor not in factors or color_factor not in factors or time_factor not in factors:
            continue
        trajectory_rows.append({
            "group_factor": group_factor,
            "group_value": factors[group_factor],
            "color_factor": color_factor,
            "color_value": factors[color_factor],
            "time_factor": time_factor,
            "time_value": factors[time_factor],
            "emmean": cell["emmean"],
            "se": cell["se"],
            "ci_lower": cell["ci_lower"],
            "ci_upper": cell["ci_upper"],
            "n": cell.get("n"),
        })

    if not trajectory_rows:
        return None, "pooled model estimated_means had no rows matching group/color/time factors"

    # Sort rows for deterministic output order: time first (semantic), then group, then color.
    trajectory_rows.sort(key=lambda r: (str(r["time_value"]), str(r["group_value"]), str(r["color_value"])))

    # Collect simple-effect p-values per timepoint.
    # pairwise_comparisons rows use factor_scope (e.g. "Treatment|Day=D0") and p_adjusted.
    # Case-safety: factor names in factor_scope come from lmm_anova internals and may differ
    # in casing from simple_effects_config text. Discover the canonical scope prefix from
    # emitted rows themselves by case-insensitive matching, then use the exact emitted names.
    pairwise_rows = pooled_result.get("pairwise_comparisons", [])
    group_norm = group_factor.lower().strip()
    time_norm = time_factor.lower().strip()

    discovered_scope_prefix: str | None = None
    for comp in pairwise_rows:
        scope = comp.get("factor_scope", "")
        if "|" not in scope or "=" not in scope:
            continue
        lhs, rhs = scope.split("|", 1)
        if "=" not in rhs:
            continue
        time_key, _ = rhs.split("=", 1)
        if lhs.lower().strip() == group_norm and time_key.lower().strip() == time_norm:
            discovered_scope_prefix = f"{lhs}|{time_key}="
            break

    simple_effects_by_time: Dict[str, float | None] = {}
    if discovered_scope_prefix is not None:
        for comp in pairwise_rows:
            scope = comp.get("factor_scope", "")
            if not scope.startswith(discovered_scope_prefix):
                continue
            time_val = scope[len(discovered_scope_prefix):]
            p = comp.get("p_adjusted")
            if time_val not in simple_effects_by_time:
                simple_effects_by_time[time_val] = p

    # Compute v1 10-key stats contract.
    emmeans_vals = [r["emmean"] for r in trajectory_rows]
    se_vals = [r["se"] for r in trajectory_rows]
    time_values = sorted({r["time_value"] for r in trajectory_rows})
    n_time = len(time_values)
    trace_combos = {(r["group_value"], r["color_value"]) for r in trajectory_rows}
    n_traces = len(trace_combos)
    p_vals = [v for v in simple_effects_by_time.values() if v is not None]
    sig_count = sum(1 for p in p_vals if p < alpha)

    stats: Dict[str, Any] = {
        "total_points": len(trajectory_rows),
        "trace_count": n_traces,
        "n_points_per_trace": n_time,
        "overall_mean": float(np.mean(emmeans_vals)),
        "mean_se": float(np.mean(se_vals)),
        "min_mean": float(np.min(emmeans_vals)),
        "max_mean": float(np.max(emmeans_vals)),
        "sig_total_points": len(p_vals),
        "sig_significant_points": sig_count,
        "sig_ns_points": len(p_vals) - sig_count,
    }

    facet_key = "|".join(f"{k}={v}" for k, v in panel_filter.items())

    return {
        "facet_key": facet_key,
        "panel_filter": panel_filter,
        "color_factor": color_factor,
        "panel_factors": panel_factors,
        "trajectory_rows": trajectory_rows,
        "simple_effects_by_time": simple_effects_by_time,
        "stats": stats,
    }, None


def _run_stratified_lmm(
    dependent: Sequence[Any],
    subject: Sequence[Any],
    predictors: Dict[str, Sequence[Any]],
    predictor_types: Dict[str, str] | None,
    alpha: float,
    reml: bool,
    random_effects_config: Dict[str, Any] | None,
    simple_effects_config: list[dict[str, str]] | dict[str, bool] | None,
    factor_level_labels: Dict[str, Sequence[Any]] | None,
    posthoc_adjustment: str,
    control_levels: Dict[str, Any] | None,
    posthoc_q: float | None,
    interaction_depth: int | None,
    df_method: str,
    stratify_by: Sequence[str],
    continuous_effects_config: Dict[str, Any] | None = None,
    trajectory_roles: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    invalid_df_method = _validate_df_method(df_method)
    if invalid_df_method:
        return _error(invalid_df_method, trajectory_roles=trajectory_roles)

    predictor_types = predictor_types or {}
    factor_level_labels = factor_level_labels or {}
    random_effects_config = dict(random_effects_config or {})
    control_levels = control_levels or {}

    normalized_stratify_by = _normalize_stratify_by(stratify_by)
    if not normalized_stratify_by:
        return _error("Stratified lmm_anova requires at least one stratification factor.", trajectory_roles=trajectory_roles)

    for name in normalized_stratify_by:
        if name not in predictors:
            return _error(f"Stratification factor '{name}' was not found in predictors.", trajectory_roles=trajectory_roles)
        if _normalize_predictor_type(predictor_types.get(name), predictors[name]) != "categorical":
            return _error(f"Stratification factor '{name}' must be categorical.", trajectory_roles=trajectory_roles)

    remaining_predictors = {
        name: values for name, values in predictors.items() if name not in normalized_stratify_by
    }
    if not remaining_predictors:
        return _error("Stratified lmm_anova requires remaining model predictors after removing stratification factors.", trajectory_roles=trajectory_roles)

    row_count = len(dependent)
    if len(subject) != row_count:
        return _error("dependent and subject must have the same length.", trajectory_roles=trajectory_roles)

    strata_frame = pd.DataFrame(
        {name: _decode_categorical_values(predictors[name], factor_level_labels.get(name)) for name in normalized_stratify_by}
    )

    strata_results: list[Dict[str, Any]] = []
    warnings_out: list[str] = []

    grouped = strata_frame.groupby(normalized_stratify_by, sort=False, dropna=False).indices
    for group_key, row_index in grouped.items():
        key_tuple = group_key if isinstance(group_key, tuple) else (group_key,)
        indices = list(row_index)
        stratum = {name: str(value) for name, value in zip(normalized_stratify_by, key_tuple)}
        stratum_label = _format_stratum_label(stratum, normalized_stratify_by)
        subgroup_subjects = _subset_values(subject, indices)
        n_subjects = len({str(value) for value in subgroup_subjects})
        if len(indices) < MIN_STRATIFIED_ROWS or n_subjects < MIN_STRATIFIED_SUBJECTS:
            child_result = {
                "success": False,
                "test_type": "lmm_anova",
                "stratum": stratum,
                "stratum_label": stratum_label,
                "error": (
                    f"Stratum has only {n_subjects} subjects and {len(indices)} observations; "
                    "skipping fit."
                ),
            }
            strata_results.append(child_result)
            warnings_out.append(f"{stratum_label}: {child_result['error']}")
            continue

        child_random_effects = dict(random_effects_config)
        if child_random_effects.get("group_values") is not None:
            child_random_effects["group_values"] = _subset_values(child_random_effects["group_values"], indices)

        child_slopes = child_random_effects.get("random_slopes") or []
        if child_slopes:
            child_random_effects["random_slopes"] = [
                slope for slope in child_slopes if slope not in normalized_stratify_by
            ]

        child_simple_effects = simple_effects_config
        child_continuous_effects = continuous_effects_config
        dropped_simple_effects: list[str] = []
        dropped_continuous_effects: list[str] = []
        if isinstance(simple_effects_config, list):
            child_simple_effects = []
            for item in simple_effects_config:
                if not isinstance(item, dict):
                    continue
                factor = item.get("factor")
                within = item.get("within")
                if factor in normalized_stratify_by or within in normalized_stratify_by:
                    dropped_simple_effects.append(f"{factor} within {within}")
                    continue
                child_simple_effects.append(item)

        if isinstance(continuous_effects_config, dict):
            group_factor = str(continuous_effects_config.get("group_factor", "")).strip()
            time_factor = str(continuous_effects_config.get("time_factor", "")).strip()
            if group_factor in normalized_stratify_by or time_factor in normalized_stratify_by:
                child_continuous_effects = None
                dropped_continuous_effects.append(
                    f"{group_factor} at selected {time_factor} values"
                )

        child_result = lmm_anova(
            _subset_values(dependent, indices),
            subgroup_subjects,
            {name: _subset_values(values, indices) for name, values in remaining_predictors.items()},
            predictor_types={name: value for name, value in predictor_types.items() if name in remaining_predictors},
            alpha=alpha,
            reml=reml,
            random_effects_config=child_random_effects,
            simple_effects_config=child_simple_effects,
            continuous_effects_config=child_continuous_effects,
            factor_level_labels={name: value for name, value in factor_level_labels.items() if name in remaining_predictors},
            posthoc_adjustment=posthoc_adjustment,
            control_levels={name: value for name, value in control_levels.items() if name in remaining_predictors},
            posthoc_q=posthoc_q,
            interaction_depth=interaction_depth,
            df_method=df_method,
            stratify_by=None,
        )
        child_result["stratum"] = stratum
        child_result["stratum_label"] = stratum_label
        child_warnings = list(child_result.get("warnings") or [])
        if dropped_simple_effects:
            child_warnings.extend(
                f"Simple effect '{entry}' was skipped because it references a stratification factor."
                for entry in dropped_simple_effects
            )
        if dropped_continuous_effects:
            child_warnings.extend(
                f"Continuous-time contrast '{entry}' was skipped because it references a stratification factor."
                for entry in dropped_continuous_effects
            )
        if child_warnings:
            child_result["warnings"] = child_warnings
        strata_results.append(child_result)
        if child_result.get("success", False):
            for warning in child_warnings:
                warnings_out.append(f"{stratum_label}: {warning}")
        else:
            for warning in child_warnings:
                warnings_out.append(f"{stratum_label}: {warning}")
            warnings_out.append(f"{stratum_label}: {child_result.get('error', 'stratified fit failed')}")

    successful = [result for result in strata_results if result.get("success")]
    if not successful:
        failure_result: Dict[str, Any] = {
            "success": False,
            "error": "All stratified lmm_anova fits failed.",
            "test_type": "lmm_anova_stratified",
            "stratified": True,
            "stratify_by": normalized_stratify_by,
            "strata_results": strata_results,
            "compound_panels": [],
            "compound_panels_warnings": [],
            "warnings": warnings_out or None,
        }
        if trajectory_roles is not None and isinstance(trajectory_roles, dict):
            failure_result["trajectory_roles"] = trajectory_roles
        return failure_result

    # Default R-parity mode follows lmm_anova_test.R: independent subgroup
    # fits with lme4/lmerTest-style Type III inference and emmeans simple
    # effects. Pooled compound panels are retained for a future explicit
    # comparative mode, but are not emitted by default.
    # References: Bates et al. 2015 (lme4), Kuznetsova et al. 2017 (lmerTest),
    # Lenth emmeans.
    compound_panels: list[Dict[str, Any]] = []
    compound_panels_warnings: list[str] = []
    if _ENABLE_POOLED_COMPOUND_PANELS:
        # Build pooled compound panels when stratify_by has >= 2 dimensions and
        # simple_effects_config is provided. colorFactor = stratify_by[0],
        # panelFactors = stratify_by[1:].
        # Recursive lmm_anova() call uses stratify_by=None — guarded against infinite
        # recursion by the len(normalized_stratify_by) >= 2 guard above.
        _tr_treatment = trajectory_roles.get("treatment_factor") if isinstance(trajectory_roles, dict) else None
        _tr_time = trajectory_roles.get("time_factor") if isinstance(trajectory_roles, dict) else None
        _has_trajectory_roles_axes = bool(_tr_treatment and _tr_time)
        # Belt-and-suspenders: same column for both roles is always invalid.
        if _has_trajectory_roles_axes and _tr_treatment == _tr_time:
            compound_panels_warnings.append(
                f"trajectory_roles.treatment_factor and trajectory_roles.time_factor are the same column "
                f"('{_tr_treatment}') — compound panel skipped."
            )
            _has_trajectory_roles_axes = False
        _has_simple_effects = isinstance(simple_effects_config, list) and bool(simple_effects_config)
        if len(normalized_stratify_by) >= 2 and (_has_trajectory_roles_axes or _has_simple_effects):
            color_factor = normalized_stratify_by[0]
            panel_factor_names = normalized_stratify_by[1:]
            # trajectory_roles is authoritative; fall back to simple_effects only when absent
            if _has_trajectory_roles_axes:
                group_factor = _tr_treatment  # already extracted above
                time_factor = _tr_time  # type: ignore[assignment]
                # Validate both names exist in remaining_predictors; skip compound build if stale.
                for role_key, role_val in [("treatment_factor", group_factor), ("time_factor", time_factor)]:
                    if role_val not in remaining_predictors:
                        compound_panels_warnings.append(
                            f"trajectory_roles.{role_key} '{role_val}' is not a model predictor — compound panel skipped."
                        )
                        group_factor = ""
                        time_factor = ""
                        break
            else:
                se_config = simple_effects_config[0]  # type: ignore[index]
                group_factor = se_config.get("factor", "")
                time_factor = se_config.get("within", "")

            if group_factor and time_factor:
                # Decode only the stratify columns for groupby key labelling.
                # Do NOT pre-decode remaining_predictors or colorFactor: lmm_anova() expects
                # raw values + factor_level_labels and does normalization internally.
                full_df = pd.DataFrame({
                    name: _decode_categorical_values(predictors[name], factor_level_labels.get(name))
                    for name in normalized_stratify_by
                })

                panel_grouped = full_df.groupby(panel_factor_names, sort=False, dropna=False).indices
                for panel_key_raw, panel_row_index in panel_grouped.items():
                    panel_key_tuple = panel_key_raw if isinstance(panel_key_raw, tuple) else (panel_key_raw,)
                    panel_filter = {
                        name: str(val)
                        for name, val in zip(panel_factor_names, panel_key_tuple)
                    }
                    idx = list(panel_row_index)
                    facet_key_str = "|".join(f"{k}={v}" for k, v in panel_filter.items())

                    # Pass raw subset values; lmm_anova() handles decoding via factor_level_labels.
                    panel_predictors = {
                        name: _subset_values(values, idx)
                        for name, values in remaining_predictors.items()
                    }
                    panel_predictors[color_factor] = _subset_values(predictors[color_factor], idx)

                    panel_random_effects = dict(random_effects_config)
                    if panel_random_effects.get("group_values") is not None:
                        panel_random_effects["group_values"] = _subset_values(
                            panel_random_effects["group_values"], idx
                        )

                    payload, panel_error = _build_compound_panel_payload(
                        panel_filter=panel_filter,
                        color_factor=color_factor,
                        panel_factors=list(panel_factor_names),
                        group_factor=group_factor,
                        time_factor=time_factor,
                        dependent=_subset_values(dependent, idx),
                        subject=_subset_values(subject, idx),
                        panel_predictors=panel_predictors,
                        predictor_types=predictor_types,
                        alpha=alpha,
                        reml=reml,
                        random_effects_config=panel_random_effects,
                        simple_effects_config=simple_effects_config,
                        factor_level_labels=factor_level_labels,
                        posthoc_adjustment=posthoc_adjustment,
                        control_levels=control_levels,
                        posthoc_q=posthoc_q,
                        interaction_depth=interaction_depth,
                        df_method=df_method,
                    )
                    if payload is not None:
                        compound_panels.append(payload)
                    else:
                        warning = f"compound_panel skipped: {facet_key_str}"
                        if panel_error:
                            warning += f" — {panel_error}"
                        compound_panels_warnings.append(warning)

    inference_fit_reml_values = [bool(result.get("inference_fit_reml", reml)) for result in successful]
    if all(inference_fit_reml_values):
        aggregated_inference_fit_reml: bool | None = True
    elif not any(inference_fit_reml_values):
        aggregated_inference_fit_reml = False
    else:
        aggregated_inference_fit_reml = None

    success_result: Dict[str, Any] = {
        "success": True,
        "test_type": "lmm_anova_stratified",
        "stratified": True,
        "stratify_by": normalized_stratify_by,
        "strata_results": strata_results,
        "compound_panels": compound_panels,
        "compound_panels_warnings": compound_panels_warnings,
        "requested_reml": bool(reml),
        "inference_fit_reml": aggregated_inference_fit_reml,
        "kr_reml_refit": any(bool(result.get("kr_reml_refit")) for result in successful),
        "adjustment_method": successful[0].get("adjustment_method", get_method_label(posthoc_adjustment)),
        "posthoc_q": successful[0].get("posthoc_q", posthoc_q),
        "warnings": warnings_out or None,
    }
    if trajectory_roles is not None and isinstance(trajectory_roles, dict):
        success_result["trajectory_roles"] = trajectory_roles
    return success_result


def _normalize_interaction_depth(value: int | None, predictor_count: int) -> int:
    try:
        depth = int(value) if value is not None else 2
    except Exception:
        depth = 2
    return min(max(depth, 1), max(predictor_count, 1))


def _build_fixed_formula(predictor_metas: list[PredictorMeta], interaction_depth: int | None) -> str:
    terms = [f"C({meta.internal_name}, Sum)" if meta.is_categorical else meta.internal_name for meta in predictor_metas]
    depth = _normalize_interaction_depth(interaction_depth, len(terms))
    expanded_terms: list[str] = []
    for term_depth in range(1, depth + 1):
        for combo in itertools.combinations(terms, term_depth):
            expanded_terms.append(":".join(combo))
    rhs = " + ".join(expanded_terms)
    return f"DV ~ {rhs}"


def _build_random_formula(
    random_effects_config: Dict[str, Any],
    predictor_metas: list[PredictorMeta],
) -> tuple[str, list[PredictorMeta]]:
    if random_effects_config.get("random_intercept", True) is False:
        raise ValueError("Phase-1 lmm_anova requires a random intercept.")

    requested_slopes = random_effects_config.get("random_slopes") or []
    if not isinstance(requested_slopes, list):
        raise ValueError("random_slopes must be a list when provided.")
    if len(requested_slopes) > 1:
        raise ValueError("Phase-1 lmm_anova supports at most one random slope.")

    slope_metas = []
    if requested_slopes:
        slope_name = str(requested_slopes[0])
        slope_meta = next((meta for meta in predictor_metas if meta.original_name == slope_name), None)
        if slope_meta is None:
            raise ValueError(f"Random slope predictor '{slope_name}' was not found.")
        if not slope_meta.is_continuous:
            raise ValueError("Random slopes are only supported for continuous predictors in phase 1.")
        slope_metas.append(slope_meta)

    if not slope_metas:
        return "1", slope_metas
    return f"1 + {slope_metas[0].internal_name}", slope_metas


def _fit_is_boundary(fitted) -> bool:
    """Return True if the fit has near-zero or singular random-effects variance."""
    cov_re = np.asarray(getattr(fitted, "cov_re", np.empty((0, 0))), dtype=float)
    if cov_re.size == 0:
        return False
    try:
        eigenvalues = np.linalg.eigvalsh(cov_re)
    except np.linalg.LinAlgError:
        eigenvalues = np.diag(cov_re)
    return bool(np.any(eigenvalues <= NEAR_ZERO_VAR_TOL))


def _fit_model(df: pd.DataFrame, fixed_formula: str, re_formula: str, reml: bool, groups: pd.Series):
    methods = ("lbfgs", "bfgs", "cg", "powell", "nm")
    fallback_result = None
    fallback_warnings: list[str] = []
    fallback_optimizer = ""
    errors: list[str] = []

    for method in methods:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                model = mixedlm(fixed_formula, df, groups=groups, re_formula=re_formula)
                fitted = model.fit(reml=bool(reml), method=method, disp=False, maxiter=400)
                captured = [str(item.message) for item in caught]
                if fallback_result is None:
                    fallback_result = fitted
                    fallback_warnings = captured
                    fallback_optimizer = method
                if getattr(fitted, "converged", False):
                    # If this converged fit is not a boundary solution, return it immediately
                    # (preserves original behaviour for well-conditioned datasets).
                    if not _fit_is_boundary(fitted):
                        return fitted, captured, method
                    # Converged but boundary — keep as fallback and continue searching
                    # for a non-boundary converged solution.
                    fallback_result = fitted
                    fallback_warnings = captured
                    fallback_optimizer = method
            except Exception as exc:
                errors.append(f"{method}: {exc}")

    if fallback_result is not None:
        fallback_warnings.extend(errors)
        return fallback_result, fallback_warnings, fallback_optimizer
    raise RuntimeError("MixedLM fit failed across optimizers: " + "; ".join(errors))


def _term_label(raw_term: str, predictor_metas: list[PredictorMeta]) -> str:
    cleaned = raw_term
    for meta in predictor_metas:
        cleaned = cleaned.replace(f"C({meta.internal_name}, Sum)", meta.original_name)
        cleaned = re.sub(rf"\b{re.escape(meta.internal_name)}\b", meta.original_name, cleaned)
    return cleaned.replace(":", " x ")


def _resolve_df_approx(fit, df_method: str) -> float:
    if df_method in {"asymptotic", "satterthwaite", "kenward_roger"}:
        return float("inf")
    return float(max(int(fit.nobs) - int(len(fit.fe_params)), 1))


def _critical_value(alpha: float, df_approx: float) -> float:
    if np.isfinite(df_approx):
        return float(stats.t.ppf(1 - alpha / 2, df_approx))
    return float(stats.norm.ppf(1 - alpha / 2))


def _two_sided_p(statistic: float, df_approx: float) -> float:
    if np.isfinite(df_approx):
        return float(2 * stats.t.sf(abs(statistic), df_approx))
    return float(2 * stats.norm.sf(abs(statistic)))


def _multicomp_df(df_approx: float) -> float:
    return float(df_approx if np.isfinite(df_approx) else ASYMPTOTIC_DF)


def _display_df(df_approx: float) -> float | None:
    if not np.isfinite(df_approx):
        return None
    return float(df_approx)


def _serialize_named_vector(names: Sequence[str], values: Sequence[float]) -> str:
    pieces: list[str] = []
    for name, value in zip(names, values):
        pieces.append(f"{name}={format(float(value), '.16g')}")
    return ";".join(pieces)


def _phase1a_supports_satterthwaite(fit, slope_metas: list[PredictorMeta], df_method: str) -> bool:
    return (
        df_method == "satterthwaite"
        and not slope_metas
        and int(getattr(fit.model, "k_re", 0)) == 1
        and int(getattr(fit.model, "k_vc", 0)) == 0
    )


def _phase1b_supports_satterthwaite(fit, slope_metas: list[PredictorMeta], df_method: str) -> bool:
    return (
        df_method == "satterthwaite"
        and len(slope_metas) == 1
        and int(getattr(fit.model, "k_re", 0)) == 2
        and int(getattr(fit.model, "k_vc", 0)) == 0
    )


def _finite_df_mode(fit, slope_metas: list[PredictorMeta], df_method: str) -> str | None:
    if df_method == "kenward_roger" and not slope_metas and int(getattr(fit.model, "k_re", 0)) == 1 and int(getattr(fit.model, "k_vc", 0)) == 0:
        return "kenward_roger"
    if _phase1a_supports_satterthwaite(fit, slope_metas, df_method):
        return "phase1a"
    if _phase1b_supports_satterthwaite(fit, slope_metas, df_method):
        return "phase1b"
    return None


def _unstable_random_slope_fit_warning(
    fit_warnings: Sequence[str],
    slope_metas: list[PredictorMeta],
    df_method: str,
    allow_boundary_singularity: bool = False,
) -> str | None:
    if df_method != "satterthwaite" or len(slope_metas) != 1:
        return None
    markers = [
        "hessian matrix at the estimated parameter values is not positive definite",
        "invalid value encountered",
    ]
    if not allow_boundary_singularity:
        markers = [
            "boundary of the parameter space",
            "random effects covariance is singular",
            "random-effects covariance is singular",
            *markers,
        ]
    matched = [
        str(warning).strip()
        for warning in fit_warnings
        if str(warning).strip() and any(marker in str(warning).lower() for marker in markers)
    ]
    if not matched:
        return None
    unique = list(dict.fromkeys(matched))
    return "random-slope fit emitted unstable optimization warnings: " + "; ".join(unique[:3])


def _internal_term_label(raw_term: str, predictor_metas: list[PredictorMeta]) -> str:
    cleaned = str(raw_term)
    for meta in predictor_metas:
        cleaned = cleaned.replace(meta.internal_name, meta.original_name)
    return cleaned.replace(":", " x ")


def _extract_fixed_effects(
    fit,
    predictor_metas: list[PredictorMeta],
    alpha: float,
    df_method: str,
    phase1a_inference: Dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], float]:
    df_approx = _resolve_df_approx(fit, df_method)
    if phase1a_inference is not None:
        rows = []
        fe_params = phase1a_inference["fe_params"]
        cov_beta = phase1a_inference["cov_beta"]
        method = str(phase1a_inference.get("method", "satterthwaite"))
        for term_name, contrast in phase1a_inference["type3_contrasts"].items():
            l_matrix = np.asarray(contrast, dtype=float)
            lc_lt = l_matrix @ cov_beta @ l_matrix.T
            num_df = effective_rank(lc_lt)
            if num_df == 0:
                continue
            projected = l_matrix @ fe_params
            if method == "kenward_roger":
                f_value, num_df, den_df, p_value = infer_kr_md(
                    phase1a_inference["kr_bundle"],
                    l_matrix,
                    projected,
                )
                inference = "kenward_roger_f"
                statistic_type = "F"
                quadratic_form = float(projected.T @ np.linalg.pinv(lc_lt) @ projected)
            else:
                theta_cov = phase1a_inference["theta_cov"]
                jacobian = phase1a_inference["cov_beta_jacobian"]
                quadratic_form = float(projected.T @ np.linalg.pinv(lc_lt) @ projected)
                _, den_df = satterthwaite_df_md(l_matrix, cov_beta, jacobian, theta_cov)
                f_value, p_value = infer_md_from_df(quadratic_form, num_df, den_df)
                inference = "satterthwaite_f"
                statistic_type = "F"
            rows.append(
                {
                    "source": _internal_term_label(term_name, predictor_metas),
                    "term": str(term_name),
                    "statistic_type": statistic_type,
                    "statistic": format_number(f_value),
                    "f_value": format_number(f_value),
                    "chi_square": format_number(quadratic_form),
                    "num_df": int(num_df),
                    "den_df": format_number(den_df) if np.isfinite(den_df) else None,
                    "df": format_number(den_df) if np.isfinite(den_df) else None,
                    "p_value": format_number(p_value),
                    "significant": bool(p_value < alpha),
                    "inference": inference,
                }
            )
        return rows, df_approx
    rows = []
    fe_params, cov_beta = _fixed_covariance(fit)
    type3_contrasts = build_type3_contrasts_from_matrices(
        fit.model.exog,
        fit.model.data.design_info,
        fit.model.exog,
        fit.model.data.design_info,
    )
    for term_name, contrast in type3_contrasts.items():
        l_matrix = np.asarray(contrast, dtype=float)
        lc_lt = l_matrix @ cov_beta @ l_matrix.T
        df_constraint = effective_rank(lc_lt)
        if df_constraint == 0:
            continue
        projected = l_matrix @ fe_params
        chi_square = float(projected.T @ np.linalg.pinv(lc_lt) @ projected)
        p_value = float(stats.chi2.sf(chi_square, df_constraint))
        rows.append(
            {
                "source": _internal_term_label(term_name, predictor_metas),
                "term": str(term_name),
                "statistic_type": "Chi-Square",
                "statistic": format_number(chi_square),
                "chi_square": format_number(chi_square),
                "num_df": int(df_constraint),
                "df": int(df_constraint),
                "p_value": format_number(p_value),
                "significant": bool(p_value < alpha),
                "inference": "wald_chi2",
            }
        )
    return rows, df_approx


def _fit_metrics_payload(fit, optimizer_used: str) -> Dict[str, Any]:
    llf = getattr(fit, "llf", np.nan)
    aic = getattr(fit, "aic", np.nan)
    bic = getattr(fit, "bic", np.nan)
    scale = getattr(fit, "scale", np.nan)
    return {
        "optimizer": optimizer_used,
        "converged": bool(getattr(fit, "converged", False)),
        "log_likelihood": format_number(llf) if np.isfinite(llf) else None,
        "aic": format_number(aic) if np.isfinite(aic) else None,
        "bic": format_number(bic) if np.isfinite(bic) else None,
        "residual_variance": format_number(scale) if np.isfinite(scale) else None,
    }


def _build_diagnostics(
    fit,
    alpha: float,
    dropped_rows: int,
    fit_warnings: list[str],
) -> Dict[str, Any]:
    warnings_out = list(dict.fromkeys(str(item) for item in fit_warnings if str(item).strip()))

    residual_basis = "conditional"
    try:
        fitted_values = np.asarray(fit.fittedvalues, dtype=float)
        residuals = np.asarray(fit.resid, dtype=float)
    except (ValueError, np.linalg.LinAlgError) as exc:
        message = str(exc)
        lower_message = message.lower()
        is_linalg_failure = isinstance(exc, np.linalg.LinAlgError)
        is_supported_value_error = (
            isinstance(exc, ValueError)
            and "singular covariance structure" in lower_message
        )
        if not (is_linalg_failure or is_supported_value_error):
            raise
        fitted_values = np.asarray(np.dot(fit.model.exog, fit.fe_params), dtype=float)
        residuals = np.asarray(fit.model.endog - fitted_values, dtype=float)
        residual_basis = "fixed_only_fallback"
        warnings_out.append(
            "Conditional random-effects predictions were unavailable from a singular covariance structure; "
            "residual diagnostics used fixed-effects-only fitted values."
        )
    mask = np.isfinite(fitted_values) & np.isfinite(residuals)
    fitted_values = fitted_values[mask]
    residuals = residuals[mask]

    shapiro_stat = np.nan
    shapiro_p = np.nan
    if residuals.size >= 3:
        sample = residuals[: min(5000, residuals.size)]
        try:
            shapiro_stat, shapiro_p = stats.shapiro(sample)
        except Exception:
            pass

    spread_stat = np.nan
    spread_p = np.nan
    if residuals.size >= 3 and fitted_values.size == residuals.size:
        try:
            spread_stat, spread_p = stats.spearmanr(np.abs(residuals), fitted_values)
        except Exception:
            pass

    cov_re = np.asarray(getattr(fit, "cov_re", np.empty((0, 0))), dtype=float)
    random_variances: list[float] = []
    singular_fit = False
    near_zero_random_variance = False
    if cov_re.size > 0:
        try:
            eigenvalues = np.linalg.eigvalsh(cov_re)
        except np.linalg.LinAlgError:
            eigenvalues = np.diag(cov_re)
        diag_terms = [float(value) for value in np.diag(cov_re)]
        cov_terms: list[float] = []
        if cov_re.shape[0] > 1:
            for row in range(cov_re.shape[0]):
                for col in range(row + 1, cov_re.shape[1]):
                    cov_terms.append(float(cov_re[row, col]))
        random_variances = diag_terms + cov_terms
        singular_fit = bool(np.any(eigenvalues <= SINGULAR_TOL))
        near_zero_random_variance = bool(np.any(eigenvalues <= NEAR_ZERO_VAR_TOL))

    if dropped_rows:
        warnings_out.append(f"{dropped_rows} row(s) dropped before model fitting.")
    if singular_fit:
        warnings_out.append("Random-effects covariance appears singular.")
    elif near_zero_random_variance:
        warnings_out.append("Random-effects variance is near zero.")

    return {
        "converged": bool(getattr(fit, "converged", False)),
        "singular_fit": singular_fit,
        "near_zero_random_variance": near_zero_random_variance,
        "random_effect_variances": [format_number(value) for value in random_variances],
        "rows_dropped": int(dropped_rows),
        "residual_normality": {
            "statistic": format_number(shapiro_stat) if np.isfinite(shapiro_stat) else None,
            "p_value": format_number(shapiro_p) if np.isfinite(shapiro_p) else None,
            "normal": bool(shapiro_p >= alpha) if np.isfinite(shapiro_p) else None,
            "test": "Shapiro-Wilk",
        },
        "residual_spread": {
            "statistic": format_number(spread_stat) if np.isfinite(spread_stat) else None,
            "p_value": format_number(spread_p) if np.isfinite(spread_p) else None,
            "test": "Spearman(abs(residual), fitted)",
        },
        "residual_basis": residual_basis,
        "warnings": warnings_out,
    }


def _continuous_defaults(df: pd.DataFrame, predictor_metas: list[PredictorMeta]) -> Dict[str, float]:
    return {
        meta.internal_name: float(pd.to_numeric(df[meta.internal_name], errors="coerce").mean())
        for meta in predictor_metas
        if meta.is_continuous
    }


def _grid_row_to_exog(fit, row: Dict[str, Any]) -> np.ndarray:
    row_df = pd.DataFrame([row])
    frame = fit.model.data.frame
    for column in row_df.columns:
        if column in frame.columns and isinstance(frame[column].dtype, pd.CategoricalDtype):
            row_df[column] = pd.Categorical(
                row_df[column],
                categories=frame[column].cat.categories,
                ordered=True,
            )
    matrix = build_design_matrices([fit.model.data.design_info], row_df)[0]
    return np.asarray(matrix, dtype=float)[0]


def _fixed_covariance(fit) -> tuple[np.ndarray, np.ndarray]:
    fe_names = list(fit.fe_params.index)
    fe_params = np.asarray(fit.fe_params, dtype=float)
    cov_df = fit.cov_params()
    cov_fe = np.asarray(cov_df.loc[fe_names, fe_names], dtype=float)
    return fe_params, cov_fe


def _build_finite_df_inference_bundle(fit) -> Dict[str, Any]:
    fe_params, cov_beta = _fixed_covariance(fit)
    theta_spec = extract_finite_df_varpar_spec(fit)
    if int(getattr(fit.model, "k_re", 0)) == 2:
        hessian = _numerical_hessian(
            lambda values: finite_df_negloglike_from_varpar(fit, values),
            np.asarray(theta_spec.theta, dtype=float),
        )
        if float(np.min(np.linalg.eigvalsh(hessian))) <= 0.0:
            raise ValueError("phase1 numerical Hessian has non-positive eigenvalues for this random-slope fit")
        reproduced_cov_beta = cov_beta_from_finite_df_varpar(fit, theta_spec.theta)
        if not np.allclose(reproduced_cov_beta, cov_beta, rtol=1e-3, atol=1e-6):
            raise ValueError(
                "phase1 varpar surface does not reproduce fitted fixed-effect covariance for this random-slope fit"
            )
    cov_beta_jacobian = numerical_cov_beta_jacobian(
        fit,
        theta_spec.theta,
        evaluator=cov_beta_from_finite_df_varpar,
    )
    type3_contrasts = build_type3_contrasts_from_matrices(
        fit.model.exog,
        fit.model.data.design_info,
        fit.model.exog,
        fit.model.data.design_info,
    )
    return {
        "method": "satterthwaite",
        "fe_params": fe_params,
        "cov_beta": cov_beta,
        "theta": theta_spec.theta,
        "theta_cov": theta_spec.covariance,
        "theta_names": theta_spec.names,
        "cov_beta_jacobian": cov_beta_jacobian,
        "type3_contrasts": type3_contrasts,
    }


def _collect_satterthwaite_1d_diagnostics(
    contrast: np.ndarray,
    cov_beta: np.ndarray,
    jacobian: np.ndarray,
    theta_cov: np.ndarray,
    *,
    theta_names: Sequence[str] | None = None,
    contrast_term_names: Sequence[str] | None = None,
) -> Dict[str, Any]:
    contrast_vector = np.asarray(contrast, dtype=float).reshape(-1)
    covariance = np.asarray(cov_beta, dtype=float)
    cov_jacobian = np.asarray(jacobian, dtype=float)
    varpar_covariance = np.asarray(theta_cov, dtype=float)
    variance = quad_form_vec(contrast_vector, covariance)
    gradient = contract_cov_jacobian(contrast_vector, cov_jacobian)
    denominator = quad_form_vec(gradient, varpar_covariance)
    theta_name_list = list(theta_names or [])
    contrast_name_list = list(contrast_term_names or [])
    return {
        "contrast_vector": contrast_vector.tolist(),
        "contrast_term_names": contrast_name_list,
        "contrast_vector_by_term": {
            name: float(value) for name, value in zip(contrast_name_list, contrast_vector)
        },
        "contrast_variance": float(variance),
        "variance_gradient": gradient.tolist(),
        "theta_names": theta_name_list,
        "variance_gradient_by_theta": {
            name: float(value) for name, value in zip(theta_name_list, gradient)
        },
        "theta_cov": varpar_covariance.tolist(),
        "theta_cov_eigenvalues": np.linalg.eigvalsh(varpar_covariance).tolist(),
        "denominator": float(denominator),
        "df": float(satterthwaite_df_1d(contrast_vector, covariance, cov_jacobian, varpar_covariance)),
    }


def _build_kr_df_inference_bundle(fit, fixed_formula: str, re_formula: str, groups: pd.Series) -> Dict[str, Any]:
    kr_fit = fit
    reml_refit = False
    if not bool(getattr(fit.model, "reml", False)):
        kr_fit, _warnings, _optimizer = _fit_model(
            fit.model.data.frame,
            fixed_formula,
            re_formula,
            True,
            groups,
        )
        reml_refit = True
    kr_bundle = build_kr_inference_bundle(kr_fit, reml_refit=reml_refit)
    type3_contrasts = build_type3_contrasts_from_matrices(
        kr_fit.model.exog,
        kr_fit.model.data.design_info,
        kr_fit.model.exog,
        kr_fit.model.data.design_info,
    )
    return {
        "method": "kenward_roger",
        "fe_params": kr_bundle.fe_params,
        "cov_beta": kr_bundle.cov_beta,
        "theta_cov": kr_bundle.theta_cov,
        "type3_contrasts": type3_contrasts,
        "kr_bundle": kr_bundle,
        "reml_refit": reml_refit,
        "fit": kr_fit,
    }


def _estimate_from_vector(
    x_vector: np.ndarray,
    fe_params: np.ndarray,
    cov_fe: np.ndarray,
    alpha: float,
    df_approx: float,
    phase1a_inference: Dict[str, Any] | None = None,
) -> Dict[str, float]:
    estimate = float(x_vector @ fe_params)
    variance = float(x_vector @ cov_fe @ x_vector.T)
    variance = max(variance, 0.0)
    se = float(math.sqrt(variance))
    if phase1a_inference is not None:
        method = str(phase1a_inference.get("method", "satterthwaite"))
        if method == "kenward_roger":
            se, _statistic, estimate_df, _p_value = infer_kr_1d(
                phase1a_inference["kr_bundle"],
                x_vector,
                estimate,
            )
            inference = "kenward_roger_t"
            df_fallback_reason = None
        else:
            estimate_df = satterthwaite_df_1d(
                x_vector,
                cov_fe,
                phase1a_inference["cov_beta_jacobian"],
                phase1a_inference["theta_cov"],
            )
            if np.isfinite(estimate_df):
                inference = "satterthwaite_t"
                df_fallback_reason = None
            else:
                estimate_df = float("inf")
                inference = "asymptotic_z"
                df_fallback_reason = (
                    "Row-level Satterthwaite df was unavailable for this estimate; "
                    "fell back to asymptotic inference for this row."
                )
    else:
        estimate_df = df_approx
        inference = "asymptotic_z" if not np.isfinite(df_approx) else "residual_t"
        df_fallback_reason = None
    critical = _critical_value(alpha, estimate_df)
    result = {
        "estimate": estimate,
        "se": se,
        "ci_lower": estimate - critical * se,
        "ci_upper": estimate + critical * se,
        "df": estimate_df if np.isfinite(estimate_df) else None,
        "inference": inference,
    }
    if df_fallback_reason:
        result["df_fallback_reason"] = df_fallback_reason
    return result


def _categorical_levels(df: pd.DataFrame, predictor_metas: list[PredictorMeta]) -> Dict[str, list[str]]:
    levels: Dict[str, list[str]] = {}
    for meta in predictor_metas:
        if not meta.is_categorical:
            continue
        series = df[meta.internal_name]
        if isinstance(series.dtype, pd.CategoricalDtype):
            observed = set(series.astype(str))
            levels[meta.internal_name] = [str(value) for value in series.cat.categories if str(value) in observed]
        else:
            levels[meta.internal_name] = list(dict.fromkeys(series.astype(str).tolist()))
    return levels


def _build_estimated_means(
    fit,
    df: pd.DataFrame,
    predictor_metas: list[PredictorMeta],
    alpha: float,
    df_approx: float,
    phase1a_inference: Dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    categorical = [meta for meta in predictor_metas if meta.is_categorical]
    if not categorical:
        return []

    fit_for_inference = phase1a_inference.get("fit", fit) if phase1a_inference is not None else fit
    fe_params, cov_fe = _fixed_covariance(fit_for_inference)
    defaults = _continuous_defaults(df, predictor_metas)
    levels = _categorical_levels(df, predictor_metas)
    rows = []

    for combo in itertools.product(*[levels[meta.internal_name] for meta in categorical]):
        grid = {"subject": str(df["subject"].iloc[0])}
        factors = {}
        for meta, level in zip(categorical, combo):
            grid[meta.internal_name] = level
            factors[meta.original_name] = str(level)
        for meta in predictor_metas:
            if meta.is_continuous:
                grid[meta.internal_name] = defaults[meta.internal_name]
                factors[meta.original_name] = format_number(defaults[meta.internal_name])

        x_vector = _grid_row_to_exog(fit_for_inference, grid)
        estimate = _estimate_from_vector(
            x_vector,
            fe_params,
            cov_fe,
            alpha,
            df_approx,
            phase1a_inference=phase1a_inference,
        )
        mask = pd.Series(True, index=df.index)
        for meta, level in zip(categorical, combo):
            mask = mask & (df[meta.internal_name].astype(str) == str(level))
        rows.append(
            {
                "factors": factors,
                "emmean": format_number(estimate["estimate"]),
                "se": format_number(estimate["se"]),
                "ci_lower": format_number(estimate["ci_lower"]),
                "ci_upper": format_number(estimate["ci_upper"]),
                "df": format_number(estimate["df"]) if estimate["df"] is not None else None,
                "inference": estimate["inference"],
                "n": int(mask.sum()),
            }
        )

    return rows


def _build_cell_summaries(df: pd.DataFrame, predictor_metas: list[PredictorMeta], alpha: float) -> list[dict[str, Any]]:
    categorical = [meta for meta in predictor_metas if meta.is_categorical]
    if not categorical:
        return []

    summaries = []
    grouped = df.groupby([meta.internal_name for meta in categorical], sort=False, observed=False)
    for key, group in grouped:
        values = group["DV"].astype(float).to_numpy()
        n = int(values.size)
        mean = float(values.mean())
        std = float(values.std(ddof=1)) if n > 1 else 0.0
        se = std / math.sqrt(n) if n > 0 else float("nan")
        critical = _critical_value(alpha, max(n - 1, 1))
        if not isinstance(key, tuple):
            key = (key,)
        summaries.append(
            {
                "factors": {meta.original_name: str(level) for meta, level in zip(categorical, key)},
                "mean": format_number(mean),
                "std": format_number(std),
                "se": format_number(se) if np.isfinite(se) else None,
                "ci_lower": format_number(mean - critical * se) if np.isfinite(se) else None,
                "ci_upper": format_number(mean + critical * se) if np.isfinite(se) else None,
                "n": n,
            }
        )
    return summaries


def _normalize_simple_effects(
    simple_effects_config: list[dict[str, str]] | dict[str, bool] | None,
    predictor_metas: list[PredictorMeta],
) -> list[dict[str, str]]:
    if not simple_effects_config:
        return []
    categorical = [meta.original_name for meta in predictor_metas if meta.is_categorical]
    if len(categorical) < 2:
        return []

    if isinstance(simple_effects_config, list):
        normalized = []
        for item in simple_effects_config:
            if not isinstance(item, dict):
                continue
            factor = item.get("factor")
            within = item.get("within")
            if factor in categorical and within in categorical and factor != within:
                normalized.append({"factor": factor, "within": within})
        return normalized

    if isinstance(simple_effects_config, dict):
        first, second = categorical[:2]
        normalized = []
        if simple_effects_config.get("factor_a_within_factor_b"):
            normalized.append({"factor": first, "within": second})
        if simple_effects_config.get("factor_b_within_factor_a"):
            normalized.append({"factor": second, "within": first})
        return normalized

    return []


def _normalize_time_transform(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"", "none"}:
        return None
    if normalized == "center_scale":
        return normalized
    return None


def _normalize_continuous_effects_config(
    continuous_effects_config: Dict[str, Any] | None,
    predictor_metas: list[PredictorMeta],
) -> Dict[str, Any] | None:
    if not isinstance(continuous_effects_config, dict):
        return None

    mode = str(continuous_effects_config.get("mode", "")).strip().lower()
    if mode != "at_values":
        return None

    group_factor = str(continuous_effects_config.get("group_factor", "")).strip()
    time_factor = str(continuous_effects_config.get("time_factor", "")).strip()
    if not group_factor or not time_factor or group_factor == time_factor:
        return None

    group_meta = next((meta for meta in predictor_metas if meta.original_name == group_factor), None)
    time_meta = next((meta for meta in predictor_metas if meta.original_name == time_factor), None)
    if group_meta is None or time_meta is None:
        return None
    if not group_meta.is_categorical or not time_meta.is_continuous:
        return None

    raw_values = continuous_effects_config.get("time_values")
    if not isinstance(raw_values, Sequence) or isinstance(raw_values, (str, bytes)):
        return None

    time_values: list[float] = []
    seen: set[float] = set()
    for value in raw_values:
        try:
            numeric = float(value)
        except Exception:
            continue
        if not math.isfinite(numeric) or numeric in seen:
            continue
        seen.add(numeric)
        time_values.append(numeric)

    if not time_values:
        return None

    normalized = {
        "mode": "at_values",
        "group_factor": group_factor,
        "time_factor": time_factor,
        "time_values": time_values,
    }
    display_values = continuous_effects_config.get("display_time_values")
    if isinstance(display_values, Sequence) and not isinstance(display_values, (str, bytes)):
        normalized["display_time_values"] = list(display_values)
    transform_mode = _normalize_time_transform(continuous_effects_config.get("time_transform"))
    if transform_mode is not None:
        normalized["time_transform"] = transform_mode
    if continuous_effects_config.get("time_transform_center") is not None:
        normalized["time_transform_center"] = float(continuous_effects_config["time_transform_center"])
    if continuous_effects_config.get("time_transform_scale") is not None:
        normalized["time_transform_scale"] = float(continuous_effects_config["time_transform_scale"])
    return normalized


def _center_scale_continuous_series(values: pd.Series) -> tuple[pd.Series, float, float]:
    numeric = pd.to_numeric(values, errors="coerce")
    center = float(numeric.mean())
    scale = float(numeric.std(ddof=1))
    if not pd.notna(scale) or scale <= 0.0:
        raise ValueError("center_scale transform requires a positive sample standard deviation")
    transformed = (numeric - center) / scale
    return transformed.astype(float), center, scale


def _prepare_numeric_time_random_slope_transform(
    df: pd.DataFrame,
    predictor_metas: list[PredictorMeta],
    slope_metas: list[PredictorMeta],
    continuous_effects_config: Dict[str, Any] | None,
) -> tuple[pd.DataFrame, Dict[str, Any] | None, Dict[str, Any] | None]:
    config = _normalize_continuous_effects_config(continuous_effects_config, predictor_metas)
    if config is None or len(slope_metas) != 1:
        return df, config, None
    if slope_metas[0].original_name != config["time_factor"]:
        return df, config, None
    transform_mode = _normalize_time_transform(config.get("time_transform"))
    if transform_mode != "center_scale":
        return df, config, None

    time_meta = next((meta for meta in predictor_metas if meta.original_name == config["time_factor"]), None)
    if time_meta is None:
        return df, config, None

    transformed_df = df.copy()
    transformed_series, center, scale = _center_scale_continuous_series(df[time_meta.internal_name])
    transformed_df[time_meta.internal_name] = transformed_series
    display_time_values = list(config.get("display_time_values") or config["time_values"])
    model_time_values = [float((value - center) / scale) for value in config["time_values"]]
    runtime_config = {
        **config,
        "time_values": model_time_values,
        "display_time_values": display_time_values,
        "time_transform": transform_mode,
        "time_transform_center": center,
        "time_transform_scale": scale,
    }
    transform_info = {
        "applied": True,
        "mode": transform_mode,
        "time_factor": time_meta.original_name,
        "center": center,
        "scale": scale,
        "display_time_values": display_time_values,
        "model_time_values": model_time_values,
    }
    return transformed_df, runtime_config, transform_info


def _contrast_payload(
    fe_params: np.ndarray,
    cov_fe: np.ndarray,
    x_left: np.ndarray,
    x_right: np.ndarray,
    left_label: str,
    right_label: str,
    alpha: float,
    df_approx: float,
    phase1a_inference: Dict[str, Any] | None = None,
) -> dict[str, Any]:
    contrast = x_left - x_right
    estimate = float(contrast @ fe_params)
    variance = float(contrast @ cov_fe @ contrast.T)
    variance = max(variance, 0.0)
    se = float(math.sqrt(variance))
    statistic = estimate / se if se > 0 else 0.0
    if phase1a_inference is not None:
        method = str(phase1a_inference.get("method", "satterthwaite"))
        if method == "kenward_roger":
            se, statistic, contrast_df, p_raw = infer_kr_1d(
                phase1a_inference["kr_bundle"],
                contrast,
                estimate,
            )
            inference = "kenward_roger_t"
            df_fallback_reason = None
        else:
            contrast_df = satterthwaite_df_1d(
                contrast,
                cov_fe,
                phase1a_inference["cov_beta_jacobian"],
                phase1a_inference["theta_cov"],
            )
            if np.isfinite(contrast_df):
                statistic, p_raw = infer_1d_from_df(estimate, se, contrast_df)
                inference = "satterthwaite_t"
                df_fallback_reason = None
            else:
                contrast_df = float("inf")
                statistic, p_raw = infer_1d_from_df(estimate, se, contrast_df)
                inference = "asymptotic_z"
                df_fallback_reason = (
                    "Row-level Satterthwaite df was unavailable for this contrast; "
                    "fell back to asymptotic inference for this row."
                )
    else:
        contrast_df = df_approx
        p_raw = _two_sided_p(statistic, df_approx)
        inference = "asymptotic_z" if not np.isfinite(df_approx) else "residual_t"
        df_fallback_reason = None
    critical = _critical_value(alpha, contrast_df)
    result = {
        "group1": left_label,
        "group2": right_label,
        "estimate": estimate,
        "se": se,
        "t_stat": statistic,
        "df": contrast_df,
        "p_raw": p_raw,
        "p_adjusted": p_raw,
        "ci_lower": estimate - critical * se,
        "ci_upper": estimate + critical * se,
        "contrast_vector": contrast,
        "inference": inference,
    }
    if df_fallback_reason:
        result["df_fallback_reason"] = df_fallback_reason
    return result


def _apply_dunnett_adjustment(
    comparisons: list[dict[str, Any]],
    control_level: str,
    alpha: float,
    df_approx: float,
    cov_fe: np.ndarray,
) -> list[dict[str, Any]]:
    selected = [comp for comp in comparisons if control_level in {comp["group1"], comp["group2"]}]
    if not selected:
        return []

    # Canonicalize Dunnett rows so control is always reported as group2.
    # This avoids orientation flips driven by factor-level ordering.
    for comp in selected:
        if comp["group2"] == control_level:
            continue
        if comp["group1"] != control_level:
            continue

        original_group2 = comp["group2"]
        comp["group1"] = original_group2
        comp["group2"] = control_level
        comp["estimate"] = float(-float(comp["estimate"]))
        comp["t_stat"] = float(-float(comp["t_stat"]))

        if "contrast_vector" in comp and comp["contrast_vector"] is not None:
            comp["contrast_vector"] = -np.asarray(comp["contrast_vector"], dtype=float)

        if "ci_lower" in comp and "ci_upper" in comp:
            ci_lower = float(comp["ci_lower"])
            ci_upper = float(comp["ci_upper"])
            comp["ci_lower"] = float(-ci_upper)
            comp["ci_upper"] = float(-ci_lower)

    if len(selected) == 1:
        comp = selected[0]
        contrast_df = float(comp.get("df", df_approx))
        critical = _critical_value(alpha, contrast_df)
        comp["p_adjusted"] = float(comp["p_raw"])
        comp["ci_lower"] = float(comp["estimate"] - critical * comp["se"])
        comp["ci_upper"] = float(comp["estimate"] + critical * comp["se"])
        comp["method"] = "Dunnett (model-based)"
        return selected

    contrast_cov = np.zeros((len(selected), len(selected)), dtype=float)
    for i, left in enumerate(selected):
        for j, right in enumerate(selected):
            contrast_cov[i, j] = float(left["contrast_vector"] @ cov_fe @ right["contrast_vector"].T)

    se = np.sqrt(np.clip(np.diag(contrast_cov), a_min=0.0, a_max=None))
    denom = np.outer(se, se)
    correlation = np.divide(
        contrast_cov,
        denom,
        out=np.eye(len(selected), dtype=float),
        where=denom > 0,
    )
    correlation = np.clip(correlation, -0.999999, 0.999999)
    np.fill_diagonal(correlation, 1.0)
    finite_dfs = [float(comp["df"]) for comp in selected if np.isfinite(float(comp.get("df", df_approx)))]
    adjustment_df = min(finite_dfs) if finite_dfs else df_approx
    mvt = stats.multivariate_t(shape=correlation, df=_multicomp_df(adjustment_df))

    for comp in selected:
        stat_value = abs(comp["t_stat"])
        upper = np.full(len(selected), stat_value, dtype=float)
        lower = np.full(len(selected), -stat_value, dtype=float)
        p_adj = 1.0 - float(mvt.cdf(upper, lower_limit=lower))
        comp["p_adjusted"] = float(np.clip(p_adj, 0.0, 1.0))
        comp["method"] = "Dunnett (model-based)"

    def objective(critical: float) -> float:
        upper = np.full(len(selected), critical, dtype=float)
        lower = np.full(len(selected), -critical, dtype=float)
        rectangle_prob = float(mvt.cdf(upper, lower_limit=lower))
        return (1.0 - rectangle_prob) - alpha

    critical = _critical_value(alpha, adjustment_df)
    upper_bound = 2.0
    while objective(upper_bound) > 0 and upper_bound < 50.0:
        upper_bound *= 2.0
    if objective(upper_bound) <= 0:
        critical = float(optimize.brentq(objective, 0.0, upper_bound))

    for comp in selected:
        margin = critical * comp["se"]
        comp["ci_lower"] = float(comp["estimate"] - margin)
        comp["ci_upper"] = float(comp["estimate"] + margin)
    return selected


def _apply_lmm_adjustment(
    comparisons: list[dict[str, Any]],
    method: str,
    alpha: float,
    q: float | None,
    family_size: int,
    df_approx: float,
    control_level: Any,
    cov_fe: np.ndarray,
) -> list[dict[str, Any]]:
    if not comparisons:
        return []

    finite_dfs = [float(comp["df"]) for comp in comparisons if np.isfinite(float(comp.get("df", df_approx)))]
    adjustment_df = min(finite_dfs) if finite_dfs else df_approx

    if method == "tukey":
        if family_size <= 2:
            critical = _critical_value(alpha, adjustment_df)
            for comp in comparisons:
                comp["p_adjusted"] = float(comp["p_raw"])
                margin = critical * comp["se"]
                comp["ci_lower"] = float(comp["estimate"] - margin)
                comp["ci_upper"] = float(comp["estimate"] + margin)
                comp["method"] = "Tukey HSD (model-based)"
            return comparisons
        tukey_df = _multicomp_df(adjustment_df)
        if hasattr(stats, "studentized_range"):
            critical = float(stats.studentized_range.isf(alpha, family_size, tukey_df))
        else:
            critical = float(np.asarray(qsturng(1 - alpha, family_size, tukey_df)).reshape(-1)[0])
        for comp in comparisons:
            q_stat = abs(comp["t_stat"]) * math.sqrt(2.0)
            if hasattr(stats, "studentized_range"):
                p_adj = float(stats.studentized_range.sf(q_stat, family_size, tukey_df))
            else:
                p_adj = float(np.asarray(psturng(q_stat, family_size, tukey_df)).reshape(-1)[0])
            margin = critical * comp["se"] / math.sqrt(2.0)
            comp["p_adjusted"] = p_adj
            comp["ci_lower"] = float(comp["estimate"] - margin)
            comp["ci_upper"] = float(comp["estimate"] + margin)
            comp["method"] = "Tukey HSD (model-based)"
        return comparisons

    if method == "dunnett":
        if control_level is None:
            raise ValueError("Dunnett adjustment requires a control level.")
        return _apply_dunnett_adjustment(comparisons, str(control_level), alpha, adjustment_df, cov_fe)

    raw_p = [float(comp["p_raw"]) for comp in comparisons]
    threshold = _normalize_q(q, alpha) if method == "fdr_bh" else alpha
    reject, adjusted, _, _ = multipletests(raw_p, alpha=threshold, method=method)
    label = get_method_label(method)
    for comp, p_value, is_reject in zip(comparisons, adjusted, reject):
        comp["p_adjusted"] = float(p_value)
        comp["significant"] = bool(is_reject)
        comp["method"] = label
    return comparisons


def _format_pairwise_entry(
    comparison: dict[str, Any],
    threshold: float,
    factor: str | None = None,
    factor_scope: str | None = None,
) -> dict[str, Any]:
    entry = {
        "group1": str(comparison["group1"]),
        "group2": str(comparison["group2"]),
        "contrast": f"{comparison['group1']} vs {comparison['group2']}",
        "difference": format_number(comparison["estimate"]),
        "estimate": format_number(comparison["estimate"]),
        "p_value": format_number(comparison["p_adjusted"]),
        "p_adjusted": format_number(comparison["p_adjusted"]),
        "p_raw": format_number(comparison["p_raw"]),
        "p_value_display": (
            f"{format_number(comparison['p_raw'])} (praw) / "
            f"{format_number(comparison['p_adjusted'])} (padj)"
        ),
        "ci_lower": format_number(comparison["ci_lower"]),
        "ci_upper": format_number(comparison["ci_upper"]),
        "significant": bool(comparison["p_adjusted"] < threshold),
        "se": format_number(comparison["se"]),
        "t_stat": format_number(comparison["t_stat"]),
        "df": _display_df(float(comparison.get("df", np.inf))),
        "method": comparison.get("method", ""),
        "inference": str(comparison.get("inference", "")),
    }
    if comparison.get("df_fallback_reason"):
        entry["df_fallback_reason"] = str(comparison["df_fallback_reason"])
    if factor is not None:
        entry["factor"] = factor
    if factor_scope is not None:
        entry["factor_scope"] = factor_scope
    return entry


def _build_continuous_time_followups(
    fit,
    df: pd.DataFrame,
    predictor_metas: list[PredictorMeta],
    alpha: float,
    adjustment_method: str,
    control_levels: Dict[str, Any],
    posthoc_q: float | None,
    continuous_effects_config: Dict[str, Any] | None,
    df_approx: float,
    phase1a_inference: Dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    config = _normalize_continuous_effects_config(continuous_effects_config, predictor_metas)
    if config is None:
        return [], [], [], []
    display_time_values = list(config.get("display_time_values") or config["time_values"])
    if len(display_time_values) != len(config["time_values"]):
        display_time_values = list(config["time_values"])

    fit_for_inference = phase1a_inference.get("fit", fit) if phase1a_inference is not None else fit
    fe_params, cov_fe = _fixed_covariance(fit_for_inference)
    if phase1a_inference is not None:
        fe_params = phase1a_inference["fe_params"]
        cov_fe = phase1a_inference["cov_beta"]
    contrast_term_names = list(fit_for_inference.fe_params.index)

    group_meta = next(meta for meta in predictor_metas if meta.original_name == config["group_factor"])
    time_meta = next(meta for meta in predictor_metas if meta.original_name == config["time_factor"])
    group_levels = _categorical_levels(df, predictor_metas).get(group_meta.internal_name, [])
    if len(group_levels) < 2:
        return [], [], [], [
            (
                f"Continuous-time contrasts for {group_meta.original_name} at selected "
                f"{time_meta.original_name} values were skipped because fewer than 2 "
                "levels remained in the fitted data."
            )
        ]

    defaults = _continuous_defaults(df, predictor_metas)
    other_cats = [meta for meta in predictor_metas if meta.is_categorical and meta.internal_name != group_meta.internal_name]
    other_level_sets = [_categorical_levels(df, predictor_metas)[meta.internal_name] for meta in other_cats]
    other_combos = list(itertools.product(*other_level_sets)) if other_level_sets else [()]
    threshold = _normalize_q(posthoc_q, alpha) if adjustment_method == "fdr_bh" else alpha

    pairwise_rows: list[dict[str, Any]] = []
    continuous_records: list[dict[str, Any]] = []
    per_group_means_over_time: list[dict[str, Any]] = []

    for model_time_value, display_time_value in zip(config["time_values"], display_time_values):
        vectors: Dict[str, np.ndarray] = {}
        for group_level in group_levels:
            level_vectors = []
            for other_combo in other_combos:
                grid = {
                    "subject": str(df["subject"].iloc[0]),
                    group_meta.internal_name: group_level,
                    time_meta.internal_name: model_time_value,
                }
                for meta, other_level in zip(other_cats, other_combo):
                    grid[meta.internal_name] = other_level
                for meta in predictor_metas:
                    if meta.is_continuous and meta.internal_name != time_meta.internal_name:
                        grid[meta.internal_name] = defaults[meta.internal_name]
                level_vectors.append(_grid_row_to_exog(fit_for_inference, grid))
            vectors[str(group_level)] = np.mean(level_vectors, axis=0)

        time_label = _normalize_time_value_label(display_time_value)
        for group_label in [str(level) for level in group_levels]:
            estimate = _estimate_from_vector(
                vectors[group_label],
                fe_params,
                cov_fe,
                alpha,
                df_approx,
                phase1a_inference=phase1a_inference,
            )
            observed_mask = (
                (df[group_meta.internal_name].astype(str) == group_label)
                & np.isclose(
                    pd.to_numeric(df[time_meta.internal_name], errors="coerce"),
                    float(model_time_value),
                    equal_nan=False,
                )
            )
            per_group_means_over_time.append(
                {
                    "group_factor": group_meta.original_name,
                    "group_value": group_label,
                    "time_factor": time_meta.original_name,
                    "time_value": time_label,
                    "mean": format_number(estimate["estimate"]),
                    "se": format_number(estimate["se"]),
                    "ci_lower": format_number(estimate["ci_lower"]),
                    "ci_upper": format_number(estimate["ci_upper"]),
                    "df": format_number(estimate["df"]) if estimate["df"] is not None else None,
                    "inference": estimate["inference"],
                    "n": int(observed_mask.sum()),
                }
            )

        comparisons = []
        level_labels = [str(level) for level in group_levels]
        for left, right in itertools.combinations(level_labels, 2):
            comparisons.append(
                _contrast_payload(
                    fe_params,
                    cov_fe,
                    vectors[left],
                    vectors[right],
                    left,
                    right,
                    alpha,
                    df_approx,
                    phase1a_inference=phase1a_inference,
                )
            )

        comparisons = _apply_lmm_adjustment(
            comparisons,
            adjustment_method,
            alpha,
            posthoc_q,
            len(level_labels),
            df_approx,
            control_levels.get(group_meta.original_name),
            cov_fe,
        )

        scope = f"{group_meta.original_name}|{time_meta.original_name}={time_label}"
        for comparison in comparisons:
            entry = _format_pairwise_entry(comparison, threshold, factor=group_meta.original_name, factor_scope=scope)
            entry["time_factor"] = time_meta.original_name
            entry["time_value"] = time_label
            pairwise_rows.append(entry)
            continuous_records.append(
                {
                    "label": (
                        f"{comparison['group1']} vs {comparison['group2']}|"
                        f"{group_meta.original_name}|{time_meta.original_name}={time_label}"
                    ),
                    "effect": group_meta.original_name,
                    "time_factor": time_meta.original_name,
                    "time_value": time_label,
                    "estimate": comparison["estimate"],
                    "se": comparison["se"],
                    "ci_lower": comparison["ci_lower"],
                    "ci_upper": comparison["ci_upper"],
                    "df": (float(comparison["df"]) if np.isfinite(float(comparison.get("df", np.inf))) else None),
                    "t_ratio": comparison["t_stat"],
                    "p_raw": comparison["p_raw"],
                    "p": comparison["p_adjusted"],
                    "contrast_vector": _serialize_named_vector(
                        contrast_term_names,
                        np.asarray(comparison["contrast_vector"], dtype=float).tolist(),
                    ),
                }
            )

    return pairwise_rows, continuous_records, per_group_means_over_time, []


def _build_pairwise_outputs(
    fit,
    df: pd.DataFrame,
    predictor_metas: list[PredictorMeta],
    alpha: float,
    adjustment_method: str,
    control_levels: Dict[str, Any],
    posthoc_q: float | None,
    simple_effects: list[dict[str, str]],
    df_approx: float,
    phase1a_inference: Dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    categorical = [meta for meta in predictor_metas if meta.is_categorical]
    if not categorical:
        return [], [], []

    fit_for_inference = phase1a_inference.get("fit", fit) if phase1a_inference is not None else fit
    fe_params, cov_fe = _fixed_covariance(fit_for_inference)
    if phase1a_inference is not None:
        fe_params = phase1a_inference["fe_params"]
        cov_fe = phase1a_inference["cov_beta"]
    levels_map = _categorical_levels(df, predictor_metas)
    defaults = _continuous_defaults(df, predictor_metas)
    pairwise_rows = []
    marginal_records = []
    simple_records = []
    threshold = _normalize_q(posthoc_q, alpha) if adjustment_method == "fdr_bh" else alpha

    for target in categorical:
        marginal_vectors: Dict[str, np.ndarray] = {}
        other_cats = [meta for meta in categorical if meta.internal_name != target.internal_name]
        other_level_sets = [levels_map[meta.internal_name] for meta in other_cats]
        combos = list(itertools.product(*other_level_sets)) if other_level_sets else [()]

        for level in levels_map[target.internal_name]:
            vectors = []
            for combo in combos:
                grid = {"subject": str(df["subject"].iloc[0]), target.internal_name: level}
                for meta, other_level in zip(other_cats, combo):
                    grid[meta.internal_name] = other_level
                for meta in predictor_metas:
                    if meta.is_continuous:
                        grid[meta.internal_name] = defaults[meta.internal_name]
                vectors.append(_grid_row_to_exog(fit_for_inference, grid))
            marginal_vectors[str(level)] = np.mean(vectors, axis=0)

        comparisons = []
        level_labels = [str(level) for level in levels_map[target.internal_name]]
        for left, right in itertools.combinations(level_labels, 2):
            comparisons.append(
                _contrast_payload(
                    fe_params,
                    cov_fe,
                    marginal_vectors[left],
                    marginal_vectors[right],
                    left,
                    right,
                    alpha,
                    df_approx,
                    phase1a_inference=phase1a_inference,
                )
            )

        comparisons = _apply_lmm_adjustment(
            comparisons,
            adjustment_method,
            alpha,
            posthoc_q,
            len(level_labels),
            df_approx,
            control_levels.get(target.original_name),
            cov_fe,
        )

        for comparison in comparisons:
            pairwise_rows.append(
                _format_pairwise_entry(comparison, threshold, factor=target.original_name)
            )
            marginal_records.append(
                {
                    "factor": target.original_name,
                    "label": f"{comparison['group1']} - {comparison['group2']}",
                    "estimate": comparison["estimate"],
                    "se": comparison["se"],
                    "ci_lower": comparison["ci_lower"],
                    "ci_upper": comparison["ci_upper"],
                    "df": (float(comparison["df"]) if np.isfinite(float(comparison.get("df", np.inf))) else None),
                    "t_ratio": comparison["t_stat"],
                    "p_raw": comparison["p_raw"],
                    "p": comparison["p_adjusted"],
                }
            )

    for effect in simple_effects:
        factor_meta = next((meta for meta in categorical if meta.original_name == effect["factor"]), None)
        within_meta = next((meta for meta in categorical if meta.original_name == effect["within"]), None)
        if factor_meta is None or within_meta is None:
            continue

        factor_levels = [str(level) for level in levels_map[factor_meta.internal_name]]
        other_cats = [
            meta
            for meta in categorical
            if meta.internal_name not in {factor_meta.internal_name, within_meta.internal_name}
        ]
        other_level_sets = [levels_map[meta.internal_name] for meta in other_cats]
        other_combos = list(itertools.product(*other_level_sets)) if other_level_sets else [()]

        for within_level in levels_map[within_meta.internal_name]:
            vectors = {}
            for factor_level in factor_levels:
                level_vectors = []
                for other_combo in other_combos:
                    grid = {
                        "subject": str(df["subject"].iloc[0]),
                        factor_meta.internal_name: factor_level,
                        within_meta.internal_name: within_level,
                    }
                    for meta, other_level in zip(other_cats, other_combo):
                        grid[meta.internal_name] = other_level
                    for meta in predictor_metas:
                        if meta.is_continuous:
                            grid[meta.internal_name] = defaults[meta.internal_name]
                    level_vectors.append(_grid_row_to_exog(fit_for_inference, grid))
                vectors[factor_level] = np.mean(level_vectors, axis=0)

            comparisons = []
            for left, right in itertools.combinations(factor_levels, 2):
                comparisons.append(
                    _contrast_payload(
                        fe_params,
                        cov_fe,
                        vectors[left],
                        vectors[right],
                        left,
                        right,
                        alpha,
                        df_approx,
                        phase1a_inference=phase1a_inference,
                    )
                )

            comparisons = _apply_lmm_adjustment(
                comparisons,
                adjustment_method,
                alpha,
                posthoc_q,
                len(factor_levels),
                df_approx,
                control_levels.get(factor_meta.original_name),
                cov_fe,
            )

            scope = f"{factor_meta.original_name}|{within_meta.original_name}={within_level}"
            for comparison in comparisons:
                pairwise_rows.append(
                    _format_pairwise_entry(comparison, threshold, factor_scope=scope)
                )
                simple_records.append(
                    {
                        "label": f"{comparison['group1']} - {comparison['group2']}|{factor_meta.original_name}|{within_meta.original_name}={within_level}",
                        "estimate": comparison["estimate"],
                        "se": comparison["se"],
                        "ci_lower": comparison["ci_lower"],
                        "ci_upper": comparison["ci_upper"],
                        "df": (float(comparison["df"]) if np.isfinite(float(comparison.get("df", np.inf))) else None),
                        "t_ratio": comparison["t_stat"],
                        "p_raw": comparison["p_raw"],
                        "p": comparison["p_adjusted"],
                    }
                )

    return pairwise_rows, marginal_records, simple_records


def _flatten_pairwise_records(
    result: Dict[str, Any],
    marginal_records: list[dict[str, Any]],
    simple_records: list[dict[str, Any]],
    continuous_records: list[dict[str, Any]] | None = None,
) -> None:
    for index, record in enumerate(marginal_records, start=1):
        prefix = f"me{index}"
        result[f"{prefix}_factor"] = record["factor"]
        result[f"{prefix}_label"] = record["label"]
        result[f"{prefix}_estimate"] = format_number(record["estimate"])
        result[f"{prefix}_se"] = format_number(record["se"])
        result[f"{prefix}_ci_lower"] = format_number(record["ci_lower"])
        result[f"{prefix}_ci_upper"] = format_number(record["ci_upper"])
        result[f"{prefix}_df"] = format_number(record["df"]) if record["df"] is not None else None
        result[f"{prefix}_t_ratio"] = format_number(record["t_ratio"])
        result[f"{prefix}_t"] = format_number(record["t_ratio"])
        result[f"{prefix}_p_raw"] = format_number(record["p_raw"])
        result[f"{prefix}_p_adjusted"] = format_number(record["p"])
        result[f"{prefix}_p"] = format_number(record["p"])

    for index, record in enumerate(simple_records, start=1):
        prefix = f"se{index}"
        result[f"{prefix}_label"] = record["label"]
        result[f"{prefix}_estimate"] = format_number(record["estimate"])
        result[f"{prefix}_se"] = format_number(record["se"])
        result[f"{prefix}_ci_lower"] = format_number(record["ci_lower"])
        result[f"{prefix}_ci_upper"] = format_number(record["ci_upper"])
        result[f"{prefix}_df"] = format_number(record["df"]) if record["df"] is not None else None
        result[f"{prefix}_t_ratio"] = format_number(record["t_ratio"])
        result[f"{prefix}_t"] = format_number(record["t_ratio"])
        result[f"{prefix}_p_raw"] = format_number(record["p_raw"])
        result[f"{prefix}_p_adjusted"] = format_number(record["p"])
        result[f"{prefix}_p"] = format_number(record["p"])

    for index, record in enumerate(continuous_records or [], start=1):
        prefix = f"ce{index}"
        result[f"{prefix}_label"] = record["label"]
        result[f"{prefix}_effect"] = record["effect"]
        result[f"{prefix}_time_factor"] = record["time_factor"]
        result[f"{prefix}_time_value"] = record["time_value"]
        result[f"{prefix}_estimate"] = format_number(record["estimate"])
        result[f"{prefix}_se"] = format_number(record["se"])
        result[f"{prefix}_ci_lower"] = format_number(record["ci_lower"])
        result[f"{prefix}_ci_upper"] = format_number(record["ci_upper"])
        result[f"{prefix}_df"] = format_number(record["df"]) if record["df"] is not None else None
        result[f"{prefix}_t_ratio"] = format_number(record["t_ratio"])
        result[f"{prefix}_t"] = format_number(record["t_ratio"])
        result[f"{prefix}_p_raw"] = format_number(record["p_raw"])
        result[f"{prefix}_p_adjusted"] = format_number(record["p"])
        result[f"{prefix}_p"] = format_number(record["p"])


def _flatten_fixed_effects(result: Dict[str, Any], fixed_effects: list[dict[str, Any]]) -> None:
    for index, record in enumerate(fixed_effects, start=1):
        prefix = f"fe{index}"
        result[f"{prefix}_source"] = record["source"]
        result[f"{prefix}_statistic_type"] = record.get("statistic_type")
        result[f"{prefix}_chi_square"] = format_number(record["chi_square"])
        result[f"{prefix}_statistic"] = format_number(record["statistic"])
        result[f"{prefix}_f_value"] = format_number(record.get("f_value"))
        result[f"{prefix}_num_df"] = record.get("num_df")
        result[f"{prefix}_den_df"] = format_number(record.get("den_df"))
        result[f"{prefix}_df"] = format_number(record["df"]) if record["df"] is not None else None
        result[f"{prefix}_p"] = format_number(record["p_value"])
        result[f"{prefix}_significant"] = bool(record["significant"])


def _flatten_fit_metrics(result: Dict[str, Any], fit_metrics: Dict[str, Any]) -> None:
    for key, value in fit_metrics.items():
        result[f"fit_{key}"] = value


def _flatten_diagnostics(result: Dict[str, Any], diagnostics: Dict[str, Any]) -> None:
    result["diag_converged"] = bool(diagnostics.get("converged", False))
    result["diag_singular_fit"] = bool(diagnostics.get("singular_fit", False))
    result["diag_near_zero_random_variance"] = bool(diagnostics.get("near_zero_random_variance", False))
    result["diag_rows_dropped"] = int(diagnostics.get("rows_dropped", 0))

    normality = diagnostics.get("residual_normality", {})
    result["diag_residual_normality_statistic"] = normality.get("statistic")
    result["diag_residual_normality_p"] = normality.get("p_value")
    result["diag_residual_normality_normal"] = normality.get("normal")

    spread = diagnostics.get("residual_spread", {})
    result["diag_residual_spread_statistic"] = spread.get("statistic")
    result["diag_residual_spread_p"] = spread.get("p_value")

    random_effect_variances = diagnostics.get("random_effect_variances", [])
    for index, value in enumerate(random_effect_variances, start=1):
        result[f"diag_random_effect_variance_{index}"] = value


def lmm_anova(
    dependent: Sequence[Any],
    subject: Sequence[Any],
    predictors: Dict[str, Sequence[Any]],
    predictor_types: Dict[str, str] | None = None,
    alpha: float = 0.05,
    reml: bool = False,
    random_effects_config: Dict[str, Any] | None = None,
    simple_effects_config: list[dict[str, str]] | dict[str, bool] | None = None,
    continuous_effects_config: Dict[str, Any] | None = None,
    factor_level_labels: Dict[str, Sequence[Any]] | None = None,
    posthoc_adjustment: str = "tukey",
    control_levels: Dict[str, Any] | None = None,
    posthoc_q: float | None = None,
    interaction_depth: int | None = 2,
    df_method: str = "satterthwaite",
    stratify_by: Sequence[str] | None = None,
    trajectory_roles: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    try:
        invalid_df_method = _validate_df_method(df_method)
        if invalid_df_method:
            return _error(invalid_df_method, trajectory_roles=trajectory_roles)

        normalized_stratify_by = _normalize_stratify_by(stratify_by)
        if normalized_stratify_by:
            return _run_stratified_lmm(
                dependent,
                subject,
                predictors,
                predictor_types,
                alpha,
                reml,
                random_effects_config,
                simple_effects_config,
                factor_level_labels,
                posthoc_adjustment,
                control_levels,
                posthoc_q,
                interaction_depth,
                df_method,
                normalized_stratify_by,
                continuous_effects_config,
                trajectory_roles=trajectory_roles,
            )

        adjustment_method = _normalize_adjustment(posthoc_adjustment)
        df_method = _normalize_df_method(df_method)
        predictor_types = predictor_types or {}
        factor_level_labels = factor_level_labels or {}
        random_effects_config = random_effects_config or {}
        control_levels = control_levels or {}

        if not isinstance(predictors, dict) or not predictors:
            return _error("lmm_anova requires at least one predictor.", trajectory_roles=trajectory_roles)

        row_count = len(dependent)
        if len(subject) != row_count:
            return _error("dependent and subject must have the same length.", trajectory_roles=trajectory_roles)

        predictor_metas = _build_predictor_metas(predictors, predictor_types, factor_level_labels)
        for name, values in predictors.items():
            if len(values) != row_count:
                return _error(f"Predictor '{name}' length does not match dependent length.", trajectory_roles=trajectory_roles)

        df = pd.DataFrame(
            {
                "DV": pd.to_numeric(pd.Series(dependent), errors="coerce"),
                "subject": pd.Series(subject, dtype="object"),
            }
        )
        group_values = random_effects_config.get("group_values")
        if group_values is not None:
            if len(group_values) != row_count:
                return _error("random_effects_config.group_values must match dependent length.", trajectory_roles=trajectory_roles)
            df["group_id"] = pd.Series(group_values, dtype="object")
        else:
            df["group_id"] = df["subject"].astype("object")
        for meta in predictor_metas:
            raw_values = predictors[meta.original_name]
            if meta.is_categorical:
                df[meta.internal_name] = _prepare_categorical_series(raw_values, meta.labels)
            else:
                df[meta.internal_name] = pd.to_numeric(pd.Series(raw_values), errors="coerce")

        model_columns = ["DV", "subject", "group_id", *[meta.internal_name for meta in predictor_metas]]
        initial_rows = len(df)
        df = df.dropna(subset=model_columns).copy()
        dropped_rows = initial_rows - len(df)
        if len(df) < 6:
            return _error("Insufficient valid rows for lmm_anova after removing missing values.", trajectory_roles=trajectory_roles)

        group_sizes = df.groupby("group_id", sort=False).size()
        if group_sizes.shape[0] < 3:
            return _error("lmm_anova requires at least 3 subjects.", trajectory_roles=trajectory_roles)
        if int(group_sizes.min()) < 2:
            return _error("Each subject requires at least 2 observations for repeated-measures LMM.", trajectory_roles=trajectory_roles)

        for meta in predictor_metas:
            if meta.is_categorical and df[meta.internal_name].nunique() < 2:
                return _error(f"Categorical predictor '{meta.original_name}' requires at least 2 levels.", trajectory_roles=trajectory_roles)

        if adjustment_method == "dunnett":
            categorical_levels = _categorical_levels(df, predictor_metas)
            missing_controls = []
            invalid_controls = []
            for meta in predictor_metas:
                if not meta.is_categorical:
                    continue
                control_level = control_levels.get(meta.original_name)
                if control_level in (None, ""):
                    missing_controls.append(meta.original_name)
                    continue
                if str(control_level) not in categorical_levels.get(meta.internal_name, []):
                    invalid_controls.append(f"{meta.original_name}={control_level}")
            if missing_controls:
                return _error(
                    "Dunnett adjustment requires control levels for all categorical targets: "
                    + ", ".join(missing_controls),
                    trajectory_roles=trajectory_roles,
                )
            if invalid_controls:
                return _error(
                    "Invalid Dunnett control level(s): " + ", ".join(invalid_controls),
                    trajectory_roles=trajectory_roles,
                )

        requested_df_method = df_method
        effective_df_method = requested_df_method
        fixed_formula = _build_fixed_formula(predictor_metas, interaction_depth)
        re_formula, slope_metas = _build_random_formula(random_effects_config, predictor_metas)
        df, runtime_continuous_effects_config, continuous_effects_transform = _prepare_numeric_time_random_slope_transform(
            df,
            predictor_metas,
            slope_metas,
            continuous_effects_config,
        )
        kr_downgrade_warning = None
        if requested_df_method == "kenward_roger" and slope_metas:
            effective_df_method = "satterthwaite"
            kr_downgrade_warning = (
                "Kenward-Roger inference is unavailable for random-slope models; "
                "fell back to Satterthwaite where supported."
            )
        fit, fit_warnings, optimizer_used = _fit_model(df, fixed_formula, re_formula, reml, df["group_id"])
        diagnostics = _build_diagnostics(fit, alpha, dropped_rows, fit_warnings)
        if kr_downgrade_warning is not None:
            diagnostics["warnings"].append(kr_downgrade_warning)
        if continuous_effects_transform is not None:
            diagnostics["warnings"].append(
                "Numeric-time random-slope fit used centered/scaled internal time values for stability; reported time values remain on the original scale."
            )
        finite_df_mode = _finite_df_mode(
            fit,
            slope_metas,
            effective_df_method,
        )
        finite_df_requested = finite_df_mode is not None
        finite_df_boundary_warning = bool(
            finite_df_requested
            and (diagnostics.get("singular_fit") or diagnostics.get("near_zero_random_variance"))
        )
        finite_df_fallback_reason = None
        phase1a_inference = None
        if finite_df_requested:
            unstable_warning = _unstable_random_slope_fit_warning(
                fit_warnings,
                slope_metas,
                effective_df_method,
                allow_boundary_singularity=continuous_effects_transform is not None,
            )
            if unstable_warning is not None:
                finite_df_fallback_reason = (
                    f"{effective_df_method.replace('_', '-').title()} inference unavailable for this fit; "
                    f"fell back to asymptotic inference. ({unstable_warning})"
                )
                diagnostics["warnings"].append(finite_df_fallback_reason)
            else:
                try:
                    if finite_df_mode == "kenward_roger":
                        phase1a_inference = _build_kr_df_inference_bundle(
                            fit,
                            fixed_formula,
                            re_formula,
                            df["group_id"],
                        )
                    else:
                        phase1a_inference = _build_finite_df_inference_bundle(fit)
                    if finite_df_boundary_warning:
                        diagnostics["warnings"].append(
                            "Finite-df inference applied on a singular or near-zero random-effects fit; results may be unstable."
                        )
                    if (
                        phase1a_inference is not None
                        and str(phase1a_inference.get("method")) == "kenward_roger"
                        and bool(phase1a_inference.get("reml_refit"))
                    ):
                        diagnostics["warnings"].append(
                            "Kenward-Roger inference used an internal REML refit for finite-df calculations."
                        )
                except (ValueError, np.linalg.LinAlgError) as exc:
                    finite_df_fallback_reason = (
                        f"{effective_df_method.replace('_', '-').title()} inference unavailable for this fit; fell back to asymptotic inference. ({exc})"
                    )
                    diagnostics["warnings"].append(finite_df_fallback_reason)

        applied_df_method = (
            str(phase1a_inference.get("method"))
            if phase1a_inference is not None
            else ("residual" if effective_df_method == "residual" else "asymptotic")
        )
        contrast_method = (
            "kenward_roger_t"
            if phase1a_inference is not None and applied_df_method == "kenward_roger"
            else (
                "satterthwaite_t"
                if phase1a_inference is not None
                else ("residual_t" if applied_df_method == "residual" else "asymptotic_z")
            )
        )

        fixed_effects, df_approx = _extract_fixed_effects(
            fit,
            predictor_metas,
            alpha,
            effective_df_method,
            phase1a_inference=phase1a_inference,
        )
        estimated_means = _build_estimated_means(
            fit,
            df,
            predictor_metas,
            alpha,
            df_approx,
            phase1a_inference=phase1a_inference,
        )
        cell_summaries = _build_cell_summaries(df, predictor_metas, alpha)
        simple_effects = _normalize_simple_effects(simple_effects_config, predictor_metas)
        fit_metrics = _fit_metrics_payload(fit, optimizer_used)
        pairwise_rows, marginal_records, simple_records = _build_pairwise_outputs(
            fit,
            df,
            predictor_metas,
            alpha,
            adjustment_method,
            control_levels,
            posthoc_q,
            simple_effects,
            df_approx,
            phase1a_inference=phase1a_inference,
        )
        continuous_pairwise_rows, continuous_records, per_group_means_over_time, continuous_warnings = _build_continuous_time_followups(
            fit,
            df,
            predictor_metas,
            alpha,
            adjustment_method,
            control_levels,
            posthoc_q,
            runtime_continuous_effects_config,
            df_approx,
            phase1a_inference=phase1a_inference,
        )
        if continuous_pairwise_rows:
            pairwise_rows.extend(continuous_pairwise_rows)
        if continuous_warnings:
            diagnostics["warnings"].extend(continuous_warnings)

        result: Dict[str, Any] = {
            "success": True,
            "test_type": "lmm_anova",
            "model_type": "gaussian_lmm",
            "formula": fixed_formula,
            "re_formula": re_formula,
            "reml": bool(reml),
            "requested_reml": bool(reml),
            "inference_fit_reml": bool(
                getattr((phase1a_inference or {}).get("fit", fit).model, "reml", getattr(fit.model, "reml", False))
            ),
            "kr_reml_refit": bool(
                phase1a_inference is not None
                and applied_df_method == "kenward_roger"
                and bool(phase1a_inference.get("reml_refit"))
            ),
            "df_method": effective_df_method,
            "requested_df_method": requested_df_method,
            "applied_df_method": applied_df_method,
            "finite_df_requested": finite_df_requested,
            "finite_df_applied": phase1a_inference is not None,
            "finite_df_available": phase1a_inference is not None,
            "finite_df_boundary_warning": finite_df_boundary_warning,
            "finite_df_fallback_reason": finite_df_fallback_reason,
            "finite_df_mode": finite_df_mode if phase1a_inference is not None else None,
            "omnibus_method": (
                "kenward_roger_f"
                if phase1a_inference is not None and applied_df_method == "kenward_roger"
                else ("satterthwaite_f" if phase1a_inference is not None else "wald_chi2")
            ),
            "contrast_method": contrast_method,
            "omnibus_inference": (
                "Kenward-Roger Type III F-tests"
                if phase1a_inference is not None and applied_df_method == "kenward_roger"
                else (
                    "Satterthwaite Type III F-tests"
                    if phase1a_inference is not None
                    else "Wald Type III chi-square tests"
                )
            ),
            "alpha": format_number(alpha),
            "adjustment_method": get_method_label(adjustment_method),
            "means_type": "lsmean",
            "rows_used": int(len(df)),
            "rows_dropped": int(dropped_rows),
            "subject_count": int(group_sizes.shape[0]),
            "grouping_variable": random_effects_config.get("group_var", "Subject"),
            "predictors": [
                {
                    "name": meta.original_name,
                    "type": meta.predictor_type,
                    "levels": meta.labels if meta.is_categorical else None,
                }
                for meta in predictor_metas
            ],
            "random_effects": {
                "group_var": random_effects_config.get("group_var", "Subject"),
                "random_intercept": True,
                "random_slopes": [meta.original_name for meta in slope_metas],
            },
            "fit_metrics": fit_metrics,
            "fixed_effects": fixed_effects,
            "estimated_means": estimated_means,
            "cell_summaries": cell_summaries,
            "diagnostics": diagnostics,
        }

        diagnostic_warnings = diagnostics.get("warnings")
        if isinstance(diagnostic_warnings, list) and diagnostic_warnings:
            result["warnings"] = list(diagnostic_warnings)

        if pairwise_rows:
            result["pairwise_comparisons"] = pairwise_rows
        if simple_effects:
            result["simple_effects"] = simple_effects
        if continuous_records:
            result["continuous_effects"] = continuous_records
            result["continuous_effects_config"] = continuous_effects_config
        if per_group_means_over_time:
            result["per_group_means_over_time"] = per_group_means_over_time
        if continuous_effects_transform is not None:
            result["continuous_effects_transform"] = continuous_effects_transform
        if adjustment_method == "fdr_bh":
            result["posthoc_q"] = format_number(_normalize_q(posthoc_q, alpha))
        if trajectory_roles is not None and isinstance(trajectory_roles, dict):
            result["trajectory_roles"] = trajectory_roles

        _flatten_fixed_effects(result, fixed_effects)
        _flatten_fit_metrics(result, fit_metrics)
        _flatten_diagnostics(result, diagnostics)
        _flatten_pairwise_records(result, marginal_records, simple_records, continuous_records)
        return result
    except Exception as exc:  # pragma: no cover
        return _error(f"lmm_anova failed: {exc}", trajectory_roles=trajectory_roles)
