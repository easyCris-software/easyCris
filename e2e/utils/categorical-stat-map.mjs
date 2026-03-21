/**
 * Categorical Tests - data-stat to R Baseline Key Translation Map
 *
 * Maps hierarchical data-stat attribute names from the UI to flat R baseline JSON keys.
 * Used during metric extraction to align with R baselines.
 *
 * See: _documentation/e2e-testing/GROUP_4_E2E_VALIDATION_PLAN.md
 */

/**
 * Translation map from data-stat attributes to R baseline keys
 */
export const categoricalStatMap = {
  // Chi-Square Independence (4 metrics)
  'chi_square.test.chi_square': 'chi_squared',
  'chi_square.test.df': 'degrees_of_freedom',
  'chi_square.test.p_value': 'p_value',
  'chi_square.effect_sizes.cramers_v': 'cramers_v',
  // Additional chi-square attributes (not in baseline, but may be in UI)
  'chi_square.effect_sizes.phi_coefficient': 'phi_coefficient',
  'chi_square.odds_ratio.value': 'odds_ratio',
  'chi_square.odds_ratio.ci_95_lower': 'ci_95_lower',
  'chi_square.odds_ratio.ci_95_upper': 'ci_95_upper',
  'chi_square.test.likelihood_ratio_chi2': 'likelihood_ratio_chi2',
  'chi_square.test.likelihood_ratio_df': 'likelihood_ratio_df',
  'chi_square.test.likelihood_ratio_p': 'likelihood_ratio_p',

  // Fisher's Exact (4 metrics)
  'fishers_exact.test.p_value': 'p_value',
  'fishers_exact.odds_ratio.value': 'odds_ratio',
  'fishers_exact.odds_ratio.ci_95_lower': 'ci_95_lower',
  'fishers_exact.odds_ratio.ci_95_upper': 'ci_95_upper',

  // McNemar's Test (5 metrics)
  'mcnemar.test.chi_square': 'chi_squared',
  'mcnemar.test.p_value': 'p_value',
  'mcnemar.test.exact_p_value': 'exact_p_value',
  'mcnemar.discordant_pairs.b': 'discordant_b',
  'mcnemar.discordant_pairs.c': 'discordant_c',

  // Chi-Square Goodness of Fit (3 metrics)
  'chi_square_gof.test.chi_square': 'chi_squared',
  'chi_square_gof.test.df': 'degrees_of_freedom',
  'chi_square_gof.test.p_value': 'p_value',
}

/**
 * Translate hierarchical data-stat name to flat R baseline key.
 * If no mapping exists, returns the original key unchanged.
 *
 * @param {string} dataStat - The data-stat attribute value from the UI
 * @returns {string} - The corresponding R baseline key
 */
export function translateStatName(dataStat) {
  return categoricalStatMap[dataStat] || dataStat
}

/**
 * Check if a data-stat attribute belongs to categorical tests
 *
 * @param {string} dataStat - The data-stat attribute value
 * @returns {boolean} - True if this is a categorical test stat
 */
export function isCategoricalStat(dataStat) {
  return (
    dataStat.startsWith('chi_square.') ||
    dataStat.startsWith('chi_square_gof.') ||
    dataStat.startsWith('fishers_exact.') ||
    dataStat.startsWith('mcnemar.')
  )
}
