"""
Analysis of Variance (ANOVA) functions including two-way and factorial designs.

This module contains the anova_two_way function extracted from the v1.23 monolithic
statistical_analysis_enhanced.py to ensure compatibility with C# calling conventions.

VERSION: 2.0.7
DATE: 2025-12-11
CHANGES: Fixed Type III SS to use sum contrasts (Type III SS support):
         - Added Sum contrasts before model fitting
         - Now correctly computes Type III SS for unbalanced/balanced designs
         - Fixes SS mismatch between Python and baseline comparisons

PREVIOUS VERSION: 2.0.6 (2025-12-11)
         - Added SE, t_stat, df, n1, n2, and method fields to main effects pairwise comparisons
"""
import numpy as np
from scipy import stats
from scipy.stats import shapiro
import pandas as pd
import logging
from itertools import product
from typing import Dict, Any, List, Optional, Tuple
from .utils import format_number, interpret_partial_eta, significance_marker, significance_text
from .adjustment_utils import apply_adjustment, get_method_label

# Set up module logger
logger = logging.getLogger(__name__)

def anova_two_way(
    data,
    factor1,
    factor2,
    alpha=0.05,
    factor_names=None,
    simple_effects=None,
    factor_level_labels=None,
    posthoc_adjustment='tukey',
    control_levels=None,
    posthoc_q=None
):
    """
    Perform two-way ANOVA with interaction effects using statsmodels

    Args:
        data: Dependent variable values (list/array)
        factor1: First factor levels (list/array, same length as data)
        factor2: Second factor levels (list/array, same length as data)
        alpha: Significance level (default 0.05)
        factor_names: Optional list of factor names [factor1_name, factor2_name] (default ['factor1', 'factor2'])
        simple_effects: Optional dict with 'factor_a_within_factor_b' and/or 'factor_b_within_factor_a' boolean flags
        factor_level_labels: Optional dict mapping factor names to list of original string labels (for decoding numeric codes)
        posthoc_adjustment: Post-hoc adjustment method (default: 'tukey')
        control_levels: Optional dict mapping factor names to control levels (for Dunnett)

    Returns:
        Dictionary containing two-way ANOVA results and optional simple effects analysis
    """
    try:
        # Import statsmodels here to avoid dependency if not needed
        try:
            import statsmodels.api as sm
            from statsmodels.formula.api import ols
        except ImportError:
            return {'success': False, 'error': 'statsmodels package required for two-way ANOVA. Install with: pip install statsmodels'}

        # Extract factor names (passed from C#)
        if factor_names is None:
            factor_names = ['factor1', 'factor2']
        elif len(factor_names) < 2:
            factor_names = factor_names + ['factor1', 'factor2'][len(factor_names):]

        factor1_name = factor_names[0]
        factor2_name = factor_names[1]

        # Convert to numpy arrays and validate
        data_arr = np.array(data, dtype=float)

        # Try to convert factors to numeric first, but keep them as-is if they fail
        try:
            factor1_arr = np.array(factor1, dtype=float)
            # Check for inf/NaN in factor1
            if not np.all(np.isfinite(factor1_arr)):
                return {
                    'success': False,
                    'error': f'Factor 1 contains inf or NaN values. Two-way ANOVA requires valid numeric or categorical factor levels. Please check your first column for invalid values.'
                }
        except (ValueError, TypeError):
            # Factor is categorical (strings), keep as-is
            factor1_arr = np.array(factor1)

        try:
            factor2_arr = np.array(factor2, dtype=float)
            # Check for inf/NaN in factor2
            if not np.all(np.isfinite(factor2_arr)):
                return {
                    'success': False,
                    'error': f'Factor 2 contains inf or NaN values. Two-way ANOVA requires valid numeric or categorical factor levels. Please check your second column for invalid values.'
                }
        except (ValueError, TypeError):
            # Factor is categorical (strings), keep as-is
            factor2_arr = np.array(factor2)

        # Check lengths match
        if not (len(data_arr) == len(factor1_arr) == len(factor2_arr)):
            return {
                'success': False,
                'error': f'All inputs must have same length. Got: data={len(data_arr)}, factor1={len(factor1_arr)}, factor2={len(factor2_arr)}'
            }

        # DECODE FACTOR ARRAYS TO CATEGORICAL LABELS BEFORE CREATING DATAFRAME
        # This ensures Tukey HSD operates on "Aspirin" instead of 0.0
        # C# sends: {"Drug_Type": ["Aspirin", "Ibuprofen", "Placebo"], "Dosage_Level": ["High", "Low", "Medium"]}
        # We decode: [0, 1, 2] → ["Aspirin", "Ibuprofen", "Placebo"]
        factor1_levels_list = []
        factor2_levels_list = []
        if factor_level_labels is not None and isinstance(factor_level_labels, dict):
            factor1_levels_list = factor_level_labels.get(factor1_name, [])
            factor2_levels_list = factor_level_labels.get(factor2_name, [])

        # Build lookup dictionaries {0: "Aspirin", 1: "Ibuprofen", ...}
        factor1_lookup = {idx: lvl for idx, lvl in enumerate(factor1_levels_list)}
        factor2_lookup = {idx: lvl for idx, lvl in enumerate(factor2_levels_list)}

        # Decode numeric codes to categorical labels
        # If lookup fails (e.g., label list is empty), fall back to string conversion
        factor1_labels = [factor1_lookup.get(int(code), str(code)) for code in factor1_arr]
        factor2_labels = [factor2_lookup.get(int(code), str(code)) for code in factor2_arr]

        # Create DataFrame for analysis using DECODED LABELS (not numeric codes)
        df = pd.DataFrame({
            'value': data_arr,
            factor1_name: factor1_labels,
            factor2_name: factor2_labels
        })

        # Apply ordered categories if factor_level_labels provided
        # This preserves the UI-selected/baseline level ordering for ANOVA + plots.
        factor1_levels_order = None
        factor2_levels_order = None
        if factor1_levels_list:
            present = {str(v) for v in factor1_labels}
            ordered = [str(lvl) for lvl in factor1_levels_list if str(lvl) in present]
            factor1_levels_order = ordered if ordered else None
        if factor2_levels_list:
            present = {str(v) for v in factor2_labels}
            ordered = [str(lvl) for lvl in factor2_levels_list if str(lvl) in present]
            factor2_levels_order = ordered if ordered else None

        if factor1_levels_order is not None:
            df[factor1_name] = pd.Categorical(df[factor1_name], categories=factor1_levels_order, ordered=True)
        if factor2_levels_order is not None:
            df[factor2_name] = pd.Categorical(df[factor2_name], categories=factor2_levels_order, ordered=True)

        # Remove rows with NaN or Inf in the value column only
        initial_len = len(df)
        df = df[np.isfinite(df['value'])]
        df = df.dropna()

        if len(df) < initial_len:
            removed_count = initial_len - len(df)
            # This is just informational, we'll continue with valid data
            pass

        if len(df) < 3:
            return {'success': False, 'error': f'Insufficient valid data after removing NaN/Inf values. Two-way ANOVA requires at least 3 valid observations. Started with {initial_len} rows, {initial_len - len(df)} had invalid values.'}

        # Check observations per cell (important for balanced design)
        cell_counts = df.groupby([factor1_name, factor2_name]).size()
        min_cell_size = int(cell_counts.min())
        max_cell_size = int(cell_counts.max())
        mean_cell_size = float(cell_counts.mean())
        is_balanced = (min_cell_size == max_cell_size)

        # ASSUMPTION CHECK 1: Test for Homogeneity of Variance (Levene's test)
        # For two-way ANOVA, test across all factor level combinations
        from scipy.stats import levene
        groups_for_levene = [group['value'].values for name, group in df.groupby([factor1_name, factor2_name])]
        if len(groups_for_levene) >= 2:  # Need at least 2 groups for Levene's test
            levene_stat, levene_p = levene(*groups_for_levene, center='median')
            equal_variances = bool(levene_p >= alpha)
        else:
            levene_stat, levene_p = np.nan, np.nan
            equal_variances = None

        # Build formula dynamically using actual factor names
        # CRITICAL: Use Sum contrasts for proper Type III SS
        # Type III SS requires sum-to-zero contrasts to properly test each effect controlling for others
        from patsy.contrasts import Sum
        formula = f'value ~ C({factor1_name}, Sum) + C({factor2_name}, Sum) + C({factor1_name}, Sum):C({factor2_name}, Sum)'
        model = ols(formula, data=df).fit()

        # Use Type III Sum of Squares (industry-standard default)
        # Type III tests each effect after controlling for all other effects
        # With Sum contrasts, this now produces identical results to the baseline
        anova_table = sm.stats.anova_lm(model, typ=3)

        # Create dynamic index names for ANOVA table lookups
        # With Sum contrasts, the index includes the contrast specification
        factor1_idx = f'C({factor1_name}, Sum)'
        factor2_idx = f'C({factor2_name}, Sum)'
        interaction_idx = f'C({factor1_name}, Sum):C({factor2_name}, Sum)'

        # ASSUMPTION CHECK 2: Test for Normality of Residuals (Shapiro-Wilk)
        # For two-way ANOVA, test the residuals from the model
        residuals = model.resid
        if len(residuals) >= 3:
            try:
                w_stat, norm_p = shapiro(residuals)
                residuals_normal = bool(norm_p >= alpha)
            except Exception as e:
                w_stat, norm_p = np.nan, np.nan
                residuals_normal = None
        else:
            w_stat, norm_p = np.nan, np.nan
            residuals_normal = None

        # Helper function to safely get values from ANOVA table
        # (handles cases where factor has only one level and row is missing)
        def _safe_get(table, row, col, default=np.nan):
            """Get value from ANOVA table, return default if row doesn't exist"""
            return float(table.loc[row, col]) if row in table.index else float(default)

        # EFFECT SIZE CALCULATION: Partial Eta-Squared for each effect
        # Partial η² = SS_effect / (SS_effect + SS_error)
        ss_residual = _safe_get(anova_table, 'Residual', 'sum_sq', 0)
        df_residual = _safe_get(anova_table, 'Residual', 'df', 0)
        ms_error = ss_residual / df_residual if df_residual > 0 else np.nan

        # Factor 1 partial eta-squared
        ss_factor1 = _safe_get(anova_table, factor1_idx, 'sum_sq', 0)
        partial_eta_sq_f1 = ss_factor1 / (ss_factor1 + ss_residual) if (ss_factor1 + ss_residual) > 0 else 0

        # Factor 2 partial eta-squared
        ss_factor2 = _safe_get(anova_table, factor2_idx, 'sum_sq', 0)
        partial_eta_sq_f2 = ss_factor2 / (ss_factor2 + ss_residual) if (ss_factor2 + ss_residual) > 0 else 0

        # Interaction partial eta-squared
        ss_interaction = _safe_get(anova_table, interaction_idx, 'sum_sq', 0)
        partial_eta_sq_int = ss_interaction / (ss_interaction + ss_residual) if (ss_interaction + ss_residual) > 0 else 0

        # ANOVA table total SS (sum of all sources)
        # This is different from corrected total variance (used for omega squared)
        ss_total_anova = ss_factor1 + ss_factor2 + ss_interaction + ss_residual

        # Interpret effect sizes (Cohen 1988 thresholds handled in interpret_partial_eta)

        # Extract results with flat structure to match C# expectations
        factor1_f_value = _safe_get(anova_table, factor1_idx, 'F')
        factor1_p_value = _safe_get(anova_table, factor1_idx, 'PR(>F)')
        factor1_df_value = _safe_get(anova_table, factor1_idx, 'df', 0)

        factor2_f_value = _safe_get(anova_table, factor2_idx, 'F')
        factor2_p_value = _safe_get(anova_table, factor2_idx, 'PR(>F)')
        factor2_df_value = _safe_get(anova_table, factor2_idx, 'df', 0)

        interaction_f_value = _safe_get(anova_table, interaction_idx, 'F')
        interaction_p_value = _safe_get(anova_table, interaction_idx, 'PR(>F)')
        interaction_df_value = _safe_get(anova_table, interaction_idx, 'df', 0)

        def _compute_partial_omega(ss_effect, df_effect, ms_error, n_total):
            """Compute partial omega squared effect size estimator."""
            if df_effect <= 0 or n_total is None or n_total <= df_effect or np.isnan(ms_error):
                return 0.0
            numerator = ss_effect - (df_effect * ms_error)
            if np.isnan(numerator):
                return 0.0
            denominator = ss_effect + ((n_total - df_effect) * ms_error)
            if denominator <= 0:
                return 0.0
            value = numerator / denominator
            return float(max(0.0, min(1.0, value)))

        n_total = len(df)
        omega_sq_f1 = _compute_partial_omega(ss_factor1, factor1_df_value, ms_error, n_total)
        omega_sq_f2 = _compute_partial_omega(ss_factor2, factor2_df_value, ms_error, n_total)
        omega_sq_int = _compute_partial_omega(ss_interaction, interaction_df_value, ms_error, n_total)

        # Calculate Mean Squares for display
        ms_factor1 = ss_factor1 / factor1_df_value if factor1_df_value > 0 else np.nan
        ms_factor2 = ss_factor2 / factor2_df_value if factor2_df_value > 0 else np.nan
        ms_interaction = ss_interaction / interaction_df_value if interaction_df_value > 0 else np.nan

        # Calculate cell means with 95% confidence intervals (observed cell means)
        # Group by both factors to get all cells
        cell_summaries = []
        cell_mean_values = {}
        cell_n_values = {}
        for (level1, level2), group_data in df.groupby([factor1_name, factor2_name]):
            cell_mean = group_data['value'].mean()
            cell_std = group_data['value'].std(ddof=1)
            cell_n = len(group_data)

            # Calculate 95% CI using pooled variance (MSE) like One-Way ANOVA
            # CI = mean ± t_critical * sqrt(MSE / n)
            # Use df_residual for degrees of freedom (pooled across all cells)
            if df_residual > 0 and not np.isnan(ms_error) and cell_n > 0:
                t_critical = stats.t.ppf(0.975, df=df_residual)  # 0.975 for two-tailed 95% CI
                se_pooled = np.sqrt(ms_error / cell_n)
                ci_margin = t_critical * se_pooled
                ci_lower = cell_mean - ci_margin
                ci_upper = cell_mean + ci_margin
            else:
                ci_lower = np.nan
                ci_upper = np.nan

            cell_summaries.append({
                'factor1_level': str(level1),
                'factor2_level': str(level2),
                'cell_label': f'{level1} × {level2}',
                'mean': format_number(cell_mean),
                'std': format_number(cell_std),
                'n': int(cell_n),
                'ci_95_lower': format_number(ci_lower) if not np.isnan(ci_lower) else None,
                'ci_95_upper': format_number(ci_upper) if not np.isnan(ci_upper) else None
            })
            cell_mean_values[(str(level1), str(level2))] = float(cell_mean)
            cell_n_values[(str(level1), str(level2))] = int(cell_n)

        # Detailed cell counts (per cell)
        cell_counts_detail = []
        for (level1, level2), count in cell_counts.items():
            cell_counts_detail.append({
                'factor1_level': str(level1),
                'factor2_level': str(level2),
                'cell_label': f'{level1} × {level2}',
                'n': int(count),
            })

        # Predicted means (LS means) for each cell using the fitted model
        # Use model predictions on a full grid of factor levels
        cell_emmeans = []
        try:
            if isinstance(df[factor1_name].dtype, pd.CategoricalDtype):
                factor1_levels = list(df[factor1_name].cat.categories)
            else:
                factor1_levels = sorted(df[factor1_name].unique())
            if isinstance(df[factor2_name].dtype, pd.CategoricalDtype):
                factor2_levels = list(df[factor2_name].cat.categories)
            else:
                factor2_levels = sorted(df[factor2_name].unique())
            grid = pd.DataFrame(
                list(product(factor1_levels, factor2_levels)),
                columns=[factor1_name, factor2_name]
            )
            grid[factor1_name] = pd.Categorical(grid[factor1_name], categories=factor1_levels, ordered=True)
            grid[factor2_name] = pd.Categorical(grid[factor2_name], categories=factor2_levels, ordered=True)

            pred = model.get_prediction(grid)
            pred_summary = pred.summary_frame(alpha=alpha)
            for (level1, level2), row in zip(product(factor1_levels, factor2_levels), pred_summary.itertuples()):
                mean_val = float(getattr(row, 'mean'))
                mean_se = float(getattr(row, 'mean_se'))
                ci_lower = float(getattr(row, 'mean_ci_lower'))
                ci_upper = float(getattr(row, 'mean_ci_upper'))
                count = int(cell_counts.get((level1, level2), 0)) if (level1, level2) in cell_counts.index else 0
                cell_emmeans.append({
                    'factor1_level': str(level1),
                    'factor2_level': str(level2),
                    'cell_label': f'{level1} × {level2}',
                    'emmean': format_number(mean_val),
                    'se': format_number(mean_se),
                    'n': count,
                    'ci_95_lower': format_number(ci_lower) if not np.isnan(ci_lower) else None,
                    'ci_95_upper': format_number(ci_upper) if not np.isnan(ci_upper) else None
                })
        except Exception:
            cell_emmeans = []

        rows_summary = {
            'rows_start': int(initial_len),
            'rows_used': int(len(df)),
            'rows_dropped': int(initial_len - len(df))
        }

        result = {
            'success': True,
            'test_type': 'two_way',
            'alpha': format_number(alpha),
            'rows_start': rows_summary['rows_start'],
            'rows_used': rows_summary['rows_used'],
            'rows_dropped': rows_summary['rows_dropped'],
            'factor1_label': factor1_name,
            'factor2_label': factor2_name,
            'interaction_label': f'{factor1_name} x {factor2_name}',
            # Main effect of Factor 1
            'factor1_f': format_number(factor1_f_value),
            'factor1_p': format_number(factor1_p_value),
            'factor1_df': int(factor1_df_value),
            'factor1_significant': bool(factor1_p_value < alpha) if not np.isnan(factor1_p_value) else False,
            'factor1_partial_eta_squared': format_number(partial_eta_sq_f1),
            'factor1_eta': format_number(partial_eta_sq_f1),
            'factor1_effect_interpretation': interpret_partial_eta(partial_eta_sq_f1),
            'factor1_omega_squared': format_number(omega_sq_f1),
            'factor1_omega_interpretation': interpret_partial_eta(omega_sq_f1),
            # Main effect of Factor 2
            'factor2_f': format_number(factor2_f_value),
            'factor2_p': format_number(factor2_p_value),
            'factor2_df': int(factor2_df_value),
            'factor2_significant': bool(factor2_p_value < alpha) if not np.isnan(factor2_p_value) else False,
            'factor2_partial_eta_squared': format_number(partial_eta_sq_f2),
            'factor2_eta': format_number(partial_eta_sq_f2),
            'factor2_effect_interpretation': interpret_partial_eta(partial_eta_sq_f2),
            'factor2_omega_squared': format_number(omega_sq_f2),
            'factor2_omega_interpretation': interpret_partial_eta(omega_sq_f2),
            # Interaction effect
            'interaction_f': format_number(interaction_f_value),
            'interaction_p': format_number(interaction_p_value),
            'interaction_df': int(interaction_df_value),
            'interaction_significant': bool(interaction_p_value < alpha) if not np.isnan(interaction_p_value) else False,
            'interaction_partial_eta_squared': format_number(partial_eta_sq_int),
            'interaction_eta': format_number(partial_eta_sq_int),
            'interaction_effect_interpretation': interpret_partial_eta(partial_eta_sq_int),
            'interaction_omega_sq': format_number(omega_sq_int),
            'interaction_omega_interpretation': interpret_partial_eta(omega_sq_int),
            # Residual degrees of freedom
            'residual_df': int(_safe_get(anova_table, 'Residual', 'df', 0)),
            # Model fit
            'r_squared': format_number(model.rsquared),
            'adj_r_squared': format_number(model.rsquared_adj),
            # Sum of Squares (for ANOVA table display)
            'ss_factor1': format_number(ss_factor1),
            'ss_factor2': format_number(ss_factor2),
            'ss_interaction': format_number(ss_interaction),
            'ss_residual': format_number(ss_residual),
            'ss_total': format_number(ss_total_anova),
            # Mean Squares (for ANOVA table display)
            'ms_factor1': format_number(ms_factor1) if not np.isnan(ms_factor1) else None,
            'ms_factor2': format_number(ms_factor2) if not np.isnan(ms_factor2) else None,
            'ms_interaction': format_number(ms_interaction) if not np.isnan(ms_interaction) else None,
            'ms_residual': format_number(ms_error) if not np.isnan(ms_error) else None,
            # Cell means with 95% confidence intervals (observed)
            'cell_summaries': cell_summaries,
            # Predicted (LS) means per cell (for unbalanced designs)
            'cell_emmeans': cell_emmeans,
            # Design information
            'cell_counts': {
                'min': min_cell_size,
                'max': max_cell_size,
                'mean': format_number(mean_cell_size),
                'is_balanced': is_balanced
            },
            'cell_counts_detail': cell_counts_detail,
            'means_type': 'cell_mean' if is_balanced else 'lsmean',
            # Assumption checks
            'assumptions': {
                'homogeneity_of_variance': {
                    'levene_statistic': format_number(levene_stat) if not np.isnan(levene_stat) else None,
                    'levene_p_value': format_number(levene_p) if not np.isnan(levene_p) else None,
                    'equal_variances': equal_variances,
                    'test': 'Levene (median)'
                },
                'normality': {
                    'shapiro_statistic': format_number(w_stat) if not np.isnan(w_stat) else None,
                    'shapiro_p_value': format_number(norm_p) if not np.isnan(norm_p) else None,
                    'residuals_normal': residuals_normal,
                    'test': 'Shapiro-Wilk (residuals)'
                }
            }
        }

        result['factor1_display'] = {
            'statistic_label': f'{factor1_name} F statistic',
            'statistic_value': format_number(factor1_f_value),
            'pvalue_label': f'{factor1_name} p-value',
            'pvalue_value': format_number(factor1_p_value),
            'significance_label': f'{factor1_name} significance',
            'significance_marker': significance_marker(factor1_p_value),
            'significance_text': significance_text(factor1_p_value),
            'effect_label': f'{factor1_name} partial eta sq',
            'effect_value': format_number(partial_eta_sq_f1),
            'effect_interpretation': interpret_partial_eta(partial_eta_sq_f1),
            'omega_label': f'{factor1_name} omega sq',
            'omega_value': format_number(omega_sq_f1),
            'omega_interpretation': interpret_partial_eta(omega_sq_f1)
        }

        result['factor2_display'] = {
            'statistic_label': f'{factor2_name} F statistic',
            'statistic_value': format_number(factor2_f_value),
            'pvalue_label': f'{factor2_name} p-value',
            'pvalue_value': format_number(factor2_p_value),
            'significance_label': f'{factor2_name} significance',
            'significance_marker': significance_marker(factor2_p_value),
            'significance_text': significance_text(factor2_p_value),
            'effect_label': f'{factor2_name} partial eta sq',
            'effect_value': format_number(partial_eta_sq_f2),
            'effect_interpretation': interpret_partial_eta(partial_eta_sq_f2),
            'omega_label': f'{factor2_name} omega sq',
            'omega_value': format_number(omega_sq_f2),
            'omega_interpretation': interpret_partial_eta(omega_sq_f2)
        }

        result['interaction_display'] = {
            'statistic_label': f'{factor1_name} x {factor2_name} F statistic',
            'statistic_value': format_number(interaction_f_value),
            'pvalue_label': f'{factor1_name} x {factor2_name} p-value',
            'pvalue_value': format_number(interaction_p_value),
            'significance_label': f'{factor1_name} x {factor2_name} significance',
            'significance_marker': significance_marker(interaction_p_value),
            'significance_text': significance_text(interaction_p_value),
            'effect_label': f'{factor1_name} x {factor2_name} partial eta sq',
            'effect_value': format_number(partial_eta_sq_int),
            'effect_interpretation': interpret_partial_eta(partial_eta_sq_int),
            'omega_label': f'{factor1_name} x {factor2_name} omega sq',
            'omega_value': format_number(omega_sq_int),
            'omega_interpretation': interpret_partial_eta(omega_sq_int)
        }

        # PHASE 2: Main effects post-hoc (v1.23 - matching Scheirer-Ray-Hare behavior)
        pairwise_comparisons = []
        main_effects_records = []
        simple_effects_records = []

        # Post-hoc adjustment configuration
        posthoc_method = str(posthoc_adjustment or 'tukey').lower()
        if posthoc_method not in ['tukey', 'bonferroni', 'holm', 'holm-sidak', 'sidak', 'dunnett', 'fdr_bh']:
            posthoc_method = 'tukey'
        control_levels = control_levels or {}
        adjustment_method_label = get_method_label(posthoc_method)
        posthoc_q_value = None
        if posthoc_method == 'fdr_bh':
            try:
                posthoc_q_value = float(posthoc_q) if posthoc_q is not None else float(alpha)
            except Exception:
                posthoc_q_value = float(alpha)
            if posthoc_q_value <= 0 or posthoc_q_value > 1:
                posthoc_q_value = float(alpha)
        posthoc_threshold = posthoc_q_value if posthoc_method == 'fdr_bh' else float(alpha)

        def _format_pairwise_output(comp, factor=None, factor_scope=None):
            p_adj = comp.get('p_adjusted', comp.get('p_raw', float('nan')))
            if not np.isfinite(p_adj):
                p_adj = float('nan')

            output = {
                'group1': str(comp['group1']),
                'group2': str(comp['group2']),
                'contrast': f"{comp['group1']} vs {comp['group2']}",
                'difference': format_number(comp['mean_diff']),
                'p_value': format_number(p_adj),
                'p_adjusted': format_number(p_adj),
                'p_value_display': f"{format_number(p_adj)} (pvalue) / {format_number(p_adj)} (padj)",
                'ci_lower': format_number(comp.get('ci_lower', float('nan'))),
                'ci_upper': format_number(comp.get('ci_upper', float('nan'))),
                'significant': bool(p_adj < posthoc_threshold) if np.isfinite(p_adj) else False,
                'n1': int(comp['n1']),
                'n2': int(comp['n2']),
                'se': format_number(comp['se']),
                't_stat': format_number(comp['t_stat']),
                'df': int(df_residual),
                'method': comp.get('method', adjustment_method_label),
            }
            if factor is not None:
                output['factor'] = factor
            if factor_scope is not None:
                output['factor_scope'] = factor_scope
            return output, p_adj

        # Always run main effects post-hoc (regardless of simple effects selection)
        # Then additionally run requested simple effects
        
        # Factor 1 main effect post-hoc (marginal means with equal weights)
        factor1_levels = sorted(df[factor1_name].unique())
        factor2_levels = sorted(df[factor2_name].unique())
        if len(factor1_levels) >= 2:
            try:
                from scipy.stats import studentized_range

                # Compute marginal means across factor2 with equal weights
                f1_marginals = {}
                for level1 in factor1_levels:
                    cell_means = []
                    cell_ns = []
                    for level2 in factor2_levels:
                        key = (str(level1), str(level2))
                        if key not in cell_mean_values or key not in cell_n_values:
                            continue
                        cell_means.append(cell_mean_values[key])
                        cell_ns.append(cell_n_values[key])

                    if len(cell_means) == 0:
                        continue

                    mean_val = float(sum(cell_means) / len(cell_means))
                    weight = 1.0 / len(cell_means)
                    if df_residual > 0 and not np.isnan(ms_error):
                        se_val = np.sqrt(
                            ms_error * sum((weight * weight) / n for n in cell_ns if n > 0)
                        )
                    else:
                        se_val = 0.0
                    n_total_level = int(sum(cell_ns))
                    f1_marginals[str(level1)] = {
                        'mean': mean_val,
                        'se': float(se_val),
                        'n': n_total_level,
                    }

                k = len(factor1_levels)
                factor1_comparisons = []
                for i in range(len(factor1_levels)):
                    for j in range(i + 1, len(factor1_levels)):
                        group1 = str(factor1_levels[i])
                        group2 = str(factor1_levels[j])
                        if group1 not in f1_marginals or group2 not in f1_marginals:
                            continue

                        mean1 = f1_marginals[group1]['mean']
                        mean2 = f1_marginals[group2]['mean']
                        se1 = f1_marginals[group1]['se']
                        se2 = f1_marginals[group2]['se']
                        n1 = f1_marginals[group1]['n']
                        n2 = f1_marginals[group2]['n']

                        mean_diff = float(mean1 - mean2)
                        se_diff = np.sqrt(se1 ** 2 + se2 ** 2) if se1 >= 0 and se2 >= 0 else 0
                        t_stat = mean_diff / se_diff if se_diff > 0 else 0
                        p_raw = float(2 * stats.t.sf(abs(t_stat), df_residual)) if df_residual > 0 else float('nan')

                        # Default CI from t distribution
                        if df_residual > 0:
                            t_critical = stats.t.ppf(1 - alpha / 2, df_residual)
                            margin = t_critical * se_diff
                            ci_low = mean_diff - margin
                            ci_high = mean_diff + margin
                        else:
                            ci_low = float('nan')
                            ci_high = float('nan')

                        comp = {
                            'group1': str(group1),
                            'group2': str(group2),
                            'mean_diff': mean_diff,
                            'se': float(se_diff),
                            't_stat': float(t_stat),
                            'p_raw': float(p_raw),
                            'p_adjusted': float(p_raw),
                            'ci_lower': float(ci_low),
                            'ci_upper': float(ci_high),
                            'n1': int(n1),
                            'n2': int(n2),
                        }

                        if posthoc_method == 'tukey' and df_residual > 0 and k > 1:
                            q_stat = abs(t_stat) * np.sqrt(2)
                            p_adj = float(studentized_range.sf(q_stat, k, df_residual))
                            q_critical = float(studentized_range.ppf(1 - alpha, k, df_residual))
                            margin = q_critical * se_diff / np.sqrt(2)
                            comp['p_adjusted'] = p_adj
                            comp['ci_lower'] = float(mean_diff - margin)
                            comp['ci_upper'] = float(mean_diff + margin)
                            comp['method'] = 'Tukey HSD (pooled error)'
                        else:
                            if posthoc_method == 'dunnett':
                                control_level = control_levels.get(factor1_name)
                                if control_level and group1 == control_level:
                                    comp['n_control'] = int(n1)
                                    comp['n_treatment'] = int(n2)
                                elif control_level and group2 == control_level:
                                    comp['n_control'] = int(n2)
                                    comp['n_treatment'] = int(n1)

                        factor1_comparisons.append(comp)

                if posthoc_method != 'tukey' and factor1_comparisons:
                    try:
                        control_level = control_levels.get(factor1_name) if posthoc_method == 'dunnett' else None
                        factor1_comparisons = apply_adjustment(
                            factor1_comparisons,
                            posthoc_method,
                            alpha=alpha,
                            q=posthoc_q_value,
                            control_level=control_level,
                            k=k,
                            df=df_residual,
                        )
                    except Exception as e:
                        logger.warning(f"Two-Way ANOVA Factor 1 adjustment failed: {e}")

                for comp in factor1_comparisons:
                    formatted, p_adj = _format_pairwise_output(comp, factor=factor1_name)
                    pairwise_comparisons.append(formatted)
                    main_effects_records.append({
                        'factor': factor1_name,
                        'label': f"{comp['group1']} - {comp['group2']}",
                        'estimate': comp['mean_diff'],
                        'se': float(comp['se']),
                        'ci_lower': float(comp['ci_lower']) if np.isfinite(comp['ci_lower']) else float('nan'),
                        'ci_upper': float(comp['ci_upper']) if np.isfinite(comp['ci_upper']) else float('nan'),
                        'df': int(df_residual),
                        't_ratio': float(comp['t_stat']),
                        'p': float(p_adj) if np.isfinite(p_adj) else float('nan')
                    })

            except Exception as e:
                import sys
                print(f"Warning: Two-Way ANOVA Factor 1 main effect post-hoc failed: {str(e)}", file=sys.stderr)

        # Factor 2 main effect post-hoc (marginal means with equal weights)
        factor2_levels = sorted(df[factor2_name].unique())
        if len(factor2_levels) >= 2:
            try:
                from scipy.stats import studentized_range

                # Compute marginal means across factor1 with equal weights
                f2_marginals = {}
                for level2 in factor2_levels:
                    cell_means = []
                    cell_ns = []
                    for level1 in factor1_levels:
                        key = (str(level1), str(level2))
                        if key not in cell_mean_values or key not in cell_n_values:
                            continue
                        cell_means.append(cell_mean_values[key])
                        cell_ns.append(cell_n_values[key])

                    if len(cell_means) == 0:
                        continue

                    mean_val = float(sum(cell_means) / len(cell_means))
                    weight = 1.0 / len(cell_means)
                    if df_residual > 0 and not np.isnan(ms_error):
                        se_val = np.sqrt(
                            ms_error * sum((weight * weight) / n for n in cell_ns if n > 0)
                        )
                    else:
                        se_val = 0.0
                    n_total_level = int(sum(cell_ns))
                    f2_marginals[str(level2)] = {
                        'mean': mean_val,
                        'se': float(se_val),
                        'n': n_total_level,
                    }

                k = len(factor2_levels)
                factor2_comparisons = []
                for i in range(len(factor2_levels)):
                    for j in range(i + 1, len(factor2_levels)):
                        group1 = str(factor2_levels[i])
                        group2 = str(factor2_levels[j])
                        if group1 not in f2_marginals or group2 not in f2_marginals:
                            continue

                        mean1 = f2_marginals[group1]['mean']
                        mean2 = f2_marginals[group2]['mean']
                        se1 = f2_marginals[group1]['se']
                        se2 = f2_marginals[group2]['se']
                        n1 = f2_marginals[group1]['n']
                        n2 = f2_marginals[group2]['n']

                        mean_diff = float(mean1 - mean2)
                        se_diff = np.sqrt(se1 ** 2 + se2 ** 2) if se1 >= 0 and se2 >= 0 else 0
                        t_stat = mean_diff / se_diff if se_diff > 0 else 0
                        p_raw = float(2 * stats.t.sf(abs(t_stat), df_residual)) if df_residual > 0 else float('nan')

                        # Default CI from t distribution
                        if df_residual > 0:
                            t_critical = stats.t.ppf(1 - alpha / 2, df_residual)
                            margin = t_critical * se_diff
                            ci_low = mean_diff - margin
                            ci_high = mean_diff + margin
                        else:
                            ci_low = float('nan')
                            ci_high = float('nan')

                        comp = {
                            'group1': str(group1),
                            'group2': str(group2),
                            'mean_diff': mean_diff,
                            'se': float(se_diff),
                            't_stat': float(t_stat),
                            'p_raw': float(p_raw),
                            'p_adjusted': float(p_raw),
                            'ci_lower': float(ci_low),
                            'ci_upper': float(ci_high),
                            'n1': int(n1),
                            'n2': int(n2),
                        }

                        if posthoc_method == 'tukey' and df_residual > 0 and k > 1:
                            q_stat = abs(t_stat) * np.sqrt(2)
                            p_adj = float(studentized_range.sf(q_stat, k, df_residual))
                            q_critical = float(studentized_range.ppf(1 - alpha, k, df_residual))
                            margin = q_critical * se_diff / np.sqrt(2)
                            comp['p_adjusted'] = p_adj
                            comp['ci_lower'] = float(mean_diff - margin)
                            comp['ci_upper'] = float(mean_diff + margin)
                            comp['method'] = 'Tukey HSD (pooled error)'
                        else:
                            if posthoc_method == 'dunnett':
                                control_level = control_levels.get(factor2_name)
                                if control_level and group1 == control_level:
                                    comp['n_control'] = int(n1)
                                    comp['n_treatment'] = int(n2)
                                elif control_level and group2 == control_level:
                                    comp['n_control'] = int(n2)
                                    comp['n_treatment'] = int(n1)

                        factor2_comparisons.append(comp)

                if posthoc_method != 'tukey' and factor2_comparisons:
                    try:
                        control_level = control_levels.get(factor2_name) if posthoc_method == 'dunnett' else None
                        factor2_comparisons = apply_adjustment(
                            factor2_comparisons,
                            posthoc_method,
                            alpha=alpha,
                            q=posthoc_q_value,
                            control_level=control_level,
                            k=k,
                            df=df_residual,
                        )
                    except Exception as e:
                        logger.warning(f"Two-Way ANOVA Factor 2 adjustment failed: {e}")

                for comp in factor2_comparisons:
                    formatted, p_adj = _format_pairwise_output(comp, factor=factor2_name)
                    pairwise_comparisons.append(formatted)
                    main_effects_records.append({
                        'factor': factor2_name,
                        'label': f"{comp['group1']} - {comp['group2']}",
                        'estimate': comp['mean_diff'],
                        'se': float(comp['se']),
                        'ci_lower': float(comp['ci_lower']) if np.isfinite(comp['ci_lower']) else float('nan'),
                        'ci_upper': float(comp['ci_upper']) if np.isfinite(comp['ci_upper']) else float('nan'),
                        'df': int(df_residual),
                        't_ratio': float(comp['t_stat']),
                        'p': float(p_adj) if np.isfinite(p_adj) else float('nan')
                    })

            except Exception as e:
                import sys
                print(f"Warning: Two-Way ANOVA Factor 2 main effect post-hoc failed: {str(e)}", file=sys.stderr)

        # PHASE 3: Simple effects analysis (if requested) - v2.0.5 uses pooled error
        simple_effects_warning = None
        if simple_effects is not None and isinstance(simple_effects, dict):
            from scipy.stats import studentized_range

            # Check if interaction is significant - store warning in result if not, but still compute
            if interaction_p_value >= alpha:
                simple_effects_warning = (
                    f"Interaction not significant (p = {interaction_p_value:.4f} >= {alpha}). "
                    "Interpret simple effects with caution. Consider main effects instead."
                )

            # Always proceed with simple effects if requested (with warning if appropriate)
            # Continue using the same pairwise_comparisons list (don't reinitialize - preserve main effects)

            # Factor A within each level of Factor B
            if simple_effects.get('factor_a_within_factor_b', False):
                for level_b in sorted(df[factor2_name].unique()):
                    # Slice data to rows where Factor B = level_b
                    df_slice = df[df[factor2_name] == level_b]

                    # Get unique levels of Factor A in this slice
                    levels_a = sorted(df_slice[factor1_name].unique())
                    k = len(levels_a)  # Number of groups for Tukey adjustment

                    if k < 2:
                        continue  # Need at least 2 levels to compare

                    # Pairwise comparisons using POOLED error from overall ANOVA
                    try:
                        slice_comparisons = []
                        for i in range(k):
                            for j in range(i + 1, k):
                                group1 = levels_a[i]
                                group2 = levels_a[j]

                                # Get data for each group
                                group1_data = df_slice[df_slice[factor1_name] == group1]['value'].values
                                group2_data = df_slice[df_slice[factor1_name] == group2]['value'].values

                                n1 = len(group1_data)
                                n2 = len(group2_data)

                                if n1 == 0 or n2 == 0:
                                    continue

                                # Calculate mean difference
                                mean_diff = float(np.mean(group1_data) - np.mean(group2_data))

                                # Calculate standard error using POOLED MSE from overall ANOVA
                                # SE = sqrt(MSE * (1/n1 + 1/n2))
                                se_pooled = np.sqrt(ms_error * (1.0/n1 + 1.0/n2))

                                # Calculate t-statistic
                                t_stat = mean_diff / se_pooled if se_pooled > 0 else 0

                                p_raw = float(2 * stats.t.sf(abs(t_stat), df_residual)) if df_residual > 0 else float('nan')

                                # Default CI from t distribution
                                if df_residual > 0:
                                    t_critical = stats.t.ppf(1 - alpha / 2, df_residual)
                                    margin = t_critical * se_pooled
                                    ci_low = mean_diff - margin
                                    ci_high = mean_diff + margin
                                else:
                                    ci_low = float('nan')
                                    ci_high = float('nan')

                                comp = {
                                    'group1': str(group1),
                                    'group2': str(group2),
                                    'mean_diff': mean_diff,
                                    'se': float(se_pooled),
                                    't_stat': float(t_stat),
                                    'p_raw': float(p_raw),
                                    'p_adjusted': float(p_raw),
                                    'ci_lower': float(ci_low),
                                    'ci_upper': float(ci_high),
                                    'n1': int(n1),
                                    'n2': int(n2),
                                }

                                if posthoc_method == 'tukey' and df_residual > 0 and k > 1:
                                    q_stat = abs(t_stat) * np.sqrt(2)
                                    p_adj = float(studentized_range.sf(q_stat, k, df_residual))
                                    q_critical = studentized_range.ppf(1 - alpha, k, df_residual)
                                    margin = q_critical * se_pooled / np.sqrt(2)
                                    comp['p_adjusted'] = p_adj
                                    comp['ci_lower'] = float(mean_diff - margin)
                                    comp['ci_upper'] = float(mean_diff + margin)
                                    comp['method'] = 'Tukey HSD (pooled error)'
                                else:
                                    if posthoc_method == 'dunnett':
                                        control_level = control_levels.get(factor1_name)
                                        if control_level and str(group1) == control_level:
                                            comp['n_control'] = int(n1)
                                            comp['n_treatment'] = int(n2)
                                        elif control_level and str(group2) == control_level:
                                            comp['n_control'] = int(n2)
                                            comp['n_treatment'] = int(n1)

                                slice_comparisons.append(comp)

                        if posthoc_method != 'tukey' and slice_comparisons:
                            try:
                                control_level = control_levels.get(factor1_name) if posthoc_method == 'dunnett' else None
                                slice_comparisons = apply_adjustment(
                                    slice_comparisons,
                                    posthoc_method,
                                    alpha=alpha,
                                    q=posthoc_q_value,
                                    control_level=control_level,
                                    k=k,
                                    df=df_residual,
                                )
                            except Exception as e:
                                logger.warning(f"Simple effects adjustment failed for {factor1_name} within {factor2_name}={level_b}: {e}")

                        for comp in slice_comparisons:
                            scope = f'{factor1_name}|{factor2_name}={level_b}'
                            formatted, p_adj = _format_pairwise_output(comp, factor_scope=scope)
                            pairwise_comparisons.append(formatted)
                            simple_effects_records.append({
                                'label': f"{comp['group1']} - {comp['group2']}",
                                'factor2_level': str(level_b),
                                'estimate': float(comp['mean_diff']),
                                'se': float(comp['se']),
                                'ci_lower': float(comp['ci_lower']) if np.isfinite(comp['ci_lower']) else float('nan'),
                                'ci_upper': float(comp['ci_upper']) if np.isfinite(comp['ci_upper']) else float('nan'),
                                'df': int(df_residual),
                                't_ratio': float(comp['t_stat']),
                                'p': float(p_adj) if np.isfinite(p_adj) else float('nan')
                            })

                    except Exception as e:
                        # If calculation fails for this slice, skip it
                        logger.warning(f"Simple effects failed for {factor1_name} within {factor2_name}={level_b}: {e}")
                        continue

            # Factor B within each level of Factor A
            if simple_effects.get('factor_b_within_factor_a', False):
                for level_a in sorted(df[factor1_name].unique()):
                    # Slice data to rows where Factor A = level_a
                    df_slice = df[df[factor1_name] == level_a]

                    # Get unique levels of Factor B in this slice
                    levels_b = sorted(df_slice[factor2_name].unique())
                    k = len(levels_b)  # Number of groups for Tukey adjustment

                    if k < 2:
                        continue  # Need at least 2 levels to compare

                    # Pairwise comparisons using POOLED error from overall ANOVA
                    try:
                        slice_comparisons = []
                        for i in range(k):
                            for j in range(i + 1, k):
                                group1 = levels_b[i]
                                group2 = levels_b[j]

                                # Get data for each group
                                group1_data = df_slice[df_slice[factor2_name] == group1]['value'].values
                                group2_data = df_slice[df_slice[factor2_name] == group2]['value'].values

                                n1 = len(group1_data)
                                n2 = len(group2_data)

                                if n1 == 0 or n2 == 0:
                                    continue

                                # Calculate mean difference
                                mean_diff = float(np.mean(group1_data) - np.mean(group2_data))

                                # Calculate standard error using POOLED MSE from overall ANOVA
                                # SE = sqrt(MSE * (1/n1 + 1/n2))
                                se_pooled = np.sqrt(ms_error * (1.0/n1 + 1.0/n2))

                                # Calculate t-statistic
                                t_stat = mean_diff / se_pooled if se_pooled > 0 else 0

                                p_raw = float(2 * stats.t.sf(abs(t_stat), df_residual)) if df_residual > 0 else float('nan')

                                # Default CI from t distribution
                                if df_residual > 0:
                                    t_critical = stats.t.ppf(1 - alpha / 2, df_residual)
                                    margin = t_critical * se_pooled
                                    ci_low = mean_diff - margin
                                    ci_high = mean_diff + margin
                                else:
                                    ci_low = float('nan')
                                    ci_high = float('nan')

                                comp = {
                                    'group1': str(group1),
                                    'group2': str(group2),
                                    'mean_diff': mean_diff,
                                    'se': float(se_pooled),
                                    't_stat': float(t_stat),
                                    'p_raw': float(p_raw),
                                    'p_adjusted': float(p_raw),
                                    'ci_lower': float(ci_low),
                                    'ci_upper': float(ci_high),
                                    'n1': int(n1),
                                    'n2': int(n2),
                                }

                                if posthoc_method == 'tukey' and df_residual > 0 and k > 1:
                                    q_stat = abs(t_stat) * np.sqrt(2)
                                    p_adj = float(studentized_range.sf(q_stat, k, df_residual))
                                    q_critical = studentized_range.ppf(1 - alpha, k, df_residual)
                                    margin = q_critical * se_pooled / np.sqrt(2)
                                    comp['p_adjusted'] = p_adj
                                    comp['ci_lower'] = float(mean_diff - margin)
                                    comp['ci_upper'] = float(mean_diff + margin)
                                    comp['method'] = 'Tukey HSD (pooled error)'
                                else:
                                    if posthoc_method == 'dunnett':
                                        control_level = control_levels.get(factor2_name)
                                        if control_level and str(group1) == control_level:
                                            comp['n_control'] = int(n1)
                                            comp['n_treatment'] = int(n2)
                                        elif control_level and str(group2) == control_level:
                                            comp['n_control'] = int(n2)
                                            comp['n_treatment'] = int(n1)

                                slice_comparisons.append(comp)

                        if posthoc_method != 'tukey' and slice_comparisons:
                            try:
                                control_level = control_levels.get(factor2_name) if posthoc_method == 'dunnett' else None
                                slice_comparisons = apply_adjustment(
                                    slice_comparisons,
                                    posthoc_method,
                                    alpha=alpha,
                                    q=posthoc_q_value,
                                    control_level=control_level,
                                    k=k,
                                    df=df_residual,
                                )
                            except Exception as e:
                                logger.warning(f"Simple effects adjustment failed for {factor2_name} within {factor1_name}={level_a}: {e}")

                        for comp in slice_comparisons:
                            scope = f'{factor2_name}|{factor1_name}={level_a}'
                            formatted, p_adj = _format_pairwise_output(comp, factor_scope=scope)
                            pairwise_comparisons.append(formatted)
                            simple_effects_records.append({
                                'label': f"{comp['group1']} - {comp['group2']}",
                                'factor1_level': str(level_a),
                                'estimate': float(comp['mean_diff']),
                                'se': float(comp['se']),
                                'ci_lower': float(comp['ci_lower']) if np.isfinite(comp['ci_lower']) else float('nan'),
                                'ci_upper': float(comp['ci_upper']) if np.isfinite(comp['ci_upper']) else float('nan'),
                                'df': int(df_residual),
                                't_ratio': float(comp['t_stat']),
                                'p': float(p_adj) if np.isfinite(p_adj) else float('nan')
                            })

                    except Exception as e:
                        # If calculation fails for this slice, skip it
                        logger.warning(f"Simple effects failed for {factor2_name} within {factor1_name}={level_a}: {e}")
                        continue

        # Add pairwise comparisons to result if any were made (main effects or simple effects)
        if pairwise_comparisons:
            result['pairwise_comparisons'] = pairwise_comparisons
            if adjustment_method_label:
                result['adjustment_method'] = adjustment_method_label
            if posthoc_method == 'fdr_bh' and posthoc_q_value is not None:
                result['posthoc_q'] = format_number(posthoc_q_value)

        # Add flattened main effects (me*) for flat output compatibility
        for idx, record in enumerate(main_effects_records, start=1):
            prefix = f'me{idx}'
            result[f'{prefix}_factor'] = record['factor']
            result[f'{prefix}_label'] = record['label']
            result[f'{prefix}_estimate'] = format_number(record['estimate'])
            result[f'{prefix}_se'] = format_number(record['se'])
            result[f'{prefix}_ci_lower'] = format_number(record['ci_lower'])
            result[f'{prefix}_ci_upper'] = format_number(record['ci_upper'])
            result[f'{prefix}_df'] = record['df']
            result[f'{prefix}_t_ratio'] = format_number(record['t_ratio'])
            result[f'{prefix}_t'] = format_number(record['t_ratio'])
            result[f'{prefix}_p'] = format_number(record['p'])

        # Add flattened simple effects (se*) for flat output compatibility
        for idx, record in enumerate(simple_effects_records, start=1):
            prefix = f'se{idx}'
            result[f'{prefix}_label'] = record['label']
            if 'factor2_level' in record:
                result[f'{prefix}_factor2_level'] = record['factor2_level']
            if 'factor1_level' in record:
                result[f'{prefix}_factor1_level'] = record['factor1_level']
            result[f'{prefix}_estimate'] = format_number(record['estimate'])
            result[f'{prefix}_se'] = format_number(record['se'])
            result[f'{prefix}_ci_lower'] = format_number(record['ci_lower'])
            result[f'{prefix}_ci_upper'] = format_number(record['ci_upper'])
            result[f'{prefix}_df'] = record['df']
            result[f'{prefix}_t_ratio'] = format_number(record['t_ratio'])
            result[f'{prefix}_t'] = format_number(record['t_ratio'])
            result[f'{prefix}_p'] = format_number(record['p'])

        # Add simple effects warning if interaction not significant
        if simple_effects_warning:
            result['simple_effects_warning'] = simple_effects_warning

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}
