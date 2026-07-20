"""
Parametric statistical tests (t-tests, ANOVA, etc.)

VERSION: 2.6.0
DATE: 2026-01-30
CHANGES: Added user-selectable adjustment methods for one-way ANOVA post-hoc tests.
         Supports: Tukey HSD (default), Bonferroni, Holm, Holm-Sidak, Sidak, Dunnett.

🔓 MODULE UNLOCKED - Authorized modification in progress (2026-01-30)
   - Modified: anova_one_way() to support multiple adjustment methods
   - Reason: Implement adjustment method selection per ADJUSTMENT_METHOD_IMPLEMENTATION_PLAN.md
   - User authorization: Explicit unlock granted
   - Status: REQUIRES_REVALIDATION against R baseline for all adjustment methods
"""
import numpy as np
from scipy import stats
from typing import Dict, Any, List, Optional, Union
from . import distributions
from .adjustment_utils import apply_adjustment, get_method_label
from .utils import preprocess_data, format_number, validate_input, _consume_context_metadata


def _assign_group_labels(group_labels: Optional[List[str]], k: int) -> List[str]:
    """
    Helper function to assign group labels.

    Args:
        group_labels: User-provided labels or None
        k: Number of groups

    Returns:
        List of string labels (either provided or generic "Group 1", "Group 2", etc.)
    """
    if group_labels is None or len(group_labels) != k:
        return [f"Group {i+1}" for i in range(k)]
    else:
        return [str(label) for label in group_labels]


def _build_group_normality_tests(arr: np.ndarray, alpha: float) -> List[Dict[str, Any]]:
    """
    Build the detailed per-group normality checks used by ANOVA reports.

    Individual tests have different minimum sample sizes. We keep the ANOVA
    result available and include every test that can be computed for the group.
    """
    test_specs = [
        ('shapiro_wilk', distributions.shapiro_wilk_test, 'shapiro_statistic'),
        ('kolmogorov_smirnov', distributions.kolmogorov_smirnov_test, 'ks_statistic'),
        ('anderson_darling', distributions.anderson_darling_test, 'ad_statistic'),
        ('cramer_von_mises', distributions.cramer_von_mises_test, 'cvm_statistic'),
        ('jarque_bera', distributions.jarque_bera_test, 'jb_statistic'),
    ]
    tests: List[Dict[str, Any]] = []

    for test_name, test_func, statistic_key in test_specs:
        result = test_func(arr, alpha=alpha)
        if not result.get('success'):
            continue
        tests.append({
            'test_name': test_name,
            'statistic': result.get(statistic_key),
            'p_value': result.get('p_value'),
            'is_normal': result.get('is_normal'),
        })

    return tests


def t_test_one_sample(data: List[float], population_mean: float, alpha: float = 0.05) -> Dict[str, Any]:
    """
    Perform one-sample t-test with comprehensive output

    Output includes:
    - t statistic, df, p-value
    - Sample statistics (N, Mean, Std Dev, Std Error, Min, Max)
    - 95% Confidence Interval for Mean

    Args:
        data: Sample data
        population_mean: Hypothesized population mean
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing test results
    """
    try:
        arr = preprocess_data(data)
        n = len(arr)
        df = n - 1
        if n < 2:
            return {'success': False, 'error': 'Insufficient data: at least 2 observations are required.'}

        # Core t-test
        t_stat, p_value = stats.ttest_1samp(arr, population_mean)

        # Sample statistics
        sample_mean = np.mean(arr)
        sample_std = np.std(arr, ddof=1)
        sample_sem = stats.sem(arr)
        sample_min = np.min(arr)
        sample_max = np.max(arr)

        # 95% Confidence Interval for Mean
        # CI = mean ± t_critical * SEM
        t_critical = stats.t.ppf(1 - alpha/2, df)  # Two-tailed critical value
        lower_t_critical = stats.t.ppf(alpha/2, df)  # tinv(.025, df) - negative value
        upper_t_critical = stats.t.ppf(1 - alpha/2, df)  # tinv(.975, df) - positive value
        ci_margin = t_critical * sample_sem
        ci_lower = sample_mean - ci_margin
        ci_upper = sample_mean + ci_margin

        return {
            'success': True,
            'test_type': 'one_sample',
            # Core statistics
            't_statistic': format_number(t_stat),
            'p_value': format_number(p_value),
            'degrees_of_freedom': int(df),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            't_critical': format_number(t_critical),  # Critical value for alpha/2 two-tailed
            'lower_t_critical': format_number(lower_t_critical),  # tinv(.025, df)
            'upper_t_critical': format_number(upper_t_critical),  # tinv(.975, df)
            # Sample statistics
            'n': int(n),
            'sample_mean': format_number(sample_mean),
            'sample_std': format_number(sample_std),
            'sample_sem': format_number(sample_sem),
            'sample_min': format_number(sample_min),
            'sample_max': format_number(sample_max),
            # Confidence interval
            'ci_95_lower': format_number(ci_lower),
            'ci_95_upper': format_number(ci_upper),
            # Comparison value
            'population_mean': format_number(population_mean)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}

def t_test_two_sample(data1: List[float], data2: List[float], equal_var: bool = True, alpha: float = 0.05,
                      group1_name: Optional[str] = None, group2_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Perform two-sample t-test with detailed output

    Output includes:
    - Equality of Variances test (F-test for normality, Folded F or Levene's)
    - Both Pooled and Satterthwaite (Welch) t-test results
    - Sample statistics per group (N, Mean, Std Dev, Std Error, Min, Max)
    - 95% Confidence Interval for Mean Difference

    Args:
        data1: First sample data (Group 1)
        data2: Second sample data (Group 2)
        equal_var: Whether to assume equal variances (default True)
                   Determines which test result is displayed first (Pooled or Welch)
        alpha: Significance level (default 0.05)
        group1_name: Optional name/label for Group 1 (defaults to "Group 1")
        group2_name: Optional name/label for Group 2 (defaults to "Group 2")

    Returns:
        Dictionary containing test results for both methods
    """
    try:
        arr1 = preprocess_data(data1)
        arr2 = preprocess_data(data2)

        n1, n2 = len(arr1), len(arr2)
        df_pooled = n1 + n2 - 2
        if n1 < 2 or n2 < 2:
            return {'success': False, 'error': 'Insufficient data: each group requires at least 2 observations.'}

        # Sample statistics for each group
        mean1, mean2 = np.mean(arr1), np.mean(arr2)
        std1, std2 = np.std(arr1, ddof=1), np.std(arr2, ddof=1)
        sem1, sem2 = stats.sem(arr1), stats.sem(arr2)
        min1, max1 = np.min(arr1), np.max(arr1)
        min2, max2 = np.min(arr2), np.max(arr2)

        # Mean difference
        mean_diff = mean1 - mean2

        # EQUALITY OF VARIANCES TEST (F-test)
        # Report F = var1 / var2 in original group order
        var1, var2 = np.var(arr1, ddof=1), np.var(arr2, ddof=1)
        f_stat = var1 / var2 if var2 > 0 else np.inf
        df1_f, df2_f = n1 - 1, n2 - 1
        # Two-tailed F-test p-value
        f_p_value = 2 * min(stats.f.cdf(f_stat, df1_f, df2_f), 1 - stats.f.cdf(f_stat, df1_f, df2_f))
        equal_variances = bool(f_p_value >= alpha)

        # POOLED T-TEST (Equal variances assumed)
        t_pooled, p_pooled = stats.ttest_ind(arr1, arr2, equal_var=True)
        # Pooled standard error
        pooled_var = ((n1 - 1) * var1 + (n2 - 1) * var2) / df_pooled
        se_pooled = np.sqrt(pooled_var * (1/n1 + 1/n2))
        # 95% CI for mean difference (Pooled)
        t_crit_pooled = stats.t.ppf(1 - alpha/2, df_pooled)
        lower_t_crit_pooled = stats.t.ppf(alpha/2, df_pooled)  # tinv(.025, df)
        upper_t_crit_pooled = stats.t.ppf(1 - alpha/2, df_pooled)  # tinv(.975, df)
        ci_margin_pooled = t_crit_pooled * se_pooled
        ci_pooled_lower = mean_diff - ci_margin_pooled
        ci_pooled_upper = mean_diff + ci_margin_pooled

        # WELCH'S T-TEST (Unequal variances, Satterthwaite df)
        t_welch, p_welch = stats.ttest_ind(arr1, arr2, equal_var=False)
        # Welch-Satterthwaite degrees of freedom
        numerator = (var1/n1 + var2/n2) ** 2
        denominator = (var1/n1)**2 / (n1-1) + (var2/n2)**2 / (n2-1)
        df_welch = numerator / denominator if denominator > 0 else df_pooled
        # Standard error for Welch
        se_welch = np.sqrt(var1/n1 + var2/n2)
        # 95% CI for mean difference (Welch)
        t_crit_welch = stats.t.ppf(1 - alpha/2, df_welch)
        lower_t_crit_welch = stats.t.ppf(alpha/2, df_welch)  # tinv(.025, df)
        upper_t_crit_welch = stats.t.ppf(1 - alpha/2, df_welch)  # tinv(.975, df)
        ci_margin_welch = t_crit_welch * se_welch
        ci_welch_lower = mean_diff - ci_margin_welch
        ci_welch_upper = mean_diff + ci_margin_welch

        # Primary result (Welch by default for robustness)
        t_stat = t_welch
        p_value = p_welch
        df = df_welch
        test_method = 'welch'

        # Group names (default to "Group 1" and "Group 2" if not provided)
        g1_name = group1_name if group1_name else "Group 1"
        g2_name = group2_name if group2_name else "Group 2"

        return {
            'success': True,
            'test_type': 'two_sample',
            # Primary result (Welch default)
            't_statistic': format_number(t_stat),
            'p_value': format_number(p_value),
            'degrees_of_freedom': format_number(df),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'equal_variance_assumed': False,
            'test_method': test_method,
            'recommended_method': test_method,
            # Equality of Variances Test (F-test)
            'f_statistic': format_number(f_stat),
            'f_df1': int(df1_f),
            'f_df2': int(df2_f),
            'f_p_value': format_number(f_p_value),
            'equal_variances': equal_variances,
            # Pooled t-test results (always computed)
            'pooled_t': format_number(t_pooled),
            'pooled_p': format_number(p_pooled),
            'pooled_df': int(df_pooled),
            'pooled_t_critical': format_number(t_crit_pooled),  # Critical value
            'pooled_lower_t_critical': format_number(lower_t_crit_pooled),  # tinv(.025, df)
            'pooled_upper_t_critical': format_number(upper_t_crit_pooled),  # tinv(.975, df)
            'pooled_ci_lower': format_number(ci_pooled_lower),
            'pooled_ci_upper': format_number(ci_pooled_upper),
            # Welch t-test results (always computed)
            'welch_t': format_number(t_welch),
            'welch_p': format_number(p_welch),
            'welch_df': format_number(df_welch),
            'welch_t_critical': format_number(t_crit_welch),  # Critical value
            'welch_lower_t_critical': format_number(lower_t_crit_welch),  # tinv(.025, df)
            'welch_upper_t_critical': format_number(upper_t_crit_welch),  # tinv(.975, df)
            'welch_ci_lower': format_number(ci_welch_lower),
            'welch_ci_upper': format_number(ci_welch_upper),
            # Mean difference
            'mean_difference': format_number(mean_diff),
            # Group names
            'group1_name': g1_name,
            'group2_name': g2_name,
            # Group 1 statistics
            'n1': int(n1),
            'mean1': format_number(mean1),
            'std1': format_number(std1),
            'sem1': format_number(sem1),
            'min1': format_number(min1),
            'max1': format_number(max1),
            # Group 2 statistics
            'n2': int(n2),
            'mean2': format_number(mean2),
            'std2': format_number(std2),
            'sem2': format_number(sem2),
            'min2': format_number(min2),
            'max2': format_number(max2)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def t_test_two_sample_from_aggregates(
    group1_stats: Dict[str, Any],
    group2_stats: Dict[str, Any],
    equal_var: bool = True,
    alpha: float = 0.05,
    group1_name: Optional[str] = None,
    group2_name: Optional[str] = None
) -> Dict[str, Any]:
    """
    Perform two-sample t-test using precomputed aggregates (large-mode fast path).
    """
    try:
        n1 = int(group1_stats.get('n') or 0)
        n2 = int(group2_stats.get('n') or 0)
        if n1 <= 1 or n2 <= 1:
            return {'success': False, 'error': 'Insufficient data for t-test.'}

        mean1 = group1_stats.get('mean')
        mean2 = group2_stats.get('mean')
        std1 = group1_stats.get('std')
        std2 = group2_stats.get('std')
        var1 = group1_stats.get('var')
        var2 = group2_stats.get('var')
        min1 = group1_stats.get('min')
        max1 = group1_stats.get('max')
        min2 = group2_stats.get('min')
        max2 = group2_stats.get('max')

        if mean1 is None:
            mean1 = float('nan')
        if mean2 is None:
            mean2 = float('nan')
        if std1 is None:
            std1 = float('nan')
        if std2 is None:
            std2 = float('nan')
        if var1 is None and std1 is not None:
            var1 = std1 ** 2
        if var2 is None and std2 is not None:
            var2 = std2 ** 2
        if var1 is None:
            var1 = float('nan')
        if var2 is None:
            var2 = float('nan')

        sem1 = std1 / np.sqrt(n1) if n1 > 0 else float('nan')
        sem2 = std2 / np.sqrt(n2) if n2 > 0 else float('nan')

        mean_diff = mean1 - mean2

        df_pooled = n1 + n2 - 2
        pooled_var = ((n1 - 1) * var1 + (n2 - 1) * var2) / df_pooled if df_pooled > 0 else float('nan')
        se_pooled = np.sqrt(pooled_var * (1/n1 + 1/n2)) if df_pooled > 0 else float('nan')
        t_pooled = mean_diff / se_pooled if se_pooled != 0 else float('nan')
        p_pooled = 2 * (1 - stats.t.cdf(abs(t_pooled), df_pooled)) if df_pooled > 0 else float('nan')

        numerator = (var1/n1 + var2/n2) ** 2
        denominator = (var1/n1) ** 2 / (n1 - 1) + (var2/n2) ** 2 / (n2 - 1)
        df_welch = numerator / denominator if denominator > 0 else df_pooled
        se_welch = np.sqrt(var1/n1 + var2/n2)
        t_welch = mean_diff / se_welch if se_welch != 0 else float('nan')
        p_welch = 2 * (1 - stats.t.cdf(abs(t_welch), df_welch)) if df_welch > 0 else float('nan')

        f_stat = var1 / var2 if var2 > 0 else np.inf
        df1_f, df2_f = n1 - 1, n2 - 1
        f_p_value = 2 * min(stats.f.cdf(f_stat, df1_f, df2_f), 1 - stats.f.cdf(f_stat, df1_f, df2_f))
        equal_variances = bool(f_p_value >= alpha)

        t_crit_pooled = stats.t.ppf(1 - alpha/2, df_pooled)
        lower_t_crit_pooled = stats.t.ppf(alpha/2, df_pooled)
        upper_t_crit_pooled = stats.t.ppf(1 - alpha/2, df_pooled)
        ci_margin_pooled = t_crit_pooled * se_pooled
        ci_pooled_lower = mean_diff - ci_margin_pooled
        ci_pooled_upper = mean_diff + ci_margin_pooled

        t_crit_welch = stats.t.ppf(1 - alpha/2, df_welch)
        lower_t_crit_welch = stats.t.ppf(alpha/2, df_welch)
        upper_t_crit_welch = stats.t.ppf(1 - alpha/2, df_welch)
        ci_margin_welch = t_crit_welch * se_welch
        ci_welch_lower = mean_diff - ci_margin_welch
        ci_welch_upper = mean_diff + ci_margin_welch

        # Primary result (Welch by default for robustness)
        t_stat = t_welch
        p_value = p_welch
        df = df_welch
        test_method = 'welch'

        g1_name = group1_name if group1_name else "Group 1"
        g2_name = group2_name if group2_name else "Group 2"

        return {
            'success': True,
            'test_type': 'two_sample',
            't_statistic': format_number(t_stat),
            'p_value': format_number(p_value),
            'degrees_of_freedom': format_number(df),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'equal_variance_assumed': False,
            'test_method': test_method,
            'recommended_method': test_method,
            'f_statistic': format_number(f_stat),
            'f_df1': int(df1_f),
            'f_df2': int(df2_f),
            'f_p_value': format_number(f_p_value),
            'equal_variances': equal_variances,
            'pooled_t': format_number(t_pooled),
            'pooled_p': format_number(p_pooled),
            'pooled_df': int(df_pooled),
            'pooled_t_critical': format_number(t_crit_pooled),
            'pooled_lower_t_critical': format_number(lower_t_crit_pooled),
            'pooled_upper_t_critical': format_number(upper_t_crit_pooled),
            'pooled_ci_lower': format_number(ci_pooled_lower),
            'pooled_ci_upper': format_number(ci_pooled_upper),
            'welch_t': format_number(t_welch),
            'welch_p': format_number(p_welch),
            'welch_df': format_number(df_welch),
            'welch_t_critical': format_number(t_crit_welch),
            'welch_lower_t_critical': format_number(lower_t_crit_welch),
            'welch_upper_t_critical': format_number(upper_t_crit_welch),
            'welch_ci_lower': format_number(ci_welch_lower),
            'welch_ci_upper': format_number(ci_welch_upper),
            'mean_difference': format_number(mean_diff),
            'group1_name': g1_name,
            'group2_name': g2_name,
            'n1': int(n1),
            'mean1': format_number(mean1),
            'std1': format_number(std1),
            'sem1': format_number(sem1),
            'min1': format_number(min1),
            'max1': format_number(max1),
            'n2': int(n2),
            'mean2': format_number(mean2),
            'std2': format_number(std2),
            'sem2': format_number(sem2),
            'min2': format_number(min2),
            'max2': format_number(max2)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}

def t_test_paired(data1: List[float], data2: List[float], alpha: float = 0.05) -> Dict[str, Any]:
    """
    Perform paired t-test with detailed output

    Output includes:
    - t statistic, df, p-value
    - Difference statistics (N, Mean, Std Dev, Std Error, Min, Max)
    - 95% Confidence Interval for Mean Difference

    Args:
        data1: First paired sample
        data2: Second paired sample
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing test results
    """
    try:
        arr1 = preprocess_data(data1, remove_nan=False)
        arr2 = preprocess_data(data2, remove_nan=False)

        if len(arr1) != len(arr2):
            return {'success': False, 'error': 'Paired samples must have equal length'}

        # Pairwise deletion: keep only pairs where both values are finite
        valid_mask = np.isfinite(arr1) & np.isfinite(arr2)
        arr1 = arr1[valid_mask]
        arr2 = arr2[valid_mask]

        n = len(arr1)
        df = n - 1
        if n < 2:
            return {'success': False, 'error': 'Insufficient data: at least 2 paired observations are required.'}

        # Core paired t-test
        t_stat, p_value = stats.ttest_rel(arr1, arr2)

        # Difference statistics
        differences = arr1 - arr2
        mean_diff = np.mean(differences)
        std_diff = np.std(differences, ddof=1)
        sem_diff = stats.sem(differences)
        min_diff = np.min(differences)
        max_diff = np.max(differences)

        # 95% Confidence Interval for Mean Difference
        # CI = mean_diff ± t_critical * SEM
        t_critical = stats.t.ppf(1 - alpha/2, df)
        lower_t_critical = stats.t.ppf(alpha/2, df)  # tinv(.025, df)
        upper_t_critical = stats.t.ppf(1 - alpha/2, df)  # tinv(.975, df)
        ci_margin = t_critical * sem_diff
        ci_lower = mean_diff - ci_margin
        ci_upper = mean_diff + ci_margin

        return {
            'success': True,
            'test_type': 'paired',
            # Core statistics
            't_statistic': format_number(t_stat),
            'p_value': format_number(p_value),
            'degrees_of_freedom': int(df),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            't_critical': format_number(t_critical),  # Critical value for alpha/2 two-tailed
            'lower_t_critical': format_number(lower_t_critical),  # tinv(.025, df)
            'upper_t_critical': format_number(upper_t_critical),  # tinv(.975, df)
            # Difference statistics
            'n': int(n),
            'mean_difference': format_number(mean_diff),
            'std_difference': format_number(std_diff),
            'sem_difference': format_number(sem_diff),
            'min_difference': format_number(min_diff),
            'max_difference': format_number(max_diff),
            # Confidence interval
            'ci_95_lower': format_number(ci_lower),
            'ci_95_upper': format_number(ci_upper)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}

def anova_one_way(*groups, alpha: float = 0.05, **metadata) -> Dict[str, Any]:
    """
    Perform one-way ANOVA with post-hoc Tukey HSD test, assumption checks, and effect sizes

    Best practices implementation following:
    - Fisher (1925) - Analysis of Variance
    - Levene (1960) - Test for homogeneity of variance
    - Shapiro & Wilk (1965) - Test for normality
    - Cohen (1988) - Effect size interpretation
    - Richardson (2011) - Eta-squared and omega-squared

    Args:
        groups: Variable number of group data arrays
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing ANOVA results, assumption checks, effect sizes, and post-hoc tests
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("anova_one_way")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        source_format = metadata.get("source_format", "wide")
        group_labels = metadata.get("group_labels")
        group_counts_metadata = metadata.get("group_counts")
        value_column = metadata.get("value_column")
        group_column = metadata.get("group_column")

        arrays = [preprocess_data(g) for g in groups]

        # Validate minimum sample sizes
        validation_labels = _assign_group_labels(group_labels, len(arrays))

        for idx, arr in enumerate(arrays):
            if len(arr) < 2:
                label = validation_labels[idx] if idx < len(validation_labels) else f'Group {idx+1}'
                return {'success': False, 'error': f"Group '{label}' has insufficient data (n={len(arr)}). Each group requires at least 2 observations."}

        # Calculate degrees of freedom
        k = len(arrays)  # number of groups
        n = sum(len(arr) for arr in arrays)  # total sample size
        df_between = k - 1
        df_within = n - k

        # ASSUMPTION CHECK 1: Test for Homogeneity of Variance (Levene's test)
        from scipy.stats import levene
        levene_stat, levene_p = levene(*arrays, center='median')  # Use median for robustness
        equal_variances = bool(levene_p >= alpha)

        # ASSUMPTION CHECK 2: Test for Normality (Shapiro-Wilk test for each group)
        group_labels = _assign_group_labels(group_labels, k)

        if group_counts_metadata is not None and len(group_counts_metadata) == k:
            try:
                group_counts_provided = [int(count) for count in group_counts_metadata]
            except (TypeError, ValueError):
                group_counts_provided = None
        else:
            group_counts_provided = None

        normality_results_indexed = {}
        normality_results_by_label = {}
        all_normal = True
        for idx, (arr, label) in enumerate(zip(arrays, group_labels), start=1):
            detailed_tests = _build_group_normality_tests(arr, alpha)
            normality_warning = "Normality tests are unstable for group sizes below 5" if len(arr) < 5 else None
            shapiro_entry = next(
                (test for test in detailed_tests if test.get('test_name') == 'shapiro_wilk'),
                None
            )
            if len(arr) >= 3:  # Shapiro-Wilk requires at least 3 observations
                try:
                    if shapiro_entry is not None:
                        w_stat = shapiro_entry.get('statistic')
                        norm_p = shapiro_entry.get('p_value')
                        is_normal_val = shapiro_entry.get('is_normal')
                        is_normal = bool(is_normal_val) if is_normal_val is not None else bool(norm_p >= alpha)
                    else:
                        w_stat, norm_p = stats.shapiro(arr)
                        is_normal = bool(norm_p >= alpha)
                    entry = {
                        'statistic': w_stat,
                        'p_value': norm_p,
                        'is_normal': is_normal,
                        'label': label,
                        'n': int(len(arr)),
                        'tests': detailed_tests
                    }
                    if normality_warning:
                        entry['warning'] = normality_warning
                    if not is_normal:
                        all_normal = False
                except Exception as e:
                    entry = {
                        'error': str(e),
                        'is_normal': None,
                        'label': label,
                        'n': int(len(arr)),
                        'tests': detailed_tests
                    }
                    if normality_warning:
                        entry['warning'] = normality_warning
            else:
                entry = {
                    'is_normal': None,
                    'note': 'Sample size too small for normality test',
                    'label': label,
                    'n': int(len(arr)),
                    'tests': detailed_tests
                }
                if normality_warning:
                    entry['warning'] = normality_warning
            normality_results_indexed[f'group{idx}'] = entry
            normality_results_by_label[label] = entry

        # Perform one-way ANOVA
        f_stat, p_value = stats.f_oneway(*arrays)

        # EFFECT SIZE CALCULATION
        # Calculate eta-squared (proportion of variance explained)
        grand_mean = np.mean([x for arr in arrays for x in arr])
        ss_between = sum(len(arr) * (np.mean(arr) - grand_mean)**2 for arr in arrays)
        ss_total = sum(sum((x - grand_mean)**2 for x in arr) for arr in arrays)
        eta_squared = ss_between / ss_total if ss_total > 0 else 0

        # Calculate Mean Squares (Expected Mean Square)
        ms_between = ss_between / df_between if df_between > 0 else 0

        # Calculate omega-squared (less biased estimator of effect size)
        # Formula: ω² = (SS_between - df_between * MS_within) / (SS_total + MS_within)
        ss_within = ss_total - ss_between
        ms_within = ss_within / df_within if df_within > 0 else 0
        omega_squared = (ss_between - df_between * ms_within) / (ss_total + ms_within) if (ss_total + ms_within) > 0 else 0
        omega_squared = max(0, omega_squared)  # Omega-squared can be negative in small samples, floor at 0

        # Interpret effect sizes (Cohen 1988, Richardson 2011)
        # Eta-squared: 0.01 = small, 0.06 = medium, 0.14 = large
        if eta_squared < 0.01:
            eta_interpretation = "negligible"
        elif eta_squared < 0.06:
            eta_interpretation = "small"
        elif eta_squared < 0.14:
            eta_interpretation = "medium"
        else:
            eta_interpretation = "large"

        result = {
            'success': True,
            'test_type': 'one_way_anova',
            'f_statistic': format_number(f_stat),
            'p_value': format_number(p_value),
            'df_between': int(df_between),
            'df_within': int(df_within),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'num_groups': int(k),
            'total_n': int(n),
            # Sum of Squares and Mean Squares
            'ss_between': format_number(ss_between),
            'ss_within': format_number(ss_within),
            'ss_total': format_number(ss_total),
            'ms_between': format_number(ms_between),
            'ms_within': format_number(ms_within),
            # Effect sizes
            'eta_squared': format_number(eta_squared),
            'omega_squared': format_number(omega_squared),
            'effect_size_interpretation': eta_interpretation,
            # Levene's test at top level
            'levene_statistic': format_number(levene_stat),
            'levene_p_value': format_number(levene_p),
            'equal_variances': equal_variances,
            # Normality at top level
            'all_groups_normal': all_normal,
            # Assumption checks (nested structure for backward compatibility)
            'assumptions': {
                'homogeneity_of_variance': {
                    'levene_statistic': format_number(levene_stat),
                    'levene_p_value': format_number(levene_p),
                    'equal_variances': equal_variances,
                    'test': 'Levene (median)'
                },
                'normality': {
                    'all_groups_normal': all_normal,
                    'groups': normality_results_indexed,
                    'groups_by_label': normality_results_by_label,
                    'group_labels': group_labels,
                    'test': 'Shapiro-Wilk'
                }
            },
            'group_labels': group_labels,
            'source_format': source_format
        }

        # Add group statistics with 95% CI
        group_summaries = []
        for idx, (arr, label) in enumerate(zip(arrays, group_labels), start=1):
            mean_val = np.mean(arr)
            std_val = np.std(arr, ddof=1)
            sem_val = stats.sem(arr)
            n_val = len(arr)

            # Calculate 95% Confidence Interval using pooled variance (LSMEAN approach)
            # CI = mean ± t_critical * sqrt(MSE / n)
            # Use MSE (ms_within) and df_within for pooled variance estimate (pooled-variance standard)
            # This assumes homogeneity of variance (ANOVA assumption)
            t_critical = stats.t.ppf(0.975, df=df_within)  # 0.975 for two-tailed 95% CI, df = df_within
            se_pooled = np.sqrt(ms_within / n_val)  # Standard error using pooled variance
            ci_margin = t_critical * se_pooled
            ci_lower = mean_val - ci_margin
            ci_upper = mean_val + ci_margin

            summary = {
                'index': idx,
                'label': label,
                'mean': format_number(mean_val),
                'std': format_number(std_val),
                'sem': format_number(sem_val),
                'n': int(n_val),
                'ci_95_lower': format_number(ci_lower),
                'ci_95_upper': format_number(ci_upper)
            }
            group_summaries.append(summary)

            result[f'group{idx}_label'] = label
            result[f'group{idx}_mean'] = format_number(mean_val)
            result[f'group{idx}_std'] = format_number(std_val)
            result[f'group{idx}_sem'] = format_number(sem_val)
            result[f'group{idx}_n'] = int(n_val)
            result[f'group{idx}_ci_95_lower'] = format_number(ci_lower)
            result[f'group{idx}_ci_95_upper'] = format_number(ci_upper)

        result['group_summaries'] = group_summaries
        result['group_counts'] = [summary['n'] for summary in group_summaries]

        if group_counts_provided is not None:
            result['group_counts_input'] = group_counts_provided
        if value_column is not None:
            result['value_column'] = value_column
        if group_column is not None:
            result['group_column'] = group_column

        # Perform post-hoc tests if more than 2 groups
        # Modern approach: Run post-hoc regardless of omnibus significance
        # Matches common practice across statistical software
        # Supports: Tukey HSD (default), Bonferroni, Holm, Holm-Sidak, Sidak, Dunnett
        if k > 2:
            # Get adjustment method from metadata (default: tukey)
            posthoc_adjustment = metadata.get('posthoc_adjustment', 'tukey').lower()
            control_level = metadata.get('control_level')  # Required for Dunnett

            try:
                pairwise_comparisons = []
                group_means = [np.mean(arr) for arr in arrays]
                group_ns = [len(arr) for arr in arrays]
                posthoc_q = alpha
                if posthoc_adjustment == 'fdr_bh':
                    raw_q = metadata.get('posthoc_q', alpha)
                    try:
                        posthoc_q = float(raw_q)
                    except Exception:
                        posthoc_q = alpha
                    if posthoc_q <= 0 or posthoc_q > 1:
                        posthoc_q = alpha

                def _build_comparison(label1: str, label2: str, idx1: int, idx2: int) -> Dict[str, Any]:
                    n1, n2 = group_ns[idx1], group_ns[idx2]
                    mean_diff = float(group_means[idx1] - group_means[idx2])
                    se_pooled = float(np.sqrt(ms_within * (1.0 / n1 + 1.0 / n2))) if n1 > 0 and n2 > 0 else 0.0
                    t_stat = float(mean_diff / se_pooled) if se_pooled > 0 else 0.0
                    p_raw = float(2 * stats.t.sf(abs(t_stat), df_within)) if df_within > 0 else float('nan')
                    if df_within > 0:
                        t_critical = float(stats.t.ppf(1 - alpha / 2, df_within))
                        margin = t_critical * se_pooled
                        ci_lower = float(mean_diff - margin)
                        ci_upper = float(mean_diff + margin)
                    else:
                        ci_lower = float('nan')
                        ci_upper = float('nan')

                    return {
                        'group1': label1,
                        'group2': label2,
                        'contrast': f'{label1} vs {label2}',
                        'mean_diff': mean_diff,
                        'se': se_pooled,
                        't_stat': t_stat,
                        'df': int(df_within),
                        'p_raw': p_raw,
                        'p_adjusted': p_raw,
                        'ci_lower': ci_lower,
                        'ci_upper': ci_upper,
                        'n1': int(n1),
                        'n2': int(n2),
                    }

                def _apply_one_way_ci_adjustment(
                    comparisons: List[Dict[str, Any]],
                    method: str,
                    family_alpha: float,
                ) -> None:
                    if not comparisons or df_within <= 0:
                        return

                    n_comparisons = len(comparisons)
                    if n_comparisons <= 0:
                        return

                    critical_value = None
                    if method in ['bonferroni', 'holm', 'fdr_bh']:
                        critical_value = float(
                            stats.t.ppf(1 - family_alpha / (2 * n_comparisons), df_within)
                        )
                    elif method == 'sidak':
                        sidak_alpha = 1 - (1 - family_alpha) ** (1 / n_comparisons)
                        critical_value = float(stats.t.ppf(1 - sidak_alpha / 2, df_within))

                    if critical_value is None or not np.isfinite(critical_value):
                        return

                    for comp in comparisons:
                        se = float(comp.get('se', float('nan')))
                        mean_diff = float(comp.get('mean_diff', float('nan')))
                        if not (np.isfinite(se) and np.isfinite(mean_diff)):
                            continue
                        margin = critical_value * se
                        comp['ci_lower'] = float(mean_diff - margin)
                        comp['ci_upper'] = float(mean_diff + margin)

                if posthoc_adjustment == 'tukey':
                    from scipy.stats import studentized_range, tukey_hsd
                    tukey_result = tukey_hsd(*arrays)
                    for i in range(k):
                        for j in range(i + 1, k):
                            comparison = _build_comparison(group_labels[i], group_labels[j], i, j)
                            q_stat = abs(comparison['t_stat']) * np.sqrt(2)
                            p_adj_value = float(studentized_range.sf(q_stat, k, df_within))
                            q_critical = float(studentized_range.ppf(1 - alpha, k, df_within))
                            margin = q_critical * comparison['se'] / np.sqrt(2)
                            comparison['p_adjusted'] = p_adj_value
                            comparison['ci_lower'] = float(comparison['mean_diff'] - margin)
                            comparison['ci_upper'] = float(comparison['mean_diff'] + margin)
                            comparison['method'] = 'Tukey HSD (pooled error)'
                            pairwise_comparisons.append({
                                'group1': group_labels[i],
                                'group2': group_labels[j],
                                'contrast': f'{group_labels[i]} vs {group_labels[j]}',
                                'estimate': format_number(comparison['mean_diff']),
                                'mean_difference': format_number(comparison['mean_diff']),
                                'se': format_number(comparison['se']),
                                'df': int(df_within),
                                't_stat': format_number(comparison['t_stat']),
                                'statistic': format_number(comparison['t_stat']),
                                'p_value': format_number(comparison['p_raw']),
                                'p_adjusted': format_number(comparison['p_adjusted']),
                                'ci_lower': format_number(comparison['ci_lower']),
                                'ci_upper': format_number(comparison['ci_upper']),
                                'significant': bool(comparison['p_adjusted'] < alpha),
                                'method': comparison['method'],
                            })

                    # Keep old format for backward compatibility
                    result['posthoc_tukey'] = {
                        'pvalue': [[format_number(val) for val in row] for row in tukey_result.pvalue.tolist()],
                        'statistic': [[format_number(val) for val in row] for row in tukey_result.statistic.tolist()],
                        'performed': True,
                        'group_labels': group_labels
                    }

                elif posthoc_adjustment == 'dunnett':
                    if not control_level:
                        raise ValueError("control_level required for Dunnett adjustment")
                    if control_level not in group_labels:
                        raise ValueError(f"Control level '{control_level}' not found in groups: {group_labels}")

                    # Find control group index
                    control_idx = group_labels.index(control_level)
                    numeric_comparisons = []
                    for i, label in enumerate(group_labels):
                        if i == control_idx:
                            continue
                        comparison = _build_comparison(label, control_level, i, control_idx)
                        comparison['n_control'] = int(group_ns[control_idx])
                        comparison['n_treatment'] = int(group_ns[i])
                        numeric_comparisons.append(comparison)

                    numeric_comparisons = apply_adjustment(
                        numeric_comparisons,
                        'dunnett',
                        alpha=alpha,
                        control_level=control_level,
                        k=k,
                        df=df_within,
                    )

                    for comparison in numeric_comparisons:
                        pairwise_comparisons.append({
                            'group1': comparison['group1'],
                            'group2': comparison['group2'],
                            'contrast': comparison['contrast'],
                            'estimate': format_number(comparison['mean_diff']),
                            'mean_difference': format_number(comparison['mean_diff']),
                            'se': format_number(comparison['se']),
                            'df': int(df_within),
                            't_stat': format_number(comparison['t_stat']),
                            'statistic': format_number(comparison['t_stat']),
                            'p_value': format_number(comparison['p_raw']),
                            'p_adjusted': format_number(comparison['p_adjusted']),
                            'ci_lower': format_number(comparison['ci_lower']),
                            'ci_upper': format_number(comparison['ci_upper']),
                            'significant': bool(comparison['p_adjusted'] < alpha),
                            'method': comparison.get('method', 'Dunnett (pooled MSE)'),
                        })

                    result['control_level'] = control_level

                elif posthoc_adjustment in ['bonferroni', 'holm', 'holm-sidak', 'sidak', 'fdr_bh']:
                    numeric_comparisons = []
                    for i in range(k):
                        for j in range(i + 1, k):
                            numeric_comparisons.append(
                                _build_comparison(group_labels[i], group_labels[j], i, j)
                            )

                    numeric_comparisons = apply_adjustment(
                        numeric_comparisons,
                        posthoc_adjustment,
                        alpha=alpha,
                        q=posthoc_q,
                        k=k,
                        df=df_within,
                    )

                    _apply_one_way_ci_adjustment(numeric_comparisons, posthoc_adjustment, alpha)

                    threshold = posthoc_q if posthoc_adjustment == 'fdr_bh' else alpha
                    for comparison in numeric_comparisons:
                        pairwise_comparisons.append({
                            'group1': comparison['group1'],
                            'group2': comparison['group2'],
                            'contrast': comparison['contrast'],
                            'estimate': format_number(comparison['mean_diff']),
                            'mean_difference': format_number(comparison['mean_diff']),
                            'se': format_number(comparison['se']),
                            'df': int(df_within),
                            't_stat': format_number(comparison['t_stat']),
                            'statistic': format_number(comparison['t_stat']),
                            'p_value': format_number(comparison['p_raw']),
                            'p_adjusted': format_number(comparison['p_adjusted']),
                            'ci_lower': format_number(comparison['ci_lower']),
                            'ci_upper': format_number(comparison['ci_upper']),
                            'significant': bool(comparison['p_adjusted'] < threshold),
                            'method': comparison.get('method', get_method_label(posthoc_adjustment)),
                        })

                else:
                    raise ValueError(f"Unknown adjustment method: {posthoc_adjustment}")

                result['pairwise_comparisons'] = pairwise_comparisons
                result['adjustment_method'] = get_method_label(posthoc_adjustment)
                if posthoc_adjustment == 'fdr_bh':
                    result['posthoc_q'] = format_number(posthoc_q)

                for idx, comparison in enumerate(pairwise_comparisons, start=1):
                    prefix = f'posthoc{idx}'
                    result[f'{prefix}_mean_diff'] = comparison['mean_difference']
                    result[f'{prefix}_se'] = comparison.get('se')
                    result[f'{prefix}_ci_lower'] = comparison.get('ci_lower')
                    result[f'{prefix}_ci_upper'] = comparison.get('ci_upper')
                    result[f'{prefix}_df'] = comparison.get('df')
                    result[f'{prefix}_t'] = comparison.get('t_stat')
                    result[f'{prefix}_p'] = comparison.get('p_value')
                    result[f'{prefix}_p_adj'] = comparison.get('p_adjusted')

            except Exception as e:
                result['posthoc_error'] = str(e)
                result['posthoc_tukey'] = {
                    'performed': False,
                    'error': str(e)
                }

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}
