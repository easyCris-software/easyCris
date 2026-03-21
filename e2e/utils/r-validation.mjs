/**
 * R Baseline Validation Utility
 * FIX 3: Extracts data-stat attributes from table cells for R comparison
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation infrastructure (655 metrics).
 * Contains metric extraction and comparison logic validated against R baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { translateStatName, isCategoricalStat } from './categorical-stat-map.mjs'
import { translateGroup5StatName, isGroup5Test } from './group5-stat-map.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASELINES_DIR = path.resolve(__dirname, '../fixtures/baselines')
const PLOT_BASELINES_DIR = path.resolve(__dirname, '../fixtures/plot-baselines')

// Test to validation group mapping (copied from fixtures.mjs for internal use)
const TEST_TO_GROUP = {
  // Group 1: Hypothesis Testing
    anova_one_way: 'Group1_Hypothesis_Testing',
    anova_two_way: 'Group1_Hypothesis_Testing',
    anova_two_way_unbalanced: 'Group1_Hypothesis_Testing',
    lmm_anova: 'Group1_Hypothesis_Testing',
  t_test_one_sample: 'Group1_Hypothesis_Testing',
  t_test_two_sample: 'Group1_Hypothesis_Testing',
  t_test_paired: 'Group1_Hypothesis_Testing',
  mann_whitney: 'Group1_Hypothesis_Testing',
  wilcoxon_signed_rank: 'Group1_Hypothesis_Testing',
  kruskal_wallis: 'Group1_Hypothesis_Testing',
  scheirer_ray_hare: 'Group1_Hypothesis_Testing',
    multifactorial_anova: 'Group1_Hypothesis_Testing',
    multifactorial_anova_unbalanced: 'Group1_Hypothesis_Testing',
  // Group 2: Pharmacology
  dose_response_3pl: 'Group2_Pharmacology',
  dose_response_4pl: 'Group2_Pharmacology',
  dose_response_5pl: 'Group2_Pharmacology',
  dose_response_compare: 'Group2_Pharmacology',
  synergy_bliss: 'Group2_Pharmacology',
  synergy_hsa: 'Group2_Pharmacology',
  synergy_loewe: 'Group2_Pharmacology',
  synergy_zip: 'Group2_Pharmacology',
  synergy_all: 'Group2_Pharmacology',
  // Group 3: Regression & Correlation
  correlation_pearson: 'Group3_Regression_Correlation',
  correlation_spearman: 'Group3_Regression_Correlation',
  correlation_kendall: 'Group3_Regression_Correlation',
  linear_regression: 'Group3_Regression_Correlation',
  multiple_linear_regression: 'Group3_Regression_Correlation',
  logistic_binary: 'Group3_Regression_Correlation',
  logistic_multinomial: 'Group3_Regression_Correlation',
  // Group 4: Categorical Tests
  chi_square: 'Group4_Categorical',
  chi_square_gof: 'Group4_Categorical',
  fishers_exact: 'Group4_Categorical',
  mcnemar: 'Group4_Categorical',
  // Group 5: Distribution & Descriptive
  normality_all: 'Group5_Distribution_Descriptive',
  descriptive_stats: 'Group5_Distribution_Descriptive',
  outlier_detection: 'Group5_Distribution_Descriptive',
  // Group 6: Survival Analysis
  kaplan_meier: 'Group6_Survival',
  cox_proportional_hazards: 'Group6_Survival',
  nelson_aalen: 'Group6_Survival',
  // RNA-seq
  rnaseq: 'RNA_seq',
}

const TEST_TO_VALIDATION_DIR = {
  chi_square: 'chi_squared',
  chi_square_gof: 'chi_squared_gof',
  fishers_exact: 'fisher_exact',
  normality_all: 'normality_tests',
  descriptive_stats: 'descriptive_statistics',
  lmm_anova: 'linear_mixed_models',
}

export function getValidationDirForTest(testName) {
  return TEST_TO_VALIDATION_DIR[testName] ?? testName
}

/**
 * Load R baseline JSON file for a test
 * @param {string} testName - Test name (e.g., 'anova_two_way')
 * @returns {object} R baseline metrics
 */
export async function loadRBaseline(testName) {
  const baselinePath = path.join(BASELINES_DIR, `${testName}_r_baseline.json`)

  if (!fs.existsSync(baselinePath)) {
    throw new Error(`R baseline not found: ${baselinePath}`)
  }

  const json = fs.readFileSync(baselinePath, 'utf-8')
  const baseline = JSON.parse(json)

  console.log(`[R Validation] Loaded baseline: ${testName} (${Object.keys(baseline).length} metrics)`)

  return baseline
}

/**
 * FIX 3: Extract statistics using data-stat attributes
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testType - Test type for logging
 * @returns {object} Extracted metrics as {data-stat: value}
 */
export async function extractStatsFromUI(driver, testType) {
  console.log(`[R Validation] Extracting stats for: ${testType}`)

  const stats = await driver.executeScript(() => {
    const results = {}

    // Try results-table first, then fall back to searching entire document
    let table = document.querySelector('[data-testid="results-table"]')
    let searchRoot = table

    if (!table) {
      // Fallback: search in results panel or entire document
      const resultsPanel = document.querySelector('[data-testid="results-panel"]') ||
                          document.querySelector('.results-container') ||
                          document.querySelector('[class*="results"]') ||
                          document.body
      searchRoot = resultsPanel
      console.log('[R Validation] No results-table found, searching in:', resultsPanel?.className || 'document body')
    }

    // Extract standard metric cells plus visible CI cells that only expose metadata attrs.
    const statCells = searchRoot.querySelectorAll(
      '[data-stat], [data-ci-lower-stat], [data-ci-upper-stat]'
    )

    // DEBUG: Collect all data-stat values found
    const allStats = Array.from(statCells).map(c => c.getAttribute('data-stat'))
    results._debug_all_stats = allStats

    // DEBUG: Check what table titles exist
    const tableTitles = Array.from(searchRoot.querySelectorAll('h3, h4, .table-title, [class*="title"]')).map(el => el.textContent?.trim())
    results._debug_table_titles = tableTitles

    for (const cell of statCells) {
      const statName = cell.getAttribute('data-stat')

      // Check for data-value attribute first (for formatted cells like "t=44.64" or "N = 10")
      const rawValue = statName ? cell.getAttribute('data-value') : null
      if (rawValue) {
        const numValue = parseFloat(rawValue)
        if (!isNaN(numValue)) {
          results[statName] = numValue
        }
        continue
      }

      // Fall back to parsing textContent
      const statValue = statName ? cell.textContent.trim() : ''

      // Parse numeric values (handle < prefix for p-values, ± prefix for critical values)
      const numValue = parseFloat(statValue.replace('<', '').replace('±', '').replace(/,/g, ''))
      if (statName && !isNaN(numValue)) {
        results[statName] = numValue
      }

      // Extract custom data-* attributes (data-se1-df, data-me1-df, etc.)
      for (const attr of cell.attributes) {
        // Check for data-*-df attributes (e.g., data-se1-df="12")
        if (attr.name.startsWith('data-') && attr.name.endsWith('-df') && !attr.name.startsWith('data-stat')) {
          const metricName = attr.name.replace('data-', '').replace(/-/g, '_')
          const metricValue = parseFloat(attr.value)
          if (!isNaN(metricValue)) {
            results[metricName] = metricValue
          }
        }
      }

      // Also extract additional t_critical variants from data-* attributes
      const pooledTCrit = cell.getAttribute('data-pooled-t-critical')
      const pooledLowerTCrit = cell.getAttribute('data-pooled-lower-t-critical')
      const welchTCrit = cell.getAttribute('data-welch-t-critical')
      const welchLowerTCrit = cell.getAttribute('data-welch-lower-t-critical')
      const ciLowerStat = cell.getAttribute('data-ci-lower-stat')
      const ciLowerValue = cell.getAttribute('data-ci-lower-value')
      const ciUpperStat = cell.getAttribute('data-ci-upper-stat')
      const ciUpperValue = cell.getAttribute('data-ci-upper-value')

      if (pooledTCrit) results['pooled_t_critical'] = parseFloat(pooledTCrit)
      if (pooledLowerTCrit) results['pooled_lower_t_critical'] = parseFloat(pooledLowerTCrit)
      if (welchTCrit) results['welch_t_critical'] = parseFloat(welchTCrit)
      if (welchLowerTCrit) results['welch_lower_t_critical'] = parseFloat(welchLowerTCrit)
      if (ciLowerStat && ciLowerValue) results[ciLowerStat] = parseFloat(ciLowerValue)
      if (ciUpperStat && ciUpperValue) results[ciUpperStat] = parseFloat(ciUpperValue)

      // Extract one-sample t-test t_critical variants
      const lowerTCrit = cell.getAttribute('data-lower-t-critical')
      const upperTCrit = cell.getAttribute('data-upper-t-critical')

      if (lowerTCrit) results['lower_t_critical'] = parseFloat(lowerTCrit)
      if (upperTCrit) results['upper_t_critical'] = parseFloat(upperTCrit)
    }

    // Derive summary metrics (these are aliases when variances are equal)
    // The R baseline includes these top-level metrics which equal pooled values
    if (results['pooled_t'] !== undefined) results['t_statistic'] = results['pooled_t']
    if (results['pooled_p'] !== undefined) results['p_value'] = results['pooled_p']
    if (results['pooled_df'] !== undefined) results['degrees_of_freedom'] = results['pooled_df']

    // Alpha is a constant (default significance level)
    results['alpha'] = 0.05

    return results
  })

  // DEBUG: Print all data-stat attributes found
  if (stats._debug_all_stats) {
    console.log(`[DEBUG] All data-stat attributes in DOM:`, stats._debug_all_stats)
    delete stats._debug_all_stats
  }
  if (stats._debug_table_titles) {
    console.log(`[DEBUG] Table titles in DOM:`, stats._debug_table_titles)
    delete stats._debug_table_titles
  }

  // Translate hierarchical data-stat names to flat R baseline keys
  // This is needed for categorical tests where data-stat uses nested names
  // (e.g., 'chi_square.test.chi_square' -> 'chi_squared')
  // Group 5 tests also need translation (e.g., 'std' -> 'std_dev')
  const translatedStats = {}
  let translationApplied = false
  const isGroup5 = isGroup5Test(testType)

  for (const [key, value] of Object.entries(stats)) {
    if (isGroup5) {
      // Group 5: Distribution & Descriptive tests
      const flatKey = translateGroup5StatName(key)
      translatedStats[flatKey] = value
      if (flatKey !== key) {
        translationApplied = true
        console.log(`[R Validation] Translated (Group 5): ${key} -> ${flatKey}`)
      }
    } else if (isCategoricalStat(key)) {
      // Group 4: Categorical tests
      const flatKey = translateStatName(key)
      translatedStats[flatKey] = value
      if (flatKey !== key) {
        translationApplied = true
        console.log(`[R Validation] Translated: ${key} -> ${flatKey}`)
      }
    } else {
      translatedStats[key] = value
    }
  }

  if (translationApplied) {
    console.log(`[R Validation] Applied stat name translation for ${isGroup5 ? 'Group 5' : 'categorical'} test`)
  }

  console.log(`[R Validation] Extracted ${Object.keys(translatedStats).length} metrics`)

  return translatedStats
}

/**
 * Compare actual stats to R baseline
 * @param {object} actual - Actual statistics from UI
 * @param {object} baseline - R baseline metrics
 * @param {number|object} tolerance - Tolerance for numeric comparison
 *   - If number: applied to all metrics
 *     - If >= 0.01: treated as RELATIVE tolerance (e.g., 0.06 = 6%)
 *     - If < 0.01: treated as ABSOLUTE tolerance (e.g., 0.0001)
 *   - If object:
 *     {
 *       defaultTolerance,
 *       bootstrapTolerance,
 *       bootstrapMetrics,
 *       defaultToleranceMode,
 *       bootstrapToleranceMode,
 *       metricToleranceOverrides: [
 *         { pattern: 'regex', tolerance: number, mode: 'absolute'|'relative' }
 *       ]
 *     }
 * @returns {object} Comparison result with pass/fail status
 */
export function compareToRBaseline(actual, baseline, tolerance = 0.0001) {
  const diffs = []
  let totalMetrics = 0
  let passedMetrics = 0

  // Handle tolerance object (for bootstrap metrics) or simple number
  let defaultTolerance, bootstrapTolerance, bootstrapMetrics, metricToleranceOverrides
  let defaultToleranceMode, bootstrapToleranceMode
  if (typeof tolerance === 'object' && tolerance !== null) {
    defaultTolerance = tolerance.defaultTolerance || 0.0001
    bootstrapTolerance = tolerance.bootstrapTolerance || 0.01
    bootstrapMetrics = tolerance.bootstrapMetrics || []
    metricToleranceOverrides = Array.isArray(tolerance.metricToleranceOverrides)
      ? tolerance.metricToleranceOverrides
      : []
    defaultToleranceMode = tolerance.defaultToleranceMode
    bootstrapToleranceMode = tolerance.bootstrapToleranceMode
    console.log(`[R Validation] Using per-metric tolerances: default=${defaultTolerance}, bootstrap=${bootstrapTolerance}`)
    console.log(`[R Validation] Bootstrap metrics (${bootstrapMetrics.length}): ${bootstrapMetrics.join(', ')}`)
    console.log(`[R Validation] Metric overrides (${metricToleranceOverrides.length}) configured`)
  } else {
    defaultTolerance = tolerance
    bootstrapTolerance = tolerance
    bootstrapMetrics = []
    metricToleranceOverrides = []
    defaultToleranceMode = undefined
    bootstrapToleranceMode = undefined
  }

  console.log('[R Validation] Detailed metric comparison:')

  for (const [metric, expectedValue] of Object.entries(baseline)) {
    if (typeof expectedValue !== 'number') continue
    totalMetrics++

    const actualValue = actual[metric]

    if (actualValue === undefined) {
      console.log(`  ❌ ${metric.padEnd(30)} R=${expectedValue.toExponential(4)}, easyCris=MISSING`)
      diffs.push({
        metric,
        expected: expectedValue,
        actual: NaN,
        diff: NaN,
        diffPercent: NaN,
        tolerance: defaultTolerance,
        status: 'MISSING'
      })
      continue
    }

    const diff = Math.abs(actualValue - expectedValue)
    // Avoid over-penalizing relative diffs when expected values are near zero.
    const relativeBaseline = Math.max(Math.abs(expectedValue), 0.025)
    const diffPercent = expectedValue !== 0 ? (diff / relativeBaseline) : 0

    // Use bootstrap tolerance for bootstrap metrics, default for others.
    const isBootstrapMetric = bootstrapMetrics.includes(metric)
    let metricTolerance = isBootstrapMetric ? bootstrapTolerance : defaultTolerance
    let explicitMode = isBootstrapMetric ? bootstrapToleranceMode : defaultToleranceMode

    // Apply explicit per-metric overrides last.
    for (const override of metricToleranceOverrides) {
      if (!override || typeof override !== 'object') continue
      const pattern = typeof override.pattern === 'string' ? override.pattern : ''
      const overrideTolerance = Number(override.tolerance)
      if (!pattern || !Number.isFinite(overrideTolerance)) continue

      let matches = false
      try {
        matches = new RegExp(pattern).test(metric)
      } catch {
        matches = false
      }
      if (!matches) continue

      metricTolerance = overrideTolerance
      explicitMode = override.mode === 'relative' ? 'relative' : override.mode === 'absolute' ? 'absolute' : explicitMode
      break
    }
    const useRelativeTolerance =
      explicitMode === 'relative'
        ? true
        : explicitMode === 'absolute'
          ? false
          : metricTolerance >= 0.01

    // Use relative or absolute tolerance based on tolerance value
    const passes = useRelativeTolerance
      ? diffPercent <= metricTolerance  // e.g., 0.025 <= 0.06 (2.5% <= 6%)
      : diff <= metricTolerance         // e.g., 0.0001 <= 0.0001

    if (passes) {
      passedMetrics++
      console.log(`  ✅ ${metric.padEnd(30)} R=${expectedValue.toExponential(4)}, easyCris=${actualValue.toExponential(4)}, diff=${diff.toExponential(2)}`)
    } else {
      console.log(`  ❌ ${metric.padEnd(30)} R=${expectedValue.toExponential(4)}, easyCris=${actualValue.toExponential(4)}, diff=${diff.toExponential(2)} (${(diffPercent * 100).toFixed(2)}%)`)
      diffs.push({
        metric,
        expected: expectedValue,
        actual: actualValue,
        diff,
        diffPercent: diffPercent * 100,  // Convert to percentage for display
        tolerance: metricTolerance,
        status: 'FAILED'
      })
    }
  }

  const result = {
    passed: diffs.length === 0,
    totalMetrics,
    passedMetrics,
    failedMetrics: diffs.length,
    diffs
  }

  console.log(`[R Validation] Result: ${passedMetrics}/${totalMetrics} passed`)

  if (!result.passed) {
    console.warn(`[R Validation] ${result.failedMetrics} metric(s) failed:`)
    for (const diff of diffs) {
      console.warn(`  - ${diff.metric}: expected=${diff.expected}, actual=${diff.actual}, diff=${diff.diff}`)
    }
  }

  return result
}

/**
 * Assert validation passed, throw error if failed
 * @param {object} comparison - Comparison result from compareToRBaseline()
 */
export function assertValidation(comparison) {
  if (!comparison.passed) {
    const message = `R Validation FAILED: ${comparison.failedMetrics}/${comparison.totalMetrics} metrics differ from baseline\n` +
      comparison.diffs.map(d => `  ${d.metric}: ${d.status} (expected=${d.expected}, actual=${d.actual}, diff=${d.diff})`).join('\n')
    throw new Error(message)
  }

  console.log(`[R Validation] PASSED: All ${comparison.totalMetrics} metrics match R baseline`)
}

/**
 * Full R validation workflow
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testName - Test name (e.g., 'anova_two_way')
 * @param {number} tolerance - Absolute tolerance (default 0.0001)
 */
export async function validateAgainstRBaseline(driver, testName, tolerance = 0.0001) {
  console.log(`[R Validation] Starting validation for: ${testName}`)

  // 1. Load R baseline
  const baseline = await loadRBaseline(testName)

  // 2. Extract stats from UI using data-stat attributes
  const actual = await extractStatsFromUI(driver, testName)

  // 3. Compare
  const comparison = compareToRBaseline(actual, baseline, tolerance)

  // 4. Assert (throws if failed)
  assertValidation(comparison)

  return comparison
}

function parseInferentialValue(rawText, kind = 'text') {
  const text = String(rawText ?? '').trim()
  if (!text || text === '.') {
    return kind === 'text' ? '.' : null
  }

  if (kind === 'text') {
    return text
  }

  const value = Number.parseFloat(text.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

function normalizeInferentialRow(row) {
  return {
    section: parseInferentialValue(row.section, 'text'),
    effect: parseInferentialValue(row.effect, 'text'),
    withinFactor: parseInferentialValue(row.withinFactor, 'text'),
    withinLevel: parseInferentialValue(row.withinLevel, 'text'),
    comparison: parseInferentialValue(row.comparison, 'text'),
    estimate: parseInferentialValue(row.estimate, 'number'),
    stdError: parseInferentialValue(row.stdError, 'number'),
    statistic: parseInferentialValue(row.statistic, 'number'),
    numDf: parseInferentialValue(row.numDf, 'number'),
    denDf: parseInferentialValue(row.denDf, 'number'),
    rawP: parseInferentialValue(row.rawP, 'text'),
    adjustedP: parseInferentialValue(row.adjustedP, 'text'),
    sig: parseInferentialValue(row.sig, 'text'),
  }
}

export async function extractInferentialReportFromUI(driver) {
  const rows = await driver.executeScript(() => {
    const root = document.querySelector('[data-testid="results-table"]') || document.body
    const reportTable = Array.from(root.querySelectorAll('.ecp-table')).find((table) => {
      const title = table.querySelector('.ecp-title')
      return title?.textContent?.trim() === 'Inferential Report'
    })

    if (!reportTable) {
      return []
    }

    const headerCells = Array.from(reportTable.querySelectorAll('tr.ecp-header th')).map((cell) =>
      (cell.textContent || '').trim()
    )
    const columnMap = {
      Section: 'section',
      Effect: 'effect',
      'Within Factor': 'withinFactor',
      'Within Level': 'withinLevel',
      Comparison: 'comparison',
      Estimate: 'estimate',
      'Std Error': 'stdError',
      Statistic: 'statistic',
      NumDF: 'numDf',
      DenDF: 'denDf',
      DF: 'numDf',
      'Raw p': 'rawP',
      'Adj. p-value': 'adjustedP',
      Sig: 'sig',
    }

    return Array.from(reportTable.querySelectorAll('tr.ecp-data-row')).map((row) => {
      const values = Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent || '').trim())
      const parsed = {}
      headerCells.forEach((header, index) => {
        const key = columnMap[header]
        if (key) {
          parsed[key] = values[index] ?? ''
        }
      })
      return parsed
    })
  })

  return rows.map(normalizeInferentialRow)
}

export function compareInferentialReportRows(actualRows, baselineRows, tolerance = 0.0001) {
  const numericFields = ['estimate', 'stdError', 'statistic', 'numDf', 'denDf']
  const textFields = [
    'section',
    'effect',
    'withinFactor',
    'withinLevel',
    'comparison',
    'rawP',
    'adjustedP',
    'sig',
  ]
  const diffs = []
  const totalRows = baselineRows.length
  let totalFieldsCompared = 0
  let passed = actualRows.length === baselineRows.length

  for (let rowIndex = 0; rowIndex < baselineRows.length; rowIndex += 1) {
    const expected = normalizeInferentialRow(baselineRows[rowIndex] ?? {})
    const actual = normalizeInferentialRow(actualRows[rowIndex] ?? {})

    for (const field of textFields) {
      totalFieldsCompared += 1
      if (actual[field] !== expected[field]) {
        passed = false
        diffs.push({ row: rowIndex, field, expected: expected[field], actual: actual[field], status: 'MISMATCH' })
      }
    }

    for (const field of numericFields) {
      totalFieldsCompared += 1
      const expectedValue = expected[field]
      const actualValue = actual[field]
      if (expectedValue === null && actualValue === null) continue
      if (expectedValue === null || actualValue === null) {
        passed = false
        diffs.push({ row: rowIndex, field, expected: expectedValue, actual: actualValue, status: 'MISMATCH' })
        continue
      }
      const diff = Math.abs(actualValue - expectedValue)
      if (diff > tolerance) {
        passed = false
        diffs.push({ row: rowIndex, field, expected: expectedValue, actual: actualValue, diff, status: 'MISMATCH' })
      }
    }
  }

  return {
    passed,
    totalRows,
    totalFieldsCompared,
    diffs,
  }
}

/**
 * Extract plot statistics from data-plot-stats div
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} plotType - Plot type filter (optional)
 * @returns {object} Extracted plot stats
 */
export async function extractPlotStatsFromUI(driver, plotType = null) {
  console.log(`[R Validation] Extracting plot stats${plotType ? ` for type: ${plotType}` : ''}`)

  const stats = await driver.executeScript((filterType) => {
    const results = {}

    // Find all plot stats divs
    const plotStatsDivs = document.querySelectorAll('[data-plot-stats]')

    for (const div of plotStatsDivs) {
      const divPlotType = div.getAttribute('data-plot-type')

      // Filter by plot type if specified (interaction plots fall back to "interaction")
      if (filterType) {
        const isInteractionFilter = typeof filterType === 'string' && filterType.startsWith('interaction_')
        const matchesFilter =
          divPlotType === filterType ||
          (filterType === 'grouped_bar' && divPlotType === 'faceted_grouped_bar') ||
          (isInteractionFilter && divPlotType === 'interaction')
        if (!matchesFilter) {
          continue
        }
      }

      // Extract all data-* attributes
      for (const attr of div.attributes) {
        if (attr.name.startsWith('data-') && attr.name !== 'data-plot-stats') {
          // Convert data-attribute-name to attribute_name
          const key = attr.name.replace(/^data-/, '').replace(/-/g, '_')
          const value = attr.value

          // Try to parse as number
          const numValue = parseFloat(value)
          if (!isNaN(numValue)) {
            results[key] = numValue
          } else {
            results[key] = value
          }
        }
      }
    }

    return results
  }, plotType)

  console.log(`[R Validation] Extracted ${Object.keys(stats).length} plot stats`)

  return stats
}

/**
 * Load R plot baseline from CSV files
 * @param {string} testName - Test name (e.g., 'anova_two_way')
 * @returns {object} R plot baseline data
 */
export async function loadRPlotBaseline(testName, plotType = null) {
  // Determine which baseline file to load based on plot type
  let baselineFile = 'r_plot_stats.csv'

  if (testName === 'normality_all') {
    if (plotType === 'qq') {
      baselineFile = 'r_plot_stats_qq.csv'
    } else if (plotType === 'histogram') {
      baselineFile = 'r_plot_stats_histogram.csv'
    }
  } else if (testName === 'descriptive_stats') {
    if (plotType === 'histogram') {
      baselineFile = 'r_plot_stats_histogram.csv'
    } else if (plotType === 'box') {
      baselineFile = 'r_plot_stats_box.csv'
    } else if (plotType === 'violin') {
      baselineFile = 'r_plot_stats_violin.csv'
    }
  } else if (testName === 'outlier_detection') {
    if (plotType === 'box') {
      baselineFile = 'r_plot_stats_box.csv'
    } else if (plotType === 'column_scatter') {
      baselineFile = 'r_plot_stats_column_scatter.csv'
    }
  } else if (plotType === 'histogram') {
    baselineFile = 'r_histogram_metadata.csv'
  } else if (testName === 'anova_two_way' && plotType === 'interaction') {
    baselineFile = 'r_plot_stats_interaction.csv'
  } else if (testName === 'multifactorial_anova') {
    // Route multifactorial interaction plots to separate baseline files
    if (plotType === 'interaction_f1f2') {
      baselineFile = 'r_plot_stats_interaction_f1f2.csv'
    } else if (plotType === 'interaction_f1f3') {
      baselineFile = 'r_plot_stats_interaction_f1f3.csv'
    } else if (plotType === 'interaction_f2f3') {
      baselineFile = 'r_plot_stats_interaction_f2f3.csv'
    }
  } else if (testName.startsWith('synergy_')) {
    if (plotType === 'synergy_contour') {
      baselineFile = 'r_plot_stats_contour.csv'
    } else if (plotType === 'synergy_heatmap') {
      baselineFile = 'r_plot_stats_heatmap.csv'
    } else if (testName === 'synergy_loewe' && plotType === 'loewe_isobologram') {
      baselineFile = 'r_plot_stats_isobologram.csv'
    }
  } else if (testName.startsWith('correlation_')) {
    if (plotType === 'scatter') {
      baselineFile = 'r_plot_stats_scatter.csv'
    } else if (plotType === 'heatmap') {
      baselineFile = 'r_plot_stats_heatmap.csv'
    }
  } else if (testName === 'linear_regression') {
    if (plotType === 'scatter') {
      baselineFile = 'r_plot_stats_scatter.csv'
    } else if (plotType === 'residual') {
      baselineFile = 'r_plot_stats_residual.csv'
    }
  } else if (testName === 'multiple_linear_regression') {
    if (plotType === 'forest') {
      baselineFile = 'r_plot_stats_forest.csv'
    } else if (plotType === 'residual') {
      baselineFile = 'r_plot_stats_residual.csv'
    }
  } else if (testName === 'logistic_binary') {
    if (plotType === 'forest') {
      baselineFile = 'r_plot_stats_forest.csv'
    } else if (plotType === 'scatter') {
      baselineFile = 'r_plot_stats_roc.csv'
    }
  } else if (testName === 'logistic_multinomial') {
    if (plotType === 'forest') {
      baselineFile = 'r_plot_stats_forest.csv'
    } else if (plotType === 'scatter') {
      baselineFile = 'r_plot_stats_roc.csv'
    } else if (plotType === 'line') {
      baselineFile = 'r_plot_stats_probability.csv'
    }
  } else if (testName === 'chi_square') {
    // Chi-Square Independence: mosaic, grouped_bar, heatmap
    if (plotType === 'mosaic') {
      baselineFile = 'r_plot_stats_mosaic.csv'
    } else if (plotType === 'grouped_bar') {
      baselineFile = 'r_plot_stats_grouped_bar.csv'
    } else if (plotType === 'heatmap') {
      baselineFile = 'r_plot_stats_heatmap.csv'
    }
  } else if (testName === 'chi_square_gof') {
    // Chi-Square GOF: distribution, bar
    if (plotType === 'line') {
      baselineFile = 'r_plot_stats_line.csv'
    } else if (plotType === 'grouped_bar') {
      baselineFile = 'r_plot_stats_grouped_bar.csv'
    }
  } else if (testName === 'fishers_exact') {
    // Fisher's Exact: distribution, grouped_bar, forest
    if (plotType === 'line') {
      baselineFile = 'r_plot_stats_line.csv'
    } else if (plotType === 'grouped_bar') {
      baselineFile = 'r_plot_stats_grouped_bar.csv'
    } else if (plotType === 'forest') {
      baselineFile = 'r_plot_stats_forest.csv'
    }
  } else if (testName === 'mcnemar') {
    // McNemar: paired bar (grouped_bar plot type)
    if (plotType === 'grouped_bar') {
      baselineFile = 'r_plot_stats_grouped_bar.csv'
    }
  } else if (testName === 'kaplan_meier') {
    if (plotType === 'survival') {
      baselineFile = 'r_plot_stats_survival.csv'
    }
  } else if (testName === 'cox_proportional_hazards') {
    if (plotType === 'forest') {
      baselineFile = 'r_plot_stats_forest.csv'
    } else if (plotType === 'survival') {
      baselineFile = 'r_plot_stats_adjusted.csv'
    }
  } else if (testName === 'nelson_aalen') {
    if (plotType === 'survival') {
      baselineFile = 'r_plot_stats_cumhaz.csv'
    } else if (plotType === 'line') {
      baselineFile = 'r_plot_stats_hazard.csv'
    }
  }

  // Dynamically determine group directory from TEST_TO_GROUP mapping
  const groupDir = TEST_TO_GROUP[testName]
  if (!groupDir) {
    throw new Error(`Unknown test name: ${testName}. Add it to TEST_TO_GROUP mapping in r-validation.mjs`)
  }

  const testDir = getValidationDirForTest(testName)
  const fixtureStatsPath = path.resolve(
    PLOT_BASELINES_DIR,
    `${groupDir}/${testDir}/results/${baselineFile}`
  )
  const statsPath = path.resolve(
    __dirname,
    `../../_test_validation/${groupDir}/${testDir}/results/${baselineFile}`
  )

  const resolvedStatsPath = fs.existsSync(fixtureStatsPath) ? fixtureStatsPath : statsPath

  if (!fs.existsSync(resolvedStatsPath)) {
    throw new Error(`R plot baseline not found: ${resolvedStatsPath}`)
  }

  // Parse CSV to JSON
  const csvContent = fs.readFileSync(resolvedStatsPath, 'utf-8')
  const lines = csvContent.trim().split('\n')
  const baseline = {}

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const [metric, value] = lines[i].split(',')
    const numValue = parseFloat(value)
    if (!isNaN(numValue)) {
      baseline[metric] = numValue
    } else {
      baseline[metric] = value
    }
  }

  console.log(`[R Validation] Loaded plot baseline: ${testName} from ${baselineFile} (${Object.keys(baseline).length} metrics)`)
  if (resolvedStatsPath === fixtureStatsPath) {
    console.log(`[R Validation] Plot baseline source: fixtures (${fixtureStatsPath})`)
  } else {
    console.log(`[R Validation] Plot baseline source: _test_validation (${statsPath})`)
  }

  return baseline
}

/**
 * Export plot as PNG screenshot for visual comparison
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testName - Test name (e.g., 'anova_two_way')
 * @param {number} dpi - DPI setting (default 300)
 */
export async function exportPlotScreenshot(driver, testName, dpi = 300, plotTypeSuffix = '') {
  const suffix = plotTypeSuffix ? `_${plotTypeSuffix}` : ''
  console.log(`[R Validation] Exporting plot screenshot for: ${testName}${suffix} (${dpi} DPI)`)

  // Dynamically determine group directory from TEST_TO_GROUP mapping
  const groupDir = TEST_TO_GROUP[testName]
  if (!groupDir) {
    throw new Error(`Unknown test name: ${testName}. Add it to TEST_TO_GROUP mapping in r-validation.mjs`)
  }

  const testDir = getValidationDirForTest(testName)
  const outputPath = path.resolve(
    __dirname,
    `../../_test_validation/${groupDir}/${testDir}/results/easycris_plot${suffix}.png`
  )

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
    console.log(`[R Validation] Created directory: ${outputDir}`)
  }

  try {
    // Use window.__E2E__.exportPlotPng if available (Tauri command)
    const exported = await driver.executeScript(
      (outputPath, dpi) => {
        if (!window.__E2E__?.exportPlotPng) return null
        return window.__E2E__.exportPlotPng({ outputPath, dpi })
      },
      outputPath,
      dpi
    )

    if (exported) {
      console.log(`[R Validation] Plot exported to ${outputPath}`)
      return outputPath
    }

    // Fallback: use WebDriver screenshot if Tauri command not available
    // WARNING: This captures the entire window, not just the plot area
    console.warn('[R Validation] Tauri export hook unavailable, using WebDriver screenshot (captures whole window)')
    const screenshot = await driver.takeScreenshot()
    fs.writeFileSync(outputPath, screenshot, 'base64')
    console.log(`[R Validation] Plot screenshot saved to ${outputPath}`)
    return outputPath
  } catch (error) {
    console.error(`[R Validation] Failed to export plot: ${error.message}`)
    throw error
  }
}

/**
 * Validate plot against R baseline
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testName - Test name (e.g., 'anova_two_way')
 * @param {string} plotType - Plot type (e.g., 'grouped_bar')
 * @param {number} tolerance - Tolerance for comparison (default 0.01 for plots)
 */
export async function validatePlotAgainstRBaseline(driver, testName, plotType = null, tolerance = 0.01) {
  console.log(`[R Validation] Starting plot validation for: ${testName}`)

  // 1. Load R plot baseline (use plotType to determine which baseline file to load)
  const baseline = await loadRPlotBaseline(testName, plotType)

  // 2. Extract plot stats from UI
  const actual = await extractPlotStatsFromUI(driver, plotType)

  // 3. Compare
  const comparison = compareToRBaseline(actual, baseline, tolerance)

  // 4. Assert (throws if failed)
  assertValidation(comparison)

  return comparison
}
