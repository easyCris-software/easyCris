"""
Moderation Analysis Module (Models 1 & 7)

Implements simple moderation (Model 1) and moderated mediation (Model 7)
using statsmodels with bootstrap confidence intervals.

VERSION: 1.8.0
DATE: December 5, 2025
CHANGELOG:
- v1.8.0: Model 7 bootstrap uses fixed probe values + percentile CIs for baseline consistency
- v1.7.0: CRITICAL FIX - Model 1 simple slopes force centered probes, Model 7 respects centering flag
- v1.6.0: CRITICAL FIX - Simple slopes always use centered moderator values (standard convention)
- v1.5.0: Added p_value field to conditional indirect effects (bootstrap two-tailed p-value)
- v1.4.0: Added centering flags to Model 7 (center_predictor, center_moderator, default True)
- v1.3.0: CRITICAL FIX - Model 7 bootstrap now recalculates probe values per iteration
- v1.2.0: CRITICAL FIX - Model 7 bootstrap now includes W in outcome design matrix (fixes collapsed CIs)
- v1.1.0: CRITICAL FIX - Added moderator W to Model 7 outcome model (was statistically incorrect)
"""

import json
import traceback
import warnings
import numpy as np
import statsmodels.api as sm
from scipy import stats
from statsmodels.tools.sm_exceptions import PerfectSeparationError, PerfectSeparationWarning


def _fit_logistic_model(y, X, maxiter=200):
    """
    Fits a logistic regression safely, returning None on separation/non-convergence.
    """
    try:
        with warnings.catch_warnings():
            warnings.filterwarnings("error", category=PerfectSeparationWarning)
            model = sm.Logit(y, X).fit(disp=0, maxiter=maxiter)
    except (PerfectSeparationError, PerfectSeparationWarning):
        return None
    except Exception:
        return None

    converged = model.mle_retvals.get("converged", False)
    if not converged or not np.all(np.isfinite(model.bse)):
        return None
    return model


def _summarize_encodings(encodings):
    summary = []
    for column, mapping in encodings.items():
        ordered = sorted(mapping.items(), key=lambda kv: kv[1])
        reference = next((label for label, code in ordered if code == 0), ordered[0][0] if ordered else "")
        summary.append({
            "column": column,
            "levels": [{"label": label, "code": int(code)} for label, code in ordered],
            "reference_level": reference
        })
    return summary


def _center_variable(values, name, encodings, min_variance=1e-8):
    """
    Mean-center continuous variables (skip categorical/binary) and capture metadata.
    Returns (possibly centered array, metadata dict).
    """
    values = np.asarray(values, dtype=float)
    metadata = {
        "name": name,
        "was_centered": False,
        "mean": float(np.mean(values)) if values.size else 0.0,
        "std_dev": float(np.std(values, ddof=1)) if values.size > 1 else 0.0,
        "unique_values": int(np.unique(values).size),
        "note": ""
    }

    if name in encodings:
        metadata["note"] = "Categorical variable (dummy coded); centering skipped."
        return values, metadata

    if metadata["unique_values"] <= 2:
        metadata["note"] = "Binary variable; centering skipped."
        return values, metadata

    if metadata["std_dev"] < min_variance or not np.isfinite(metadata["std_dev"]):
        metadata["note"] = "Insufficient variability to center."
        return values, metadata

    centered = values - metadata["mean"]
    metadata["was_centered"] = True
    metadata["note"] = "Mean-centered prior to computing interaction/probes."
    return centered, metadata


def _prepare_probe_values(raw_values, params, center_meta):
    """
    Determine moderator probe values (raw + centered) and labels, returning tuple:
    (raw_values_list, centered_values_list, labels, warnings, info_dict)
    """
    probe_values = params.get('probe_values')
    info = {"source": "custom" if probe_values else "default"}

    raw = list(probe_values) if probe_values else None
    if raw is None:
        mean = float(np.mean(raw_values))
        sd = float(np.std(raw_values, ddof=1))
        raw = [mean - sd, mean, mean + sd]
        info.update({"mean": mean, "sd": sd, "labels": ['-1 SD', 'Mean', '+1 SD']})
    else:
        info["labels"] = [f"W = {val:.2f}" for val in raw]

    warnings_list = []
    w_min = float(np.min(raw_values)) if len(raw_values) else 0.0
    w_max = float(np.max(raw_values)) if len(raw_values) else 0.0
    out_of_range = [v for v in raw if v < w_min or v > w_max]
    if out_of_range:
        warnings_list.append(
            f"Probe value(s) {', '.join(f'{v:.2f}' for v in out_of_range)} fall outside observed W range [{w_min:.2f}, {w_max:.2f}]."
        )

    # Center probe values if the moderator was centered
    # For Model 1: Simple slopes always use centered W values (standard convention)
    # For Model 7: Conditional indirect effects respect the centering flag
    if center_meta.get("was_centered"):
        centered = [val - center_meta["mean"] for val in raw]
    else:
        centered = raw[:]

    info["values_raw"] = [float(val) for val in raw]
    info["values_centered"] = [float(val) for val in centered]

    return raw, centered, info["labels"], warnings_list, info


def _normalize_binary_outcome(values):
    """
    Ensure binary outcomes are encoded as 0/1. Returns (normalized_array, mapping_dict).
    """
    unique = np.unique(values)
    unique = unique[~np.isnan(unique)]
    mapping = {}
    if unique.size != 2:
        return values, mapping

    unique.sort()
    low, high = unique[0], unique[1]
    mapping = {float(low): 0, float(high): 1}
    normalized = np.where(np.isclose(values, high), 1.0, 0.0)
    return normalized, mapping


def _format_number(value, decimals=3):
    """Format float safely."""
    try:
        if value is None or not np.isfinite(value):
            return None
        return round(float(value), decimals)
    except Exception:
        return None


def _interpret_f_squared(value):
    if value is None or not np.isfinite(value):
        return "Not classified"
    if value < 0.02:
        return "Negligible"
    if value < 0.15:
        return "Small"
    if value < 0.35:
        return "Medium"
    return "Large"


def _build_apa_table(title, columns, rows, notes=None):
    """Return APA style table description."""
    return {
        "title": title,
        "columns": columns,
        "rows": rows,
        "notes": notes or []
    }


def _build_covariance_entries(model, names):
    cov = np.asarray(model.cov_params())
    entries = []
    for i, name_i in enumerate(names):
        for j in range(i, len(names)):
            name_j = names[j]
            entries.append({
                "parameter_i": name_i,
                "parameter_j": name_j,
                "covariance": float(cov[i, j])
            })
    return entries


def _compute_bca_interval(boot_samples, original_estimate, jackknife_samples, alpha):
    """
    Compute BCa confidence interval. Returns (lower, upper, method_string).
    Falls back to percentile when jackknife samples unavailable or invalid.
    """
    if boot_samples.size == 0:
        return np.nan, np.nan, "Unavailable"

    eps = 1e-12
    proportion = np.mean(boot_samples < original_estimate)
    proportion = np.clip(proportion, eps, 1 - eps)
    z0 = stats.norm.ppf(proportion)

    if jackknife_samples is None or len(jackknife_samples) == 0:
        accel = 0.0
        method = "Bias-Corrected"
    else:
        jackknife_samples = np.asarray(jackknife_samples)
        jack_mean = np.mean(jackknife_samples)
        numerator = np.sum((jack_mean - jackknife_samples) ** 3)
        denominator = 6.0 * (np.sum((jack_mean - jackknife_samples) ** 2) ** 1.5)
        accel = numerator / denominator if denominator not in (0, np.inf, -np.inf) else 0.0
        method = "BCa"

    z_alpha_low = stats.norm.ppf(alpha / 2)
    z_alpha_high = stats.norm.ppf(1 - alpha / 2)

    def _adjust(z_alpha):
        denom = 1 - accel * (z0 + z_alpha)
        if denom == 0:
            return stats.norm.cdf(z0)
        return stats.norm.cdf(z0 + (z0 + z_alpha) / denom)

    adj_lower = _adjust(z_alpha_low)
    adj_upper = _adjust(z_alpha_high)

    lower = np.percentile(boot_samples, np.clip(adj_lower * 100, 0, 100))
    upper = np.percentile(boot_samples, np.clip(adj_upper * 100, 0, 100))

    return lower, upper, method


def _estimate_model7_paths(Y, X, M, W, covariates, use_logit_outcome, use_logit_mediator):
    """
    Fit mediator and outcome models for Model 7 and return (a1, a3, b).
    """
    n = len(Y)
    XW = X * W

    if covariates is not None:
        design_m = np.column_stack([np.ones(n), X, W, XW, covariates])
        design_y = np.column_stack([np.ones(n), M, X, W, covariates])
    else:
        design_m = np.column_stack([np.ones(n), X, W, XW])
        design_y = np.column_stack([np.ones(n), M, X, W])

    if use_logit_mediator:
        model_m = _fit_logistic_model(M, design_m)
        if model_m is None:
            raise RuntimeError("Mediator logistic model failed")
    else:
        model_m = sm.OLS(M, design_m).fit()
    a1 = model_m.params[1]
    a3 = model_m.params[3]

    if use_logit_outcome:
        model_y = _fit_logistic_model(Y, design_y)
        if model_y is None:
            raise RuntimeError("Logistic model failed")
        b = model_y.params[1]
    else:
        model_y = sm.OLS(Y, design_y).fit()
        b = model_y.params[1]

    return a1, a3, b


def _jackknife_model7_effects(Y, X, M, W, covariates, probe_values, use_logit_outcome, use_logit_mediator):
    """
    Compute jackknife samples for conditional indirect effects, total indirect effect,
    and index of moderated mediation. Returns tuple (cond_dict, total_list, index_list, failures).
    """
    n = len(Y)
    jackknife_cond = {i: [] for i in range(len(probe_values))}
    jackknife_total = []
    jackknife_index = []
    failures = 0

    for leave_out in range(n):
        mask = np.ones(n, dtype=bool)
        mask[leave_out] = False

        Y_j = Y[mask]
        X_j = X[mask]
        M_j = M[mask]
        W_j = W[mask]
        cov_j = covariates[mask] if covariates is not None else None

        try:
            a1_j, a3_j, b_j = _estimate_model7_paths(
                Y_j, X_j, M_j, W_j, cov_j, use_logit_outcome, use_logit_mediator
            )
        except Exception:
            failures += 1
            continue

        for idx, w_val in enumerate(probe_values):
            jackknife_cond[idx].append((a1_j + a3_j * w_val) * b_j)

        jackknife_total.append(a1_j * b_j)
        jackknife_index.append(a3_j * b_j)

    if failures >= max(1, int(0.1 * n)):
        return None, None, None, failures

    return jackknife_cond, jackknife_total, jackknife_index, failures


JACKKNIFE_LIMIT = 250
def _select_robust_type(sample_size, requested):
    valid = {"HC0", "HC1", "HC2", "HC3", "HC4"}
    auto_selected = False

    if not requested:
        requested = "AUTO"

    if requested == "NONE":
        return "NONE", auto_selected

    if requested in valid:
        return requested, auto_selected

    # AUTO selection based on sample size
    auto_selected = True
    if sample_size <= 30:
        return "HC4", auto_selected
    if sample_size <= 250:
        return "HC3", auto_selected
    return "HC2", auto_selected


def simple_moderation(data_json: str) -> str:
    """
    Perform simple moderation analysis (Model 1).

    Tests if the effect of X on Y depends on moderator W.
    Y = b0 + b1X + b2W + b3(XxW) + ε

    Parameters (in JSON):
    - outcome_data: List of Y values
    - predictor_data: List of X values
    - moderator_data: List of W values
    - outcome_name: Name of Y variable
    - predictor_name: Name of X variable
    - moderator_name: Name of W variable
    - control_data: Optional list of covariate arrays
    - control_names: Optional list of covariate names
    - confidence: Confidence level (default 0.95)
    - probe_values: Optional specific W values for probing (default: mean, ±1 SD)
    - johnson_neyman: Whether to compute J-N regions (default True)
    - categorical_encodings: Dict of baseline encodings
    - robust_se: Optional heteroscedasticity-consistent SE type (HC0-HC4)
    - center_predictor: Whether to mean-center X before fitting (default True)
    - center_moderator: Whether to mean-center W before fitting (default True)

    Returns: JSON with moderation results
    """
    try:
        params = json.loads(data_json)
        categorical_encodings = params.get('categorical_encodings', {})

        Y_values = np.array(params['outcome_data'], dtype=float)
        X_raw = np.array(params['predictor_data'], dtype=float)
        W_raw = np.array(params['moderator_data'], dtype=float)
        X = X_raw.copy()
        W = W_raw.copy()

        seed = params.get('seed', None)
        if seed is not None:
            np.random.seed(seed)

        confidence = params.get('confidence', 0.95)
        compute_jn = params.get('johnson_neyman', True)

        requested_robust = params.get('robust_se', 'AUTO')
        if isinstance(requested_robust, str):
            requested_robust = requested_robust.upper()
        else:
            requested_robust = 'AUTO'

        covariates = None
        covariate_names = []
        if 'control_data' in params and params['control_data']:
            covariates = np.column_stack([np.array(c, dtype=float) for c in params['control_data']])
            covariate_names = params.get('control_names', [f'Cov{i+1}' for i in range(len(params['control_data']))])

        mask = ~(np.isnan(Y_values) | np.isnan(X) | np.isnan(W))
        if covariates is not None:
            mask &= ~np.any(np.isnan(covariates), axis=1)

        n_deleted = int(np.sum(~mask))
        Y_values, X, W = Y_values[mask], X[mask], W[mask]
        if covariates is not None:
            covariates = covariates[mask]

        n = len(Y_values)
        if n < 20:
            return json.dumps({
                "success": False,
                "error": f"Insufficient sample size after listwise deletion (N={n}). Minimum required: 20."
            })

        predictor_name = params.get('predictor_name', 'X')
        moderator_name = params.get('moderator_name', 'W')
        outcome_name = params.get('outcome_name', 'Y')

        observed_W = W_raw[mask] if mask.size else W_raw

        continuous_Y = Y_values.copy()
        normalized_Y, binary_mapping = _normalize_binary_outcome(continuous_Y)
        use_logit = len(binary_mapping) == 2
        Y_model = normalized_Y if use_logit else continuous_Y

        logistic_info = {
            "attempted": bool(use_logit),
            "used": bool(use_logit),
            "fallback_to_ols": False,
            "binary_mapping": {str(k): int(v) for k, v in binary_mapping.items()} if binary_mapping else {},
            "positive_label": None,
            "negative_label": None
        }
        if use_logit and outcome_name in categorical_encodings:
            inverse = {code: label for label, code in categorical_encodings[outcome_name].items()}
            logistic_info["negative_label"] = inverse.get(0)
            logistic_info["positive_label"] = inverse.get(1)

        robust_type, auto_selected = _select_robust_type(n, requested_robust)
        use_robust = robust_type in {"HC0", "HC1", "HC2", "HC3", "HC4"}

        robust_metadata = {
            "requested": requested_robust,
            "selected_type": robust_type if use_robust else "CLASSICAL",
            "auto_selected": auto_selected,
            "applied": False,
            "message": ""
        }

        # Centering flags (default True for UI, can be disabled for validation)
        center_predictor = params.get('center_predictor', True)
        center_moderator = params.get('center_moderator', True)

        center_metadata = []
        if center_predictor:
            X, x_center_meta = _center_variable(X, predictor_name, categorical_encodings)
        else:
            x_center_meta = {
                "name": predictor_name,
                "was_centered": False,
                "mean": float(np.mean(X)) if X.size else 0.0,
                "std_dev": float(np.std(X, ddof=1)) if X.size > 1 else 0.0,
                "unique_values": int(np.unique(X).size),
                "note": "Centering disabled by user"
            }

        if center_moderator:
            W, w_center_meta = _center_variable(W, moderator_name, categorical_encodings)
        else:
            w_center_meta = {
                "name": moderator_name,
                "was_centered": False,
                "mean": float(np.mean(W)) if W.size else 0.0,
                "std_dev": float(np.std(W, ddof=1)) if W.size > 1 else 0.0,
                "unique_values": int(np.unique(W).size),
                "note": "Centering disabled by user"
            }

        center_metadata.extend([x_center_meta, w_center_meta])

        warnings_list = []

        XW = X * W
        if covariates is not None:
            design = np.column_stack([np.ones(n), X, W, XW, covariates])
            var_names = ['const', predictor_name, moderator_name, f'{predictor_name}x{moderator_name}'] + covariate_names
        else:
            design = np.column_stack([np.ones(n), X, W, XW])
            var_names = ['const', predictor_name, moderator_name, f'{predictor_name}x{moderator_name}']

        model = None
        model_type = "ols"
        if use_logit:
            fitted_logit = _fit_logistic_model(Y_model, design)
            if fitted_logit is None:
                warnings_list.append(
                    "Binary outcome detected but logistic regression failed to converge; reverting to OLS for the outcome model."
                )
                logistic_info["fallback_to_ols"] = True
                logistic_info["used"] = False
                use_logit = False
                Y_model = continuous_Y
            else:
                model = fitted_logit
                model_type = "logistic"

        if not use_logit:
            model = sm.OLS(Y_model, design).fit()
            model_type = "ols"
        else:
            logistic_info["used"] = True

        if use_robust:
            try:
                model = model.get_robustcov_results(cov_type=robust_type)
                robust_metadata["applied"] = True
            except Exception as exc:
                robust_metadata["message"] = str(exc)
                warnings_list.append(
                    f"Requested robust SE ({robust_type}) could not be applied; falling back to classical SEs."
                )

        b3_idx = 3
        b3 = model.params[b3_idx]
        b3_se = model.bse[b3_idx]
        b3_t = model.tvalues[b3_idx]
        b3_p = model.pvalues[b3_idx]
        b3_ci = np.asarray(model.conf_int(alpha=1-confidence))[b3_idx]
        interaction_stat_label = "z" if use_logit else "t"

        # For simple slopes, ALWAYS use centered probe values (standard convention)
        # Create a modified metadata dict that forces centering for probe value calculation
        w_probe_meta = w_center_meta.copy()
        w_probe_meta["was_centered"] = True

        raw_probe_values, probe_values, probe_labels, probe_warnings, probe_info = _prepare_probe_values(
            observed_W, params, w_probe_meta
        )
        if probe_warnings:
            warnings_list.extend(probe_warnings)
        probe_info["note"] = (
            "Custom moderator probe values supplied."
            if probe_info.get("source") == "custom"
            else "Default probes use mean and +/- 1 SD of the moderator."
        )

        conditional_effects = []
        b1 = model.params[1]
        vcov = np.asarray(model.cov_params())
        df_resid = max(int(model.df_resid), 1)

        for i, w_val in enumerate(probe_values):
            effect = b1 + b3 * w_val
            se = np.sqrt(vcov[1, 1] + w_val**2 * vcov[b3_idx, b3_idx] + 2 * w_val * vcov[1, b3_idx])
            stat_val = effect / se if se > 0 else 0
            if use_logit:
                p_val = 2 * (1 - stats.norm.cdf(abs(stat_val)))
                crit = stats.norm.ppf(1 - (1 - confidence) / 2)
            else:
                p_val = 2 * (1 - stats.t.cdf(abs(stat_val), df_resid))
                crit = stats.t.ppf(1 - (1 - confidence) / 2, df_resid)
            ci_lower = effect - crit * se
            ci_upper = effect + crit * se
            conditional_effects.append({
                'moderator_value': float(raw_probe_values[i]),
                'moderator_value_centered': float(w_val),
                'label': probe_labels[i],
                'effect': float(effect),
                'se': float(se),
                't': float(stat_val),
                'p': float(p_val),
                'p_value': float(p_val),
                'ci_lower': float(ci_lower),
                'ci_upper': float(ci_upper),
                'significant': bool(p_val < (1 - confidence)),
                'statistic_type': "z" if use_logit else "t"
            })

        jn_result = None
        if compute_jn:
            transform = (lambda val: val + w_center_meta["mean"]) if w_center_meta.get("was_centered") else None
            jn_result = _compute_johnson_neyman(
                b1, b3,
                vcov[1, 1], vcov[b3_idx, b3_idx], vcov[1, b3_idx],
                df_resid, confidence,
                W.min(), W.max(),
                reported_w_min=float(np.min(observed_W)) if len(observed_W) else None,
                reported_w_max=float(np.max(observed_W)) if len(observed_W) else None,
                value_transform=transform,
                distribution="normal" if use_logit else "t"
            )

        if covariates is not None:
            design_no_int = np.column_stack([np.ones(n), X, W, covariates])
        else:
            design_no_int = np.column_stack([np.ones(n), X, W])

        model_no_int = None
        r2_change = None
        f_change = None
        f_change_p = None
        f_change_df1 = None
        f_change_df2 = None
        interaction_stat_name = "F"

        if use_logit:
            model_no_int = _fit_logistic_model(Y_model, design_no_int)
            if model_no_int is None:
                warnings_list.append(
                    "Could not compute reduced logistic model for ΔR²/χ² change due to convergence issues."
                )
            else:
                ll_full = model.llf
                ll_reduced = model_no_int.llf
                chi_sq = max(2 * (ll_full - ll_reduced), 0)
                f_change = chi_sq
                if hasattr(model, "df_model") and hasattr(model_no_int, "df_model"):
                    f_change_df1 = int(model.df_model - model_no_int.df_model)
                if not f_change_df1:
                    f_change_df1 = 1
                f_change_p = 1 - stats.chi2.cdf(chi_sq, f_change_df1)
                f_change_df2 = None
                interaction_stat_name = "Chi²"
                if hasattr(model, "prsquared") and hasattr(model_no_int, "prsquared"):
                    r2_change = model.prsquared - model_no_int.prsquared
        else:
            model_no_int = sm.OLS(Y_model, design_no_int).fit()
            r2_change = model.rsquared - model_no_int.rsquared
            if hasattr(model, "df_model") and hasattr(model_no_int, "df_model"):
                f_change_df1 = int(model.df_model - model_no_int.df_model)
            if not f_change_df1:
                f_change_df1 = 1
            f_change_df2 = int(df_resid)
            f_change = (r2_change / f_change_df1) / ((1 - model.rsquared) / df_resid)
            f_change_p = 1 - stats.f.cdf(f_change, f_change_df1, df_resid)

        apa_rows = []

        def extract_coefficients(model_ref, names):
            coeffs = []
            conf_int = np.asarray(model_ref.conf_int(alpha=1-confidence))
            for i, name in enumerate(names):
                coeffs.append({
                    "parameter": name,
                    "estimate": float(model_ref.params[i]),
                    "std_error": float(model_ref.bse[i]),
                    "t_value": float(model_ref.tvalues[i]),
                    "p_value": float(model_ref.pvalues[i]),
                    "ci_lower": float(conf_int[i, 0]),
                    "ci_upper": float(conf_int[i, 1])
                })
                apa_rows.append([
                    name,
                    _format_number(model_ref.params[i]),
                    _format_number(model_ref.bse[i]),
                    _format_number(model_ref.tvalues[i]),
                    _format_number(model_ref.pvalues[i]),
                    _format_number(conf_int[i, 0]),
                    _format_number(conf_int[i, 1])
                ])
            return coeffs

        if n < 100:
            warnings_list.append(f"Sample size (N={n}) may be insufficient to detect small interaction effects. Recommend N >= 100.")

        interaction_payload = {
            "term": f"{predictor_name}x{moderator_name}",
            "coefficient": float(b3),
            "se": float(b3_se),
            "t": float(b3_t),
            "p": float(b3_p),
            "ci_lower": float(b3_ci[0]),
            "ci_upper": float(b3_ci[1]),
            "significant": bool(b3_p < (1 - confidence)),
            "r2_change": float(r2_change) if r2_change is not None else None,
            "f_change": float(f_change) if f_change is not None else None,
            "f_change_p": float(f_change_p) if f_change_p is not None else None,
            "f_change_df1": int(f_change_df1) if f_change_df1 is not None else None,
            "f_change_df2": int(f_change_df2) if f_change_df2 is not None else None,
            "statistic_label": interaction_stat_name,
            "effect_statistic": interaction_stat_label
        }

        total_effect = None
        if model_no_int is not None:
            coef_idx = 1
            total_ci = np.asarray(model_no_int.conf_int(alpha=1-confidence))[coef_idx]
            total_effect = {
                "effect": float(model_no_int.params[coef_idx]),
                "se": float(model_no_int.bse[coef_idx]),
                "statistic": float(model_no_int.tvalues[coef_idx]),
                "statistic_type": "z" if use_logit else "t",
                "p": float(model_no_int.pvalues[coef_idx]),
                "ci_lower": float(total_ci[0]) if total_ci is not None else None,
                "ci_upper": float(total_ci[1]) if total_ci is not None else None
            }

        standardized_coeffs = []
        if not use_logit:
            y_sd = np.std(continuous_Y, ddof=1)
            if y_sd > 1e-8:
                predictor_sds = {
                    predictor_name: np.std(X, ddof=1),
                    moderator_name: np.std(W, ddof=1),
                    f'{predictor_name}x{moderator_name}': np.std(XW, ddof=1)
                }
                if covariates is not None:
                    for idx, cov_name in enumerate(covariate_names):
                        predictor_sds[cov_name] = np.std(covariates[:, idx], ddof=1)
                for name, sd_val in predictor_sds.items():
                    if sd_val is None or sd_val <= 1e-8:
                        continue
                    if name not in var_names:
                        continue
                    beta = model.params[var_names.index(name)] * (sd_val / y_sd)
                    standardized_coeffs.append({"parameter": name, "beta": float(beta)})

        effect_sizes = None
        if not use_logit and r2_change is not None:
            denom = max(1 - model.rsquared, 1e-8)
            f_squared = r2_change / denom
            effect_sizes = {
                "r_squared_full": float(model.rsquared),
                "r_squared_without_interaction": float(model_no_int.rsquared),
                "delta_r_squared": float(r2_change),
                "cohens_f2": float(f_squared),
                "interpretation": _interpret_f_squared(f_squared)
            }

        apa_notes = []
        if robust_metadata["applied"]:
            apa_notes.append(f"Robust SE type: {robust_type}")
        elif use_robust:
            apa_notes.append(f"Requested robust SE ({robust_type}) unavailable; classical SE reported.")
        apa_tables = [
            _build_apa_table(
                "Model 1 Coefficients",
                ["Predictor", "b", "SE", "stat", "p", "CI Lower", "CI Upper"],
                apa_rows,
                apa_notes
            )
        ]

        r_squared_value = getattr(model, "rsquared", getattr(model, "prsquared", np.nan))
        adj_r_squared_value = getattr(model, "rsquared_adj", np.nan) if model_type == "ols" else None
        f_statistic_value = getattr(model, "fvalue", getattr(model, "llr", np.nan))
        f_p_value = getattr(model, "f_pvalue", getattr(model, "llr_pvalue", np.nan))
        mse_value = getattr(model, "mse_resid", np.nan) if model_type == "ols" else None

        covariance_matrix = _build_covariance_entries(model, var_names)

        result = {
            "success": True,
            "test_type": "Moderation Analysis (Model 1)",
            "model_info": {
                "model_number": 1,
                "outcome": outcome_name,
                "predictor": predictor_name,
                "moderator": moderator_name,
                "controls": covariate_names,
                "sample_size": n,
                "seed": seed,
                "confidence_level": confidence,
                "listwise_deleted": n_deleted
            },
            "model_summary": {
                "n": int(n),
                "model_type": model_type,
                "r_squared": float(r_squared_value),
                "adj_r_squared": float(adj_r_squared_value) if adj_r_squared_value is not None else None,
                "f_statistic": float(f_statistic_value),
                "f_p_value": float(f_p_value),
                "mse": float(mse_value) if mse_value is not None else None,
                "df_model": int(model.df_model),
                "df_resid": int(model.df_resid)
            },
            "coefficients": extract_coefficients(model, var_names),
            "interaction": interaction_payload,
            "conditional_effects": conditional_effects,
            "johnson_neyman": jn_result,
            "interpretation": _generate_moderation_interpretation(b3_p, conditional_effects, confidence),
            "warnings": warnings_list,
            "categorical_encodings": categorical_encodings,
            "encoding_summary": _summarize_encodings(categorical_encodings),
            "covariance_matrix": covariance_matrix,
            "apa_tables": apa_tables,
            "preprocessing": {
                "centered_variables": center_metadata,
                "probe_strategy": probe_info,
                "logistic": logistic_info,
                "robust_standard_errors": robust_metadata
            }
        }

        result["interaction_effect"] = {
            "coefficient": interaction_payload["coefficient"],
            "std_error": interaction_payload["se"],
            "t_value": interaction_payload["t"],
            "p_value": interaction_payload["p"],
            "ci_lower": interaction_payload["ci_lower"],
            "ci_upper": interaction_payload["ci_upper"],
            "statistic_type": interaction_stat_label
        }

        if total_effect is not None:
            result["total_effect"] = total_effect

        if standardized_coeffs:
            result["standardized_coefficients"] = standardized_coeffs

        if effect_sizes is not None:
            result["effect_sizes"] = effect_sizes

        return json.dumps(result)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        })

def moderated_mediation_model7(data_json: str) -> str:
    """
    Perform first-stage moderated mediation analysis (Model 7).

    Tests if the indirect effect X->M->Y depends on moderator W (moderates the X->M path).
    """
    try:
        params = json.loads(data_json)
        categorical_encodings = params.get('categorical_encodings', {})

        Y_raw = np.array(params['outcome_data'], dtype=float)
        X_raw = np.array(params['predictor_data'], dtype=float)
        M_raw = np.array(params['mediator_data'], dtype=float)
        W_raw = np.array(params['moderator_data'], dtype=float)

        n_boot = params.get('n_boot', 5000)
        confidence = params.get('confidence', 0.95)
        seed = params.get('seed', None)
        requested_robust = params.get('robust_se', 'AUTO')
        if isinstance(requested_robust, str):
            requested_robust = requested_robust.upper()
        else:
            requested_robust = 'AUTO'

        if seed is not None:
            np.random.seed(seed)

        covariates = None
        covariate_names = []
        if 'control_data' in params and params['control_data']:
            covariates = np.column_stack([np.array(c, dtype=float) for c in params['control_data']])
            covariate_names = params.get('control_names', [f'Cov{i+1}' for i in range(len(params['control_data']))])

        mask = ~(np.isnan(Y_raw) | np.isnan(X_raw) | np.isnan(M_raw) | np.isnan(W_raw))
        if covariates is not None:
            mask &= ~np.any(np.isnan(covariates), axis=1)

        n_deleted = int(np.sum(~mask))
        Y = Y_raw[mask]
        X = X_raw[mask]
        M = M_raw[mask]
        W = W_raw[mask]
        observed_W = W.copy()
        covariates = covariates[mask] if covariates is not None else None

        n = len(Y)
        if n < 20:
            return json.dumps({
                "success": False,
                "error": f"Insufficient sample size after listwise deletion (N={n}). Minimum required: 20."
            })

        robust_type, auto_selected = _select_robust_type(n, requested_robust)
        use_robust = robust_type in {"HC0", "HC1", "HC2", "HC3", "HC4"}

        predictor_name = params.get('predictor_name', 'X')
        mediator_name = params.get('mediator_name', 'M')
        moderator_name = params.get('moderator_name', 'W')
        outcome_name = params.get('outcome_name', 'Y')

        x_std_original = float(np.std(X, ddof=1)) if n > 1 else 0.0
        y_std_original = float(np.std(Y, ddof=1)) if n > 1 else 0.0

        continuous_Y = Y.copy()
        normalized_Y, binary_mapping = _normalize_binary_outcome(Y)
        use_logit = len(binary_mapping) == 2
        Y_model = normalized_Y if use_logit else continuous_Y

        logistic_info = {
            "attempted": bool(use_logit),
            "used": bool(use_logit),
            "fallback_to_ols": False,
            "binary_mapping": {str(k): int(v) for k, v in binary_mapping.items()} if binary_mapping else {},
            "positive_label": None,
            "negative_label": None
        }
        if use_logit and outcome_name in categorical_encodings:
            inverse = {code: label for label, code in categorical_encodings[outcome_name].items()}
            logistic_info["negative_label"] = inverse.get(0)
            logistic_info["positive_label"] = inverse.get(1)

        M_model = M.copy()
        mediator_mapping = {}
        mediator_logit_requested = False
        mediator_logit_used = False
        mediator_logit_fallback = False
        normalized_M, mediator_mapping = _normalize_binary_outcome(M)
        if len(mediator_mapping) == 2:
            mediator_logit_requested = True
            M_model = normalized_M
            M = M_model

        mediator_logistic_info = {
            "attempted": bool(mediator_logit_requested),
            "used": bool(mediator_logit_used),
            "fallback_to_ols": bool(mediator_logit_fallback),
            "binary_mapping": {str(k): int(v) for k, v in mediator_mapping.items()} if mediator_mapping else {}
        }

        robust_metadata = {
            "requested": requested_robust,
            "selected_type": robust_type if use_robust else "CLASSICAL",
            "auto_selected": auto_selected,
            "mediator_applied": False,
            "outcome_applied": False,
            "message": ""
        }

        # Centering flags (default True for UI, can be disabled for validation)
        center_predictor = params.get('center_predictor', True)
        center_moderator = params.get('center_moderator', True)

        center_metadata = []
        if center_predictor:
            X, x_meta = _center_variable(X, predictor_name, categorical_encodings)
        else:
            x_meta = {
                "name": predictor_name,
                "was_centered": False,
                "mean": float(np.mean(X)) if X.size else 0.0,
                "std_dev": float(np.std(X, ddof=1)) if X.size > 1 else 0.0,
                "unique_values": int(np.unique(X).size),
                "note": "Centering disabled by user"
            }

        if center_moderator:
            W, w_meta = _center_variable(W, moderator_name, categorical_encodings)
        else:
            w_meta = {
                "name": moderator_name,
                "was_centered": False,
                "mean": float(np.mean(W)) if W.size else 0.0,
                "std_dev": float(np.std(W, ddof=1)) if W.size > 1 else 0.0,
                "unique_values": int(np.unique(W).size),
                "note": "Centering disabled by user"
            }

        center_metadata.extend([x_meta, w_meta])

        raw_probe_values, probe_values, probe_labels, probe_warnings, probe_info = _prepare_probe_values(
            observed_W, params, w_meta
        )
        probe_info["note"] = (
            "Custom moderator probe values supplied."
            if probe_info.get("source") == "custom"
            else "Default probes use mean and +/- 1 SD of the moderator."
        )

        warnings_list = []
        if n < 100:
            warnings_list.append(f"Sample size (N={n}) may yield unstable bootstrap estimates. Recommend N >= 100.")
        if probe_warnings:
            warnings_list.extend(probe_warnings)

        XW = X * W

        if covariates is not None:
            X_m = np.column_stack([np.ones(n), X, W, XW, covariates])
            var_names_m = ['const', predictor_name, moderator_name, f'{predictor_name}x{moderator_name}'] + covariate_names
            X_y = np.column_stack([np.ones(n), M, X, W, covariates])
            var_names_y = ['const', mediator_name, predictor_name, moderator_name] + covariate_names
        else:
            X_m = np.column_stack([np.ones(n), X, W, XW])
            var_names_m = ['const', predictor_name, moderator_name, f'{predictor_name}x{moderator_name}']
            X_y = np.column_stack([np.ones(n), M, X, W])
            var_names_y = ['const', mediator_name, predictor_name, moderator_name]

        if mediator_logit_requested:
            model_m = _fit_logistic_model(M, X_m)
            if model_m is None:
                mediator_logit_fallback = True
                model_m = sm.OLS(M, X_m).fit()
            else:
                mediator_logit_used = True
        else:
            model_m = sm.OLS(M, X_m).fit()
        if use_robust:
            try:
                model_m = model_m.get_robustcov_results(cov_type=robust_type)
                robust_metadata["mediator_applied"] = True
            except Exception as exc:
                robust_metadata["message"] = str(exc)
                warnings_list.append(
                    f"Requested robust SE ({robust_type}) could not be applied to mediator model; classical SEs used."
                )
        if mediator_logit_fallback:
            warnings_list.append(
                "Binary mediator detected but logistic regression failed to converge; "
                "results shown using a linear probability model for the mediator path."
            )
        elif mediator_logit_used:
            warnings_list.append(
                "Binary mediator modeled with logistic regression; path a is on the log-odds scale."
            )
        mediator_logistic_info["used"] = bool(mediator_logit_used)
        mediator_logistic_info["fallback_to_ols"] = bool(mediator_logit_fallback)
        a1 = model_m.params[1]
        a3 = model_m.params[3]

        if use_logit:
            model_y = _fit_logistic_model(Y_model, X_y)
            if model_y is None:
                logistic_info["fallback_to_ols"] = True
                logistic_info["used"] = False
                warnings_list.append(
                    "Binary outcome detected but logistic regression failed to converge; reverting to OLS for the outcome model."
                )
                use_logit = False
                Y_model = continuous_Y
                model_y = sm.OLS(Y_model, X_y).fit()
        else:
            model_y = sm.OLS(Y_model, X_y).fit()

        logistic_info["used"] = bool(use_logit)
        if use_robust:
            try:
                model_y = model_y.get_robustcov_results(cov_type=robust_type)
                robust_metadata["outcome_applied"] = True
            except Exception as exc:
                robust_metadata["message"] = str(exc)
                warnings_list.append(
                    f"Requested robust SE ({robust_type}) could not be applied to outcome model; classical SEs used."
                )

        b = model_y.params[1]
        c_prime = model_y.params[2]

        direct_se = model_y.bse[2]
        direct_stat = model_y.tvalues[2]
        direct_p = model_y.pvalues[2]
        direct_ci = np.asarray(model_y.conf_int(alpha=1-confidence))[2]
        direct_stat_label = "z" if use_logit else "t"

        # NOTE: Keep probe values fixed for baseline consistency
        # across bootstrap samples and use percentile CIs (no BCa/jackknife).
        boot_indirect = {i: [] for i in range(len(probe_values))}
        boot_total = []
        boot_index = []
        discarded = 0
        mediator_logit_boot_fallbacks = 0
        outcome_logit_boot_fallbacks = 0

        for _ in range(n_boot):
            idx = np.random.choice(n, n, replace=True)
            Y_b = Y_model[idx]
            X_b = X[idx]
            M_b = M[idx]
            W_b = W[idx]
            XW_b = X_b * W_b
            cov_b = covariates[idx] if covariates is not None else None

            try:
                if cov_b is not None:
                    X_m_b = np.column_stack([np.ones(n), X_b, W_b, XW_b, cov_b])
                    X_y_b = np.column_stack([np.ones(n), M_b, X_b, W_b, cov_b])
                else:
                    X_m_b = np.column_stack([np.ones(n), X_b, W_b, XW_b])
                    X_y_b = np.column_stack([np.ones(n), M_b, X_b, W_b])

                if mediator_logit_used:
                    model_m_b = _fit_logistic_model(M_b, X_m_b)
                    if model_m_b is None:
                        mediator_logit_boot_fallbacks += 1
                        model_m_b = sm.OLS(M_b, X_m_b).fit()
                    a1_b = model_m_b.params[1]
                    a3_b = model_m_b.params[3]
                else:
                    model_m_b = sm.OLS(M_b, X_m_b).fit()
                    a1_b = model_m_b.params[1]
                    a3_b = model_m_b.params[3]

                if use_logit:
                    model_y_b = _fit_logistic_model(Y_b, X_y_b)
                    if model_y_b is None:
                        outcome_logit_boot_fallbacks += 1
                        b_b = sm.OLS(Y_b, X_y_b).fit().params[1]
                    else:
                        b_b = model_y_b.params[1]
                else:
                    b_b = sm.OLS(Y_b, X_y_b).fit().params[1]

                # Use fixed probe values derived from the original data
                for i, w_val in enumerate(probe_values):
                    boot_indirect[i].append((a1_b + a3_b * w_val) * b_b)

                boot_total.append(a1_b * b_b)
                # Index of moderated mediation = indirect_high - indirect_low
                if len(probe_values) >= 2:
                    boot_index.append(
                        (a1_b + a3_b * probe_values[-1]) * b_b
                        - (a1_b + a3_b * probe_values[0]) * b_b
                    )

            except Exception:
                discarded += 1
                continue

        if len(boot_index) == 0:
            return json.dumps({
                "success": False,
                "error": "Bootstrap failed: all resamples encountered convergence issues."
            })

        if mediator_logit_boot_fallbacks > 0:
            warnings_list.append(
                f"Bootstrap fallback: mediator logistic model failed in {mediator_logit_boot_fallbacks} resample(s); OLS used for those iterations."
            )
        if outcome_logit_boot_fallbacks > 0:
            warnings_list.append(
                f"Bootstrap fallback: outcome logistic model failed in {outcome_logit_boot_fallbacks} resample(s); OLS used for those iterations."
            )

        alpha = 1 - confidence
        boot_index = np.array(boot_index)
        boot_total = np.array(boot_total)
        boot_arrays = [np.array(boot_indirect[i]) for i in range(len(probe_values))]

        # Baseline uses percentile CIs without BCa/jackknife for model 7.
        jackknife_cond = None

        conditional_indirect_effects = []
        can_standardize = (not use_logit) and x_std_original > 1e-8 and y_std_original > 1e-8
        apa_tables = []

        for i, w_val in enumerate(probe_values):
            boot_vals = boot_arrays[i]
            effect = (a1 + a3 * w_val) * b
            boot_se = float(np.std(boot_vals, ddof=1)) if boot_vals.size > 1 else float('nan')
            perc_lower = np.percentile(boot_vals, 100 * alpha / 2)
            perc_upper = np.percentile(boot_vals, 100 * (1 - alpha / 2))
            ci_method = "Percentile"

            # Bootstrap p-value: two-tailed sign test (baseline convention)
            if effect == 0:
                p_bootstrap = 1.0
            else:
                pos = np.sum(boot_vals > 0)
                neg = np.sum(boot_vals < 0)
                p_bootstrap = 2 * min(pos, neg) / boot_vals.size
            p_bootstrap = float(min(p_bootstrap, 1.0))  # Clamp to [0, 1]

            conditional_indirect_effects.append({
                'moderator_value': float(raw_probe_values[i]),
                'moderator_value_centered': float(w_val),
                'label': probe_labels[i],
                'effect': float(effect),
                'boot_se': float(boot_se),
                'boot_ci_lower': float(perc_lower),
                'boot_ci_upper': float(perc_upper),
                'percentile_ci_lower': float(perc_lower),
                'percentile_ci_upper': float(perc_upper),
                'ci_method': ci_method,
                'p_value': p_bootstrap,
                'significant': bool(not (perc_lower <= 0 <= perc_upper)),
                'completely_standardized_effect': float(effect * (x_std_original / y_std_original)) if can_standardize else None
            })

        total_effect_value = a1 * b
        total_bca_lower, total_bca_upper = (
            float(np.percentile(boot_total, 100 * alpha / 2)),
            float(np.percentile(boot_total, 100 * (1 - alpha / 2))),
        )
        total_ci_method = "Percentile"
        total_indirect_effect = {
            'effect': float(total_effect_value),
            'boot_se': float(np.std(boot_total, ddof=1)) if boot_total.size > 1 else float('nan'),
            'boot_ci_lower': float(total_bca_lower),
            'boot_ci_upper': float(total_bca_upper),
            'ci_method': total_ci_method,
            'percentile_ci_lower': float(np.percentile(boot_total, 100 * alpha / 2)),
            'percentile_ci_upper': float(np.percentile(boot_total, 100 * (1 - alpha / 2))),
            'significant': bool(not (total_bca_lower <= 0 <= total_bca_upper)),
            'direction': 'positive' if total_effect_value > 0 else 'negative',
            'interpretation': 'Stronger mediation at high X' if total_effect_value > 0 else 'Inverse mediation pattern'
        }
        if can_standardize:
            total_indirect_effect['completely_standardized_effect'] = float(total_effect_value * (x_std_original / y_std_original))

        pairwise_contrasts = []
        for i in range(len(probe_values)):
            for j in range(i + 1, len(probe_values)):
                diff = conditional_indirect_effects[i]['effect'] - conditional_indirect_effects[j]['effect']
                boot_diff = boot_arrays[i] - boot_arrays[j]
                diff_lower, diff_upper = (
                    float(np.percentile(boot_diff, 100 * alpha / 2)),
                    float(np.percentile(boot_diff, 100 * (1 - alpha / 2))),
                )
                diff_method = "Percentile"
                pairwise_contrasts.append({
                    'comparison': f"{probe_labels[i]} minus {probe_labels[j]}",
                    'w_values': [float(raw_probe_values[i]), float(raw_probe_values[j])],
                    'effect': float(diff),
                    'boot_se': float(np.std(boot_diff, ddof=1)) if boot_diff.size > 1 else float('nan'),
                    'boot_ci_lower': float(diff_lower),
                    'boot_ci_upper': float(diff_upper),
                    'ci_method': diff_method,
                    'significant': bool(not (diff_lower <= 0 <= diff_upper))
                })

        # Index of moderated mediation: indirect_high - indirect_low
        if len(probe_values) >= 2:
            index_mm = float((a1 + a3 * probe_values[-1]) * b - (a1 + a3 * probe_values[0]) * b)
        else:
            index_mm = float(a3 * b)
        index_ci_lower = float(np.percentile(boot_index, 100 * alpha / 2))
        index_ci_upper = float(np.percentile(boot_index, 100 * (1 - alpha / 2)))
        index_method = "Percentile"
        index_significant = not (index_ci_lower <= 0 <= index_ci_upper)

        def extract_coefficients(model, names, apa_title=None):
            coeffs = []
            conf_int = np.asarray(model.conf_int(alpha=1-confidence))
            apa_rows = []
            for i, name in enumerate(names):
                coeffs.append({
                    "parameter": name,
                    "estimate": float(model.params[i]),
                    "std_error": float(model.bse[i]),
                    "t_value": float(model.tvalues[i]),
                    "p_value": float(model.pvalues[i]),
                    "ci_lower": float(conf_int[i, 0]),
                    "ci_upper": float(conf_int[i, 1])
                })
                if apa_title is not None:
                    apa_rows.append([
                        name,
                        _format_number(model.params[i]),
                        _format_number(model.bse[i]),
                        _format_number(model.tvalues[i]),
                        _format_number(model.pvalues[i]),
                        _format_number(conf_int[i, 0]),
                        _format_number(conf_int[i, 1])
                    ])
            if apa_title is not None:
                notes = []
                if use_robust:
                    notes.append(f"Robust SE type: {robust_type}" if (apa_title.lower().startswith("mediator") and robust_metadata["mediator_applied"]) or (apa_title.lower().startswith("outcome") and robust_metadata["outcome_applied"]) else "")
                    notes = [n for n in notes if n]
                apa_tables.append(_build_apa_table(
                    apa_title,
                    ["Predictor", "b", "SE", "stat", "p", "CI Lower", "CI Upper"],
                    apa_rows,
                    notes
                ))
            return coeffs

        def safe_float(value):
            try:
                if value is None or (isinstance(value, float) and (np.isnan(value) or np.isinf(value))):
                    return None
                return float(value)
            except Exception:
                return None

        if use_logit:
            y_r2 = safe_float(getattr(model_y, "prsquared", None))
            y_adj_r2 = None
            y_f = safe_float(getattr(model_y, "llr", None))
            y_fp = safe_float(getattr(model_y, "llr_pvalue", None))
            y_mse = None
        else:
            y_r2 = safe_float(model_y.rsquared)
            y_adj_r2 = safe_float(model_y.rsquared_adj)
            y_f = safe_float(model_y.fvalue)
            y_fp = safe_float(model_y.f_pvalue)
            y_mse = safe_float(model_y.mse_resid)

        mediator_model_type = "logistic" if mediator_logit_used else "ols"
        m_r2 = safe_float(getattr(model_m, "prsquared", model_m.rsquared)) if mediator_logit_used else safe_float(model_m.rsquared)
        m_adj_r2 = safe_float(model_m.rsquared_adj) if hasattr(model_m, "rsquared_adj") else None
        m_f = safe_float(model_m.fvalue) if hasattr(model_m, "fvalue") else None
        m_fp = safe_float(model_m.f_pvalue) if hasattr(model_m, "f_pvalue") else None
        m_mse = safe_float(model_m.mse_resid) if hasattr(model_m, "mse_resid") else None

        result = {
            "success": True,
            "test_type": "Moderated Mediation Analysis (Model 7)",
            "model_info": {
                "model_number": 7,
                "outcome": outcome_name,
                "predictor": predictor_name,
                "mediator": mediator_name,
                "moderator": moderator_name,
                "moderation_path": "X -> M (first stage)",
                "controls": covariate_names,
                "sample_size": n,
                "n_bootstrap": n_boot,
                "confidence_level": confidence,
                "seed": seed,
                "listwise_deleted": n_deleted,
                "boot_samples_discarded": discarded,
                "mediator_link": "logit" if mediator_logit_used else "identity",
                "outcome_link": "logit" if use_logit else "identity"
            },
            "outcome_models": {
                mediator_name: {
                    "description": f"M = a0 + a1X + a2W + a3(XxW)",
                    "model_type": mediator_model_type,
                    "r_squared": m_r2,
                    "adj_r_squared": m_adj_r2,
                    "f_statistic": m_f,
                    "f_p_value": m_fp,
                    "mse": m_mse,
                    "df1": int(model_m.df_model),
                    "df2": int(model_m.df_resid),
                    "coefficients": extract_coefficients(model_m, var_names_m, apa_title="Mediator model coefficients"),
                    "covariance_matrix": _build_covariance_entries(model_m, var_names_m)
                },
                outcome_name: {
                    "description": "Y = b0 + b1M + c'X",
                    "model_type": "logistic" if use_logit else "ols",
                    "r_squared": y_r2,
                    "adj_r_squared": y_adj_r2,
                    "f_statistic": y_f,
                    "f_p_value": y_fp,
                    "mse": y_mse,
                    "df1": int(model_y.df_model),
                    "df2": int(model_y.df_resid),
                    "coefficients": extract_coefficients(model_y, var_names_y, apa_title="Outcome model coefficients"),
                    "covariance_matrix": _build_covariance_entries(model_y, var_names_y)
                }
            },
            "direct_effect": {
                "effect": float(c_prime),
                "se": float(direct_se),
                "statistic": float(direct_stat),
                "statistic_type": direct_stat_label,
                "p": float(direct_p),
                "ci_lower": float(direct_ci[0]),
                "ci_upper": float(direct_ci[1]),
                "significant": bool(direct_p < (1 - confidence))
            },
            "conditional_indirect_effects": conditional_indirect_effects,
            "total_indirect_effect": total_indirect_effect,
            "pairwise_contrasts": pairwise_contrasts,
            "index_of_moderated_mediation": {
                "index": float(index_mm),
                "boot_se": float(np.std(boot_index, ddof=1)) if boot_index.size > 1 else float('nan'),
                "boot_ci_lower": float(index_ci_lower),
                "boot_ci_upper": float(index_ci_upper),
                "ci_method": index_method,
                "significant": bool(index_significant),
                "interpretation": "Significant index indicates the indirect effect varies by W"
            },
            "interpretation": _generate_mod_med_interpretation(
                index_significant, conditional_indirect_effects, direct_p, confidence
            ),
            "warnings": warnings_list,
            "categorical_encodings": categorical_encodings,
            "encoding_summary": _summarize_encodings(categorical_encodings),
            "apa_tables": apa_tables,
            "preprocessing": {
                "centered_variables": center_metadata,
                "probe_strategy": probe_info,
                "logistic": logistic_info,
                "robust_standard_errors": robust_metadata
            }
        }

        return json.dumps(result)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        })
def _compute_johnson_neyman(
    b1,
    b3,
    var_b1,
    var_b3,
    cov_b1_b3,
    df,
    confidence,
    w_min,
    w_max,
    reported_w_min=None,
    reported_w_max=None,
    value_transform=None,
    distribution="t"
):
    """
    Compute Johnson-Neyman significance regions.

    Finds values of W where the conditional effect of X on Y
    transitions from significant to non-significant.
    """
    if distribution == "normal":
        crit_value = stats.norm.ppf(1 - (1 - confidence) / 2)
    else:
        crit_value = stats.t.ppf(1 - (1 - confidence) / 2, df)

    a = b3**2 - crit_value**2 * var_b3
    b = 2 * b1 * b3 - 2 * crit_value**2 * cov_b1_b3
    c = b1**2 - crit_value**2 * var_b1

    discriminant = b**2 - 4 * a * c

    if discriminant < 0 or abs(a) < 1e-10:
        w_mid = (w_min + w_max) / 2
        effect_mid = b1 + b3 * w_mid
        se_mid = np.sqrt(var_b1 + w_mid**2 * var_b3 + 2 * w_mid * cov_b1_b3)
        is_sig = abs(effect_mid / se_mid) > crit_value if se_mid > 0 else False

        return {
            "regions": [],
            "message": f"Effect of X on Y is {'significant' if is_sig else 'non-significant'} across all observed values of W ({(reported_w_min if reported_w_min is not None else w_min):.2f} to {(reported_w_max if reported_w_max is not None else w_max):.2f})."
        }

    w1 = (-b - np.sqrt(discriminant)) / (2 * a)
    w2 = (-b + np.sqrt(discriminant)) / (2 * a)

    w_lower = min(w1, w2)
    w_upper = max(w1, w2)

    effect_at_min = b1 + b3 * w_min
    se_at_min = np.sqrt(var_b1 + w_min**2 * var_b3 + 2 * w_min * cov_b1_b3)
    sig_at_min = abs(effect_at_min / se_at_min) > crit_value if se_at_min > 0 else False

    effect_at_max = b1 + b3 * w_max
    se_at_max = np.sqrt(var_b1 + w_max**2 * var_b3 + 2 * w_max * cov_b1_b3)
    sig_at_max = abs(effect_at_max / se_at_max) > crit_value if se_at_max > 0 else False

    regions = []

    def transform_value(val):
        return value_transform(val) if value_transform else val

    def clamp_to_reported(val):
        if reported_w_min is not None and val < reported_w_min:
            return reported_w_min
        if reported_w_max is not None and val > reported_w_max:
            return reported_w_max
        return val

    lower_in_range = w_min <= w_lower <= w_max
    upper_in_range = w_min <= w_upper <= w_max

    if lower_in_range:
        val = clamp_to_reported(w_lower)
        regions.append({
            "boundary": float(transform_value(val)),
            "description": "Effect transitions between significance states"
        })
    if upper_in_range and not np.isclose(w_lower, w_upper):
        val = clamp_to_reported(w_upper)
        regions.append({
            "boundary": float(transform_value(val)),
            "description": "Effect transitions between significance states"
        })

    message_parts = []
    if not regions:
        message_parts.append("No Johnson-Neyman regions within the observed moderator range.")
    else:
        if sig_at_min:
            message_parts.append("Effect significant below first boundary.")
        else:
            message_parts.append("Effect non-significant below first boundary.")
        if sig_at_max:
            message_parts.append("Effect significant above last boundary.")
        else:
            message_parts.append("Effect non-significant above last boundary.")

    return {
        "regions": regions,
        "message": " ".join(message_parts)
    }

def _generate_moderation_interpretation(interaction_p, conditional_effects, confidence):
    """Generate plain-language interpretation of moderation results."""

    alpha = 1 - confidence

    if interaction_p < alpha:
        interp = f"The interaction is statistically significant (p = {interaction_p:.4f}), indicating that the effect of X on Y depends on the level of W (moderation is present)."
    else:
        interp = f"The interaction is not statistically significant (p = {interaction_p:.4f}), suggesting that the effect of X on Y does not depend on W (no evidence of moderation)."

    # Add conditional effects interpretation
    sig_effects = [e for e in conditional_effects if e['significant']]
    nonsig_effects = [e for e in conditional_effects if not e['significant']]

    if sig_effects:
        labels = [e['label'] for e in sig_effects]
        interp += f"\n\nConditional effects are significant at: {', '.join(labels)}."

    if nonsig_effects:
        labels = [e['label'] for e in nonsig_effects]
        interp += f"\nConditional effects are non-significant at: {', '.join(labels)}."

    return interp


def _generate_mod_med_interpretation(index_sig, cond_effects, direct_p, confidence):
    """Generate interpretation for moderated mediation results."""

    alpha = 1 - confidence

    if index_sig:
        interp = "The index of moderated mediation is significantly different from zero, indicating that the indirect effect of X on Y through M depends on the level of W (moderated mediation is present)."
    else:
        interp = "The index of moderated mediation is not significantly different from zero, suggesting that the indirect effect does not vary by W (no evidence of moderated mediation)."

    # Conditional indirect effects
    sig_cond = [e for e in cond_effects if e['significant']]
    nonsig_cond = [e for e in cond_effects if not e['significant']]

    if sig_cond:
        labels = [e['label'] for e in sig_cond]
        interp += f"\n\nThe indirect effect is significant at: {', '.join(labels)}."

    if nonsig_cond:
        labels = [e['label'] for e in nonsig_cond]
        interp += f"\nThe indirect effect is non-significant at: {', '.join(labels)}."

    # Direct effect
    if direct_p < alpha:
        interp += f"\n\nThe direct effect (c') is significant (p = {direct_p:.4f}), indicating X affects Y independent of M."
    else:
        interp += f"\n\nThe direct effect (c') is not significant (p = {direct_p:.4f})."

    return interp
