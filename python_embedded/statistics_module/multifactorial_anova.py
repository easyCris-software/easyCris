# VERSION: 1.4
# DATE: 2025-12-11
"""
Multi-Factorial ANOVA Module

Performs multi-factorial ANOVA with 3+ factors, configurable interaction depth,
Type III SS for unbalanced designs, effect sizes, and simple effects analysis.

Uses statsmodels for analysis with dynamic formula generation.

CHANGES (v1.4):
- Implemented statistically correct simple effects using pooled error
- Simple effects now use MSE and df from overall ANOVA (pooled error approach)
- Manual Tukey HSD computation with studentized range distribution
- Validated against baseline: all 12 simple effects metrics match exactly
- SE constant at 0.8269 (pooled), df = 8 for all comparisons

CHANGES (v1.3):
- Fixed simple effects crash caused by scikit-posthocs matplotlib import
- Replaced scikit-posthocs with statsmodels (partial fix, p-values were wrong)
"""

import json
import sys
import numpy as np
import pandas as pd
from itertools import combinations, product
from math import comb
from scipy import stats
from typing import Any, Dict, List

# Statsmodels imports
import statsmodels.api as sm
from statsmodels.formula.api import ols
from statsmodels.stats.anova import anova_lm
from .adjustment_utils import apply_adjustment, get_method_label
from . import distributions
# Import Sum contrasts for Type III SS compatibility
from patsy.contrasts import Sum
from patsy import build_design_matrices

from .utils import format_number


def _build_residual_normality_tests(residuals: np.ndarray, alpha: float) -> List[Dict[str, Any]]:
    """Build detailed residual normality diagnostics for factorial ANOVA reports."""
    test_specs = [
        ('shapiro_wilk', distributions.shapiro_wilk_test, 'shapiro_statistic'),
        ('kolmogorov_smirnov', distributions.kolmogorov_smirnov_test, 'ks_statistic'),
        ('anderson_darling', distributions.anderson_darling_test, 'ad_statistic'),
        ('cramer_von_mises', distributions.cramer_von_mises_test, 'cvm_statistic'),
        ('jarque_bera', distributions.jarque_bera_test, 'jb_statistic'),
    ]
    tests: List[Dict[str, Any]] = []

    for test_name, test_func, statistic_key in test_specs:
        result = test_func(residuals, alpha=alpha)
        if not result.get('success'):
            continue
        tests.append({
            'test_name': test_name,
            'statistic': result.get(statistic_key),
            'p_value': result.get('p_value'),
            'is_normal': result.get('is_normal'),
        })

    return tests


def decode_factor_values(
    factor_values: dict,
    factor_level_labels: dict = None,
) -> dict:
    """
    Decode factor values using factor_level_labels if provided.
    """
    decoded_values = {}
    for factor_name, encoded_val in factor_values.items():
        if factor_level_labels and factor_name in factor_level_labels:
            labels = factor_level_labels[factor_name]
            try:
                idx = int(float(str(encoded_val)))
                if 0 <= idx < len(labels):
                    decoded_values[factor_name] = labels[idx]
                else:
                    decoded_values[factor_name] = str(encoded_val)
            except (ValueError, TypeError):
                decoded_values[factor_name] = str(encoded_val)
        else:
            decoded_values[factor_name] = str(encoded_val)
    return decoded_values


def _infer_factor_level_order(
    series: pd.Series,
    labels: list = None,
    baseline: str = None,
) -> list:
    values = [str(val) for val in series.dropna().tolist()]
    seen = set()
    appearance_order = []
    def _canonicalize_whole_number(value: str) -> str:
        if "." not in value:
            return value
        try:
            num = float(value)
            if float(int(num)) == num:
                return str(int(num))
        except (TypeError, ValueError):
            return value
        return value
    for val in values:
        canonical_val = _canonicalize_whole_number(val)
        if canonical_val not in seen:
            seen.add(canonical_val)
            appearance_order.append(canonical_val)

    def _is_numeric(value: str) -> bool:
        try:
            float(value)
            return True
        except (TypeError, ValueError):
            return False

    def _as_int_if_whole(value: str):
        try:
            num = float(value)
            if float(int(num)) == num:
                return int(num)
        except (TypeError, ValueError):
            return None
        return None

    values_numeric = all(_is_numeric(val) for val in appearance_order) if appearance_order else False
    numeric_indices = [
        _as_int_if_whole(val) for val in appearance_order if _as_int_if_whole(val) is not None
    ]
    values_are_indices = (
        labels is not None
        and len(numeric_indices) == len(appearance_order)
        and all(0 <= idx < len(labels) for idx in numeric_indices)
    )

    if labels is not None and values_are_indices:
        ordered = [str(idx) for idx in range(len(labels)) if str(idx) in seen]
    elif values_numeric:
        ordered = sorted(appearance_order, key=lambda val: float(val))
    else:
        ordered = appearance_order

    baseline_value = str(baseline) if baseline is not None else None
    if baseline_value and labels is not None and values_are_indices and baseline_value in labels:
        baseline_value = str(labels.index(baseline_value))

    if baseline_value and baseline_value in ordered:
        ordered = [baseline_value] + [val for val in ordered if val != baseline_value]

    return ordered


def build_formula_with_depth(factor_names: list, max_depth: int = None) -> str:
    """
    Build statsmodels formula with configurable interaction depth.

    Args:
        factor_names: List of factor names ["A", "B", "C", "D"]
        max_depth: Maximum interaction order
                   - None or >= len(factors): Full model (all interactions)
                   - 0 or 1: Main effects only
                   - 2: Main effects + 2-way interactions
                   - 3: Main effects + 2-way + 3-way interactions

    Returns:
        Formula string for statsmodels OLS with Sum contrasts for Type III SS
    """
    n_factors = len(factor_names)

    # Determine actual max depth
    if max_depth is None or max_depth > n_factors:
        actual_max_depth = n_factors
    elif max_depth < 1:
        actual_max_depth = 1  # Main effects only
    else:
        actual_max_depth = max_depth

    # Build terms list
    terms = []

    # Add main effects (depth 1) - wrap in C(factor, Sum) for sum-to-zero contrasts
    # This ensures Type III SS matches the sum-contrast baseline
    for factor in factor_names:
        terms.append(f"C({factor}, Sum)")

    # Add interactions up to max depth - wrap each factor in C(factor, Sum)
    for depth in range(2, actual_max_depth + 1):
        for combo in combinations(factor_names, depth):
            # Create interaction term with sum contrasts: C(A, Sum):C(B, Sum):C(C, Sum)
            interaction_term = ":".join([f"C({f}, Sum)" for f in combo])
            terms.append(interaction_term)

    formula = f"DV ~ {' + '.join(terms)}"

    return formula


def count_terms_by_depth(n_factors: int, max_depth: int = None) -> dict:
    """
    Calculate number of terms at each interaction depth.

    Returns:
        Dictionary with counts per depth and total
    """
    if max_depth is None or max_depth > n_factors:
        actual_max_depth = n_factors
    elif max_depth < 1:
        actual_max_depth = 1
    else:
        actual_max_depth = max_depth

    result = {}
    total = 0

    for depth in range(1, actual_max_depth + 1):
        count = comb(n_factors, depth)
        result[depth] = count
        total += count

    result["total"] = total
    return result


def get_interaction_terms_by_depth(factor_names: list, max_depth: int = None) -> dict:
    """
    Get actual term names organized by depth (with Sum contrasts).

    Returns:
        Dictionary mapping depth to list of term names
    """
    n_factors = len(factor_names)

    if max_depth is None or max_depth > n_factors:
        actual_max_depth = n_factors
    elif max_depth < 1:
        actual_max_depth = 1
    else:
        actual_max_depth = max_depth

    result = {}

    for depth in range(1, actual_max_depth + 1):
        terms = []
        for combo in combinations(factor_names, depth):
            # Use C(factor, Sum) notation to match ANOVA table index names
            if depth == 1:
                # Main effect: C(factor1, Sum)
                terms.append(f"C({combo[0]}, Sum)")
            else:
                # Interaction: C(factor1, Sum):C(factor2, Sum):...
                term = ":".join([f"C({f}, Sum)" for f in combo])
                terms.append(term)
        result[depth] = terms

    return result


def calculate_effect_sizes(ss_effect, ss_total, ss_error, df_effect, df_error):
    """
    Calculate effect sizes.

    Args:
        ss_effect: Sum of squares for the effect
        ss_total: Total sum of squares
        ss_error: Error/residual sum of squares
        df_effect: Degrees of freedom for effect
        df_error: Degrees of freedom for error

    Returns:
        Tuple of (partial_eta_squared, omega_squared)
    """
    # Partial eta-squared (matches UI label + baseline)
    denom = ss_effect + ss_error
    eta_squared = ss_effect / denom if denom > 0 else 0

    # Omega-squared (less biased estimator)
    ms_error = ss_error / df_error if df_error > 0 else 0
    omega_squared = (ss_effect - df_effect * ms_error) / (ss_total + ms_error)
    omega_squared = max(0, omega_squared)  # Can't be negative

    return eta_squared, omega_squared


def perform_tukey_posthoc(
    df,
    dv_col,
    factor_col,
    alpha=0.05,
    posthoc_adjustment="tukey",
    posthoc_q=None,
    control_level=None,
    mse_pooled=None,
    df_pooled=None,
    model=None,
    factor_names=None,
    factor_levels=None,
    factor_level_labels=None,
):
    """
    Perform Tukey HSD post-hoc test for a single factor.

    Returns:
        List of pairwise comparison dictionaries
    """
    try:
        posthoc_method = str(posthoc_adjustment or "tukey").lower()
        if posthoc_method not in ["tukey", "bonferroni", "holm", "holm-sidak", "sidak", "dunnett", "fdr_bh"]:
            posthoc_method = "tukey"
        posthoc_q_value = None
        if posthoc_method == "fdr_bh":
            try:
                posthoc_q_value = float(posthoc_q) if posthoc_q is not None else float(alpha)
            except Exception:
                posthoc_q_value = float(alpha)
            if posthoc_q_value <= 0 or posthoc_q_value > 1:
                posthoc_q_value = float(alpha)
        posthoc_threshold = posthoc_q_value if posthoc_method == "fdr_bh" else float(alpha)

        factor_levels_map = factor_levels if isinstance(factor_levels, dict) else None
        if factor_levels_map is None and factor_names:
            factor_levels_map = {
                name: list(df[name].cat.categories)
                if isinstance(df[name].dtype, pd.CategoricalDtype)
                else sorted(df[name].unique())
                for name in factor_names
            }

        if isinstance(factor_levels_map, dict) and factor_col in factor_levels_map:
            levels = factor_levels_map.get(factor_col)
        elif isinstance(df[factor_col].dtype, pd.CategoricalDtype):
            levels = list(df[factor_col].cat.categories)
        else:
            levels = sorted(df[factor_col].unique())
        group_ns = {level: int(len(df[df[factor_col] == level])) for level in levels}

        design_info = None
        cov_beta = None
        params = None
        if model is not None and factor_names:
            try:
                design_info = model.model.data.design_info
                cov_beta = model.cov_params()
                params = model.params
            except Exception:
                design_info = None

        level_set = {str(level) for level in levels}
        control_level_str = str(control_level) if control_level is not None else None
        if control_level_str and factor_level_labels and factor_col in factor_level_labels:
            labels = [str(item) for item in factor_level_labels[factor_col]]
            if control_level_str not in level_set and control_level_str in labels:
                control_level_str = str(labels.index(control_level_str))

        level_stats = {}
        other_factors = [name for name in (factor_names or []) if name != factor_col]
        for level in levels:
            if design_info is not None and cov_beta is not None and params is not None and factor_levels_map:
                grid_rows = []
                if other_factors:
                    for combo in product(*[factor_levels_map[name] for name in other_factors]):
                        row = {factor_col: level}
                        row.update(dict(zip(other_factors, combo)))
                        grid_rows.append(row)
                else:
                    grid_rows.append({factor_col: level})

                grid_df = pd.DataFrame(grid_rows)
                for name in factor_levels_map:
                    grid_df[name] = pd.Categorical(
                        grid_df[name],
                        categories=factor_levels_map[name],
                        ordered=True,
                    )
                X = build_design_matrices([design_info], grid_df, return_type="dataframe")[0]
                xbar = np.asarray(X).mean(axis=0)
                mean_val = float(np.dot(xbar, params))
                var_val = float(np.dot(xbar, np.dot(cov_beta, xbar.T)))
                se_val = float(np.sqrt(var_val)) if var_val >= 0 else 0.0
                level_stats[level] = {
                    "mean": mean_val,
                    "se": se_val,
                    "n": group_ns.get(level, 0),
                    "xbar": xbar,
                }
            else:
                df_level = df[df[factor_col] == level]
                mean_val = float(df_level[dv_col].mean()) if len(df_level) > 0 else 0.0
                n_level = max(len(df_level), 1)
                se_val = float(np.sqrt(mse_pooled / n_level)) if mse_pooled is not None else float(df_level[dv_col].std(ddof=1) / np.sqrt(n_level))
                level_stats[level] = {
                    "mean": mean_val,
                    "se": se_val,
                    "n": group_ns.get(level, 0),
                    "xbar": None,
                }

        comparisons = []
        k = len(levels)
        for i in range(k):
            for j in range(i + 1, k):
                group1 = str(levels[i])
                group2 = str(levels[j])
                n1 = group_ns.get(levels[i], 0)
                n2 = group_ns.get(levels[j], 0)
                if n1 == 0 or n2 == 0:
                    continue

                mean1 = level_stats[levels[i]]["mean"]
                mean2 = level_stats[levels[j]]["mean"]
                mean_diff = float(mean1 - mean2)

                xbar1 = level_stats[levels[i]].get("xbar")
                xbar2 = level_stats[levels[j]].get("xbar")
                if xbar1 is not None and xbar2 is not None and cov_beta is not None:
                    xdiff = xbar1 - xbar2
                    var_diff = float(np.dot(xdiff, np.dot(cov_beta, xdiff.T)))
                    se_diff = float(np.sqrt(var_diff)) if var_diff >= 0 else 0.0
                else:
                    se1 = float(level_stats[levels[i]]["se"])
                    se2 = float(level_stats[levels[j]]["se"])
                    se_diff = float(np.sqrt(se1 ** 2 + se2 ** 2))

                t_stat = mean_diff / se_diff if se_diff > 0 else 0
                p_raw = float(2 * stats.t.sf(abs(t_stat), df_pooled)) if df_pooled and df_pooled > 0 else float("nan")

                # Default CI from t distribution
                if df_pooled and df_pooled > 0:
                    t_critical = stats.t.ppf(1 - alpha / 2, df_pooled)
                    margin = t_critical * se_diff
                    ci_low = mean_diff - margin
                    ci_high = mean_diff + margin
                else:
                    ci_low = float("nan")
                    ci_high = float("nan")

                comp = {
                    "group1": group1,
                    "group2": group2,
                    "mean_diff": mean_diff,
                    "se": float(se_diff),
                    "t_stat": float(t_stat),
                    "p_raw": float(p_raw),
                    "p_adjusted": float(p_raw),
                    "ci_lower": float(ci_low),
                    "ci_upper": float(ci_high),
                    "n1": int(n1),
                    "n2": int(n2),
                }

                if posthoc_method == "dunnett" and control_level_str:
                    if group1 == control_level_str:
                        comp["n_control"] = int(n1)
                        comp["n_treatment"] = int(n2)
                    elif group2 == control_level_str:
                        comp["n_control"] = int(n2)
                        comp["n_treatment"] = int(n1)

                comparisons.append(comp)

        if comparisons:
            if posthoc_method == "tukey" and df_pooled and df_pooled > 0 and k > 1:
                from scipy.stats import studentized_range
                for comp in comparisons:
                    q_stat = abs(comp["t_stat"]) * np.sqrt(2)
                    p_adj = float(studentized_range.sf(q_stat, k, df_pooled))
                    q_critical = studentized_range.ppf(1 - alpha, k, df_pooled)
                    margin = q_critical * comp["se"] / np.sqrt(2)
                    comp["p_adjusted"] = p_adj
                    comp["ci_lower"] = float(comp["mean_diff"] - margin)
                    comp["ci_upper"] = float(comp["mean_diff"] + margin)
                    comp["method"] = "Tukey HSD (pooled error)"
            else:
                try:
                    comparisons = apply_adjustment(
                        comparisons,
                        posthoc_method,
                        alpha=alpha,
                        q=posthoc_q_value,
                        control_level=control_level_str if posthoc_method == "dunnett" else None,
                        k=k,
                        df=df_pooled,
                    )
                except Exception:
                    # Leave unadjusted if adjustment fails
                    pass

        method_label = get_method_label(posthoc_method)
        formatted = []
        for comp in comparisons:
            p_adj = comp.get("p_adjusted", comp.get("p_raw", float("nan")))
            formatted.append({
                "comparison": f"{comp['group1']} vs {comp['group2']}",
                "group1": str(comp["group1"]),
                "group2": str(comp["group2"]),
                "estimate": format_number(float(comp["mean_diff"])),
                "mean_diff": format_number(float(comp["mean_diff"])),
                "difference": format_number(float(comp["mean_diff"])),
                "diff": format_number(float(comp["mean_diff"])),
                "se": format_number(float(comp["se"])),
                "t_stat": format_number(float(comp["t_stat"])),
                "df": int(df_pooled) if df_pooled is not None else None,
                "p_value": format_number(float(p_adj)),
                "p_adjusted": format_number(float(p_adj)),
                "ci_lower": format_number(float(comp.get("ci_lower", float("nan")))),
                "ci_upper": format_number(float(comp.get("ci_upper", float("nan")))),
                "significant": bool(float(p_adj) < posthoc_threshold) if np.isfinite(p_adj) else False,
                "method": comp.get("method", method_label),
            })

        return formatted
    except Exception as e:
        return [{"error": str(e)}]


def perform_simple_effects(
    df,
    dv_col,
    factor_names,
    simple_effects_config,
    mse_pooled,
    df_pooled,
    alpha=0.05,
    factor_level_labels=None,
    model=None,
    posthoc_adjustment="tukey",
    control_levels=None,
    factor_levels=None,
    posthoc_q=None,
):
    """
    Perform simple effects analysis using pooled error from overall ANOVA.

    This implementation uses the pooled Mean Square Error
    and degrees of freedom from the overall ANOVA model for all simple effects comparisons.
    This is the statistically correct approach for factorial designs.

    Args:
        df: DataFrame with data
        dv_col: Name of dependent variable column
        factor_names: List of all factor names
        simple_effects_config: List of {"factor": "A", "within": "B"} dicts
        mse_pooled: Pooled Mean Square Error from overall ANOVA residual
        df_pooled: Degrees of freedom from overall ANOVA residual
        alpha: Significance level
        factor_level_labels: Dict mapping factor names to list of original labels

    Returns:
        List of pairwise comparison results matching Two-Way ANOVA format
    """
    from scipy import stats

    results = []
    posthoc_method = str(posthoc_adjustment or "tukey").lower()
    if posthoc_method not in ["tukey", "bonferroni", "holm", "holm-sidak", "sidak", "dunnett", "fdr_bh"]:
        posthoc_method = "tukey"
    control_levels = control_levels or {}
    posthoc_q_value = None
    if posthoc_method == "fdr_bh":
        try:
            posthoc_q_value = float(posthoc_q) if posthoc_q is not None else float(alpha)
        except Exception:
            posthoc_q_value = float(alpha)
        if posthoc_q_value <= 0 or posthoc_q_value > 1:
            posthoc_q_value = float(alpha)
    posthoc_threshold = posthoc_q_value if posthoc_method == "fdr_bh" else float(alpha)

    if factor_levels is None:
        factor_levels = {
            name: list(df[name].cat.categories)
            if isinstance(df[name].dtype, pd.CategoricalDtype)
            else sorted(df[name].unique())
            for name in factor_names
        }

    def _normalize_control_level(control_value, factor_name):
        if control_value is None:
            return None
        control_str = str(control_value)
        level_set = {str(level) for level in factor_levels.get(factor_name, [])}
        if factor_level_labels and factor_name in factor_level_labels:
            labels = [str(item) for item in factor_level_labels[factor_name]]
            if control_str not in level_set and control_str in labels:
                return str(labels.index(control_str))
        return control_str

    for config in simple_effects_config:
        factor = config.get("factor")
        within_factor = config.get("within")

        if not factor or not within_factor:
            continue

        if factor not in factor_names or within_factor not in factor_names:
            continue

        # Get unique levels of the within factor
        within_levels = factor_levels.get(within_factor, df[within_factor].unique())

        # Build factor levels for grid generation
        # Prepare design info if we have a model (for LS means)
        design_info = None
        cov_beta = None
        params = None
        if model is not None:
            try:
                design_info = model.model.data.design_info
                cov_beta = model.cov_params()
                params = model.params
            except Exception:
                design_info = None

        for level in sorted(within_levels):
            # Subset data for this level of the within factor (for counts/labels)
            df_slice = df[df[within_factor] == level]

            if len(df_slice) < 2:
                continue

            # Get unique levels of the target factor (use full factor levels for consistency)
            present_levels = set(df_slice[factor].unique())
            ordered_levels = factor_levels.get(factor, sorted(present_levels))
            factor_levels_list = [level for level in ordered_levels if level in present_levels]

            if len(factor_levels_list) < 2:
                continue

            # Decode within_factor level to original label
            within_level_label = str(level)
            if factor_level_labels and within_factor in factor_level_labels:
                labels = factor_level_labels[within_factor]
                try:
                    level_idx = int(float(level))
                    if 0 <= level_idx < len(labels):
                        within_level_label = labels[level_idx]
                except (ValueError, IndexError):
                    pass

            # Use estimated marginal means (equal-weighted) when model is available
            level_summaries = {}
            other_factors = [name for name in factor_names if name not in {factor, within_factor}]
            cell_counts = df.groupby(factor_names).size()

            for level_factor in factor_levels_list:
                # Build grid for this factor/within combination across remaining factors
                grid_rows = []
                if other_factors:
                    for combo in product(*[factor_levels[name] for name in other_factors]):
                        row = {factor: level_factor, within_factor: level}
                        row.update(dict(zip(other_factors, combo)))
                        grid_rows.append(row)
                else:
                    grid_rows.append({factor: level_factor, within_factor: level})

                grid_df = pd.DataFrame(grid_rows)
                for name in factor_names:
                    grid_df[name] = pd.Categorical(
                        grid_df[name],
                        categories=factor_levels[name],
                        ordered=True,
                    )

                # Compute xbar for LS means and its SE
                if design_info is not None and cov_beta is not None and params is not None:
                    X = build_design_matrices([design_info], grid_df, return_type="dataframe")[0]
                    xbar = np.asarray(X).mean(axis=0)
                    mean_val = float(np.dot(xbar, params))
                    var_val = float(np.dot(xbar, np.dot(cov_beta, xbar.T)))
                    se_val = float(np.sqrt(var_val)) if var_val >= 0 else 0.0
                else:
                    # Fallback to observed means in slice
                    df_level = df_slice[df_slice[factor] == level_factor]
                    mean_val = float(df_level[dv_col].mean()) if len(df_level) > 0 else 0.0
                    n_level = max(len(df_level), 1)
                    se_val = float(np.sqrt(mse_pooled * (1.0 / n_level))) if n_level > 0 else 0.0
                    xbar = None

                # Aggregate counts across remaining factor combinations
                n_total_level = 0
                for row in grid_rows:
                    key = tuple(row[name] for name in factor_names)
                    n_total_level += int(cell_counts.get(key, 0))

                level_summaries[str(level_factor)] = {
                    "mean": mean_val,
                    "se": se_val,
                    "xbar": xbar,
                    "n": int(n_total_level),
                }

            # Pairwise comparisons using LS means
            k = len(factor_levels_list)
            slice_comparisons = []
            for i in range(len(factor_levels_list)):
                for j in range(i + 1, len(factor_levels_list)):
                    group1 = str(factor_levels_list[i])
                    group2 = str(factor_levels_list[j])
                    if group1 not in level_summaries or group2 not in level_summaries:
                        continue

                    mean1 = level_summaries[group1]["mean"]
                    mean2 = level_summaries[group2]["mean"]
                    n1 = level_summaries[group1]["n"]
                    n2 = level_summaries[group2]["n"]
                    mean_diff = float(mean1 - mean2)

                    xbar1 = level_summaries[group1]["xbar"]
                    xbar2 = level_summaries[group2]["xbar"]
                    if xbar1 is not None and xbar2 is not None and cov_beta is not None:
                        contrast = xbar1 - xbar2
                        var_diff = float(np.dot(contrast, np.dot(cov_beta, contrast.T)))
                        se_diff = float(np.sqrt(var_diff)) if var_diff >= 0 else 0.0
                    else:
                        se1 = level_summaries[group1]["se"]
                        se2 = level_summaries[group2]["se"]
                        se_diff = float(np.sqrt(se1 ** 2 + se2 ** 2))

                    t_stat = mean_diff / se_diff if se_diff > 0 else 0
                    p_raw = 2 * (1 - stats.t.cdf(abs(t_stat), df_pooled)) if df_pooled > 0 else 1

                    # Default CI from t distribution
                    if df_pooled > 0:
                        t_critical = stats.t.ppf(1 - alpha / 2, df_pooled)
                        margin = t_critical * se_diff
                        ci_low = mean_diff - margin
                        ci_high = mean_diff + margin
                    else:
                        ci_low = float("nan")
                        ci_high = float("nan")

                    comp = {
                        "group1": group1,
                        "group2": group2,
                        "mean_diff": float(mean_diff),
                        "se": float(se_diff),
                        "t_stat": float(t_stat),
                        "p_raw": float(p_raw),
                        "p_adjusted": float(p_raw),
                        "ci_lower": float(ci_low),
                        "ci_upper": float(ci_high),
                        "n1": int(n1),
                        "n2": int(n2),
                    }

                    if posthoc_method == "dunnett":
                        control_level = _normalize_control_level(control_levels.get(factor), factor)
                        if control_level and str(group1) == control_level:
                            comp["n_control"] = int(n1)
                            comp["n_treatment"] = int(n2)
                        elif control_level and str(group2) == control_level:
                            comp["n_control"] = int(n2)
                            comp["n_treatment"] = int(n1)

                    slice_comparisons.append(comp)

            # Apply adjustment within this slice
            if slice_comparisons:
                if posthoc_method == "tukey" and df_pooled > 0 and k > 1:
                    from scipy.stats import studentized_range
                    for comp in slice_comparisons:
                        q_stat = abs(comp["t_stat"]) * np.sqrt(2)
                        p_adj = float(studentized_range.sf(q_stat, k, df_pooled))
                        q_critical = studentized_range.ppf(1 - alpha, k, df_pooled)
                        margin = q_critical * comp["se"] / np.sqrt(2)
                        comp["p_adjusted"] = p_adj
                        comp["ci_lower"] = float(comp["mean_diff"] - margin)
                        comp["ci_upper"] = float(comp["mean_diff"] + margin)
                        comp["method"] = "Tukey HSD (pooled error)"
                else:
                    try:
                        control_level = _normalize_control_level(control_levels.get(factor), factor) if posthoc_method == "dunnett" else None
                        slice_comparisons = apply_adjustment(
                            slice_comparisons,
                            posthoc_method,
                            alpha=alpha,
                            q=posthoc_q_value,
                            control_level=control_level,
                            k=k,
                            df=df_pooled,
                        )
                    except Exception:
                        pass

            # Decode factor level codes to labels
            for comp in slice_comparisons:
                group1_label = str(comp["group1"])
                group2_label = str(comp["group2"])
                if factor_level_labels and factor in factor_level_labels:
                    factor_labels = factor_level_labels[factor]
                    try:
                        idx1 = int(float(comp["group1"]))
                        idx2 = int(float(comp["group2"]))
                        if 0 <= idx1 < len(factor_labels):
                            group1_label = factor_labels[idx1]
                        if 0 <= idx2 < len(factor_labels):
                            group2_label = factor_labels[idx2]
                    except (ValueError, IndexError):
                        pass

                p_adj = comp.get("p_adjusted", comp.get("p_raw", float("nan")))
                if np.isfinite(p_adj) and p_adj < posthoc_threshold:
                    if p_adj < 0.001:
                        sig_stars = "***"
                    elif p_adj < 0.01:
                        sig_stars = "**"
                    elif p_adj < 0.05:
                        sig_stars = "*"
                    else:
                        sig_stars = "*"
                else:
                    sig_stars = ""

                comparison_result = {
                    "label": f"{group1_label} vs {group2_label} | {factor}|{within_factor}={within_level_label}",
                    "group1": group1_label,
                    "group2": group2_label,
                    "comparison": f"{group1_label} vs {group2_label}",
                    "factor": factor,
                    "factor_scope": f"{factor}|{within_factor}={within_level_label}",
                    "comparison_type": "simple_effect",
                    "estimate": format_number(float(comp["mean_diff"])),
                    "mean_diff": format_number(float(comp["mean_diff"])),
                    "difference": format_number(float(comp["mean_diff"])),
                    "p_value": format_number(float(p_adj)),
                    "p_adj": format_number(float(p_adj)),
                    "p_adjusted": format_number(float(p_adj)),
                    "ci_lower": format_number(float(comp.get("ci_lower", float('nan')))),
                    "ci_upper": format_number(float(comp.get("ci_upper", float('nan')))),
                    "ci_low": format_number(float(comp.get("ci_lower", float('nan')))),
                    "ci_high": format_number(float(comp.get("ci_upper", float('nan')))),
                    "significant": bool(p_adj < posthoc_threshold) if np.isfinite(p_adj) else False,
                    "sig_stars": sig_stars,
                    "method": comp.get("method", get_method_label(posthoc_method)),
                    "n1": int(comp["n1"]),
                    "n2": int(comp["n2"]),
                    "se": format_number(float(comp["se"])),
                    "t_stat": format_number(float(comp["t_stat"])),
                    "df": int(df_pooled),
                }

                results.append(comparison_result)

    return results


def calculate_cell_means(df, dv_col, factor_names, alpha=0.05, factor_level_labels=None):
    """
    Calculate cell means with confidence intervals.

    Args:
        df: DataFrame with data
        dv_col: Name of dependent variable column
        factor_names: List of factor column names
        alpha: Significance level for CI
        factor_level_labels: Dict mapping factor names to list of original labels
            e.g., {"Temperature": ["High", "Low"], "Pressure": ["High", "Low"]}
            Index 0 maps to encoded value 0, index 1 maps to encoded value 1, etc.

    Returns:
        List of cell mean dictionaries
    """
    from scipy.stats import t as t_dist

    cell_means = []

    # Group by all factors
    grouped = df.groupby(factor_names, sort=False)[dv_col]

    # Calculate pooled standard error for CI
    n_total = len(df)
    grand_mean = df[dv_col].mean()

    for name, group in grouped:
        if isinstance(name, tuple):
            factor_values = dict(zip(factor_names, name))
        else:
            factor_values = {factor_names[0]: name}

        # Decode factor values using factor_level_labels if provided
        factor_values = decode_factor_values(factor_values, factor_level_labels)

        n = len(group)
        mean = group.mean()
        std = group.std(ddof=1) if n > 1 else 0

        # Calculate CI using t-distribution
        if n > 1:
            se = std / np.sqrt(n)
            t_crit = t_dist.ppf(1 - alpha / 2, n - 1)
            ci_lower = mean - t_crit * se
            ci_upper = mean + t_crit * se
        else:
            ci_lower = ci_upper = mean

        cell_means.append({
            "factors": {k: str(v) for k, v in factor_values.items()},
            "mean": format_number(float(mean)),
            "std": format_number(float(std)),
            "n": int(n),
            "ci_lower": format_number(float(ci_lower)),
            "ci_upper": format_number(float(ci_upper))
        })

    return cell_means


def multifactorial_anova(
    dependent_var: list,
    factors: dict,
    factor_names: list,
    alpha: float = 0.05,
    max_interaction_depth: int = None,
    simple_effects_config: list = None,
    factor_baselines: dict = None,
    factor_level_labels: dict = None,
    posthoc_adjustment: str = "tukey",
    control_levels: dict = None,
    posthoc_q: float = None
) -> dict:
    """
    Perform Multi-Factorial ANOVA with configurable interaction depth.

    Args:
        dependent_var: List of dependent variable values
        factors: Dictionary mapping factor names to lists of values
            {"Drug": ["A", "A", "B", ...], "Dose": ["Low", "High", ...]}
        factor_names: Ordered list of factor names
        alpha: Significance level (default 0.05)
        max_interaction_depth: Maximum interaction order
            - None: Full model (all interactions)
            - 0 or 1: Main effects only
            - 2: Up to 2-way interactions
            - 3: Up to 3-way interactions
        simple_effects_config: List of simple effects to analyze
            [{"factor": "Drug", "within": "Dose"}, ...]
        factor_baselines: Dictionary of baseline categories per factor
            {"Drug": "Placebo", "Dose": "Low"}
        posthoc_adjustment: Post-hoc adjustment method (default: 'tukey')
        control_levels: Optional dict mapping factor names to control levels (for Dunnett)

    Returns:
        Dictionary with complete ANOVA results
    """
    try:
        # Build DataFrame
        data = {"DV": dependent_var}
        for name in factor_names:
            if name in factors:
                data[name] = factors[name]
            else:
                raise ValueError(f"Factor '{name}' not found in factors dict")

        df = pd.DataFrame(data)

        # Convert factors to ordered categoricals with stable level ordering
        factor_levels_map = {}
        for name in factor_names:
            df[name] = df[name].astype(str)
            labels = factor_level_labels.get(name) if factor_level_labels else None
            baseline = factor_baselines.get(name) if factor_baselines else None
            level_order = _infer_factor_level_order(df[name], labels, baseline)
            df[name] = pd.Categorical(df[name], categories=level_order, ordered=True)
            factor_levels_map[name] = level_order

        n_total = len(df)
        n_factors = len(factor_names)

        # Determine actual max depth
        if max_interaction_depth is None or max_interaction_depth > n_factors:
            actual_max_depth = n_factors
        elif max_interaction_depth < 1:
            actual_max_depth = 1
        else:
            actual_max_depth = max_interaction_depth

        # Build formula
        formula = build_formula_with_depth(factor_names, actual_max_depth)

        # Fit OLS model
        model = ols(formula, data=df).fit()

        # Get Type III ANOVA table (primary)
        anova_table = anova_lm(model, typ=3)

        # Get terms by depth
        terms_by_depth = get_interaction_terms_by_depth(factor_names, actual_max_depth)
        term_counts = count_terms_by_depth(n_factors, actual_max_depth)

        # Calculate corrected total SS (exclude intercept)
        dv_vals = df['DV'].astype(float).to_numpy()
        ss_total = float(np.sum((dv_vals - dv_vals.mean()) ** 2))
        ss_residual = anova_table.loc['Residual', 'sum_sq']
        df_residual = int(anova_table.loc['Residual', 'df'])
        ms_residual = ss_residual / df_residual if df_residual > 0 else 0
        residuals = np.asarray(model.resid, dtype=float)
        residual_normality_tests = _build_residual_normality_tests(residuals, alpha)
        shapiro_entry = next(
            (entry for entry in residual_normality_tests if entry.get('test_name') == 'shapiro_wilk'),
            None
        )
        if shapiro_entry is not None:
            w_stat = shapiro_entry.get('statistic')
            norm_p = shapiro_entry.get('p_value')
            is_normal_val = shapiro_entry.get('is_normal')
            residuals_normal = (
                bool(is_normal_val)
                if is_normal_val is not None
                else bool(norm_p >= alpha) if isinstance(norm_p, (int, float, np.number)) else None
            )
        else:
            w_stat, norm_p = None, None
            residuals_normal = None
        residual_normality_warning = (
            'Normality tests may be unstable with fewer than 8 residuals.'
            if len(residuals) < 8
            else None
        )

        # Parse main effects
        main_effects = []
        for term in terms_by_depth.get(1, []):
            if term in anova_table.index:
                row = anova_table.loc[term]
                ss = float(row['sum_sq'])
                df_effect = int(row['df'])
                ms = ss / df_effect if df_effect > 0 else 0
                f_val = float(row['F']) if not np.isnan(row['F']) else 0
                p_val = float(row['PR(>F)']) if not np.isnan(row['PR(>F)']) else 1

                eta_sq, omega_sq = calculate_effect_sizes(
                    ss, ss_total, ss_residual, df_effect, df_residual
                )

                # Extract factor name from C(factor1, Sum) → factor1
                # term format: "C(factor1, Sum)"
                factor_name = term.split('(')[1].split(',')[0] if '(' in term else term

                main_effects.append({
                    "source": factor_name,  # Store clean factor name for flattening
                    "term": term,  # Store full term for reference
                    "SS": format_number(ss),
                    "df": df_effect,
                    "MS": format_number(ms),
                    "F": format_number(f_val),
                    "p_value": format_number(p_val),
                    "eta_squared": format_number(eta_sq),
                    "omega_squared": format_number(omega_sq),
                    "significant": bool(p_val < alpha)
                })

        # Parse interactions by depth
        interactions = []
        for depth in range(2, actual_max_depth + 1):
            for term in terms_by_depth.get(depth, []):
                if term in anova_table.index:
                    row = anova_table.loc[term]
                    ss = float(row['sum_sq'])
                    df_effect = int(row['df'])
                    ms = ss / df_effect if df_effect > 0 else 0
                    f_val = float(row['F']) if not np.isnan(row['F']) else 0
                    p_val = float(row['PR(>F)']) if not np.isnan(row['PR(>F)']) else 1

                    eta_sq, omega_sq = calculate_effect_sizes(
                        ss, ss_total, ss_residual, df_effect, df_residual
                    )

                    # Extract clean factor names from C(factor1, Sum):C(factor2, Sum) → factor1:factor2
                    # Split by ':', extract factor name from each C(...) term
                    clean_factors = []
                    for part in term.split(':'):
                        # Extract from "C(factor1, Sum)" → "factor1"
                        factor_name = part.split('(')[1].split(',')[0] if '(' in part else part
                        clean_factors.append(factor_name)
                    clean_term = ":".join(clean_factors)

                    # Format source name with × symbol for display
                    display_name = clean_term.replace(":", "×")

                    interactions.append({
                        "source": display_name,
                        "term": clean_term,  # Store clean term (factor1:factor2) for flattening
                        "depth": depth,
                        "SS": format_number(ss),
                        "df": df_effect,
                        "MS": format_number(ms),
                        "F": format_number(f_val),
                        "p_value": format_number(p_val),
                        "eta_squared": format_number(eta_sq),
                        "omega_squared": format_number(omega_sq),
                        "significant": bool(p_val < alpha)
                    })

        # Levene's test for homogeneity
        try:
            # Create group labels by combining all factors
            df['_group'] = df[factor_names].astype(str).agg('_'.join, axis=1)
            groups = [group['DV'].values for name, group in df.groupby('_group')]
            # Brown-Forsythe test (Levene with median, more robust)
            levene_stat, levene_p = stats.levene(*groups, center='median')
            levene_result = {
                # Force 4-decimal rounding for UI consistency
                "statistic": round(float(levene_stat), 4),
                "p_value": format_number(float(levene_p)),
                "homogeneous": bool(levene_p >= alpha)
            }
        except Exception as e:
            levene_result = {"error": str(e)}

        # Post-hoc tests for significant main effects
        post_hoc_main_effects = {}
        for effect in main_effects:
            if effect["significant"]:
                factor_name = effect["source"]
                n_levels = df[factor_name].nunique()
                if n_levels > 2:
                    comparisons = perform_tukey_posthoc(
                        df,
                        'DV',
                        factor_name,
                        alpha,
                        posthoc_adjustment=posthoc_adjustment,
                        posthoc_q=posthoc_q,
                        control_level=(control_levels or {}).get(factor_name),
                        mse_pooled=ms_residual,
                        df_pooled=df_residual,
                        model=model,
                        factor_names=factor_names,
                        factor_levels=factor_levels_map,
                        factor_level_labels=factor_level_labels,
                    )
                    post_hoc_main_effects[factor_name] = comparisons

        # Simple effects analysis
        simple_effects_results = []
        simple_effects_warning = None
        if simple_effects_config:
            significant_interaction_terms = []
            for interaction in interactions:
                if not interaction.get("significant"):
                    continue
                clean_term = interaction.get("term")
                if isinstance(clean_term, str) and clean_term.strip():
                    significant_interaction_terms.append(set(clean_term.split(":")))

            unsupported_simple_effects = []
            for config in simple_effects_config:
                if not isinstance(config, dict):
                    continue

                factor = config.get("factor")
                within_factor = config.get("within")
                if not factor or not within_factor:
                    continue

                requested_pair = {str(factor), str(within_factor)}
                has_significant_support = any(
                    requested_pair.issubset(term_parts) for term_parts in significant_interaction_terms
                )

                if not has_significant_support:
                    unsupported_simple_effects.append(f"{factor} within {within_factor}")

            if unsupported_simple_effects:
                unsupported_label = ", ".join(unsupported_simple_effects)
                if len(significant_interaction_terms) == 0:
                    simple_effects_warning = (
                        f"No significant interaction terms were detected (alpha = {alpha}). "
                        "Interpret simple effects with caution. "
                        f"Requested contrasts without significant interaction support: {unsupported_label}. "
                        "Consider main effects instead."
                    )
                else:
                    simple_effects_warning = (
                        "No significant interaction term was detected for requested simple effects: "
                        f"{unsupported_label}. "
                        "Interpret simple effects with caution and prioritize supported interactions."
                    )

            simple_effects_results = perform_simple_effects(
                df,
                'DV',
                factor_names,
                simple_effects_config,
                ms_residual,
                df_residual,
                alpha,
                factor_level_labels,
                model,
                posthoc_adjustment=posthoc_adjustment,
                control_levels=control_levels,
                factor_levels=factor_levels_map,
                posthoc_q=posthoc_q,
            )

        # Cell means (observed)
        cell_means = calculate_cell_means(
            df,
            'DV',
            factor_names,
            alpha,
            factor_level_labels,
        )

        # Cell counts / balance check
        cell_counts_series = df.groupby(factor_names, sort=False).size()
        min_cell_size = int(cell_counts_series.min()) if len(cell_counts_series) > 0 else 0
        max_cell_size = int(cell_counts_series.max()) if len(cell_counts_series) > 0 else 0
        mean_cell_size = float(cell_counts_series.mean()) if len(cell_counts_series) > 0 else 0.0
        is_balanced = bool(min_cell_size == max_cell_size) if len(cell_counts_series) > 0 else False

        cell_counts_detail = []
        for key, count in cell_counts_series.items():
            if isinstance(key, tuple):
                factor_values = dict(zip(factor_names, key))
            else:
                factor_values = {factor_names[0]: key}
            factor_values = decode_factor_values(factor_values, factor_level_labels)
            cell_counts_detail.append({
                "factors": {k: str(v) for k, v in factor_values.items()},
                "n": int(count),
            })

        # Predicted means (LS means) from the fitted model
        cell_emmeans = []
        try:
            factor_levels = factor_levels_map
            # Build cartesian product of all factor levels
            grid_rows = []
            for combo in product(*[factor_levels[name] for name in factor_names]):
                grid_rows.append(dict(zip(factor_names, combo)))
            grid_df = pd.DataFrame(grid_rows)
            for name in factor_names:
                grid_df[name] = pd.Categorical(
                    grid_df[name],
                    categories=factor_levels[name],
                    ordered=True
                )
            pred = model.get_prediction(grid_df)
            pred_summary = pred.summary_frame(alpha=alpha)
            for combo, row in zip(product(*[factor_levels[name] for name in factor_names]), pred_summary.itertuples()):
                factor_values = dict(zip(factor_names, combo))
                factor_values = decode_factor_values(factor_values, factor_level_labels)
                mean_val = float(getattr(row, 'mean'))
                mean_se = float(getattr(row, 'mean_se'))
                ci_lower = float(getattr(row, 'mean_ci_lower'))
                ci_upper = float(getattr(row, 'mean_ci_upper'))
                count = int(cell_counts_series.get(combo, 0)) if combo in cell_counts_series.index else 0
                cell_emmeans.append({
                    "factors": {k: str(v) for k, v in factor_values.items()},
                    "emmean": format_number(mean_val),
                    "se": format_number(mean_se),
                    "n": count,
                    "ci_lower": format_number(ci_lower) if not np.isnan(ci_lower) else None,
                    "ci_upper": format_number(ci_upper) if not np.isnan(ci_upper) else None,
                })
        except Exception:
            cell_emmeans = []

        # Calculate total cells
        total_cells = 1
        for name in factor_names:
            total_cells *= df[name].nunique()

        # Model fit statistics
        r_squared = model.rsquared
        r_squared_adj = model.rsquared_adj

        posthoc_q_value = None
        if str(posthoc_adjustment or "").lower() == "fdr_bh":
            try:
                posthoc_q_value = float(posthoc_q) if posthoc_q is not None else float(alpha)
            except Exception:
                posthoc_q_value = float(alpha)
            if posthoc_q_value <= 0 or posthoc_q_value > 1:
                posthoc_q_value = float(alpha)

        # Build result
        result = {
            "test_name": "Multi-Factorial ANOVA",
            "factor_count": n_factors,
            "factor_names": factor_names,
            "n_total": n_total,
            "total_n": n_total,  # alias for compatibility
            "total_cells": total_cells,
            "alpha": alpha,
            "adjustment_method": get_method_label(posthoc_adjustment),

            "interaction_config": {
                "max_depth_requested": max_interaction_depth,
                "max_depth_actual": actual_max_depth,
                "depth_label": get_depth_label(actual_max_depth, n_factors)
            },

            "model_terms": {
                "main_effects": term_counts.get(1, 0),
                "two_way": term_counts.get(2, 0),
                "three_way": term_counts.get(3, 0),
                "four_way_plus": sum(term_counts.get(d, 0) for d in range(4, n_factors + 1)),
                "total": term_counts.get("total", 0),
                "formula": formula
            },

            "model_fit": {
                "r_squared": format_number(r_squared),
                "r_squared_adj": format_number(r_squared_adj)
            },

            "main_effects": main_effects,
            "interactions": interactions,

            # Top-level residual fields (flat output)
            "residual_df": df_residual,
            "residual_ss": format_number(ss_residual),

            "residual": {
                "SS": format_number(ss_residual),
                "df": df_residual,
                "MS": format_number(ms_residual)
            },

            "total": {
                "SS": format_number(ss_total),
                "df": n_total - 1
            },

            "levene_test": levene_result,
            "assumptions": {
                "homogeneity_of_variance": {
                    "levene_statistic": levene_result.get("statistic"),
                    "levene_p_value": levene_result.get("p_value"),
                    "equal_variances": levene_result.get("homogeneous"),
                    "test": "Levene (median)"
                },
                "normality": {
                    "scope": "residuals",
                    "n": int(len(residuals)),
                    "shapiro_statistic": format_number(w_stat),
                    "shapiro_p_value": format_number(norm_p),
                    "residuals_normal": residuals_normal,
                    "test": "Shapiro-Wilk (residuals)",
                    "tests": residual_normality_tests,
                    "warning": residual_normality_warning
                }
            },
            "cell_means": cell_means,
            "cell_emmeans": cell_emmeans,
            "cell_counts": {
                "min": min_cell_size,
                "max": max_cell_size,
                "mean": format_number(mean_cell_size),
                "is_balanced": is_balanced
            },
            "cell_counts_detail": cell_counts_detail,
            "means_type": "cell_mean" if is_balanced else "lsmean",
            "post_hoc_main_effects": post_hoc_main_effects,
            "simple_effects": simple_effects_results
        }

        if posthoc_q_value is not None:
            result["posthoc_q"] = format_number(posthoc_q_value)

        # Shared factorial post-hoc contract used by the table builder and E2E
        pairwise_comparisons = []
        marginal_effect_records = []
        simple_effect_records = []

        for factor_name, comparisons in post_hoc_main_effects.items():
            if not isinstance(comparisons, list):
                continue
            for comp in comparisons:
                if not isinstance(comp, dict) or comp.get("error"):
                    continue
                pairwise_entry = {
                    "group1": str(comp.get("group1", "")),
                    "group2": str(comp.get("group2", "")),
                    "contrast": comp.get("comparison") or f"{comp.get('group1', '')} vs {comp.get('group2', '')}",
                    "difference": comp.get("difference", comp.get("mean_diff", comp.get("diff"))),
                    "estimate": comp.get("estimate", comp.get("mean_diff", comp.get("diff"))),
                    "p_value": comp.get("p_value"),
                    "p_adjusted": comp.get("p_adjusted", comp.get("p_value")),
                    "p_value_display": f"{comp.get('p_value')} (pvalue) / {comp.get('p_adjusted', comp.get('p_value'))} (padj)",
                    "ci_lower": comp.get("ci_lower"),
                    "ci_upper": comp.get("ci_upper"),
                    "significant": bool(comp.get("significant", False)),
                    "se": comp.get("se"),
                    "t_stat": comp.get("t_stat"),
                    "df": comp.get("df"),
                    "method": comp.get("method", get_method_label(posthoc_adjustment)),
                    "factor": factor_name,
                }
                pairwise_comparisons.append(pairwise_entry)
                marginal_effect_records.append({
                    "factor": factor_name,
                    "label": f"{pairwise_entry['group1']} - {pairwise_entry['group2']}",
                    "estimate": pairwise_entry["estimate"],
                    "se": pairwise_entry["se"],
                    "ci_lower": pairwise_entry["ci_lower"],
                    "ci_upper": pairwise_entry["ci_upper"],
                    "df": pairwise_entry["df"],
                    "t_ratio": pairwise_entry["t_stat"],
                    "p": pairwise_entry["p_adjusted"],
                })

        if isinstance(simple_effects_results, list):
            for entry in simple_effects_results:
                if not isinstance(entry, dict) or entry.get("error"):
                    continue
                pairwise_entry = {
                    "group1": entry.get("group1"),
                    "group2": entry.get("group2"),
                    "contrast": entry.get("comparison") or f"{entry.get('group1', '')} vs {entry.get('group2', '')}",
                    "difference": entry.get("difference", entry.get("mean_diff", entry.get("estimate"))),
                    "estimate": entry.get("estimate", entry.get("mean_diff")),
                    "p_value": entry.get("p_value"),
                    "p_adjusted": entry.get("p_adjusted", entry.get("p_adj", entry.get("p_value"))),
                    "p_value_display": f"{entry.get('p_value')} (pvalue) / {entry.get('p_adjusted', entry.get('p_adj', entry.get('p_value')))} (padj)",
                    "ci_lower": entry.get("ci_lower", entry.get("ci_low")),
                    "ci_upper": entry.get("ci_upper", entry.get("ci_high")),
                    "significant": bool(entry.get("significant", False)),
                    "n1": entry.get("n1"),
                    "n2": entry.get("n2"),
                    "se": entry.get("se"),
                    "t_stat": entry.get("t_stat"),
                    "df": entry.get("df"),
                    "method": entry.get("method", get_method_label(posthoc_adjustment)),
                    "factor": entry.get("factor"),
                    "factor_scope": entry.get("factor_scope"),
                }
                pairwise_comparisons.append(pairwise_entry)
                simple_effect_records.append({
                    "label": entry.get("label"),
                    "estimate": pairwise_entry["estimate"],
                    "se": pairwise_entry["se"],
                    "ci_lower": pairwise_entry["ci_lower"],
                    "ci_upper": pairwise_entry["ci_upper"],
                    "df": pairwise_entry["df"],
                    "t_ratio": pairwise_entry["t_stat"],
                    "p": pairwise_entry["p_adjusted"],
                })

        if pairwise_comparisons:
            result["pairwise_comparisons"] = pairwise_comparisons

        # FLATTEN main effects and interactions for flat output compatibility
        # Expected flat fields: factor1_df1, factor1_df2, factor1_F, factor1_p, factor1_pes, factor1_significant
        # Interaction naming: factor1_x_factor2, factor1_x_factor3, factor2_x_factor3, etc.

        # Flatten main effects
        for effect in main_effects:
            source = effect["source"]  # Clean factor name (e.g., "factor1")
            anova_term = effect["term"]  # Full term in ANOVA table (e.g., "C(factor1, Sum)")

            # Get SS from ANOVA table using the full term notation (Type III)
            ss_effect = float(anova_table.loc[anova_term, 'sum_sq']) if anova_term in anova_table.index else 0

            # Partial eta squared (Type III)
            partial_eta_sq = ss_effect / (ss_effect + ss_residual) if (ss_effect + ss_residual) > 0 else 0

            # Flat fields (for validation + cross-language parity)
            result[f"{source}_df"] = effect["df"]
            result[f"{source}_ss"] = format_number(ss_effect)
            result[f"{source}_f"] = effect["F"]
            result[f"{source}_eta"] = format_number(partial_eta_sq)

            result[f"{source}_df1"] = effect["df"]  # Numerator df
            result[f"{source}_df2"] = df_residual  # Denominator df (always residual)
            result[f"{source}_F"] = effect["F"]
            result[f"{source}_p"] = effect["p_value"]
            result[f"{source}_pes"] = format_number(partial_eta_sq)  # partial eta squared
            result[f"{source}_significant"] = effect["significant"]

        # Flatten interactions (convert : to _x_ for naming convention)
        for interaction in interactions:
            # interaction["term"] is clean: "factor1:factor2"
            # We need to construct the ANOVA table term: "C(factor1, Sum):C(factor2, Sum)"
            clean_term = interaction["term"]

            # Reconstruct ANOVA table term with C(..., Sum) notation
            factors = clean_term.split(':')
            anova_term = ":".join([f"C({f}, Sum)" for f in factors])

            # Get SS from ANOVA table using the full term notation (Type III)
            ss_interaction = float(anova_table.loc[anova_term, 'sum_sq']) if anova_term in anova_table.index else 0

            # Partial eta squared (Type III)
            partial_eta_sq = ss_interaction / (ss_interaction + ss_residual) if (ss_interaction + ss_residual) > 0 else 0

            # Convert "factor1:factor2" to "factor1_x_factor2"
            r_style_name = clean_term.replace(":", "_x_")
            result[f"{r_style_name}_df1"] = interaction["df"]
            result[f"{r_style_name}_df2"] = df_residual
            result[f"{r_style_name}_F"] = interaction["F"]
            result[f"{r_style_name}_p"] = interaction["p_value"]
            result[f"{r_style_name}_pes"] = format_number(partial_eta_sq)  # partial eta squared
            result[f"{r_style_name}_significant"] = interaction["significant"]

        # Baseline compatibility: factor1:factor2 -> interaction, 3-way -> factor4
            parts = clean_term.split(":")
            if len(parts) == 2:
                if len(factor_names) >= 2 and parts[0] == factor_names[0] and parts[1] == factor_names[1]:
                    r_base = "interaction"
                else:
                    r_base = "_".join(parts)
            elif len(parts) == 3 and len(factor_names) >= 3 and parts[:3] == factor_names[:3]:
                r_base = "factor4"
            else:
                r_base = "_".join(parts)

            result[f"{r_base}_df"] = interaction["df"]
            result[f"{r_base}_ss"] = format_number(ss_interaction)
            result[f"{r_base}_f"] = interaction["F"]
            result[f"{r_base}_p"] = interaction["p_value"]
            result[f"{r_base}_eta"] = format_number(partial_eta_sq)

        # Add note if interactions were excluded
        if actual_max_depth < n_factors:
            excluded = []
            for d in range(actual_max_depth + 1, n_factors + 1):
                excluded.append(f"{d}-way")
            result["note"] = f"{', '.join(excluded)} interactions not included (max_interaction_depth={actual_max_depth})"

        # Flatten simple effects for baseline compatibility (se1_label, se1_estimate, se1_se, se1_df, se1_t, se1_p)
        if marginal_effect_records:
            result["marginal_effects_count"] = len(marginal_effect_records)
            for idx, record in enumerate(marginal_effect_records, start=1):
                prefix = f"me{idx}"
                result[f"{prefix}_factor"] = record.get("factor")
                result[f"{prefix}_label"] = record.get("label")
                result[f"{prefix}_estimate"] = record.get("estimate")
                result[f"{prefix}_se"] = record.get("se")
                result[f"{prefix}_ci_lower"] = record.get("ci_lower")
                result[f"{prefix}_ci_upper"] = record.get("ci_upper")
                result[f"{prefix}_df"] = record.get("df")
                result[f"{prefix}_t_ratio"] = record.get("t_ratio")
                result[f"{prefix}_t"] = record.get("t_ratio")
                result[f"{prefix}_p"] = record.get("p")

        if simple_effect_records:
            result["simple_effects_count"] = len(simple_effect_records)
            for idx, entry in enumerate(simple_effect_records, start=1):
                prefix = f"se{idx}"
                label = entry.get("label")
                if label:
                    label = label.replace(" vs ", " - ").replace(" | ", "| ")
                    result[f"{prefix}_label"] = label
                result[f"{prefix}_estimate"] = entry.get("estimate")
                result[f"{prefix}_se"] = entry.get("se")
                result[f"{prefix}_ci_lower"] = entry.get("ci_lower")
                result[f"{prefix}_ci_upper"] = entry.get("ci_upper")
                result[f"{prefix}_df"] = entry.get("df")
                result[f"{prefix}_t"] = entry.get("t_ratio")
                result[f"{prefix}_t_ratio"] = entry.get("t_ratio")
                result[f"{prefix}_p"] = entry.get("p")

        if simple_effects_warning:
            result["simple_effects_warning"] = simple_effects_warning

        # Residual mean square
        result["residual_ms"] = format_number(ms_residual)

        return result

    except Exception as e:
        import traceback
        return {
            "test_name": "Multi-Factorial ANOVA",
            "error": str(e),
            "traceback": traceback.format_exc()
        }


def get_depth_label(depth: int, n_factors: int) -> str:
    """Get human-readable label for interaction depth."""
    if depth >= n_factors:
        return f"Full model (all interactions up to {n_factors}-way)"
    elif depth == 1:
        return "Main effects only"
    elif depth == 2:
        return "Up to 2-way interactions"
    elif depth == 3:
        return "Up to 3-way interactions"
    else:
        return f"Up to {depth}-way interactions"


# Command-line interface for testing
if __name__ == "__main__":
    if len(sys.argv) > 1:
        command = sys.argv[1]
        if command == "test":
            # Test with sample data
            np.random.seed(42)
            n = 60

            # Create test data with 3 factors
            drug = np.repeat(["A", "B", "C"], 20)
            dose = np.tile(np.repeat(["Low", "High"], 10), 3)
            gender = np.tile(["M", "F"], 30)

            # Generate response with main effects and interaction
            response = (
                5 +
                np.where(drug == "A", 0, np.where(drug == "B", 2, 4)) +
                np.where(dose == "Low", 0, 3) +
                np.where(gender == "M", 0, 1) +
                np.random.normal(0, 1, n)
            )

            result = multifactorial_anova(
                dependent_var=response.tolist(),
                factors={
                    "Drug": drug.tolist(),
                    "Dose": dose.tolist(),
                    "Gender": gender.tolist()
                },
                factor_names=["Drug", "Dose", "Gender"],
                alpha=0.05,
                max_interaction_depth=2,
                simple_effects_config=[
                    {"factor": "Drug", "within": "Dose"}
                ]
            )

            print(json.dumps(result, indent=2))
        else:
            # Parse JSON input
            data = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
            result = multifactorial_anova(**data)
            print(json.dumps(result))
    else:
        print("Usage: python multifactorial_anova.py test")
        print("       python multifactorial_anova.py run '{json_data}'")
