"""
using PyDESeq2
Differential expression analysis for RNA-seq data.

VERSION: 1.0.0

Dependencies:
- pydeseq2 (MIT license)
- pandas
- numpy
"""

import itertools
import os
import sys
import warnings as py_warnings
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Any

from .utils import emit_progress


def _get_env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _get_env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


LOWESS_FRAC = 0.45
LOWESS_ITER = 0
LOCFIT_FRAC = _get_env_float("RNASEQ_LOCFIT_FRAC", 0.7)
LOCFIT_DEGREE = _get_env_int("RNASEQ_LOCFIT_DEGREE", 2)
# Lock small-strata default profile to validated setting.
LOCFIT_FRAC_SMALL = _get_env_float("RNASEQ_LOCFIT_FRAC_SMALL", 1.0)
LOCFIT_DEGREE_SMALL = _get_env_int("RNASEQ_LOCFIT_DEGREE_SMALL", LOCFIT_DEGREE)
LOCFIT_SMALL_MAX_SAMPLES = _get_env_int("RNASEQ_LOCFIT_SMALL_MAX_SAMPLES", 6)
USE_GAMMA_GLM_OVERRIDE = os.environ.get(
    "RNASEQ_GAMMA_GLM_OVERRIDE", "1"
).strip().lower() in {"1", "true", "yes", "on"}
RNASEQ_OVERRIDE_MODE = os.environ.get("RNASEQ_ENABLE_PYDESEQ2_OVERRIDES", "auto").strip().lower()
DEBUG_RNASEQ = os.environ.get("RNASEQ_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
CURRENT_LOCFIT_FRAC = LOCFIT_FRAC
CURRENT_LOCFIT_DEGREE = LOCFIT_DEGREE


def _debug_log(message: str) -> None:
    if DEBUG_RNASEQ:
        print(message, file=sys.stderr, flush=True)


def _set_locfit_profile(sample_count: int) -> None:
    global CURRENT_LOCFIT_FRAC
    global CURRENT_LOCFIT_DEGREE

    if sample_count <= LOCFIT_SMALL_MAX_SAMPLES:
        CURRENT_LOCFIT_FRAC = LOCFIT_FRAC_SMALL
        CURRENT_LOCFIT_DEGREE = LOCFIT_DEGREE_SMALL
    else:
        CURRENT_LOCFIT_FRAC = LOCFIT_FRAC
        CURRENT_LOCFIT_DEGREE = LOCFIT_DEGREE

    _debug_log(
        "[DEBUG] run_wald_test: locfit profile "
        f"(n={sample_count}, frac={CURRENT_LOCFIT_FRAC}, degree={CURRENT_LOCFIT_DEGREE})"
    )


def _should_apply_pydeseq2_overrides() -> bool:
    if RNASEQ_OVERRIDE_MODE in {"1", "true", "yes", "on"}:
        return True
    if RNASEQ_OVERRIDE_MODE in {"0", "false", "no", "off"}:
        return False
    # Auto mode: keep overrides in script mode, disable in frozen/compiled mode.
    return not getattr(sys, "frozen", False)


def _apply_gamma_glm_override(default_inference_module: Any) -> None:
    if getattr(default_inference_module, "_easycris_gamma_glm_patched", False):
        return

    original_dispersion_trend_gamma_glm = (
        default_inference_module.DefaultInference.dispersion_trend_gamma_glm
    )

    def _dispersion_trend_gamma_glm_override(self, covariates, targets):
        # Try a statsmodels Gamma(identity) fit first, then fall back to
        # PyDESeq2's original L-BFGS-B implementation.
        try:
            import statsmodels.api as sm

            x = np.asarray(covariates, dtype=float).reshape(-1)
            y = np.asarray(targets, dtype=float).reshape(-1)
            if (
                x.size >= 8
                and y.size >= 8
                and np.all(np.isfinite(x))
                and np.all(np.isfinite(y))
                and np.all(y > 0)
            ):
                X = np.column_stack([np.ones_like(x), x])
                with py_warnings.catch_warnings():
                    py_warnings.simplefilter("ignore")
                    model = sm.GLM(
                        y,
                        X,
                        family=sm.families.Gamma(sm.families.links.identity()),
                    )
                    result = model.fit(maxiter=200, tol=1e-8)

                coeffs = np.asarray(result.params, dtype=float)
                predictions = X @ coeffs
                converged = bool(getattr(result, "converged", True))
                if (
                    converged
                    and np.all(np.isfinite(coeffs))
                    and np.all(coeffs > 1e-10)
                    and np.all(np.isfinite(predictions))
                    and np.all(predictions > 0)
                ):
                    return coeffs, predictions, True
        except Exception as error:
            _debug_log(f"[DEBUG] run_wald_test: gamma GLM override fallback ({error})")

        # Deterministic positive approximation when the optimizer is unstable.
        # This preserves the parametric curve shape (a0 + a1 / mu) and avoids
        # immediate local-fit fallback from non-convergence flags.
        try:
            x = np.asarray(covariates, dtype=float).reshape(-1)
            y = np.asarray(targets, dtype=float).reshape(-1)
            if (
                x.size >= 8
                and y.size >= 8
                and np.all(np.isfinite(x))
                and np.all(np.isfinite(y))
                and np.all(y > 0)
            ):
                X = np.column_stack([np.ones_like(x), x])
                coeffs, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
                coeffs = np.asarray(coeffs, dtype=float)
                coeffs = np.maximum(coeffs, 1e-10)
                predictions = X @ coeffs
                if np.all(np.isfinite(predictions)) and np.all(predictions > 0):
                    return coeffs, predictions, True
        except Exception as error:
            _debug_log(f"[DEBUG] run_wald_test: parametric LS fallback failed ({error})")

        return original_dispersion_trend_gamma_glm(self, covariates, targets)

    default_inference_module.DefaultInference.dispersion_trend_gamma_glm = (
        _dispersion_trend_gamma_glm_override
    )
    default_inference_module._easycris_gamma_glm_patched = True


def _apply_lowess_override(dds_module: Any, utils_module: Any, ds_module: Optional[Any] = None) -> None:
    # Force LOWESS settings to match the validated tuning sweep.
    # Patch both dds.lowess_weighted and ds.lowess (used by independent filtering).
    if getattr(dds_module, "_easycris_lowess_patched", False):
        return

    original_lowess_weighted = utils_module.lowess_weighted

    def _lowess_weighted_override(x, y, weights, *args, **kwargs):
        kwargs["frac"] = LOWESS_FRAC
        kwargs["iter"] = LOWESS_ITER
        return original_lowess_weighted(x, y, weights, *args, **kwargs)

    dds_module.lowess_weighted = _lowess_weighted_override
    dds_module._easycris_lowess_patched = True

    if ds_module is not None and not getattr(ds_module, "_easycris_lowess_patched", False):
        original_ds_lowess = ds_module.lowess

        def _ds_lowess_override(features, targets, *args, **kwargs):
            kwargs["frac"] = LOWESS_FRAC
            kwargs["iter"] = LOWESS_ITER
            return original_ds_lowess(features, targets, *args, **kwargs)

        ds_module.lowess = _ds_lowess_override
        ds_module._easycris_lowess_patched = True


def _apply_locfit_override(dds_module: Any, utils_module: Any) -> None:
    # Override local-dispersion smoothing parameters on the active call path.
    if getattr(dds_module, "_easycris_locfit_patched", False):
        return

    original_dds_locfit_weighted = dds_module.locfit_weighted
    original_utils_locfit_weighted = utils_module.locfit_weighted

    def _dds_locfit_weighted_override(x, y, weights, *args, **kwargs):
        kwargs["frac"] = CURRENT_LOCFIT_FRAC
        kwargs["degree"] = CURRENT_LOCFIT_DEGREE
        return original_dds_locfit_weighted(x, y, weights, *args, **kwargs)

    def _utils_locfit_weighted_override(x, y, weights, *args, **kwargs):
        kwargs["frac"] = CURRENT_LOCFIT_FRAC
        kwargs["degree"] = CURRENT_LOCFIT_DEGREE
        return original_utils_locfit_weighted(x, y, weights, *args, **kwargs)

    dds_module.locfit_weighted = _dds_locfit_weighted_override
    dds_module._easycris_locfit_patched = True
    utils_module.locfit_weighted = _utils_locfit_weighted_override
    utils_module._easycris_locfit_patched = True


def _format_case_mismatch_warning(case_mismatches: List[Tuple[str, str]]) -> str:
    preview = ", ".join([f"{c}->{m}" for c, m in case_mismatches[:5]])
    return (
        "Sample IDs differ only by case between counts and metadata. "
        f"Example mappings: {preview}. Please correct your data. "
        "Continuing will match case-insensitively."
    )


def _match_samples_case_insensitive(
    count_columns: List[str],
    metadata_index: List[str]
) -> Tuple[Dict[str, str], List[str], List[str], List[Tuple[str, str]]]:
    """
    Match sample IDs between counts and metadata, allowing case-insensitive matching.

    Returns:
        Tuple of (mapping dict, unmatched_counts, unmatched_metadata, case_mismatches)
        mapping dict: {count_column_name: metadata_index_name}
    """
    def find_case_collisions(values: List[str], label: str) -> None:
        collisions: Dict[str, List[str]] = {}
        for value in values:
            key = value.lower()
            collisions.setdefault(key, []).append(value)
        conflicts = {k: v for k, v in collisions.items() if len(v) > 1}
        if conflicts:
            examples = []
            for key, values in sorted(conflicts.items())[:5]:
                examples.append(f"{key} -> {', '.join(values)}")
            remaining = len(conflicts) - len(examples)
            suffix = f" (+{remaining} more)" if remaining > 0 else ""
            raise ValueError(
                f"Duplicate {label} IDs that differ only by case. "
                f"Conflicts: {', '.join(examples)}{suffix}. "
                "Please make sample IDs unique (case-insensitive)."
            )

    find_case_collisions(metadata_index, "metadata")
    find_case_collisions(count_columns, "count matrix")

    # Build lowercase lookup for metadata
    meta_lower = {idx.lower(): idx for idx in metadata_index}

    mapping = {}
    unmatched_counts = []
    case_mismatches: List[Tuple[str, str]] = []

    for col in count_columns:
        if col in metadata_index:
            # Exact match
            mapping[col] = col
        elif col.lower() in meta_lower:
            # Case-insensitive match
            mapped = meta_lower[col.lower()]
            mapping[col] = mapped
            case_mismatches.append((col, mapped))
        else:
            unmatched_counts.append(col)

    matched_meta = set(mapping.values())
    unmatched_metadata = [idx for idx in metadata_index if idx not in matched_meta]

    return mapping, unmatched_counts, unmatched_metadata, case_mismatches


def _extract_design_formula_factors(design_formula: str) -> List[str]:
    """
    Extract factor names from design formula.
    """
    import re

    # Remove ~ prefix and whitespace
    formula = design_formula.strip().lstrip('~').strip()

    factors: List[str] = []

    # Capture backtick-quoted names first (allowing special characters)
    quoted = re.findall(r'`([^`]+)`', formula)
    factors.extend(quoted)
    formula = re.sub(r'`[^`]+`', ' ', formula)

    # Split by operators: +, *, :, and whitespace (avoid splitting on '-')
    tokens = re.split(r'[\+\*:\s]+', formula)

    for token in tokens:
        token = token.strip()
        if not token:
            continue
        # Skip pure numeric tokens (allow leading '-')
        if token.lstrip('-').replace('.', '').isdigit():
            continue

        if token.startswith('-') and len(token) > 1:
            token = token[1:].strip()
            if not token:
                continue

        # Handle simple function calls like I(x^2), log(x), scale(x)
        func_match = re.match(r'([A-Za-z_][A-Za-z0-9_\.]*)\((.+)\)$', token)
        if func_match:
            inner = func_match.group(2)
            inner_tokens = re.findall(r'[A-Za-z_][A-Za-z0-9_\.]*', inner)
            factors.extend(inner_tokens)
            continue

        factors.append(token)

    # Deduplicate while preserving order
    seen = set()
    ordered = []
    for factor in factors:
        if factor in seen:
            continue
        seen.add(factor)
        ordered.append(factor)

    return ordered


def _validate_design_formula_factors(
    design_formula: str,
    metadata_columns: List[str]
) -> List[str]:
    """
    Extract factor names from design formula and validate they exist in metadata.

    Returns:
        List of missing factor names (empty if all valid)
    """
    factors = _extract_design_formula_factors(design_formula)

    # Check which factors are missing from metadata
    missing = [f for f in factors if f not in metadata_columns]

    return missing


def _validate_factor_levels(
    metadata: pd.DataFrame,
    factor: str,
    reference: str,
    test: str
) -> Optional[str]:
    """
    Validate that reference and test levels exist in the factor column.

    Returns:
        Error message if validation fails, None if valid
    """
    if factor not in metadata.columns:
        return f"Factor '{factor}' not found in metadata columns: {list(metadata.columns)}"

    # Get unique values as strings
    unique_values = metadata[factor].dropna().astype(str).unique().tolist()

    missing = []
    if reference not in unique_values:
        missing.append(f"reference='{reference}'")
    if test not in unique_values:
        missing.append(f"test='{test}'")

    if missing:
        return (
            f"Factor '{factor}' does not contain {' and '.join(missing)}. "
            f"Available levels: {unique_values}"
        )

    return None


def filter_low_count_genes(
    count_matrix: pd.DataFrame,
    min_count: int = 10,
    min_samples: int = 3
) -> Tuple[pd.DataFrame, int, int]:
    """
    Filter low-count genes from count matrix.

    Args:
        count_matrix: DataFrame with genes as rows, samples as columns
        min_count: Minimum count threshold
        min_samples: Minimum number of samples that must have >= min_count

    Returns:
        Tuple of (filtered_matrix, original_count, filtered_count)
    """
    original_count = len(count_matrix)

    # Keep genes with >= min_count in >= min_samples samples
    genes_to_keep = (count_matrix >= min_count).sum(axis=1) >= min_samples
    filtered_matrix = count_matrix.loc[genes_to_keep]

    filtered_count = len(filtered_matrix)

    return filtered_matrix, original_count, filtered_count


def run_wald_test(
    count_matrix: pd.DataFrame,
    metadata: pd.DataFrame,
    design_formula: str,
    contrast: Optional[Tuple[str, str, str]] = None,
    contrast_vector: Optional[np.ndarray] = None,
    interaction_contrast: Optional[Dict[str, str]] = None,
    apply_shrinkage: bool = False,
    shrinkage_method: str = "apeglm",
    alpha: float = 0.05,
    min_count: int = 10,
    min_samples: int = 3,
    use_padj_for_significance: bool = True,
    allow_warnings: bool = False,
    quiet: bool = True,
    fit_type: Optional[str] = None,
    size_factors_fit_type: Optional[str] = None,
    refit_cooks: Optional[bool] = None,
    min_replicates: Optional[int] = None,
    cooks_filter: Optional[bool] = None,
    independent_filter: Optional[bool] = None
) -> Dict[str, Any]:
    """
    Run PyDESeq2 Wald test for differential expression.

    Args:
        count_matrix: DataFrame with genes (rows) × samples (cols), raw counts
        metadata: DataFrame with samples (rows) × factors (cols)
        design_formula: Formulaic design string (e.g., "~ PC2 + treatment * sex")
        contrast: Tuple of (factor_name, test_level, reference_level)
        contrast_vector: Optional custom contrast vector
        interaction_contrast: Optional 2-way/3-way interaction contrast dict with keys:
            {
              "factor_a": str, "test_a": str, "reference_a": str,
              "factor_b": str, "test_b": str, "reference_b": str,
              "factor_c": str, "test_c": str, "reference_c": str  # optional
            }
        apply_shrinkage: Whether to apply LFC shrinkage
        shrinkage_method: Shrinkage method (apeglm only)
        alpha: Significance threshold
        min_count: Minimum count filter
        min_samples: Minimum samples with min_count
        use_padj_for_significance: Use adjusted p-value for significance
        quiet: Suppress PyDESeq2 console output
        fit_type: Optional dispersion fit type override (e.g., "parametric")
        size_factors_fit_type: Optional size factor fit type override (e.g., "ratio")
        refit_cooks: Optional override for Cooks outlier refit
        min_replicates: Optional override for min replicates to replace outliers
        cooks_filter: Optional override for Cooks filtering in stats
        independent_filter: Optional override for independent filtering in stats

    Returns:
        Dict with results, summary, size_factors, dispersions
    """
    _debug_log("[DEBUG] run_wald_test: ENTERED")

    if apply_shrinkage:
        shrinkage_method = "apeglm"

    warnings: List[str] = []

    emit_progress("filtering", 5, "Filtering low-count genes...")

    # Import PyDESeq2
    _debug_log("[DEBUG] run_wald_test: Importing PyDESeq2...")
    try:
        from pydeseq2.dds import DeseqDataSet
        from pydeseq2.ds import DeseqStats
    except ImportError as e:
        _debug_log(f"[DEBUG] run_wald_test: PyDESeq2 import FAILED: {e}")
        raise RuntimeError(
            f"PyDESeq2 is not installed. Install it with: "
            f"pip install pydeseq2 --target python_embedded/python_dependencies/"
        ) from e

    _debug_log("[DEBUG] run_wald_test: PyDESeq2 import SUCCESS")

    if _should_apply_pydeseq2_overrides():
        try:
            import pydeseq2.ds as pydeseq2_ds
            import pydeseq2.dds as pydeseq2_dds
            import pydeseq2.utils as pydeseq2_utils
            import pydeseq2.default_inference as pydeseq2_default_inference

            _apply_lowess_override(pydeseq2_dds, pydeseq2_utils, pydeseq2_ds)
            _apply_locfit_override(pydeseq2_dds, pydeseq2_utils)
            if USE_GAMMA_GLM_OVERRIDE:
                _apply_gamma_glm_override(pydeseq2_default_inference)
            _debug_log("[DEBUG] run_wald_test: PyDESeq2 overrides applied")
        except Exception as override_error:
            _debug_log(
                f"[DEBUG] run_wald_test: PyDESeq2 overrides skipped due to import/patch error: {override_error}"
            )

    # 1. Filter low-count genes
    filtered_counts, total_genes, tested_genes = filter_low_count_genes(
        count_matrix, min_count=min_count, min_samples=min_samples
    )

    emit_progress("filtering", 10, f"Kept {tested_genes}/{total_genes} genes after filtering")

    # Match samples between counts and metadata (case-insensitive)
    sample_mapping, unmatched_counts, unmatched_metadata, case_mismatches = _match_samples_case_insensitive(
        filtered_counts.columns.tolist(),
        metadata.index.tolist()
    )

    if case_mismatches:
        warnings.append(_format_case_mismatch_warning(case_mismatches))

    # Hard-block: every count sample must exist in metadata.
    # Metadata-only rows are allowed (they are ignored downstream), but
    # counts-only samples can silently invalidate design alignment.
    if unmatched_counts:
        preview = ", ".join(unmatched_counts[:10])
        suffix = "..." if len(unmatched_counts) > 10 else ""
        raise ValueError(
            f"Sample mismatch: {len(unmatched_counts)} sample(s) in counts are missing from metadata "
            f"(examples: {preview}{suffix}). "
            "Add these sample IDs to metadata or remove unmatched count columns."
        )

    if warnings and not allow_warnings:
        return {
            "success": False,
            "requires_confirmation": True,
            "warnings": warnings,
        }

    if len(sample_mapping) < 2:
        raise ValueError(
            f"Insufficient sample overlap: {len(sample_mapping)} matched samples. "
            f"Counts has {len(filtered_counts.columns)}, metadata has {len(metadata)}. "
            f"Unmatched in counts: {unmatched_counts[:5]}{'...' if len(unmatched_counts) > 5 else ''}. "
            f"Unmatched in metadata: {unmatched_metadata[:5]}{'...' if len(unmatched_metadata) > 5 else ''}."
        )

    # Rename count columns to match metadata index (handles case differences)
    if any(k != v for k, v in sample_mapping.items()):
        filtered_counts = filtered_counts.rename(columns=sample_mapping)
        emit_progress("filtering", 10, f"Resolved {sum(1 for k, v in sample_mapping.items() if k != v)} case-mismatched sample IDs")

    common_samples = list(sample_mapping.values())
    filtered_counts = filtered_counts[common_samples]
    metadata = metadata.loc[common_samples]

    emit_progress("normalization", 15, "Creating PyDESeq2 dataset...")

    # 2. Create PyDESeq2 dataset
    # PyDESeq2 expects counts as samples × genes (transposed from standard)
    _debug_log(
        f"[DEBUG] run_wald_test: Creating DeseqDataSet with {filtered_counts.shape[0]} genes, {filtered_counts.shape[1]} samples"
    )
    def run_deseq2_with_fit_type(fit_type_value: Optional[str]) -> "DeseqDataSet":
        _set_locfit_profile(filtered_counts.shape[1])
        dds_kwargs: Dict[str, Any] = {}
        if fit_type_value is not None:
            dds_kwargs["fit_type"] = fit_type_value
        if size_factors_fit_type is not None:
            dds_kwargs["size_factors_fit_type"] = size_factors_fit_type
        if refit_cooks is not None:
            dds_kwargs["refit_cooks"] = refit_cooks
        if min_replicates is not None:
            dds_kwargs["min_replicates"] = min_replicates
        if quiet:
            dds_kwargs["quiet"] = True

        dds = DeseqDataSet(
            counts=filtered_counts.T,
            metadata=metadata,
            design=design_formula,
            **dds_kwargs
        )
        _debug_log("[DEBUG] run_wald_test: DeseqDataSet created")

        emit_progress("normalization", 25, "Estimating size factors...")
        _debug_log("[DEBUG] run_wald_test: Running dds.deseq2()...")
        dds.deseq2()
        _debug_log("[DEBUG] run_wald_test: dds.deseq2() complete")
        return dds

    # Match PyDESeq2 defaults: parametric with fallback to local (then mean if needed).
    if fit_type is None:
        fit_type = "parametric"
    if fit_type not in ("parametric", "local", "mean"):
        raise ValueError(
            f"Unsupported fit_type '{fit_type}'. Use 'parametric', 'local' or 'mean'."
        )
    if size_factors_fit_type is None:
        size_factors_fit_type = "ratio"

    if fit_type == "parametric":
        try:
            _debug_log("[DEBUG] run_wald_test: Trying fit_type=parametric")
            dds = run_deseq2_with_fit_type("parametric")
        except Exception as error:
            _debug_log(f"[DEBUG] run_wald_test: parametric fit failed: {error}")
            warnings.append(
                "Parametric dispersion fit failed; falling back to local fit."
            )
            try:
                _debug_log("[DEBUG] run_wald_test: Trying fit_type=local")
                dds = run_deseq2_with_fit_type("local")
            except Exception as local_error:
                _debug_log(f"[DEBUG] run_wald_test: local fit failed: {local_error}")
                warnings.append(
                    "Local dispersion fit failed; falling back to mean fit."
                )
                _debug_log("[DEBUG] run_wald_test: Trying fit_type=mean")
                dds = run_deseq2_with_fit_type("mean")
    elif fit_type == "local":
        try:
            _debug_log("[DEBUG] run_wald_test: Using fit_type=local")
            dds = run_deseq2_with_fit_type("local")
        except Exception as error:
            _debug_log(f"[DEBUG] run_wald_test: local fit failed: {error}")
            warnings.append(
                "Local dispersion fit failed; falling back to mean fit."
            )
            _debug_log("[DEBUG] run_wald_test: Trying fit_type=mean")
            dds = run_deseq2_with_fit_type("mean")
    else:
        _debug_log("[DEBUG] run_wald_test: Using fit_type=mean")
        dds = run_deseq2_with_fit_type("mean")

    emit_progress("dispersion", 50, "Fitting dispersion model...")
    dispersion_fit_type_used = str(dds.uns.get("disp_function_type", fit_type))

    # 4. Extract results for contrast
    emit_progress("wald_test", 60, "Running Wald test...")

    if interaction_contrast:
        factors = []
        missing = []
        for suffix in ("a", "b", "c"):
            factor = interaction_contrast.get(f"factor_{suffix}")
            if not factor:
                continue
            test_level = interaction_contrast.get(f"test_{suffix}")
            reference_level = interaction_contrast.get(f"reference_{suffix}")
            if not test_level:
                missing.append(f"test_{suffix}")
            if not reference_level:
                missing.append(f"reference_{suffix}")
            if test_level and reference_level:
                factors.append((factor, test_level, reference_level))

        if missing:
            raise ValueError(f"Interaction contrast is missing: {', '.join(missing)}")
        if len(factors) < 2:
            raise ValueError("Interaction contrast requires at least two factors.")

        try:
            contrast_vector = None
            for selection in itertools.product([0, 1], repeat=len(factors)):
                levels = {}
                sign = 1
                for (factor, test_level, reference_level), pick_test in zip(factors, selection):
                    if pick_test:
                        levels[factor] = test_level
                    else:
                        levels[factor] = reference_level
                        sign *= -1
                term = dds.cond(**levels)
                contrast_vector = term * sign if contrast_vector is None else contrast_vector + (term * sign)
        except Exception as e:
            raise ValueError(f"Failed to build interaction contrast: {e}") from e

    if contrast_vector is None and not contrast and not interaction_contrast:
        if _extract_design_formula_factors(design_formula):
            raise ValueError(
                "Contrast is required when the design formula includes factors."
            )
        emit_progress("wald_test", 60, "Skipping Wald test for null model (~1)...")

        results_df = pd.DataFrame(
            columns=[
                "baseMean",
                "log2FoldChange",
                "lfcSE",
                "stat",
                "pvalue",
                "padj",
                "gene_id",
                "significant",
                "direction",
                "sig_category",
            ]
        )

        summary = {
            "total_genes": total_genes,
            "tested_genes": tested_genes,
            "significant_p05": 0,
            "significant_p01": 0,
            "significant_p001": 0,
            "significant_padj05": 0,
            "upregulated": 0,
            "downregulated": 0,
            "significance_method": "padj" if use_padj_for_significance else "pvalue",
            "alpha": alpha,
        }

        emit_progress("wald_test", 85, "Extracting normalization data...")

        try:
            if "size_factors" in dds.obs:
                size_factors = dict(zip(dds.obs.index, dds.obs["size_factors"]))
            else:
                size_factors = dict(zip(dds.obs.index, dds.obsm["size_factors"]))
        except Exception:
            size_factors = {}

        try:
            if "dispersions" in dds.var:
                dispersions = dict(zip(dds.var.index, dds.var["dispersions"]))
            else:
                dispersions = dict(zip(dds.var.index, dds.varm["dispersions"]))
        except Exception:
            dispersions = {}

        emit_progress("wald_test", 90, "Finalizing results...")

        return {
            "success": True,
            "results_df": results_df,
            "dds": dds,
            "summary": summary,
            "size_factors": size_factors,
            "dispersions": dispersions,
            "design_formula": design_formula,
            "contrast": None,
            "filtered_counts": filtered_counts,
            "warnings": warnings,
            "dispersion_fit_type_used": dispersion_fit_type_used,
        }

    stats_kwargs: Dict[str, Any] = {"alpha": alpha}
    if cooks_filter is not None:
        stats_kwargs["cooks_filter"] = cooks_filter
    if independent_filter is not None:
        stats_kwargs["independent_filter"] = independent_filter
    if quiet:
        stats_kwargs["quiet"] = True

    if contrast_vector is not None:
        stat_res = DeseqStats(dds, contrast=np.array(contrast_vector), **stats_kwargs)
    else:
        if not contrast:
            raise ValueError("Contrast is required when no custom contrast is provided.")
        stat_res = DeseqStats(dds, contrast=list(contrast), **stats_kwargs)

    stat_res.summary()

    # 5. Apply shrinkage if requested
    if apply_shrinkage:
        coeff_name = None
        contrast_vec = stat_res.contrast_vector
        if contrast_vec is not None:
            non_zero = np.where(np.abs(contrast_vec) > 1e-8)[0]
            if len(non_zero) == 1:
                coeff_name = stat_res.LFC.columns[non_zero[0]]

        if coeff_name:
            emit_progress("shrinkage", 75, f"Applying {shrinkage_method} shrinkage...")
            try:
                stat_res.lfc_shrink(coeff=coeff_name)
            except Exception as e:
                # Shrinkage can fail for some datasets, continue without it
                emit_progress("shrinkage", 75, f"Shrinkage failed: {e}. Continuing with raw LFC.")
        else:
            emit_progress(
                "shrinkage",
                75,
                "Shrinkage skipped: contrast does not map to a single coefficient.",
            )

    emit_progress("wald_test", 80, "Building results table...")

    # 6. Build results DataFrame
    results_df = stat_res.results_df.copy()
    results_df['gene_id'] = results_df.index

    # Significance determination
    sig_column = 'padj' if use_padj_for_significance else 'pvalue'
    results_df['significant'] = results_df[sig_column] < alpha

    # Direction
    results_df['direction'] = np.where(
        results_df['log2FoldChange'] > 0, 'up',
        np.where(results_df['log2FoldChange'] < 0, 'down', 'ns')
    )

    # 7. Add significance categories (match configured significance column)
    def get_sig_category(pval):
        if pd.isna(pval):
            return 'ns'
        elif pval < 0.001:
            return '***'
        elif pval < 0.01:
            return '**'
        elif pval < 0.05:
            return '*'
        elif pval < 0.1:
            return '.'
        else:
            return 'ns'

    results_df['sig_category'] = results_df[sig_column].apply(get_sig_category)

    # 8. Build summary
    sig_mask = results_df['significant']
    up_mask = sig_mask & (results_df['log2FoldChange'] > 0)
    down_mask = sig_mask & (results_df['log2FoldChange'] < 0)

    summary = {
        'total_genes': total_genes,
        'tested_genes': tested_genes,
        'significant_p05': int((results_df['pvalue'] < 0.05).sum()),
        'significant_p01': int((results_df['pvalue'] < 0.01).sum()),
        'significant_p001': int((results_df['pvalue'] < 0.001).sum()),
        'significant_padj05': int((results_df['padj'] < 0.05).sum()),
        'upregulated': int(up_mask.sum()),
        'downregulated': int(down_mask.sum()),
        'significance_method': 'padj' if use_padj_for_significance else 'pvalue',
        'alpha': alpha
    }

    emit_progress("wald_test", 85, "Extracting normalization data...")

    # Extract size factors and dispersions
    try:
        if "size_factors" in dds.obs:
            size_factors = dict(zip(dds.obs.index, dds.obs["size_factors"]))
        else:
            size_factors = dict(zip(dds.obs.index, dds.obsm["size_factors"]))
    except (KeyError, AttributeError, TypeError, ValueError):
        size_factors = {}

    try:
        if "dispersions" in dds.var:
            dispersions = dict(zip(dds.var.index, dds.var["dispersions"]))
        else:
            dispersions = dict(zip(dds.var.index, dds.varm["dispersions"]))
    except (KeyError, AttributeError, TypeError, ValueError):
        dispersions = {}

    emit_progress("wald_test", 90, "Finalizing results...")

    return {
        'success': True,
        'results_df': results_df,
        'dds': dds,
        'summary': summary,
        'size_factors': size_factors,
        'dispersions': dispersions,
        'design_formula': design_formula,
        'contrast': list(contrast) if contrast else None,
        'filtered_counts': filtered_counts,
        'warnings': warnings,
        'dispersion_fit_type_used': dispersion_fit_type_used,
    }


def run_deseq2_analysis(
    counts: Dict[str, Dict[str, int]],
    metadata: Dict[str, Dict[str, Any]],
    design_formula: str,
    contrast: Optional[List[str]] = None,
    interaction_contrast: Optional[Dict[str, str]] = None,
    factor_reference_levels: Optional[Dict[str, str]] = None,
    subset_filters: Optional[Dict[str, str]] = None,
    covariates: Optional[List[Dict[str, Any]]] = None,
    apply_shrinkage: bool = False,
    shrinkage_method: str = "apeglm",
    alpha: float = 0.05,
    min_count: int = 10,
    min_samples: int = 3,
    use_padj_for_significance: bool = True,
    compute_pca: bool = True,
    compute_vst: bool = True,
    annotate_genes: bool = True,
    organism: str = "mmusculus",
    gene_id_type: str = "ensembl",
    gene_label_source: str = "id_lookup",
    duplicate_policy: str = "sum_duplicates",
    duplicate_count: int = 0,
    pca_top_genes: int = 500,
    pca_gene_selection_mode: str = "significant_only",
    pca_group_by: Optional[str] = None,
    confirm_warnings: bool = False,
    round_counts: bool = False,
    quiet: bool = True,
    fit_type: Optional[str] = None,
    size_factors_fit_type: Optional[str] = None,
    refit_cooks: Optional[bool] = None,
    min_replicates: Optional[int] = None,
    cooks_filter: Optional[bool] = None,
    independent_filter: Optional[bool] = None,
    annotation_refresh: str = "auto",
    annotation_refresh_days: int = 30,
    annotation_allow_online: Optional[bool] = None
) -> Dict[str, Any]:
    """
    Full PyDESeq2 analysis pipeline.

    This is the main entry point called from stats.py.

    Args:
        counts: Dict of {gene_id: {sample_id: count, ...}, ...}
        metadata: Dict of {sample_id: {factor: value, ...}, ...}
        design_formula: Formulaic design string (e.g., "~PC2 + treatment * sex")
        contrast: List of [factor_name, test_level, reference_level]
        interaction_contrast: Optional 2-way or 3-way interaction contrast dict
        factor_reference_levels: Optional mapping of factor -> reference level
        subset_filters: Optional dict of {factor: value} to subset samples
        covariates: Optional list of covariate configs for centering/scaling
        apply_shrinkage: Whether to apply LFC shrinkage
        shrinkage_method: Shrinkage method (apeglm only)
        alpha: Significance threshold
        min_count: Minimum count filter
        min_samples: Minimum samples with min_count
        use_padj_for_significance: Use padj for significance calls
        compute_pca: Whether to compute PCA data
        compute_vst: Whether to compute VST transformation
        annotate_genes: Whether to annotate genes with symbols
        organism: Organism for gene annotation
        gene_id_type: Type of gene ID (ensembl, entrez, uniprot, uniprot_swissprot)
        gene_label_source: Gene label source ('id_lookup' or 'user_provided')
        duplicate_policy: Duplicate handling policy ('sum_duplicates' or 'keep_first')
        duplicate_count: Number of duplicate gene IDs detected before preprocessing
        pca_top_genes: Number of top variable genes for PCA
        pca_gene_selection_mode: PCA gene selection mode
        pca_group_by: Metadata field to group PCA ellipses/legend by
        round_counts: Whether to round non-integer estimated counts before DESeq2
        quiet: Suppress PyDESeq2 console output
        fit_type: Optional dispersion fit type override (e.g., "parametric")
        size_factors_fit_type: Optional size factor fit type override (e.g., "ratio")
        refit_cooks: Optional override for Cooks outlier refit
        min_replicates: Optional override for min replicates to replace outliers
        cooks_filter: Optional override for Cooks filtering in stats
        independent_filter: Optional override for independent filtering in stats

    Returns:
        Complete analysis results dict
    """
    _debug_log("[DEBUG] run_deseq2_analysis: ENTERED")
    emit_progress("filtering", 0, "Starting to fit model...")

    if apply_shrinkage:
        shrinkage_method = "apeglm"

    try:
        pca_top_genes = int(pca_top_genes)
    except (TypeError, ValueError):
        pca_top_genes = 500
    if pca_top_genes < 1:
        pca_top_genes = 500
    pca_gene_selection_mode = str(pca_gene_selection_mode or "significant_only").strip().lower()
    if pca_gene_selection_mode not in {"significant_then_variable", "significant_only", "variable_only"}:
        pca_gene_selection_mode = "significant_only"
    gene_label_source = str(gene_label_source or "id_lookup").strip().lower()
    if gene_label_source not in {"id_lookup", "user_provided"}:
        gene_label_source = "id_lookup"
    duplicate_policy = str(duplicate_policy or "sum_duplicates").strip().lower()
    if duplicate_policy not in {"sum_duplicates", "keep_first"}:
        duplicate_policy = "sum_duplicates"
    try:
        duplicate_count = int(duplicate_count)
    except (TypeError, ValueError):
        duplicate_count = 0
    if duplicate_count < 0:
        duplicate_count = 0

    # Convert to DataFrames when needed
    _debug_log(
        f"[DEBUG] run_deseq2_analysis: Converting to DataFrames (counts={len(counts)}, metadata={len(metadata)})"
    )
    count_df = counts if isinstance(counts, pd.DataFrame) else pd.DataFrame.from_dict(counts, orient='index')
    meta_df = metadata if isinstance(metadata, pd.DataFrame) else pd.DataFrame.from_dict(metadata, orient='index')
    _debug_log(
        f"[DEBUG] run_deseq2_analysis: count_df shape={count_df.shape}, meta_df shape={meta_df.shape}"
    )
    if count_df.shape[1] == 0:
        raise ValueError(
            "No usable count sample columns found after removing structurally empty columns."
        )

    warnings: List[str] = []
    annotation_cache_status = None
    annotation_refresh_mode = (annotation_refresh or "auto").lower()
    if annotation_refresh_mode not in {"auto", "force", "skip"}:
        annotation_refresh_mode = "auto"

    # === VALIDATION: Ensure counts are integers ===
    # PyDESeq2 requires raw integer counts, not normalized values
    non_integer_samples: List[str] = []
    non_integer_cells_detected = 0
    for col in count_df.columns:
        if not pd.api.types.is_integer_dtype(count_df[col]):
            # Check if values are close to integers
            vals = count_df[col].dropna()
            if len(vals) > 0:
                rounded = vals.round()
                non_integer_mask = ~np.isclose(vals, rounded, rtol=0.01)
                non_integer_cells_detected += int(non_integer_mask.sum())
                if bool(non_integer_mask.any()):
                    non_integer_samples.append(col)
                else:
                    # Coerce to int (values are close enough to integers)
                    count_df[col] = rounded.astype(int)

    if non_integer_samples:
        preview = ", ".join(non_integer_samples[:5])
        warnings.append(
            f"{len(non_integer_samples)} samples have non-integer counts "
            f"(examples: {preview}). Counts should be raw, un-normalized integers."
        )
        if not confirm_warnings:
            _, _, _, case_mismatches = _match_samples_case_insensitive(
                count_df.columns.tolist(),
                meta_df.index.tolist()
            )
            if case_mismatches:
                warnings.append(_format_case_mismatch_warning(case_mismatches))
        if not round_counts:
            return {
                "success": False,
                "requires_confirmation": True,
                "confirmation_type": "non_integer_counts",
                "warnings": warnings,
                "non_integer_samples_detected": len(non_integer_samples),
                "non_integer_sample_examples": non_integer_samples[:10],
                "non_integer_cells_detected": int(non_integer_cells_detected),
            }

    # Ensure all counts are numeric, finite and non-negative.
    count_df = count_df.apply(pd.to_numeric, errors='coerce')
    count_df = count_df.replace([np.inf, -np.inf], np.nan).fillna(0)
    if round_counts:
        count_df = count_df.round(0)
    count_df = count_df.clip(lower=0)
    if not round_counts:
        values = count_df.to_numpy(dtype=float)
        if not np.allclose(values, np.round(values), rtol=0.0, atol=1e-8):
            raise ValueError(
                "Non-integer counts remain after preprocessing. "
                "Provide raw integer counts or enable round_counts for estimated counts."
            )
    count_df = count_df.round(0).astype(int)

    # === VALIDATION: Design formula factors ===
    missing_factors = _validate_design_formula_factors(design_formula, meta_df.columns.tolist())
    if missing_factors:
        raise ValueError(
            f"Design formula references factors not found in metadata: {missing_factors}. "
            f"Available columns: {meta_df.columns.tolist()}"
        )
    formula_factors = set(_extract_design_formula_factors(design_formula))
    is_null_model = len(formula_factors) == 0

    if is_null_model:
        contrast = None
        interaction_contrast = None

    # === VALIDATION: Contrast factor levels ===
    if contrast and len(contrast) >= 3:
        factor, test_level, reference_level = contrast[0], contrast[1], contrast[2]
        if factor and factor not in formula_factors:
            raise ValueError(
                f"Contrast factor '{factor}' is not present in design formula {design_formula}."
            )
        if factor in meta_df.columns and pd.api.types.is_numeric_dtype(meta_df[factor]):
            raise ValueError(
                f"Contrast factor '{factor}' appears numeric. "
                "Contrasts require categorical factors. Use covariates for continuous variables."
            )
        level_error = _validate_factor_levels(meta_df, factor, reference_level, test_level)
        if level_error:
            raise ValueError(level_error)

    # === VALIDATION: Interaction contrast levels ===
    if interaction_contrast:
        for suffix in ("a", "b", "c"):
            factor = interaction_contrast.get(f"factor_{suffix}")
            test_level = interaction_contrast.get(f"test_{suffix}")
            reference_level = interaction_contrast.get(f"reference_{suffix}")
            if factor and test_level and reference_level:
                if factor not in formula_factors:
                    raise ValueError(
                        f"Interaction factor '{factor}' is not present in design formula {design_formula}."
                    )
                if factor in meta_df.columns and pd.api.types.is_numeric_dtype(meta_df[factor]):
                    raise ValueError(
                        f"Interaction factor '{factor}' appears numeric. "
                        "Interactions require categorical factors."
                    )
                level_error = _validate_factor_levels(meta_df, factor, reference_level, test_level)
                if level_error:
                    raise ValueError(level_error)

        missing_counts = []
        for suffix in ("a", "b", "c"):
            factor = interaction_contrast.get(f"factor_{suffix}")
            if not factor or factor not in meta_df.columns:
                continue
            series = meta_df[factor]
            missing_mask = series.isna()
            if series.dtype == object or str(series.dtype) == "category":
                missing_mask = missing_mask | series.astype(str).str.strip().isin(["", "nan", "None"])
            missing_count = int(missing_mask.sum())
            if missing_count > 0:
                missing_counts.append((factor, missing_count))
        if missing_counts:
            preview = ", ".join([f"{f}({n})" for f, n in missing_counts[:3]])
            warnings.append(
                "Interaction factors contain missing values "
                f"(examples: {preview}). These samples may be excluded or cause model failures."
            )
            if not confirm_warnings:
                return {
                    "success": False,
                    "requires_confirmation": True,
                    "warnings": warnings,
                }

    # Apply subset filters if provided
    if subset_filters:
        emit_progress("filtering", 2, f"Applying subset filter: {subset_filters}")
        for factor, value in subset_filters.items():
            if factor in meta_df.columns:
                col_values = meta_df[factor]
                # Handle type coercion: UI sends string values but column may be numeric
                # (Issue 9: numeric-coded categories like 0/1 stored as strings)
                if pd.api.types.is_numeric_dtype(col_values):
                    filter_num = pd.to_numeric(pd.Series([value]), errors="coerce").iloc[0]
                    if pd.isna(filter_num):
                        # Fall back to string comparison if conversion fails
                        mask = col_values.astype(str) == str(value)
                    else:
                        mask = col_values == filter_num
                else:
                    # For non-numeric columns, compare as strings
                    mask = col_values.astype(str) == str(value)
                meta_df = meta_df[mask]
                count_df = count_df[[c for c in count_df.columns if c in meta_df.index]]

        if len(meta_df) < 4:
            raise ValueError(
                f"After subsetting, only {len(meta_df)} samples remain. "
                f"Need at least 4 samples for PyDESeq2 analysis."
            )

    if covariates:
        for cov in covariates:
            column = cov.get("column")
            if not column or column not in meta_df.columns:
                continue
            kind = cov.get("kind") or cov.get("type")
            if kind in ("categorical", "factor"):
                meta_df[column] = meta_df[column].apply(
                    lambda v: str(v) if pd.notna(v) else np.nan
                )
                continue

            series = pd.to_numeric(meta_df[column], errors="coerce")
            if cov.get("centerAndScale") or cov.get("center_and_scale"):
                mean = series.mean(skipna=True)
                std = series.std(skipna=True)
                if std and not np.isclose(std, 0):
                    series = (series - mean) / std
            meta_df[column] = series

    if factor_reference_levels:
        for factor, reference in factor_reference_levels.items():
            if factor not in meta_df.columns:
                continue
            series = meta_df[factor]
            string_series = series.apply(lambda v: str(v) if pd.notna(v) else np.nan)
            levels = []
            seen = set()
            for value in string_series.dropna().tolist():
                if value in seen:
                    continue
                seen.add(value)
                levels.append(value)
            if reference in levels:
                levels = [reference] + [level for level in levels if level != reference]
            meta_df[factor] = pd.Categorical(string_series, categories=levels, ordered=True)

    if annotate_genes and gene_label_source != "user_provided":
        from .annotation import get_cache_status
        # Strict offline mode: never perform network annotation refresh.
        status_allow_online = False
        annotation_cache_status = get_cache_status(
            organism,
            gene_id_type=gene_id_type,
            max_age_days=annotation_refresh_days,
            allow_online=status_allow_online
        )
        if annotation_cache_status and not annotation_cache_status.get("cache_exists") and not status_allow_online:
            warnings.append(
                    f"No bundled {gene_id_type} gene annotation cache for {organism}. "
                    "Gene IDs will be used as symbols."
                )
        if annotation_refresh_mode == "auto" and annotation_cache_status.get("stale"):
            if status_allow_online:
                return {
                    "success": False,
                    "requires_confirmation": True,
                    "confirmation_type": "gene_symbol_refresh",
                    "warnings": warnings,
                }
            annotation_refresh_mode = "skip"
            warnings.append(
                "Gene symbol cache is stale. Using bundled cached symbols."
            )

    # Run Wald test
    _debug_log(
        f"[DEBUG] run_deseq2_analysis: Calling run_wald_test() with design={design_formula}, contrast={contrast}"
    )
    wald_result = run_wald_test(
        count_matrix=count_df,
        metadata=meta_df,
        design_formula=design_formula,
        contrast=tuple(contrast) if contrast else None,
        interaction_contrast=interaction_contrast,
        apply_shrinkage=apply_shrinkage,
        shrinkage_method=shrinkage_method,
        alpha=alpha,
        min_count=min_count,
        min_samples=min_samples,
        use_padj_for_significance=use_padj_for_significance,
        allow_warnings=confirm_warnings,
        quiet=quiet,
        fit_type=fit_type,
        size_factors_fit_type=size_factors_fit_type,
        refit_cooks=refit_cooks,
        min_replicates=min_replicates,
        cooks_filter=cooks_filter,
        independent_filter=independent_filter
    )
    _debug_log(
        f"[DEBUG] run_deseq2_analysis: run_wald_test returned, success={wald_result.get('success')}"
    )

    if not wald_result.get("success", True):
        merged = warnings + wald_result.get("warnings", [])
        return {
            "success": False,
            "requires_confirmation": True,
            "warnings": merged,
        }

    merged_warnings = warnings + wald_result.get("warnings", [])
    if merged_warnings:
        merged_warnings = list(dict.fromkeys(merged_warnings))

    # Build gene results list
    results_df = wald_result['results_df']
    genes_list = []

    for row in results_df.itertuples(index=False):
        gene_id = getattr(row, "gene_id", None)
        gene_result = {
            'gene_id': gene_id,
            'gene_symbol': gene_id,  # Will be updated by annotation
            'base_mean': float(row.baseMean) if not pd.isna(row.baseMean) else None,
            'log2_fold_change': float(row.log2FoldChange) if not pd.isna(row.log2FoldChange) else None,
            'lfc_se': float(row.lfcSE) if not pd.isna(row.lfcSE) else None,
            'stat': float(row.stat) if not pd.isna(row.stat) else None,
            'pvalue': float(row.pvalue) if not pd.isna(row.pvalue) else None,
            'padj': float(row.padj) if not pd.isna(row.padj) else None,
            'significant': bool(row.significant),
            'direction': row.direction,
            'sig_category': row.sig_category
        }
        genes_list.append(gene_result)
    wald_result['results_df'] = None
    del results_df

    annotation_source = "local_cache"
    if gene_label_source == "user_provided":
        annotation_source = "user_provided"

    # Annotate genes if requested
    if annotate_genes and gene_label_source != "user_provided":
        emit_progress("annotation", 90, "Annotating genes...")
        try:
            from .annotation import annotate_gene_results

            # Determine annotation behavior based on refresh mode
            allow_online = False
            refresh_all = annotation_refresh_mode == "force"
            refresh_identity_cache = annotation_refresh_mode == "force"

            genes_list = annotate_gene_results(
                genes_list,
                organism=organism,
                gene_id_type=gene_id_type,
                refresh_identity_cache=refresh_identity_cache,
                allow_online=allow_online,
                refresh_all=refresh_all
            )
            mapped_count = sum(
                1 for g in genes_list
                if g.get("gene_symbol") and g.get("gene_symbol") != g.get("gene_id")
            )
            if mapped_count == 0:
                sample_ids = [g.get("gene_id", "") for g in genes_list[:25]]
                if any(str(gid).startswith("ENS") for gid in sample_ids):
                    merged_warnings.append(
                        "Gene symbol annotation returned no symbols from bundled cache."
                    )
            if annotation_refresh_mode == "skip":
                merged_warnings.append(
                    "Using bundled cached gene symbols."
                )
        except Exception as e:
            emit_progress("annotation", 90, f"Annotation failed: {e}. Using original gene IDs.")
            merged_warnings.append(f"Gene annotation failed: {e}")

    # Compute VST if requested (for heatmap and PCA)
    normalized_counts = None
    vst_df = None
    vst_transform = None
    if compute_vst:
        emit_progress("pca", 92, "Computing VST transformation...")
        try:
            from .visualization import compute_vst
            vst_df = compute_vst(
                count_matrix=wald_result['filtered_counts'],
                size_factors=wald_result['size_factors'],
                dds=wald_result['dds'],
                use_design=not is_null_model,
                fit_type=fit_type,
                return_df=True
            )
            normalized_counts = vst_df.values.tolist()
            if isinstance(vst_df, pd.DataFrame):
                transform = vst_df.attrs.get("transform")
                vst_transform = transform
                if transform and transform != "vst":
                    merged_warnings.append(
                        "VST transformation fell back to log2(normalized counts + 1)."
                    )
        except Exception as e:
            emit_progress("pca", 95, f"VST computation failed: {e}")
            merged_warnings.append(
                f"VST computation failed ({e}); heatmap may be unavailable and PCA will use log2-normalized counts."
            )

    # Compute PCA if requested
    pca_data = None
    pca_significance_metric_used = None
    effective_pca_gene_selection_mode = "variable_only" if is_null_model else pca_gene_selection_mode
    if compute_pca:
        emit_progress("pca", 95, "Computing PCA...")
        try:
            from .visualization import compute_pca_for_biplot
            gene_symbols = {g['gene_id']: g['gene_symbol'] for g in genes_list}
            significant_genes_for_pca = None

            # Determine PCA grouping factor
            group_by = None
            if is_null_model:
                # For null model, use explicit pca_group_by from UI or auto-detect
                if pca_group_by and pca_group_by in meta_df.columns:
                    group_by = str(pca_group_by)
                else:
                    # Auto-detect: first categorical column with >=2 levels
                    for col in meta_df.columns:
                        if pd.api.types.is_numeric_dtype(meta_df[col]):
                            continue  # Skip numeric columns
                        n_levels = meta_df[col].nunique()
                        if n_levels >= 2:
                            group_by = col
                            break

                    # Fallback: single dummy group
                    if group_by is None:
                        group_by = '__all_samples__'
                        meta_df['__all_samples__'] = 'All samples'
            else:
                # For DE models, use explicit pca_group_by or extract from model
                if pca_group_by and pca_group_by in meta_df.columns:
                    group_by = str(pca_group_by)
                elif contrast and len(contrast) > 0:
                    group_by = str(contrast[0])
                elif factor_reference_levels:
                    group_by = next(iter(factor_reference_levels.keys()), None)

                if not group_by:
                    group_by = "treatment"

                # Build significance-ranked genes for PCA modes that use significance:
                # - sort by selected significance metric (padj or pvalue)
                # - keep significant genes (<= alpha), preserving sorted order
                if effective_pca_gene_selection_mode in {"significant_then_variable", "significant_only"}:
                    pca_significance_metric_used = "padj" if use_padj_for_significance else "pvalue"
                    sig_pairs = []
                    for gene in genes_list:
                        gene_id = gene.get("gene_id")
                        if not gene_id:
                            continue
                        metric_value = gene.get(pca_significance_metric_used)
                        if metric_value is None:
                            continue
                        try:
                            metric_value = float(metric_value)
                        except (TypeError, ValueError):
                            continue
                        if not np.isfinite(metric_value):
                            continue
                        if metric_value <= alpha:
                            sig_pairs.append((metric_value, str(gene_id)))

                    sig_pairs.sort(key=lambda item: (item[0], item[1]))
                    significant_genes_for_pca = [gene_id for _, gene_id in sig_pairs]

            pca_data = compute_pca_for_biplot(
                count_matrix=wald_result['filtered_counts'],
                metadata=meta_df,
                vst_matrix=vst_df,
                size_factors=wald_result.get('size_factors'),
                significant_genes=significant_genes_for_pca,
                gene_selection_mode=effective_pca_gene_selection_mode,
                gene_symbols=gene_symbols,
                n_top_genes=pca_top_genes,
                group_by=group_by
            )

            # Attach direction/significance to PCA loadings from DE results
            # Build map: gene_id (stripped of version suffix) -> {direction, significant}
            import re
            de_info_map = {}
            for gene in genes_list:
                gene_id_raw = gene.get('gene_id')
                if not gene_id_raw:
                    continue
                gene_id = str(gene_id_raw)
                # Strip Ensembl version suffix (e.g., ENSMUSG00000000001.5 -> ENSMUSG00000000001)
                clean_id = re.sub(r'\.\d+$', '', gene_id)
                log2fc = gene.get('log2_fold_change')
                significant = gene.get('significant', False)

                # Determine direction based on log2FoldChange
                if log2fc is not None and log2fc > 0:
                    direction = 'up'
                elif log2fc is not None and log2fc < 0:
                    direction = 'down'
                else:
                    direction = 'ns'

                de_info_map[clean_id] = {
                    'direction': direction,
                    'significant': significant
                }
                # Also store with original ID in case version suffix is present in loadings
                if gene_id != clean_id:
                    de_info_map[gene_id] = de_info_map[clean_id]

            # Update loadings with direction/significant
            if pca_data and 'loadings' in pca_data:
                for loading in pca_data['loadings']:
                    gene_id_raw = loading.get('geneId')
                    if not gene_id_raw:
                        loading['direction'] = 'ns'
                        loading['significant'] = False
                        continue
                    gene_id = str(gene_id_raw)
                    clean_id = re.sub(r'\.\d+$', '', gene_id)
                    info = de_info_map.get(clean_id) or de_info_map.get(gene_id)
                    if info:
                        loading['direction'] = info['direction']
                        loading['significant'] = info['significant']
                    else:
                        loading['direction'] = 'ns'
                        loading['significant'] = False

        except Exception as e:
            emit_progress("pca", 92, f"PCA computation failed: {e}")

    emit_progress("complete", 100, "Analysis complete")

    # Get Ensembl version from annotation cache status
    ensembl_version = None
    ensembl_version_source = None
    annotation_source_name = None
    annotation_source_version = None
    if annotation_cache_status:
        ensembl_version = annotation_cache_status.get("ensembl_version")
        ensembl_version_source = annotation_cache_status.get("ensembl_version_source")
        annotation_source_name = annotation_cache_status.get("annotation_source_name")
        annotation_source_version = annotation_cache_status.get("annotation_source_version")
    if ensembl_version:
        if annotation_refresh_mode == "skip":
            ensembl_version_source = "cache"
        elif annotation_refresh_mode == "force":
            ensembl_version_source = "online"

    return {
        'success': True,
        'genes': genes_list,
        'summary': wald_result['summary'],
        'size_factors': wald_result['size_factors'],
        'dispersions': wald_result['dispersions'],
        'pca_data': pca_data,
        'normalized_counts': normalized_counts,
        'sample_ids': wald_result['filtered_counts'].columns.tolist(),
        'design_formula': design_formula,
        'contrast': contrast,
        'ensembl_version': ensembl_version,
        'ensembl_version_source': ensembl_version_source,
        'gene_id_type': gene_id_type,
        'gene_label_source': gene_label_source,
        'annotation_source_name': annotation_source_name,
        'annotation_source_version': annotation_source_version,
        'duplicate_policy': duplicate_policy,
        'duplicate_count': duplicate_count,
        'round_counts': bool(round_counts),
        'rounding_method': 'nearest' if round_counts else None,
        'non_integer_samples_detected': len(non_integer_samples),
        'non_integer_cells_detected': int(non_integer_cells_detected),
        'annotation_source': annotation_source,
        'warnings': merged_warnings if merged_warnings else [],
        'parameters': {
            'organism': organism,
            'gene_id_type': gene_id_type,
            'gene_label_source': gene_label_source,
            'duplicate_policy': duplicate_policy,
            'duplicate_count': duplicate_count,
            'round_counts': bool(round_counts),
            'rounding_method': 'nearest' if round_counts else None,
            'non_integer_samples_detected': len(non_integer_samples),
            'non_integer_cells_detected': int(non_integer_cells_detected),
            'alpha': alpha,
            'min_count': min_count,
            'min_samples': min_samples,
            'apply_shrinkage': apply_shrinkage,
            'shrinkage_method': shrinkage_method if apply_shrinkage else None,
            'use_padj_for_significance': use_padj_for_significance,
            'subset_filters': subset_filters,
            'pca_top_genes': pca_top_genes,
            'pca_gene_selection_mode': effective_pca_gene_selection_mode,
            'pca_group_by': pca_group_by,
            'pca_significance_metric_used': pca_significance_metric_used,
            'use_null_model': is_null_model,
            'quiet': quiet,
            'fit_type': fit_type,
            'dispersion_fit_type_used': wald_result.get('dispersion_fit_type_used'),
            'size_factors_fit_type': size_factors_fit_type,
            'refit_cooks': refit_cooks,
            'min_replicates': min_replicates,
            'cooks_filter': cooks_filter,
            'independent_filter': independent_filter,
            'annotation_refresh': annotation_refresh_mode,
            'annotation_refresh_days': annotation_refresh_days,
            'vst_transform': vst_transform
        }
    }
