"""
Minimal logistic fitting helpers for dose-response curves.

Implements 5-parameter log-logistic (LL.5) model:
- Self-starting parameter initialization (findcd + findbe1)
- BFGS optimization with central-difference gradients + parscale
- Parameterization: y = c + (d-c) / (1 + exp(b*(log(x)-log(e))))^f

VERSION: 3.0.0
DATE: December 16, 2025

CHANGES v3.0.0:
- Complete rewrite for numerical stability
- Switched from trust-region to BFGS optimizer
- Implemented parscale parameter scaling: scale = abs(start), min 1e-4 → 1
- Initial estimates: c = min(y) - 0.001*range, d = max(y) + 0.001*range
- Logit regression for hill and IC50 initialization: log((d-y)/(y-c)) ~ log(x)
- Internal b parameter (not negated) during optimization
- Reports hill_slope = -b for user-facing output
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple

import numpy as np
from scipy.stats import linregress


@dataclass
class FivePLFitResult:
    success: bool
    message: str = ""
    params: Optional[np.ndarray] = None
    covariance: Optional[np.ndarray] = None
    fitted: Optional[np.ndarray] = None
    residuals: Optional[np.ndarray] = None


def _findcd(y: np.ndarray) -> Tuple[float, float]:
    """
    Find initial c (bottom) and d (top) values from response data.

    Adds small margin (0.1% of range) to allow curve fitting at data extremes.
    """
    y_range = np.ptp(y)  # max - min
    margin = 0.001 * y_range
    c_val = float(np.min(y) - margin)
    d_val = float(np.max(y) + margin)
    return c_val, d_val


def _findbe1(x: np.ndarray, y: np.ndarray, c_val: float, d_val: float) -> Tuple[float, float]:
    """
    Find initial b (hill) and e (IC50) values using logit regression.

    Uses linear regression on logit-transformed data:
        log((d - y)/(y - c)) ~ log(x)

    Returns:
        b: Hill slope parameter (raw slope from regression)
        e: IC50/EC50 estimate

    Note: For inhibition curves (response decreases with dose), b < 0.
    Output reports hill_slope = -b (negated for user-facing display).
    """
    # Filter to positive doses only
    mask = x > 0
    x_pos = x[mask]
    y_pos = y[mask]

    if len(x_pos) < 2:
        # Fallback
        return 1.0, float(np.median(x[x > 0])) if np.any(x > 0) else 1.0

    # Compute logit transform: log((d - y) / (y - c))
    # Need to ensure valid values (numerator > 0 and denominator > 0)
    numerator = d_val - y_pos
    denominator = y_pos - c_val

    # Filter to valid points
    valid = (numerator > 0) & (denominator > 0)
    if np.sum(valid) < 2:
        # Fallback: use correlation to determine sign
        corr = np.corrcoef(x_pos, y_pos)[0, 1] if len(x_pos) > 1 else 0
        b_val = -1.0 if corr < 0 else 1.0
        e_val = float(np.exp(np.median(np.log(x_pos))))
        return b_val, e_val

    log_x = np.log(x_pos[valid])
    logit_y = np.log(numerator[valid] / denominator[valid])

    # Linear regression: logit_y ~ log_x
    try:
        slope, intercept, _, _, _ = linregress(log_x, logit_y)

        b_val = float(slope)

        # e = exp(-intercept / slope)
        if abs(slope) > 1e-10:
            e_val = float(np.exp(-intercept / slope))
        else:
            e_val = float(np.exp(np.median(log_x)))

        # Sanity check: constrain e to reasonable range
        dose_min = np.min(x_pos)
        dose_max = np.max(x_pos)
        e_val = np.clip(e_val, dose_min * 0.001, dose_max * 1000)

        return b_val, e_val

    except Exception:
        # Fallback
        corr = np.corrcoef(x_pos, y_pos)[0, 1] if len(x_pos) > 1 else 0
        b_val = -1.0 if corr < 0 else 1.0
        e_val = float(np.exp(np.median(np.log(x_pos))))
        return b_val, e_val


def _ll5_model(x: np.ndarray, b: float, c: float, d: float, e: float, f: float) -> np.ndarray:
    """
    5-parameter log-logistic model.

    Model: y = c + (d - c) / (1 + exp(b * (log(x) - log(e))))^f

    Parameters:
    - b: Hill slope (internal, not negated)
    - c: Bottom asymptote
    - d: Top asymptote
    - e: IC50/EC50
    - f: Asymmetry parameter
    """
    # Compute exponent term
    log_ratio = np.log(x) - np.log(e)
    exponent = np.exp(b * log_ratio)

    # Full model
    return c + (d - c) / np.power(1.0 + exponent, f)


def _objective_function(params: np.ndarray, x: np.ndarray, y: np.ndarray) -> float:
    """
    Objective function: sum of squared residuals (RSS).
    """
    b, c, d, e, f = params

    # Ensure e > 0 and f > 0 (positive constraints)
    if e <= 0 or f <= 0:
        return 1e10

    try:
        predicted = _ll5_model(x, b, c, d, e, f)
        residuals = y - predicted
        return float(np.sum(residuals ** 2))
    except Exception:
        return 1e10


def _compute_parscale(start_vec: np.ndarray) -> np.ndarray:
    """
    Compute parameter scaling for optimization.

    Uses absolute values with minimum threshold of 1e-4.
    """
    ps_vec = np.abs(start_vec)
    ps_vec[ps_vec < 1e-4] = 1.0
    return ps_vec


def _numerical_gradient_central(
    p_scaled: np.ndarray,
    fminfn,
    ndeps: np.ndarray,
) -> np.ndarray:
    """
    Central-difference numerical gradient for BFGS optimization.
    """
    grad = np.zeros_like(p_scaled)
    for i in range(len(p_scaled)):
        eps = float(ndeps[i])
        p_plus = p_scaled.copy()
        p_minus = p_scaled.copy()
        p_plus[i] += eps
        p_minus[i] -= eps
        val1 = fminfn(p_plus)
        val2 = fminfn(p_minus)
        grad[i] = (val1 - val2) / (2.0 * eps)
    return grad


def _optim_hessian_r(
    params: np.ndarray,
    fminfn,
    ndeps: np.ndarray,
    parscale: np.ndarray,
    fnscale: float = 1.0,
) -> np.ndarray:
    """
    Numerical Hessian using central differences of gradient.
    """
    n = len(params)
    hess = np.zeros((n, n), dtype=float)
    p_scaled = params / parscale
    for i in range(n):
        eps = float(ndeps[i] / parscale[i])
        p_scaled[i] += eps
        df1 = _numerical_gradient_central(p_scaled, fminfn, ndeps)
        p_scaled[i] -= 2.0 * eps
        df2 = _numerical_gradient_central(p_scaled, fminfn, ndeps)
        for j in range(n):
            hess[i, j] = fnscale * (df1[j] - df2[j]) / (2.0 * eps * parscale[i] * parscale[j])
        p_scaled[i] += eps
    # Symmetrize the Hessian
    hess = 0.5 * (hess + hess.T)
    return hess


def _r_optim_vmmin(
    start_scaled: np.ndarray,
    fminfn,
    fmingr,
    maxit: int,
    reltol: float,
    abstol: float,
) -> Tuple[np.ndarray, float, int, int, int]:
    """
    BFGS optimization implementation.
    Returns (params, fmin, fncount, grcount, iters).
    """
    stepredn = 0.2
    acctol = 1e-4
    reltest = 10.0

    n0 = len(start_scaled)
    mask = np.ones(n0, dtype=bool)
    idx = np.where(mask)[0]
    n = len(idx)

    b = start_scaled.copy()
    f = fminfn(b)
    if not np.isfinite(f):
        raise ValueError("Initial value in BFGS optimization is not finite.")

    fmin = f
    funcount = 1
    gradcount = 1
    g = fmingr(b)
    iters = 1
    ilast = gradcount

    B = np.eye(n)
    count = 0

    while True:
        if ilast == gradcount:
            B[:] = np.eye(n)

        X = b[idx].copy()
        c = g[idx].copy()
        gradproj = 0.0
        t = np.zeros(n)

        for i in range(n):
            s = -float(np.dot(B[i, :], g[idx]))
            t[i] = s
            gradproj += s * g[idx[i]]

        if gradproj < 0.0:
            steplength = 1.0
            accpoint = False
            while True:
                count = 0
                for i in range(n):
                    b[idx[i]] = X[i] + steplength * t[i]
                    if reltest + X[i] == reltest + b[idx[i]]:
                        count += 1

                if count < n:
                    f = fminfn(b)
                    funcount += 1
                    accpoint = np.isfinite(f) and (f <= fmin + gradproj * steplength * acctol)
                    if not accpoint:
                        steplength *= stepredn

                if count == n or accpoint:
                    break

            enough = (f > abstol) and (abs(f - fmin) > reltol * (abs(fmin) + reltol))
            if not enough:
                count = n
                fmin = f

            if count < n:
                fmin = f
                g = fmingr(b)
                gradcount += 1
                iters += 1

                t = steplength * t
                c = g[idx] - c
                d1 = float(np.dot(t, c))

                if d1 > 0.0:
                    xvec = B @ c
                    d2 = 1.0 + float(np.dot(c, xvec)) / d1
                    B += (d2 / d1) * np.outer(t, t) - (np.outer(xvec, t) + np.outer(t, xvec)) / d1
                else:
                    ilast = gradcount
            else:
                if ilast < gradcount:
                    count = 0
                    ilast = gradcount
        else:
            count = 0
            if ilast == gradcount:
                count = n
            else:
                ilast = gradcount

        if iters >= maxit:
            break
        if gradcount - ilast > 2 * n:
            ilast = gradcount
        if count == n and ilast == gradcount:
            break

    return b, fmin, funcount, gradcount, iters


def fit_log_logistic_5pl(
    doses: np.ndarray,
    responses: np.ndarray,
    weights: Optional[np.ndarray] = None,
    initial_guess: Optional[np.ndarray] = None,
) -> FivePLFitResult:
    """
    Fit the 5-parameter log-logistic model.

    Uses:
    - Self-starting parameter initialization (findcd + findbe1)
    - BFGS optimizer with central-difference gradients
    - Parameter scaling (parscale) for numerical stability

    Parameters
    ----------
    doses : array-like
        Positive dose concentrations (must be > 0).
    responses : array-like
        Observed responses.
    weights : array-like, optional
        Optional weights (not used currently, for API compatibility).
    initial_guess : array-like, optional
        Override initial parameter values [b, c, d, e, f].

    Returns
    -------
    FivePLFitResult
        Fit results with parameters [b, c, d, e, f].
    """
    doses = np.asarray(doses, dtype=float)
    responses = np.asarray(responses, dtype=float)

    if np.any(doses <= 0):
        return FivePLFitResult(False, "All dose values must be > 0 for 5PL fitting.")

    if len(doses) < 5:
        return FivePLFitResult(False, "At least 5 data points required for 5PL fitting.")

    # Step 1: Apply order-of-magnitude scaling to doses/responses
    # doseScaling = 10^(floor(log10(median(dose))))
    # respScaling = 10^(floor(log10(median(resp))))
    dose_median = np.median(doses)
    resp_median = np.median(responses)

    if dose_median > 0 and np.isfinite(dose_median):
        dose_scaling = 10 ** np.floor(np.log10(dose_median))
        if not np.isfinite(dose_scaling) or dose_scaling < 1e-15:
            dose_scaling = 1.0
    else:
        dose_scaling = 1.0

    if resp_median > 0 and np.isfinite(resp_median):
        resp_scaling = 10 ** np.floor(np.log10(resp_median))
        if not np.isfinite(resp_scaling) or resp_scaling < 1e-15:
            resp_scaling = 1.0
    else:
        resp_scaling = 1.0

    scaled_doses = doses / dose_scaling
    scaled_responses = responses / resp_scaling

    # Step 2: Get initial parameter values using self-starting on scaled data
    c_init, d_init = _findcd(scaled_responses)
    b_init, e_init = _findbe1(scaled_doses, scaled_responses, c_init, d_init)
    f_init = 1.0  # Start asymmetry parameter at 1.0 (symmetric case)

    # Initial parameter vector: [b, c, d, e, f]
    if initial_guess is not None and len(initial_guess) == 5:
        start_vec = np.asarray(initial_guess, dtype=float)
    else:
        start_vec = np.array([b_init, c_init, d_init, e_init, f_init])

    # Step 3: Compute parscale for numerical stability
    parscale = _compute_parscale(start_vec)

    # Step 4: Optimize using BFGS with parscale + central differences
    start_scaled = start_vec / parscale
    ndeps = np.full_like(start_vec, 1e-3)

    def fminfn(p_scaled: np.ndarray) -> float:
        params = p_scaled * parscale
        return _objective_function(params, scaled_doses, scaled_responses)

    def fmingr(p_scaled: np.ndarray) -> np.ndarray:
        return _numerical_gradient_central(p_scaled, fminfn, ndeps)

    try:
        p_scaled, fmin, _, _, iters = _r_optim_vmmin(
            start_scaled,
            fminfn,
            fmingr,
            maxit=500,
            reltol=1e-7,
            abstol=-np.inf,
        )

        if iters >= 500:
            return FivePLFitResult(False, "Optimization failed: max iterations reached.")

        # Transform back to original scale
        params_scaled = p_scaled * parscale
        b_fit, c_fit_s, d_fit_s, e_fit_s, f_fit = params_scaled
        c_fit = c_fit_s * resp_scaling
        d_fit = d_fit_s * resp_scaling
        e_fit = e_fit_s * dose_scaling
        params_final = np.array([b_fit, c_fit, d_fit, e_fit, f_fit], dtype=float)

    except Exception as ex:
        return FivePLFitResult(False, f"Optimization error: {str(ex)}")

    # Step 6: Compute fitted values and residuals (original scale)
    fitted = _ll5_model(doses, b_fit, c_fit, d_fit, e_fit, f_fit)
    residuals = responses - fitted

    # Step 7: Estimate covariance matrix
    try:
        # Hessian in scaled-data parameter space
        hessian_scaled = _optim_hessian_r(params_scaled, fminfn, ndeps, parscale)

        # Scale Hessian back to original parameter space
        long_scale_vec = np.array([1.0, resp_scaling, resp_scaling, dose_scaling, 1.0], dtype=float)
        scale_factor = 1.0 / np.outer(long_scale_vec / resp_scaling, long_scale_vec / resp_scaling)
        hessian_original = hessian_scaled * scale_factor

        # Residual variance (RSS/df) in original scale
        n = len(doses)
        k = 5
        dof = n - k
        rss = np.sum(residuals ** 2)
        res_var = rss / dof if dof > 0 else rss

        if res_var > 0 and np.all(np.isfinite(hessian_original)):
            cov_matrix = np.linalg.inv(hessian_original / (2.0 * res_var))
        else:
            cov_matrix = np.full((5, 5), np.nan)

    except Exception:
        cov_matrix = np.full((5, 5), np.nan)

    return FivePLFitResult(
        success=True,
        message="",
        params=params_final,
        covariance=cov_matrix,
        fitted=fitted,
        residuals=residuals
    )


def format_five_pl_parameters(
    fit: FivePLFitResult, confidence_level: float = 0.95, df: float | None = None
) -> Dict[str, Dict[str, float]]:
    """
    Convert the raw parameter vector into the dict structure used by dose_response.

    Note: hill_slope is reported as b (internal parameter sign).
    """
    if not fit.success or fit.params is None:
        raise ValueError("Cannot format parameters when fit was unsuccessful.")

    # Parameter order: b, c, d, e, f
    b, c, d, e, f = fit.params

    variances = np.diag(fit.covariance) if fit.covariance is not None else np.full(5, np.nan)
    std_errors = np.where(variances >= 0, np.sqrt(variances), np.nan)

    # Use t-distribution with df.residual for continuous outcomes.
    # Fall back to normal z when df is missing/invalid.
    try:
        from scipy.stats import t
        alpha = 1.0 - confidence_level
        if df is not None and df > 0:
            crit = t.ppf(1.0 - alpha / 2.0, df)
        else:
            crit = 1.96
    except Exception:
        crit = 1.96

    def ci(value, stderr):
        if stderr is None or np.isnan(stderr):
            return (None, None)
        return (
            float(value - crit * stderr),
            float(value + crit * stderr),
        )

    params_dict: Dict[str, Dict[str, float]] = {}

    # Hill slope uses internal sign (negative for activation, positive for inhibition)
    hill_value = b
    hill_stderr = std_errors[0] if not np.isnan(std_errors[0]) else None

    f_value = float(f)
    if np.isfinite(f_value):
        # Clamp to a reasonable range to keep outputs interpretable/stable.
        f_value = float(np.clip(f_value, 0.1, 10.0))

    entries = [
        ("bottom", c, std_errors[1]),
        ("top", d, std_errors[2]),
        ("ic50", e, std_errors[3]),
        ("hill", hill_value, hill_stderr),
        ("asymmetry", f_value, std_errors[4]),
    ]

    for name, value, stderr in entries:
        ci_low, ci_up = ci(value, stderr if stderr is not None and not np.isnan(stderr) else np.nan)
        params_dict[name] = {
            "value": float(value),
            "stderr": None if stderr is None or np.isnan(stderr) else float(stderr),
            "ci_lower": ci_low,
            "ci_upper": ci_up,
        }

    return params_dict
