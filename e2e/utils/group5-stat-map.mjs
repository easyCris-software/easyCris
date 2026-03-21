/**
 * Group 5 (Distribution & Descriptive) Statistical Test Translation Map
 *
 * Maps data-stat attribute names to R baseline JSON keys for Group 5 tests.
 * Used during E2E metric extraction to align UI output with R baselines.
 *
 * Validated Metrics:
 * - normality_all: 11 metrics (n, shapiro_w, shapiro_p, ks_d, ks_p, ad_a, ad_p, cvm_w, cvm_p, jb_stat, jb_p)
 * - descriptive_stats: 16 metrics (n, mean, std, sem, variance, median, min, max, range, q1, q3, iqr, skewness, kurtosis, ci_lower, ci_upper)
 * - outlier_detection: 12 metrics (n, q1, q3, iqr, lower_fence, upper_fence, iqr_outlier_count, z_outlier_count, mad, mad_outlier_count, grubbs_g, grubbs_p)
 * - TOTAL: 39 metrics
 */

export const group5StatMap = {
  // ============================================================
  // Descriptive Statistics (data-stat -> R baseline key)
  // ============================================================
  'n': 'n',
  'mean': 'mean',
  'median': 'median',
  'std': 'std_dev',           // UI: std, R: std_dev
  'sem': 'std_error',         // UI: sem, R: std_error
  'variance': 'variance',
  'min': 'min',
  'max': 'max',
  'range': 'range',
  'q1': 'q1',
  'q3': 'q3',
  'iqr': 'iqr',
  'skewness': 'skewness',
  'kurtosis': 'kurtosis',
  'ci_lower': 'ci_95_lower',  // UI: ci_lower, R: ci_95_lower
  'ci_upper': 'ci_95_upper',  // UI: ci_upper, R: ci_95_upper

  // ============================================================
  // Normality Tests (all 5 tests)
  // ============================================================
  'shapiro_w': 'shapiro_w',
  'shapiro_p': 'shapiro_p',
  'ks_d': 'ks_d',
  'ks_p': 'ks_p',
  'ad_a': 'ad_a',
  'ad_p': 'ad_p',
  'cvm_w': 'cvm_w',           // Cramer-von Mises W statistic
  'cvm_p': 'cvm_p',           // Cramer-von Mises p-value
  'jb_stat': 'jb_stat',       // Jarque-Bera statistic
  'jb_p': 'jb_p',             // Jarque-Bera p-value

  // ============================================================
  // Outlier Detection (data-stat matches R baseline - no translation needed)
  // ============================================================
  'lower_fence': 'lower_fence',
  'upper_fence': 'upper_fence',
  'iqr_outlier_count': 'iqr_outlier_count',
  'z_outlier_count': 'z_outlier_count',
  'mad': 'mad',
  'mad_outlier_count': 'mad_outlier_count',
  'grubbs_g': 'grubbs_g',
  'grubbs_p': 'grubbs_p',
}

/**
 * Translate data-stat attribute name to R baseline key for Group 5 tests.
 *
 * @param {string} dataStat - The data-stat attribute value from the DOM
 * @returns {string} - The corresponding R baseline key
 */
export function translateGroup5StatName(dataStat) {
  return group5StatMap[dataStat] || dataStat
}

/**
 * Check if a test type belongs to Group 5 (Distribution & Descriptive).
 *
 * @param {string} testType - The test type identifier
 * @returns {boolean} - True if the test belongs to Group 5
 */
export function isGroup5Test(testType) {
  const group5Tests = [
    'normality_all',
    'descriptive_stats',
    'outlier_detection',
    'normality_shapiro',
    'normality_ks',
    'normality_ad',
    'normality_cvm',
    'normality_jb',
  ]
  return group5Tests.includes(testType)
}

/**
 * Get the expected metric count for a Group 5 test.
 *
 * @param {string} testType - The test type identifier
 * @returns {number} - Expected number of validated metrics
 */
export function getGroup5MetricCount(testType) {
  const metricCounts = {
    'normality_all': 11,       // All 5 normality tests (11 metrics)
    'descriptive_stats': 16,
    'outlier_detection': 12,
  }
  return metricCounts[testType] || 0
}
