"""
Descriptive statistics functions.

VERSION: 1.0.0
DATE: 2025-12-05
"""
import numpy as np
from scipy import stats
from typing import Dict, Any, List, Optional, Tuple
from .utils import preprocess_data, format_number

def descriptive_statistics(data: List[float], alpha: float = 0.05) -> Dict[str, Any]:
    """
    Calculate comprehensive descriptive statistics with configurable alpha

    Args:
        data: Input data list
        alpha: Significance level for confidence intervals (default 0.05 for 95% CI)

    Returns:
        Dictionary with statistics including:
        - mode: First mode (most frequent value)
        - mode_count: Number of times the mode appears
        - is_multimodal: True if multiple values share the highest frequency
        - all_modes: Array of all modes (only included if is_multimodal=True)
    """
    try:
        arr = preprocess_data(data)

        # Calculate mode - properly handle multimodal distributions and no mode case
        unique_vals, counts = np.unique(arr, return_counts=True)
        max_count = np.max(counts)
        min_count = np.min(counts)

        # Check if there's no mode (all values have same frequency)
        has_no_mode = (max_count == min_count)

        if has_no_mode:
            # No mode - all values appear with equal frequency
            results = {
                'count': int(len(arr)),
                'mean': format_number(np.mean(arr)),
                'median': format_number(np.median(arr)),
                'mode': None,
                'mode_count': int(max_count),
                'is_multimodal': False,
                'has_mode': False,
                'std': format_number(np.std(arr, ddof=1)),
                'variance': format_number(np.var(arr, ddof=1)),
                'min': format_number(np.min(arr)),
                'max': format_number(np.max(arr)),
                'range': format_number(np.max(arr) - np.min(arr)),
                'sem': format_number(stats.sem(arr)),
                'skewness': format_number(stats.skew(arr, bias=False)),
                'kurtosis': format_number(stats.kurtosis(arr, bias=False, fisher=True)),
                'q25': format_number(np.percentile(arr, 25)),
                'q50': format_number(np.percentile(arr, 50)),
                'q75': format_number(np.percentile(arr, 75)),
                'iqr': format_number(np.percentile(arr, 75) - np.percentile(arr, 25)),
                'alpha': format_number(alpha)
            }
        else:
            # Mode exists - find value(s) with highest frequency
            modes = unique_vals[counts == max_count]
            is_multimodal = len(modes) > 1

            results = {
                'count': int(len(arr)),
                'mean': format_number(np.mean(arr)),
                'median': format_number(np.median(arr)),
                'mode': format_number(modes[0]),
                'mode_count': int(max_count),
                'is_multimodal': is_multimodal,
                'has_mode': True,
                'std': format_number(np.std(arr, ddof=1)),
                'variance': format_number(np.var(arr, ddof=1)),
                'min': format_number(np.min(arr)),
                'max': format_number(np.max(arr)),
                'range': format_number(np.max(arr) - np.min(arr)),
                'sem': format_number(stats.sem(arr)),
                'skewness': format_number(stats.skew(arr, bias=False)),
                'kurtosis': format_number(stats.kurtosis(arr, bias=False, fisher=True)),
                'q25': format_number(np.percentile(arr, 25)),
                'q50': format_number(np.percentile(arr, 50)),
                'q75': format_number(np.percentile(arr, 75)),
                'iqr': format_number(np.percentile(arr, 75) - np.percentile(arr, 25)),
                'alpha': format_number(alpha)
            }

            # If multimodal, include all modes
            if is_multimodal:
                results['all_modes'] = [format_number(m) for m in modes]

        # Confidence intervals based on specified alpha
        confidence_level = 1 - alpha
        if len(arr) > 1:
            # Use t-distribution for all n when sigma is unknown
            t_critical = stats.t.ppf(1 - alpha / 2, len(arr) - 1)
            margin = t_critical * results['sem']
            ci = (results['mean'] - margin, results['mean'] + margin)

            results['ci_lower'] = format_number(ci[0])
            results['ci_upper'] = format_number(ci[1])
            results['confidence_level'] = format_number(confidence_level)
            results['ci_method'] = 't-distribution'
        else:
            results['ci_lower'] = results['mean']
            results['ci_upper'] = results['mean']
            results['confidence_level'] = format_number(confidence_level)
            results['ci_method'] = 'insufficient-data'

        return {'success': True, **results}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def descriptive_statistics_from_aggregates(
    stats_row: Dict[str, Any],
    mode_stats: Dict[str, Any],
    alpha: float = 0.05
) -> Dict[str, Any]:
    """
    Calculate descriptive statistics from SQL aggregates (large-mode fast path).
    """
    try:
        n = int(stats_row.get('n') or 0)
        if n < 2:
            return {
                'success': False,
                'error': f'Insufficient sample size: {n} observation(s). Minimum 2 observations required for meaningful statistics.'
            }

        def _value_or_nan(value: Any) -> float:
            if value is None:
                return float('nan')
            try:
                return float(value)
            except Exception:
                return float('nan')

        mean = _value_or_nan(stats_row.get('mean'))
        std = _value_or_nan(stats_row.get('std'))
        min_val = _value_or_nan(stats_row.get('min'))
        max_val = _value_or_nan(stats_row.get('max'))
        median = _value_or_nan(stats_row.get('median'))
        q1 = _value_or_nan(stats_row.get('q1'))
        q3 = _value_or_nan(stats_row.get('q3'))
        skewness = _value_or_nan(stats_row.get('skewness'))
        kurtosis = _value_or_nan(stats_row.get('kurtosis'))

        sem = std / np.sqrt(n) if n > 0 else float('nan')
        variance = std ** 2
        range_val = max_val - min_val
        iqr = q3 - q1

        has_mode = bool(mode_stats.get('has_mode')) if mode_stats is not None else False
        is_multimodal = bool(mode_stats.get('is_multimodal')) if mode_stats is not None else False
        mode_value = mode_stats.get('mode') if has_mode and mode_stats is not None else None
        mode_count = int(mode_stats.get('mode_count') or 0) if mode_stats is not None else 0
        all_modes = mode_stats.get('all_modes') if mode_stats is not None else None

        confidence_level = 1 - alpha
        if n > 1 and np.isfinite(sem):
            # Use t-distribution for all n when sigma is unknown
            t_critical = stats.t.ppf(1 - alpha / 2, n - 1)
            ci_margin = t_critical * sem
            ci_lower = mean - ci_margin
            ci_upper = mean + ci_margin
            ci_method = 't-distribution'
        else:
            ci_lower = mean
            ci_upper = mean
            ci_method = 'insufficient-data'

        results = {
            'count': int(n),
            'mean': format_number(mean),
            'median': format_number(median),
            'mode': format_number(mode_value) if has_mode else None,
            'mode_count': int(mode_count),
            'is_multimodal': bool(is_multimodal),
            'has_mode': bool(has_mode),
            'std': format_number(std),
            'variance': format_number(variance),
            'min': format_number(min_val),
            'max': format_number(max_val),
            'range': format_number(range_val),
            'sem': format_number(sem),
            'skewness': format_number(skewness),
            'kurtosis': format_number(kurtosis),
            'q25': format_number(q1),
            'q50': format_number(median),
            'q75': format_number(q3),
            'iqr': format_number(iqr),
            'alpha': format_number(alpha),
            'ci_lower': format_number(ci_lower),
            'ci_upper': format_number(ci_upper),
            'confidence_level': format_number(confidence_level),
            'ci_method': ci_method
        }

        if is_multimodal and isinstance(all_modes, list):
            results['all_modes'] = [format_number(m) for m in all_modes]

        return {'success': True, **results}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def outlier_detection(data, methods=['iqr', 'zscore', 'modified_zscore'], alpha=0.05):
    """
    Detect outliers using multiple methods with standard textbook thresholds.

    Args:
        data: Input data array
        methods: List of methods to use ['iqr', 'zscore', 'modified_zscore']
        alpha: Significance level (not used for outliers but kept for consistency)

    Returns:
        Dictionary containing outlier detection results

    FIXES (2025-12-01):
    - Changed z-score threshold from 2 to 3 (common practice)
    - Added +1 to all indices for 1-based indexing compatibility
    - Added missing summary statistics: q1, q3, iqr, mad
    """
    try:
        arr = preprocess_data(data)

        # Calculate summary statistics (used by downstream baselines)
        q1, q3 = np.percentile(arr, [25, 75])
        iqr_val = q3 - q1
        median = np.median(arr)
        mad_val = np.median(np.abs(arr - median))  # Unscaled MAD for modified Z-score

        results = {
            'success': True,
            'outliers': {},
            'n_original': int(len(data)),
            'n_valid': int(len(arr)),
            # Add summary statistics for compatibility
            'q1': format_number(q1),
            'q3': format_number(q3),
            'iqr': format_number(iqr_val),
            'mad': format_number(mad_val)
        }

        if 'iqr' in methods:
            lower_bound = q1 - 1.5 * iqr_val
            upper_bound = q3 + 1.5 * iqr_val
            outlier_mask = (arr < lower_bound) | (arr > upper_bound)
            outlier_values = arr[outlier_mask].tolist()
            outlier_indices = (np.where(outlier_mask)[0] + 1).tolist()  # +1 for 1-based indexing

            results['outliers']['iqr'] = {
                'indices': outlier_indices,
                'values': outlier_values,
                'count': int(len(outlier_indices)),
                'lower_bound': format_number(lower_bound),
                'upper_bound': format_number(upper_bound)
            }

        if 'zscore' in methods:
            if len(arr) > 1 and np.std(arr, ddof=1) > 0:
                z_scores = np.abs(stats.zscore(arr, ddof=1))
                outlier_mask = z_scores > 3  # Changed from 2 to 3 (common practice)
                outlier_values = arr[outlier_mask].tolist()
                outlier_indices = (np.where(outlier_mask)[0] + 1).tolist()  # +1 for 1-based indexing

                results['outliers']['zscore'] = {
                    'indices': outlier_indices,
                    'values': outlier_values,
                    'count': int(len(outlier_indices)),
                    'threshold': 3.0  # Changed from 2.0 to 3.0
                }
            else:
                results['outliers']['zscore'] = {
                    'indices': [],
                    'values': [],
                    'count': 0,
                    'threshold': 3.0,
                    'note': 'Insufficient variance for Z-score calculation'
                }

        if 'modified_zscore' in methods:
            if mad_val > 1e-10:  # Avoid division by zero
                modified_z = 0.6745 * (arr - median) / mad_val
                outlier_mask = np.abs(modified_z) > 3.5
                outlier_values = arr[outlier_mask].tolist()
                outlier_indices = (np.where(outlier_mask)[0] + 1).tolist()  # +1 for 1-based indexing

                results['outliers']['modified_zscore'] = {
                    'indices': outlier_indices,
                    'values': outlier_values,
                    'count': int(len(outlier_indices)),
                    'threshold': 3.5
                }
            else:
                results['outliers']['modified_zscore'] = {
                    'indices': [],
                    'values': [],
                    'count': 0,
                    'threshold': 3.5,
                    'note': 'All values nearly identical (MAD ≈ 0)'
                }

        grubbs_stats = _compute_grubbs(arr, alpha=alpha)
        if grubbs_stats:
            results['grubbs_g'] = format_number(grubbs_stats['g_stat'])
            results['grubbs_p'] = format_number(grubbs_stats['p_value'])
            results['grubbs_critical'] = format_number(grubbs_stats['critical_value'])
            results['grubbs_suspect_value'] = format_number(grubbs_stats['suspect_value'])
            results['grubbs_suspect_index'] = int(grubbs_stats['suspect_index'])

        return results
    except Exception as e:
        return {'success': False, 'error': str(e)}


def _compute_grubbs(arr: np.ndarray, alpha: float = 0.05) -> Optional[Dict[str, float]]:
    """
    Compute Grubbs test statistic and p-value (two-sided) for baseline consistency.
    Returns (G, p_value) or None if computation is not possible.
    """
    n = len(arr)
    if n < 3:
        return None

    std = np.std(arr, ddof=1)
    if std <= 0:
        return None

    mean = np.mean(arr)
    deviations = np.abs(arr - mean)
    suspect_index = int(np.argmax(deviations))
    suspect_value = float(arr[suspect_index])
    g_stat = deviations[suspect_index] / std

    denom = ((n - 1) ** 2) / n - g_stat ** 2
    if denom <= 0:
        return None

    t_squared = ((n - 2) * (g_stat ** 2)) / denom
    t_stat = float(np.sqrt(t_squared))

    tail_prob = max(0.0, 1 - stats.t.cdf(t_stat, n - 2))
    # Two-sided Grubbs p-value
    p_value = min(1.0, 2 * n * tail_prob)

    t_critical = stats.t.ppf(1 - alpha / (2 * n), n - 2)
    critical_value = ((n - 1) / np.sqrt(n)) * np.sqrt((t_critical ** 2) / (n - 2 + t_critical ** 2))

    return {
        'g_stat': g_stat,
        'p_value': p_value,
        'critical_value': critical_value,
        'suspect_value': suspect_value,
        'suspect_index': suspect_index + 1,
    }
