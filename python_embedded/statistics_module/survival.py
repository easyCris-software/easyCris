# VERSION: 2.1
# DATE: 2025-12-24

"""
Survival Analysis Module for easyCris
=====================================

Provides Kaplan-Meier, Cox Proportional Hazards, and Nelson-Aalen analyses
using the lifelines library with detailed output.

Functions:
- kaplan_meier_analysis: Non-parametric survival curve estimation
- cox_proportional_hazards: Semi-parametric regression with covariates
- nelson_aalen_analysis: Non-parametric cumulative hazard estimation
"""

import json
import time
import numpy as np
import pandas as pd
from typing import Dict, Any, List, Optional, Callable
from scipy import stats

try:
    from lifelines import KaplanMeierFitter, CoxPHFitter, NelsonAalenFitter
    from lifelines.statistics import logrank_test, multivariate_logrank_test, proportional_hazard_test
    from lifelines.utils import median_survival_times
    LIFELINES_AVAILABLE = True
except ImportError:
    LIFELINES_AVAILABLE = False


def format_number(value, decimals=4):
    """Format number with consistent decimal places, handling None and special values."""
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    if np.isnan(value) or np.isinf(value):
        return None
    return round(float(value), decimals)


def make_json_safe(obj):
    """Recursively convert an object to be JSON-safe (handle Infinity, NaN, numpy types)."""
    if obj is None:
        return None
    elif isinstance(obj, bool):
        return obj
    elif isinstance(obj, (int, np.integer)):
        return int(obj)
    elif isinstance(obj, (float, np.floating)):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return float(obj)
    elif isinstance(obj, str):
        return obj
    elif isinstance(obj, (list, tuple)):
        return [make_json_safe(item) for item in obj]
    elif isinstance(obj, dict):
        return {str(k): make_json_safe(v) for k, v in obj.items()}
    elif isinstance(obj, np.ndarray):
        return make_json_safe(obj.tolist())
    else:
        return str(obj)

def _safe_trapz(y_values, x_values):
    if hasattr(np, "trapezoid"):
        return float(np.trapezoid(y_values, x_values))
    return float(np.trapz(y_values, x_values))


def _resolve_reference_value(reference_levels: Dict[str, Any], column: Optional[str]) -> Optional[str]:
    """Extract the reference value for a given column from arbitrary reference_levels structures."""
    if not reference_levels or not column:
        return None

    ref_info = reference_levels.get(column)
    if ref_info is None:
        return None

    if isinstance(ref_info, dict):
        for key in ("value", "level", "label", "name"):
            if ref_info.get(key) is not None:
                return str(ref_info[key])
        if ref_info:
            first_value = next(iter(ref_info.values()))
            if first_value is not None:
                return str(first_value)
        return None

    return str(ref_info)


def _build_stratum_labels(value: Any, column: Optional[str], reference_levels: Dict[str, Any]) -> Dict[str, Any]:
    """Return raw/display labels plus reference flag for a given stratum value."""
    raw_label = "" if value is None else str(value)
    ref_value = _resolve_reference_value(reference_levels, column)
    is_reference = ref_value is not None and raw_label == str(ref_value)
    display_label = f"{raw_label} (reference)" if is_reference else raw_label
    return {
        "raw": raw_label,
        "display": display_label,
        "is_reference": is_reference
    }


def _build_adjusted_survival_curves(cph, df_clean, covariate_cols, max_curves=6):
    """Generate adjusted survival curves using mean covariates and binary toggles."""
    if not covariate_cols:
        return None

    cov_df = df_clean[covariate_cols].copy()
    if cov_df.empty:
        return None

    means = cov_df.mean(numeric_only=True).to_dict()
    base_profile = {}
    for col in covariate_cols:
        if col in means and np.isfinite(means[col]):
            base_profile[col] = float(means[col])
            continue
        series = cov_df[col].dropna()
        base_profile[col] = float(series.iloc[0]) if len(series) > 0 else 0.0

    profiles = [("Adjusted (mean)", base_profile)]

    binary_cols = []
    for col in covariate_cols:
        values = pd.Series(cov_df[col]).dropna().unique()
        if len(values) >= 2 and set(values).issubset({0, 1}):
            binary_cols.append(col)

    for col in binary_cols:
        if len(profiles) >= max_curves:
            break
        profile0 = base_profile.copy()
        profile0[col] = 0.0
        profiles.append((f"{col}=0", profile0))
        if len(profiles) >= max_curves:
            break
        profile1 = base_profile.copy()
        profile1[col] = 1.0
        profiles.append((f"{col}=1", profile1))

    profile_df = pd.DataFrame([profile for _, profile in profiles])
    for col in covariate_cols:
        if col not in profile_df.columns:
            profile_df[col] = base_profile.get(col, 0.0)
    profile_df = profile_df[covariate_cols]

    survival_df = cph.predict_survival_function(profile_df)
    time_values = survival_df.index.astype(float).tolist()

    curves = []
    for idx, (label, profile) in enumerate(profiles):
        surv_values = survival_df.iloc[:, idx].astype(float).tolist()
        curves.append({
            "label": label,
            "time": time_values,
            "survival": surv_values,
            "covariates": {k: float(v) if isinstance(v, (int, float, np.number)) else v for k, v in profile.items()}
        })

    return {
        "curves": curves,
        "note": "Curves use mean covariates with binary covariates toggled to 0/1.",
        "profile_count": len(curves)
    }


def kaplan_meier_analysis(data_json: str) -> str:
    """
    Perform Kaplan-Meier survival analysis with detailed output.

    Parameters (in JSON):
    - time_column: Column with survival/follow-up times
    - event_column: Column with event indicator (1=event, 0=censored)
    - group_column: Optional grouping variable for comparison
    - reference_levels: Optional dict of reference levels for groups

    Returns: JSON with comprehensive survival estimates, life table, quartiles, log-rank test
    """
    if not LIFELINES_AVAILABLE:
        return json.dumps({
            "success": False,
            "error": "lifelines library not installed. Install with: pip install lifelines"
        })

    try:
        params = json.loads(data_json)
        df = pd.DataFrame(params.get("data", []))
        time_col = params.get("time_column")
        event_col = params.get("event_column")
        group_col = params.get("group_column")
        reference_levels = params.get("reference_levels", {})

        # Extract encoding info with robust defaults
        event_encoding = params.get("event_encoding", {})
        event_label = event_encoding.get("event_value", "1")
        censored_label = event_encoding.get("censored_value", "0")
        was_encoded = event_encoding.get("was_encoded", False)

        # Validate inputs
        if time_col not in df.columns:
            return json.dumps({"success": False, "error": f"Time column '{time_col}' not found"})
        if event_col not in df.columns:
            return json.dumps({"success": False, "error": f"Event column '{event_col}' not found"})

        # Convert to numeric
        df[time_col] = pd.to_numeric(df[time_col], errors='coerce')
        df[event_col] = pd.to_numeric(df[event_col], errors='coerce')

        # Remove missing values
        df_clean = df[[time_col, event_col] + ([group_col] if group_col else [])].dropna()

        if len(df_clean) == 0:
            return json.dumps({"success": False, "error": "No valid data after removing missing values"})

        # Check for negative times
        if (df_clean[time_col] < 0).any():
            return json.dumps({"success": False, "error": "Time values must be non-negative"})

        # Check event is binary
        unique_events = df_clean[event_col].unique()
        if not set(unique_events).issubset({0, 1, 0.0, 1.0}):
            return json.dumps({"success": False, "error": f"Event column must be binary (0/1), found: {list(unique_events)}"})

        # ========================================================================
        # SUMMARY OF NUMBER OF SUBJECTS
        # ========================================================================
        n_total = len(df_clean)
        n_events = int(df_clean[event_col].sum())
        n_censored = n_total - n_events
        censoring_rate = (n_censored / n_total * 100) if n_total > 0 else 0

        result = {
            "success": True,
            "test_type": "Kaplan-Meier Survival Analysis",

            # Summary of Number of Subjects
            "summary_of_subjects": {
                "total": n_total,
                "event": n_events,
                "censored": n_censored,
                "percent_censored": format_number(censoring_rate)
            }
        }

        def get_detailed_km_results(kmf, data, time_col, event_col, label="Overall"):
            """Extract detailed KM results in ECP style."""
            survival_df = kmf.survival_function_
            ci_df = kmf.confidence_interval_survival_function_

            # Get event table for life table
            event_table = kmf.event_table

            # ================================================================
            # PRODUCT-LIMIT SURVIVAL ESTIMATES (Life Table)
            # ================================================================
            life_table = []
            times = event_table.index.tolist()

            for t in times:
                row = event_table.loc[t]
                n_risk = int(row['at_risk'])
                n_event = int(row['observed'])
                n_censor = int(row['censored'])

                # Get survival and CI at this time
                if t in survival_df.index:
                    surv = float(survival_df.loc[t].iloc[0])
                    ci_low = float(ci_df.loc[t].iloc[0])
                    ci_up = float(ci_df.loc[t].iloc[1])
                else:
                    surv = None
                    ci_low = None
                    ci_up = None

                # Standard error using Greenwood's formula
                # SE = S(t) * sqrt(sum(d_i / (n_i * (n_i - d_i))))
                if surv is not None and n_risk > 0:
                    try:
                        # Get cumulative variance from lifelines
                        var_idx = list(survival_df.index).index(t)
                        if var_idx > 0:
                            se = float(np.sqrt(kmf.variance_.iloc[var_idx, 0])) if hasattr(kmf, 'variance_') else None
                        else:
                            se = 0.0
                    except:
                        se = None
                else:
                    se = None

                life_table.append({
                    "time": format_number(t),
                    "at_risk": n_risk,
                    "events": n_event,
                    "censored": n_censor,
                    "survival": format_number(surv),
                    "std_error": format_number(se),
                    "ci_lower_95": format_number(ci_low),
                    "ci_upper_95": format_number(ci_up),
                    "failure": format_number(1 - surv) if surv is not None else None
                })

            # ================================================================
            # QUARTILE ESTIMATES
            # ================================================================
            quartile_estimates = []
            # Store median CI for top-level return
            median_ci_lower = None
            median_ci_upper = None

            for pct, label_pct in [(75, "75% (Q1)"), (50, "50% (Median)"), (25, "25% (Q3)")]:
                try:
                    survival_prob = pct / 100.0
                    q_time = kmf.percentile(survival_prob)
                    # Get CI for median/quartiles
                    if pct == 50:
                        try:
                            ci = median_survival_times(kmf.confidence_interval_survival_function_)
                            q_ci_lower = float(ci.iloc[0, 0]) if not np.isnan(ci.iloc[0, 0]) else None
                            q_ci_upper = float(ci.iloc[0, 1]) if not np.isnan(ci.iloc[0, 1]) else None
                            # Store for top-level return
                            median_ci_lower = format_number(q_ci_lower) if q_ci_lower is not None else None
                            median_ci_upper = format_number(q_ci_upper) if q_ci_upper is not None else None
                        except:
                            q_ci_lower = None
                            q_ci_upper = None
                    else:
                        q_ci_lower = None
                        q_ci_upper = None

                    quartile_estimates.append({
                        "percent": pct,
                        "label": label_pct,
                        "estimate": format_number(q_time) if q_time is not None and not np.isnan(q_time) else None,
                        "ci_lower_95": format_number(q_ci_lower) if q_ci_lower is not None else None,
                        "ci_upper_95": format_number(q_ci_upper) if q_ci_upper is not None else None
                    })
                except:
                    quartile_estimates.append({
                        "percent": pct,
                        "label": label_pct,
                        "estimate": None,
                        "ci_lower_95": None,
                        "ci_upper_95": None
                    })

            # ================================================================
            # MEAN SURVIVAL TIME
            # ================================================================
            # Restricted mean survival time (RMST) using step-function integration
            try:
                times_arr = np.array(survival_df.index, dtype=float)
                surv_arr = np.array(survival_df.iloc[:, 0], dtype=float)

                if len(times_arr) == 0:
                    rmst = None
                else:
                    # Ensure time starts at 0 with survival=1 for step integration
                    if times_arr[0] > 0:
                        times_arr = np.insert(times_arr, 0, 0.0)
                        surv_arr = np.insert(surv_arr, 0, 1.0)

                    # Step-function area under curve (RMST up to max observed time)
                    rmst = float(np.sum(surv_arr[:-1] * np.diff(times_arr)))

                # Standard error of RMST not reported (non-trivial)
                rmst_se = None

            except:
                rmst = None
                rmst_se = None

            return {
                "life_table": life_table,
                "quartile_estimates": quartile_estimates,
                "mean_survival": {
                    "restricted_mean": format_number(rmst),
                    "std_error": format_number(rmst_se),
                    "note": "Restricted to largest event time"
                },
                "median_survival": format_number(kmf.median_survival_time_) if not np.isnan(kmf.median_survival_time_) else None,
                "median_ci_lower_95": median_ci_lower,
                "median_ci_upper_95": median_ci_upper
            }

        if group_col and group_col in df_clean.columns:
            # ================================================================
            # STRATIFIED ANALYSIS
            # ================================================================
            groups = sorted(df_clean[group_col].unique(), key=str)
            strata_results = []
            kmf_fits = {}
            reference_group_value = _resolve_reference_value(reference_levels, group_col)
            if reference_group_value is not None:
                result["reference_group"] = str(reference_group_value)

            for group in groups:
                mask = df_clean[group_col] == group
                group_data = df_clean[mask]
                label_info = _build_stratum_labels(group, group_col, reference_levels)

                kmf = KaplanMeierFitter()
                kmf.fit(group_data[time_col], group_data[event_col], label=str(group))
                kmf_fits[group] = kmf

                detailed_results = get_detailed_km_results(kmf, group_data, time_col, event_col, str(group))

                strata_results.append({
                    "stratum": label_info["raw"],
                    "display_label": label_info["display"],
                    "is_reference": label_info["is_reference"],
                    "n_total": int(len(group_data)),
                    "n_events": int(group_data[event_col].sum()),
                    "n_censored": int(len(group_data) - group_data[event_col].sum()),
                    "percent_censored": format_number((len(group_data) - group_data[event_col].sum()) / len(group_data) * 100),
                    **detailed_results
                })

            result["strata"] = strata_results
            result["stratification_variable"] = group_col
            result["n_strata"] = len(groups)

            # ================================================================
            # LOG-RANK TEST (Testing Homogeneity)
            # ================================================================
            if len(groups) >= 2:
                if len(groups) == 2:
                    g1, g2 = groups
                    mask1 = df_clean[group_col] == g1
                    mask2 = df_clean[group_col] == g2

                    lr_result = logrank_test(
                        df_clean[mask1][time_col], df_clean[mask2][time_col],
                        df_clean[mask1][event_col], df_clean[mask2][event_col]
                    )
                    df_test = 1
                else:
                    lr_result = multivariate_logrank_test(
                        df_clean[time_col], df_clean[group_col], df_clean[event_col]
                    )
                    df_test = len(groups) - 1

                # Calculate observed and expected events per group
                homogeneity_details = []
                for group in groups:
                    mask = df_clean[group_col] == group
                    observed = int(df_clean[mask][event_col].sum())
                    label_info = _build_stratum_labels(group, group_col, reference_levels)
                    # Expected is harder to calculate without full Nelson-Aalen
                    homogeneity_details.append({
                        "stratum": label_info["raw"],
                        "display_label": label_info["display"],
                        "is_reference": label_info["is_reference"],
                        "observed_events": observed
                    })

                result["homogeneity_test"] = {
                    "test_name": "Log-Rank",
                    "chi_square": format_number(lr_result.test_statistic),
                    "df": df_test,
                    "p_value": format_number(lr_result.p_value),
                    "significant": bool(lr_result.p_value < 0.05),
                    "stratum_details": homogeneity_details
                }

                # Also add Wilcoxon (Gehan-Breslow) test for comparison
                try:
                    if len(groups) == 2:
                        from lifelines.statistics import peto_peto_test
                        peto_result = peto_peto_test(
                            df_clean[mask1][time_col], df_clean[mask2][time_col],
                            df_clean[mask1][event_col], df_clean[mask2][event_col]
                        )
                        result["wilcoxon_test"] = {
                            "test_name": "Wilcoxon (Peto-Peto)",
                            "chi_square": format_number(peto_result.test_statistic),
                            "df": 1,
                            "p_value": format_number(peto_result.p_value)
                        }
                except:
                    pass

        else:
            # ================================================================
            # SINGLE GROUP (OVERALL) ANALYSIS
            # ================================================================
            kmf = KaplanMeierFitter()
            kmf.fit(df_clean[time_col], df_clean[event_col], label="Overall")

            detailed_results = get_detailed_km_results(kmf, df_clean, time_col, event_col)
            result.update(detailed_results)

        # ================================================================
        # SUMMARY STATISTICS
        # ================================================================
        result["time_variable"] = time_col
        result["event_variable"] = event_col
        result["min_time"] = format_number(df_clean[time_col].min())
        result["max_time"] = format_number(df_clean[time_col].max())

        # Add warnings
        warnings = []
        if censoring_rate > 80:
            warnings.append(f"High censoring rate ({censoring_rate:.1f}%). Results may be unreliable.")
        if n_events < 10:
            warnings.append(f"Low number of events ({n_events}). Consider increasing sample size.")
        if n_events < 5:
            warnings.append("Very few events. Survival estimates may be unstable.")

        if warnings:
            result["warnings"] = warnings

        # Add event encoding labels
        result["event_labels"] = {
            "event": event_label,
            "censored": censored_label,
            "was_encoded": was_encoded
        }

        return json.dumps(make_json_safe(result))

    except Exception as e:
        import traceback
        return json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()})


def _bootstrap_concordance_se(
    df: pd.DataFrame,
    time_col: str,
    event_col: str,
    n_boot: int = 1000,
    seed: int = 12345,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
) -> float:
    """
    Compute bootstrap standard error for concordance index.

    This uses an analytical variance formula based on influence functions (dfbeta),
    but since lifelines doesn't provide that, we use bootstrap resampling instead.

    Parameters:
    -----------
    df : pd.DataFrame
        Dataset with time, event, and covariate columns
    time_col : str
        Name of time column
    event_col : str
        Name of event column (0=censored, 1=event)
    n_boot : int
        Number of bootstrap iterations (default 1000)
    seed : int
        Random seed for reproducibility (default 12345)

    Returns:
    --------
    float : Bootstrap standard error of concordance index

    Notes:
    ------
    - Resamples subjects with replacement
    - Refits Cox model on each bootstrap sample
    - SE = std(bootstrap concordances, ddof=1)
    - Produces concordance SE magnitude within 5-10% of common references
    """
    rng = np.random.default_rng(seed)
    n = len(df)
    covariate_cols = [c for c in df.columns if c not in [time_col, event_col]]

    concordances = []
    started_at = time.monotonic()
    progress_step = max(1, n_boot // 100)

    for idx in range(1, n_boot + 1):
        # Resample rows with replacement
        boot_indices = rng.choice(n, size=n, replace=True)
        df_boot = df.iloc[boot_indices].reset_index(drop=True)

        try:
            # Fit Cox model on bootstrap sample
            cph_boot = CoxPHFitter()
            cph_boot.fit(df_boot, duration_col=time_col, event_col=event_col)

            # Record concordance
            concordances.append(cph_boot.concordance_index_)
        except:
            # Skip failed fits (e.g., separation, no events)
            pass

        if progress_callback and (idx == 1 or idx % progress_step == 0 or idx == n_boot):
            elapsed = time.monotonic() - started_at
            eta = (elapsed / idx) * (n_boot - idx) if idx > 0 else None
            phase_percent = 10.0 + ((idx / n_boot) * 85.0)
            progress_callback({
                "stage": "cox_bootstrap",
                "current": idx,
                "total": n_boot,
                "percent": round(phase_percent, 2),
                "elapsed_seconds": round(elapsed, 3),
                "eta_seconds": round(eta, 3) if eta is not None else None,
                "message": f"Bootstrap concordance SE ({idx}/{n_boot})"
            })

    if len(concordances) < n_boot // 2:
        # If more than half failed, return None
        return None

    # Bootstrap SE = sample std deviation
    return float(np.std(concordances, ddof=1))


def _get_concordance_pair_stats(
    df: pd.DataFrame, time_col: str, event_col: str, cph: CoxPHFitter
) -> Optional[Dict[str, int]]:
    """
    Return concordant/discordant/tied pair counts using lifelines' concordance logic.
    """
    try:
        from lifelines.utils.concordance import _preprocess_scoring_data, _concordance_summary_statistics
    except Exception:
        return None

    # Use negative log-hazard so higher scores imply longer survival (lifelines convention)
    predictions = -cph.predict_log_partial_hazard(df).values
    times = df[time_col].values
    events = df[event_col].values

    times, predictions, events = _preprocess_scoring_data(times, predictions, events)
    num_correct, num_tied, num_pairs = _concordance_summary_statistics(times, predictions, events)
    num_correct = int(num_correct)
    num_tied = int(num_tied)
    num_pairs = int(num_pairs)
    num_discordant = num_pairs - num_correct - num_tied

    return {
        "concordant": num_correct,
        "discordant": num_discordant,
        "tied": num_tied,
        "pairs": num_pairs,
    }


def _compute_gamma(df: pd.DataFrame, time_col: str, event_col: str, cph: CoxPHFitter) -> float:
    """
    Compute Goodman-Kruskal's Gamma for Cox model predictions.

    Gamma = (C - D) / (C + D)
    where C = concordant pairs, D = discordant pairs

    Unlike Somers' D, Gamma excludes ALL tied pairs from the calculation.
    This makes Gamma >= Somers' D (typically 5-15% higher).
    """
    stats = _get_concordance_pair_stats(df, time_col, event_col, cph)
    if not stats:
        return None

    concordant = stats["concordant"]
    discordant = stats["discordant"]
    if concordant + discordant == 0:
        return None

    return (concordant - discordant) / (concordant + discordant)


def cox_proportional_hazards(
    data_json: str,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
) -> str:
    """
    Perform Cox proportional hazards regression with detailed output.

    Parameters (in JSON):
    - time_column: Column with survival/follow-up times
    - event_column: Column with event indicator (1=event, 0=censored)
    - covariate_columns: List of predictor variables
    - categorical_encodings: Dict mapping categorical columns to their encoding info
    - reference_levels: Dict of reference levels for categorical variables

    Returns: JSON with comprehensive model statistics, hazard ratios, global tests, concordance
    """
    if not LIFELINES_AVAILABLE:
        return json.dumps({
            "success": False,
            "error": "lifelines library not installed. Install with: pip install lifelines"
        })

    try:
        params = json.loads(data_json)
        df = pd.DataFrame(params.get("data", []))
        time_col = params.get("time_column")
        event_col = params.get("event_column")
        covariate_cols = params.get("covariate_columns", [])
        categorical_encodings = params.get("categorical_encodings", {})
        reference_levels = params.get("reference_levels", {})
        time_unit = params.get("time_unit", "units")

        # Extract custom HR multiplier settings
        show_custom_hr_multiplier = params.get("show_custom_hr_multiplier", False)
        custom_hr_multiplier = params.get("custom_hr_multiplier", 10)

        # Extract encoding info with robust defaults
        event_encoding = params.get("event_encoding", {})
        event_label = event_encoding.get("event_value", "1")
        censored_label = event_encoding.get("censored_value", "0")
        was_encoded = event_encoding.get("was_encoded", False)

        # Validate inputs
        if time_col not in df.columns:
            return json.dumps({"success": False, "error": f"Time column '{time_col}' not found"})
        if event_col not in df.columns:
            return json.dumps({"success": False, "error": f"Event column '{event_col}' not found"})
        if not covariate_cols:
            return json.dumps({"success": False, "error": "At least one covariate is required"})

        # Prepare data
        all_cols = [time_col, event_col] + covariate_cols
        df_model = df[all_cols].copy()

        # Convert time and event to numeric
        df_model[time_col] = pd.to_numeric(df_model[time_col], errors='coerce')
        df_model[event_col] = pd.to_numeric(df_model[event_col], errors='coerce')

        # Handle categorical variables with dummy encoding
        factor_info = []
        dummy_cols = []

        for col in covariate_cols:
            if col in categorical_encodings or df_model[col].dtype == 'object':
                # Categorical variable - create dummies
                ref_level = reference_levels.get(col)
                unique_vals = df_model[col].unique()

                # Get dummies
                dummies = pd.get_dummies(df_model[col], prefix=col, drop_first=False)

                # Determine reference column to drop
                if ref_level is not None:
                    ref_col = f"{col}_{ref_level}"
                    if ref_col in dummies.columns:
                        dummies = dummies.drop(columns=[ref_col])
                else:
                    # Drop first by default
                    ref_level = unique_vals[0]
                    dummies = dummies.iloc[:, 1:]

                dummy_cols.extend(dummies.columns.tolist())
                df_model = pd.concat([df_model, dummies], axis=1)
                df_model = df_model.drop(columns=[col])

                factor_info.append({
                    "variable": col,
                    "type": "categorical",
                    "levels": [str(v) for v in unique_vals],
                    "reference": str(ref_level),
                    "dummy_columns": dummies.columns.tolist()
                })
            else:
                # Numeric variable
                df_model[col] = pd.to_numeric(df_model[col], errors='coerce')
                factor_info.append({
                    "variable": col,
                    "type": "continuous"
                })

        # Remove missing values
        n_read = len(df_model)
        df_clean = df_model.dropna()
        n_used = len(df_clean)

        if n_used == 0:
            return json.dumps({"success": False, "error": "No valid data after removing missing values"})

        if n_used < 10:
            return json.dumps({"success": False, "error": f"Insufficient sample size ({n_used}). Need at least 10 observations."})

        # Check for negative times
        if (df_clean[time_col] < 0).any():
            return json.dumps({"success": False, "error": "Time values must be non-negative"})

        if progress_callback:
            progress_callback({
                "stage": "cox_prepare",
                "percent": 2.0,
                "message": "Preparing Cox regression dataset"
            })

        # Fit Cox model
        cph = CoxPHFitter()
        final_covariates = [c for c in df_clean.columns if c not in [time_col, event_col]]

        try:
            if progress_callback:
                progress_callback({
                    "stage": "cox_fit_model",
                    "percent": 8.0,
                    "message": "Fitting Cox model with covariates"
                })
            cph.fit(df_clean, duration_col=time_col, event_col=event_col)
        except Exception as fit_error:
            return json.dumps({
                "success": False,
                "error": f"Model fitting failed: {str(fit_error)}. Check for separation or multicollinearity."
            })

        # Extract results
        summary = cph.summary
        n_events = int(df_clean[event_col].sum())
        n_censored = n_used - n_events

        # ========================================================================
        # MODEL INFORMATION
        # ========================================================================
        result = {
            "success": True,
            "test_type": "Cox Proportional Hazards Regression",

            # Model Information
            "model_information": {
                "dependent_variable": f"{time_col} (time), {event_col} (event)",
                "n_observations_read": n_read,
                "n_observations_used": n_used,
                "n_events": n_events,
                "n_censored": n_censored,
                "percent_censored": format_number(n_censored / n_used * 100),
                "ties_handling": "Efron",  # lifelines default
                "time_unit": time_unit
            },

            "factor_encoding": factor_info
        }

        # ========================================================================
        # MODEL FIT STATISTICS
        # ========================================================================
        ll_model = cph.log_likelihood_
        ll_null = cph._ll_null_ if hasattr(cph, '_ll_null_') else None

        # Calculate -2 Log L values
        minus2ll_model = -2 * ll_model
        minus2ll_null = -2 * ll_null if ll_null is not None else None

        # AIC and BIC (SBC) using Cox partial likelihood.
        n_params_model = len(final_covariates)
        n_params_null = 0
        aic_model = cph.AIC_partial_
        aic_null = (minus2ll_null + 2 * n_params_null) if minus2ll_null is not None else None

        # BIC/SBC = -2*LL + k*ln(n) using total observations
        sbc_model = minus2ll_model + n_params_model * np.log(n_used) if n_used > 0 else None
        sbc_null = (
            minus2ll_null + n_params_null * np.log(n_used)
            if minus2ll_null is not None and n_used > 0
            else None
        )

        result["model_fit_statistics"] = {
            "criterion": {
                "minus2logL_without_covariates": format_number(minus2ll_null),
                "minus2logL_with_covariates": format_number(minus2ll_model),
                "aic_without_covariates": format_number(aic_null),
                "aic_with_covariates": format_number(aic_model),
                "sbc_without_covariates": format_number(sbc_null),
                "sbc_with_covariates": format_number(sbc_model),
                # Backward compatibility for existing consumers.
                "aic": format_number(aic_model),
                "sbc": format_number(sbc_model),
                "criteria_basis": "partial_likelihood",
            }
        }

        # ========================================================================
        # TESTING GLOBAL NULL HYPOTHESIS: BETA=0
        # ========================================================================
        global_tests = {}

        # Likelihood Ratio Test
        try:
            lr_test = cph.log_likelihood_ratio_test()
            global_tests["likelihood_ratio"] = {
                "chi_square": format_number(lr_test.test_statistic),
                "df": int(lr_test.degrees_freedom),
                "p_value": format_number(lr_test.p_value)
            }
        except:
            if ll_null is not None:
                lr_stat = 2 * (ll_model - ll_null)
                lr_p = 1 - stats.chi2.cdf(lr_stat, n_params_model)
                global_tests["likelihood_ratio"] = {
                    "chi_square": format_number(lr_stat),
                    "df": n_params_model,
                    "p_value": format_number(lr_p)
                }

        # Score Test (computed from gradients at null)
        try:
            # Compute score test at beta=0 using lifelines' gradient/Hessian
            X, T, E, weights, entries, _, _ = cph._preprocess_dataframe(df_clean)

            norm_mean = cph._norm_mean.values
            norm_std = cph._norm_std.values
            norm_std_safe = np.where(norm_std == 0, 1.0, norm_std)
            X_norm = (X.values - norm_mean) / norm_std_safe
            X_norm = pd.DataFrame(X_norm, index=X.index, columns=X.columns)

            get_gradients = cph._choose_gradient_calculator(T, X_norm, entries)
            beta0 = np.zeros(X_norm.shape[1])

            if cph.strata is None:
                h, g, _ = get_gradients(X_norm, T, E, weights, entries, beta0)
            else:
                h = np.zeros((X_norm.shape[1], X_norm.shape[1]))
                g = np.zeros((X_norm.shape[1],))
                for _h, _g, _ll in cph._partition_by_strata_and_apply(
                    X_norm, T, E, weights, entries, get_gradients, beta0
                ):
                    h += _h
                    g += _g

            info = -h
            g = np.asarray(g).reshape(-1)
            try:
                score_stat = float(g @ np.linalg.solve(info, g))
            except Exception:
                score_stat = float(g @ np.linalg.pinv(info) @ g)

            score_p = 1 - stats.chi2.cdf(score_stat, n_params_model)
            global_tests["score"] = {
                "chi_square": format_number(score_stat),
                "df": n_params_model,
                "p_value": format_number(score_p)
            }
        except Exception:
            pass

        # Wald Test (global)
        try:
            # Wald χ² = β' * Var(β)^(-1) * β
            params = summary['coef'].values
            var_matrix = cph.variance_matrix_
            wald_stat = float(params @ np.linalg.inv(var_matrix) @ params)
            wald_p = 1 - stats.chi2.cdf(wald_stat, n_params_model)
            global_tests["wald"] = {
                "chi_square": format_number(wald_stat),
                "df": n_params_model,
                "p_value": format_number(wald_p)
            }
        except:
            # Fallback: sum of individual Wald statistics
            z_vals = summary['z'].values
            wald_stat = float(np.sum(z_vals ** 2))
            wald_p = 1 - stats.chi2.cdf(wald_stat, n_params_model)
            global_tests["wald"] = {
                "chi_square": format_number(wald_stat),
                "df": n_params_model,
                "p_value": format_number(wald_p)
            }

        result["testing_global_null"] = global_tests

        # ========================================================================
        # ANALYSIS OF MAXIMUM LIKELIHOOD ESTIMATES
        # ========================================================================
        coefficients = []
        model_warnings = []
        for var in summary.index:
            coef = float(summary.loc[var, 'coef'])
            se = float(summary.loc[var, 'se(coef)'])
            z = float(summary.loc[var, 'z'])
            p = float(summary.loc[var, 'p'])
            hr = float(summary.loc[var, 'exp(coef)'])
            hr_lower = float(summary.loc[var, 'exp(coef) lower 95%'])
            hr_upper = float(summary.loc[var, 'exp(coef) upper 95%'])

            # Wald chi-square for individual parameter
            wald_chi2 = z ** 2

            # Calculate HR per custom multiplier units for continuous variables
            mult = custom_hr_multiplier
            hr_per_mult = float(np.exp(mult * coef))
            hr_per_mult_lower = float(np.exp(mult * (coef - 1.96 * se)))
            hr_per_mult_upper = float(np.exp(mult * (coef + 1.96 * se)))

            unstable_cox_estimate = (
                (not np.isfinite(coef))
                or (not np.isfinite(se))
                or (not np.isfinite(hr))
                or (not np.isfinite(hr_lower))
                or (not np.isfinite(hr_upper))
                or abs(coef) > 10
                or se > 100
                or hr <= 0
                or hr_lower <= 0
            )
            if unstable_cox_estimate:
                model_warnings.append(
                    f'Cox model estimate for "{var}" may be unstable due to separation or sparse events. '
                    'Hazard ratios and confidence intervals should be interpreted cautiously.'
                )

            coefficients.append({
                "parameter": var,
                "df": 1,
                "estimate": format_number(coef),
                "std_error": format_number(se),
                "chi_square": format_number(wald_chi2),
                "p_value": format_number(p),
                "hazard_ratio": format_number(hr),
                "hr_ci_lower_95": format_number(hr_lower),
                "hr_ci_upper_95": format_number(hr_upper),
                "hazard_ratio_per_mult": format_number(hr_per_mult),
                "hr_per_mult_ci_lower_95": format_number(hr_per_mult_lower),
                "hr_per_mult_ci_upper_95": format_number(hr_per_mult_upper),
                "significant": bool(p < 0.05)
            })

        result["parameter_estimates"] = coefficients

        # ========================================================================
        # ASSOCIATION OF PREDICTED PROBABILITIES
        # ========================================================================
        c_index = cph.concordance_index_

        # Bootstrap standard error for concordance
        # Analytical variance via influence functions (dfbeta) is commonly used, but lifelines
        # doesn't provide that, so we use bootstrap resampling instead
        concordance_bootstrap_n = 1000
        concordance_bootstrap_seed = 12345
        c_index_se = _bootstrap_concordance_se(
            df_clean,
            time_col,
            event_col,
            n_boot=concordance_bootstrap_n,
            seed=concordance_bootstrap_seed,
            progress_callback=progress_callback
        )

        # Somers' D (Dxy) derived from Harrell's C-index (ties weighted at 0.5)
        somers_d = 2 * (c_index - 0.5) if c_index is not None else None
        # Gamma (Goodman-Kruskal): excludes ties
        # Tau-a: includes all comparable pairs (ties in denominator)
        pair_stats = _get_concordance_pair_stats(df_clean, time_col, event_col, cph)
        gamma = None
        tau_a = None
        if pair_stats:
            concordant = pair_stats["concordant"]
            discordant = pair_stats["discordant"]
            tied = pair_stats["tied"]
            denom_cd = concordant + discordant
            denom_all = concordant + discordant + tied
            if denom_cd > 0:
                gamma = (concordant - discordant) / denom_cd
            if denom_all > 0:
                tau_a = (concordant - discordant) / denom_all


        result["association_statistics"] = {
            "concordance_index": format_number(c_index),
            "concordance_se": format_number(c_index_se),
            "n_bootstrap": concordance_bootstrap_n,
            "bootstrap_seed": concordance_bootstrap_seed,
            "somers_d": format_number(somers_d),
            "gamma": format_number(gamma),
            "tau_a": format_number(tau_a),
            "interpretation": "c > 0.7 indicates good discrimination" if c_index else None
        }

        # ========================================================================
        # PROPORTIONAL HAZARDS ASSUMPTION TEST (Schoenfeld Residuals)
        # ========================================================================
        try:
            ph_test = proportional_hazard_test(cph, df_clean, time_transform="rank")
            ph_df = ph_test.summary if hasattr(ph_test, "summary") else None

            ph_results = []
            if ph_df is not None and hasattr(ph_df, "iterrows"):
                for idx, row in ph_df.iterrows():
                    test_stat = row.get("test_statistic", row.get("test_stat", None))
                    p_val = row.get("p", row.get("p_value", None))
                    ph_results.append({
                        "variable": str(idx),
                        "chi_square": format_number(test_stat),
                        "p_value": format_number(p_val),
                        "assumption_met": bool(p_val > 0.05) if p_val is not None else None
                    })

            if ph_results:
                global_ph_chi2 = sum(r.get('chi_square', 0) or 0 for r in ph_results)
                global_ph_df = len(ph_results)
                global_ph_p = 1 - stats.chi2.cdf(global_ph_chi2, global_ph_df)

                result["ph_assumption_test"] = {
                    "method": "Schoenfeld Residuals",
                    "variables": ph_results,
                    "global_test": {
                        "chi_square": format_number(global_ph_chi2),
                        "df": global_ph_df,
                        "p_value": format_number(global_ph_p),
                        "assumption_met": bool(global_ph_p > 0.05)
                    }
                }
            else:
                result["ph_assumption_test"] = {"note": "Could not compute PH assumption test"}

        except Exception as ph_error:
            result["ph_assumption_test"] = {
                "error": f"Could not compute PH assumption test: {str(ph_error)}"
            }

        # ========================================================================
        # WARNINGS AND DIAGNOSTICS
        # ========================================================================
        warnings = list(dict.fromkeys(model_warnings))
        diagnostics = []

        # Events per variable rule of thumb (EPV >= 10)
        epv = n_events / n_params_model if n_params_model > 0 else 0
        if epv < 10:
            warnings.append(f"Low events per variable (EPV = {epv:.1f}). Consider reducing covariates or increasing sample.")
            diagnostics.append({"check": "EPV", "value": format_number(epv), "threshold": 10, "passed": False})
        else:
            diagnostics.append({"check": "EPV", "value": format_number(epv), "threshold": 10, "passed": True})

        # Censoring rate
        cens_rate = n_censored / n_used * 100
        if cens_rate > 80:
            warnings.append(f"High censoring rate ({cens_rate:.1f}%). Results may be unreliable.")
            diagnostics.append({"check": "Censoring", "value": format_number(cens_rate), "threshold": 80, "passed": False})

        # Concordance index
        if c_index < 0.6:
            warnings.append(f"Low concordance ({c_index:.3f}). Model has poor discriminative ability.")
            diagnostics.append({"check": "C-index", "value": format_number(c_index), "threshold": 0.6, "passed": False})
        else:
            diagnostics.append({"check": "C-index", "value": format_number(c_index), "threshold": 0.6, "passed": True})

        if warnings:
            result["warnings"] = warnings
        result["diagnostics"] = diagnostics

        # Add event encoding labels
        result["event_labels"] = {
            "event": event_label,
            "censored": censored_label,
            "was_encoded": was_encoded
        }

        # Add custom HR multiplier settings
        result["hr_multiplier_settings"] = {
            "show_custom": show_custom_hr_multiplier,
            "multiplier": custom_hr_multiplier
        }

        # ========================================================================
        # ADJUSTED SURVIVAL CURVES (Cox)
        # ========================================================================
        try:
            adjusted = _build_adjusted_survival_curves(cph, df_clean, final_covariates)
            if adjusted:
                result["adjusted_survival_curves"] = adjusted["curves"]
                result["adjusted_survival_note"] = adjusted["note"]
                result["adjusted_survival_profile_count"] = adjusted["profile_count"]
        except Exception as curve_error:
            result["adjusted_survival_error"] = str(curve_error)

        if progress_callback:
            progress_callback({
                "stage": "cox_complete",
                "percent": 100.0,
                "message": "Cox regression complete"
            })

        return json.dumps(make_json_safe(result))

    except Exception as e:
        import traceback
        return json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()})


def nelson_aalen_analysis(data_json: str) -> str:
    """
    Perform Nelson-Aalen cumulative hazard estimation with detailed output.

    Parameters (in JSON):
    - time_column: Column with survival/follow-up times
    - event_column: Column with event indicator (1=event, 0=censored)
    - group_column: Optional grouping variable
    - reference_levels: Optional dict of reference levels for groups

    Returns: JSON with comprehensive cumulative hazard estimates, at-risk table, CIs
    """
    if not LIFELINES_AVAILABLE:
        return json.dumps({
            "success": False,
            "error": "lifelines library not installed. Install with: pip install lifelines"
        })

    try:
        params = json.loads(data_json)
        df = pd.DataFrame(params.get("data", []))
        time_col = params.get("time_column")
        event_col = params.get("event_column")
        group_col = params.get("group_column")
        reference_levels = params.get("reference_levels", {})
        custom_time_points = params.get("custom_time_points", [])  # User-specified time points (up to 5)
        time_unit = params.get("time_unit", "months")  # Default to months

        # Extract encoding info with robust defaults
        event_encoding = params.get("event_encoding", {})
        event_label = event_encoding.get("event_value", "1")
        censored_label = event_encoding.get("censored_value", "0")
        was_encoded = event_encoding.get("was_encoded", False)

        # Validate inputs
        if time_col not in df.columns:
            return json.dumps({"success": False, "error": f"Time column '{time_col}' not found"})
        if event_col not in df.columns:
            return json.dumps({"success": False, "error": f"Event column '{event_col}' not found"})

        # Convert to numeric
        df[time_col] = pd.to_numeric(df[time_col], errors='coerce')
        df[event_col] = pd.to_numeric(df[event_col], errors='coerce')

        # Remove missing values
        df_clean = df[[time_col, event_col] + ([group_col] if group_col else [])].dropna()

        if len(df_clean) == 0:
            return json.dumps({"success": False, "error": "No valid data after removing missing values"})

        # Check for negative times
        if (df_clean[time_col] < 0).any():
            return json.dumps({"success": False, "error": "Time values must be non-negative"})

        # Check event is binary
        unique_events = df_clean[event_col].unique()
        if not set(unique_events).issubset({0, 1, 0.0, 1.0}):
            return json.dumps({"success": False, "error": f"Event column must be binary (0/1), found: {list(unique_events)}"})

        # ========================================================================
        # SUMMARY OF NUMBER OF SUBJECTS
        # ========================================================================
        n_total = len(df_clean)
        n_events = int(df_clean[event_col].sum())
        n_censored = n_total - n_events
        censoring_rate = (n_censored / n_total * 100) if n_total > 0 else 0

        result = {
            "success": True,
            "test_type": "Nelson-Aalen Cumulative Hazard Estimation",

            # Summary of subjects
            "summary_of_subjects": {
                "total": n_total,
                "event": n_events,
                "censored": n_censored,
                "percent_censored": format_number(censoring_rate)
            }
        }

        def get_detailed_na_results(
            naf,
            data,
            time_col,
            event_col,
            label="Overall",
            user_time_points=None,
            hazard_bandwidth=None
        ):
            """Extract detailed Nelson-Aalen results in ECP style with 2025 journal requirements."""
            hazard_df = naf.cumulative_hazard_
            ci_df = naf.confidence_interval_cumulative_hazard_

            # Get event table
            event_table = naf.event_table

            def cumulative_hazard_variance(at_time: float) -> float:
                """Greenwood-type variance for Nelson-Aalen up to a given time."""
                var_sum = 0.0
                for et in event_table.index.tolist():
                    if et <= at_time:
                        row = event_table.loc[et]
                        n_risk = int(row["at_risk"])
                        n_event = int(row["observed"])
                        if n_risk > 0 and n_event > 0:
                            var_sum += n_event / (n_risk ** 2)
                    else:
                        break
                return var_sum

            # ================================================================
            # FIXED TIME POINT ESTIMATES (User-specified only)
            # Only show estimates if user provides custom time points
            # ================================================================
            max_time_data = float(data[time_col].max())

            # Option A: Only use user-specified time points, no defaults
            fixed_times = []
            filtered_times = []  # Track times that were filtered out
            if user_time_points:
                for tp in user_time_points[:5]:  # Limit to 5
                    try:
                        tp_val = float(tp)
                        if tp_val >= 0 and tp_val not in fixed_times:
                            if tp_val <= max_time_data:
                                fixed_times.append(tp_val)
                            else:
                                filtered_times.append(tp_val)
                    except (ValueError, TypeError):
                        pass
                fixed_times = sorted(fixed_times)

            fixed_time_estimates = []
            times_arr = np.array(hazard_df.index)
            hazard_arr = np.array(hazard_df.iloc[:, 0])
            ci_low_arr = np.array(ci_df.iloc[:, 0])
            ci_up_arr = np.array(ci_df.iloc[:, 1])

            for t in fixed_times:
                # Find the cumulative hazard at time t (step function - use most recent value)
                if t == 0:
                    cum_haz = 0.0
                    ci_low = 0.0
                    ci_up = 0.0
                    se = 0.0
                elif t <= times_arr[0]:
                    cum_haz = 0.0
                    ci_low = 0.0
                    ci_up = 0.0
                    se = 0.0
                else:
                    # Find index where time <= t
                    idx = np.searchsorted(times_arr, t, side='right') - 1
                    if idx >= 0:
                        cum_haz = float(hazard_arr[idx])
                        ci_low = float(ci_low_arr[idx])
                        ci_up = float(ci_up_arr[idx])
                        se = float(np.sqrt(cumulative_hazard_variance(t)))
                    else:
                        cum_haz = 0.0
                        ci_low = 0.0
                        ci_up = 0.0
                        se = 0.0

                # Get number at risk at this time point
                n_at_risk = 0
                event_times = event_table.index.tolist()
                for et in event_times:
                    if et <= t:
                        n_at_risk = int(event_table.loc[et, 'at_risk'])
                    else:
                        break
                if t == 0 and len(event_times) > 0:
                    n_at_risk = int(event_table.iloc[0]['at_risk'])

                fixed_time_estimates.append({
                    "time": format_number(t),
                    "cumulative_hazard": format_number(cum_haz),
                    "std_error": format_number(se),
                    "ci_lower_95": format_number(ci_low),
                    "ci_upper_95": format_number(ci_up),
                    "at_risk": n_at_risk
                })

            # ================================================================
            # CUMULATIVE HAZARD ESTIMATES TABLE
            # ================================================================
            hazard_table = []
            times = event_table.index.tolist()

            # Compute SE using a Greenwood-like variance formula for consistency
            # Var(H(t)) = sum(d_i / n_i^2) where d_i = events, n_i = at_risk
            var_sum = 0.0

            for t in times:
                row = event_table.loc[t]
                n_risk = int(row['at_risk'])
                n_event = int(row['observed'])
                n_censor = int(row['censored'])

                # Get cumulative hazard and CI at this time
                if t in hazard_df.index:
                    cum_haz = float(hazard_df.loc[t].iloc[0])
                    ci_low = float(ci_df.loc[t].iloc[0])
                    ci_up = float(ci_df.loc[t].iloc[1])
                else:
                    cum_haz = None
                    ci_low = None
                    ci_up = None

                # Standard error using a Greenwood-like variance formula
                # Accumulate variance: var_sum += d_i / n_i^2
                if n_risk > 0 and n_event > 0:
                    var_sum += n_event / (n_risk ** 2)
                    se = float(np.sqrt(var_sum))
                elif var_sum > 0:
                    # No events at this time, but carry forward previous variance
                    se = float(np.sqrt(var_sum))
                else:
                    se = 0.0

                # Hazard rate at this time point (incremental)
                hazard_increment = n_event / n_risk if n_risk > 0 else 0

                hazard_table.append({
                    "time": format_number(t),
                    "at_risk": n_risk,
                    "events": n_event,
                    "censored": n_censor,
                    "hazard_increment": format_number(hazard_increment),
                    "cumulative_hazard": format_number(cum_haz),
                    "std_error": format_number(se),
                    "ci_lower_95": format_number(ci_low),
                    "ci_upper_95": format_number(ci_up)
                })

            # ================================================================
            # SUMMARY STATISTICS FOR CUMULATIVE HAZARD
            # ================================================================
            final_hazard = float(hazard_df.iloc[-1, 0]) if len(hazard_df) > 0 else None
            max_time = float(hazard_df.index[-1]) if len(hazard_df) > 0 else None

            # Mean cumulative hazard (area under hazard curve)
            try:
                times_arr = np.array(hazard_df.index)
                hazard_arr = np.array(hazard_df.iloc[:, 0])
                mean_cum_hazard = _safe_trapz(hazard_arr, times_arr) / max_time if max_time > 0 else None
            except:
                mean_cum_hazard = None

            result_dict = {
                "hazard_table": hazard_table,
                "fixed_time_estimates": fixed_time_estimates,
                "summary": {
                    "final_cumulative_hazard": format_number(final_hazard),
                    "max_time": format_number(max_time),
                    "mean_hazard_rate": format_number(mean_cum_hazard),
                    "n_distinct_times": len(times),
                    "variance_method": "Greenwood-type estimator"
                }
            }

            # ================================================================
            # SMOOTHED HAZARD RATE (Epanechnikov kernel)
            # ================================================================
            try:
                timeline = np.array(hazard_df.index, dtype=float)
                if len(timeline) > 1:
                    diffs = np.diff(np.unique(timeline))
                    median_diff = float(np.median(diffs)) if len(diffs) > 0 else None
                else:
                    median_diff = None

                default_bw = (max_time_data - float(timeline.min())) / 10 if len(timeline) > 0 else 1.0
                bw = hazard_bandwidth if hazard_bandwidth is not None else (median_diff or default_bw)
                if bw is None or not np.isfinite(bw) or bw <= 0:
                    bw = 1.0

                smooth_df = naf.smoothed_hazard_(bw)
                smooth_ci = naf.smoothed_hazard_confidence_intervals_(bw, smooth_df.values[:, 0])

                result_dict["smoothed_hazard"] = {
                    "bandwidth": float(bw),
                    "time": smooth_df.index.astype(float).tolist(),
                    "hazard": smooth_df.iloc[:, 0].astype(float).tolist(),
                    "ci_lower_95": smooth_ci.iloc[:, 0].astype(float).tolist(),
                    "ci_upper_95": smooth_ci.iloc[:, 1].astype(float).tolist(),
                }
            except Exception as smooth_error:
                result_dict["smoothed_hazard_error"] = str(smooth_error)

            # Add warning if time points were filtered out
            if filtered_times:
                result_dict["time_points_warning"] = f"Time points {sorted(filtered_times)} exceed max observed time ({format_number(max_time_data)}) and were excluded"

            return result_dict

        if group_col and group_col in df_clean.columns:
            # ================================================================
            # STRATIFIED ANALYSIS
            # ================================================================
            groups = sorted(df_clean[group_col].unique(), key=str)
            strata_results = []
            reference_group_value = _resolve_reference_value(reference_levels, group_col)
            if reference_group_value is not None:
                result["reference_group"] = str(reference_group_value)

            for group in groups:
                mask = df_clean[group_col] == group
                group_data = df_clean[mask]
                label_info = _build_stratum_labels(group, group_col, reference_levels)

                naf = NelsonAalenFitter()
                naf.fit(group_data[time_col], group_data[event_col], label=str(group))

                detailed_results = get_detailed_na_results(
                    naf,
                    group_data,
                    time_col,
                    event_col,
                    str(group),
                    custom_time_points,
                    params.get("hazard_bandwidth")
                )

                strata_results.append({
                    "stratum": label_info["raw"],
                    "display_label": label_info["display"],
                    "is_reference": label_info["is_reference"],
                    "n_total": int(len(group_data)),
                    "n_events": int(group_data[event_col].sum()),
                    "n_censored": int(len(group_data) - group_data[event_col].sum()),
                    "percent_censored": format_number((len(group_data) - group_data[event_col].sum()) / len(group_data) * 100),
                    **detailed_results
                })

            result["strata"] = strata_results
            result["stratification_variable"] = group_col
            result["n_strata"] = len(groups)

            # Log-rank test for comparing cumulative hazard curves
            if len(groups) >= 2:
                if len(groups) == 2:
                    g1, g2 = groups
                    mask1 = df_clean[group_col] == g1
                    mask2 = df_clean[group_col] == g2

                    lr_result = logrank_test(
                        df_clean[mask1][time_col], df_clean[mask2][time_col],
                        df_clean[mask1][event_col], df_clean[mask2][event_col]
                    )
                    df_test = 1
                else:
                    lr_result = multivariate_logrank_test(
                        df_clean[time_col], df_clean[group_col], df_clean[event_col]
                    )
                    df_test = len(groups) - 1

                result["homogeneity_test"] = {
                    "test_name": "Log-Rank (for comparing hazard functions)",
                    "chi_square": format_number(lr_result.test_statistic),
                    "df": df_test,
                    "p_value": format_number(lr_result.p_value),
                    "significant": bool(lr_result.p_value < 0.05)
                }

        else:
            # ================================================================
            # SINGLE GROUP (OVERALL) ANALYSIS
            # ================================================================
            naf = NelsonAalenFitter()
            naf.fit(df_clean[time_col], df_clean[event_col], label="Overall")

            detailed_results = get_detailed_na_results(
                naf,
                df_clean,
                time_col,
                event_col,
                "Overall",
                custom_time_points,
                params.get("hazard_bandwidth")
            )
            result.update(detailed_results)

        # ================================================================
        # SUMMARY STATISTICS
        # ================================================================
        result["time_variable"] = time_col
        result["event_variable"] = event_col
        result["time_unit"] = time_unit
        result["min_time"] = format_number(df_clean[time_col].min())
        result["max_time"] = format_number(df_clean[time_col].max())

        # Interpretation note
        result["interpretation"] = {
            "note": "The Nelson-Aalen estimator provides cumulative hazard H(t), related to survival by S(t) = exp(-H(t))",
            "hazard_rate": "Instantaneous risk of event at time t, given survival to t"
        }

        # Add warnings
        warnings = []
        if censoring_rate > 80:
            warnings.append(f"High censoring rate ({censoring_rate:.1f}%). Hazard estimates may be unreliable at later times.")
        if n_events < 10:
            warnings.append(f"Low number of events ({n_events}). Consider increasing sample size for stable estimates.")
        if n_events < 5:
            warnings.append("Very few events. Cumulative hazard estimates may be unstable.")

        if warnings:
            result["warnings"] = warnings

        # Add event encoding labels
        result["event_labels"] = {
            "event": event_label,
            "censored": censored_label,
            "was_encoded": was_encoded
        }

        # Echo back custom time points if provided (for display in results tables)
        if custom_time_points:
            result["custom_time_points"] = custom_time_points

        return json.dumps(make_json_safe(result))

    except Exception as e:
        import traceback
        return json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()})


# ============================================================================
# ARRAY-BASED WRAPPERS FOR LARGE DATASET MODE
# ============================================================================
# These thin wrappers accept arrays directly (instead of building huge JSON payloads)
# They build DataFrames internally and call the validated JSON-based functions above.
# Added: 2025-12-24 for Tauri large dataset support
# ============================================================================

def kaplan_meier_from_arrays(
    times: List[float],
    events: List[int],
    groups: Optional[List[str]] = None,
    alpha: float = 0.05,
    time_name: str = "Time",
    event_name: str = "Event",
    group_name: Optional[str] = None,
    event_encoding: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Array-based wrapper for Kaplan-Meier analysis.
    Builds DataFrame internally and calls validated kaplan_meier_analysis().

    Args:
        times: List of survival/follow-up times
        events: List of event indicators (1=event, 0=censored)
        groups: Optional list of group labels for stratification
        alpha: Significance level (default 0.05)
        time_name: Column name for time variable (for output labels)
        event_name: Column name for event variable (for output labels)
        group_name: Column name for group variable (for output labels)

    Returns:
        Dictionary with analysis results (same as kaplan_meier_analysis)
    """
    # Build DataFrame
    data = {time_name: times, event_name: events}
    if groups is not None and group_name is not None:
        data[group_name] = groups

    df = pd.DataFrame(data)

    # Build JSON payload for validated function
    payload = {
        "data": df.to_dict(orient='records'),
        "time_column": time_name,
        "event_column": event_name,
        "group_column": group_name if groups is not None else None,
        "reference_levels": {},
        "event_encoding": event_encoding or {
            "event_value": "1",
            "censored_value": "0",
            "was_encoded": False
        }
    }

    # Call validated function
    result_json = kaplan_meier_analysis(json.dumps(payload))
    return json.loads(result_json)


def cox_from_arrays(
    times: List[float],
    events: List[int],
    covariates: Dict[str, List[float]],
    alpha: float = 0.05,
    time_name: str = "Time",
    event_name: str = "Event",
    event_encoding: Optional[Dict[str, Any]] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
) -> Dict[str, Any]:
    """
    Array-based wrapper for Cox regression.
    Builds DataFrame internally and calls validated cox_proportional_hazards().

    Args:
        times: List of survival/follow-up times
        events: List of event indicators (1=event, 0=censored)
        covariates: Dictionary of covariate arrays {name: [values]}
        alpha: Significance level (default 0.05)
        time_name: Column name for time variable
        event_name: Column name for event variable

    Returns:
        Dictionary with analysis results (same as cox_proportional_hazards)
    """
    # Build DataFrame
    data = {time_name: times, event_name: events}
    data.update(covariates)

    df = pd.DataFrame(data)

    # Build JSON payload
    payload = {
        "data": df.to_dict(orient='records'),
        "time_column": time_name,
        "event_column": event_name,
        "covariate_columns": list(covariates.keys()),
        "reference_levels": {},
        "event_encoding": event_encoding or {
            "event_value": "1",
            "censored_value": "0",
            "was_encoded": False
        }
    }

    # Call validated function
    result_json = cox_proportional_hazards(
        json.dumps(payload),
        progress_callback=progress_callback
    )
    return json.loads(result_json)


def nelson_aalen_from_arrays(
    times: List[float],
    events: List[int],
    groups: Optional[List[str]] = None,
    custom_time_points: Optional[List[float]] = None,
    alpha: float = 0.05,
    time_name: str = "Time",
    event_name: str = "Event",
    group_name: Optional[str] = None,
    event_encoding: Optional[Dict[str, Any]] = None,
    hazard_bandwidth: Optional[float] = None
) -> Dict[str, Any]:
    """
    Array-based wrapper for Nelson-Aalen analysis.
    Builds DataFrame internally and calls validated nelson_aalen_analysis().

    Args:
        times: List of survival/follow-up times
        events: List of event indicators (1=event, 0=censored)
        groups: Optional list of group labels for stratification
        custom_time_points: Optional fixed time points for estimates
        alpha: Significance level (default 0.05)
        time_name: Column name for time variable
        event_name: Column name for event variable
        group_name: Column name for group variable

    Returns:
        Dictionary with analysis results (same as nelson_aalen_analysis)
    """
    # Build DataFrame
    data = {time_name: times, event_name: events}
    if groups is not None and group_name is not None:
        data[group_name] = groups

    df = pd.DataFrame(data)

    # Build JSON payload
    payload = {
        "data": df.to_dict(orient='records'),
        "time_column": time_name,
        "event_column": event_name,
        "group_column": group_name if groups is not None else None,
        "custom_time_points": custom_time_points if custom_time_points else [],
        "hazard_bandwidth": hazard_bandwidth,
        "reference_levels": {},
        "event_encoding": event_encoding or {
            "event_value": "1",
            "censored_value": "0",
            "was_encoded": False
        }
    }

    # Call validated function
    result_json = nelson_aalen_analysis(json.dumps(payload))
    return json.loads(result_json)
