"""
Mediation Analysis Module (Model 4)

Implements simple mediation analysis using statsmodels.
Provides bootstrap confidence intervals for indirect effects.

VERSION: 1.1.0
DATE: December 5, 2025
CHANGES:
- v1.1.0: Added optional bootstrap for direct effect and proportion mediated (for validation)
- v1.0.1: Fixed CI calculation to use t-distribution from model.conf_int()
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
    Fits a logistic regression and returns the model if convergence succeeded.
    Returns None when perfect separation or non-convergence is detected.
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


def _normalize_binary_vector(values):
    """
    Ensure binary vectors are encoded as 0/1.
    Returns (normalized_array, mapping_dict). Mapping empty if not binary.
    """
    unique = np.unique(values)
    unique = unique[~np.isnan(unique)]
    if unique.size != 2:
        return values, {}

    unique.sort()
    low, high = unique[0], unique[1]
    mapping = {float(low): 0, float(high): 1}
    normalized = np.where(np.isclose(values, high), 1.0, 0.0)
    return normalized, mapping


def mediation_analysis(data_json: str) -> str:
    """
    Perform Model 4 mediation analysis using statsmodels.

    Provides:
    - OLS/Logit regression for path coefficients
    - Bootstrap percentile CI for indirect effect
    - Sobel test for normal-theory inference

    Parameters (in JSON):
    - outcome_data: List of Y values
    - predictor_data: List of X values
    - mediator_data: List of M values
    - outcome_name: Name of Y variable
    - predictor_name: Name of X variable
    - mediator_name: Name of M variable
    - control_data: Optional list of covariate arrays
    - control_names: Optional list of covariate names
    - n_boot: Number of bootstrap samples (default 5000)
    - confidence: Confidence level (default 0.95)
    - logit: True for binary outcome (uses Logit instead of OLS)
    - seed: Random seed for reproducibility
    - categorical_encodings: Dict of baseline encodings
    - bootstrap_direct_effect: True to bootstrap direct effect (c') CIs (default False)
    - bootstrap_prop_mediated: True to bootstrap proportion mediated CIs (default False)

    Returns: JSON with comprehensive mediation results
    """
    try:
        params = json.loads(data_json)

        # Extract data
        Y = np.array(params['outcome_data'], dtype=float)
        X = np.array(params['predictor_data'], dtype=float)
        M = np.array(params['mediator_data'], dtype=float)

        n_boot = params.get('n_boot', 5000)
        confidence = params.get('confidence', 0.95)
        use_logit = params.get('logit', False)
        logit_requested = bool(use_logit)
        logit_fallback_used = False
        seed = params.get('seed', None)
        bootstrap_direct_effect = params.get('bootstrap_direct_effect', False)
        bootstrap_prop_mediated = params.get('bootstrap_prop_mediated', False)

        # DEBUG: Log what we received
        print(f"[MEDIATION DEBUG] bootstrap_direct_effect={bootstrap_direct_effect}, bootstrap_prop_mediated={bootstrap_prop_mediated}")

        if seed is not None:
            np.random.seed(seed)

        # Handle covariates
        covariates = None
        covariate_names = []
        if 'control_data' in params and params['control_data']:
            covariates = np.column_stack([np.array(c, dtype=float) for c in params['control_data']])
            covariate_names = params.get('control_names', [f'Covariate_{i}' for i in range(covariates.shape[1])])

        # Listwise deletion for missing data
        mask = ~(np.isnan(Y) | np.isnan(X) | np.isnan(M))
        if covariates is not None:
            mask &= ~np.any(np.isnan(covariates), axis=1)

        n_deleted = int(np.sum(~mask))
        Y, X, M = Y[mask], X[mask], M[mask]
        if covariates is not None:
            covariates = covariates[mask]

        # Detect binary mediator for optional logistic modeling
        mediator_mapping = {}
        mediator_logit_requested = False
        mediator_logit_used = False
        mediator_logit_fallback = False
        M, mediator_mapping = _normalize_binary_vector(M)
        if mediator_mapping:
            mediator_logit_requested = True

        n = len(Y)

        if n < 20:
            return json.dumps({
                "success": False,
                "error": f"Insufficient sample size after listwise deletion (N={n}). Minimum required: 20."
            })

        # Normalize binary outcome for logistic regression
        if use_logit:
            unique_outcomes = np.unique(Y[~np.isnan(Y)])
            if unique_outcomes.size != 2:
                return json.dumps({
                    "success": False,
                    "error": f"Binary outcome required for logistic mediation: found {unique_outcomes.size} distinct values."
                })

            unique_outcomes.sort()
            lower, upper = unique_outcomes[0], unique_outcomes[1]
            if not (np.isclose(lower, 0.0) and np.isclose(upper, 1.0)):
                Y = np.where(np.isclose(Y, upper), 1.0, 0.0)

        # ===== Path a: X → M =====
        if covariates is not None:
            X_a = sm.add_constant(np.column_stack([X, covariates]))
            exog_names_a = ['const', params.get('predictor_name', 'X')] + covariate_names
        else:
            X_a = sm.add_constant(X)
            exog_names_a = ['const', params.get('predictor_name', 'X')]

        if mediator_logit_requested:
            model_m = _fit_logistic_model(M, X_a)
            if model_m is None:
                mediator_logit_fallback = True
                model_m = sm.OLS(M, X_a).fit()
            else:
                mediator_logit_used = True
        else:
            model_m = sm.OLS(M, X_a).fit()
        a = model_m.params[1]  # X coefficient
        a_se = model_m.bse[1]
        a_t = model_m.tvalues[1]
        a_p = model_m.pvalues[1]

        # ===== Path b and c': X + M → Y =====
        if covariates is not None:
            X_y = sm.add_constant(np.column_stack([X, M, covariates]))
            exog_names_y = ['const', params.get('predictor_name', 'X'), params.get('mediator_name', 'M')] + covariate_names
        else:
            X_y = sm.add_constant(np.column_stack([X, M]))
            exog_names_y = ['const', params.get('predictor_name', 'X'), params.get('mediator_name', 'M')]

        if use_logit:
            model_y = _fit_logistic_model(Y, X_y)
            if model_y is None:
                logit_fallback_used = True
                use_logit = False
                model_y = sm.OLS(Y, X_y).fit()
        else:
            model_y = sm.OLS(Y, X_y).fit()

        c_prime = model_y.params[1]  # Direct effect (X → Y)
        b = model_y.params[2]  # M → Y

        c_prime_se = model_y.bse[1]
        c_prime_t = model_y.tvalues[1]
        c_prime_p = model_y.pvalues[1]
        # Use model's conf_int for proper t-distribution CIs
        c_prime_ci = model_y.conf_int(alpha=1-confidence)[1]
        c_prime_ci_lower = c_prime_ci[0]
        c_prime_ci_upper = c_prime_ci[1]

        b_se = model_y.bse[2]
        b_t = model_y.tvalues[2]
        b_p = model_y.pvalues[2]

        # ===== Indirect effect =====
        indirect = a * b

        # ===== Bootstrap CI for indirect effect =====
        boot_indirect = []
        boot_direct = [] if bootstrap_direct_effect else None
        # Allow proportion mediated bootstrap even with logistic models (baseline convention)
        # if use_logit or mediator_logit_used:
        #     bootstrap_prop_mediated = False
        boot_prop = [] if bootstrap_prop_mediated else None
        boot_total = [] if bootstrap_prop_mediated else None
        discarded = 0

        for _ in range(n_boot):
            idx = np.random.choice(n, n, replace=True)
            Y_b, X_b, M_b = Y[idx], X[idx], M[idx]
            cov_b = covariates[idx] if covariates is not None else None

            try:
                # Path a
                if cov_b is not None:
                    X_a_b = sm.add_constant(np.column_stack([X_b, cov_b]))
                else:
                    X_a_b = sm.add_constant(X_b)
                if mediator_logit_used:
                    model_m_b = _fit_logistic_model(M_b, X_a_b)
                    if model_m_b is None:
                        discarded += 1
                        continue
                    a_b = model_m_b.params[1]
                else:
                    a_b = sm.OLS(M_b, X_a_b).fit().params[1]

                # Path b and c' (direct effect)
                if cov_b is not None:
                    X_y_b = sm.add_constant(np.column_stack([X_b, M_b, cov_b]))
                else:
                    X_y_b = sm.add_constant(np.column_stack([X_b, M_b]))

                if use_logit:
                    model_y_b = _fit_logistic_model(Y_b, X_y_b)
                    if model_y_b is None:
                        discarded += 1
                        continue
                    b_b = model_y_b.params[2]
                    c_prime_b = model_y_b.params[1]
                else:
                    model_y_b = sm.OLS(Y_b, X_y_b).fit()
                    b_b = model_y_b.params[2]
                    c_prime_b = model_y_b.params[1]

                if not np.isfinite(a_b) or not np.isfinite(b_b) or not np.isfinite(c_prime_b):
                    discarded += 1
                    continue

                indirect_b = a_b * b_b
                boot_indirect.append(indirect_b)

                # Collect direct effect if requested
                if bootstrap_direct_effect:
                    boot_direct.append(c_prime_b)

                # Collect proportion mediated if requested
                if bootstrap_prop_mediated:
                    # Need total effect for proportion
                    if cov_b is not None:
                        X_total_b = sm.add_constant(np.column_stack([X_b, cov_b]))
                    else:
                        X_total_b = sm.add_constant(X_b)

                    if use_logit:
                        model_total_b = _fit_logistic_model(Y_b, X_total_b)
                        if model_total_b is None:
                            # Keep indirect/direct samples, but mark prop as missing
                            boot_prop.append(np.nan)
                            continue
                        total_b = model_total_b.params[1]
                    else:
                        total_b = sm.OLS(Y_b, X_total_b).fit().params[1]

                    boot_total.append(total_b)
                    # Proportion = indirect / total (avoid division by zero)
                    if abs(total_b) > 1e-8:
                        boot_prop.append(indirect_b / total_b)
                    else:
                        # Keep indirect/direct samples, but mark prop as missing
                        boot_prop.append(np.nan)
                        continue

            except:
                discarded += 1
                continue

        boot_indirect = np.array(boot_indirect)
        if boot_indirect.size == 0:
            return json.dumps({
                "success": False,
                "error": "Bootstrap failed: all resamples encountered convergence issues in mediation analysis."
            })
        alpha = 1 - confidence
        boot_ci_lower = np.percentile(boot_indirect, 100 * alpha / 2)
        boot_ci_upper = np.percentile(boot_indirect, 100 * (1 - alpha / 2))
        boot_se = np.std(boot_indirect)

        # ===== Bootstrap summaries for direct effect and proportion mediated (optional) =====
        direct_boot_ci_lower = None
        direct_boot_ci_upper = None
        direct_boot_p = None
        prop_boot_ci_lower = None
        prop_boot_ci_upper = None

        if bootstrap_direct_effect and boot_direct:
            print(f"[MEDIATION DEBUG] boot_direct before filtering: {len(boot_direct)} samples")
            boot_direct = np.array([v for v in boot_direct if not np.isnan(v)])
            print(f"[MEDIATION DEBUG] boot_direct after filtering NaNs: {boot_direct.size} samples")
            if boot_direct.size > 0:
                direct_boot_ci_lower = float(np.percentile(boot_direct, 100 * alpha / 2))
                direct_boot_ci_upper = float(np.percentile(boot_direct, 100 * (1 - alpha / 2)))
                # Bootstrap p-value: two-tailed test (proportion of samples on opposite side of zero)
                if c_prime > 0:
                    direct_boot_p = float(2 * np.mean(boot_direct <= 0))
                elif c_prime < 0:
                    direct_boot_p = float(2 * np.mean(boot_direct >= 0))
                else:
                    direct_boot_p = 1.0
                direct_boot_p = min(direct_boot_p, 1.0)

        if bootstrap_prop_mediated and boot_prop is not None:
            boot_prop = np.array([p for p in boot_prop if not np.isnan(p)])
            if boot_prop.size == 0 and boot_total is not None and len(boot_total) > 0:
                boot_total_arr = np.array(boot_total)
                valid_mask = np.isfinite(boot_total_arr) & (np.abs(boot_total_arr) > 1e-12)
                if np.any(valid_mask):
                    boot_prop = boot_indirect[valid_mask] / boot_total_arr[valid_mask]

            if boot_prop.size > 0:
                prop_boot_ci_lower = float(np.percentile(boot_prop, 100 * alpha / 2))
                prop_boot_ci_upper = float(np.percentile(boot_prop, 100 * (1 - alpha / 2)))

        # ===== Total effect =====
        if covariates is not None:
            X_total = sm.add_constant(np.column_stack([X, covariates]))
        else:
            X_total = sm.add_constant(X)

        if use_logit:
            model_total = _fit_logistic_model(Y, X_total)
            if model_total is None:
                logit_fallback_used = True
                use_logit = False
                model_total = sm.OLS(Y, X_total).fit()
        else:
            model_total = sm.OLS(Y, X_total).fit()

        c_total = model_total.params[1]
        c_total_se = model_total.bse[1]
        c_total_t = model_total.tvalues[1]
        c_total_p = model_total.pvalues[1]
        # Use model's conf_int for proper t-distribution CIs
        c_total_ci = model_total.conf_int(alpha=1-confidence)[1]
        c_total_ci_lower = c_total_ci[0]
        c_total_ci_upper = c_total_ci[1]

        # ===== Sobel test =====
        sobel_se = np.sqrt(a**2 * b_se**2 + b**2 * a_se**2)
        sobel_z = indirect / sobel_se if sobel_se > 0 else 0
        sobel_p = 2 * (1 - stats.norm.cdf(abs(sobel_z)))

        # ===== Effect proportions =====
        prop_mediated = np.nan
        if not use_logit and not mediator_logit_used and abs(c_total) > 1e-10:
            prop_mediated = indirect / c_total

        # ===== Build coefficient tables =====
        def extract_coefficients(model, names):
            coeffs = []
            conf_int = model.conf_int()
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
            return coeffs

        # Build warnings
        warnings = []
        if n < 50:
            warnings.append(f"Small sample size (N={n}). Bootstrap estimates may be unstable. Recommend N >= 50.")
        if discarded > n_boot * 0.05:
            warnings.append(f"{discarded} bootstrap samples ({discarded/n_boot*100:.1f}%) discarded due to convergence issues.")
        if c_total_p > 0.05 and not (boot_ci_lower <= 0 <= boot_ci_upper):
            warnings.append("Total effect non-significant but indirect effect is. May indicate inconsistent mediation or suppression.")
        if mediator_logit_fallback:
            warnings.append(
                "Binary mediator detected but logistic regression failed to converge; "
                "results shown using a linear probability model for the mediator path.")
        elif mediator_logit_used:
            warnings.append(
                "Binary mediator modeled with logistic regression; path a is on the log-odds scale.")
        if logit_fallback_used:
            warnings.append(
                "Binary logistic regression failed to converge due to perfect separation; "
                "results shown using a linear probability model instead.")
        elif logit_requested and use_logit:
            warnings.append(
                "Effect proportions are not reported for binary outcomes (logit link). "
                "Interpret indirect effects on the log-odds scale.")
        if mediator_logit_used:
            warnings.append(
                "Effect proportions are not reported when the mediator is binary (logit link).")

        mediator_model_type = "logistic" if mediator_logit_used else "ols"
        mediator_r2 = float(getattr(model_m, "prsquared", model_m.rsquared)) if mediator_logit_used else float(model_m.rsquared)
        mediator_adj_r2 = float(model_m.rsquared_adj) if hasattr(model_m, "rsquared_adj") else None
        mediator_f = float(model_m.fvalue) if hasattr(model_m, "fvalue") else None
        mediator_fp = float(model_m.f_pvalue) if hasattr(model_m, "f_pvalue") else None
        mediator_mse = float(model_m.mse_resid) if hasattr(model_m, "mse_resid") else None
        mediator_df1 = int(model_m.df_model) if hasattr(model_m, "df_model") else None
        mediator_df2 = int(model_m.df_resid) if hasattr(model_m, "df_resid") else None

        # Build result
        result = {
            "success": True,
            "test_type": "Mediation Analysis (Model 4)",
            "model_info": {
                "model_number": 4,
                "outcome": params.get('outcome_name', 'Y'),
                "predictor": params.get('predictor_name', 'X'),
                "mediators": [params.get('mediator_name', 'M')],
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
                params.get('mediator_name', 'M'): {
                    "model_type": mediator_model_type,
                    "r_squared": mediator_r2,
                    "adj_r_squared": mediator_adj_r2,
                    "f_statistic": mediator_f,
                    "f_p_value": mediator_fp,
                    "mse": mediator_mse,
                    "df1": mediator_df1,
                    "df2": mediator_df2,
                    "coefficients": extract_coefficients(model_m, exog_names_a)
                },
                params.get('outcome_name', 'Y'): {
                    "model_type": "logistic" if use_logit else "ols",
                    "r_squared": float(getattr(model_y, 'prsquared', model_y.rsquared)) if hasattr(model_y, 'rsquared') else None,
                    "adj_r_squared": float(model_y.rsquared_adj) if hasattr(model_y, 'rsquared_adj') else None,
                    "f_statistic": float(model_y.fvalue) if hasattr(model_y, 'fvalue') else None,
                    "f_p_value": float(model_y.f_pvalue) if hasattr(model_y, 'f_pvalue') else None,
                    "mse": float(model_y.mse_resid) if hasattr(model_y, 'mse_resid') else None,
                    "coefficients": extract_coefficients(model_y, exog_names_y)
                }
            },
            "effects": {
                "direct": {
                    "effect": float(c_prime),
                    "se": float(c_prime_se),
                    "t": float(c_prime_t),
                    "p": float(c_prime_p),
                    "ci_lower": float(c_prime_ci_lower),
                    "ci_upper": float(c_prime_ci_upper),
                    "boot_ci_lower": direct_boot_ci_lower,
                    "boot_ci_upper": direct_boot_ci_upper,
                    "boot_p": direct_boot_p,
                    "significant": bool(c_prime_p < 0.05)
                },
                "indirect": [{
                    "mediator": params.get('mediator_name', 'M'),
                    "effect": float(indirect),
                    "boot_se": float(boot_se),
                    "boot_ci_lower": float(boot_ci_lower),
                    "boot_ci_upper": float(boot_ci_upper),
                    "significant": bool(not (boot_ci_lower <= 0 <= boot_ci_upper))
                }],
                "total": {
                    "effect": float(c_total),
                    "se": float(c_total_se),
                    "t": float(c_total_t),
                    "p": float(c_total_p),
                    "ci_lower": float(c_total_ci_lower),
                    "ci_upper": float(c_total_ci_upper),
                    "significant": bool(c_total_p < 0.05)
                }
            },
            "proportions": {
                "indirect_over_total": float(prop_mediated) if not np.isnan(prop_mediated) else None,
                "direct_over_total": float(1 - prop_mediated) if not np.isnan(prop_mediated) else None,
                "percent_mediated": float(prop_mediated * 100) if not np.isnan(prop_mediated) else None,
                "boot_ci_lower": prop_boot_ci_lower,
                "boot_ci_upper": prop_boot_ci_upper
            },
            "sobel_test": {
                "effect": float(indirect),
                "se": float(sobel_se),
                "z": float(sobel_z),
                "p": float(sobel_p)
            },
            "warnings": warnings,
            "categorical_encodings": params.get('categorical_encodings', {})
        }

        return json.dumps(result)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        })
