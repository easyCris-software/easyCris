"""
Non-parametric statistical tests.

VERSION: 2.3.2
DATE: 2026-02-16
CHANGES: Removed eager matplotlib startup import in compiled mode.
         Matplotlib/scikit-posthocs are no longer required for core
         nonparametric execution path.

🔒 MODULE RELOCKED - Authorized modification complete (2026-02-16)
   - Modified: kruskal_wallis() post-hoc gating logic
   - Modified: Removed eager matplotlib import to avoid compiled startup aborts
   - Reason: Keep nonparametric runtime path import-safe in compiled backend
   - User authorization: Explicit unlock granted
   - Status: REQUIRES_REVALIDATION against updated baseline

PREVIOUS VERSION: 2.3.1 (2026-01-12)
         - Included eager matplotlib Agg import
"""
import numpy as np
from scipy import stats
import pandas as pd
from typing import Dict, Any, List, Optional
from .utils import preprocess_data, format_number, _consume_context_metadata

def _adjust_pvalues(pvalues: List[float], method: Optional[str]) -> List[float]:
    if not pvalues:
        return []
    if method is None:
        return list(pvalues)

    method = method.lower()
    m = len(pvalues)

    if method in {"bonferroni", "bonf"}:
        return [min(1.0, p * m) for p in pvalues]

    if method in {"fdr_bh", "bh", "benjamini-hochberg"}:
        indexed = sorted(enumerate(pvalues), key=lambda item: item[1])
        adjusted = [0.0] * m
        prev = 1.0
        for rank, (idx, p) in enumerate(reversed(indexed), start=1):
            adj = min(prev, (p * m) / (m - rank + 1))
            adjusted[idx] = min(1.0, adj)
            prev = adjusted[idx]
        return adjusted

    return list(pvalues)

def _dunn_pairwise(arrays: List[np.ndarray], labels: List[str], p_adjust: Optional[str]) -> List[Dict[str, float]]:
    all_values = np.concatenate(arrays) if arrays else np.array([])
    n_total = len(all_values)
    if n_total == 0:
        return []

    ranks = stats.rankdata(all_values)
    _, tie_counts = np.unique(all_values, return_counts=True)
    tie_term = np.sum(tie_counts ** 3 - tie_counts)
    tie_correction = 1.0 - (tie_term / (n_total ** 3 - n_total)) if n_total > 1 else 1.0
    variance = (n_total * (n_total + 1) / 12.0) * tie_correction

    rank_arrays = []
    start_idx = 0
    for arr in arrays:
        end_idx = start_idx + len(arr)
        rank_arrays.append(ranks[start_idx:end_idx])
        start_idx = end_idx

    mean_ranks = [np.mean(rank_arr) if len(rank_arr) else 0.0 for rank_arr in rank_arrays]
    ns = [len(arr) for arr in arrays]

    pairs = []
    raw_pvalues = []
    for i in range(len(arrays)):
        for j in range(i + 1, len(arrays)):
            se = np.sqrt(variance * (1.0 / ns[i] + 1.0 / ns[j])) if ns[i] and ns[j] else np.nan
            z = (mean_ranks[i] - mean_ranks[j]) / se if np.isfinite(se) and se != 0 else 0.0
            p_raw = 2.0 * (1.0 - stats.norm.cdf(abs(z)))
            pairs.append((i, j, p_raw))
            raw_pvalues.append(p_raw)

    adjusted = _adjust_pvalues(raw_pvalues, p_adjust)
    results = []
    for idx, (i, j, p_raw) in enumerate(pairs):
        results.append({
            'group1': labels[i],
            'group2': labels[j],
            'p_value': p_raw,
            'p_adjusted': adjusted[idx],
        })
    return results

def wilcoxon_signed_rank(data1: List[float], data2: List[float], alpha: float = 0.05) -> Dict[str, Any]:
    """
    Perform Wilcoxon signed-rank test (non-parametric alternative to paired t-test)

    Best practices implementation following:
    - Wilcoxon (1945) - original paper
    - Pratt (1959) - handling of zero differences
    - Cureton (1967) - rank-biserial correlation for effect size

    Args:
        data1: First paired sample
        data2: Second paired sample
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing test results including:
        - W statistic (sum of positive ranks)
        - p-value (two-sided)
        - effect size (rank-biserial correlation)
        - median difference
        - number of zero differences (excluded from analysis)

    Notes:
        - Uses exact distribution for n ≤ 25 (when no ties)
        - Uses normal approximation for n > 25 or when ties present
        - Zero differences are excluded (Pratt method)
        - Handles ties by assigning average ranks
    """
    try:
        arr1 = preprocess_data(data1)
        arr2 = preprocess_data(data2)

        if len(arr1) != len(arr2):
            return {'success': False, 'error': 'Paired samples must have equal length'}

        # Calculate differences
        differences = arr1 - arr2

        # Count zero differences (will be excluded per Pratt 1959)
        n_zeros = np.sum(differences == 0)
        n_nonzero = len(differences) - n_zeros
        # Detect ties among absolute non-zero differences
        abs_nonzero = np.abs(differences[differences != 0])
        ties_present = False
        if abs_nonzero.size > 0:
            _, tie_counts = np.unique(abs_nonzero, return_counts=True)
            ties_present = np.any(tie_counts > 1)

        if n_nonzero < 1:
            return {'success': False, 'error': 'All differences are zero - no variation to test'}

        # Perform Wilcoxon signed-rank test
        # mode='approx': uses normal approximation when ties exist
        # scipy's mode='auto' uses exact even with ties for small n, causing mismatch
        # correction=True: applies continuity correction (default behavior)
        # alternative='two-sided': tests if median difference ≠ 0
        # zero_method='pratt': exclude zero differences (best practice)
        use_exact = (n_nonzero <= 50) and (not ties_present) and (n_zeros == 0)
        mode = 'exact' if use_exact else 'approx'
        correction = not use_exact

        statistic, p_value = stats.wilcoxon(
            arr1, arr2,
            zero_method='pratt',
            alternative='two-sided',
            mode=mode,
            correction=correction
        )

        # Calculate effect size: rank-biserial correlation (Cureton 1967)
        # r = (4 * W) / (n * (n + 1)) - 1
        # where W is the sum of positive ranks and n is the number of non-zero differences
        # Range: -1 to +1 (similar to correlation)
        r_rb = (4 * statistic) / (n_nonzero * (n_nonzero + 1)) - 1

        # Interpret effect size (Kerby 2014)
        if abs(r_rb) < 0.2:
            effect_interpretation = "negligible"
        elif abs(r_rb) < 0.5:
            effect_interpretation = "small"
        elif abs(r_rb) < 0.8:
            effect_interpretation = "medium"
        else:
            effect_interpretation = "large"

        # Calculate median difference (more appropriate than mean for non-parametric)
        median_diff = float(np.median(differences))

        # Determine which distribution was used
        method_used = "exact" if use_exact else "normal approximation"

        # Standard rank statistics under H0 (null hypothesis: median difference = 0)
        # Use the reference formula (no tie correction).
        expected_rank_sum = (n_nonzero * (n_nonzero + 1)) / 4.0
        std_rank_sum = np.sqrt((n_nonzero * (n_nonzero + 1) * (2 * n_nonzero + 1)) / 24.0)
        # Sum of negative ranks (complement of W)
        sum_negative_ranks = (n_nonzero * (n_nonzero + 1) / 2.0) - statistic

        return {
            'success': True,
            'test_type': 'wilcoxon_signed_rank',
            'W_statistic': format_number(statistic),
            'w_statistic': format_number(statistic),
            'p_value': format_number(p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n_pairs': int(len(arr1)),
            'n_zero_differences': int(n_zeros),
            'n_nonzero_differences': int(n_nonzero),
            'median_difference': format_number(median_diff),
            'rank_biserial_correlation': format_number(r_rb),
            'effect_size_interpretation': effect_interpretation,
            'method': method_used,
            # Standard rank statistics
            'sum_positive_ranks': format_number(statistic),  # W statistic = sum of positive ranks
            'sum_negative_ranks': format_number(sum_negative_ranks),
            'expected_rank_sum_H0': format_number(expected_rank_sum),
            'std_rank_sum_H0': format_number(std_rank_sum)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}

def mann_whitney_u(data1: List[float], data2: List[float], alpha: float = 0.05,
                   group_name1: str = "Group 1", group_name2: str = "Group 2") -> Dict[str, Any]:
    """
    Perform Mann-Whitney U test (Wilcoxon rank-sum test for unpaired data)

    Best practices implementation following:
    - Mann & Whitney (1947) - original paper
    - Wilcoxon (1945) - rank-sum test
    - Conover (1999) - modern statistical methods

    Args:
        data1: First unpaired sample
        data2: Second unpaired sample
        alpha: Significance level (default 0.05)
        group_name1: Name/label for first group (default "Group 1")
        group_name2: Name/label for second group (default "Group 2")

    Returns:
        Dictionary containing test results including:
        - U statistic
        - p-value (two-sided)
        - effect size (rank-biserial correlation)
        - median difference
        - confidence that samples differ
        - group names for display

    Notes:
        - Non-parametric alternative to two-sample (unpaired) t-test
        - Does not assume normal distribution
        - Tests if two independent samples come from same distribution
        - Uses exact distribution for small samples (n1*n2 < 20)
        - Uses normal approximation for larger samples
    """
    try:
        arr1 = preprocess_data(data1)
        arr2 = preprocess_data(data2)

        n1 = len(arr1)
        n2 = len(arr2)

        if n1 < 1 or n2 < 1:
            return {'success': False, 'error': 'Both samples must have at least one observation'}

        # Perform Mann-Whitney U test
        # Reference script forces normal approximation with continuity correction.
        use_exact = False
        method = 'asymptotic'
        statistic, p_value = stats.mannwhitneyu(
            arr1, arr2,
            alternative='two-sided',
            method=method,
            use_continuity=True
        )

        # Calculate median difference (more appropriate than mean for non-parametric)
        median1 = float(np.median(arr1))
        median2 = float(np.median(arr2))
        median_diff = median1 - median2

        # Determine which method was used
        method_used = "normal_approximation"

        # Standard rank statistics
        # Combine and rank all data
        combined = np.concatenate([arr1, arr2])
        ranks = stats.rankdata(combined)

        # Sum of ranks for each group
        sum_ranks_1 = np.sum(ranks[:n1])
        sum_ranks_2 = np.sum(ranks[n1:])

        # Effect size (rank-biserial correlation) matching reference script:
        # r = 1 - (2*U) / (n1*n2)
        u1 = sum_ranks_1 - (n1 * (n1 + 1)) / 2.0
        r_rb = 1 - (2 * statistic) / (n1 * n2)

        # Interpret effect size (following Cohen's conventions adapted for rank-biserial)
        if abs(r_rb) < 0.1:
            effect_interpretation = "negligible"
        elif abs(r_rb) < 0.3:
            effect_interpretation = "small"
        elif abs(r_rb) < 0.5:
            effect_interpretation = "medium"
        else:
            effect_interpretation = "large"

        # Expected sum of ranks for group 1 under H0 (null hypothesis: same distribution)
        expected_sum_ranks_1 = n1 * (n1 + n2 + 1) / 2.0

        # Standard deviation of sum of ranks under H0
        std_sum_ranks = np.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12.0)

        # Standard U statistic parameters under H0
        expected_U = n1 * n2 / 2.0
        std_U = np.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12.0)

        # Z-statistic (no continuity correction in reported z)
        z_score = (statistic - expected_U) / std_U if std_U > 0 else 0.0

        return {
            'success': True,
            'test_type': 'mann_whitney_u',
            'U_statistic': format_number(statistic),
            'u_statistic': format_number(statistic),
            'p_value': format_number(p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'n1': int(n1),
            'n2': int(n2),
            'median1': format_number(median1),
            'median2': format_number(median2),
            'median_difference': format_number(median_diff),
            'rank_biserial_correlation': format_number(r_rb),
            'effect_size_interpretation': effect_interpretation,
            'method': method_used,
            # Standard rank statistics
            'sum_ranks_group1': format_number(sum_ranks_1),
            'sum_ranks_group2': format_number(sum_ranks_2),
            'expected_sum_ranks_H0': format_number(expected_sum_ranks_1),
            'std_sum_ranks_H0': format_number(std_sum_ranks),
            # U statistic parameters
            'expected_U_H0': format_number(expected_U),
            'std_U_H0': format_number(std_U),
            'z_statistic': format_number(z_score),
            'z_score': format_number(z_score),
            # Group names for display (actual column names from C#)
            'group_name1': group_name1,
            'group_name2': group_name2
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}

def kruskal_wallis(*groups, alpha: float = 0.05, **metadata) -> Dict[str, Any]:
    """
    Perform Kruskal-Wallis H-test (non-parametric alternative to one-way ANOVA)

    Tests whether samples from multiple groups come from the same distribution.
    Does not assume normality - uses rank-based approach.

    Args:
        groups: Variable number of group data arrays
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing Kruskal-Wallis test results
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("kruskal_wallis")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        source_format = metadata.get("source_format", "wide")
        group_labels = metadata.get("group_labels")
        group_counts_metadata = metadata.get("group_counts")
        value_column = metadata.get("value_column")
        group_column = metadata.get("group_column")

        # Preprocess each group
        arrays = [preprocess_data(g) for g in groups]

        # Validate minimum requirements
        if len(arrays) < 2:
            return {'success': False, 'error': 'Kruskal-Wallis test requires at least 2 groups'}

        # Check sample sizes
        for i, arr in enumerate(arrays):
            if len(arr) < 2:
                return {'success': False, 'error': f'Group {i+1} has only {len(arr)} samples. Each group needs at least 2 samples.'}

        if group_labels is None or len(group_labels) != len(arrays):
            group_labels = [f"Group {i+1}" for i in range(len(arrays))]
        else:
            group_labels = [str(label) for label in group_labels]

        if group_counts_metadata is not None and len(group_counts_metadata) == len(arrays):
            try:
                group_counts_provided = [int(count) for count in group_counts_metadata]
            except (TypeError, ValueError):
                group_counts_provided = None
        else:
            group_counts_provided = None

        # Perform Kruskal-Wallis test
        statistic, p_value = stats.kruskal(*arrays)

        # Calculate effect size (epsilon-squared - similar to eta-squared for ANOVA)
        # Formula: epsilon^2 = H / (n - 1)  [standard convention]
        n_total = sum(len(arr) for arr in arrays)
        k = len(arrays)
        epsilon_sq = float(statistic) / float(n_total - 1)
        epsilon_sq = max(0.0, min(1.0, epsilon_sq))  # Bound between 0 and 1

        # Effect size interpretation
        if epsilon_sq < 0.01:
            effect_interpretation = "negligible"
        elif epsilon_sq < 0.06:
            effect_interpretation = "small"
        elif epsilon_sq < 0.14:
            effect_interpretation = "medium"
        else:
            effect_interpretation = "large"

        # Standard rank statistics: Combine all data and rank
        all_values = np.concatenate(arrays)
        all_ranks = stats.rankdata(all_values)

        # Split ranks back into groups
        rank_arrays = []
        start_idx = 0
        for arr in arrays:
            end_idx = start_idx + len(arr)
            rank_arrays.append(all_ranks[start_idx:end_idx])
            start_idx = end_idx

        # Calculate summaries for each group (including rank statistics)
        group_summaries = []
        for idx, (arr, label, rank_arr) in enumerate(zip(arrays, group_labels, rank_arrays), start=1):
            n_i = len(arr)
            sum_ranks = np.sum(rank_arr)
            # Expected sum of ranks under H0 (null: all groups from same distribution)
            expected_sum_ranks = n_i * (n_total + 1) / 2.0
            # Standard deviation of sum of ranks under H0
            std_sum_ranks = np.sqrt((n_i * (n_total + 1) * (k - 1)) / 12.0)

            summary = {
                'index': idx,
                'label': label,
                'median': format_number(np.median(arr)),
                'mean': format_number(np.mean(arr)),
                'std': format_number(np.std(arr, ddof=1)),
                'n': int(n_i),
                # Standard rank statistics
                'sum_ranks': format_number(sum_ranks),
                'mean_rank': format_number(sum_ranks / n_i),  # Average rank for this group
                'expected_sum_ranks_H0': format_number(expected_sum_ranks),
                'std_sum_ranks_H0': format_number(std_sum_ranks)
            }
            group_summaries.append(summary)

        result = {
            'success': True,
            'test_type': 'kruskal_wallis',
            'h_statistic': format_number(statistic),
            'df': int(k - 1),  # Degrees of freedom = number of groups - 1
            'p_value': format_number(p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'num_groups': int(k),
            'total_n': int(n_total),
            'sample_sizes': [summary['n'] for summary in group_summaries],
            'group_labels': group_labels,
            'group_summaries': group_summaries,
            'group_medians': [summary['median'] for summary in group_summaries],
            'epsilon_squared': format_number(epsilon_sq, decimals=4),  # Explicit 4 decimals for precision
            'effect_size_interpretation': effect_interpretation,
            'assumptions': 'Non-parametric test. Assumptions: (1) Independent samples, (2) Ordinal or continuous data, (3) Similar distributions across groups',
            'source_format': source_format
        }

        # Perform post-hoc Dunn's test if more than 2 groups
        # Modern approach: Run post-hoc regardless of omnibus significance
        # Matches behavior of major statistical software packages
        if k > 2:
            try:
                posthoc_method = str(metadata.get("posthoc_adjustment", "bonferroni")).lower()
                if posthoc_method not in {"bonferroni", "fdr_bh"}:
                    posthoc_method = "bonferroni"
                posthoc_q_value = None
                if posthoc_method == "fdr_bh":
                    try:
                        posthoc_q_value = float(metadata.get("posthoc_q", alpha))
                    except Exception:
                        posthoc_q_value = float(alpha)
                    if posthoc_q_value <= 0 or posthoc_q_value > 1:
                        posthoc_q_value = float(alpha)
                posthoc_threshold = posthoc_q_value if posthoc_method == "fdr_bh" else float(alpha)

                dunn_pairs = _dunn_pairwise(arrays, group_labels, p_adjust=posthoc_method)

                pairwise_comparisons = []
                group_medians = {label: np.median(arr) for label, arr in zip(group_labels, arrays)}

                for pair in dunn_pairs:
                    label_i = pair['group1']
                    label_j = pair['group2']
                    p_raw = pair['p_value']
                    p_adj = pair['p_adjusted']

                    comparison = {
                        'group1': label_i,
                        'group2': label_j,
                        'contrast': f'{label_i} vs {label_j}',
                        'median_difference': format_number(group_medians[label_i] - group_medians[label_j]),
                        'p_value': format_number(p_raw),
                        'p_adjusted': format_number(p_adj),
                        'significant': bool(p_adj < posthoc_threshold)
                    }
                    pairwise_comparisons.append(comparison)

                result['pairwise_comparisons'] = pairwise_comparisons
                if posthoc_method == "fdr_bh":
                    result['adjustment_method'] = "Dunn's test (Benjamini-Hochberg)"
                    result['posthoc_q'] = format_number(posthoc_threshold)
                else:
                    result['adjustment_method'] = "Dunn's test (Bonferroni)"

            except Exception as e:
                # If Dunn test fails, add error note but don't fail the whole analysis
                result['posthoc_error'] = f"Dunn's test failed: {str(e)}"

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}


def scheirer_ray_hare(values, factor1, factor2, alpha=0.05, **metadata):
    """
    Perform Scheirer–Ray–Hare test (non-parametric alternative to two-way ANOVA)

    Computes main effects for two factors and their interaction using ranked data.
    """
    try:
        metadata = metadata or {}
        context_metadata = _consume_context_metadata("scheirer_ray_hare")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        factor_names = metadata.get("factor_names") or []
        dependent_label = metadata.get("dependent_variable", "Value")
        factor_level_labels = metadata.get("factor_level_labels") or {}
        source_format = metadata.get("source_format", "wide")
        rows_processed = metadata.get("rows_processed")
        simple_effects = metadata.get("simple_effects")

        factor1_name = factor_names[0] if len(factor_names) > 0 else "Factor 1"
        factor2_name = factor_names[1] if len(factor_names) > 1 else "Factor 2"

        values_arr = np.asarray(values, dtype=float)
        factor1_arr = np.asarray(factor1, dtype=float)
        factor2_arr = np.asarray(factor2, dtype=float)

        if not (len(values_arr) == len(factor1_arr) == len(factor2_arr)):
            return {'success': False, 'error': 'Scheirer–Ray–Hare requires aligned value and factor arrays of equal length.'}

        finite_mask = np.isfinite(values_arr) & np.isfinite(factor1_arr) & np.isfinite(factor2_arr)
        values_arr = values_arr[finite_mask]
        factor1_arr = factor1_arr[finite_mask].astype(int)
        factor2_arr = factor2_arr[finite_mask].astype(int)

        if len(values_arr) < 3:
            return {'success': False, 'error': 'Scheirer–Ray–Hare requires at least 3 observations after cleaning.'}

        # Map encoded factor levels back to labels for readability
        factor1_levels_list = factor_level_labels.get(factor1_name, [])
        factor2_levels_list = factor_level_labels.get(factor2_name, [])
        factor1_lookup = {idx: lvl for idx, lvl in enumerate(factor1_levels_list)}
        factor2_lookup = {idx: lvl for idx, lvl in enumerate(factor2_levels_list)}

        factor1_labels = [factor1_lookup.get(code, f"{factor1_name}_{code}") for code in factor1_arr]
        factor2_labels = [factor2_lookup.get(code, f"{factor2_name}_{code}") for code in factor2_arr]

        df = pd.DataFrame({
            'value': values_arr,
            factor1_name: factor1_labels,
            factor2_name: factor2_labels,
            'factor1_encoded': factor1_arr,
            'factor2_encoded': factor2_arr
        })

        N = len(df)
        if N < 3:
            return {'success': False, 'error': 'Scheirer–Ray–Hare requires at least 3 observations.'}

        if df[factor1_name].nunique() < 2 or df[factor2_name].nunique() < 2:
            return {'success': False, 'error': 'Scheirer–Ray–Hare requires at least two levels for each factor.'}

        # Rank the dependent variable
        df['rank'] = stats.rankdata(df['value'])

        # Calculate tie correction factor for H-statistic
        # tie_corr = 1 - Σ(t³-t)/(N³-N) where t is count of each tied group
        unique_vals, counts = np.unique(df['value'], return_counts=True)
        tie_sum = np.sum(counts**3 - counts)
        tie_corr = 1.0 - (tie_sum / (N**3 - N)) if N > 1 else 1.0

        # Group aggregations
        rank_sum_a = df.groupby(factor1_name)['rank'].sum()
        rank_sum_b = df.groupby(factor2_name)['rank'].sum()
        rank_sum_ab = df.groupby([factor1_name, factor2_name])['rank'].sum()

        n_a = df.groupby(factor1_name)['rank'].count()
        n_b = df.groupby(factor2_name)['rank'].count()
        n_ab = df.groupby([factor1_name, factor2_name])['rank'].count()

        a_levels = len(rank_sum_a)
        b_levels = len(rank_sum_b)

        df_a = a_levels - 1
        df_b = b_levels - 1
        df_ab = df_a * df_b

        if df_a <= 0 or df_b <= 0 or df_ab <= 0:
            return {'success': False, 'error': 'Scheirer–Ray–Hare requires at least two levels per factor to compute degrees of freedom.'}

        denominator = N * (N + 1)
        # Calculate uncorrected H-statistics
        H_a_uncorrected = (12 / denominator) * np.sum((rank_sum_a ** 2) / n_a) - 3 * (N + 1)
        H_b_uncorrected = (12 / denominator) * np.sum((rank_sum_b ** 2) / n_b) - 3 * (N + 1)
        H_total_uncorrected = (12 / denominator) * np.sum((rank_sum_ab ** 2) / n_ab) - 3 * (N + 1)
        H_ab_uncorrected = max(0.0, H_total_uncorrected - H_a_uncorrected - H_b_uncorrected)

        # Apply tie correction: divide H by tie_corr (equivalent to multiplying by 1/tie_corr)
        H_a = H_a_uncorrected / tie_corr if tie_corr > 0 else H_a_uncorrected
        H_b = H_b_uncorrected / tie_corr if tie_corr > 0 else H_b_uncorrected
        H_total = H_total_uncorrected / tie_corr if tie_corr > 0 else H_total_uncorrected
        H_ab = H_ab_uncorrected / tie_corr if tie_corr > 0 else H_ab_uncorrected

        # Sum of Squares (ANOVA-on-ranks approach)
        # Formula: SS = H_uncorrected * N * (N+1) / 12 (inverse of H = SS / MStotalSokal)
        # where MStotalSokal = N * (N+1) / 12
        # IMPORTANT: Use uncorrected H for SS calculation (no tie correction in SS)
        MS_total_sokal = float(N * (N + 1)) / 12.0
        ss_a_r_style = float(H_a_uncorrected * MS_total_sokal)
        ss_b_r_style = float(H_b_uncorrected * MS_total_sokal)
        ss_ab_r_style = float(H_ab_uncorrected * MS_total_sokal)

        p_a = float(stats.chi2.sf(H_a, df_a))
        p_b = float(stats.chi2.sf(H_b, df_b))
        p_ab = float(stats.chi2.sf(H_ab, df_ab))

        def interpret_eta(value):
            if value is None:
                return None
            if value < 0.01:
                return "negligible"
            if value < 0.06:
                return "small"
            if value < 0.14:
                return "medium"
            return "large"

        eta_sq_a = max(0.0, min(1.0, H_a / (N - 1))) if N > 1 else None
        eta_sq_b = max(0.0, min(1.0, H_b / (N - 1))) if N > 1 else None
        eta_sq_ab = max(0.0, min(1.0, H_ab / (N - 1))) if N > 1 else None

        # Standard rank statistics for Factor 1 levels
        factor1_rank_stats = []
        for lvl in sorted(df[factor1_name].unique()):
            group = df[df[factor1_name] == lvl]
            n_i = len(group)
            sum_ranks = group['rank'].sum()
            # Expected sum of ranks under H0 (null: no factor effect)
            expected_sum_ranks = n_i * (N + 1) / 2.0
            # Std dev of sum of ranks under H0
            std_sum_ranks = np.sqrt((n_i * (N + 1) * (a_levels - 1)) / 12.0)

            factor1_rank_stats.append({
                'level': str(lvl),
                'n': int(n_i),
                'sum_ranks': format_number(sum_ranks),
                'expected_sum_ranks_H0': format_number(expected_sum_ranks),
                'std_sum_ranks_H0': format_number(std_sum_ranks)
            })

        # Standard rank statistics for Factor 2 levels
        factor2_rank_stats = []
        for lvl in sorted(df[factor2_name].unique()):
            group = df[df[factor2_name] == lvl]
            n_i = len(group)
            sum_ranks = group['rank'].sum()
            # Expected sum of ranks under H0 (null: no factor effect)
            expected_sum_ranks = n_i * (N + 1) / 2.0
            # Std dev of sum of ranks under H0
            std_sum_ranks = np.sqrt((n_i * (N + 1) * (b_levels - 1)) / 12.0)

            factor2_rank_stats.append({
                'level': str(lvl),
                'n': int(n_i),
                'sum_ranks': format_number(sum_ranks),
                'expected_sum_ranks_H0': format_number(expected_sum_ranks),
                'std_sum_ranks_H0': format_number(std_sum_ranks)
            })

        cell_summaries = []
        for (lvl_a, lvl_b), group in df.groupby([factor1_name, factor2_name]):
            values = group['value']
            q1 = np.percentile(values, 25)
            q3 = np.percentile(values, 75)
            iqr = q3 - q1
            cell_summaries.append({
                'factor1_level': lvl_a,
                'factor2_level': lvl_b,
                'n': int(values.count()),
                'rank_sum': format_number(group['rank'].sum()),
                'median': format_number(np.median(values)),
                'q1': format_number(q1),
                'q3': format_number(q3),
                'iqr': format_number(iqr),
                'mean': format_number(np.mean(values))
            })

        # POST-HOC PAIRWISE COMPARISONS (Phase 2): Run Dunn's test for significant main effects
        pairwise_comparisons = []
        adjustment_method = "Dunn's test (Benjamini-Hochberg)"

        # Always run main effects post-hoc (regardless of simple effects selection)
        # Then additionally run requested simple effects
        
        # Factor 1 post-hoc (if significant and >=2 levels)
        if p_a < alpha and a_levels >= 2:
            try:
                factor1_levels_list = list(rank_sum_a.index)
                factor1_arrays = [
                    df[df[factor1_name] == lvl]['value'].to_numpy()
                    for lvl in factor1_levels_list
                ]
                dunn_pairs_f1 = _dunn_pairwise(factor1_arrays, [str(lvl) for lvl in factor1_levels_list], p_adjust='fdr_bh')
                factor1_medians = {lvl: df[df[factor1_name] == lvl]['value'].median() for lvl in factor1_levels_list}

                for pair in dunn_pairs_f1:
                    lvl_i = pair['group1']
                    lvl_j = pair['group2']
                    p_raw = pair['p_value']
                    p_adj = pair['p_adjusted']

                    comparison = {
                        'factor': factor1_name,
                        'group1': str(lvl_i),
                        'group2': str(lvl_j),
                        'contrast': f'{lvl_i} vs {lvl_j}',
                        'median_difference': format_number(factor1_medians[lvl_i] - factor1_medians[lvl_j]),
                        'p_value': format_number(p_raw),
                        'p_adjusted': format_number(p_adj),
                        'significant': bool(p_adj < alpha)
                    }
                    pairwise_comparisons.append(comparison)
            except Exception as e:
                # If post-hoc fails, log to stderr but don't fail the entire test
                import sys
                print(f"Warning: Scheirer-Ray-Hare Factor 1 post-hoc failed: {str(e)}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        # Factor 2 post-hoc (if significant and >=2 levels)
        if p_b < alpha and b_levels >= 2:
            try:
                factor2_levels_list = list(rank_sum_b.index)
                factor2_arrays = [
                    df[df[factor2_name] == lvl]['value'].to_numpy()
                    for lvl in factor2_levels_list
                ]
                dunn_pairs_f2 = _dunn_pairwise(factor2_arrays, [str(lvl) for lvl in factor2_levels_list], p_adjust='fdr_bh')
                factor2_medians = {lvl: df[df[factor2_name] == lvl]['value'].median() for lvl in factor2_levels_list}

                for pair in dunn_pairs_f2:
                    lvl_i = pair['group1']
                    lvl_j = pair['group2']
                    p_raw = pair['p_value']
                    p_adj = pair['p_adjusted']

                    comparison = {
                        'factor': factor2_name,
                        'group1': str(lvl_i),
                        'group2': str(lvl_j),
                        'contrast': f'{lvl_i} vs {lvl_j}',
                        'median_difference': format_number(factor2_medians[lvl_i] - factor2_medians[lvl_j]),
                        'p_value': format_number(p_raw),
                        'p_adjusted': format_number(p_adj),
                        'significant': bool(p_adj < alpha)
                    }
                    pairwise_comparisons.append(comparison)
            except Exception as e:
                # If post-hoc fails, log to stderr but don't fail the entire test
                import sys
                print(f"Warning: Scheirer-Ray-Hare Factor 2 post-hoc failed: {str(e)}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        # PHASE 3: Simple effects analysis - DISABLED in v2.1.1
        #
        # Simple effects for Scheirer-Ray-Hare are disabled pending validation.
        #
        # Reason: The implementation re-ranks data within slices, which may not be
        # statistically correct. For parametric tests (Two-Way/Multi-Factorial ANOVA),
        # we use pooled error from the overall model. For non-parametric tests, we should
        # likely use pooled ranks from the overall ranking, but this methodology is not
        # clearly established in the statistical literature.
        #
        # Baseline implementation does not include simple effects.
        #
        # To re-enable: Research correct methodology (pooled ranks vs re-ranking),
        # establish baseline for comparison, validate thoroughly.
        #
        # See: SCHEIRER_RAY_HARE_SIMPLE_EFFECTS_ANALYSIS.md for detailed analysis

        simple_effects_warning = None
        if simple_effects is not None and isinstance(simple_effects, dict):
            import sys
            print(f"WARNING: Simple effects requested for Scheirer-Ray-Hare but this feature is disabled (v2.1.1).", file=sys.stderr)
            print(f"  Reason: Implementation not validated against baseline. Re-ranking methodology questionable.", file=sys.stderr)
            print(f"  Use validated main effects and interaction instead.", file=sys.stderr)
            simple_effects_warning = "Simple effects for Scheirer-Ray-Hare are disabled pending validation. Use main effects and interaction."

        # Sum of squares calculations (component of H-statistic formula)
        ss_a = np.sum((rank_sum_a.values ** 2) / n_a.values)
        ss_b = np.sum((rank_sum_b.values ** 2) / n_b.values)
        ss_total = np.sum((rank_sum_ab.values ** 2) / n_ab.values)
        ss_ab = max(0.0, ss_total - ss_a - ss_b)

        # Residual calculations
        residual_df = int(N - a_levels * b_levels)
        # Total sum of squared ranks
        total_ss_ranks = np.sum(df['rank'] ** 2)
        # Residual SS = Total SS - (SS_a + SS_b + SS_ab)
        residual_ss = max(0.0, total_ss_ranks - ss_total)

        result = {
            'success': True,
            'test_type': 'scheirer_ray_hare',
            'num_observations': int(N),
            'total_n': int(N),  # alias for compatibility
            'factor1_label': factor1_name,
            'factor2_label': factor2_name,
            'interaction_label': f"{factor1_name} × {factor2_name}",
            # Factor 1
            'factor1_chi_square': format_number(H_a),
            'factor1_H': format_number(H_a),  # alias for compatibility
            'factor1_df': int(df_a),
            'factor1_p': format_number(p_a),
            'factor1_significant': bool(p_a < alpha),  # boolean flag
            'factor1_ss': format_number(ss_a_r_style),  # ANOVA-on-ranks sum of squares
            'factor1_eta_squared': format_number(eta_sq_a),
            'factor1_effect_interpretation': interpret_eta(eta_sq_a) if eta_sq_a is not None else None,
            # Factor 2
            'factor2_chi_square': format_number(H_b),
            'factor2_H': format_number(H_b),  # alias for compatibility
            'factor2_df': int(df_b),
            'factor2_p': format_number(p_b),
            'factor2_significant': bool(p_b < alpha),  # boolean flag
            'factor2_ss': format_number(ss_b_r_style),  # ANOVA-on-ranks sum of squares
            'factor2_eta_squared': format_number(eta_sq_b),
            'factor2_effect_interpretation': interpret_eta(eta_sq_b) if eta_sq_b is not None else None,
            # Interaction
            'interaction_chi_square': format_number(H_ab),
            'interaction_H': format_number(H_ab),  # alias for compatibility
            'interaction_df': int(df_ab),
            'interaction_p': format_number(p_ab),
            'interaction_significant': bool(p_ab < alpha),  # boolean flag
            'interaction_ss': format_number(ss_ab_r_style),  # ANOVA-on-ranks sum of squares
            'interaction_eta_squared': format_number(eta_sq_ab),
            'interaction_effect_interpretation': interpret_eta(eta_sq_ab) if eta_sq_ab is not None else None,
            # Residual
            'residual_df': residual_df,
            'residual_ss': format_number(residual_ss),
            # Factor levels and summaries
            'factor1_levels': list(rank_sum_a.index.astype(str)),
            'factor2_levels': list(rank_sum_b.index.astype(str)),
            'cell_summaries': cell_summaries,
            # Standard rank statistics per factor level
            'factor1_rank_stats': factor1_rank_stats,
            'factor2_rank_stats': factor2_rank_stats,
            'value_column': dependent_label,
            'source_format': source_format,
            'rows_processed': int(rows_processed) if rows_processed is not None else int(N),
            'assumptions': 'Non-parametric test. Assumptions: (1) Independent observations, (2) Ordinal or continuous dependent variable, (3) Balanced or near-balanced cell sizes recommended.'
        }

        # Add post-hoc comparisons if any were computed
        if pairwise_comparisons:
            result['pairwise_comparisons'] = pairwise_comparisons
            result['adjustment_method'] = adjustment_method

        # Add simple effects warning if interaction not significant
        if simple_effects_warning:
            result['simple_effects_warning'] = simple_effects_warning

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}


def friedman_test(*samples, alpha=0.05, **metadata):
    """
    Perform Friedman test (non-parametric alternative to repeated measures ANOVA)

    Tests for differences across multiple related samples (repeated measures).
    Does not assume normality - uses rank-based approach.

    Args:
        samples: Variable number of related sample arrays (must have same length)
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing Friedman test results
    """
    try:
        # Preprocess each sample
        arrays = [preprocess_data(s) for s in samples]

        # Validate minimum requirements
        if len(arrays) < 3:
            return {'success': False, 'error': 'Friedman test requires at least 3 related samples (conditions/time points)'}

        # Check that all samples have the same length (paired data)
        lengths = [len(arr) for arr in arrays]
        if len(set(lengths)) > 1:
            return {'success': False, 'error': f'All samples must have the same length for Friedman test. Got lengths: {lengths}'}

        n_subjects = lengths[0]
        if n_subjects < 3:
            return {'success': False, 'error': f'Need at least 3 subjects/blocks. Got {n_subjects}.'}

        metadata = metadata or {}
        context_metadata = _consume_context_metadata("friedman_test")
        if context_metadata:
            context_metadata.update(metadata)
            metadata = context_metadata

        source_format = metadata.get("source_format", "wide")
        condition_labels = metadata.get("condition_labels")
        subject_labels = metadata.get("subject_labels")
        value_column = metadata.get("value_column")
        condition_column = metadata.get("condition_column")
        subject_column = metadata.get("subject_column")
        excluded_subjects = metadata.get("excluded_subjects")
        duplicate_pairs = metadata.get("duplicate_pairs_ignored")

        if condition_labels is None or len(condition_labels) != len(arrays):
            condition_labels = [f"Condition {i+1}" for i in range(len(arrays))]
        else:
            condition_labels = [str(label) for label in condition_labels]

        if subject_labels is None or len(subject_labels) != n_subjects:
            subject_labels = [f"Subject {i+1}" for i in range(n_subjects)]
        else:
            subject_labels = [str(label) for label in subject_labels]

        # Perform Friedman test
        statistic, p_value = stats.friedmanchisquare(*arrays)

        # Calculate effect size (Kendall's W - coefficient of concordance)
        k = len(arrays)  # number of conditions/treatments
        n = n_subjects
        kendalls_w = statistic / (n * (k - 1))
        kendalls_w = max(0, min(1, kendalls_w))  # Bound between 0 and 1

        # Effect size interpretation for Kendall's W
        if kendalls_w < 0.1:
            effect_interpretation = "negligible"
        elif kendalls_w < 0.3:
            effect_interpretation = "small"
        elif kendalls_w < 0.5:
            effect_interpretation = "medium"
        else:
            effect_interpretation = "large"

        # Standard rank statistics: Friedman ranks within each subject (block)
        # Create subject × condition matrix and rank within each subject
        data_matrix = np.column_stack(arrays)  # n_subjects × k conditions
        # Rank each row (subject) separately
        rank_matrix = np.apply_along_axis(stats.rankdata, axis=1, arr=data_matrix)
        # Sum ranks for each condition (column sum)
        sum_ranks_per_condition = np.sum(rank_matrix, axis=0)

        # Expected sum of ranks for each condition under H0 (null: no condition differences)
        expected_sum_ranks = n * (k + 1) / 2.0

        # Standard deviation of sum of ranks under H0 (for Friedman test)
        std_sum_ranks = np.sqrt((n * k * (k + 1)) / 12.0)

        # Calculate medians for each condition (with rank statistics)
        condition_summaries = []
        for idx, (arr, label) in enumerate(zip(arrays, condition_labels)):
            condition_summaries.append({
                'label': label,
                'median': format_number(np.median(arr)),
                'mean': format_number(np.mean(arr)),
                'std': format_number(np.std(arr, ddof=1)),
                'n': int(len(arr)),
                # Standard rank statistics
                'sum_ranks': format_number(sum_ranks_per_condition[idx]),
                'mean_rank': format_number(sum_ranks_per_condition[idx] / n),  # Average rank for this condition
                'expected_sum_ranks_H0': format_number(expected_sum_ranks),
                'std_sum_ranks_H0': format_number(std_sum_ranks)
            })

        # POST-HOC PAIRWISE COMPARISONS (Phase 2): Run Wilcoxon with Benjamini-Hochberg adjustment if significant and >2 conditions
        pairwise_comparisons = []
        adjustment_method = "Pairwise Wilcoxon (Benjamini-Hochberg)"

        if p_value < alpha and k > 2:
            try:
                from statsmodels.stats.multitest import multipletests
                from scipy.stats import wilcoxon

                condition_medians = {label: np.median(arr) for label, arr in zip(condition_labels, arrays)}

                # Calculate unadjusted p-values using pairwise Wilcoxon signed-rank tests
                p_values_unadj = []
                comparison_info = []

                for i in range(k):
                    for j in range(i + 1, k):
                        label_i = condition_labels[i]
                        label_j = condition_labels[j]

                        # Compute unadjusted p-value using Wilcoxon signed-rank test
                        try:
                            _, p_unadj = wilcoxon(arrays[i], arrays[j])
                        except Exception:
                            p_unadj = np.nan

                        p_values_unadj.append(p_unadj)
                        comparison_info.append({
                            'label_i': label_i,
                            'label_j': label_j,
                            'i': i,
                            'j': j
                        })

                # Apply Benjamini-Hochberg correction to all p-values
                reject, p_values_adj, _, _ = multipletests(p_values_unadj, alpha=alpha, method='fdr_bh')

                # Build comparison list with both unadjusted and adjusted p-values
                for idx, info in enumerate(comparison_info):
                    comparison = {
                        'group1': str(info['label_i']),
                        'group2': str(info['label_j']),
                        'contrast': f'{info["label_i"]} vs {info["label_j"]}',
                        'median_difference': format_number(condition_medians[info['label_i']] - condition_medians[info['label_j']]),
                        'p_value': format_number(p_values_unadj[idx]),
                        'p_adjusted': format_number(p_values_adj[idx]),
                        'significant': bool(p_values_adj[idx] < alpha)
                    }
                    pairwise_comparisons.append(comparison)
            except Exception as e:
                # If post-hoc fails, log to stderr but don't fail the entire test
                import sys
                print(f"Warning: Friedman post-hoc failed: {str(e)}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        result = {
            'success': True,
            'test_type': 'friedman',
            'chi_square_statistic': format_number(statistic),
            'df': int(k - 1),  # Degrees of freedom = number of conditions - 1
            'p_value': format_number(p_value),
            'is_significant': bool(p_value < alpha),
            'alpha': format_number(alpha),
            'num_conditions': int(k),
            'num_subjects': int(n),
            'condition_labels': condition_labels,
            'subject_labels': subject_labels,
            'condition_medians': [summary['median'] for summary in condition_summaries],
            'condition_summaries': condition_summaries,
            'kendalls_w': format_number(kendalls_w),
            'effect_size_interpretation': effect_interpretation,
            'source_format': source_format,
            'assumptions': 'Non-parametric test for repeated measures. Assumptions: (1) Related/paired samples, (2) Ordinal or continuous data, (3) Same subjects measured under all conditions'
        }

        if value_column is not None:
            result['value_column'] = value_column
        if condition_column is not None:
            result['condition_column'] = condition_column
        if subject_column is not None:
            result['subject_column'] = subject_column
        if excluded_subjects:
            result['excluded_subjects'] = [str(subj) for subj in excluded_subjects if subj is not None]
        if duplicate_pairs is not None:
            try:
                result['duplicate_pairs_ignored'] = int(duplicate_pairs)
            except (TypeError, ValueError):
                result['duplicate_pairs_ignored'] = duplicate_pairs

        # Add post-hoc comparisons if any were computed
        if pairwise_comparisons:
            result['pairwise_comparisons'] = pairwise_comparisons
            result['adjustment_method'] = adjustment_method

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}
