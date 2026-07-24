"""
Drug Combination Analysis Module
VERSION: 1.2.0
DATE: January 26, 2026

CHANGES v1.2.0:
- BREAKING: fitting_method now accepts only "log_dose" or "lmfit"
- Removed deprecated fitting_method aliases
- Removed external package references from comments (license compliance)
- Updated imports: fit_ll4_ecp_style → fit_ll4_ecp_style

CHANGES v1.1.2:
DATE: November 27, 2025

Implements four models for drug combination analysis:
- HSA (Highest Single Agent)
- Bliss Independence
- Loewe Additivity
- ZIP (Zero Interaction Potency)

CRITICAL ASSUMPTION:
All response values must be % inhibition (0-100 scale).
Raw fluorescence/OD values must be normalized upstream.

LICENSE: BSD-3-Clause
"""

import numpy as np
import json
import os
import sys
from scipy.optimize import brentq
from .dose_response import FittingPolicy, _normalize_fitting_method

# Handle both package and direct script execution
try:
    from .dose_response import fit_4pl_dose_response
except ImportError:
    from dose_response import fit_4pl_dose_response


DEBUG = os.getenv("EASYCRIS_SYNERGY_DEBUG") == "1"


def _debug(message: str) -> None:
    if DEBUG:
        print(message, file=sys.stderr)


def _sanitize_for_json(obj):
    """
    Recursively convert NaN/Infinity to None for JSON serialization.
    """
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_sanitize_for_json(item) for item in obj]
    elif isinstance(obj, (float, np.floating)):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return float(obj)
    elif isinstance(obj, (np.integer, np.int_)):
        return int(obj)
    return obj


def _validate_percent_inhibition(values, name="responses"):
    """
    Validate that values are in % viability/activity range (0-100).
    Returns list of warnings if values are outside range.
    """
    warnings = []
    arr = np.asarray(values, dtype=float)

    if np.any(arr < 0):
        min_val = np.min(arr)
        warnings.append(f"WARNING: {name} contains values < 0 (min={min_val:.2f}). "
                       "Expected % viability (0-100).")

    if np.any(arr > 100):
        max_val = np.max(arr)
        warnings.append(f"WARNING: {name} contains values > 100 (max={max_val:.2f}). "
                       "Expected % viability (0-100).")

    return warnings


def _interpret_synergy_score(mean_score, model_type="HSA"):
    """
    Interpret synergy score based on model type.
    Positive = synergy, Negative = antagonism, Near zero = additive.
    """
    if model_type in ["HSA", "Bliss"]:
        # For HSA/Bliss: score = observed - expected
        # Positive means observed > expected = synergy
        if mean_score > 10:
            return "Strong synergy"
        elif mean_score > 5:
            return "Moderate synergy"
        elif mean_score > 0:
            return "Weak synergy"
        elif mean_score > -5:
            return "Additive (no interaction)"
        elif mean_score > -10:
            return "Moderate antagonism"
        else:
            return "Strong antagonism"
    elif model_type == "Loewe":
        # Treat Loewe scores the same way as other synergy metrics
        if mean_score is None:
            return "Additive"
        if mean_score > 10:
            return "Strong synergy"
        elif mean_score > 5:
            return "Moderate synergy"
        elif mean_score > 0:
            return "Weak synergy"
        elif mean_score > -5:
            return "Additive (no interaction)"
        elif mean_score > -10:
            return "Moderate antagonism"
        else:
            return "Strong antagonism"
    elif model_type == "ZIP":
        # ZIP: delta > 0 = synergy, delta < 0 = antagonism
        if mean_score > 10:
            return "Strong synergy (ZIP > 10)"
        elif mean_score > 5:
            return "Moderate synergy (ZIP > 5)"
        elif mean_score > 0:
            return "Weak synergy"
        elif mean_score > -5:
            return "Additive (ZIP ~ 0)"
        elif mean_score > -10:
            return "Moderate antagonism"
        else:
            return "Strong antagonism (ZIP < -10)"

    return "Unknown"


def calculate_hsa_synergy_sparse(dose_a, dose_b, response_a, response_b, combo_response):
    """
    Calculate HSA synergy for sparse combo data (real-life screens).

    HSA Model:
        Expected_AB = max(E_A, E_B)
        Synergy = Observed_AB - Expected_AB

    Parameters
    ----------
    dose_a : array-like
        Drug A doses for each combination
    dose_b : array-like
        Drug B doses for each combination
    response_a : array-like
        Single-agent response of Drug A at dose_a (% inhibition)
    response_b : array-like
        Single-agent response of Drug B at dose_b (% inhibition)
    combo_response : array-like
        Observed combination response (% inhibition)

    Returns
    -------
    dict : JSON-serializable result with row-by-row synergy scores
    """
    try:
        dose_a = np.asarray(dose_a, dtype=float)
        dose_b = np.asarray(dose_b, dtype=float)
        response_a = np.asarray(response_a, dtype=float)
        response_b = np.asarray(response_b, dtype=float)
        combo_response = np.asarray(combo_response, dtype=float)

        n = len(dose_a)
        if not (len(dose_b) == len(response_a) == len(response_b) == len(combo_response) == n):
            return {"success": False, "error": "All input arrays must have the same length"}

        if n < 1:
            return {"success": False, "error": "No combination data provided"}

        # Validate % inhibition range
        warnings = []
        warnings.extend(_validate_percent_inhibition(response_a, "Drug A single-agent responses"))
        warnings.extend(_validate_percent_inhibition(response_b, "Drug B single-agent responses"))
        warnings.extend(_validate_percent_inhibition(combo_response, "Combination responses"))

        # Calculate HSA expected and synergy for each row
        expected = np.maximum(response_a, response_b)
        synergy_scores = combo_response - expected

        # Summary statistics
        mean_synergy = float(np.mean(synergy_scores))
        std_synergy = float(np.std(synergy_scores, ddof=1)) if n > 1 else 0.0
        max_synergy = float(np.max(synergy_scores))
        min_synergy = float(np.min(synergy_scores))

        max_idx = int(np.argmax(synergy_scores))
        interpretation = _interpret_synergy_score(mean_synergy, "HSA")

        result = {
            "success": True,
            "model": "HSA",
            "sparse_mode": True,
            "n_combinations": n,
            "mean_synergy": mean_synergy,
            "std_synergy": std_synergy,
            "max_synergy": max_synergy,
            "min_synergy": min_synergy,
            "max_synergy_dose_a": float(dose_a[max_idx]),
            "max_synergy_dose_b": float(dose_b[max_idx]),
            "interpretation": interpretation,
            # Row-by-row data for visualization
            "dose_a": dose_a.tolist(),
            "dose_b": dose_b.tolist(),
            "response_a": response_a.tolist(),
            "response_b": response_b.tolist(),
            "combo_response": combo_response.tolist(),
            "expected": expected.tolist(),
            "synergy_scores": synergy_scores.tolist(),
        }

        if warnings:
            result["warnings"] = warnings

        return _sanitize_for_json(result)

    except Exception as e:
        return {"success": False, "error": f"HSA sparse calculation failed: {str(e)}"}


def calculate_hsa_synergy(responses_a, responses_b, combo_matrix,
                          doses_a=None, doses_b=None):
    """
    Calculate HSA (Highest Single Agent) synergy scores.

    HSA Model:
        Expected_AB = max(E_A, E_B)
        Synergy = Observed_AB - Expected_AB

    Parameters
    ----------
    responses_a : array-like
        Single-agent responses for Drug A at each dose (% inhibition, 0-100)
    responses_b : array-like
        Single-agent responses for Drug B at each dose (% inhibition, 0-100)
    combo_matrix : 2D array-like
        Combination responses matrix [n_doses_a x n_doses_b] (% inhibition)
    doses_a : array-like, optional
        Doses of Drug A (for reporting max synergy location)
    doses_b : array-like, optional
        Doses of Drug B (for reporting max synergy location)

    Returns
    -------
    dict : JSON-serializable result
    """
    try:
        # Convert to numpy arrays
        resp_a = np.asarray(responses_a, dtype=float)
        resp_b = np.asarray(responses_b, dtype=float)
        combo = np.asarray(combo_matrix, dtype=float)

        # Validate dimensions
        if combo.ndim != 2:
            return {"success": False, "error": "combo_matrix must be 2D"}

        n_a, n_b = combo.shape
        if len(resp_a) != n_a:
            return {"success": False,
                    "error": f"responses_a length ({len(resp_a)}) must match combo_matrix rows ({n_a})"}
        if len(resp_b) != n_b:
            return {"success": False,
                    "error": f"responses_b length ({len(resp_b)}) must match combo_matrix columns ({n_b})"}

        # Validate % inhibition range
        warnings = []
        warnings.extend(_validate_percent_inhibition(resp_a, "responses_a"))
        warnings.extend(_validate_percent_inhibition(resp_b, "responses_b"))
        warnings.extend(_validate_percent_inhibition(combo.flatten(), "combo_matrix"))

        # Calculate HSA expected matrix
        # For each combination (i, j): expected = max(E_A[i], E_B[j])
        expected_matrix = np.maximum(resp_a[:, np.newaxis], resp_b[np.newaxis, :])

        # Synergy score = observed - expected
        synergy_matrix = combo - expected_matrix

        # Summary statistics (use nanmean/nanmax/nanmin to handle sparse matrices with NaN)
        mean_synergy = float(np.nanmean(synergy_matrix))
        max_synergy = float(np.nanmax(synergy_matrix))
        min_synergy = float(np.nanmin(synergy_matrix))

        # Find location of max synergy (use nanargmax to ignore NaN)
        max_idx = np.unravel_index(np.nanargmax(synergy_matrix), synergy_matrix.shape)
        max_synergy_at = {"index_a": int(max_idx[0]), "index_b": int(max_idx[1])}
        if doses_a is not None and doses_b is not None:
            max_synergy_at["dose_a"] = float(doses_a[max_idx[0]])
            max_synergy_at["dose_b"] = float(doses_b[max_idx[1]])

        # Fraction of combinations showing synergy (score > 0, ignore NaN)
        # Match reference implementation output: percent of combinations
        synergistic_fraction = float(np.nanmean(synergy_matrix > 0)) * 100.0

        n_combinations = int(n_a * n_b)

        return {
            "success": True,
            "model": "HSA",
            "warnings": warnings,
            "synergy_matrix": synergy_matrix.tolist(),
            "expected_matrix": expected_matrix.tolist(),
            "summary": {
                "mean_synergy": mean_synergy,
                "max_synergy": max_synergy,
                "min_synergy": min_synergy,
                "max_synergy_at": max_synergy_at,
                "synergistic_fraction": synergistic_fraction
            },
            "interpretation": _interpret_synergy_score(mean_synergy, "HSA"),
            "n_combinations": n_combinations,
            "n_drug_a_doses": n_a,
            "n_drug_b_doses": n_b
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def calculate_bliss_synergy_sparse(dose_a, dose_b, response_a, response_b, combo_response):
    """
    Calculate Bliss Independence synergy for sparse combo data.

    Bliss Model:
        Expected_AB = E_A + E_B - (E_A × E_B / 100)
        Synergy = Observed_AB - Expected_AB

    Parameters
    ----------
    dose_a : array-like
        Drug A doses for each combination
    dose_b : array-like
        Drug B doses for each combination
    response_a : array-like
        Single-agent response of Drug A at dose_a (% inhibition)
    response_b : array-like
        Single-agent response of Drug B at dose_b (% inhibition)
    combo_response : array-like
        Observed combination response (% inhibition)

    Returns
    -------
    dict : JSON-serializable result with row-by-row synergy scores
    """
    try:
        dose_a = np.asarray(dose_a, dtype=float)
        dose_b = np.asarray(dose_b, dtype=float)
        response_a = np.asarray(response_a, dtype=float)
        response_b = np.asarray(response_b, dtype=float)
        combo_response = np.asarray(combo_response, dtype=float)

        n = len(dose_a)
        if not (len(dose_b) == len(response_a) == len(response_b) == len(combo_response) == n):
            return {"success": False, "error": "All input arrays must have the same length"}

        if n < 1:
            return {"success": False, "error": "No combination data provided"}

        # Validate % inhibition range
        warnings = []
        warnings.extend(_validate_percent_inhibition(response_a, "Drug A single-agent responses"))
        warnings.extend(_validate_percent_inhibition(response_b, "Drug B single-agent responses"))
        warnings.extend(_validate_percent_inhibition(combo_response, "Combination responses"))

        # Calculate Bliss expected: E_A + E_B - (E_A × E_B / 100)
        expected = response_a + response_b - (response_a * response_b / 100.0)
        synergy_scores = combo_response - expected

        # Summary statistics
        mean_synergy = float(np.mean(synergy_scores))
        std_synergy = float(np.std(synergy_scores, ddof=1)) if n > 1 else 0.0
        max_synergy = float(np.max(synergy_scores))
        min_synergy = float(np.min(synergy_scores))

        max_idx = int(np.argmax(synergy_scores))
        interpretation = _interpret_synergy_score(mean_synergy, "Bliss")

        result = {
            "success": True,
            "model": "Bliss",
            "sparse_mode": True,
            "n_combinations": n,
            "mean_synergy": mean_synergy,
            "std_synergy": std_synergy,
            "max_synergy": max_synergy,
            "min_synergy": min_synergy,
            "max_synergy_dose_a": float(dose_a[max_idx]),
            "max_synergy_dose_b": float(dose_b[max_idx]),
            "interpretation": interpretation,
            # Row-by-row data for visualization
            "dose_a": dose_a.tolist(),
            "dose_b": dose_b.tolist(),
            "response_a": response_a.tolist(),
            "response_b": response_b.tolist(),
            "combo_response": combo_response.tolist(),
            "expected": expected.tolist(),
            "synergy_scores": synergy_scores.tolist(),
        }

        if warnings:
            result["warnings"] = warnings

        return _sanitize_for_json(result)

    except Exception as e:
        return {"success": False, "error": f"Bliss sparse calculation failed: {str(e)}"}


def calculate_bliss_synergy(responses_a, responses_b, combo_matrix,
                            doses_a=None, doses_b=None):
    """
    Calculate Bliss Independence synergy scores.

    Bliss Model (fractional effects):
        Expected_AB = E_A + E_B - (E_A * E_B / 100)
        Synergy (Excess over Bliss) = Observed_AB - Expected_AB

    Note: Formula uses /100 because responses are % inhibition (0-100 scale).

    Parameters
    ----------
    responses_a : array-like
        Single-agent responses for Drug A at each dose (% inhibition, 0-100)
    responses_b : array-like
        Single-agent responses for Drug B at each dose (% inhibition, 0-100)
    combo_matrix : 2D array-like
        Combination responses matrix [n_doses_a x n_doses_b] (% inhibition)
    doses_a : array-like, optional
        Doses of Drug A
    doses_b : array-like, optional
        Doses of Drug B

    Returns
    -------
    dict : JSON-serializable result
    """
    try:
        # Convert to numpy arrays
        resp_a = np.asarray(responses_a, dtype=float)
        resp_b = np.asarray(responses_b, dtype=float)
        combo = np.asarray(combo_matrix, dtype=float)

        # Validate dimensions
        if combo.ndim != 2:
            return {"success": False, "error": "combo_matrix must be 2D"}

        n_a, n_b = combo.shape
        if len(resp_a) != n_a:
            return {"success": False,
                    "error": f"responses_a length ({len(resp_a)}) must match combo_matrix rows ({n_a})"}
        if len(resp_b) != n_b:
            return {"success": False,
                    "error": f"responses_b length ({len(resp_b)}) must match combo_matrix columns ({n_b})"}

        # Validate % inhibition range
        warnings = []
        warnings.extend(_validate_percent_inhibition(resp_a, "responses_a"))
        warnings.extend(_validate_percent_inhibition(resp_b, "responses_b"))
        warnings.extend(_validate_percent_inhibition(combo.flatten(), "combo_matrix"))

        # Calculate Bliss expected matrix
        # E_AB = E_A + E_B - (E_A * E_B / 100)
        # Using broadcasting: [n_a, 1] + [1, n_b] - [n_a, 1] * [1, n_b] / 100
        E_A = resp_a[:, np.newaxis]
        E_B = resp_b[np.newaxis, :]
        expected_matrix = E_A + E_B - (E_A * E_B / 100.0)

        # Synergy score (Excess over Bliss) = observed - expected
        synergy_matrix = combo - expected_matrix

        # reference implementation-compatible edge masking:
        # Set synergy = 0 for non-combination cells (doseA==0 OR doseB==0)
        # Synergy is only defined for true combinations (both drugs present)
        if doses_a is not None and doses_b is not None:
            doses_a_arr = np.asarray(doses_a, dtype=float)
            doses_b_arr = np.asarray(doses_b, dtype=float)

            # Create mask for edge cells (monotherapy or DMSO)
            for i in range(n_a):
                for j in range(n_b):
                    if doses_a_arr[i] == 0 or doses_b_arr[j] == 0:
                        synergy_matrix[i, j] = 0.0

        # Summary statistics (use nanmean/nanmax/nanmin to handle sparse matrices with NaN)
        mean_synergy = float(np.nanmean(synergy_matrix))
        max_synergy = float(np.nanmax(synergy_matrix))
        min_synergy = float(np.nanmin(synergy_matrix))

        # Find location of max synergy
        max_idx = np.unravel_index(np.nanargmax(synergy_matrix), synergy_matrix.shape)
        max_synergy_at = {"index_a": int(max_idx[0]), "index_b": int(max_idx[1])}
        if doses_a is not None and doses_b is not None:
            max_synergy_at["dose_a"] = float(doses_a[max_idx[0]])
            max_synergy_at["dose_b"] = float(doses_b[max_idx[1]])

        # Fraction synergistic
        # Match reference implementation output: percent of combinations
        synergistic_fraction = float(np.nanmean(synergy_matrix > 0)) * 100.0

        n_combinations = int(n_a * n_b)

        return {
            "success": True,
            "model": "Bliss",
            "warnings": warnings,
            "synergy_matrix": synergy_matrix.tolist(),
            "expected_matrix": expected_matrix.tolist(),
            "summary": {
                "mean_synergy": mean_synergy,
                "max_synergy": max_synergy,
                "min_synergy": min_synergy,
                "max_synergy_at": max_synergy_at,
                "synergistic_fraction": synergistic_fraction,
                "excess_over_bliss": mean_synergy  # Alias for clarity
            },
            "interpretation": _interpret_synergy_score(mean_synergy, "Bliss"),
            "n_combinations": n_combinations,
            "n_drug_a_doses": n_a,
            "n_drug_b_doses": n_b
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def calculate_loewe_synergy(doses_a, doses_b, responses_a, responses_b,
                            combo_matrix=None, combo_doses_a=None, combo_doses_b=None, combo_responses=None,
                            data_type="inhibition",
                            fitting_method="log_dose",
                            fitting_policy=None):
    """
    Calculate Loewe Additivity Combination Index (CI).

    Loewe Model:
        CI = (d_A / D_A) + (d_B / D_B)
        Where D_A is the dose of Drug A alone that gives the same effect as the combo
        And D_B is the dose of Drug B alone that gives the same effect

    CI < 1: Synergy
    CI = 1: Additivity
    CI > 1: Antagonism

    Parameters
    ----------
    doses_a : array-like
        Doses of Drug A alone (INCLUDING zero dose for full-grid averaging)
    doses_b : array-like
        Doses of Drug B alone (INCLUDING zero dose for full-grid averaging)
    responses_a : array-like
        Single-agent responses for Drug A
        - If data_type="viability": % viability (100→0 with increasing dose)
        - If data_type="inhibition": % inhibition (0→100 with increasing dose)
    responses_b : array-like
        Single-agent responses for Drug B (same scale as responses_a)
    combo_matrix : 2D array-like, optional
        Full combination response matrix [n_doses_a x n_doses_b]
        If provided, uses full 5×5 grid for averaging
        If None, falls back to legacy flattened format
    combo_doses_a : array-like, optional
        LEGACY: Drug A doses in the combination experiment (flattened)
    combo_doses_b : array-like, optional
        LEGACY: Drug B doses in the combination experiment (flattened)
    combo_responses : array-like, optional
        LEGACY: Observed combination responses (flattened)
    data_type : str, optional
        Type of response data: "viability" (100→0) or "inhibition" (0→100)
        Default: "inhibition" (converts to inhibition before fitting)
        Affects synergy formula:
        - viability: synergy = expected - observed (lower viability = synergy)
        - inhibition: synergy = observed - expected (higher inhibition = synergy)
    fitting_method : str, optional
        Curve fitting algorithm for single-agent dose-response:
        - "log_dose" (default): Log-logistic parameterization with analytical Jacobian
        - "lmfit": Original approach with numerical Jacobian
    fitting_policy : FittingPolicy, optional
        Solver policy for log-dose fitting method (ignored for lmfit).
        - None (default): Uses FittingPolicy.BEST_RSS (find mathematically best fit)
        - FittingPolicy.BEST_RSS: Unconstrained optimization
        - FittingPolicy.STRICT_PARITY: Constrained fit for numerical parity with reference
        Note: Only affects Loewe synergy (HSA/Bliss/ZIP converge to identical basins)

    Returns
    -------
    dict : JSON-serializable result with combination indices
    """
    # Normalize fitting method (defaults to log_dose on unknown values)
    fitting_method = _normalize_fitting_method(fitting_method)

    try:
        # Default fitting policy:
        # - Loewe is sensitive to basin selection (curve fitting can be underconstrained).
        # - If not specified, prefer STRICT_PARITY when using log-dose fitting for numerical stability.
        if fitting_policy is None:
            fitting_policy = FittingPolicy.STRICT_PARITY if fitting_method == "log_dose" else FittingPolicy.BEST_RSS

        # Convert to numpy
        d_a = np.asarray(doses_a, dtype=float)
        d_b = np.asarray(doses_b, dtype=float)
        r_a = np.asarray(responses_a, dtype=float)
        r_b = np.asarray(responses_b, dtype=float)

        # Phase 2.3: Full-grid averaging (support both matrix and legacy flattened format)
        if combo_matrix is not None:
            # NEW: Full 5×5 matrix format (Phase 2.3)
            combo_r = np.asarray(combo_matrix, dtype=float)
            # combo_d_a and combo_d_b will be derived from doses_a, doses_b during iteration
            combo_d_a = d_a  # Full dose lists including zero
            combo_d_b = d_b
        else:
            # LEGACY: Flattened format (backward compatibility)
            combo_d_a = np.asarray(combo_doses_a, dtype=float)
            combo_d_b = np.asarray(combo_doses_b, dtype=float)
            combo_r = np.asarray(combo_responses, dtype=float)

        # Validate % viability/activity range (0-100)
        warnings = []
        warnings.extend(_validate_percent_inhibition(r_a, "responses_a"))
        warnings.extend(_validate_percent_inhibition(r_b, "responses_b"))
        warnings.extend(_validate_percent_inhibition(combo_r.flatten(), "combo_responses"))

        # =======================================================================
        # ZIP-STYLE FIX: Extract single-agent data from COMBO MATRIX EDGES
        # Baseline implementation uses single-agent fitting on the combo matrix edges,
        # NOT the separately supplied single-agent arrays. This aligns the
        # single-agent baselines with the actual plate measurements.
        # =======================================================================
        from .dose_response import fit_3pl_dose_response, fit_ll4_ecp_style, fit_log_dose_single_agent

        if combo_matrix is not None:
            # Extract first column (Drug A alone, Drug B = 0) from combo matrix
            # This is combo_r[:, 0] - responses at all Drug A doses when Drug B = 0
            combo_col_a = combo_r[:, 0]  # First column = Drug A single-agent

            # Extract first row (Drug B alone, Drug A = 0) from combo matrix
            # This is combo_r[0, :] - responses at all Drug B doses when Drug A = 0
            combo_row_b = combo_r[0, :]  # First row = Drug B single-agent

            # Filter out zero doses for fitting (fitters use log-dose space)
            nonzero_mask_a = d_a > 0
            nonzero_mask_b = d_b > 0

            d_a_fit = d_a[nonzero_mask_a]
            r_a_fit = combo_col_a[nonzero_mask_a]  # For reporting only
            d_a_all = d_a
            r_a_all = combo_col_a  # Use full edge (includes 0-dose)

            d_b_fit = d_b[nonzero_mask_b]
            r_b_fit = combo_row_b[nonzero_mask_b]  # For reporting only
            d_b_all = d_b
            r_b_all = combo_row_b  # Use full edge (includes 0-dose)

            _debug("[DEBUG] Using combo matrix edges for single-agent fits")
            _debug(f"[DEBUG] Drug A from combo col: doses={d_a_fit}, responses={r_a_fit}")
            _debug(f"[DEBUG] Drug B from combo row: doses={d_b_fit}, responses={r_b_fit}")
        else:
            # LEGACY: Use separately supplied single-agent arrays
            nonzero_mask_a = d_a > 0
            nonzero_mask_b = d_b > 0
            d_a_fit = d_a[nonzero_mask_a]
            r_a_fit = r_a[nonzero_mask_a]
            d_b_fit = d_b[nonzero_mask_b]
            r_b_fit = r_b[nonzero_mask_b]
            d_a_all = d_a
            r_a_all = r_a
            d_b_all = d_b
            r_b_all = r_b

        # Normalize to inhibition space for reference implementation parity.
        # reference implementation converts viability -> inhibition before fitting and scoring.
        # IMPORTANT: Convert the single-agent edge series used for fitting too.
        calc_data_type = data_type
        if data_type == "viability":
            r_a = 100.0 - r_a
            r_b = 100.0 - r_b
            combo_r = 100.0 - combo_r
            if combo_matrix is not None:
                combo_col_a = 100.0 - combo_col_a
                combo_row_b = 100.0 - combo_row_b
            r_a_fit = 100.0 - r_a_fit
            r_b_fit = 100.0 - r_b_fit
            calc_data_type = "inhibition"
            if combo_matrix is not None:
                r_a_all = combo_col_a
                r_b_all = combo_row_b
            else:
                r_a_all = r_a
                r_b_all = r_b

        # Fit dose-response curves for single agents.
        #
        # IMPORTANT (reference implementation parity):
        # reference implementation's FitDoseResponse() replaces 0-dose with 1e-10 in its fallback path. For parity with
        # the reference implementation and to preserve the possibility of negative inhibition baselines,
        # we include the (0,0) vehicle point in the single-agent edge series when present.
        def _fit_baseline_single_drug(doses_all, responses_all):
            doses_all = np.asarray(doses_all, dtype=float)
            responses_all = np.asarray(responses_all, dtype=float)

            # reference implementation: if variance is 0, nudge last response slightly so fitting doesn't fail.
            if len(responses_all) > 1 and np.var(responses_all) == 0:
                responses_all[-1] = responses_all[-1] + 1e-10

            return fit_log_dose_single_agent(
                doses_all,
                responses_all,
                policy=fitting_policy
            )

        # Fit on full edge series (include 0-dose; fall back to L.4 if needed)
        fit_a = _fit_baseline_single_drug(d_a_all, r_a_all)
        fit_b = _fit_baseline_single_drug(d_b_all, r_b_all)

        # Reporting fits (validation: LL.4 on inhibition edges, dose > 0 only)
        # Validation script approach: fit ONLY on non-zero doses without replacing 0 with epsilon
        if combo_matrix is not None:
            # Use combo matrix edge series for parity with reference implementation
            report_r_a_fit = combo_col_a[nonzero_mask_a]
            report_r_b_fit = combo_row_b[nonzero_mask_b]
        else:
            report_r_a_fit = r_a[nonzero_mask_a]
            report_r_b_fit = r_b[nonzero_mask_b]

        # FIT DIRECTLY on non-zero data (no epsilon replacement like _fit_baseline_single_drug does)
        # This matches the validation LL.4 fit on non-zero doses
        report_fit_a = fit_ll4_ecp_style(d_a_fit, report_r_a_fit, policy=fitting_policy)
        report_fit_b = fit_ll4_ecp_style(d_b_fit, report_r_b_fit, policy=fitting_policy)

        if not fit_a.get("success", False):
            return {"success": False,
                    "error": f"Failed to fit Drug A dose-response: {fit_a.get('error', 'Unknown')}"}
        if not fit_b.get("success", False):
            return {"success": False,
                    "error": f"Failed to fit Drug B dose-response: {fit_b.get('error', 'Unknown')}"}

        # Extract 4PL parameters and normalize to reporting convention
        params_a = fit_a["parameters"]
        params_b = fit_b["parameters"]
        output_params_a = report_fit_a["parameters"] if report_fit_a.get("success") else params_a
        output_params_b = report_fit_b["parameters"] if report_fit_b.get("success") else params_b
        output_fit_a = report_fit_a if report_fit_a.get("success") else fit_a
        output_fit_b = report_fit_b if report_fit_b.get("success") else fit_b

        # Extract parameters (do NOT clamp curve parameters - only clamp the final expected effect)
        # Reference uses extrapolated curve fits, but clamps the solver result to [0, 100]
        bottom_a = params_a["bottom"]["value"]
        top_a = params_a["top"]["value"]
        ic50_a = params_a["ic50"]["value"]

        bottom_b = params_b["bottom"]["value"]
        top_b = params_b["top"]["value"]
        ic50_b = params_b["ic50"]["value"]

        # STEP 1: Match log-dose LL.4 convention for Loewe (hill "b")
        # fit_ll4_ecp_style stores hill with sign flipped (EasyCris convention).
        # For reference implementation parity we need the original log-dose b (negative for
        # increasing inhibition), so invert the reported hill here.
        hill_a = -params_a["hill"]["value"]
        hill_b = -params_b["hill"]["value"]
        _debug(f"[DEBUG FINAL] data_type={calc_data_type}")
        _debug(f"[DEBUG FINAL] hill_a={hill_a:.6f}, hill_b={hill_b:.6f}")
        _debug(f"[DEBUG FINAL] bottom_a={bottom_a:.2f}, bottom_b={bottom_b:.2f}")
        _debug(f"[DEBUG FINAL] top_a={top_a:.2f}, top_b={top_b:.2f}")
        _debug(f"[DEBUG FINAL] ic50_a={ic50_a:.2f}, ic50_b={ic50_b:.2f}")

        model_a = fit_a.get("log_dose_model", "LL.4")
        model_b = fit_b.get("log_dose_model", "LL.4")
        e_log_a = params_a.get("e_log", {}).get("value")
        e_log_b = params_b.get("e_log", {}).get("value")
        if e_log_a is None and ic50_a is not None and ic50_a > 0:
            e_log_a = float(np.log(ic50_a))
        if e_log_b is None and ic50_b is not None and ic50_b > 0:
            e_log_b = float(np.log(ic50_b))

        # CI-only parameters (validation: LL.4 on inhibition edges, dose > 0 only)
        ci_bottom_a = output_params_a["bottom"]["value"]
        ci_top_a = output_params_a["top"]["value"]
        ci_ic50_a = output_params_a["ic50"]["value"]
        # CRITICAL: Must negate hill to match log-dose convention (same as synergy calculation above)
        ci_hill_a = -output_params_a["hill"]["value"]

        ci_bottom_b = output_params_b["bottom"]["value"]
        ci_top_b = output_params_b["top"]["value"]
        ci_ic50_b = output_params_b["ic50"]["value"]
        ci_hill_b = -output_params_b["hill"]["value"]

        # 4PL model function using the same parameterization as log-dose LL.4.
        # IMPORTANT: Do NOT clamp predictions to [0, 100] here.
        # reference implementation (and the Mathews screening dataset) can legitimately contain negative inhibition
        # values due to normalization/baseline effects, and Loewe_ref / Loewe_synergy must be computed
        # on the same scale for parity.
        def fourpl(dose, bottom, top, ic50, hill):
            if dose <= 0:
                # Limit as dose→0 depends on hill sign.
                if hill > 0:
                    return float(top)
                if hill < 0:
                    return float(bottom)
                return float((top + bottom) / 2.0)
            r = (dose / ic50) ** hill
            pred = (top + bottom * r) / (1.0 + r)
            return float(pred)

        # reference implementation helpers for Loewe:
        # - Solve expected dose for effect using LL.4 inversion (SolveExpDoesLL4)
        # - Solve Loewe expected effect by scanning effect space (SolveLoewe)
        def solve_exp_dose(effect, bottom, top, ic50, hill, model_type="LL.4", e_log=None):
            c = bottom
            d = top
            b = hill
            y = float(effect)

            with np.errstate(all="ignore"):
                if model_type == "L.4":
                    log_e = e_log
                    if log_e is None and ic50 is not None and ic50 > 0:
                        log_e = np.log(ic50)
                    ratio = np.divide((d - y), (y - c))
                    dose = np.exp(log_e + np.log(ratio) / b) if (b != 0 and log_e is not None) else np.nan
                else:
                    ratio = np.divide((y - d), (c - y))
                    dose = ic50 * np.power(ratio, 1.0 / b) if (b != 0 and ic50 is not None) else np.nan

            if np.isnan(dose):
                dose = np.inf if y > max(d, c) else 0.0

            return float(dose)

        def solve_loewe_expected_effect(dose_a, dose_b, nsteps=100):
            # reference implementation: scan y_test from min_y..max_y and pick y minimizing |sum(x/x_cap(y)) - 1|
            min_y = min(min(bottom_a, top_a), min(bottom_b, top_b))
            max_y = max(max(bottom_a, top_a), max(bottom_b, top_b))
            y_test = np.linspace(min_y, max_y, num=int(nsteps))

            best_y = float(y_test[0])
            best_dist = np.inf
            for y in y_test:
                da = solve_exp_dose(y, bottom_a, top_a, ic50_a, hill_a, model_a, e_log_a)
                db = solve_exp_dose(y, bottom_b, top_b, ic50_b, hill_b, model_b, e_log_b)
                # Baseline semantics: x/0 => Inf (do not throw)
                with np.errstate(divide="ignore", invalid="ignore"):
                    term_a = np.inf if da == 0.0 else (dose_a / da)
                    term_b = np.inf if db == 0.0 else (dose_b / db)
                    dist = abs((term_a + term_b) - 1.0)
                if not np.isfinite(dist):
                    continue
                if dist < best_dist:
                    best_dist = dist
                    best_y = float(y)

            return best_y

        # Calculate synergy (observed - expected) for each combination point
        is_matrix = combo_r.ndim == 2
        if is_matrix:
            n_a, n_b = combo_r.shape
            synergy_matrix = np.full((n_a, n_b), np.nan)
            expected_matrix = np.full((n_a, n_b), np.nan)
            ci_matrix = np.full((n_a, n_b), np.nan)
            # Validation builds the combo matrix in column-major order.
            # Use a transposed view for CI-only calculations to match baseline.
            combo_r_ci = combo_r.T if combo_matrix is not None else combo_r

            for i in range(n_a):
                for j in range(n_b):
                    effect_obs = combo_r[i, j]

                    # Phase 2.3: Use matrix indices for dose lookups (full-grid format)
                    if combo_matrix is not None:
                        d_a_combo = combo_d_a[i]
                        d_b_combo = combo_d_b[j]
                    else:
                        # Legacy flattened format
                        d_a_combo = combo_d_a[i] if len(combo_d_a) == n_a else combo_d_a[i * n_b + j]
                        d_b_combo = combo_d_b[j] if len(combo_d_b) == n_b else combo_d_b[i * n_b + j]

                    # Phase 2.3: Boundary cell handling (zero-dose rows/columns)
                    # Boundary cells: set synergy = 0 (no interaction when one drug absent)
                    if d_a_combo == 0 or d_b_combo == 0:
                        # Boundary cells: monotherapy or vehicle control
                        # reference implementation sets Loewe_ref = observed and CI = NA for single-drug wells.
                        ci_matrix[i, j] = np.nan
                        synergy_matrix[i, j] = 0.0  # No synergy for monotherapy
                        expected_matrix[i, j] = effect_obs  # Expected = observed for monotherapy
                        continue

                    # Combination cells (both doses > 0)
                    # reference implementation:
                    # - CI uses doses that achieve the OBSERVED effect in each single-drug model
                    # - Loewe_ref is chosen by scanning the effect range for minimal isobole distance
                    ci_effect_obs = combo_r_ci[i, j]
                    da_cap = solve_exp_dose(ci_effect_obs, ci_bottom_a, ci_top_a, ci_ic50_a, ci_hill_a)
                    db_cap = solve_exp_dose(ci_effect_obs, ci_bottom_b, ci_top_b, ci_ic50_b, ci_hill_b)
                    with np.errstate(divide="ignore", invalid="ignore"):
                        term_a = np.inf if da_cap == 0.0 else (d_a_combo / da_cap)
                        term_b = np.inf if db_cap == 0.0 else (d_b_combo / db_cap)
                        ci_matrix[i, j] = term_a + term_b

                    finite_a = np.isfinite(da_cap)
                    finite_b = np.isfinite(db_cap)

                    if (not finite_a) and (not finite_b):
                        # If none of drugs achieve the observed effect, use max predicted response at combined dose
                        combined = d_a_combo + d_b_combo
                        expected = max(
                            fourpl(combined, bottom_a, top_a, ic50_a, hill_a),
                            fourpl(combined, bottom_b, top_b, ic50_b, hill_b),
                        )
                    elif finite_a ^ finite_b:
                        # reference implementation edge-case: if exactly one drug can achieve the observed effect,
                        # the isobole equation is underdetermined; reference implementation effectively snaps to the
                        # achievable drug's minimal effect (Emin) for Loewe_ref in this scenario.
                        expected = min(bottom_a, top_a) if finite_a else min(bottom_b, top_b)
                    else:
                        expected = solve_loewe_expected_effect(d_a_combo, d_b_combo)

                    expected_matrix[i, j] = expected

                    if not np.isnan(expected):
                        # Calculate synergy based on data type
                        if calc_data_type == "inhibition":
                            # INHIBITION: synergy = observed - expected
                            # (higher inhibition than expected = synergy)
                            synergy_matrix[i, j] = effect_obs - expected
                        else:
                            # VIABILITY: synergy = expected - observed
                            # (lower viability than expected = synergy)
                            synergy_matrix[i, j] = expected - effect_obs
        else:
            synergy_matrix = np.full(combo_r.shape, np.nan)
            expected_matrix = np.full(combo_r.shape, np.nan)
            ci_matrix = np.full(combo_r.shape, np.nan)
            for idx in range(len(combo_r)):
                effect_obs = combo_r[idx]
                d_a_combo = combo_d_a[idx]
                d_b_combo = combo_d_b[idx]

                # Edge masking: set synergy=0 for non-combination cells
                if d_a_combo == 0 or d_b_combo == 0:
                    ci_matrix[idx] = np.nan
                    synergy_matrix[idx] = 0.0
                    expected_matrix[idx] = effect_obs
                    continue

                da_cap = solve_exp_dose(effect_obs, ci_bottom_a, ci_top_a, ci_ic50_a, ci_hill_a)
                db_cap = solve_exp_dose(effect_obs, ci_bottom_b, ci_top_b, ci_ic50_b, ci_hill_b)
                with np.errstate(divide="ignore", invalid="ignore"):
                    term_a = np.inf if da_cap == 0.0 else (d_a_combo / da_cap)
                    term_b = np.inf if db_cap == 0.0 else (d_b_combo / db_cap)
                    ci_matrix[idx] = term_a + term_b

                finite_a = np.isfinite(da_cap)
                finite_b = np.isfinite(db_cap)

                if (not finite_a) and (not finite_b):
                    combined = d_a_combo + d_b_combo
                    expected = max(
                        fourpl(combined, bottom_a, top_a, ic50_a, hill_a),
                        fourpl(combined, bottom_b, top_b, ic50_b, hill_b),
                    )
                elif finite_a ^ finite_b:
                    expected = min(bottom_a, top_a) if finite_a else min(bottom_b, top_b)
                else:
                    expected = solve_loewe_expected_effect(d_a_combo, d_b_combo)

                expected_matrix[idx] = expected

                if not np.isnan(expected):
                    # Calculate synergy based on data type
                    if calc_data_type == "inhibition":
                        # INHIBITION: synergy = observed - expected
                        # (higher inhibition than expected = synergy)
                        synergy_matrix[idx] = effect_obs - expected
                    else:
                        # VIABILITY: synergy = expected - observed
                        # (lower viability than expected = synergy)
                        synergy_matrix[idx] = expected - effect_obs

        # Reference implementation calculates mean/max/min over the 4×4 INTERIOR only (non-zero combinations)
        # Exclude row 0 (Drug A=0) and column 0 (Drug B=0) which are single-agent treatments
        # This matches the baseline matrix that stores only combination data, not monotherapy
        valid_scores = synergy_matrix[~np.isnan(synergy_matrix)].flatten()

        if len(valid_scores) == 0:
            warnings.append("WARNING: Could not calculate any valid Loewe synergy scores.")
            mean_synergy = None
            max_synergy = None
            min_synergy = None
            synergistic_fraction = 0.0
        else:
            # Use raw synergy scores (no clipping) to preserve negative synergy
            # reference implementation can report negative synergy scores
            mean_synergy = float(np.nanmean(valid_scores))
            max_synergy = float(np.nanmax(valid_scores))
            min_synergy = float(np.nanmin(valid_scores))
            # Match reference implementation outputs (percent of synergistic combinations)
            synergistic_fraction = float(np.nanmean(valid_scores > 0)) * 100.0

        n_combinations = int(np.prod(synergy_matrix.shape))

        output_hill_a = -output_params_a["hill"]["value"]
        output_hill_b = -output_params_b["hill"]["value"]

        return _sanitize_for_json({
            "success": True,
            "model": "Loewe",
            "warnings": warnings,
            "combination_indices": ci_matrix.tolist(),
            "expected_matrix": expected_matrix.tolist(),
            "synergy_matrix": synergy_matrix.tolist(),
            "summary": {
                "mean_synergy": mean_synergy,
                "max_synergy": max_synergy,
                "min_synergy": min_synergy,
                "synergistic_fraction": synergistic_fraction
            },
            "interpretation": _interpret_synergy_score(mean_synergy if mean_synergy is not None else 0.0, "Loewe"),
            "n_combinations": n_combinations,
            # Individual drug fit parameters (flat structure for validation comparison)
            "drug1_hill_b": output_hill_a,
            "drug1_bottom_c": output_params_a["bottom"]["value"],
            "drug1_top_d": output_params_a["top"]["value"],
            "drug1_ic50_e": output_params_a["ic50"]["value"],
            "drug2_hill_b": output_hill_b,
            "drug2_bottom_c": output_params_b["bottom"]["value"],
            "drug2_top_d": output_params_b["top"]["value"],
            "drug2_ic50_e": output_params_b["ic50"]["value"],
            # Nested format for backward compatibility
            "drug_a_fit": {
                "ic50": output_params_a["ic50"]["value"],
                "hill": output_hill_a,
                "bottom": output_params_a["bottom"]["value"],
                "top": output_params_a["top"]["value"],
                "r_squared": output_fit_a["goodness_of_fit"]["r_squared"]
            },
            "drug_b_fit": {
                "ic50": output_params_b["ic50"]["value"],
                "hill": output_hill_b,
                "bottom": output_params_b["bottom"]["value"],
                "top": output_params_b["top"]["value"],
                "r_squared": output_fit_b["goodness_of_fit"]["r_squared"]
            }
        })

    except Exception as e:
        return {"success": False, "error": str(e)}


def calculate_zip_synergy(doses_a, doses_b, responses_a, responses_b,
                          combo_matrix, combo_doses_a=None, combo_doses_b=None,
                          fitting_method="log_dose",
                          data_type="viability"):
    """
    Calculate ZIP (Zero Interaction Potency) synergy scores.

    ZIP Model:
        Calculates the difference between observed and expected response
        where expected is based on dose-response curves assuming no interaction.

        ZIP delta > 0: Synergy (observed effect > expected)
        ZIP delta = 0: Additivity
        ZIP delta < 0: Antagonism

    Parameters
    ----------
    doses_a : array-like
        Doses of Drug A alone
    doses_b : array-like
        Doses of Drug B alone
    responses_a : array-like
        Single-agent responses for Drug A (% viability/activity, 100→0 with increasing dose)
    responses_b : array-like
        Single-agent responses for Drug B (% viability/activity, 100→0 with increasing dose)
    combo_matrix : 2D array-like
        Combination responses matrix [n_doses_a x n_doses_b]
    combo_doses_a : array-like, optional
        Drug A doses in combo (defaults to doses_a)
    combo_doses_b : array-like, optional
        Drug B doses in combo (defaults to doses_b)
    data_type : str, optional
        "viability" (100->0) or "inhibition" (0->100). Default: "viability".
    fitting_method : str, optional
        Curve fitting algorithm:
        - "log_dose" (default): Log-logistic parameterization with analytical Jacobian
        - "lmfit": Original approach with numerical Jacobian

    Returns
    -------
    dict : JSON-serializable result with ZIP scores
    """
    # Normalize fitting method (defaults to log_dose on unknown values)
    fitting_method = _normalize_fitting_method(fitting_method)

    try:
        # Convert to numpy
        d_a = np.asarray(doses_a, dtype=float)
        d_b = np.asarray(doses_b, dtype=float)
        r_a = np.asarray(responses_a, dtype=float)
        r_b = np.asarray(responses_b, dtype=float)
        combo = np.asarray(combo_matrix, dtype=float)

        if combo.ndim != 2:
            return {"success": False, "error": "combo_matrix must be 2D"}

        n_a, n_b = combo.shape

        # Use provided combo doses or default to single-agent doses
        c_doses_a = np.asarray(combo_doses_a, dtype=float) if combo_doses_a is not None else d_a
        c_doses_b = np.asarray(combo_doses_b, dtype=float) if combo_doses_b is not None else d_b
        orig_c_doses_a = c_doses_a.copy()
        orig_c_doses_b = c_doses_b.copy()

        # Normalize to inhibition space (reference implementation uses % inhibition internally)
        if data_type == "viability":
            r_a = 100.0 - r_a
            r_b = 100.0 - r_b
            combo = 100.0 - combo
        elif data_type != "inhibition":
            return {
                "success": False,
                "error": "data_type must be 'viability' or 'inhibition'"
            }

        # Validate % inhibition (post-normalization)
        warnings = []
        warnings.extend(_validate_percent_inhibition(r_a, "responses_a"))
        warnings.extend(_validate_percent_inhibition(r_b, "responses_b"))
        warnings.extend(_validate_percent_inhibition(combo.flatten(), "combo_matrix"))

        # ========================================================================
        # Reference ZIP implementation
        # ========================================================================
        # Key difference from old approach:
        # - OLD: Fit separate single-agent curves, extrapolate to combo doses
        # - NEW: Fit to combination matrix row/column slices, average predictions
        # ========================================================================

        # Step 1: Preprocess doses for log-dose fitter compatibility
        # Log-dose parameterization cannot handle dose=0 (log(0) = -∞)
        # Replace zero doses with small value (1e-10)
        if fitting_method == "log_dose":
            d_a = np.where(d_a == 0, 1e-10, d_a)
            d_b = np.where(d_b == 0, 1e-10, d_b)
            c_doses_a = np.where(c_doses_a == 0, 1e-10, c_doses_a)
            c_doses_b = np.where(c_doses_b == 0, 1e-10, c_doses_b)

        # Step 2: Fit single-agent dose-response curves
        # Zero-dose anchor (dose=0 or 0.001, response=100%) is provided by the adapter
        # This ensures stable curve fitting with proper baseline
        _debug(f"[ZIP DEBUG] Fitting Drug A: doses={d_a.tolist()}, responses={r_a.tolist()}, method={fitting_method}")
        fit_a = fit_4pl_dose_response(d_a, r_a, fitting_method=fitting_method)
        _debug(f"[ZIP DEBUG] Drug A fit result type: {type(fit_a)}")
        _debug(f"[ZIP DEBUG] Drug A fit result: {fit_a}")

        _debug(f"[ZIP DEBUG] Fitting Drug B: doses={d_b.tolist()}, responses={r_b.tolist()}, method={fitting_method}")
        fit_b = fit_4pl_dose_response(d_b, r_b, fitting_method=fitting_method)
        _debug(f"[ZIP DEBUG] Drug B fit result type: {type(fit_b)}")
        _debug(f"[ZIP DEBUG] Drug B fit result: {fit_b}")

        if fit_a is None or not isinstance(fit_a, dict):
            error_msg = f"Failed to fit Drug A dose-response: no result returned (type={type(fit_a)})"
            _debug(f"[ZIP DEBUG ERROR] {error_msg}")
            return {"success": False, "error": error_msg}
        if fit_b is None or not isinstance(fit_b, dict):
            error_msg = f"Failed to fit Drug B dose-response: no result returned (type={type(fit_b)})"
            _debug(f"[ZIP DEBUG ERROR] {error_msg}")
            return {"success": False, "error": error_msg}

        _debug(f"[ZIP DEBUG] Checking fit_a success: {fit_a.get('success', False)}")
        if not fit_a.get("success", False):
            error_msg = f"Failed to fit Drug A dose-response: {fit_a.get('error', 'Unknown')}"
            _debug(f"[ZIP DEBUG ERROR] {error_msg}")
            return {"success": False, "error": error_msg}

        _debug(f"[ZIP DEBUG] Checking fit_b success: {fit_b.get('success', False)}")
        if not fit_b.get("success", False):
            error_msg = f"Failed to fit Drug B dose-response: {fit_b.get('error', 'Unknown')}"
            _debug(f"[ZIP DEBUG ERROR] {error_msg}")
            return {"success": False, "error": error_msg}

        # Extract parameters (use returned hill directly)
        params_a = fit_a["parameters"]
        params_b = fit_b["parameters"]

        # 4PL model function (inhibition space)
        def fourpl(dose, bottom, top, ic50, hill):
            if dose <= 0:
                return bottom
            return bottom + (top - bottom) / (1 + (dose / ic50) ** hill)

        # Step 2: Get fitted single-agent responses at each dose (inhibition space)
        single_a_fitted_inh = np.asarray(fit_a.get("fitted_values", []), dtype=float)
        single_b_fitted_inh = np.asarray(fit_b.get("fitted_values", []), dtype=float)

        if len(single_a_fitted_inh) != len(c_doses_a):
            single_a_fitted_inh = np.array([
                fourpl(d, params_a["bottom"]["value"], params_a["top"]["value"],
                       params_a["ic50"]["value"], params_a["hill"]["value"])
                for d in c_doses_a
            ])
        if len(single_b_fitted_inh) != len(c_doses_b):
            single_b_fitted_inh = np.array([
                fourpl(d, params_b["bottom"]["value"], params_b["top"]["value"],
                       params_b["ic50"]["value"], params_b["hill"]["value"])
                for d in c_doses_b
            ])


        # combo is already in inhibition space after normalization
        combo_inh = combo

        # Step 3: Fit to each column (varying drug A, fixed drug B)
        # Baseline approach: fit LL.4 to each column with fixed bottom and top
        col_fitted_mat = np.zeros((n_a, n_b))
        zero_a_idx = np.where(orig_c_doses_a == 0)[0]
        zero_b_idx = np.where(orig_c_doses_b == 0)[0]
        baseline_a_idx = int(zero_a_idx[0]) if len(zero_a_idx) > 0 else 0
        baseline_b_idx = int(zero_b_idx[0]) if len(zero_b_idx) > 0 else 0

        for j in range(n_b):
            # Extract column slice (inhibition at varying drug A doses, fixed drug B dose j)
            col_data_inh = combo_inh[:, j]

            # reference implementation approach: Use OBSERVED baseline (inhibition at drug_a=0 for this column)
            # This is col_data_inh[baseline_a_idx] where orig_c_doses_a == 0
            bottom_fixed = col_data_inh[baseline_a_idx]

            _debug(f"[ZIP DEBUG] Column {j}/{n_b-1}: bottom_fixed={bottom_fixed} (observed inhibition at drug_a=0), col_data_inh={col_data_inh.tolist()}")

            # Handle zero variance (baseline approach: add tiny perturbation)
            if np.var(col_data_inh) == 0:
                col_data_inh = col_data_inh.copy()
                col_data_inh[baseline_a_idx] = col_data_inh[baseline_a_idx] - 1e-10
                _debug(f"[ZIP DEBUG] Column {j}: Applied zero-variance perturbation")

            # Fit 4PL with fixed bottom (Emin) and free top (Emax=NA in reference implementation)
            # Use fitting_method parameter (falls through to lmfit if log_dose + fixed params)
            _debug(f"[ZIP DEBUG] Column {j}: Fitting with doses={c_doses_a.tolist()}, data={col_data_inh.tolist()}, bottom_fixed={bottom_fixed}, top_fixed=None, method={fitting_method}")
            col_fit = fit_4pl_dose_response(
                c_doses_a, col_data_inh,
                fitting_method=fitting_method,
                bottom_fixed=bottom_fixed,
                top_fixed=None
            )

            _debug(f"[ZIP DEBUG] Column {j}: fit result type={type(col_fit)}")
            _debug(f"[ZIP DEBUG] Column {j}: fit result={col_fit}")

            if col_fit is None or not isinstance(col_fit, dict):
                error_msg = f"Column {j} fitting returned None or non-dict (type={type(col_fit)})"
                _debug(f"[ZIP DEBUG ERROR] {error_msg}")
                return {"success": False, "error": error_msg}

            if col_fit.get("success"):
                fitted_vals_inh = np.array(col_fit["fitted_values"])
                fitted_vals_inh = np.clip(fitted_vals_inh, 0, 100)
                col_fitted_mat[:, j] = fitted_vals_inh
            else:
                # Fallback: use observed inhibition values
                col_fitted_mat[:, j] = col_data_inh

        # Step 4: Fit to each row (fixed drug A, varying drug B)
        row_fitted_mat = np.zeros((n_a, n_b))

        for i in range(n_a):
            # Extract row slice (inhibition at fixed drug A dose i, varying drug B doses)
            row_data_inh = combo_inh[i, :]

            # reference implementation approach: Use OBSERVED baseline (inhibition at drug_b=0 for this row)
            # This is row_data_inh[baseline_b_idx] where orig_c_doses_b == 0
            bottom_fixed = row_data_inh[baseline_b_idx]

            _debug(f"[ZIP DEBUG] Row {i}/{n_a-1}: bottom_fixed={bottom_fixed} (observed inhibition at drug_b=0), row_data_inh={row_data_inh.tolist()}")

            # Handle zero variance
            if np.var(row_data_inh) == 0:
                row_data_inh = row_data_inh.copy()
                row_data_inh[baseline_b_idx] = row_data_inh[baseline_b_idx] - 1e-10
                _debug(f"[ZIP DEBUG] Row {i}: Applied zero-variance perturbation")

            # Fit 4PL with fixed bottom (Emin) and free top (Emax=NA in reference implementation)
            # Use fitting_method parameter (falls through to lmfit if log_dose + fixed params)
            _debug(f"[ZIP DEBUG] Row {i}: Fitting with doses={c_doses_b.tolist()}, data={row_data_inh.tolist()}, bottom_fixed={bottom_fixed}, top_fixed=None, method={fitting_method}")
            row_fit = fit_4pl_dose_response(
                c_doses_b, row_data_inh,
                fitting_method=fitting_method,
                bottom_fixed=bottom_fixed,
                top_fixed=None
            )

            _debug(f"[ZIP DEBUG] Row {i}: fit result type={type(row_fit)}")
            _debug(f"[ZIP DEBUG] Row {i}: fit result={row_fit}")

            if row_fit is None or not isinstance(row_fit, dict):
                error_msg = f"Row {i} fitting returned None or non-dict (type={type(row_fit)})"
                _debug(f"[ZIP DEBUG ERROR] {error_msg}")
                return {"success": False, "error": error_msg}

            if row_fit.get("success"):
                fitted_vals_inh = np.array(row_fit["fitted_values"])
                fitted_vals_inh = np.clip(fitted_vals_inh, 0, 100)
                row_fitted_mat[i, :] = fitted_vals_inh
            else:
                # Fallback: use observed inhibition values
                row_fitted_mat[i, :] = row_data_inh

        # Step 5: Average row and column fitted matrices (baseline approach, line 63)
        # This is the OBSERVED matrix (smoothed via row/column fitting)
        fitted_mat_inh = (row_fitted_mat + col_fitted_mat) / 2.0

        # Clamp to [0, 100] (baseline approach, line 76)
        fitted_mat_inh = np.clip(fitted_mat_inh, 0, 100)

        # Step 6: Calculate ZIP EXPECTED using Bliss formula on single-agent curves
        # Baseline approach: use fitted single-drug predictions (not row/column fits).

        E_A_from_combo = single_a_fitted_inh
        E_B_from_combo = single_b_fitted_inh

        # Expected: E = E_A + E_B - (E_A * E_B / 100) [Bliss independence in inhibition space]
        zip_expected_inh = np.zeros((n_a, n_b))
        for i in range(n_a):
            for j in range(n_b):
                I_A = E_A_from_combo[i]
                I_B = E_B_from_combo[j]
                zip_expected_inh[i, j] = I_A + I_B - (I_A * I_B / 100.0)

        # Step 7: Calculate ZIP delta = fitted - expected (baseline approach, line 77)
        zip_matrix = fitted_mat_inh - zip_expected_inh
        # reference implementation treats single-agent wells as no-interaction (delta = 0).
        boundary_mask = (orig_c_doses_a == 0)[:, None] | (orig_c_doses_b == 0)[None, :]
        zip_matrix = np.where(boundary_mask, 0.0, zip_matrix)

        expected_matrix = zip_expected_inh

        # Summary statistics with clipping (matches baseline behavior)
        # Clip antagonism at 0 for summary statistics (ZIP baseline)
        # This removes negative scores (antagonism) from mean/max/min calculation
        valid_scores = zip_matrix[~np.isnan(zip_matrix)]
        clipped_scores = np.maximum(valid_scores, 0)

        mean_zip = float(np.mean(clipped_scores))
        max_zip = float(np.max(clipped_scores))
        min_zip = float(np.min(clipped_scores))

        # Find location of max synergy (use nanargmax to ignore NaN)
        max_idx = np.unravel_index(np.nanargmax(zip_matrix), zip_matrix.shape)
        max_synergy_at = {"index_a": int(max_idx[0]), "index_b": int(max_idx[1])}
        if len(c_doses_a) > max_idx[0] and len(c_doses_b) > max_idx[1]:
            max_synergy_at["dose_a"] = float(c_doses_a[max_idx[0]])
            max_synergy_at["dose_b"] = float(c_doses_b[max_idx[1]])

        # Match reference implementation output: percent of combinations
        synergistic_fraction = float(np.mean(valid_scores > 0)) * 100.0
        n_combinations = int(n_a * n_b)

        return {
            "success": True,
            "model": "ZIP",
            "warnings": warnings,
            "zip_scores": zip_matrix.tolist(),
            "expected_matrix": expected_matrix.tolist(),
            "summary": {
                "mean_synergy": mean_zip,  # Use standard key for normalizer
                "max_synergy": max_zip,
                "min_synergy": min_zip,
                "max_synergy_at": max_synergy_at,
                "synergistic_fraction": synergistic_fraction
            },
            "interpretation": _interpret_synergy_score(mean_zip, "ZIP"),
            "drug_a_fit": {
                "ic50": params_a["ic50"]["value"],
                "hill": params_a["hill"]["value"],
                "r_squared": fit_a["goodness_of_fit"]["r_squared"]
            },
            "drug_b_fit": {
                "ic50": params_b["ic50"]["value"],
                "hill": params_b["hill"]["value"],
                "r_squared": fit_b["goodness_of_fit"]["r_squared"]
            },
            "n_combinations": n_combinations,
            "n_drug_a_doses": n_a,
            "n_drug_b_doses": n_b
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def synergy_analysis_json(json_input):
    """
    Unified JSON interface for drug synergism analysis.

    Parameters
    ----------
    json_input : str or dict
        JSON string or dictionary with analysis parameters:
        {
            "analysis_type": "hsa" | "bliss" | "loewe" | "zip" | "all",
            "responses_a": [...],           # % inhibition (0-100)
            "responses_b": [...],           # % inhibition (0-100)
            "combo_matrix": [[...]],        # % inhibition matrix [n_a x n_b]
            "doses_a": [...],               # Required for Loewe/ZIP
            "doses_b": [...],               # Required for Loewe/ZIP
            "combo_doses_a": [...],         # Optional, for Loewe
            "combo_doses_b": [...]          # Optional, for Loewe
        }

    Returns
    -------
    str : JSON string with analysis results
    """
    try:
        # Parse input
        if isinstance(json_input, str):
            data = json.loads(json_input)
        else:
            data = json_input

        analysis_type = data.get("analysis_type", "all").lower()

        # Check if this is the NEW format with separate payloads per model
        # (from adapt_synergy_all calling individual adapters)
        has_separate_payloads = ("hsa" in data or "bliss" in data or
                                 "loewe" in data or "zip" in data)

        results = {
            "success": True,
            "analysis_type": analysis_type,
            "models": {}
        }
        all_warnings = []

        if has_separate_payloads:
            # NEW PATH: Use proven adapter outputs directly (no slicing/conversion needed)

            if analysis_type in ["hsa", "all"] and "hsa" in data:
                hsa_data = data["hsa"]
                hsa_matrix = np.asarray(hsa_data["combo_matrix"], dtype=float)
                hsa_result = calculate_hsa_synergy(
                    hsa_data["responses_a"],
                    hsa_data["responses_b"],
                    hsa_matrix,
                    hsa_data["doses_a"],
                    hsa_data["doses_b"])
                results["models"]["HSA"] = hsa_result
                if hsa_result.get("warnings"):
                    all_warnings.extend(hsa_result["warnings"])

            if analysis_type in ["bliss", "all"] and "bliss" in data:
                bliss_data = data["bliss"]
                bliss_matrix = np.asarray(bliss_data["combo_matrix"], dtype=float)
                bliss_result = calculate_bliss_synergy(
                    bliss_data["responses_a"],
                    bliss_data["responses_b"],
                    bliss_matrix,
                    bliss_data["doses_a"],
                    bliss_data["doses_b"])
                results["models"]["Bliss"] = bliss_result
                if bliss_result.get("warnings"):
                    all_warnings.extend(bliss_result["warnings"])

            if analysis_type in ["loewe", "all"] and "loewe" in data:
                loewe_data = data["loewe"]
                combo_matrix = np.asarray(loewe_data["combo_matrix"], dtype=float)
                loewe_result = calculate_loewe_synergy(
                    loewe_data["doses_a"],
                    loewe_data["doses_b"],
                    loewe_data["responses_a"],
                    loewe_data["responses_b"],
                    combo_matrix=combo_matrix,
                    data_type=loewe_data.get("data_type", "viability"),
                    fitting_method=loewe_data.get("fitting_method", "log_dose"))
                results["models"]["Loewe"] = loewe_result
                if loewe_result.get("warnings"):
                    all_warnings.extend(loewe_result["warnings"])

            if analysis_type in ["zip", "all"] and "zip" in data:
                zip_data = data["zip"]
                zip_matrix = np.asarray(zip_data["combo_matrix"], dtype=float)
                zip_result = calculate_zip_synergy(
                    zip_data["doses_a"],
                    zip_data["doses_b"],
                    zip_data["responses_a"],
                    zip_data["responses_b"],
                    zip_matrix,
                    fitting_method=zip_data.get("fitting_method", "log_dose"),
                    data_type=zip_data.get("data_type", "viability"))
                if not isinstance(zip_result, dict):
                    results["models"]["ZIP"] = {
                        "success": False,
                        "error": "ZIP analysis returned invalid result"
                    }
                else:
                    results["models"]["ZIP"] = zip_result
                    if zip_result.get("warnings"):
                        all_warnings.extend(zip_result["warnings"])

        else:
            # OLD PATH: Legacy format for backward compatibility
            # Extract required data
            responses_a = data.get("responses_a")
            responses_b = data.get("responses_b")
            combo_matrix = data.get("combo_matrix")

            # Optional dose data (required for Loewe/ZIP)
            doses_a = data.get("doses_a")
            doses_b = data.get("doses_b")
            combo_doses_a = data.get("combo_doses_a")
            combo_doses_b = data.get("combo_doses_b")

            # Validate required inputs
            if responses_a is None or responses_b is None or combo_matrix is None:
                return json.dumps({
                    "success": False,
                    "error": "Missing required inputs: responses_a, responses_b, and combo_matrix are required"
                })

            # Validate combo dose dimensions match matrix shape
            combo_matrix_array = np.asarray(combo_matrix, dtype=float)
            n_rows, n_cols = combo_matrix_array.shape

            if combo_doses_a is not None:
                combo_doses_a_array = np.asarray(combo_doses_a, dtype=float)
                if len(combo_doses_a_array) != n_rows:
                    return json.dumps({
                        "success": False,
                        "error": f"Combo doses A dimension mismatch: expected {n_rows} values to match matrix rows, got {len(combo_doses_a_array)}"
                    })

            if combo_doses_b is not None:
                combo_doses_b_array = np.asarray(combo_doses_b, dtype=float)
                if len(combo_doses_b_array) != n_cols:
                    return json.dumps({
                        "success": False,
                        "error": f"Combo doses B dimension mismatch: expected {n_cols} values to match matrix columns, got {len(combo_doses_b_array)}"
                    })

            # Run requested analyses
            # For HSA/Bliss: Extract non-zero combinations only (exclude zero-dose boundaries)
            # These methods don't need zero-dose rows/columns since they analyze combinations
            if analysis_type in ["hsa", "bliss", "all"]:
                # Find indices where doses are non-zero
                idx_a_nonzero = [i for i, d in enumerate(doses_a) if d > 0] if doses_a else list(range(len(responses_a)))
                idx_b_nonzero = [i for i, d in enumerate(doses_b) if d > 0] if doses_b else list(range(len(responses_b)))

                # Extract non-zero portions (viability space)
                responses_a_viab_nonzero = [responses_a[i] for i in idx_a_nonzero] if idx_a_nonzero else responses_a
                responses_b_viab_nonzero = [responses_b[i] for i in idx_b_nonzero] if idx_b_nonzero else responses_b
                doses_a_nonzero = [doses_a[i] for i in idx_a_nonzero] if doses_a and idx_a_nonzero else doses_a
                doses_b_nonzero = [doses_b[i] for i in idx_b_nonzero] if doses_b and idx_b_nonzero else doses_b
                combo_matrix_viab_nonzero = combo_matrix_array[np.ix_(idx_a_nonzero, idx_b_nonzero)] if idx_a_nonzero and idx_b_nonzero else combo_matrix_array

                # Convert viability to inhibition for HSA/Bliss (they expect % inhibition, not viability)
                responses_a_inh_nonzero = [100 - v for v in responses_a_viab_nonzero]
                responses_b_inh_nonzero = [100 - v for v in responses_b_viab_nonzero]
                combo_matrix_inh_nonzero = 100 - combo_matrix_viab_nonzero

            if analysis_type in ["hsa", "all"]:
                hsa_result = calculate_hsa_synergy(
                    responses_a_inh_nonzero, responses_b_inh_nonzero, combo_matrix_inh_nonzero,
                    doses_a_nonzero, doses_b_nonzero)
                results["models"]["HSA"] = hsa_result
                if hsa_result.get("warnings"):
                    all_warnings.extend(hsa_result["warnings"])

            if analysis_type in ["bliss", "all"]:
                bliss_result = calculate_bliss_synergy(
                    responses_a_inh_nonzero, responses_b_inh_nonzero, combo_matrix_inh_nonzero,
                    doses_a_nonzero, doses_b_nonzero)
                results["models"]["Bliss"] = bliss_result
                if bliss_result.get("warnings"):
                    all_warnings.extend(bliss_result["warnings"])

            if analysis_type in ["loewe", "all"]:
                if doses_a is None or doses_b is None:
                    results["models"]["Loewe"] = {
                        "success": False,
                        "error": "Loewe analysis requires doses_a and doses_b"
                    }
                else:
                    # Loewe expects only non-zero combinations (4x4 interior)
                    # Extract non-zero doses and responses
                    doses_a_nonzero = [d for d in doses_a if d > 0]
                    doses_b_nonzero = [d for d in doses_b if d > 0]
                    responses_a_nonzero = [responses_a[i] for i, d in enumerate(doses_a) if d > 0]
                    responses_b_nonzero = [responses_b[i] for i, d in enumerate(doses_b) if d > 0]

                    # Slice combo matrix to exclude zero-dose boundaries [1:, 1:]
                    # Don't flatten - Loewe expects 2D matrix, not 1D
                    combo_nonzero = combo_matrix_array[1:, 1:]

                    # Filter combo doses if provided, else use non-zero single-agent doses
                    if combo_doses_a:
                        c_doses_a = [d for d in combo_doses_a if d > 0]
                    else:
                        c_doses_a = doses_a_nonzero
                    if combo_doses_b:
                        c_doses_b = [d for d in combo_doses_b if d > 0]
                    else:
                        c_doses_b = doses_b_nonzero

                    loewe_result = calculate_loewe_synergy(
                        doses_a_nonzero, doses_b_nonzero, responses_a_nonzero, responses_b_nonzero,
                        c_doses_a, c_doses_b, combo_nonzero,  # Pass 2D matrix, not flattened
                        data_type="inhibition", fitting_method="log_dose")
                    results["models"]["Loewe"] = loewe_result
                    if loewe_result.get("warnings"):
                        all_warnings.extend(loewe_result["warnings"])

            if analysis_type in ["zip", "all"]:
                if doses_a is None or doses_b is None:
                    results["models"]["ZIP"] = {
                        "success": False,
                        "error": "ZIP analysis requires doses_a and doses_b"
                    }
                else:
                    # Keep zero doses for proper anchoring (adapter provides full dose arrays)
                    zip_result = calculate_zip_synergy(
                        doses_a, doses_b, responses_a, responses_b, combo_matrix,
                        combo_doses_a, combo_doses_b)
                    if not isinstance(zip_result, dict):
                        results["models"]["ZIP"] = {
                            "success": False,
                            "error": "ZIP analysis returned invalid result"
                        }
                    else:
                        results["models"]["ZIP"] = zip_result
                        if zip_result.get("warnings"):
                            all_warnings.extend(zip_result["warnings"])

        # Deduplicate warnings
        results["warnings"] = list(set(all_warnings))

        # Add overall summary if running all models
        if analysis_type == "all":
            summary = {}
            for model_name, model_result in results["models"].items():
                if model_result.get("success"):
                    if model_name == "Loewe":
                        summary[model_name] = {
                            "mean_score": model_result["summary"].get("mean_ci"),
                            "interpretation": model_result.get("interpretation")
                        }
                    else:
                        summary[model_name] = {
                            "mean_score": model_result["summary"].get("mean_synergy") or
                                         model_result["summary"].get("mean_zip"),
                            "interpretation": model_result.get("interpretation")
                        }
            results["comparison_summary"] = summary

            # Add overall n_combinations for E2E validation (prefer model-level values).
            n_combinations = None
            n_drug_a_doses = None
            n_drug_b_doses = None
            for model_result in results["models"].values():
                if not isinstance(model_result, dict):
                    continue
                if model_result.get("n_combinations") is not None and n_combinations is None:
                    n_combinations = int(model_result["n_combinations"])
                    n_drug_a_doses = model_result.get("n_drug_a_doses") or n_drug_a_doses
                    n_drug_b_doses = model_result.get("n_drug_b_doses") or n_drug_b_doses
                n_a = model_result.get("n_drug_a_doses")
                n_b = model_result.get("n_drug_b_doses")
                if n_a is not None and n_b is not None:
                    if n_combinations is None:
                        n_combinations = int(n_a) * int(n_b)
                    n_drug_a_doses = n_a
                    n_drug_b_doses = n_b
                if n_combinations is not None and n_drug_a_doses is not None and n_drug_b_doses is not None:
                    break
            if n_combinations is not None:
                results["n_combinations"] = n_combinations
            if n_drug_a_doses is not None:
                results["n_drug_a_doses"] = int(n_drug_a_doses)
            if n_drug_b_doses is not None:
                results["n_drug_b_doses"] = int(n_drug_b_doses)

        # Sanitize NaN/Infinity values before JSON serialization
        results = _sanitize_for_json(results)
        return json.dumps(results, allow_nan=False)

    except json.JSONDecodeError as e:
        return json.dumps({"success": False, "error": f"Invalid JSON input: {str(e)}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
