"""
Chi-square and contingency table tests.

VERSION: 2.1.0
DATE: 2025-11-18
CHANGES: Added extended output fields to chi-square independence test:
         - Likelihood Ratio χ² (G-test)
         - Yates' Continuity Correction for 2×2 tables
         - Row and Column Percentages
"""
import numpy as np
from scipy import stats
from scipy.stats import chi2_contingency, chisquare
from typing import Dict, Any, List, Optional
from .utils import preprocess_data, format_number, sanitize_for_json, _consume_context_metadata


def chi_squared_test(observed, expected=None, alpha=0.05, **metadata):
    """
    Perform chi-squared test for independence (contingency table)
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("chi_squared_test")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        observed_array = np.array(observed, dtype=float)

        if observed_array.ndim != 2:
            return {'success': False, 'error': 'Observed frequencies must be a 2D array.'}

        if np.any(observed_array < 0):
            return {'success': False, 'error': 'Observed frequencies must be non-negative.'}

        grand_total = observed_array.sum()
        if grand_total <= 0:
            return {'success': False, 'error': 'Observed frequencies sum to zero.'}

        # Pearson chi-square (default)
        chi2_stat, p_value, dof, expected_freq = chi2_contingency(observed_array, correction=False)

        # Additional metric: Likelihood Ratio chi-square (G-test)
        # Uses log-likelihood ratio instead of Pearson χ²
        lr_chi2, lr_p_value, _, _ = chi2_contingency(observed_array, correction=False, lambda_="log-likelihood")

        r, c = observed_array.shape
        phi2 = chi2_stat / grand_total if grand_total > 0 else np.nan
        min_dim = min(r - 1, c - 1)
        cramers_v = np.sqrt(phi2 / min_dim) if min_dim > 0 and phi2 >= 0 else np.nan
        phi_coefficient = np.sqrt(phi2) if r == 2 and c == 2 and phi2 >= 0 else np.nan

        residuals = observed_array - expected_freq
        with np.errstate(divide='ignore', invalid='ignore'):
            standardized_residuals = np.where(expected_freq > 0, residuals / np.sqrt(expected_freq), np.nan)

        # Enhancement 2: Yates' Continuity Correction for 2×2 tables
        # Applied for small sample sizes to reduce Type I error
        yates_chi2 = None
        yates_p_value = None
        if r == 2 and c == 2:
            yates_chi2, yates_p_value, _, _ = chi2_contingency(observed_array, correction=True)

        # Enhancement 3: Row and Column Percentages
        # Calculated as (cell/row_total) × 100 and (cell/col_total) × 100
        row_percentages = (observed_array / observed_array.sum(axis=1, keepdims=True)) * 100
        column_percentages = (observed_array / observed_array.sum(axis=0, keepdims=True)) * 100

        result = {
            'success': True,
            'test_type': 'chi_square_independence',
            'chi_square': format_number(chi2_stat),
            'p_value': format_number(p_value),
            'degrees_of_freedom': int(dof),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'observed_frequencies': [[format_number(val) for val in row] for row in observed_array],
            'expected_frequencies': [[format_number(val) for val in row] for row in expected_freq],
            'residuals': [[format_number(val) for val in row] for row in residuals],
            'standardized_residuals': [[format_number(val) for val in row] for row in standardized_residuals],
            'row_totals': [format_number(total) for total in observed_array.sum(axis=1)],
            'column_totals': [format_number(total) for total in observed_array.sum(axis=0)],
            'grand_total': format_number(grand_total),
            'effect_sizes': {
                'cramers_v': format_number(cramers_v),
                'phi_coefficient': format_number(phi_coefficient) if not np.isnan(phi_coefficient) else None
            },
            # Industry-standard enhancements
            'likelihood_ratio_chi2': format_number(lr_chi2),
            'likelihood_ratio_p': format_number(lr_p_value),
            'row_percentages': [[format_number(val) for val in row] for row in row_percentages],
            'column_percentages': [[format_number(val) for val in row] for row in column_percentages]
        }

        # Add Yates' correction only for 2×2 tables
        if yates_chi2 is not None and yates_p_value is not None:
            result['yates_chi2'] = format_number(yates_chi2)
            result['yates_p_value'] = format_number(yates_p_value)

        if metadata:
            if 'row_labels' in metadata:
                result['row_labels'] = metadata['row_labels']
            if 'column_labels' in metadata:
                result['column_labels'] = metadata['column_labels']
            if 'row_variable' in metadata:
                result['row_variable'] = metadata['row_variable']
            if 'column_variable' in metadata:
                result['column_variable'] = metadata['column_variable']
            if 'rows_processed' in metadata:
                result['rows_processed'] = metadata['rows_processed']
            if 'rows_skipped' in metadata:
                result['rows_skipped'] = metadata['rows_skipped']

        if observed_array.shape == (2, 2):
            a, b = observed_array[0, 0], observed_array[0, 1]
            c, d = observed_array[1, 0], observed_array[1, 1]
            try:
                from statsmodels.stats.contingency_tables import Table2x2
                table_obj = Table2x2(np.array([[a, b], [c, d]], dtype=float))
                or_estimate = table_obj.oddsratio
                ci_lower, ci_upper = table_obj.oddsratio_confint(alpha=alpha)
                result['odds_ratio'] = format_number(or_estimate)
                result['odds_ratio_ci_lower'] = format_number(ci_lower)
                result['odds_ratio_ci_upper'] = format_number(ci_upper)
            except Exception:
                if b * c == 0:
                    odds_ratio_value = float('inf') if a * d > 0 else float('nan')
                    result['odds_ratio'] = format_number(odds_ratio_value)
                else:
                    odds_ratio_value = (a * d) / (b * c)
                    result['odds_ratio'] = format_number(odds_ratio_value)

        return sanitize_for_json(result)
    except Exception as e:
        return {'success': False, 'error': str(e)}


def chi_squared_goodness_of_fit(observed, expected=None, alpha=0.05, **metadata):
    """
    Perform chi-squared goodness of fit test

    Args:
        observed: Observed frequencies (1D array/list)
        expected: Expected frequencies (1D array/list, optional - uniform if None)
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing test results
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("chi_squared_goodness_of_fit")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        if isinstance(observed, (list, tuple)) and len(observed) == 1 and isinstance(observed[0], (list, tuple)):
            observed = observed[0]
        if expected is not None and isinstance(expected, (list, tuple)) and len(expected) == 1 and isinstance(expected[0], (list, tuple)):
            expected = expected[0]

        observed_array = preprocess_data(observed)

        if observed_array.ndim != 1:
            return {'success': False, 'error': 'Observed frequencies must be a 1D array.'}

        if np.any(observed_array < 0):
            return {'success': False, 'error': 'Observed frequencies must be non-negative.'}

        total_observed = observed_array.sum()
        if total_observed <= 0:
            return {'success': False, 'error': 'Observed frequencies sum to zero.'}

        if expected is None:
            n_categories = len(observed_array)
            exp_array = np.full(n_categories, total_observed / n_categories)
        else:
            exp_array = preprocess_data(expected)
            if len(exp_array) != len(observed_array):
                return {'success': False, 'error': 'Observed and expected arrays must have the same length.'}
            exp_array = exp_array * (total_observed / exp_array.sum())

        chi2_stat, p_value = chisquare(observed_array, f_exp=exp_array)
        dof = len(observed_array) - 1
        phi = np.sqrt(chi2_stat / total_observed) if total_observed > 0 else np.nan

        residuals = observed_array - exp_array
        with np.errstate(divide='ignore', invalid='ignore'):
            standardized_residuals = np.where(exp_array > 0, residuals / np.sqrt(exp_array), np.nan)

        result = {
            'success': True,
            'test_type': 'chi_square_goodness_of_fit',
            'chi_square': format_number(chi2_stat),
            'p_value': format_number(p_value),
            'degrees_of_freedom': int(dof),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'observed_frequencies': [format_number(val) for val in observed_array],
            'expected_frequencies': [format_number(val) for val in exp_array],
            'residuals': [format_number(val) for val in residuals],
            'standardized_residuals': [format_number(val) for val in standardized_residuals],
            'effect_sizes': {
                'phi_coefficient': format_number(phi)
            }
        }

        if metadata:
            if 'category_labels' in metadata:
                result['category_labels'] = metadata['category_labels']
            if 'value_column' in metadata:
                result['value_column'] = metadata['value_column']
            if 'observed_total' in metadata:
                result['observed_total'] = metadata['observed_total']
            if 'rows_processed' in metadata:
                result['rows_processed'] = metadata['rows_processed']
            if 'rows_skipped' in metadata:
                result['rows_skipped'] = metadata['rows_skipped']

        return sanitize_for_json(result)
    except Exception as e:
        return {'success': False, 'error': str(e)}


def fisher_exact_test(table, alpha=0.05, **metadata):
    """
    Perform Fisher's exact test for 2x2 contingency tables
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("fisher_exact_test")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        table_array = np.array(table, dtype=float)

        if table_array.shape != (2, 2):
            return {'success': False, 'error': "Fisher's exact test requires a 2x2 table."}

        if np.any(table_array < 0):
            return {'success': False, 'error': "Contingency table contains negative counts."}

        # Get p-value from scipy.stats.fisher_exact (this IS the exact p-value)
        _, p_value = stats.fisher_exact(table_array, alternative='two-sided')
        exact_p_value = p_value  # Fisher's exact test returns an exact p-value

        chi_square = None
        phi_coefficient = None
        ci_lower = None
        ci_upper = None
        odds_ratio = None

        # Use scipy.stats.contingency.odds_ratio for conditional MLE (reference implementation)
        try:
            from scipy.stats.contingency import odds_ratio as scipy_odds_ratio
            # Compute conditional MLE odds ratio (Fisher's noncentrality parameter)
            fisher_res = scipy_odds_ratio(table_array.astype(int), kind='conditional')
            odds_ratio = fisher_res.statistic
            # Compute Clopper-Pearson confidence interval
            ci = fisher_res.confidence_interval(confidence_level=1 - alpha)
            ci_lower, ci_upper = ci.low, ci.high
        except Exception:
            # Fall back to simple ad/bc odds ratio if scipy method fails
            a, b, c, d = table_array[0, 0], table_array[0, 1], table_array[1, 0], table_array[1, 1]
            if b * c > 0:
                odds_ratio = (a * d) / (b * c)
            else:
                odds_ratio = float('inf') if a * d > 0 else float('nan')

        result = {
            'success': True,
            'test_type': 'fisher_exact',
            'odds_ratio': format_number(odds_ratio),
            'p_value': format_number(p_value),
            'exact_p_value': format_number(exact_p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'table': [[format_number(val) for val in row] for row in table_array],
            'effect_sizes': {
                'phi_coefficient': format_number(phi_coefficient) if phi_coefficient is not None else None
            }
        }

        if chi_square is not None:
            result['chi_square'] = format_number(chi_square)
        if ci_lower is not None and ci_upper is not None:
            result['odds_ratio_ci_lower'] = format_number(ci_lower)
            result['odds_ratio_ci_upper'] = format_number(ci_upper)

        if metadata:
            if 'row_labels' in metadata:
                result['row_labels'] = metadata['row_labels']
            if 'column_labels' in metadata:
                result['column_labels'] = metadata['column_labels']
            if 'row_variable' in metadata:
                result['row_variable'] = metadata['row_variable']
            if 'column_variable' in metadata:
                result['column_variable'] = metadata['column_variable']
            if 'rows_processed' in metadata:
                result['rows_processed'] = metadata['rows_processed']
            if 'rows_skipped' in metadata:
                result['rows_skipped'] = metadata['rows_skipped']

        return sanitize_for_json(result)
    except Exception as e:
        return {'success': False, 'error': str(e)}


def mcnemar_test(table, alpha=0.05, **metadata):
    """
    Perform McNemar's test for paired nominal data.
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("mcnemar_test")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        table_array = np.array(table, dtype=float)

        if table_array.shape != (2, 2):
            return {'success': False, 'error': "McNemar's test requires a 2x2 table."}

        if np.any(table_array < 0):
            return {'success': False, 'error': "Contingency table contains negative counts."}

        a = table_array[0, 0]
        b_default = table_array[0, 1]
        c_default = table_array[1, 0]
        d = table_array[1, 1]

        row_labels = metadata.get('row_labels')
        column_labels = metadata.get('column_labels')

        if row_labels and column_labels and len(row_labels) == 2 and len(column_labels) == 2:
            # Align discordant pairs with row 2 -> col 1 and row 1 -> col 2 ordering
            b = table_array[1, 0]
            c = table_array[0, 1]
        else:
            b = b_default
            c = c_default

        discordant_total = b + c
        if discordant_total == 0:
            return {'success': False, 'error': 'No discordant pairs found (b + c = 0). McNemar test is undefined.'}

        # Use uncorrected chi-square to align with validation baseline defaults
        chi_square_stat = (b - c) ** 2 / discordant_total

        # Asymptotic chi-square p-value (df=1)
        p_value = 1 - stats.chi2.cdf(chi_square_stat, df=1)
        test_used = "Chi-square (uncorrected)"

        try:
            exact_p_value = stats.binomtest(int(c), int(discordant_total), 0.5, alternative="two-sided").pvalue
        except Exception:
            exact_p_value = 2 * min(
                stats.binom.cdf(min(b, c), discordant_total, 0.5),
                1 - stats.binom.cdf(max(b, c) - 1, discordant_total, 0.5)
            )

        phi_coefficient = np.sqrt(chi_square_stat / (a + b + c + d)) if chi_square_stat is not None else None

        result = {
            'success': True,
            'test_type': 'mcnemar',
            'test': test_used,
            'p_value': format_number(p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'exact_p_value': format_number(exact_p_value),
            'table': [[format_number(val) for val in row] for row in table_array],
            'discordant_pairs': {
                'b': format_number(b),
                'c': format_number(c),
                'total': format_number(discordant_total)
            },
            'effect_sizes': {
                'phi_coefficient': format_number(phi_coefficient) if phi_coefficient is not None else None
            }
        }

        if chi_square_stat is not None:
            result['chi_square'] = format_number(chi_square_stat)

        if metadata:
            if 'row_labels' in metadata:
                result['row_labels'] = metadata['row_labels']
            if 'column_labels' in metadata:
                result['column_labels'] = metadata['column_labels']
            if 'row_variable' in metadata:
                result['row_variable'] = metadata['row_variable']
            if 'column_variable' in metadata:
                result['column_variable'] = metadata['column_variable']
            if 'rows_processed' in metadata:
                result['rows_processed'] = metadata['rows_processed']
            if 'rows_skipped' in metadata:
                result['rows_skipped'] = metadata['rows_skipped']

        return sanitize_for_json(result)
    except Exception as e:
        return {'success': False, 'error': str(e)}
