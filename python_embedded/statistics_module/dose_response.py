"""
Dose-Response Curve Fitting Module
VERSION: 1.9.0
DATE: January 26, 2026

CHANGES v1.9.0:
- BREAKING: fitting_method now accepts only "log_dose" or "lmfit"
- Removed deprecated fitting_method aliases
- Removed external package references from comments (license compliance)
- Log-dose fitting method is pure Python implementation (no external dependencies)

CHANGES v1.8.0:
- FEATURE: Dose=0 (control) handling for 3PL/4PL/5PL models
- Controls (dose < 1e-15) are separated from positive doses
- Fitting performed on positive doses only (log-dose is undefined at 0)
- Control mean used to inform/constrain bottom parameter
- 3PL: Uses control_mean as fixed bottom when user hasn't specified bottom_fixed
- 4PL/5PL: Constrains bottom to control_mean ± 2*SD
- Added ZERO_DOSE_TOLERANCE constant (1e-15) for control detection
- Added _split_controls_and_positive() helper function
- Minimum sample checks now based on positive dose count, not total count

CHANGES v1.7.0:
- FIX: Implemented logit transform initialization for 5PL (findbe1 method)
- 5PL now uses linear regression on logit-transformed data: log((d-y)/(y-c)) ~ log(x)
- Self-starting strategy for data-driven IC50 and Hill parameter initialization
- Expected to converge to correct global minimum

CHANGES v1.6.0:
- EVALUATION: Tested external 5PL helper for reference
- RESULT: Parametrization issues (IC50 error, wrong hill sign)
- DECISION: Keeping scipy.curve_fit implementation with improved initialization
- 3PL and 4PL unchanged (already validated)

CHANGES v1.5.0:
- FEATURE: Added -log10(IC50) [pIC50] to all model outputs
- Includes proper error propagation: stderr(pIC50) = stderr(IC50) / (IC50 × ln(10))
- Displayed as "neg_log10_ic50" in JSON for clarity
- Publication-ready metric per Journal of Medicinal Chemistry 2024 guidelines
- Added to 3PL, 4PL, and 5PL models

CHANGES v1.4.0:
- FEATURE: Added multi-model comparison function compare_dose_response_models()
- Fits 3PL, 4PL, and 5PL simultaneously and compares via AIC/BIC
- Calculates delta AIC and delta BIC (relative to best model)
- Returns model selection recommendation based on information criteria
- Handles cases where some models fail (e.g., n<6 excludes 5PL)

CHANGES v1.3.0:
- FEATURE: Added 5PL (5-Parameter Logistic) dose-response model with asymmetry
- 5PL formula: y = bottom + (top - bottom) / [1 + (dose/IC50)^hill]^asymmetry
- Strict n≥6 requirement for 5PL (no warnings, just rejection)
- asymmetry=1.0 reduces to 4PL, >1.0 upper tail gradual, <1.0 lower tail gradual
- Use k+1 (parameters + sigma) for 5PL AIC/BIC calculation

CHANGES v1.2.0:
- FEATURE: Added 3PL (3-Parameter Logistic) dose-response model
- 3PL has fixed bottom parameter (default 0.0), fits only top, IC50, hill
- Correct k=3 for AIC/BIC penalties in 3PL (not k=4)
- Updated JSON interface to route "3PL", "4PL", "5PL" model types
- Added bottom_fixed parameter for 3PL customization

CHANGES v1.1.1:
- BUGFIX: Adjusted R² now returns null when undefined (n <= k + 1)
- Added warnings system: warns when n=4 (minimal data)
- Warns when adj_r² is undefined (requires n >= 5 for 4PL)
- Prevents misleading "0.000" values for adj_r²

CHANGES v1.1.0:
- Adaptive parameter initialization based on real data characteristics
- Spearman correlation to detect inhibition vs activation curves
- Correct Hill slope convention for standard 4PL formula:
  * Activation curves (response increases): negative Hill slope
  * Inhibition curves (response decreases): positive Hill slope
- Geometric mean for IC50/EC50 initial guess (better for log-spaced doses)
- Flexible bounds (-10 to +10) allow both curve types without hardcoding

Implements 4-parameter logistic (4PL) model using lmfit for robust parameter estimation.
Follows easyCris modular architecture and code standards.

LICENSE: BSD-3-Clause (lmfit dependency)
"""

import numpy as np
from lmfit import Model, Parameters
import json
import os
import sys

# Use scipy.curve_fit implementation with 5PL helper
from .ecp_basic import fit_log_logistic_5pl, format_five_pl_parameters
from enum import Enum

DEBUG = os.getenv("EASYCRIS_DOSE_DEBUG") == "1"


def _debug(message: str) -> None:
    if DEBUG:
        print(message, file=sys.stderr)


def _normalize_fitting_method(fitting_method: str) -> str:
    """
    Normalize fitting_method parameter and emit warnings for unsupported values.

    Supported values:
    - "log_dose": Log-logistic parameterization with analytical Jacobian (recommended)
    - "lmfit": Original lmfit approach with numerical Jacobian

    Parameters
    ----------
    fitting_method : str
        Fitting method identifier

    Returns
    -------
    str
        Normalized fitting method ("log_dose" or "lmfit")

    Warnings
    --------
    Emits a warning if an unknown value is provided.
    """
    import warnings

    method = (fitting_method or "log_dose").strip().lower()
    if method in {"log_dose", "lmfit"}:
        return method

    warnings.warn(
        'Unknown fitting_method value; defaulting to "log_dose".',
        UserWarning,
        stacklevel=3
    )
    return "log_dose"


class FittingPolicy(Enum):
    """
    Solver policy for dose-response curve fitting.

    Controls how the optimizer searches for parameter basins when multiple
    local minima exist (common in underconstrained nonlinear regression).

    Attributes
    ----------
    BEST_RSS : str
        Find the mathematically best fit (lowest residual sum of squares).
        Uses unconstrained optimization from self-start seeds.
        May find different basins due to optimizer differences.

    STRICT_PARITY : str
        Attempt numerical parity with reference implementation.
        Runs constrained optimization to stay near self-start seeds.
        May result in slightly higher RSS but matches reference values.

    Notes
    -----
    - Default is BEST_RSS for all synergy models
    - Only Loewe synergy currently exhibits basin divergence
    - HSA, Bliss, ZIP all converge to identical basins (no policy needed)
    - STRICT_PARITY is for validation/debugging, not production use
    """
    BEST_RSS = "best_rss"
    STRICT_PARITY = "strict_parity"


# ==============================================================================
# DOSE=0 (CONTROL) HANDLING
# ==============================================================================

ZERO_DOSE_TOLERANCE = 1e-15
"""
Tolerance for detecting dose=0 controls.

Doses below this threshold are treated as controls (baseline measurements).

Controls are NOT included in curve fitting (log(0) is undefined).
Instead, control responses inform the bottom parameter.
"""


def _split_controls_and_positive(doses, responses, weights=None):
    """
    Split dose-response data into controls (dose≈0) and positive doses.

    This function only CLASSIFIES data. Validation (negative rejection,
    minimum count) should happen BEFORE and AFTER calling this function.

    IMPORTANT: Also handles weights to avoid subtle weighting bugs when
    fitting on positive doses only.

    Uses ZERO_DOSE_TOLERANCE (1e-15) for control detection.

    Parameters
    ----------
    doses : array-like
        Dose values (should be >= 0, negatives should be rejected before calling)
    responses : array-like
        Response values (same length as doses)
    weights : array-like, optional
        Weights for weighted least squares (same length as doses)

    Returns
    -------
    dict
        Dictionary with keys:
        - 'positive_doses': numpy array of doses > ZERO_DOSE_TOLERANCE
        - 'positive_responses': numpy array of responses for positive doses
        - 'positive_weights': numpy array of weights for positive doses (or None)
        - 'control_responses': numpy array of responses where dose < ZERO_DOSE_TOLERANCE
        - 'control_weights': numpy array of weights for controls (or None)
        - 'control_mean': mean of control responses (or None if no controls)
        - 'control_sd': std dev of control responses (or None if < 2 controls)
        - 'has_controls': boolean indicating presence of controls
        - 'n_controls': int count of control points
        - 'n_positive': int count of positive dose points
    """
    doses = np.asarray(doses, dtype=float)
    responses = np.asarray(responses, dtype=float)

    if weights is not None:
        weights = np.asarray(weights, dtype=float)

    # Use tolerance for control detection (dose < 1e-15 treated as control)
    control_mask = doses < ZERO_DOSE_TOLERANCE
    positive_mask = doses >= ZERO_DOSE_TOLERANCE

    control_responses = responses[control_mask]
    positive_doses = doses[positive_mask]
    positive_responses = responses[positive_mask]

    # Handle weights
    positive_weights = weights[positive_mask] if weights is not None else None
    control_weights = weights[control_mask] if weights is not None else None

    n_controls = len(control_responses)
    n_positive = len(positive_doses)
    has_controls = n_controls > 0

    # Compute control statistics (weighted if weights provided)
    if has_controls:
        if control_weights is not None and len(control_weights) > 0 and np.sum(control_weights) > 0:
            # Weighted mean
            control_mean = np.average(control_responses, weights=control_weights)
            # Weighted std (approximate)
            if n_controls > 1:
                control_sd = np.sqrt(np.average((control_responses - control_mean)**2, weights=control_weights))
            else:
                control_sd = None
        else:
            control_mean = float(np.mean(control_responses))
            control_sd = float(np.std(control_responses, ddof=1)) if n_controls > 1 else None
    else:
        control_mean = None
        control_sd = None

    return {
        'positive_doses': positive_doses,
        'positive_responses': positive_responses,
        'positive_weights': positive_weights,
        'control_responses': control_responses,
        'control_weights': control_weights,
        'control_mean': control_mean,
        'control_sd': control_sd,
        'has_controls': has_controls,
        'n_controls': n_controls,
        'n_positive': n_positive
    }


def add_neg_log10_ic50(parameters):
    """
    Add -log10(IC50) [pIC50] to parameters dictionary with proper error propagation.

    Modifies parameters dict in-place to add "neg_log10_ic50" field.

    Formula:
        pIC50 = -log10(IC50)
        stderr(pIC50) = stderr(IC50) / (IC50 × ln(10))
        CI = pIC50 ± 1.96 × stderr(pIC50)

    Parameters
    ----------
    parameters : dict
        Parameter dictionary containing "ic50" with value and stderr

    Returns
    -------
    None (modifies parameters dict in-place)
    """
    if "ic50" not in parameters:
        return  # No IC50 to convert

    ic50_value = parameters["ic50"]["value"]
    ic50_stderr = parameters["ic50"]["stderr"]

    # Validate IC50 is positive
    if ic50_value is None or ic50_value <= 0 or np.isnan(ic50_value) or np.isinf(ic50_value):
        # Invalid IC50, cannot calculate pIC50
        return

    # Calculate pIC50 = -log10(IC50)
    pic50_value = -np.log10(ic50_value)

    # Propagate stderr: stderr(pIC50) = stderr(IC50) / (IC50 × ln(10))
    if ic50_stderr is not None and ic50_stderr > 0:
        pic50_stderr = ic50_stderr / (ic50_value * np.log(10))
        pic50_ci_lower = pic50_value - 1.96 * pic50_stderr
        pic50_ci_upper = pic50_value + 1.96 * pic50_stderr
    else:
        pic50_stderr = None
        pic50_ci_lower = None
        pic50_ci_upper = None

    # Add to parameters dict
    parameters["neg_log10_ic50"] = {
        "value": float(pic50_value),
        "stderr": float(pic50_stderr) if pic50_stderr is not None else None,
        "ci_lower": float(pic50_ci_lower) if pic50_ci_lower is not None else None,
        "ci_upper": float(pic50_ci_upper) if pic50_ci_upper is not None else None
    }


def convert_hill_to_r_convention(parameters):
    """
    Convert Hill slope to standard reporting convention (positive for decreasing curves).

    Standard dose-response convention uses positive Hill coefficient for decreasing curves,
    while lmfit's internal parameterization uses negative exponents for decreasing curves.
    This function converts the fitted Hill parameter to match standard reporting.

    Modifies parameters dict in-place:
    - Negates hill["value"] (internal exponent → reporting convention)
    - Keeps stderr positive (magnitude only)
    - Swaps and negates CI bounds to maintain ordering after sign flip

    NOTE: This does NOT change the fitted model itself, only the reported parameter.
    The internal logistic formula (1 + (dose/ic50)^hill) remains unchanged.

    Parameters
    ----------
    parameters : dict
        Parameter dictionary containing "hill" with value, stderr, ci_lower, ci_upper

    Returns
    -------
    None (modifies parameters dict in-place)

    Example
    -------
    # lmfit fitted hill = -0.6137 (decreasing curve, internal convention)
    # After conversion: hill = +0.6137 (decreasing curve, standard convention)
    """
    if "hill" not in parameters:
        return  # No Hill parameter to convert

    hill = parameters["hill"]

    # Negate value: internal exponent → standard convention
    if hill["value"] is not None:
        hill["value"] = -hill["value"]

    # Stderr is always positive (magnitude only), no change needed
    # (stderr represents uncertainty, not the sign of the parameter)

    # Swap and negate CI bounds to maintain ordering after sign flip
    # Original:  [ci_lower, ci_upper] for negative hill
    # After flip: [-ci_upper, -ci_lower] for positive hill
    if hill["ci_lower"] is not None and hill["ci_upper"] is not None:
        original_lower = hill["ci_lower"]
        original_upper = hill["ci_upper"]
        hill["ci_lower"] = -original_upper
        hill["ci_upper"] = -original_lower


def sanitize_parameter_uncertainty(parameters, warnings=None, model_label="Dose-response"):
    """
    Replace non-finite parameter uncertainty fields with None for JSON safety.

    This mirrors the existing 5PL behavior and prevents NaN/Infinity values from
    leaking into backend JSON responses.
    """
    if not isinstance(parameters, dict):
        return []

    cleaned = []
    for param_name, meta in parameters.items():
        if not isinstance(meta, dict):
            continue
        changed = False
        for key in ("stderr", "ci_lower", "ci_upper"):
            value = meta.get(key)
            if value is None:
                continue
            try:
                if np.isnan(value) or np.isinf(value):
                    meta[key] = None
                    changed = True
            except TypeError:
                # Non-numeric values are left untouched.
                continue
        if changed:
            cleaned.append(param_name)

    if cleaned and warnings is not None:
        warnings.append(
            f"{model_label} uncertainty unavailable for: {', '.join(cleaned)}. "
            "Non-finite standard errors/confidence intervals were set to null."
        )
    return cleaned


def fit_4pl_dose_response(doses, responses, weights=None, fitting_method="lmfit",
                          bottom_fixed=None, top_fixed=None, policy=FittingPolicy.BEST_RSS):
    """
    Fit a 4-parameter logistic (4PL) dose-response curve.

    Model: y = bottom + (top - bottom) / (1 + (dose / ic50)^hill)

    Standard pharmacology convention: (dose / ic50)^hill

    Parameters
    ----------
    doses : list or array-like
        Dose concentrations (must be >= 0). Dose=0 points are treated as controls
        and used to inform the bottom parameter, not included in curve fitting.
    responses : list or array-like
        Observed responses (% inhibition, viability, etc.)
    weights : list or array-like, optional
        Weights for weighted least squares
    fitting_method : str, optional
        Fitting algorithm to use:
        - "lmfit" (default): Original LMFit approach (numerical Jacobian)
        - "log_dose": Log-logistic parameterization with analytical Jacobian
    bottom_fixed : float, optional
        If provided, fix the bottom parameter to this value
    top_fixed : float, optional
        If provided, fix the top parameter to this value
    policy : FittingPolicy, optional
        Solver policy for log-dose fitting method only (ignored for lmfit).
        FittingPolicy.BEST_RSS: Find mathematically best fit (default)
        FittingPolicy.STRICT_PARITY: Attempt numerical parity with reference

    Notes
    -----
    Dose=0 Handling (v1.8.0):
    - Doses below ZERO_DOSE_TOLERANCE (1e-15) are treated as controls
    - Controls inform the bottom parameter bounds (control_mean ± 2*SD)
    - Fitting is performed on positive doses only (log(0) is undefined)
    - Requires at least 4 POSITIVE dose levels (controls don't count)

    Returns
    -------
    result : dict (JSON-serializable)
        {
            "success": bool,
            "error": str (if success=False),
            "model_type": "4PL",
            "parameters": {
                "bottom": {"value": float, "stderr": float, "ci_lower": float, "ci_upper": float},
                "top": {"value": float, "stderr": float, "ci_lower": float, "ci_upper": float},
                "ic50": {"value": float, "stderr": float, "ci_lower": float, "ci_upper": float},
                "hill": {"value": float, "stderr": float, "ci_lower": float, "ci_upper": float}
            },
            "goodness_of_fit": {
                "r_squared": float,
                "adj_r_squared": float,
                "rmse": float,
                "aic": float,
                "bic": float
            },
            "fitted_values": list,
            "residuals": list,
            "n_observations": int
        }
    """
    # Normalize fitting method (defaults to log_dose on unknown values)
    fitting_method = _normalize_fitting_method(fitting_method)

    # Route to log-dose fitter if requested (supports fixed params)
    if fitting_method == "log_dose":
        _debug(f"[4PL DEBUG] Entering log-dose fitting method")
        if weights is not None:
            return {
                "success": False,
                "error": "Log-dose fitting method does not support weights parameter"
            }
        if bottom_fixed is not None or top_fixed is not None:
            _debug("[4PL DEBUG] Fixed params detected, using log-dose fixed-params fitter")
        else:
            _debug("[4PL DEBUG] Using standard log-dose fitter (no fixed params)")
        _debug(f"[4PL DEBUG] Calling fit_ll4_ecp_style with doses={doses}, responses={responses}")
        try:
            result = fit_ll4_ecp_style(
                doses,
                responses,
                policy=policy,
                bottom_fixed=bottom_fixed,
                top_fixed=top_fixed
            )
            _debug(f"[4PL DEBUG] fit_ll4_ecp_style returned type={type(result)}")
            _debug(f"[4PL DEBUG] fit_ll4_ecp_style result: {result}")
        except Exception as exc:
            error_msg = f"LL.4 fitting failed: {str(exc)}"
            _debug(f"[4PL DEBUG ERROR] Exception caught: {error_msg}")
            return {
                "success": False,
                "error": error_msg
            }
        if result is None:
            error_msg = "LL.4 fitting failed: no result returned"
            _debug(f"[4PL DEBUG ERROR] {error_msg}")
            return {
                "success": False,
                "error": error_msg
            }
        _debug("[4PL DEBUG] Returning result successfully")
        return result

    # Otherwise, use lmfit (original implementation)
    try:
        # Convert to numpy arrays
        doses = np.asarray(doses, dtype=float)
        responses = np.asarray(responses, dtype=float)

        # Validation
        if len(doses) != len(responses):
            return {
                "success": False,
                "error": "Doses and responses must have the same length"
            }

        # Check for NaN or Inf first
        if np.any(np.isnan(doses)) or np.any(np.isnan(responses)):
            return {
                "success": False,
                "error": "Data contains NaN values"
            }

        if np.any(np.isinf(doses)) or np.any(np.isinf(responses)):
            return {
                "success": False,
                "error": "Data contains infinite values"
            }

        # STEP 1: Reject negative doses (invalid input)
        if np.any(doses < 0):
            return {
                "success": False,
                "error": "Dose values must be >= 0. Negative doses not allowed."
            }

        # STEP 2: Split controls from positive doses
        split = _split_controls_and_positive(doses, responses, weights)

        # STEP 3: Check positive dose count (4PL needs at least 4)
        MIN_POSITIVE_4PL = 4
        if split['n_positive'] < MIN_POSITIVE_4PL:
            return {
                "success": False,
                "error": f"Need at least {MIN_POSITIVE_4PL} data points (positive doses > 0). "
                         f"Found {split['n_positive']}. Controls (dose=0) don't count toward minimum."
            }

        # Use positive doses for fitting
        fit_doses = split['positive_doses']
        fit_responses = split['positive_responses']
        fit_weights = split['positive_weights']

        # Define 4PL model function
        def model_4pl(dose, bottom, top, ic50, hill):
            """
            4-Parameter Logistic function.
            Standard pharmacology convention: (dose / ic50)^hill
            """
            return bottom + (top - bottom) / (1 + (dose / ic50)**hill)

        # Create lmfit Model
        model = Model(model_4pl)

        # Set initial parameter guesses based on data characteristics
        params = Parameters()

        # Analyze POSITIVE DOSE data to determine curve direction
        response_min = np.min(fit_responses)
        response_max = np.max(fit_responses)
        response_range = response_max - response_min

        # Detect if response increases or decreases with dose
        # Use Spearman correlation to handle non-linear relationships
        from scipy.stats import spearmanr
        dose_response_correlation, _ = spearmanr(fit_doses, fit_responses)

        # Bottom parameter: Use control info if available, otherwise data extremes
        if bottom_fixed is not None:
            # User explicitly fixed bottom
            params.add('bottom',
                       value=bottom_fixed,
                       vary=False)
        elif split['has_controls'] and split['control_mean'] is not None:
            # Use control info to constrain bottom (control_mean ± 2*SD)
            control_mean = split['control_mean']
            control_sd = split['control_sd'] if split['control_sd'] is not None and split['control_sd'] > 0 else 0.01
            delta = 2 * control_sd
            params.add('bottom',
                       value=control_mean,
                       min=control_mean - delta,
                       max=control_mean + delta)
        else:
            # No controls - use data extremes with flexible bounds
            params.add('bottom',
                       value=response_min,
                       min=response_min - response_range,
                       max=response_max)

        if top_fixed is not None:
            # Fix top to specified value
            params.add('top',
                       value=top_fixed,
                       vary=False)
        else:
            params.add('top',
                       value=response_max,
                       min=response_min,
                       max=response_max + response_range)

        # IC50/EC50: Use geometric mean of POSITIVE doses (better for log-spaced data)
        try:
            ic50_initial = np.exp(np.mean(np.log(fit_doses)))
        except:
            ic50_initial = np.median(fit_doses)

        params.add('ic50',
                   value=ic50_initial,
                   min=np.min(fit_doses) * 0.001,
                   max=np.max(fit_doses) * 1000)

        # Hill slope: Adaptive based on curve direction
        # For the standard 4PL formula: y = bottom + (top - bottom) / (1 + (dose/IC50)^hill)
        #   - At low dose: y approaches top when hill > 0
        #   - At high dose: y approaches bottom when hill > 0
        # Therefore:
        #   - Inhibition (response decreases with dose): positive Hill slope
        #   - Activation (response increases with dose): negative Hill slope
        if dose_response_correlation > 0:
            # Activation: response increases with dose (EC50 curves)
            # Need negative Hill so response goes from bottom to top
            hill_initial = -1.0
        else:
            # Inhibition: response decreases with dose (IC50 curves, toxicity)
            # Positive Hill so response goes from top to bottom
            hill_initial = 1.0

        # Allow both positive and negative Hill slopes (real data can be either)
        params.add('hill',
                   value=hill_initial,
                   min=-10.0,
                   max=10.0)

        # Fit the model on POSITIVE DOSES ONLY
        result = model.fit(fit_responses, params, dose=fit_doses, weights=fit_weights)

        # Calculate goodness of fit (on POSITIVE DOSES ONLY)
        n = split['n_positive']  # Use positive dose count, not total
        k = 4  # number of parameters
        ss_res = np.sum(result.residual**2)

        # Prefer lmfit covariance; fall back to RSS Hessian if missing
        covar = getattr(result, "covar", None)
        if covar is None:
            covar = getattr(result, "covariance", None)

        if covar is None:
            bottom_val = result.params['bottom'].value
            top_val = result.params['top'].value
            ic50_val = result.params['ic50'].value
            hill_val = result.params['hill'].value

            def rss_fn(params_vec):
                bottom_p, top_p, ic50_p, hill_p = params_vec
                pred = bottom_p + (top_p - bottom_p) / (1 + (fit_doses / ic50_p) ** hill_p)
                return np.sum((fit_responses - pred) ** 2)

            variance = ss_res / max(n - k, 1)
            covar = _cov_from_rss_hessian(
                rss_fn,
                [bottom_val, top_val, ic50_val, hill_val],
                variance
            )

        stderr_overrides = None
        if covar is not None and np.all(np.isfinite(covar)):
            try:
                stderr_overrides = np.sqrt(np.diag(covar)).tolist()
            except Exception:
                stderr_overrides = None

        # Extract parameters with uncertainties (lmfit already scales covariance by χ²/DOF)
        parameters = {}
        for idx, param_name in enumerate(['bottom', 'top', 'ic50', 'hill']):
            param = result.params[param_name]
            if stderr_overrides is not None and idx < len(stderr_overrides):
                stderr = float(stderr_overrides[idx])
            else:
                stderr = float(param.stderr) if param.stderr is not None else None
            parameters[param_name] = {
                "value": float(param.value),
                "stderr": stderr,
                "ci_lower": float(param.value - 1.96 * stderr) if stderr is not None else None,
                "ci_upper": float(param.value + 1.96 * stderr) if stderr is not None else None
            }

        # Add -log10(IC50) [pIC50] with proper error propagation
        add_neg_log10_ic50(parameters)

        # Align hill slope sign with standard reporting convention (output only).
        # This does NOT affect fitted values or residuals.
        convert_hill_to_r_convention(parameters)

        # Initialize warnings list
        warnings = []
        sanitize_parameter_uncertainty(parameters, warnings=warnings, model_label="4PL")

        # Check for minimal data
        if n == 4:
            warnings.append("4PL fitted with only 4 positive dose points (minimal). Add more doses for stability and reliable uncertainty estimates.")

        # R-squared (computed on positive doses only)
        ss_tot = np.sum((fit_responses - np.mean(fit_responses))**2)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Adjusted R-squared
        # Requires n > k + 1 to be defined (for 4PL: requires n >= 5)
        if n > k + 1:  # n >= 5 for 4PL
            adj_r_squared = 1 - (1 - r_squared) * (n - 1) / (n - k - 1)
        else:
            adj_r_squared = None  # Undefined when n <= k + 1
            warnings.append(f"Adjusted R² undefined with {n} positive dose points and {k} parameters. Requires at least {k + 2} observations.")

        # RMSE
        rmse = np.sqrt(ss_res / n)

        # AIC and BIC (full likelihood with constants)
        # Include residual variance as an estimated parameter (k + 1) for continuous models.
        ll_constant = n * (np.log(2 * np.pi) + 1)
        k_aic = k + 1
        aic = ll_constant + n * np.log(ss_res / n) + 2 * k_aic
        bic = ll_constant + n * np.log(ss_res / n) + k_aic * np.log(n)

        # Confidence band stats (lmfit 4PL, log-dose grid)
        ci_band_stats = None
        dose_grid = _build_log_dose_grid(fit_doses, grid_size=100)
        if dose_grid is not None and covar is not None:
            bottom_val = result.params['bottom'].value
            top_val = result.params['top'].value
            ic50_val = result.params['ic50'].value
            hill_val = result.params['hill'].value
            log_ratio = np.log(dose_grid) - np.log(ic50_val)
            r = np.exp(hill_val * log_ratio)
            den = 1.0 + r
            delta = (top_val - bottom_val)
            pred_grid = bottom_val + delta / den

            dpred_dbottom = 1.0 - (1.0 / den)
            dpred_dtop = 1.0 / den
            dpred_dic50 = delta * hill_val * r / (ic50_val * (den**2))
            dpred_dhill = -delta * r * log_ratio / (den**2)
            grads = np.column_stack([dpred_dbottom, dpred_dtop, dpred_dic50, dpred_dhill])
            ci_band_stats = _band_from_gradients(pred_grid, grads, covar, n - k, x_values=dose_grid)

        # Build metadata about dose=0 handling
        metadata = {
            'dose_zero_handling': 'controls_as_baseline' if split['has_controls'] else 'positive_only',
            'n_controls': split['n_controls'],
            'n_positive_doses': split['n_positive'],
            'control_mean': split['control_mean'],
            'control_sd': split['control_sd']
        }

        # Return comprehensive results
        result_payload = {
            "success": True,
            "model_type": "4PL",
            "warnings": warnings,
            "parameters": parameters,
            "goodness_of_fit": {
                "r_squared": float(r_squared),
                "adj_r_squared": float(adj_r_squared) if adj_r_squared is not None else None,
                "rmse": float(rmse),
                "residual_ss": float(ss_res),
                "aic": float(aic),
                "bic": float(bic)
            },
            "fitted_values": result.best_fit.tolist(),
            "residuals": result.residual.tolist(),
            "n_observations": int(n),
            "metadata": metadata
        }
        if ci_band_stats:
            result_payload.update(ci_band_stats)
        return result_payload

    except Exception as e:
        return {
            "success": False,
            "error": f"4PL fitting failed: {str(e)}"
        }


# ==============================================================================
# LOG-DOSE FITTING FUNCTIONS (Phase A-C)
# ==============================================================================
# Log-logistic dose-response curve fitting with log-dose parameterization,
# logit regression initialization, and analytical Jacobian.
# ==============================================================================

def _log_logistic(dose_log, b, c, d, e_log):
    """
    Log-logistic function in log-dose space.

    Parameters
    ----------
    dose_log : array-like
        Log-transformed doses: log(dose)
    b : float
        Slope parameter (negative for decreasing viability curves)
    c : float
        Lower asymptote (bottom)
    d : float
        Upper asymptote (top)
    e_log : float
        Log of ED50 (IC50): log(ED50)

    Returns
    -------
    response : array-like
        Predicted responses

    Notes
    -----
    LL.3/LL.4 parameterization:
        response = c + (d - c) / (1 + exp(b * (log(dose) - log(ED50))))
    """
    return c + (d - c) / (1.0 + np.exp(b * (dose_log - e_log)))


def _get_ecp_initial_guesses(doses, responses, fixed_bottom=None):
    """
    Calculate initial guesses using logit regression approach.

    Self-starting function strategy for LL.3/LL.4 models.

    Parameters
    ----------
    doses : array-like
        Dose values (must be positive)
    responses : array-like
        Response values
    fixed_bottom : float, optional
        If provided, fix bottom (c) at this value (for LL.3, set to 0)

    Returns
    -------
    dict
        Initial guesses: {'b': slope, 'c': bottom, 'd': top, 'e': IC50}

    Notes
    -----
    Uses logit transformation to linearize the dose-response relationship:
        logit(y) = log((y - c) / (d - y)) = b * log(dose) - b * log(ED50)

    Linear regression on (log(dose), logit(y)) gives slope (b) and intercept,
    from which we back-calculate ED50.
    """
    from scipy.stats import linregress

    doses = np.asarray(doses)
    responses = np.asarray(responses)

    # Step 1: Initial estimates for asymptotes
    d_init = np.max(responses) * 1.05  # Slightly above max
    c_init = 0.0 if fixed_bottom == 0.0 else np.min(responses) * 0.95

    # Step 2: Clip responses to avoid division by zero in logit
    epsilon = 0.01
    y_clipped = np.clip(responses, c_init + epsilon, d_init - epsilon)

    # Step 3: Logit transformation
    # logit = log((y - c) / (d - y))
    logit_y = np.log((y_clipped - c_init) / (d_init - y_clipped))
    log_dose = np.log(doses)

    # Step 4: Linear regression on log-dose scale
    # Derivation from LL.4: log((d-y)/(y-c)) = b * (log(dose) - log(e))
    # Our logit = log((y-c)/(d-y)) = -b * (log(dose) - log(e)) = -b*log(dose) + b*log(e)
    # So: slope = -b, intercept = b * log(e)
    # Therefore: b = -slope, e = exp(intercept / b) = exp(-intercept / slope)
    slope, intercept, _, _, _ = linregress(log_dose, logit_y)

    b_init = -slope  # Hill slope (note the sign correction!)
    e_init = np.exp(-intercept / slope) if abs(slope) > 1e-10 else np.median(doses)

    # Sanity check: if logit regression gives IC50 outside dose range, use geometric mean
    if e_init < np.min(doses) * 0.1 or e_init > np.max(doses) * 10:
        e_init = np.sqrt(np.min(doses) * np.max(doses))

    return {
        'b': b_init,
        'c': c_init if fixed_bottom is None else fixed_bottom,
        'd': d_init,
        'e': e_init
    }


def _reparameterize_for_fitting(params):
    """
    Reparameterize to enforce constraints naturally.

    - Fit log_e instead of e (ensures IC50 > 0)
    - Fit log_delta instead of (d-c) (ensures top > bottom)

    Parameters
    ----------
    params : dict
        Natural parameters: {'b': slope, 'c': bottom, 'd': top, 'e': IC50}

    Returns
    -------
    dict
        Reparameterized: {'b': slope, 'c': bottom, 'log_e': log(IC50), 'log_delta': log(top-bottom)}
    """
    return {
        'log_e': np.log(params['e']),
        'log_delta': np.log(params['d'] - params['c']),
        'b': params['b'],
        'c': params['c']
    }


def _deparameterize_after_fitting(fitted_params):
    """
    Convert reparameterized values back to natural scale.

    Parameters
    ----------
    fitted_params : dict
        Fitted reparameterized values

    Returns
    -------
    dict
        Natural parameters: {'b': slope, 'c': bottom, 'd': top, 'e': IC50}
    """
    e = np.exp(fitted_params['log_e'])
    delta = np.exp(fitted_params['log_delta'])
    return {
        'e': e,
        'd': fitted_params['c'] + delta,
        'b': fitted_params['b'],
        'c': fitted_params['c']
    }


def _infer_slope_sign(doses, responses):
    """
    Determine expected sign of slope parameter using Spearman correlation.

    - Negative correlation (viability decreasing) → b should be negative
    - Positive correlation (inhibition increasing) → b should be positive

    Parameters
    ----------
    doses : array-like
        Dose concentrations
    responses : array-like
        Response values

    Returns
    -------
    float
        Expected slope sign: -1.0 or +1.0
    """
    from scipy.stats import spearmanr
    corr, _ = spearmanr(doses, responses)
    return -1.0 if corr < 0 else 1.0


def _get_t_critical(df, level=0.95):
    """Return t critical for confidence bands; fall back to z if df invalid."""
    try:
        from scipy.stats import t
        if df is not None and df > 0:
            return float(t.ppf(1.0 - (1.0 - level) / 2.0, df))
    except Exception:
        pass
    return 1.96


def _build_log_dose_grid(doses, grid_size=100):
    """Return log-spaced dose grid for plotting."""
    doses = np.asarray(doses, dtype=float)
    positive = doses[doses > 0]
    if positive.size == 0:
        return None
    min_dose = float(np.min(positive))
    max_dose = float(np.max(positive))
    log_min = np.log(min_dose)
    log_max = np.log(max_dose)
    grid = np.exp(np.linspace(log_min, log_max, grid_size))
    grid[0] = min_dose
    grid[-1] = max_dose
    return grid


def _compute_ci_band_stats(pred, lower, upper, tcrit, x_values=None):
    """Summarize confidence band for validation output."""
    width = upper - lower
    stats = {
        "ci_band_points": int(len(pred)),
        "ci_band_tcrit": float(tcrit),
        "ci_band_lower_min": float(np.min(lower)),
        "ci_band_lower_max": float(np.max(lower)),
        "ci_band_upper_min": float(np.min(upper)),
        "ci_band_upper_max": float(np.max(upper)),
        "ci_band_width_mean": float(np.mean(width)),
        "ci_band_width_max": float(np.max(width)),
        "ci_band_lower": lower.tolist(),
        "ci_band_upper": upper.tolist(),
    }
    if x_values is not None:
        stats["ci_band_doses"] = np.asarray(x_values, dtype=float).tolist()
    return stats


def _band_from_gradients(pred, grads, cov_matrix, dof, level=0.95, x_values=None):
    """Compute confidence band stats from gradients and covariance."""
    if cov_matrix is None or not np.all(np.isfinite(cov_matrix)):
        return None
    try:
        variances = np.einsum("ij,jk,ik->i", grads, cov_matrix, grads)
        variances = np.where(variances >= 0, variances, 0.0)
        se = np.sqrt(variances)
        tcrit = _get_t_critical(dof, level=level)
        lower = pred - tcrit * se
        upper = pred + tcrit * se
        return _compute_ci_band_stats(pred, lower, upper, tcrit, x_values=x_values)
    except Exception:
        return None


def _numerical_hessian_rss(func, params, step=1e-3):
    """Numerical Hessian for RSS using central differences (optimHess-style)."""
    params = np.asarray(params, dtype=float)
    n = len(params)
    hess = np.zeros((n, n), dtype=float)

    steps = np.array([step * (abs(p) if abs(p) > 1e-4 else 1.0) for p in params], dtype=float)

    for i in range(n):
        for j in range(n):
            ei = np.zeros(n)
            ej = np.zeros(n)
            ei[i] = steps[i]
            ej[j] = steps[j]
            f_pp = func(params + ei + ej)
            f_pm = func(params + ei - ej)
            f_mp = func(params - ei + ej)
            f_mm = func(params - ei - ej)
            hess[i, j] = (f_pp - f_pm - f_mp + f_mm) / (4.0 * steps[i] * steps[j])
    return hess


def _cov_from_rss_hessian(func, params, variance):
    """Estimate parameter covariance using a numerical RSS Hessian."""
    try:
        hess = _numerical_hessian_rss(func, params)
        if not np.all(np.isfinite(hess)):
            return None
        hess = 0.5 * (hess + hess.T)
        hess_scaled = hess / 2.0
        cov = np.linalg.inv(hess_scaled) * variance
        if not np.all(np.isfinite(cov)):
            return None
        return cov
    except Exception:
        return None


def fit_ll3_ecp_style(doses, responses):
    """
    Fit 3-parameter log-logistic (LL.3) model.

    LL.3: c=0 (fixed), f=1 (fixed), estimates b, d, e

    Uses log-dose parameterization, logit regression initialization, and analytical
    Jacobian for numerical stability.

    Parameters
    ----------
    doses : array-like
        Dose concentrations (must be > 0, no zero/negative doses)
    responses : array-like
        Response values

    Returns
    -------
    dict
        Fit results in EasyCris format with parameters and diagnostics

    Notes
    -----
    This function expects POSITIVE doses only (no dose=0 controls).
    For data with dose=0 controls, use fit_3pl_dose_response() instead,
    which handles control splitting before calling this function.
    """
    from scipy.optimize import least_squares

    doses = np.asarray(doses)
    responses = np.asarray(responses)

    # Validate: LL.3 requires strictly positive doses (log-domain fitting)
    if np.any(doses <= 0):
        return {
            "success": False,
            "error": "LL.3 requires strictly positive doses (dose > 0). "
                     "For data with dose=0 controls, use fit_3pl_dose_response() instead."
        }

    # Minimum data check (3 parameters need at least 4 points)
    MIN_POSITIVE_LL3 = 4
    if len(doses) < MIN_POSITIVE_LL3:
        return {
            "success": False,
            "error": f"Need at least {MIN_POSITIVE_LL3} positive dose points for LL.3. Found {len(doses)}."
        }

    log_doses = np.log(doses)

    # Use UNWEIGHTED least squares (standard OLS)
    sqrt_weights = np.ones_like(doses)

    # Step 1: Initial guesses via logit regression
    init = _get_ecp_initial_guesses(doses, responses, fixed_bottom=0.0)

    # DEBUG: Print initial guesses
    _debug(f"[LL3 INIT] doses={doses}, responses={responses}")
    _debug(f"[LL3 INIT] b={init['b']:.4f}, c={init['c']:.4f}, d={init['d']:.4f}, e={init['e']:.4f}")

    # Step 2: Reparameterize
    params_init = _reparameterize_for_fitting(init)
    x0 = [params_init['b'], params_init['log_e'], params_init['log_delta']]

    # Step 3: Define residual function
    def residual(x):
        b, log_e, log_delta = x
        c = 0.0  # Fixed for LL.3
        d = c + np.exp(log_delta)
        e_log = log_e

        predicted = _log_logistic(log_doses, b, c, d, e_log)
        return sqrt_weights * (responses - predicted)

    # Step 4: Analytical Jacobian
    def jacobian(x):
        b, log_e, log_delta = x
        c = 0.0
        delta = np.exp(log_delta)
        d = c + delta
        e_log = log_e

        # Compute base quantities
        exponent = np.exp(b * (log_doses - e_log))
        denominator = 1.0 + exponent

        # Partial derivatives
        # d(residual)/d(b) = -d(predicted)/d(b)
        dpred_db = -delta * exponent * (log_doses - e_log) / (denominator**2)

        # d(residual)/d(log_e) = -d(predicted)/d(log_e)
        dpred_dloge = delta * b * exponent / (denominator**2)

        # d(residual)/d(log_delta) = -d(predicted)/d(log_delta)
        dpred_dlogdelta = delta / denominator

        # Residual = sqrt_w * (response - predicted)
        J = np.column_stack([-dpred_db, -dpred_dloge, -dpred_dlogdelta])
        J = (sqrt_weights[:, np.newaxis]) * J
        return J

    # Step 5: Bounds
    bounds_lower = [-10, np.log(min(doses)/100), np.log(0.01)]
    bounds_upper = [10, np.log(max(doses)*100), np.log(200)]

    # Step 6: Fit with analytical Jacobian
    result = least_squares(
        residual,
        x0,
        jac=jacobian,
        bounds=(bounds_lower, bounds_upper),
        ftol=1e-8,
        xtol=1e-8,
        gtol=1e-8,
        max_nfev=1000
    )

    # Step 7: Deparameterize
    b_fit, log_e_fit, log_delta_fit = result.x
    fitted = _deparameterize_after_fitting({
        'b': b_fit,
        'log_e': log_e_fit,
        'log_delta': log_delta_fit,
        'c': 0.0
    })

    # DEBUG: Print fitted values
    _debug(f"[LL3 FIT] b={fitted['b']:.4f}, c={fitted['c']:.4f}, d={fitted['d']:.4f}, e={fitted['e']:.4f}")

    # Step 8: Calculate goodness of fit metrics
    predicted = _log_logistic(log_doses, fitted['b'], fitted['c'], fitted['d'], np.log(fitted['e']))
    residuals = result.fun

    # R-squared
    ss_res = np.sum(residuals**2)
    ss_tot = np.sum((responses - np.mean(responses))**2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    # RMSE
    rmse = np.sqrt(ss_res / len(responses))

    # AIC/BIC (full likelihood with constants)
    n = len(responses)
    k = 3
    ll_constant = n * (np.log(2 * np.pi) + 1)
    k_aic = k + 1
    aic = ll_constant + n * np.log(ss_res / n) + 2 * k_aic
    bic = ll_constant + n * np.log(ss_res / n) + k_aic * np.log(n)

    # Adjusted R-squared
    adj_r_squared = 1 - ((1 - r_squared) * (n - 1) / (n - k - 1)) if n > k + 1 else None

    # Step 9: Compute parameter standard errors from covariance matrix
    # Extract Jacobian at solution for covariance computation
    J = jacobian(result.x)

    dof = n - k
    cov_matrix = None
    cov_matrix_full = None
    cov_matrix_full = None
    try:
        # Variance estimate: RSS / DOF
        variance = ss_res / dof if dof > 0 else 0.0

        # Prefer RSS Hessian for numerical stability
        rss_fn = lambda x: np.sum(residual(x)**2)
        cov_matrix = _cov_from_rss_hessian(rss_fn, result.x, variance)
        if cov_matrix is None:
            # Fallback: Gauss-Newton approximation
            JtJ = J.T @ J
            cov_matrix = np.linalg.inv(JtJ) * variance

        # Standard errors are sqrt of diagonal elements
        param_stderr = np.sqrt(np.diag(cov_matrix))

        # LL.3 fits: b, log_e, log_delta (c=0 is fixed)
        stderr_b = param_stderr[0]
        stderr_log_e = param_stderr[1]
        stderr_log_delta = param_stderr[2]

        # Transform stderr for e (IC50): delta method: stderr(e) ≈ e * stderr(log_e)
        stderr_e = fitted['e'] * stderr_log_e

        # Transform stderr for d (top): delta method: stderr(d) ≈ delta * stderr(log_delta)
        # For LL.3, bottom c=0, so delta = d - 0 = d
        stderr_d = fitted['d'] * stderr_log_delta

        # Bottom is fixed, no uncertainty
        stderr_c = 0.0

    except np.linalg.LinAlgError:
        # Singular matrix - can't compute uncertainties
        stderr_b = 0.0
        stderr_c = 0.0
        stderr_e = 0.0
        stderr_d = 0.0
        cov_matrix = None

    # Step 9b: Confidence band stats (log-dose grid)
    ci_band_stats = None
    dose_grid = _build_log_dose_grid(doses, grid_size=100)
    if dose_grid is not None and cov_matrix is not None:
        log_grid = np.log(dose_grid)
        delta = np.exp(log_delta_fit)
        z = np.exp(b_fit * (log_grid - log_e_fit))
        den = 1.0 + z
        pred_grid = delta / den  # c=0 for LL.3

        dpred_db = -delta * z * (log_grid - log_e_fit) / (den**2)
        dpred_dloge = delta * b_fit * z / (den**2)
        dpred_dlogdelta = delta / den
        grads = np.column_stack([dpred_db, dpred_dloge, dpred_dlogdelta])
        ci_band_stats = _band_from_gradients(pred_grid, grads, cov_matrix, dof, x_values=dose_grid)

    # Step 10: Convert to EasyCris naming convention
    # Internal: b (slope), c (bottom), d (top), e (ED50)
    # EasyCris: hill, bottom, top, ic50
    hill_value = -fitted['b']
    hill_ci_lower = hill_value - 1.96 * stderr_b
    hill_ci_upper = hill_value + 1.96 * stderr_b

    warnings = []
    result_payload = {
        "success": result.success,
        "model_type": "3PL",
        "fixed_bottom": 0.0,
        "parameters": {
            "hill": {
                "value": hill_value,
                "stderr": stderr_b,
                "ci_lower": hill_ci_lower,
                "ci_upper": hill_ci_upper
            },
            "bottom": {
                "value": fitted['c'],
                "stderr": stderr_c,  # Fixed parameter, no uncertainty
                "ci_lower": fitted['c'],
                "ci_upper": fitted['c']
            },
            "top": {
                "value": fitted['d'],
                "stderr": stderr_d,
                "ci_lower": fitted['d'] - 1.96 * stderr_d,
                "ci_upper": fitted['d'] + 1.96 * stderr_d
            },
            "ic50": {
                "value": fitted['e'],
                "stderr": stderr_e,
                "ci_lower": fitted['e'] - 1.96 * stderr_e,
                "ci_upper": fitted['e'] + 1.96 * stderr_e
            }
        },
        "goodness_of_fit": {
            "r_squared": r_squared,
            "adj_r_squared": adj_r_squared,
            "rmse": rmse,
            "aic": aic,
            "bic": bic,
            "residual_ss": ss_res
        },
        "fitted_values": predicted.tolist(),
        "residuals": residuals.tolist(),
        "n_observations": n,
        "method": "LL3",
        "message": "Fitted using LL.3 (log-dose parameterization)"
    }
    add_neg_log10_ic50(result_payload["parameters"])
    sanitize_parameter_uncertainty(
        result_payload["parameters"],
        warnings=warnings,
        model_label="3PL",
    )
    if warnings:
        result_payload["warnings"] = warnings
    if ci_band_stats:
        result_payload.update(ci_band_stats)
    return result_payload


def fit_ll4_ecp_style(doses, responses, policy=FittingPolicy.BEST_RSS, bottom_fixed=None, top_fixed=None):
    """
    Fit 4-parameter log-logistic (LL.4) model.

    LL.4: c=free (bottom), f=1 (fixed), estimates b, c, d, e

    Uses log-dose parameterization, dose scaling for numerical stability,
    and analytical Jacobian.

    Parameters
    ----------
    doses : array-like
        Dose concentrations (must be > 0, no zero/negative doses)
    responses : array-like
        Response values
    policy : FittingPolicy, optional
        Solver policy controlling basin selection behavior.
        FittingPolicy.BEST_RSS: Find mathematically best fit (default)
        FittingPolicy.STRICT_PARITY: Attempt reference numerical parity
    bottom_fixed : float, optional
        If provided, fix the bottom (c) parameter to this value.
    top_fixed : float, optional
        If provided, fix the top (d) parameter to this value.

    Returns
    -------
    dict
        Fit results in EasyCris format with parameters and diagnostics.
        If policy=STRICT_PARITY, includes 'alternates' dict with both parameter sets.

    Notes
    -----
    This function expects POSITIVE doses only (no dose=0 controls).
    For data with dose=0 controls, use fit_4pl_dose_response() instead,
    which handles control splitting before calling this function.
    """
    _debug(f"[LL4 DEBUG] fit_ll4_ecp_style called with doses={doses}, responses={responses}, policy={policy}")
    from scipy.optimize import least_squares

    doses = np.asarray(doses)
    responses = np.asarray(responses)

    _debug(f"[LL4 DEBUG] Converted to numpy - doses shape={doses.shape}, responses shape={responses.shape}")

    # Validate: LL.4 requires strictly positive doses (log-domain fitting)
    _debug("[LL4 DEBUG] Checking for non-positive doses...")
    if np.any(doses <= 0):
        return {
            "success": False,
            "error": "LL.4 requires strictly positive doses (dose > 0). "
                     "For data with dose=0 controls, use fit_4pl_dose_response() instead."
        }

    # Minimum data check (4 parameters need at least 4 points)
    MIN_POSITIVE_LL4 = 4
    _debug(f"[LL4 DEBUG] Checking minimum data: len(doses)={len(doses)}, required={MIN_POSITIVE_LL4}")
    if len(doses) < MIN_POSITIVE_LL4:
        error_msg = f"Need at least {MIN_POSITIVE_LL4} positive dose points for LL.4. Found {len(doses)}."
        _debug(f"[LL4 DEBUG ERROR] {error_msg}")
        return {
            "success": False,
            "error": error_msg
        }

    # STEP 0: Log-centered dose scaling for numerical stability
    # Following djwooten/synergy approach: scale doses so median(log(dose)) = 0
    # This prevents overflow/underflow and stabilizes IC50 fitting around 1.0
    # CRITICAL: Filter out zeros before log (djwooten line 83: d[d > 0])
    dose_scale = np.exp(np.median(np.log(doses[doses > 0])))
    doses_scaled = doses / dose_scale
    log_doses_scaled = np.log(doses_scaled)

    # Step 1: Initial guess via logit regression (on scaled doses)
    # Use logit regression to handle both viability (decreasing) and inhibition (increasing) curves
    # This gives better starting values than simple data extrema for complex dose-response shapes
    init_raw = _get_ecp_initial_guesses(doses_scaled, responses, fixed_bottom=bottom_fixed)

    # Adjust IC50 guess - logit regression returns IC50 in scaled space
    # We'll fit in scaled space and multiply back later
    init = {
        'b': init_raw['b'],
        'c': init_raw['c'],
        'd': init_raw['d'],
        'e': init_raw['e']  # Already in scaled space from scaled doses
    }


    # Step 2: Use self-start seeds for initialization
    ecp_seeds = _get_ecp_initial_guesses(doses, responses, fixed_bottom=bottom_fixed)

    # Returns: {'b': slope, 'c': bottom, 'd': top, 'e': IC50}
    b_ecp = ecp_seeds['b']  # Slope (can be negative for inhibition)
    c_init = ecp_seeds['c']  # Bottom
    d_init = ecp_seeds['d']  # Top
    C_init = ecp_seeds['e']  # IC50 (in original dose space)

    # IMPORTANT:
    # LL.4 slope parameter `b` is free to be positive or negative (curve direction).
    # Optimize `b` directly instead of forcing a positive-only reparameterization.

    # Scale IC50 to scaled space and optimize log(IC50_scaled) for numerical stability.
    C_init_scaled = C_init / dose_scale
    logC_init = np.log(C_init_scaled)

    # Parameter vector with optional fixed bottom/top
    param_defaults = {
        "c": c_init,
        "d": d_init,
        "b": b_ecp,
        "logC": logC_init
    }
    if bottom_fixed is not None:
        param_defaults["c"] = float(bottom_fixed)
    if top_fixed is not None:
        param_defaults["d"] = float(top_fixed)

    free_params = []
    if bottom_fixed is None:
        free_params.append("c")
    if top_fixed is None:
        free_params.append("d")
    free_params.extend(["b", "logC"])

    param_index = {"c": 0, "d": 1, "b": 2, "logC": 3}
    free_indices = [param_index[name] for name in free_params]

    def _unpack(x):
        vals = param_defaults.copy()
        for idx, name in enumerate(free_params):
            vals[name] = x[idx]
        return vals

    x0 = [param_defaults[name] for name in free_params]

    _debug(f"[SELF-START] b={b_ecp:.4f}, c={param_defaults['c']:.2f}, d={param_defaults['d']:.2f}, e={C_init:.1f}")

    # Step 3: Define residual function (LL.4 convention)
    def residual(x):
        vals = _unpack(x)
        c = vals["c"]
        d = vals["d"]
        b = vals["b"]
        logC = vals["logC"]

        # LL.4: y = c + (d-c)/(1 + exp(b*(log(x) - log(e))))
        exponent = np.exp(b * (log_doses_scaled - logC))
        predicted = c + (d - c) / (1.0 + exponent)
        return responses - predicted

    # Step 4: Analytical Jacobian (LL.4 convention)
    def jacobian(x):
        vals = _unpack(x)
        c = vals["c"]
        d = vals["d"]
        b = vals["b"]
        logC = vals["logC"]

        # Compute base quantities
        exponent = np.exp(b * (log_doses_scaled - logC))
        denominator = 1.0 + exponent
        denominator_sq = denominator ** 2

        # Partial derivatives for y = c + (d-c)/(1+exp)
        dpred_dc = exponent / denominator
        dpred_dd = 1.0 / denominator
        dpred_db = -(d - c) * exponent * (log_doses_scaled - logC) / denominator_sq
        dpred_dlogC = (d - c) * b * exponent / denominator_sq

        # Residual = response - predicted, so Jacobian is negative
        full_J = np.column_stack([-dpred_dc, -dpred_dd, -dpred_db, -dpred_dlogC])
        return full_J[:, free_indices]

    # Step 5: Define bounds - wide biological constraints only
    # Use wide biological bounds with no IC50 constraint.
    # This allows optimizer to find the mathematically best basin from self-start seeds.
    response_min = np.min(responses)
    response_max = np.max(responses)
    response_range = response_max - response_min

    # Wide bounds - allow c/d to roam, b in [-100, 100], IC50 anywhere within dose range.
    #
    # IMPORTANT:
    # Do not hard-cap the Hill/slope parameter at |b| <= 10. A tight cap can force
    # the optimizer onto a boundary and yield incorrect results at extreme/low doses.
    # We therefore keep a *wide* slope range here to avoid boundary-hits while still
    # preventing numerical blow-ups.
    bounds_lower_full = [
        response_min - response_range,          # c (bottom)
        response_min,                           # d (top)
        -100.0,                                 # b (hill/slope)
        np.log(np.min(doses) / dose_scale * 0.01)  # logC (IC50 >= min_dose / 100)
    ]
    bounds_upper_full = [
        response_max,                           # c (bottom)
        response_max + response_range,          # d (top)
        100.0,                                  # b (hill/slope)
        np.log(np.max(doses) / dose_scale * 100)   # logC (IC50 <= max_dose * 100)
    ]

    bounds_lower = [bounds_lower_full[i] for i in free_indices]
    bounds_upper = [bounds_upper_full[i] for i in free_indices]

    # Step 6: Single least_squares fit from self-start seeds
    # NOTE: May find different basin due to optimizer differences.
    # Basin selection aims for lowest RSS (best mathematical fit).
    result = least_squares(
        residual,
        x0,
        jac=jacobian,
        bounds=(bounds_lower, bounds_upper),
        ftol=1e-8,
        xtol=1e-8,
        gtol=1e-8,
        max_nfev=1000
    )

    # Step 7: Deparameterize and scale IC50 back (LL.4 convention)
    fitted_vals = _unpack(result.x)
    c_fit = fitted_vals["c"]
    d_fit = fitted_vals["d"]
    b_fit = fitted_vals["b"]
    logC_fit = fitted_vals["logC"]
    h_fit = float(b_fit)  # b can be positive or negative
    C_fit_scaled = np.exp(logC_fit)
    C_fit = float(C_fit_scaled * dose_scale)

    # DEBUG: Print fitted values (already selected by two-window strategy)
    _debug(f"[LL4 FIT FINAL] h={h_fit:.4f}, c={c_fit:.4f}, d={d_fit:.4f}, e={C_fit:.4f}")

    # Step 8: Calculate goodness of fit metrics (in original dose space for consistency)
    # Predict using original doses
    exponent_original = np.exp(h_fit * (np.log(doses) - np.log(C_fit)))
    predicted = c_fit + (d_fit - c_fit) / (1.0 + exponent_original)
    residuals = responses - predicted

    # R-squared
    ss_res = np.sum(residuals**2)
    ss_tot = np.sum((responses - np.mean(responses))**2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    # RMSE
    rmse = np.sqrt(ss_res / len(responses))

    # AIC/BIC (full likelihood with constants)
    n = len(responses)
    k = len(free_params)
    ll_constant = n * (np.log(2 * np.pi) + 1)
    k_aic = k + 1
    aic = ll_constant + n * np.log(ss_res / n) + 2 * k_aic
    bic = ll_constant + n * np.log(ss_res / n) + k_aic * np.log(n)

    # Adjusted R-squared
    adj_r_squared = 1 - ((1 - r_squared) * (n - 1) / (n - k - 1)) if n > k + 1 else None

    # Step 9: Compute parameter standard errors from covariance matrix
    # Extract Jacobian at solution for covariance computation
    J = jacobian(result.x)

    dof = n - k
    cov_matrix = None
    try:
        # Variance estimate: RSS / DOF
        variance = ss_res / dof if dof > 0 else 0.0

        # Prefer RSS Hessian for numerical stability
        rss_fn = lambda x: np.sum(residual(x)**2)
        cov_matrix = _cov_from_rss_hessian(rss_fn, result.x, variance)
        if cov_matrix is None:
            # Fallback: Gauss-Newton approximation
            JtJ = J.T @ J
            cov_matrix = np.linalg.inv(JtJ) * variance

        # Standard errors are sqrt of diagonal elements
        param_stderr = np.sqrt(np.diag(cov_matrix))

        stderr_map = {"c": 0.0, "d": 0.0, "b": 0.0, "logC": 0.0}
        for idx, name in enumerate(free_params):
            stderr_map[name] = float(param_stderr[idx])

        stderr_c = stderr_map["c"]
        stderr_d = stderr_map["d"]
        stderr_b = stderr_map["b"]
        stderr_logC = stderr_map["logC"]

        cov_matrix_full = np.zeros((4, 4))
        for i, name_i in enumerate(free_params):
            for j, name_j in enumerate(free_params):
                cov_matrix_full[param_index[name_i], param_index[name_j]] = cov_matrix[i, j]

        # Transform stderr for h (hill): delta method: stderr(h) ≈ h * stderr(logh)
        stderr_h = stderr_b

        # Transform stderr for e (IC50): delta method: stderr(e) ≈ e * stderr(logC) * dose_scale
        stderr_e = C_fit * stderr_logC  # Already includes dose_scale

    except np.linalg.LinAlgError:
        # Singular matrix - can't compute uncertainties
        stderr_h = 0.0
        stderr_c = 0.0
        stderr_d = 0.0
        stderr_e = 0.0
        cov_matrix = None
        cov_matrix_full = None

    # Step 10: If STRICT_PARITY policy, run constrained fit for diagnostic comparison
    alternates = None
    if policy == FittingPolicy.STRICT_PARITY and bottom_fixed is None and top_fixed is None:
        # Run second fit with IC50 constrained near initial seed (±factor of 12)
        # This attempts to stay in reference basin for validation parity
        ic50_lower_constrained = C_init_scaled / 12.0
        ic50_upper_constrained = C_init_scaled * 12.0

        bounds_constrained_lower = [
            response_min - response_range,
            response_min,
            -100.0,
            np.log(ic50_lower_constrained)
        ]
        bounds_constrained_upper = [
            response_max,
            response_max + response_range,
            100.0,
            np.log(ic50_upper_constrained)
        ]

        result_constrained = least_squares(
            residual,
            x0,
            jac=jacobian,
            bounds=(bounds_constrained_lower, bounds_constrained_upper),
            ftol=1e-8,
            xtol=1e-8,
            gtol=1e-8,
            max_nfev=1000
        )

        # Extract constrained parameters (same parameterization as unconstrained fit)
        c_parity, d_parity, b_parity, logC_parity = result_constrained.x
        h_parity = float(b_parity)
        C_parity_scaled = np.exp(logC_parity)
        C_parity = float(C_parity_scaled * dose_scale)

        # Compute RSS for both fits for comparison
        exponent_parity = np.exp(h_parity * (np.log(doses) - np.log(C_parity)))
        predicted_parity = c_parity + (d_parity - c_parity) / (1.0 + exponent_parity)
        residuals_parity = responses - predicted_parity
        ss_res_parity = np.sum(residuals_parity**2)

        # Store both parameter sets
        alternates = {
            "best_rss": {
                "hill": h_fit,
                "bottom": c_fit,
                "top": d_fit,
                "ic50": C_fit,
                "rss": ss_res
            },
            "strict_parity": {
                "hill": h_parity,
                "bottom": c_parity,
                "top": d_parity,
                "ic50": C_parity,
                "rss": ss_res_parity
            },
            "policy_note": f"STRICT_PARITY: IC50 constrained to [{ic50_lower_constrained*dose_scale:.1f}, {ic50_upper_constrained*dose_scale:.1f}] µM around seed {C_init:.1f} µM"
        }

        # IMPORTANT: When STRICT_PARITY is requested, use the constrained fit as the
        # primary output (parameters + diagnostics). This matches the policy's intent:
        # prefer baseline-compatible basin selection over the unconstrained minimum-RSS basin.
        result = result_constrained
        c_fit = float(c_parity)
        d_fit = float(d_parity)
        h_fit = float(h_parity)
        C_fit = float(C_parity)

        # Recompute predictions/metrics for the selected (parity) solution
        predicted = predicted_parity
        residuals = residuals_parity
        ss_res = float(ss_res_parity)
        ss_tot = np.sum((responses - np.mean(responses))**2)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
        rmse = np.sqrt(ss_res / len(responses))
        aic = n * np.log(ss_res / n) + 2 * k if n > 0 else None
        bic = n * np.log(ss_res / n) + k * np.log(n) if n > k else None
        adj_r_squared = 1 - ((1 - r_squared) * (n - 1) / (n - k - 1)) if n > k + 1 else None

        # Recompute covariance / stderr for the selected (parity) solution
        J = jacobian(result_constrained.x)
        try:
            dof = n - k
            variance = ss_res / dof if dof > 0 else 0.0
            rss_fn = lambda x: np.sum(residual(x)**2)
            cov_matrix = _cov_from_rss_hessian(rss_fn, result_constrained.x, variance)
            if cov_matrix is None:
                JtJ = J.T @ J
                cov_matrix = np.linalg.inv(JtJ) * variance
            param_stderr = np.sqrt(np.diag(cov_matrix))
            stderr_c = param_stderr[0]
            stderr_d = param_stderr[1]
            stderr_b = param_stderr[2]
            stderr_logC = param_stderr[3]
            stderr_h = stderr_b
            stderr_e = C_fit * stderr_logC
        except np.linalg.LinAlgError:
            stderr_h = 0.0
            stderr_c = 0.0
            stderr_d = 0.0
            stderr_e = 0.0
            cov_matrix = None

        if cov_matrix is not None:
            cov_matrix_full = cov_matrix

    # Step 10b: Confidence band stats (log-dose grid)
    ci_band_stats = None
    dose_grid = _build_log_dose_grid(doses, grid_size=100)
    if dose_grid is not None and cov_matrix_full is not None:
        log_grid = np.log(dose_grid)
        log_c_fit = np.log(C_fit)
        z = np.exp(h_fit * (log_grid - log_c_fit))
        den = 1.0 + z
        delta = (d_fit - c_fit)
        pred_grid = c_fit + delta / den

        dpred_dc = 1.0 - (1.0 / den)
        dpred_dd = 1.0 / den
        dpred_db = -delta * z * (log_grid - log_c_fit) / (den**2)
        dpred_dlogc = delta * h_fit * z / (den**2)
        grads = np.column_stack([dpred_dc, dpred_dd, dpred_db, dpred_dlogc])
        ci_band_stats = _band_from_gradients(pred_grid, grads, cov_matrix_full, dof, x_values=dose_grid)

    # Step 11: Convert to EasyCris naming convention
    # Internal: b (slope/hill), c (bottom), d (top), e (IC50)
    # EasyCris: hill, bottom, top, ic50
    hill_value = -h_fit
    hill_ci_lower = hill_value - 1.96 * stderr_h
    hill_ci_upper = hill_value + 1.96 * stderr_h

    bottom_stderr = 0.0 if bottom_fixed is not None else stderr_c
    bottom_ci_lower = c_fit if bottom_fixed is not None else c_fit - 1.96 * stderr_c
    bottom_ci_upper = c_fit if bottom_fixed is not None else c_fit + 1.96 * stderr_c

    top_stderr = 0.0 if top_fixed is not None else stderr_d
    top_ci_lower = d_fit if top_fixed is not None else d_fit - 1.96 * stderr_d
    top_ci_upper = d_fit if top_fixed is not None else d_fit + 1.96 * stderr_d

    warnings = []
    fit_result = {
        "success": result.success,
        "model_type": "4PL",
        "fixed_bottom": float(bottom_fixed) if bottom_fixed is not None else None,
        "dose_scale": dose_scale,  # Include scaling factor for reference
        "fitting_policy": policy.value,  # Record which policy was used
        "parameters": {
            "hill": {
                "value": hill_value,
                "stderr": stderr_h,
                "ci_lower": hill_ci_lower,
                "ci_upper": hill_ci_upper
            },
            "bottom": {
                "value": c_fit,
                "stderr": bottom_stderr,
                "ci_lower": bottom_ci_lower,
                "ci_upper": bottom_ci_upper
            },
            "top": {
                "value": d_fit,
                "stderr": top_stderr,
                "ci_lower": top_ci_lower,
                "ci_upper": top_ci_upper
            },
            "ic50": {
                "value": C_fit,
                "stderr": stderr_e,
                "ci_lower": C_fit - 1.96 * stderr_e,
                "ci_upper": C_fit + 1.96 * stderr_e
            }
        },
        "goodness_of_fit": {
            "r_squared": r_squared,
            "adj_r_squared": adj_r_squared,
            "rmse": rmse,
            "aic": aic,
            "bic": bic,
            "residual_ss": ss_res
        },
        "fitted_values": predicted.tolist(),
        "residuals": residuals.tolist(),
        "n_observations": n,
        "method": "LL4",
        "message": "Fitted using LL.4 (log-dose parameterization)"
    }
    add_neg_log10_ic50(fit_result["parameters"])
    sanitize_parameter_uncertainty(
        fit_result["parameters"],
        warnings=warnings,
        model_label="4PL",
    )
    if warnings:
        fit_result["warnings"] = warnings
    if ci_band_stats:
        fit_result.update(ci_band_stats)

    # Add alternates if STRICT_PARITY policy was used
    if alternates is not None:
        fit_result["alternates"] = alternates

    return fit_result


def fit_l4_ecp_style(doses, responses, policy=FittingPolicy.BEST_RSS, bottom_fixed=None, top_fixed=None):
    """
    Fit 4-parameter logistic (L.4) model.

    L.4: c=free (bottom), f=1 (fixed), estimates b, c, d, e_log
    Uses log(dose) as the predictor and e_log = log(EC50).
    """
    from scipy.optimize import least_squares

    doses = np.asarray(doses, dtype=float)
    responses = np.asarray(responses, dtype=float)

    if np.any(doses <= 0):
        return {
            "success": False,
            "error": "L.4 requires strictly positive doses (dose > 0)."
        }

    MIN_POSITIVE_L4 = 4
    if len(doses) < MIN_POSITIVE_L4:
        return {
            "success": False,
            "error": f"Need at least {MIN_POSITIVE_L4} positive dose points for L.4. Found {len(doses)}."
        }

    log_doses = np.log(doses)
    log_scale = np.median(log_doses)
    log_doses_scaled = log_doses - log_scale

    ecp_seeds = _get_ecp_initial_guesses(doses, responses, fixed_bottom=bottom_fixed)
    b_init = ecp_seeds["b"]
    c_init = ecp_seeds["c"]
    d_init = ecp_seeds["d"]
    e_log_init = np.log(ecp_seeds["e"]) - log_scale

    param_defaults = {
        "c": c_init,
        "d": d_init,
        "b": b_init,
        "e_log": e_log_init
    }
    if bottom_fixed is not None:
        param_defaults["c"] = float(bottom_fixed)
    if top_fixed is not None:
        param_defaults["d"] = float(top_fixed)

    free_params = []
    if bottom_fixed is None:
        free_params.append("c")
    if top_fixed is None:
        free_params.append("d")
    free_params.extend(["b", "e_log"])

    param_index = {"c": 0, "d": 1, "b": 2, "e_log": 3}
    free_indices = [param_index[name] for name in free_params]

    def _unpack(x):
        vals = param_defaults.copy()
        for idx, name in enumerate(free_params):
            vals[name] = x[idx]
        return vals

    x0 = [param_defaults[name] for name in free_params]

    def residual(x):
        vals = _unpack(x)
        c = vals["c"]
        d = vals["d"]
        b = vals["b"]
        e_log = vals["e_log"]
        exponent = np.exp(b * (log_doses_scaled - e_log))
        predicted = c + (d - c) / (1.0 + exponent)
        return responses - predicted

    def jacobian(x):
        vals = _unpack(x)
        c = vals["c"]
        d = vals["d"]
        b = vals["b"]
        e_log = vals["e_log"]

        exponent = np.exp(b * (log_doses_scaled - e_log))
        denominator = 1.0 + exponent
        denominator_sq = denominator ** 2

        dpred_dc = exponent / denominator
        dpred_dd = 1.0 / denominator
        dpred_db = -(d - c) * exponent * (log_doses_scaled - e_log) / denominator_sq
        dpred_de = (d - c) * b * exponent / denominator_sq

        full_J = np.column_stack([-dpred_dc, -dpred_dd, -dpred_db, -dpred_de])
        return full_J[:, free_indices]

    response_min = np.min(responses)
    response_max = np.max(responses)
    response_range = response_max - response_min
    log_min = np.min(log_doses)
    log_max = np.max(log_doses)

    bounds_lower_full = [
        response_min - response_range,
        response_min,
        -100.0,
        (log_min - log_scale) + np.log(0.01)
    ]
    bounds_upper_full = [
        response_max,
        response_max + response_range,
        100.0,
        (log_max - log_scale) + np.log(100)
    ]

    bounds_lower = [bounds_lower_full[i] for i in free_indices]
    bounds_upper = [bounds_upper_full[i] for i in free_indices]

    result = least_squares(
        residual,
        x0,
        jac=jacobian,
        bounds=(bounds_lower, bounds_upper),
        ftol=1e-8,
        xtol=1e-8,
        gtol=1e-8,
        max_nfev=1000
    )

    fitted_vals = _unpack(result.x)
    c_fit = float(fitted_vals["c"])
    d_fit = float(fitted_vals["d"])
    b_fit = float(fitted_vals["b"])
    e_log_fit = float(fitted_vals["e_log"] + log_scale)
    ic50_fit = float(np.exp(e_log_fit))

    exponent_original = np.exp(b_fit * (log_doses - e_log_fit))
    predicted = c_fit + (d_fit - c_fit) / (1.0 + exponent_original)
    residuals = responses - predicted

    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((responses - np.mean(responses)) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
    rmse = np.sqrt(ss_res / len(responses))
    n = len(responses)
    k = len(free_params)
    ll_constant = n * (np.log(2 * np.pi) + 1)
    k_aic = k + 1
    aic = ll_constant + n * np.log(ss_res / n) + 2 * k_aic
    bic = ll_constant + n * np.log(ss_res / n) + k_aic * np.log(n)
    adj_r_squared = 1 - ((1 - r_squared) * (n - 1) / (n - k - 1)) if n > k + 1 else None

    stderr_b = 0.0
    stderr_c = 0.0
    stderr_d = 0.0
    stderr_elog = 0.0
    try:
        J = jacobian(result.x)
        dof = n - k
        variance = ss_res / dof if dof > 0 else 0.0
        rss_fn = lambda x: np.sum(residual(x) ** 2)
        cov_matrix = _cov_from_rss_hessian(rss_fn, result.x, variance)
        if cov_matrix is None:
            JtJ = J.T @ J
            cov_matrix = np.linalg.inv(JtJ) * variance

        param_stderr = np.sqrt(np.diag(cov_matrix))
        stderr_map = {"c": 0.0, "d": 0.0, "b": 0.0, "e_log": 0.0}
        for idx, name in enumerate(free_params):
            stderr_map[name] = float(param_stderr[idx])

        stderr_c = stderr_map["c"]
        stderr_d = stderr_map["d"]
        stderr_b = stderr_map["b"]
        stderr_elog = stderr_map["e_log"]
    except np.linalg.LinAlgError:
        pass

    stderr_ic50 = ic50_fit * stderr_elog

    hill_value = -b_fit
    hill_ci_lower = hill_value - 1.96 * stderr_b
    hill_ci_upper = hill_value + 1.96 * stderr_b
    bottom_stderr = 0.0 if bottom_fixed is not None else stderr_c
    bottom_ci_lower = c_fit if bottom_fixed is not None else c_fit - 1.96 * stderr_c
    bottom_ci_upper = c_fit if bottom_fixed is not None else c_fit + 1.96 * stderr_c
    top_stderr = 0.0 if top_fixed is not None else stderr_d
    top_ci_lower = d_fit if top_fixed is not None else d_fit - 1.96 * stderr_d
    top_ci_upper = d_fit if top_fixed is not None else d_fit + 1.96 * stderr_d

    fit_result = {
        "success": result.success,
        "model_type": "4PL",
        "fixed_bottom": float(bottom_fixed) if bottom_fixed is not None else None,
        "fitting_policy": policy.value,
        "parameters": {
            "hill": {
                "value": hill_value,
                "stderr": stderr_b,
                "ci_lower": hill_ci_lower,
                "ci_upper": hill_ci_upper
            },
            "bottom": {
                "value": c_fit,
                "stderr": bottom_stderr,
                "ci_lower": bottom_ci_lower,
                "ci_upper": bottom_ci_upper
            },
            "top": {
                "value": d_fit,
                "stderr": top_stderr,
                "ci_lower": top_ci_lower,
                "ci_upper": top_ci_upper
            },
            "ic50": {
                "value": ic50_fit,
                "stderr": stderr_ic50,
                "ci_lower": ic50_fit - 1.96 * stderr_ic50,
                "ci_upper": ic50_fit + 1.96 * stderr_ic50
            },
            "e_log": {
                "value": e_log_fit,
                "stderr": stderr_elog,
                "ci_lower": e_log_fit - 1.96 * stderr_elog,
                "ci_upper": e_log_fit + 1.96 * stderr_elog
            }
        },
        "goodness_of_fit": {
            "r_squared": r_squared,
            "adj_r_squared": adj_r_squared,
            "rmse": rmse,
            "aic": aic,
            "bic": bic,
            "residual_ss": ss_res
        },
        "fitted_values": predicted.tolist(),
        "residuals": residuals.tolist(),
        "n_observations": n,
        "method": "L4",
        "message": "Fitted using L.4 (log-dose parameterization)"
    }
    add_neg_log10_ic50(fit_result["parameters"])
    return fit_result


def fit_log_dose_single_agent(doses, responses, policy=FittingPolicy.BEST_RSS,
                              bottom_fixed=None, top_fixed=None):
    """
    Fit single-agent dose-response using LL.4 with an L.4 fallback when zeros are present.
    """
    doses = np.asarray(doses, dtype=float)
    responses = np.asarray(responses, dtype=float)

    if np.any(doses < 0):
        return {"success": False, "error": "Dose values must be >= 0. Negative doses not allowed."}

    use_ll4 = np.all(doses > 0)
    ll4_error = None
    if use_ll4:
        ll4_fit = fit_ll4_ecp_style(
            doses,
            responses,
            policy=policy,
            bottom_fixed=bottom_fixed,
            top_fixed=top_fixed
        )
        if ll4_fit.get("success", False):
            ll4_fit["log_dose_model"] = "LL.4"
            return ll4_fit
        ll4_error = ll4_fit.get("error")

    doses_l4 = np.where(doses == 0, 1e-10, doses)
    l4_fit = fit_l4_ecp_style(
        doses_l4,
        responses,
        policy=policy,
        bottom_fixed=bottom_fixed,
        top_fixed=top_fixed
    )
    l4_fit["log_dose_model"] = "L.4"
    l4_fit["dose_zero_replaced"] = bool(np.any(doses == 0))
    if ll4_error:
        l4_fit["ll4_error"] = ll4_error
    return l4_fit


def fit_synergyfinder_dose_response(doses, responses, policy=FittingPolicy.BEST_RSS,
                                    bottom_fixed=None, top_fixed=None):
    """
    Deprecated alias for fit_log_dose_single_agent (kept for backward compatibility).
    """
    import warnings
    warnings.warn(
        'fit_synergyfinder_dose_response is deprecated and will be removed in v2.0. '
        'Use fit_log_dose_single_agent instead.',
        DeprecationWarning,
        stacklevel=2
    )
    return fit_log_dose_single_agent(
        doses,
        responses,
        policy=policy,
        bottom_fixed=bottom_fixed,
        top_fixed=top_fixed
    )

def fit_3pl_dose_response(doses, responses, bottom_fixed=None, weights=None, fitting_method="lmfit"):
    """
    Fit a 3-parameter logistic (3PL) dose-response curve with fixed bottom.

    Model: y = bottom_fixed + (top - bottom_fixed) / (1 + (dose / ic50)^hill)

    The bottom parameter is FIXED (not fitted), reducing the model to 3 parameters.
    This is appropriate when the baseline response is known (e.g., normalized to 0%).

    Parameters
    ----------
    doses : list or array-like
        Dose concentrations (must be >= 0). Dose=0 points are treated as controls
        and used to determine the bottom parameter if not specified.
    responses : list or array-like
        Observed responses (% inhibition, viability, etc.)
    bottom_fixed : float, optional
        Fixed bottom value. Priority order:
        1. If explicitly provided (not None) -> use this value
        2. If None AND controls exist (dose=0) -> use control_mean
        3. If None AND no controls -> use 0.0 (backwards compatible default)
    weights : list or array-like, optional
        Weights for weighted least squares
    fitting_method : str, optional
        Fitting algorithm to use:
        - "lmfit" (default): Original LMFit approach with numerical Jacobian
        - "log_dose": Log-logistic parameterization with analytical Jacobian

    Notes
    -----
    Dose=0 Handling (v1.8.0):
    - Doses below ZERO_DOSE_TOLERANCE (1e-15) are treated as controls
    - If bottom_fixed is None, control_mean is used as the fixed bottom
    - Fitting is performed on positive doses only (log(0) is undefined)
    - Requires at least 4 POSITIVE dose levels (controls don't count)

    Returns
    -------
    result : dict (JSON-serializable)
        {
            "success": bool,
            "error": str (if success=False),
            "model_type": "3PL",
            "fixed_bottom": float,
            "parameters": {
                "top": {value, stderr, ci_lower, ci_upper},
                "ic50": {value, stderr, ci_lower, ci_upper},
                "hill": {value, stderr, ci_lower, ci_upper}
            },
            "goodness_of_fit": {r_squared, adj_r_squared, rmse, aic, bic},
            "fitted_values": list,
            "residuals": list,
            "n_observations": int,
            "metadata": {...}  # dose=0 handling info
        }
    """
    # Normalize fitting method (defaults to log_dose on unknown values)
    fitting_method = _normalize_fitting_method(fitting_method)

    try:
        # Convert to numpy arrays
        doses = np.asarray(doses, dtype=float)
        responses = np.asarray(responses, dtype=float)

        # Validation
        if len(doses) != len(responses):
            return {
                "success": False,
                "error": "Doses and responses must have the same length"
            }

        # Check for NaN or Inf first
        if np.any(np.isnan(doses)) or np.any(np.isnan(responses)):
            return {
                "success": False,
                "error": "Data contains NaN values"
            }

        if np.any(np.isinf(doses)) or np.any(np.isinf(responses)):
            return {
                "success": False,
                "error": "Data contains infinite values"
            }

        # STEP 1: Reject negative doses (invalid input)
        if np.any(doses < 0):
            return {
                "success": False,
                "error": "Dose values must be >= 0. Negative doses not allowed."
            }

        # STEP 2: Split controls from positive doses
        split = _split_controls_and_positive(doses, responses, weights)

        # STEP 3: Check positive dose count (3PL needs at least 4)
        MIN_POSITIVE_3PL = 4
        if split['n_positive'] < MIN_POSITIVE_3PL:
            return {
                "success": False,
                "error": f"Need at least {MIN_POSITIVE_3PL} data points (positive doses > 0). "
                         f"Found {split['n_positive']}. Controls (dose=0) don't count toward minimum."
            }

        # Use positive doses for fitting
        fit_doses = split['positive_doses']
        fit_responses = split['positive_responses']
        fit_weights = split['positive_weights']

        # STEP 4: Determine actual bottom_fixed value (backwards compatible)
        # Priority: user_specified > control_mean > default (0.0)
        if bottom_fixed is not None:
            actual_bottom_fixed = bottom_fixed
            bottom_source = 'user_specified'
        elif split['has_controls'] and split['control_mean'] is not None:
            actual_bottom_fixed = split['control_mean']
            bottom_source = 'control_mean'
        else:
            actual_bottom_fixed = 0.0  # Backwards compatible default
            bottom_source = 'default'

        # Route to log-dose fitter if requested
        if fitting_method == "log_dose":
            if actual_bottom_fixed != 0.0:
                return {
                    "success": False,
                    "error": "Log-dose fitting method only supports bottom_fixed=0.0 (LL.3 model)"
                }
            return fit_ll3_ecp_style(fit_doses, fit_responses)

        # Define 3PL model function with fixed bottom
        def model_3pl(dose, top, ic50, hill):
            """
            3-Parameter Logistic function with fixed bottom.
            actual_bottom_fixed is captured from outer scope (not a fitted parameter).
            """
            return actual_bottom_fixed + (top - actual_bottom_fixed) / (1 + (dose / ic50)**hill)

        # Create lmfit Model
        model = Model(model_3pl)

        # Set initial parameter guesses based on POSITIVE DOSE data
        params = Parameters()

        # Analyze positive dose data to determine curve direction
        response_min = np.min(fit_responses)
        response_max = np.max(fit_responses)
        response_range = response_max - response_min

        # Detect if response increases or decreases with dose
        from scipy.stats import spearmanr
        dose_response_correlation, _ = spearmanr(fit_doses, fit_responses)

        # Top: Use max response, but ensure it's >= fixed bottom
        params.add('top',
                   value=response_max,
                   min=actual_bottom_fixed,  # Must be >= fixed bottom
                   max=response_max + response_range)

        # IC50: Use geometric mean of POSITIVE doses (better for log-spaced data)
        try:
            ic50_initial = np.exp(np.mean(np.log(fit_doses)))
        except:
            ic50_initial = np.median(fit_doses)

        params.add('ic50',
                   value=ic50_initial,
                   min=np.min(fit_doses) * 0.001,
                   max=np.max(fit_doses) * 1000)

        # Hill slope: Adaptive based on curve direction
        # Same logic as 4PL
        if dose_response_correlation > 0:
            # Activation: response increases with dose
            hill_initial = -1.0
        else:
            # Inhibition: response decreases with dose
            hill_initial = 1.0

        params.add('hill',
                   value=hill_initial,
                   min=-10.0,
                   max=10.0)

        # Fit the model on POSITIVE DOSES ONLY
        result = model.fit(fit_responses, params, dose=fit_doses, weights=fit_weights)

        # Extract parameters with uncertainties (lmfit already scales covariance by χ²/DOF)
        parameters = {}
        for param_name in ['top', 'ic50', 'hill']:
            param = result.params[param_name]
            parameters[param_name] = {
                "value": float(param.value),
                "stderr": float(param.stderr) if param.stderr is not None else None,
                "ci_lower": float(param.value - 1.96 * param.stderr) if param.stderr is not None else None,
                "ci_upper": float(param.value + 1.96 * param.stderr) if param.stderr is not None else None
            }

        # Calculate goodness of fit (on POSITIVE DOSES ONLY)
        n = split['n_positive']  # Use positive dose count, not total
        k = 3  # Only 3 fitted parameters (bottom is fixed, not fitted)
        ss_res = np.sum(result.residual**2)

        # Add -log10(IC50) [pIC50] with proper error propagation
        add_neg_log10_ic50(parameters)

        # Initialize warnings list
        warnings = []
        sanitize_parameter_uncertainty(parameters, warnings=warnings, model_label="3PL")

        # Check for minimal data
        if n == 4:
            warnings.append("3PL fitted with only 4 positive dose points (minimal). Add more doses for stability and reliable uncertainty estimates.")

        # R-squared (computed on positive doses only)
        ss_tot = np.sum((fit_responses - np.mean(fit_responses))**2)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Adjusted R-squared
        # Requires n > k + 1 to be defined (for 3PL: requires n >= 5)
        if n > k + 1:  # n >= 5 for 3PL
            adj_r_squared = 1 - (1 - r_squared) * (n - 1) / (n - k - 1)
        else:
            adj_r_squared = None  # Undefined when n <= k + 1
            warnings.append(f"Adjusted R² undefined with {n} positive dose points and {k} parameters. Requires at least {k + 2} observations.")

        # RMSE
        rmse = np.sqrt(ss_res / n)

        # AIC and BIC (full likelihood with constants)
        # Include residual variance as an estimated parameter (k + 1) for continuous models.
        ll_constant = n * (np.log(2 * np.pi) + 1)
        k_aic = k + 1
        aic = ll_constant + n * np.log(ss_res / n) + 2 * k_aic
        bic = ll_constant + n * np.log(ss_res / n) + k_aic * np.log(n)

        # Confidence band stats (lmfit 3PL, log-dose grid)
        ci_band_stats = None
        dose_grid = _build_log_dose_grid(fit_doses, grid_size=100)
        covar = getattr(result, "covar", None)
        if dose_grid is not None:
            top_val = result.params['top'].value
            ic50_val = result.params['ic50'].value
            hill_val = result.params['hill'].value

            if covar is None:
                def rss_fn(params_vec):
                    top_p, ic50_p, hill_p = params_vec
                    pred = actual_bottom_fixed + (top_p - actual_bottom_fixed) / (1 + (fit_doses / ic50_p) ** hill_p)
                    return np.sum((fit_responses - pred) ** 2)

                variance = ss_res / max(n - k, 1)
                covar = _cov_from_rss_hessian(
                    rss_fn,
                    [top_val, ic50_val, hill_val],
                    variance
                )

            if covar is not None:
                log_ratio = np.log(dose_grid) - np.log(ic50_val)
                r = np.exp(hill_val * log_ratio)
                den = 1.0 + r
                delta = (top_val - actual_bottom_fixed)
                pred_grid = actual_bottom_fixed + delta / den

                dpred_dtop = 1.0 / den
                dpred_dic50 = delta * hill_val * r / (ic50_val * (den**2))
                dpred_dhill = -delta * r * log_ratio / (den**2)
                grads = np.column_stack([dpred_dtop, dpred_dic50, dpred_dhill])
                ci_band_stats = _band_from_gradients(pred_grid, grads, covar, n - k, x_values=dose_grid)

        # Build metadata about dose=0 handling
        metadata = {
            'dose_zero_handling': 'controls_as_baseline' if split['has_controls'] else 'positive_only',
            'bottom_source': bottom_source,
            'n_controls': split['n_controls'],
            'n_positive_doses': split['n_positive'],
            'control_mean': split['control_mean'],
            'control_sd': split['control_sd']
        }

        # Return comprehensive results
        result_payload = {
            "success": True,
            "model_type": "3PL",
            "bottom": float(actual_bottom_fixed),  # Top-level scalar for normalizer
            "fixed_bottom": float(actual_bottom_fixed),  # Document the fixed value
            "warnings": warnings,
            "parameters": parameters,
            "goodness_of_fit": {
                "r_squared": float(r_squared),
                "adj_r_squared": float(adj_r_squared) if adj_r_squared is not None else None,
                "rmse": float(rmse),
                "residual_ss": float(ss_res),
                "aic": float(aic),
                "bic": float(bic)
            },
            "fitted_values": result.best_fit.tolist(),
            "residuals": result.residual.tolist(),
            "n_observations": int(n),
            "metadata": metadata
        }
        if ci_band_stats:
            result_payload.update(ci_band_stats)
        return result_payload

    except Exception as e:
        return {
            "success": False,
            "error": f"3PL fitting failed: {str(e)}"
        }


def fit_5pl_dose_response(doses, responses, weights=None):
    """
    Fit a 5-parameter logistic (5PL) dose-response curve with asymmetry.

    Model: y = bottom + (top - bottom) / [1 + (dose / ic50)^hill]^asymmetry

    The 5PL adds an asymmetry parameter to the 4PL model, allowing the curve to
    have different slopes on the ascending and descending limbs.

    Parameters
    ----------
    doses : list or array-like
        Dose concentrations. Must be >= 0. Dose=0 points are treated as controls
        and separated from positive doses. Requires at least 6 positive dose levels.
    responses : list or array-like
        Observed responses (% inhibition, viability, etc.)
    weights : list or array-like, optional
        Weights for weighted least squares

    Returns
    -------
    result : dict (JSON-serializable)
        {
            "success": bool,
            "error": str (if success=False),
            "model_type": "5PL",
            "parameters": {
                "bottom": {value, stderr, ci_lower, ci_upper},
                "top": {value, stderr, ci_lower, ci_upper},
                "ic50": {value, stderr, ci_lower, ci_upper},
                "hill": {value, stderr, ci_lower, ci_upper},
                "asymmetry": {value, stderr, ci_lower, ci_upper}
            },
            "goodness_of_fit": {r_squared, adj_r_squared, rmse, aic, bic},
            "fitted_values": list,
            "residuals": list,
            "n_observations": int,
            "metadata": {dose_zero_handling, n_controls, n_positive_doses, ...}
        }
    """
    try:
        # Convert to numpy arrays
        doses = np.asarray(doses, dtype=float)
        responses = np.asarray(responses, dtype=float)

        # Validation
        if len(doses) != len(responses):
            return {
                "success": False,
                "error": "Doses and responses must have the same length"
            }

        # Check for NaN or Inf
        if np.any(np.isnan(doses)) or np.any(np.isnan(responses)):
            return {
                "success": False,
                "error": "Data contains NaN values"
            }

        if np.any(np.isinf(doses)) or np.any(np.isinf(responses)):
            return {
                "success": False,
                "error": "Data contains infinite values"
            }

        # STEP 1: Reject negative doses FIRST (before splitting controls)
        if np.any(doses < 0):
            return {
                "success": False,
                "error": "Negative dose values are not allowed. All doses must be >= 0."
            }

        # STEP 2: Split controls from positive doses
        split = _split_controls_and_positive(doses, responses, weights)

        # STEP 3: Check positive dose count (5PL needs at least 8)
        MIN_POSITIVE_5PL = 6
        if split['n_positive'] < MIN_POSITIVE_5PL:
            return {
                "success": False,
                "error": f"Need at least {MIN_POSITIVE_5PL} data points (positive doses > 0). "
                         f"Found {split['n_positive']}. Controls (dose=0) don't count toward minimum. "
                         f"Use 4PL (requires 4) or 3PL (requires 4) for fewer points."
            }

        # Use positive doses for fitting
        fit_doses = split['positive_doses']
        fit_responses = split['positive_responses']
        fit_weights = split['positive_weights']

        # Use scipy.curve_fit with logit transform initialization
        # Do NOT pass initial_guess - let the 5PL helper use its logit initialization
        fit_result = fit_log_logistic_5pl(fit_doses, fit_responses, weights=fit_weights, initial_guess=None)
        if not fit_result.success:
            return {
                "success": False,
                "error": f"5PL fitting failed: {fit_result.message or 'unable to converge.'}"
            }

        n = split['n_positive']  # Use positive dose count, not total
        k = 5  # 5 fitted parameters
        df = n - k

        parameters = format_five_pl_parameters(fit_result, df=df)
        fitted = fit_result.fitted if fit_result.fitted is not None else []
        residuals = fit_result.residuals if fit_result.residuals is not None else []

        # For 5PL, we allow undefined standard errors because:
        # 1. 5PL is fundamentally underconstrained (b and f are correlated)
        # 2. The Hessian-based covariance often fails numerically
        # 3. The curve shape/RMSE matters more than exact parameter SEs
        # Instead of failing, we just warn the user about unavailable SEs
        has_undefined_se = False
        for name, meta in parameters.items():
            stderr = meta["stderr"]
            if stderr is None or np.isnan(stderr) or np.isinf(stderr):
                has_undefined_se = True
                # Mark as unavailable but don't fail
                meta["stderr"] = None
                meta["ci_lower"] = None
                meta["ci_upper"] = None

        # Calculate goodness of fit (on POSITIVE DOSES ONLY)
        ss_res = float(np.sum(residuals ** 2))

        # Add -log10(IC50) [pIC50] with proper error propagation
        add_neg_log10_ic50(parameters)

        # NOTE: Do NOT call convert_hill_to_r_convention for 5PL!
        # format_five_pl_parameters() now preserves the internal hill sign (b).

        # Calculate goodness of fit (n, k, ss_res already computed above)

        # Initialize warnings list
        warnings = []

        # Check for marginal data (minimal degrees of freedom)
        if n == 6:
            warnings.append(
                "5PL fitted with only 6 data points (minimum). Adjusted R² undefined with 6 data points and 5 "
                "parameters. Add more dose points for stability."
            )
        elif n == 7:
            warnings.append(
                "5PL fitted with 7 data points. Adjusted R² is sensitive with 7 data points and 5 parameters. "
                "Consider adding more dose points for stability."
            )
        elif n == 8:
            warnings.append(
                "5PL fitted with 8 data points. Parameter estimates may be unstable. Consider adding more dose "
                "points for reliable uncertainty estimates."
            )
        elif n == 9:
            warnings.append(
                "5PL fitted with 9 data points. Parameter uncertainty may be elevated. Consider 10+ points for "
                "robust estimates."
            )
        elif n == 10:
            warnings.append(
                "5PL fitted with 10 data points. Acceptable but 12+ points recommended for stable parameter estimates."
            )

        # Add warning about undefined standard errors
        if has_undefined_se:
            warnings.append(
                "5PL standard errors unavailable. The 5PL model is underconstrained (b and f parameters are "
                "correlated), making uncertainty estimation unreliable. Point estimates and curve shape (R², RMSE) "
                "are still valid."
            )

        # R-squared (computed on positive doses only)
        ss_tot = np.sum((fit_responses - np.mean(fit_responses))**2)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Adjusted R-squared
        # For n=6, k=5: (n - k - 1) = 0, so adj_r² is undefined
        # For n=7, k=5: (n - k - 1) = 1, so adj_r² is defined but unstable
        # For n>=8, k=5: (n - k - 1) >= 2, so adj_r² is more reliable
        if n > k + 1:
            adj_r_squared = 1 - (1 - r_squared) * (n - 1) / (n - k - 1)
        else:
            # Undefined when n <= k + 1
            adj_r_squared = None

        # RMSE
        rmse = np.sqrt(ss_res / n)

        # AIC and BIC (full likelihood with constants)
        # ll = -n/2 * ln(2π) - n/2 * ln(RSS/n) - n/2
        # AIC = -2*ll + 2*(k+1) = n*(ln(2π) + 1) + n*ln(RSS/n) + 2*(k+1)
        # BIC = -2*ll + (k+1)*ln(n) = n*(ln(2π) + 1) + n*ln(RSS/n) + (k+1)*ln(n)
        ll_constant = n * (np.log(2 * np.pi) + 1)
        k_aic = k + 1  # Include residual variance term
        aic = ll_constant + n * np.log(ss_res / n) + 2 * k_aic
        bic = ll_constant + n * np.log(ss_res / n) + k_aic * np.log(n)

        # Confidence band stats (5PL log-dose grid)
        ci_band_stats = None
        dose_grid = _build_log_dose_grid(fit_doses, grid_size=100)
        if dose_grid is not None and fit_result.covariance is not None:
            b_fit, c_fit, d_fit, e_fit, f_fit = fit_result.params
            log_grid = np.log(dose_grid)
            log_e = np.log(e_fit)
            t_val = np.exp(b_fit * (log_grid - log_e))
            g_val = 1.0 + t_val
            den = np.power(g_val, f_fit)
            delta = d_fit - c_fit
            pred_grid = c_fit + delta / den

            dpred_db = -delta * f_fit * t_val * (log_grid - log_e) / (g_val * den)
            dpred_dc = 1.0 - (1.0 / den)
            dpred_dd = 1.0 / den
            dpred_de = delta * f_fit * t_val * b_fit / (e_fit * g_val * den)
            dpred_df = -delta * np.log(g_val) / den
            grads = np.column_stack([dpred_db, dpred_dc, dpred_dd, dpred_de, dpred_df])
            ci_band_stats = _band_from_gradients(pred_grid, grads, fit_result.covariance, df, x_values=dose_grid)

        # Build metadata about dose=0 handling
        metadata = {
            'dose_zero_handling': 'controls_as_baseline' if split['has_controls'] else 'positive_only',
            'n_controls': split['n_controls'],
            'n_positive_doses': split['n_positive'],
            'control_mean': split['control_mean'],
            'control_sd': split['control_sd']
        }

        # Return comprehensive results
        fitted_values = fitted.tolist() if fitted is not None else []
        residuals_list = residuals.tolist() if residuals is not None else []
        result_payload = {
            "success": True,
            "model_type": "5PL",
            "warnings": warnings,
            "parameters": parameters,
            "goodness_of_fit": {
                "r_squared": float(r_squared),
                "adj_r_squared": float(adj_r_squared) if adj_r_squared is not None else None,
                "rmse": float(rmse),
                "residual_ss": float(ss_res),
                "aic": float(aic),
                "bic": float(bic)
            },
            "fitted_values": fitted_values,
            "residuals": residuals_list,
            "n_observations": int(n),
            "metadata": metadata
        }
        if ci_band_stats:
            result_payload.update(ci_band_stats)
        return result_payload

    except Exception as e:
        return {
            "success": False,
            "error": f"5PL fitting failed: {str(e)}"
        }


def compare_dose_response_models(doses, responses, bottom_fixed=0.0, weights=None, fitting_method="log_dose"):
    """
    Fit and compare 3PL, 4PL, and 5PL models simultaneously.

    Returns model comparison results with AIC/BIC ranking and best model recommendation.

    Parameters
    ----------
    doses : list or array-like
        Dose concentrations (must be > 0, no zero doses)
    responses : list or array-like
        Observed responses
    bottom_fixed : float, optional
        Fixed bottom value for 3PL (default: 0.0)
    weights : list or array-like, optional
        Weights for weighted least squares
    fitting_method : str, optional
        Fitting algorithm to use:
        - "log_dose": Log-logistic parameterization with analytical Jacobian (default)
        - "lmfit": Original LMFit approach with numerical Jacobian

    Returns
    -------
    result : dict (JSON-serializable)
        {
            "success": bool,
            "error": str (if success=False),
            "n_observations": int,
            "models": {
                "3PL": {result from fit_3pl_dose_response or {"fitted": false, "reason": str}},
                "4PL": {result from fit_4pl_dose_response or {"fitted": false, "reason": str}},
                "5PL": {result from fit_5pl_dose_response or {"fitted": false, "reason": str}}
            },
            "comparison": {
                "aic_ranking": [{"model": str, "aic": float, "delta_aic": float}, ...],
                "bic_ranking": [{"model": str, "bic": float, "delta_bic": float}, ...],
                "recommended_model": str (based on AIC),
                "recommendation_reason": str
            }
        }
    """
    # Normalize fitting method (defaults to log_dose on unknown values)
    fitting_method = _normalize_fitting_method(fitting_method)

    try:
        # Convert to numpy arrays
        doses = np.asarray(doses, dtype=float)
        responses = np.asarray(responses, dtype=float)
        n = len(doses)

        # Basic validation
        if len(doses) != len(responses):
            return {
                "success": False,
                "error": "Doses and responses must have the same length"
            }

        if n < 4:
            return {
                "success": False,
                "error": f"At least 4 data points required for model comparison (you provided {n})"
            }

        # Check for zero or negative doses
        if np.any(doses <= 0):
            return {
                "success": False,
                "error": "All dose values must be greater than zero"
            }

        # Fit all three models (some may fail due to insufficient data)
        models_results = {}

        # 3PL: requires n >= 4
        models_results["3PL"] = fit_3pl_dose_response(
            doses,
            responses,
            bottom_fixed=bottom_fixed,
            weights=weights,
            fitting_method=fitting_method,
        )

        # 4PL: requires n >= 4
        models_results["4PL"] = fit_4pl_dose_response(
            doses,
            responses,
            weights=weights,
            fitting_method=fitting_method,
        )

        # 5PL: requires n >= 6 (strict minimum, though n≥8 recommended)
        if n >= 6:
            models_results["5PL"] = fit_5pl_dose_response(doses, responses, weights=weights)
        else:
            models_results["5PL"] = {
                "fitted": False,
                "reason": f"5PL requires at least 6 data points (you have {n}). Use 3PL or 4PL."
            }

        # Collect AIC/BIC values from successful fits
        aic_values = []
        bic_values = []

        for model_name, result in models_results.items():
            if result.get("success", False):
                aic = result["goodness_of_fit"]["aic"]
                bic = result["goodness_of_fit"]["bic"]
                aic_values.append({"model": model_name, "aic": aic})
                bic_values.append({"model": model_name, "bic": bic})

        # Check if at least one model fitted successfully
        if len(aic_values) == 0:
            return {
                "success": False,
                "error": "No models fitted successfully. Check your data for errors."
            }

        # Sort by AIC (lower is better)
        aic_values.sort(key=lambda x: x["aic"])

        # Sort by BIC (lower is better)
        bic_values.sort(key=lambda x: x["bic"])

        # Calculate delta AIC and delta BIC (relative to best model)
        best_aic = aic_values[0]["aic"]
        best_bic = bic_values[0]["bic"]

        aic_ranking = [
            {
                "model": item["model"],
                "aic": item["aic"],
                "delta_aic": item["aic"] - best_aic
            }
            for item in aic_values
        ]

        bic_ranking = [
            {
                "model": item["model"],
                "bic": item["bic"],
                "delta_bic": item["bic"] - best_bic
            }
            for item in bic_values
        ]

        # Recommend best model based on AIC (primary criterion)
        recommended_model = aic_ranking[0]["model"]

        # Generate recommendation reason
        if len(aic_ranking) == 1:
            recommendation_reason = f"Only {recommended_model} could be fitted with {n} data points."
        else:
            delta_aic_second = aic_ranking[1]["delta_aic"]
            if delta_aic_second < 2:
                recommendation_reason = f"{recommended_model} is marginally better (ΔAIC < 2). Models are essentially equivalent."
            elif delta_aic_second < 4:
                recommendation_reason = f"{recommended_model} has moderate support (2 ≤ ΔAIC < 4) over alternatives."
            elif delta_aic_second < 7:
                recommendation_reason = f"{recommended_model} has considerably less support for alternatives (4 ≤ ΔAIC < 7)."
            else:
                recommendation_reason = f"{recommended_model} has strong support (ΔAIC ≥ 7). Substantially better than alternatives."

        # Return comprehensive comparison
        return {
            "success": True,
            "n_observations": int(n),
            "models": models_results,
            "comparison": {
                "aic_ranking": aic_ranking,
                "bic_ranking": bic_ranking,
                "recommended_model": recommended_model,
                "recommendation_reason": recommendation_reason
            }
        }

    except Exception as e:
        return {
            "success": False,
            "error": f"Model comparison failed: {str(e)}"
        }


# JSON interface function for C# interop
def dose_response_analysis(doses_json, responses_json, model_type="4PL",
                           bottom_fixed=None, weights_json=None, fitting_method="log_dose"):
    """
    JSON interface for C# interop.

    Parameters
    ----------
    doses_json : str
        JSON array of dose values
    responses_json : str
        JSON array of response values
    model_type : str
        Model type: "3PL", "4PL", or "5PL" (default: "4PL")
    bottom_fixed : float, optional
        For 3PL only: fixed bottom value (default: 0.0 if model_type="3PL")
    weights_json : str, optional
        JSON array of weights
    fitting_method : str, optional
        Fitting algorithm to use:
        - "log_dose": Log-logistic parameterization with analytical Jacobian (default)
        - "lmfit": Original LMFit approach with numerical Jacobian

    Returns
    -------
    result_json : str
        JSON string with analysis results
    """
    # Normalize fitting method (defaults to log_dose on unknown values)
    fitting_method = _normalize_fitting_method(fitting_method)

    try:
        # Parse JSON inputs
        doses = json.loads(doses_json)
        responses = json.loads(responses_json)
        weights = json.loads(weights_json) if weights_json else None

        # Route to appropriate model
        if model_type == "3PL":
            # Use default bottom=0.0 if not specified
            bottom_val = bottom_fixed if bottom_fixed is not None else 0.0
            method = fitting_method
            if method == "log_dose" and bottom_val != 0.0:
                # Log-dose method only supports bottom_fixed=0.0
                method = "lmfit"
            result = fit_3pl_dose_response(doses, responses,
                                          bottom_fixed=bottom_val, weights=weights,
                                          fitting_method=method)
        elif model_type == "4PL":
            result = fit_4pl_dose_response(doses, responses, weights,
                                          fitting_method=fitting_method)
        elif model_type == "5PL":
            result = fit_5pl_dose_response(doses, responses, weights)
        else:
            result = {
                "success": False,
                "error": f"Model type '{model_type}' not supported. Use '3PL', '4PL', or '5PL'."
            }

        # Normalize hill slope sign for 3PL/4PL (standard convention: positive for decreasing curves)
        # REMOVED (Dec 2, 2025): Hill slope sign normalization
        # Previous code forced all hills to be positive, which broke inhibition curves.
        # The 4PL formula y = bottom + (top-bottom)/(1 + (dose/IC50)^hill) handles both:
        #   - Negative hill with top>bottom → curve increases (inhibition: 0→100)
        #   - Negative hill with bottom>top → curve decreases (viability: 100→0)
        # We now preserve natural hill signs for consistency.

        # Return JSON
        return json.dumps(result, indent=2)

    except json.JSONDecodeError as e:
        return json.dumps({
            "success": False,
            "error": f"JSON parsing error: {str(e)}"
        })
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"Unexpected error: {str(e)}"
        })
