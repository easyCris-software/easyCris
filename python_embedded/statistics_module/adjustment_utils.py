"""
Shared utilities for multiple comparison adjustments.

VERSION: 1.0.0
DATE: 2026-01-30
AUTHOR: Claude Code

Supports: Tukey, Bonferroni, Holm, Holm-Sidak, Sidak, Dunnett, FDR (Benjamini-Hochberg).

This module provides shared adjustment logic for post-hoc multiple comparisons
across one-way, two-way, and multifactorial ANOVA.

IMPORTANT:
- Tukey HSD is handled separately (uses studentized range distribution)
- Dunnett for factorial ANOVA uses pooled MSE t-statistics (not raw data)
- For one-way ANOVA Dunnett, scipy.stats.dunnett can be used directly
"""
import numpy as np
from scipy import stats
from scipy import optimize
from typing import List, Dict, Any, Optional


def apply_adjustment(
    pairwise_comparisons: List[Dict[str, Any]],
    adjustment_method: str,
    alpha: float = 0.05,
    q: Optional[float] = None,
    control_level: Optional[str] = None,
    k: Optional[int] = None,
    df: Optional[int] = None
) -> List[Dict[str, Any]]:
    """
    Apply multiple comparison adjustment to pairwise comparisons.

    Args:
        pairwise_comparisons: List of comparison dicts with 'p_raw', 'group1', 'group2'
        adjustment_method: 'tukey', 'bonferroni', 'holm', 'holm-sidak', 'sidak', 'dunnett', 'fdr_bh'
        alpha: Significance level (default 0.05)
        q: FDR q-value (only used when adjustment_method='fdr_bh')
        control_level: Required for Dunnett (which group is control)
        k: Number of groups (required for Tukey/Dunnett)
        df: Degrees of freedom (required for Tukey/Dunnett)

    Returns:
        Updated comparisons with 'p_adjusted' and 'significant' fields
    """
    if adjustment_method == 'tukey':
        # Already handled separately (uses studentized range)
        raise ValueError("Tukey should be handled by specialized function")

    elif adjustment_method == 'dunnett':
        # Filter to control comparisons only
        if not control_level:
            raise ValueError("control_level required for Dunnett adjustment")
        comparisons = [c for c in pairwise_comparisons
                      if c['group1'] == control_level or c['group2'] == control_level]
        # Apply Dunnett adjustment (implement separately)
        return apply_dunnett_adjustment(comparisons, control_level, k, df, alpha)

    elif adjustment_method in ['bonferroni', 'holm', 'holm-sidak', 'sidak', 'fdr_bh']:
        # Extract raw p-values
        raw_pvals = [c['p_raw'] for c in pairwise_comparisons]

        # Apply statsmodels multipletests
        from statsmodels.stats.multitest import multipletests
        threshold = q if adjustment_method == 'fdr_bh' and q is not None else alpha
        reject, pvals_adj, _, _ = multipletests(raw_pvals, alpha=threshold, method=adjustment_method)

        # Update comparisons
        for i, comp in enumerate(pairwise_comparisons):
            method_label = (
                'FDR (Benjamini-Hochberg)'
                if adjustment_method == 'fdr_bh'
                else f'{adjustment_method.replace("-", " ").title()} (pooled error)'
            )
            comp['p_adjusted'] = float(pvals_adj[i])
            comp['significant'] = bool(reject[i])
            comp['method'] = method_label

        return pairwise_comparisons

    else:
        raise ValueError(f"Unknown adjustment method: {adjustment_method}")


def apply_dunnett_adjustment(
    comparisons: List[Dict[str, Any]],
    control_level: str,
    k: int,
    df: int,
    alpha: float = 0.05
) -> List[Dict[str, Any]]:
    """
    Apply Dunnett's adjustment using pooled MSE (factorial ANOVA).

    NOTE:
    - Do NOT call scipy.stats.dunnett here; it recomputes variance from raw data.
    - Use pooled-MSE t-statistics already computed from the ANOVA model.

    Args:
        comparisons: List of comparison dicts with 'n_control', 'n_treatment', 't_stat'
        control_level: Name of control group
        k: Number of groups (including control)
        df: Error degrees of freedom
        alpha: Significance level (default 0.05)

    Returns:
        Updated comparisons with Dunnett-adjusted p-values
    """
    if not comparisons:
        return comparisons

    # Build correlation matrix rho from group sizes:
    # rho_ij = 1 / sqrt((n0/ni + 1)(n0/nj + 1))
    # where n0 = control size, ni = treatment size
    n_control = None
    n_samples = []
    t_stats = []

    for comp in comparisons:
        # Ensure each comp has n_control / n_treatment and t_stat
        if n_control is None:
            n_control = int(comp['n_control'])
        n_samples.append(int(comp['n_treatment']))
        t_stats.append(float(comp['t_stat']))

    n_samples = np.array(n_samples, dtype=float)
    n0 = float(n_control)

    # Build correlation matrix for multivariate t
    # rho_ij = n0 / sqrt((n0 + ni)(n0 + nj))
    # Simplified: rho_ij = 1 / sqrt((n0/ni + 1)(n0/nj + 1))
    rho = n0 / n_samples + 1.0
    rho = 1.0 / np.sqrt(rho[:, None] * rho[None, :])
    np.fill_diagonal(rho, 1.0)

    # Dunnett p-values via multivariate t distribution
    try:
        mvt = stats.multivariate_t(shape=rho, df=df)
        pvals = []
        for t_stat in t_stats:
            stat = abs(t_stat)
            # Two-tailed p-value: P(|T| > |t|) = 1 - P(-|t| < T < |t|)
            pval = 1 - mvt.cdf(
                np.full(len(t_stats), stat, dtype=float),
                lower_limit=np.full(len(t_stats), -stat, dtype=float),
            )
            pvals.append(float(max(0.0, min(1.0, pval))))  # Clip to [0, 1]

        if len(t_stats) == 1:
            dunnett_critical = float(stats.t.ppf(1 - alpha / 2, df))
        else:
            def objective(critical: float) -> float:
                bounds = np.full(len(t_stats), critical, dtype=float)
                lower = np.full(len(t_stats), -critical, dtype=float)
                rectangle_prob = float(mvt.cdf(bounds, lower_limit=lower))
                return (1 - rectangle_prob) - alpha

            upper = 2.0
            while objective(upper) > 0 and upper < 50:
                upper *= 2.0

            if objective(upper) > 0:
                raise RuntimeError("Failed to bracket Dunnett critical value")

            dunnett_critical = float(optimize.brentq(objective, 0.0, upper))
    except Exception as e:
        # Fallback not enabled - raise error
        raise RuntimeError(f"Dunnett multivariate-t computation failed: {e}")

    for comp, p_adj in zip(comparisons, pvals):
        comp['p_adjusted'] = p_adj
        comp['significant'] = p_adj < alpha
        comp['method'] = 'Dunnett (pooled MSE)'
        se = float(comp.get('se', float('nan')))
        mean_diff = float(comp.get('mean_diff', float('nan')))
        if np.isfinite(se) and np.isfinite(mean_diff):
            margin = dunnett_critical * se
            comp['ci_lower'] = float(mean_diff - margin)
            comp['ci_upper'] = float(mean_diff + margin)

    return comparisons


# Required fields for Dunnett pooled-MSE comparisons:
# - n_control (control group size)
# - n_treatment (treatment group size)
# - t_stat (pooled-MSE t-statistic)
#
# Ensure these are populated in anova.py / multifactorial_anova.py.


def get_dunnett_critical_value(k: int, df: int, alpha: float = 0.05) -> float:
    """
    Get Dunnett critical value from table (two-tailed, alpha=0.05).

    Args:
        k: Number of groups (including control)
        df: Error degrees of freedom
        alpha: Significance level (default 0.05)

    Returns:
        Critical value for Dunnett's test
    """
    # Dunnett critical values (two-tailed, alpha=0.05)
    # Rows: df, Columns: k-1 (number of treatments vs control)
    # Source: Dunnett (1955), interpolated from tables

    # Optional fallback ONLY if you explicitly allow approximation.
    # Preferred behavior: raise and block Dunnett when multivariate-t fails.
    raise NotImplementedError("Dunnett critical-value fallback not enabled")


def get_method_label(adjustment_method: str) -> str:
    """
    Get display label for adjustment method.

    Args:
        adjustment_method: Internal method name

    Returns:
        Human-readable label
    """
    method_labels = {
        'tukey': 'Tukey HSD',
        'bonferroni': 'Bonferroni',
        'holm': 'Holm',
        'holm-sidak': 'Holm-Sidak',
        'sidak': 'Sidak',
        'dunnett': 'Dunnett',
        'fdr_bh': 'FDR (Benjamini-Hochberg)',
    }
    return method_labels.get(adjustment_method.lower(), adjustment_method.title())
