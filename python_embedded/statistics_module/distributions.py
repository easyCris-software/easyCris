"""
Distribution and normality test functions.

VERSION: 2.2.1
DATE: 2025-11-18
CHANGES: Fixed Cramér-von Mises test - now standardizes data before testing
"""
import numpy as np
from typing import Dict, Any, List
from .utils import preprocess_data, format_number

# Import from statsmodels instead of scipy
from statsmodels.stats.diagnostic import (
    lilliefors,           # Lilliefors test (K-S with estimated parameters)
    normal_ad,            # Anderson-Darling test with p-value
)
from statsmodels.stats.stattools import jarque_bera as sm_jarque_bera
from scipy.stats import shapiro, norm  # Keep these from scipy (statsmodels doesn't have them)


def normality_tests(data, alpha=0.05):
    """
    Perform comprehensive normality tests for baseline consistency.

    Runs Shapiro-Wilk, Kolmogorov-Smirnov (Lilliefors), and Anderson-Darling tests.

    Args:
        data: Input data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing normality test results

    FIXES (2025-12-01):
    - Added Anderson-Darling test for baseline coverage
    - Use bias-corrected skewness and excess kurtosis
    - Preserve full precision for ks_p
    """
    try:
        arr = preprocess_data(data)

        # Shapiro-Wilk test (using scipy - statsmodels doesn't have this)
        shapiro_stat, shapiro_p = shapiro(arr)

        # Kolmogorov-Smirnov test with estimated parameters (Lilliefors)
        ks_stat, ks_p = lilliefors(arr, dist='norm')

        # Anderson-Darling test (from statsmodels)
        ad_stat, ad_p = normal_ad(arr)

        # Skewness and kurtosis (bias-corrected, excess kurtosis)
        from scipy import stats
        skew = stats.skew(arr, bias=False)
        kurt = stats.kurtosis(arr, bias=False, fisher=True)

        return {
            'success': True,
            'shapiro_statistic': format_number(shapiro_stat),
            'shapiro_p': format_number(shapiro_p),
            'shapiro_normal': bool(shapiro_p > alpha),
            'ks_statistic': format_number(ks_stat),
            'ks_p': ks_p,  # Keep full precision, don't call format_number()
            'ks_normal': bool(ks_p > alpha),
            'ad_a': format_number(ad_stat),
            'ad_p': format_number(ad_p),
            'ad_normal': bool(ad_p > alpha),
            'skewness': format_number(skew),
            'kurtosis': format_number(kurt),
            'alpha': format_number(alpha)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def anderson_darling_test(data, alpha=0.05):
    """
    Perform Anderson-Darling test for normality using statsmodels

    NOTE: This now returns a p-value unlike scipy's implementation

    Args:
        data: Sample data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary with Anderson-Darling test statistic and p-value
    """
    try:
        arr = preprocess_data(data)

        if len(arr) < 8:
            raise ValueError("Need at least 8 observations for Anderson-Darling test")

        # Perform Anderson-Darling test using statsmodels (returns statistic and p-value)
        ad_statistic, p_value = normal_ad(arr)

        return {
            'success': True,
            'test_type': 'anderson_darling',
            'ad_statistic': format_number(ad_statistic),
            'p_value': format_number(p_value),
            'is_normal': bool(p_value >= alpha),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n': int(len(arr)),
            'interpretation': 'Tests if data comes from a normal distribution',
            'method': 'Anderson-Darling goodness-of-fit test (statsmodels)',
            'null_hypothesis': 'Data follows a normal distribution',
            'decision': 'Fail to reject H0 (data appears normal)' if p_value >= alpha else 'Reject H0 (data deviates from normality)'
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def kolmogorov_smirnov_test(data, alpha=0.05):
    """
    Perform Lilliefors test for normality (K-S test with estimated parameters)

    NOTE: Using Lilliefors test from statsmodels, which is more appropriate
    than scipy's K-S test when parameters are estimated from data

    Args:
        data: Sample data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary with Kolmogorov-Smirnov test statistic and p-value
    """
    try:
        arr = preprocess_data(data)

        if len(arr) < 3:
            raise ValueError("Need at least 3 observations for Kolmogorov-Smirnov test")

        # Perform Lilliefors test (K-S with estimated parameters)
        ks_statistic, p_value = lilliefors(arr, dist='norm')

        return {
            'success': True,
            'test_type': 'kolmogorov_smirnov',
            'ks_statistic': format_number(ks_statistic),
            'p_value': format_number(p_value),
            'is_normal': bool(p_value >= alpha),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n': int(len(arr)),
            'interpretation': 'Tests if data comes from a normal distribution',
            'method': 'Lilliefors test (Kolmogorov-Smirnov with estimated parameters)',
            'null_hypothesis': 'Data follows a normal distribution',
            'decision': 'Fail to reject H0 (data appears normal)' if p_value >= alpha else 'Reject H0 (data deviates from normality)'
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def shapiro_wilk_test(data, alpha=0.05):
    """
    Perform Shapiro-Wilk test for normality

    Args:
        data: Sample data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary with Shapiro-Wilk test statistic and p-value
    """
    try:
        arr = preprocess_data(data)

        if len(arr) < 3:
            raise ValueError("Need at least 3 observations for Shapiro-Wilk test")

        # Perform Shapiro-Wilk test (using scipy)
        shapiro_statistic, p_value = shapiro(arr)

        return {
            'success': True,
            'test_type': 'shapiro_wilk',
            'shapiro_statistic': format_number(shapiro_statistic),
            'p_value': format_number(p_value),
            'is_normal': bool(p_value >= alpha),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n': int(len(arr)),
            'interpretation': 'Tests if data comes from a normal distribution',
            'method': 'Shapiro-Wilk normality test',
            'null_hypothesis': 'Data follows a normal distribution',
            'decision': 'Fail to reject H0 (data appears normal)' if p_value >= alpha else 'Reject H0 (data deviates from normality)'
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def cramer_von_mises_test(data, alpha=0.05):
    """
    Perform Cramér-von Mises test for normality

    NOTE: Using scipy as statsmodels doesn't have this test

    Args:
        data: Sample data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary with Cramér-von Mises test statistic and p-value
    """
    try:
        arr = preprocess_data(data)

        if len(arr) < 3:
            raise ValueError("Need at least 3 observations for Cramér-von Mises test")

        # Match R nortest::cvm.test for validation parity.
        standardized = np.sort((arr - np.mean(arr)) / np.std(arr, ddof=1))
        probabilities = norm.cdf(standardized)
        n = len(arr)
        expected = (2 * np.arange(1, n + 1) - 1) / (2 * n)
        statistic = (1 / (12 * n)) + np.sum((probabilities - expected) ** 2)
        adjusted = (1 + 0.5 / n) * statistic
        if adjusted < 0.0275:
            p_value = 1 - np.exp(-13.953 + 775.5 * adjusted - 12542.61 * adjusted ** 2)
        elif adjusted < 0.051:
            p_value = 1 - np.exp(-5.903 + 179.546 * adjusted - 1515.29 * adjusted ** 2)
        elif adjusted < 0.092:
            p_value = np.exp(0.886 - 31.62 * adjusted + 10.897 * adjusted ** 2)
        elif adjusted < 1.1:
            p_value = np.exp(1.111 - 34.242 * adjusted + 12.832 * adjusted ** 2)
        else:
            p_value = 7.37e-10

        return {
            'success': True,
            'test_type': 'cramer_von_mises',
            'cvm_statistic': format_number(statistic),
            'p_value': format_number(p_value),
            'is_normal': bool(p_value >= alpha),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n': int(len(arr)),
            'interpretation': 'Tests if data comes from a normal distribution',
            'method': 'Cramér-von Mises goodness-of-fit test',
            'null_hypothesis': 'Data follows a normal distribution',
            'decision': 'Fail to reject H0 (data appears normal)' if p_value >= alpha else 'Reject H0 (data deviates from normality)'
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def jarque_bera_test(data, alpha=0.05):
    """
    Perform Jarque-Bera test for normality using statsmodels

    Args:
        data: Sample data
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary with Jarque-Bera test statistic and p-value
    """
    try:
        arr = preprocess_data(data)

        if len(arr) < 4:
            raise ValueError("Need at least 4 observations for Jarque-Bera test")

        # Perform Jarque-Bera test using statsmodels
        jb_statistic, p_value, skewness, kurtosis = sm_jarque_bera(arr)

        return {
            'success': True,
            'test_type': 'jarque_bera',
            'jb_statistic': format_number(jb_statistic),
            'p_value': format_number(p_value),
            'is_normal': bool(p_value >= alpha),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n': int(len(arr)),
            'skewness': format_number(skewness),
            'kurtosis': format_number(kurtosis),
            'interpretation': 'Tests if data comes from a normal distribution based on skewness and kurtosis',
            'method': 'Jarque-Bera normality test (statsmodels)',
            'null_hypothesis': 'Data follows a normal distribution',
            'decision': 'Fail to reject H0 (data appears normal)' if p_value >= alpha else 'Reject H0 (data deviates from normality)'
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}
