/**
 * R Baseline Validation: Two-Way ANOVA Adjustment Methods
 * Validates post-hoc adjustments against method-specific R baselines.
 */

import fs from 'fs'
import path from 'path'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { importFromValidation } from '../../utils/fixtures.mjs'
import { extractStatsFromUI, extractPlotStatsFromUI, compareToRBaseline, assertValidation, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runTwoWayANOVA, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotType } from '../../utils/plot-workflow.mjs'

const ADJUSTMENT_METHODS = [
  { method: 'tukey' },
  { method: 'bonferroni' },
  { method: 'holm' },
  { method: 'holm-sidak' },
  { method: 'sidak' },
  { method: 'fdr_bh' },
  { method: 'dunnett', controlLevels: { factor1: 'A', factor2: 'X' } },
]

const DEFAULT_TOLERANCE = 0.0001
// SciPy and emmeans differ slightly on Dunnett mvt CI integration; allow a small absolute margin.
const DUNNETT_ABSOLUTE_TOLERANCE = 0.02 - 1e-12
const TOLERANCE_BY_METHOD = {
  dunnett: {
    defaultTolerance: DUNNETT_ABSOLUTE_TOLERANCE,
    defaultToleranceMode: 'absolute',
  },
}

function getTolerance(method) {
  return TOLERANCE_BY_METHOD[method] ?? DEFAULT_TOLERANCE
}

function loadMethodBaseline(testName, method) {
  const baselinePath = path.join(
    process.cwd(),
    'e2e',
    'fixtures',
    'baselines',
    'adjustments',
    testName,
    method,
    'r_baseline.json'
  )
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing baseline: ${baselinePath}`)
  }
  return JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
}

function loadMethodPlotBaseline(testName, method, plotType) {
  const fileName = plotType === 'interaction'
    ? `r_plot_stats_interaction_${method}.csv`
    : `r_plot_stats_${method}.csv`
  const baselinePath = path.join(
    process.cwd(),
    '_test_validation',
    'Group1_Hypothesis_Testing',
    testName,
    'results',
    'adjustments',
    fileName
  )
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing plot baseline: ${baselinePath}`)
  }

  const csvContent = fs.readFileSync(baselinePath, 'utf-8')
  const lines = csvContent.trim().split('\n')
  const baseline = {}
  for (let i = 1; i < lines.length; i++) {
    const [metric, value] = lines[i].split(',')
    const numValue = parseFloat(value)
    baseline[metric] = Number.isNaN(numValue) ? value : numValue
  }
  return baseline
}

async function validatePlotAgainstMethodBaseline(driver, testName, method, plotType, tolerance) {
  const baseline = loadMethodPlotBaseline(testName, method, plotType)
  const actual = await extractPlotStatsFromUI(driver, plotType)
  const comparison = compareToRBaseline(actual, baseline, tolerance)
  assertValidation(comparison)
  return comparison
}

const TARGET_METHOD = process.env.E2E_ADJUSTMENT_METHOD?.toLowerCase()
const METHODS_TO_RUN = TARGET_METHOD
  ? ADJUSTMENT_METHODS.filter(entry => entry.method === TARGET_METHOD)
  : ADJUSTMENT_METHODS

if (TARGET_METHOD && METHODS_TO_RUN.length === 0) {
  throw new Error(`Unknown adjustment method: ${TARGET_METHOD}`)
}

async function runSingleMethod({ method, controlLevels }) {
  let driver, webdriver

  try {
    logStep(`Starting Two-Way ANOVA adjustment validation (${method.toUpperCase()})...`)

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)

    await importFromValidation(driver, 'anova_two_way', { datasetFile: 'dataset_adjustment.csv' })

    await runTwoWayANOVA(driver, {
      valueColumn: 'value',
      factor1Column: 'factor1',
      factor2Column: 'factor2',
      adjustmentMethod: method,
      controlLevels,
    })

    await waitForResults(driver)

    const baseline = loadMethodBaseline('anova_two_way', method)
    const actual = await extractStatsFromUI(driver, 'anova_two_way')
    const comparison = compareToRBaseline(actual, baseline, getTolerance(method))
    assertValidation(comparison)

    logSuccess(`✅ ${method.toUpperCase()} matched ${comparison.totalMetrics} metrics`)

    // Switch to Plots tab to validate grouped bar + interaction plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    const plotTolerance = 0.01

    logStep('Selecting Grouped Bar plot type...')
    await selectPlotType(driver, 'grouped_bar')
    logStep('Exporting Grouped Bar plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_two_way', 300, `${method}_grouped_bar`)
    logStep('Validating grouped bar plot metrics...')
    const groupedBarComparison = await validatePlotAgainstMethodBaseline(driver, 'anova_two_way', method, 'grouped_bar', plotTolerance)
    logSuccess(`All ${groupedBarComparison.totalMetrics} grouped bar plot metrics validated`)

    logStep('Selecting Interaction plot type...')
    await selectPlotType(driver, 'interaction')
    logStep('Exporting Interaction plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_two_way', 300, `${method}_interaction`)
    logStep('Validating interaction plot metrics...')
    const interactionComparison = await validatePlotAgainstMethodBaseline(driver, 'anova_two_way', method, 'interaction', plotTolerance)
    logSuccess(`All ${interactionComparison.totalMetrics} interaction plot metrics validated`)
  } catch (error) {
    console.error(`[Test] FAILED: ${error.message}`)
    throw error
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

async function runTest() {
  logStep('Starting Two-Way ANOVA adjustment method validation...')

  for (const entry of METHODS_TO_RUN) {
    await runSingleMethod(entry)
  }

  logSuccess('COMPLETE: Two-Way ANOVA adjustment methods validated')
}

runTest().catch(err => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
