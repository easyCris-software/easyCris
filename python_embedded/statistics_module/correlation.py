"""
Correlation analysis functions.

VERSION: 1.0.0
DATE: 2025-12-05
"""
import numpy as np
from scipy.stats import pearsonr, spearmanr, kendalltau
from typing import Dict, Any, List
from .utils import preprocess_data, format_number


def correlation_analysis(x, y, alpha=0.05, method="all"):
    """
    Perform correlation analysis with optional method selection.

    Args:
        x: First variable data
        y: Second variable data
        alpha: Significance level
        method: Optional correlation method ("pearson", "spearman", "kendall", or "all")

    Returns:
        Dictionary with Pearson, Spearman, and/or Kendall's tau correlation results
    """
    try:
        from scipy.stats import t as t_dist, norm
        from scipy.stats import rankdata

        method = (method or "all").lower()
        if method not in ("all", "pearson", "spearman", "kendall"):
            method = "all"

        # Preserve pairing: only drop rows where either X or Y is non-finite
        x_arr = preprocess_data(x, remove_nan=False)
        y_arr = preprocess_data(y, remove_nan=False)

        if len(x_arr) != len(y_arr):
            raise ValueError("X and Y must have the same length")

        pairwise_mask = np.isfinite(x_arr) & np.isfinite(y_arr)
        x_arr = x_arr[pairwise_mask]
        y_arr = y_arr[pairwise_mask]

        n = len(x_arr)
        if n < 2:
            raise ValueError("Need at least 2 paired observations for correlation")

        result = {
            'success': True,
            'alpha': format_number(alpha),
            'n': int(n),
        }

        matrices = {}

        # Pearson correlation (parametric - assumes linear relationship)
        if method in ("all", "pearson"):
            pearson_r, pearson_p = pearsonr(x_arr, y_arr)

            # Compute Pearson t-statistic and confidence interval
            df = n - 2
            if abs(pearson_r) < 1.0:
                t_stat = pearson_r * np.sqrt(df / (1 - pearson_r**2))
            else:
                t_stat = np.inf if pearson_r > 0 else -np.inf

            # Fisher z-transformation for CI (requires n > 3)
            if n > 3:
                z_r = np.arctanh(pearson_r)  # Fisher's z = arctanh(r)
                se_z = 1 / np.sqrt(n - 3)
                z_crit = norm.ppf(1 - alpha/2)
                ci_lower_z = z_r - z_crit * se_z
                ci_upper_z = z_r + z_crit * se_z
                ci_lower = np.tanh(ci_lower_z)
                ci_upper = np.tanh(ci_upper_z)
            else:
                ci_lower = None
                ci_upper = None

            result['pearson'] = {
                'correlation': format_number(pearson_r),
                'p_value': format_number(pearson_p),
                't_statistic': format_number(t_stat),
                'degrees_of_freedom': int(df),
                'ci_95_lower': format_number(ci_lower),
                'ci_95_upper': format_number(ci_upper),
                'is_significant': bool(pearson_p < alpha),
                'interpretation': 'Measures linear relationship',
                'type': 'parametric',
                'assumptions': 'Assumes bivariate normality (both X and Y normally distributed)'
            }
            matrices['pearson'] = [[1.0, float(pearson_r)], [float(pearson_r), 1.0]]

        # Spearman correlation (non-parametric - monotonic relationship, based on ranks)
        if method in ("all", "spearman"):
            spearman_r, spearman_p = spearmanr(x_arr, y_arr)

            # Compute Spearman's S statistic
            # S = sum of squared differences of ranks
            rank_x = rankdata(x_arr)
            rank_y = rankdata(y_arr)
            d_squared = (rank_x - rank_y) ** 2
            s_statistic = np.sum(d_squared)

            result['spearman'] = {
                'correlation': format_number(spearman_r),
                'p_value': format_number(spearman_p),
                's_statistic': format_number(s_statistic),
                'is_significant': bool(spearman_p < alpha),
                'interpretation': 'Measures monotonic relationship (rank-based)',
                'type': 'non-parametric',
                'assumptions': 'No distributional assumptions (distribution-free)'
            }
            matrices['spearman'] = [[1.0, float(spearman_r)], [float(spearman_r), 1.0]]

        # Kendall's tau correlation (non-parametric - concordant/discordant pairs)
        if method in ("all", "kendall"):
            # Use method='asymptotic' to stay consistent with asymptotic p-values
            kendall_tau, kendall_p = kendalltau(x_arr, y_arr, method='asymptotic')

            # Compute Kendall's z-statistic using p-value (tie-aware asymptotic).
            # Clamp p away from 0/1 to avoid infinite z while staying consistent
            # with the returned p-value.
            if kendall_p is None or np.isnan(kendall_p):
                z_stat = None
            else:
                p_clamped = min(max(float(kendall_p), np.finfo(float).tiny), 1.0 - np.finfo(float).eps)
                z_abs = norm.ppf(1 - p_clamped / 2)
                z_stat = float(np.sign(kendall_tau) * z_abs)

            result['kendall'] = {
                'correlation': format_number(kendall_tau),
                'p_value': format_number(kendall_p),
                'z_statistic': format_number(z_stat),
                'is_significant': bool(kendall_p < alpha),
                'interpretation': 'Measures ordinal association (concordance-based)',
                'type': 'non-parametric',
                'assumptions': 'No distributional assumptions (distribution-free)'
            }
            matrices['kendall'] = [[1.0, float(kendall_tau)], [float(kendall_tau), 1.0]]

        if matrices:
            result['correlation_matrices'] = matrices
            result['correlation_matrix_labels'] = ['x', 'y']

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}


def kendall_correlation(data1, data2, alpha=0.05):
    """
    Perform Kendall's tau correlation analysis

    Args:
        data1: First variable data
        data2: Second variable data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary with Kendall's tau correlation coefficient and p-value
    """
    try:
        arr1 = preprocess_data(data1)
        arr2 = preprocess_data(data2)

        if len(arr1) != len(arr2):
            raise ValueError("Data arrays must have the same length")

        if len(arr1) < 3:
            raise ValueError("Need at least 3 observations for Kendall correlation")

        # Perform Kendall's tau correlation
        tau, p_value = kendalltau(arr1, arr2)

        return {
            'success': True,
            'test_type': 'kendall_tau',
            'tau_statistic': format_number(tau),
            'p_value': format_number(p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n': int(len(arr1)),
            'interpretation': 'Measures ordinal association between variables',
            'method': 'non-parametric',
            'assumptions': 'No distributional assumptions required'
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def correlation_matrix_analysis(matrix, matrix_labels=None, alpha=0.05, method="all"):
    """
    Compute full N x N correlation matrices for multiple variables

    Used for correlation heatmap visualization when N >= 3 variables are selected.
    Computes correlation matrices for Pearson, Spearman, and Kendall by default.
    When method is specified, computes only that correlation type.

    Args:
        matrix: List of arrays, one per variable [[var1...], [var2...], ...]
        matrix_labels: Optional list of variable names
        alpha: Significance level (default 0.05)
        method: Optional correlation method ("pearson", "spearman", "kendall", or "all")

    Returns:
        Dictionary with correlation_matrices (one or more types) and labels

    Example:
        matrix = [[1, 2, 3, 4], [2, 4, 6, 8], [1, 3, 5, 7]]
        labels = ['Age', 'Height', 'Weight']
        result = correlation_matrix_analysis(matrix, labels)
        # result['correlation_matrices']['pearson'] = 3x3 matrix
    """
    try:
        import pandas as pd

        if not matrix or len(matrix) < 2:
            raise ValueError("Matrix must contain at least 2 variables")

        # Validate all arrays have same length
        lengths = [len(arr) for arr in matrix]
        if len(set(lengths)) > 1:
            raise ValueError(f"All variables must have same length, got {lengths}")

        n = lengths[0]
        if n < 3:
            raise ValueError(f"Need at least 3 observations, got {n}")

        # Generate labels if not provided or mismatched length
        if matrix_labels is None or len(matrix_labels) != len(matrix):
            matrix_labels = [f'Variable {i+1}' for i in range(len(matrix))]

        # Convert to DataFrame (handles pairwise deletion automatically for NaN)
        # Transpose: matrix is [[var1...], [var2...]], DataFrame needs columns=variables
        df = pd.DataFrame({
            matrix_labels[i]: matrix[i]
            for i in range(len(matrix))
        })

        method = (method or "all").lower()
        if method not in ("all", "pearson", "spearman", "kendall"):
            method = "all"

        n_vars = len(matrix_labels)

        def _matrix_stats(values_matrix):
            off_diag = []
            for i in range(n_vars):
                for j in range(n_vars):
                    if i == j:
                        continue
                    value = values_matrix[i][j]
                    if value is not None:
                        off_diag.append(value)

            min_corr = min(off_diag) if off_diag else 0.0
            max_corr = max(off_diag) if off_diag else 0.0
            mean_corr = sum(off_diag) / len(off_diag) if off_diag else 0.0

            # Diagonal mean (should be 1.0 for correlations)
            diag_values = [values_matrix[i][i] for i in range(n_vars)]
            diag_mean = sum(diag_values) / len(diag_values) if diag_values else 1.0
            return min_corr, max_corr, mean_corr, diag_mean

        if method == "all":
            # Compute correlation matrices for all 3 methods
            # pandas.DataFrame.corr() handles pairwise deletion of NaN automatically
            pearson_df = df.corr(method='pearson')
            spearman_df = df.corr(method='spearman')
            kendall_df = df.corr(method='kendall')

            # Convert to lists for JSON serialization
            pearson_matrix = pearson_df.values.tolist()
            spearman_matrix = spearman_df.values.tolist()
            kendall_matrix = kendall_df.values.tolist()

            min_corr, max_corr, mean_corr, diag_mean = _matrix_stats(pearson_matrix)

            return {
                'success': True,
                'correlation_matrices': {
                    'pearson': pearson_matrix,
                    'spearman': spearman_matrix,
                    'kendall': kendall_matrix,
                },
                'correlation_matrix_labels': matrix_labels,
                'n': int(n),
                'n_vars': int(n_vars),
                'alpha': format_number(alpha),
                # Stats for E2E validation
                'matrix_stats': {
                    'min_corr': format_number(min_corr),
                    'max_corr': format_number(max_corr),
                    'mean_corr': format_number(mean_corr),
                    'diag_mean': format_number(diag_mean),
                },
            }

        # Single-method matrix
        corr_df = df.corr(method=method)
        matrix_vals = corr_df.values.tolist()
        min_corr, max_corr, mean_corr, diag_mean = _matrix_stats(matrix_vals)

        return {
            'success': True,
            'correlation_matrices': {
                method: matrix_vals,
            },
            'correlation_matrix_labels': matrix_labels,
            'n': int(n),
            'n_vars': int(n_vars),
            'alpha': format_number(alpha),
            # Stats for E2E validation
            'matrix_stats': {
                'min_corr': format_number(min_corr),
                'max_corr': format_number(max_corr),
                'mean_corr': format_number(mean_corr),
                'diag_mean': format_number(diag_mean),
            },
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}
