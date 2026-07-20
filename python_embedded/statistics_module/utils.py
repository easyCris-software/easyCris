"""
Utility functions and shared code for statistical analysis module.
"""
import sys
import os
import json
import warnings
import logging
import numpy as np
import pandas as pd
from scipy import stats
from typing import Dict, Any, List, Optional, Union
import math

# Backward-compatible type hint for numpy arrays
try:
    from numpy.typing import NDArray
except (ImportError, AttributeError):
    # Safe fallback for embedded environments
    from typing import Any
    NDArray = Any

# Configure logging for optional verbosity
logging.basicConfig(level=logging.WARNING, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# Global metadata context
_METADATA_CONTEXT = {}

def set_context_metadata(function_name: str, metadata: Optional[Dict[str, Any]]) -> bool:
    """
    Store metadata context for subsequent function calls.
    """
    if metadata is None:
        _METADATA_CONTEXT.pop(function_name, None)
        return True

    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            logger.warning("Received invalid metadata JSON for %s; storing raw string", function_name)
            metadata = {"raw": metadata}

    _METADATA_CONTEXT[function_name] = metadata
    return True

def _consume_context_metadata(function_name: str) -> Dict[str, Any]:
    """
    Retrieve and remove stored metadata for a function name.
    """
    return _METADATA_CONTEXT.pop(function_name, {}) if function_name in _METADATA_CONTEXT else {}

def format_number(value: Union[float, int, None], decimals: int = 4) -> Optional[Union[float, int]]:
    """
    Format numeric values for consistent display and JSON serialization.

    Formatting rules:
    - Integers: Return as-is
    - Floats with abs(value) < 0.0001 or >= 10000: Scientific notation (4 sig figs)
    - Other floats: Round to specified decimal places (default 4)
    - NaN/Inf: Return None
    - None: Return None

    Args:
        value: Numeric value to format (can be float, int, NumPy type, or None)
        decimals: Number of decimal places for standard formatting (default 4)

    Returns:
        Formatted Python number (float/int) or None for special values (NaN/Inf)
    """
    if value is None:
        return None

    # Handle non-numeric values - return as-is
    if not isinstance(value, (int, float, np.number)):
        return value

    # Convert numpy types to native Python types
    if isinstance(value, np.integer):
        return int(value)
    elif isinstance(value, np.number):
        value = float(value)

    # Check for NaN or Inf
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None

        # For very small or very large values, keep full precision
        # (C# will handle scientific notation formatting)
        # For normal range, round to specified decimals
        if abs(value) >= 0.0001 and abs(value) < 10000:
            return round(value, decimals)

    # Return as-is (int or float outside rounding range)
    return value

def safe_trapz(y: NDArray, x: NDArray) -> float:
    """
    Compute trapezoidal integration with NumPy, handling versions where np.trapz was removed.
    """
    if hasattr(np, "trapezoid"):
        return float(np.trapezoid(y, x))
    return float(np.trapz(y, x))

def interpret_partial_eta(value: float) -> str:
    """Interpret partial eta squared effect size."""
    if value < 0.01:
        return "negligible"
    elif value < 0.06:
        return "small"
    elif value < 0.14:
        return "medium"
    else:
        return "large"

def significance_marker(p_value: Optional[float]) -> str:
    """
    Return significance marker based on conventional thresholds.
    """
    try:
        p = float(p_value) if p_value is not None else 1.0
    except (TypeError, ValueError):
        return "ns"

    if math.isnan(p):
        return "ns"
    if p < 0.001:
        return "***"
    elif p < 0.01:
        return "**"
    elif p < 0.05:
        return "*"
    else:
        return "ns"

def significance_text(p_value: Optional[float]) -> str:
    """
    Return formatted significance description with threshold context.
    """
    marker = significance_marker(p_value)
    try:
        p = float(p_value) if p_value is not None else 1.0
    except (TypeError, ValueError):
        return f"{marker} (p unavailable)"

    if math.isnan(p):
        return f"{marker} (p unavailable)"
    if p < 0.001:
        return f"{marker} (p < 0.001)"
    elif p < 0.01:
        return f"{marker} (p < 0.01)"
    elif p < 0.05:
        return f"{marker} (p < 0.05)"
    else:
        return f"{marker} (p = {format_number(p)})"

def preprocess_data(data: List[float], remove_nan: bool = True, convert_numeric: bool = True) -> NDArray:
    """
    Preprocess data: Remove NaNs and convert to appropriate types.

    Args:
        data: Input data (list, array, or numeric iterable)
        remove_nan: Whether to remove NaN values
        convert_numeric: Whether to convert to numeric type

    Returns:
        Preprocessed numpy array

    Raises:
        ValueError: If data cannot be converted to numeric or contains no valid values
        TypeError: If input data type is invalid
    """
    try:
        # Input type validation
        if data is None:
            raise TypeError("Input data cannot be None")

        if not hasattr(data, '__iter__') or isinstance(data, str):
            raise TypeError(f"Input data must be iterable (list, array, etc.), got {type(data).__name__}")

        # Convert to numpy array
        if convert_numeric:
            try:
                arr = np.array(data, dtype=float)
            except (ValueError, TypeError) as e:
                raise ValueError(f"Cannot convert data to numeric format. Check for non-numeric values. Error: {str(e)}")
        else:
            arr = np.array(data)

        if remove_nan:
            # Remove NaN, inf, and -inf values
            arr = arr[np.isfinite(arr)]

        if len(arr) == 0:
            raise ValueError("No valid data after preprocessing. All values were NaN, inf, or invalid.")

        return arr
    except (ValueError, TypeError) as e:
        # Re-raise validation errors with original message
        raise
    except Exception as e:
        raise ValueError(f"Data preprocessing failed with unexpected error: {str(e)}")

def sanitize_for_json(obj: Any) -> Any:
    """
    Recursively replace NaN and Inf values with None for JSON compatibility.
    Also ensures proper type conversion for JSON serialization.
    """
    if isinstance(obj, dict):
        return {key: sanitize_for_json(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [sanitize_for_json(item) for item in obj]
    elif isinstance(obj, (bool, np.bool_)):
        # IMPORTANT: Check bool BEFORE int/float (bool is subclass of int in Python)
        return bool(obj)
    elif isinstance(obj, (float, np.floating)):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return float(obj)
    elif isinstance(obj, (int, np.integer)):
        return int(obj)
    elif obj is None:
        return None
    else:
        return obj

def ensure_critical_statistics(result_dict: Dict[str, Any]) -> Dict[str, Any]:
    """
    Ensure ONLY critical top-level statistics have valid numeric values instead of null.
    DO NOT replace None in coefficient tables - let C# handle displaying them as N/A.
    """
    critical_numeric_fields = {
        'pseudo_r2_mcfadden': 0.0,
        'mcfadden_r2': 0.0,
        'aic': 0.0,
        'bic': 0.0,
        'log_likelihood': 0.0,
        'accuracy': 0.0,
        'auc_roc': 0.0,
        'auc_roc_macro': 0.0,
    }

    for field, default_value in critical_numeric_fields.items():
        if field in result_dict and result_dict[field] is None:
            result_dict[field] = default_value

    return result_dict

def validate_input(input_data: Dict[str, Any], required_keys: List[str], command: str) -> Optional[Dict[str, Any]]:
    """
    Validate that required keys exist in input data.

    Args:
        input_data: Input dictionary
        required_keys: List of required key names
        command: Command name for error message

    Returns:
        Dict with success=False and error message if validation fails, None otherwise
    """
    missing_keys = [key for key in required_keys if key not in input_data]
    if missing_keys:
        return {
            'success': False,
            'error': f"Missing required parameters for '{command}': {', '.join(missing_keys)}. Please check your input data."
        }
    return None

# Classification metrics functions
def calculate_accuracy(y_true: NDArray, y_pred: NDArray) -> float:
    """Calculate accuracy score."""
    y_true = np.array(y_true)
    y_pred = np.array(y_pred)
    return float(np.mean(y_true == y_pred))

def calculate_confusion_matrix(y_true: NDArray, y_pred: NDArray, n_classes: Optional[int] = None) -> List[List[int]]:
    """Calculate confusion matrix."""
    y_true = np.array(y_true, dtype=int)
    y_pred = np.array(y_pred, dtype=int)

    if n_classes is None:
        n_classes = max(max(y_true), max(y_pred)) + 1

    cm = np.zeros((n_classes, n_classes), dtype=int)
    for true_label, pred_label in zip(y_true, y_pred):
        # Clip to valid range to avoid index errors
        true_label = np.clip(true_label, 0, n_classes - 1)
        pred_label = np.clip(pred_label, 0, n_classes - 1)
        cm[true_label, pred_label] += 1

    return cm.tolist()

def calculate_roc_auc(y_true: NDArray, y_prob: NDArray) -> Optional[float]:
    """Calculate ROC AUC for binary classification."""
    try:
        y_true = np.array(y_true)
        y_prob = np.array(y_prob)

        # Sort by predicted probability
        desc_score_indices = np.argsort(y_prob)[::-1]
        y_true_sorted = y_true[desc_score_indices]

        # Calculate True Positive Rate and False Positive Rate
        n_pos = np.sum(y_true == 1)
        n_neg = np.sum(y_true == 0)

        if n_pos == 0 or n_neg == 0:
            return None

        tps = np.cumsum(y_true_sorted)
        fps = np.arange(1, len(y_true_sorted) + 1) - tps

        tpr = tps / n_pos
        fpr = fps / n_neg

        # Calculate AUC using trapezoidal rule
        auc = safe_trapz(tpr, fpr)

        if np.isnan(auc) or np.isinf(auc):
            return None

        return float(abs(auc))
    except Exception:
        return None

def calculate_multiclass_auc_ovr(y_true: NDArray, prob_matrix: NDArray) -> Optional[float]:
    """Calculate macro-averaged AUC for multiclass (one-vs-rest)."""
    try:
        y_true = np.array(y_true, dtype=int)
        prob_matrix = np.array(prob_matrix)

        n_classes = prob_matrix.shape[1]
        auc_scores = []

        for class_idx in range(n_classes):
            # One-vs-rest: current class vs all others
            y_binary = (y_true == class_idx).astype(int)
            y_prob = prob_matrix[:, class_idx]

            auc = calculate_roc_auc(y_binary, y_prob)
            if auc is not None:
                auc_scores.append(auc)

        if not auc_scores:
            return None

        macro_auc = float(np.mean(auc_scores))

        if np.isnan(macro_auc) or np.isinf(macro_auc):
            return None

        return macro_auc
    except Exception:
        return None

def calculate_classification_metrics(y_true: NDArray, y_pred: NDArray, labels: Optional[List[int]] = None, zero_division: int = 0) -> Dict[str, Any]:
    """
    Calculate precision, recall, f1-score for each class.
    Returns a dictionary similar to sklearn's classification_report.
    """
    y_true = np.array(y_true, dtype=int)
    y_pred = np.array(y_pred, dtype=int)

    if labels is None:
        labels = np.unique(np.concatenate([y_true, y_pred]))

    report = {}

    for label in labels:
        label_str = str(label)

        # True positives, false positives, false negatives
        tp = np.sum((y_true == label) & (y_pred == label))
        fp = np.sum((y_true != label) & (y_pred == label))
        fn = np.sum((y_true == label) & (y_pred != label))
        tn = np.sum((y_true != label) & (y_pred != label))

        # Precision, recall, f1
        if tp + fp == 0:
            precision = float(zero_division)
        else:
            precision = float(tp / (tp + fp))

        if tp + fn == 0:
            recall = float(zero_division)
        else:
            recall = float(tp / (tp + fn))

        if precision + recall == 0:
            f1 = float(zero_division)
        else:
            f1 = float(2 * (precision * recall) / (precision + recall))

        support = int(np.sum(y_true == label))

        report[label_str] = {
            'precision': precision,
            'recall': recall,
            'f1-score': f1,
            'support': support
        }

    # Calculate macro and weighted averages
    precisions = [report[str(l)]['precision'] for l in labels]
    recalls = [report[str(l)]['recall'] for l in labels]
    f1s = [report[str(l)]['f1-score'] for l in labels]
    supports = [report[str(l)]['support'] for l in labels]
    total_support = sum(supports)

    report['macro avg'] = {
        'precision': float(np.mean(precisions)),
        'recall': float(np.mean(recalls)),
        'f1-score': float(np.mean(f1s)),
        'support': total_support
    }

    if total_support > 0:
        report['weighted avg'] = {
            'precision': float(np.average(precisions, weights=supports)),
            'recall': float(np.average(recalls, weights=supports)),
            'f1-score': float(np.average(f1s, weights=supports)),
            'support': total_support
        }
    else:
        report['weighted avg'] = report['macro avg']

    report['accuracy'] = calculate_accuracy(y_true, y_pred)

    return report

def compute_hosmer_lemeshow(y_true: NDArray, y_prob: NDArray, n_bins: int = 10) -> tuple:
    """
    Compute Hosmer-Lemeshow calibration test statistic.

    Parameters:
    -----------
    y_true : array-like
        True binary outcomes (0 or 1)
    y_prob : array-like
        Predicted probabilities
    n_bins : int
        Number of bins for grouping (default 10)

    Returns:
    --------
    tuple : (statistic, p_value, df) or (None, None, None) if cannot compute
    """
    try:
        y_true = np.asarray(y_true, dtype=float)
        y_prob = np.asarray(y_prob, dtype=float)

        if y_true.ndim != 1 or y_prob.ndim != 1 or len(y_true) != len(y_prob):
            return None, None, None

        # Ensure reasonable number of bins
        n_bins = max(2, min(n_bins, len(y_true) // 5))
        if n_bins < 2:
            return None, None, None

        # Sort by predicted probability
        order = np.argsort(y_prob)
        y_sorted = y_true[order]
        p_sorted = y_prob[order]

        # Split into bins
        bins = np.array_split(np.arange(len(y_true)), n_bins)

        hl_stat = 0.0
        for bin_indices in bins:
            if len(bin_indices) == 0:
                continue

            observed_events = np.sum(y_sorted[bin_indices])
            observed_nonevents = len(bin_indices) - observed_events
            expected_events = np.sum(p_sorted[bin_indices])
            expected_nonevents = len(bin_indices) - expected_events

            if expected_events > 0:
                hl_stat += (observed_events - expected_events) ** 2 / expected_events
            if expected_nonevents > 0:
                hl_stat += (observed_nonevents - expected_nonevents) ** 2 / expected_nonevents

        df = n_bins - 2
        if df > 0:
            p_value = float(1 - stats.chi2.cdf(hl_stat, df))
        else:
            p_value = None

        return float(hl_stat), p_value, int(df)

    except Exception:
        return None, None, None
