/**
 * R Baseline Validation: One-Way ANOVA Adjustment Methods
 * Validates post-hoc adjustments against method-specific R baselines.
 */

import fs from 'fs'
import path from 'path'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { importFromValidation } from '../../utils/fixtures.mjs'
import { extractStatsFromUI, extractPlotStatsFromUI, compareToRBaseline, assertValidation, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runOneWayANOVA, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotType } from '../../utils/plot-workflow.mjs'

const ADJUSTMENT_METHODS = [
  { method: 'tukey' },
  { method: 'bonferroni' },
  { method: 'holm' },
  { method: 'holm-sidak' },
  { method: 'sidak' },
  { method: 'fdr_bh' },
  { method: 'dunnett', controlLevel: 'Control' },
]

const DEFAULT_TOLERANCE = 0.0001
// Keep just under 0.01 so compareToRBaseline uses absolute tolerance.
const DUNNETT_ABSOLUTE_TOLERANCE = 0.01 - 1e-12
const TOLERANCE_BY_METHOD = {
  dunnett: DUNNETT_ABSOLUTE_TOLERANCE,
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

function loadMethodPlotBaseline(testName, method) {
  const baselinePath = path.join(
    process.cwd(),
    '_test_validation',
    'Group1_Hypothesis_Testing',
    testName,
    'results',
    'adjustments',
    `r_plot_stats_${method}.csv`
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
  const baseline = loadMethodPlotBaseline(testName, method)
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

async function runSingleMethod({ method, controlLevel }) {
  let driver, webdriver

  try {
    logStep(`Starting One-Way ANOVA adjustment validation (${method.toUpperCase()})...`)

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)

    await importFromValidation(driver, 'anova_one_way', { datasetFile: 'dataset_adjustment.csv' })

    await runOneWayANOVA(driver, {
      valueColumn: 'value',
      groupColumn: 'group',
      adjustmentMethod: method,
      controlLevel,
    })

    await waitForResults(driver)

    const baseline = loadMethodBaseline('anova_one_way', method)
    const actual = await extractStatsFromUI(driver, 'anova_one_way')
    const comparison = compareToRBaseline(actual, baseline, getTolerance(method))
    assertValidation(comparison)

    logSuccess(`✅ ${method.toUpperCase()} matched ${comparison.totalMetrics} metrics`)

    // Switch to Plots tab to validate bar/box/violin plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    const plotTolerance = 0.01

    logStep('Selecting Bar plot type...')
    await selectPlotType(driver, 'bar')
    logStep('Exporting Bar plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_one_way', 300, `${method}_bar`)
    logStep('Validating bar plot metrics...')
    const barPlotComparison = await validatePlotAgainstMethodBaseline(driver, 'anova_one_way', method, 'bar', plotTolerance)
    logSuccess(`All ${barPlotComparison.totalMetrics} bar plot metrics validated`)

    logStep('Selecting Box plot type...')
    await selectPlotType(driver, 'box')
    logStep('Exporting Box plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_one_way', 300, `${method}_box`)
    logStep('Validating box plot metrics...')
    const boxPlotComparison = await validatePlotAgainstMethodBaseline(driver, 'anova_one_way', method, 'box', plotTolerance)
    logSuccess(`All ${boxPlotComparison.totalMetrics} box plot metrics validated`)

    logStep('Selecting Violin plot type...')
    await selectPlotType(driver, 'violin')
    logStep('Exporting Violin plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_one_way', 300, `${method}_violin`)
    logStep('Validating violin plot metrics...')
    const violinPlotComparison = await validatePlotAgainstMethodBaseline(driver, 'anova_one_way', method, 'violin', plotTolerance)
    logSuccess(`All ${violinPlotComparison.totalMetrics} violin plot metrics validated`)
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
  logStep('Starting One-Way ANOVA adjustment method validation...')

  for (const entry of METHODS_TO_RUN) {
    await runSingleMethod(entry)
  }

  logSuccess('COMPLETE: One-Way ANOVA adjustment methods validated')
}

runTest().catch(err => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
