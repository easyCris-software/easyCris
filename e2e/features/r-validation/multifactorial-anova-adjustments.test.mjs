/**
 * R Baseline Validation: Multifactorial ANOVA Adjustment Methods
 * Validates post-hoc adjustments against method-specific R baselines.
 */

import fs from 'fs'
import path from 'path'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { importFromValidation } from '../../utils/fixtures.mjs'
import { extractStatsFromUI, extractPlotStatsFromUI, compareToRBaseline, assertValidation, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runMultifactorialANOVA, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByType, selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

const ADJUSTMENT_METHODS = [
  { method: 'tukey' },
  { method: 'bonferroni' },
  { method: 'holm' },
  { method: 'holm-sidak' },
  { method: 'sidak' },
  { method: 'fdr_bh' },
  { method: 'dunnett', controlLevels: { factor1: 'A', factor2: 'X', factor3: 'Low' } },
]

const DEFAULT_TOLERANCE = 0.0001
const DUNNETT_ABSOLUTE_TOLERANCE = 0.02
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
  const plotFileName =
    plotType === 'interaction_f1f2'
      ? `r_plot_stats_interaction_f1f2_${method}.csv`
      : plotType === 'interaction_f1f3'
        ? `r_plot_stats_interaction_f1f3_${method}.csv`
        : plotType === 'interaction_f2f3'
          ? `r_plot_stats_interaction_f2f3_${method}.csv`
          : `r_plot_stats_${method}.csv`
  const baselinePath = path.join(
    process.cwd(),
    '_test_validation',
    'Group1_Hypothesis_Testing',
    testName,
    'results',
    'adjustments',
    plotFileName
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
    logStep(`Starting Multifactorial ANOVA adjustment validation (${method.toUpperCase()})...`)

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)

    await importFromValidation(driver, 'multifactorial_anova', { datasetFile: 'dataset_adjustment.csv' })

    await runMultifactorialANOVA(driver, {
      valueColumn: 'value',
      adjustmentMethod: method,
      controlLevels,
      simpleEffects: [
        { mainFactor: 'factor1', withinFactor: 'factor2' },
        { mainFactor: 'factor2', withinFactor: 'factor1' },
      ],
    })

    await waitForResults(driver)

    const baseline = loadMethodBaseline('multifactorial_anova', method)
    const actual = await extractStatsFromUI(driver, 'multifactorial_anova')
    const comparison = compareToRBaseline(actual, baseline, getTolerance(method))
    assertValidation(comparison)

    logSuccess(`✅ ${method.toUpperCase()} matched ${comparison.totalMetrics} metrics`)

    // Switch to Plots tab to validate faceted grouped bar + interaction plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    const plotTolerance = 0.01

    logStep('Selecting Faceted Grouped Bar plot...')
    try {
      await selectPlotFromGalleryByType(driver, 'faceted_grouped_bar')
    } catch (error) {
      logStep('Faceted grouped bar type not found, falling back to title match...')
      try {
        await selectPlotFromGalleryByTitle(driver, 'Cell Means')
      } catch (titleError) {
        await selectPlotFromGalleryByTitle(driver, 'Predicted Means')
      }
    }
    logStep('Exporting Faceted Grouped Bar plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova', 300, `${method}_faceted_grouped_bar`)
    logStep('Validating faceted grouped bar plot metrics...')
    const groupedBarComparison = await validatePlotAgainstMethodBaseline(
      driver,
      'multifactorial_anova',
      method,
      'grouped_bar',
      plotTolerance
    )
    logSuccess(`All ${groupedBarComparison.totalMetrics} faceted grouped bar metrics validated`)

    logStep('Selecting Interaction plot: factor1 × factor2...')
    await selectPlotFromGalleryByTitle(driver, 'factor1 × factor2')
    logStep('Exporting Interaction f1×f2 plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova', 300, `${method}_interaction_f1f2`)
    logStep('Validating interaction f1×f2 plot metrics...')
    const interactionF1F2Comparison = await validatePlotAgainstMethodBaseline(
      driver,
      'multifactorial_anova',
      method,
      'interaction_f1f2',
      plotTolerance
    )
    logSuccess(`All ${interactionF1F2Comparison.totalMetrics} interaction f1×f2 metrics validated`)

    logStep('Selecting Interaction plot: factor1 × factor3...')
    await selectPlotFromGalleryByTitle(driver, 'factor1 × factor3')
    logStep('Exporting Interaction f1×f3 plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova', 300, `${method}_interaction_f1f3`)
    logStep('Validating interaction f1×f3 plot metrics...')
    const interactionF1F3Comparison = await validatePlotAgainstMethodBaseline(
      driver,
      'multifactorial_anova',
      method,
      'interaction_f1f3',
      plotTolerance
    )
    logSuccess(`All ${interactionF1F3Comparison.totalMetrics} interaction f1×f3 metrics validated`)

    logStep('Selecting Interaction plot: factor2 × factor3...')
    await selectPlotFromGalleryByTitle(driver, 'factor2 × factor3')
    logStep('Exporting Interaction f2×f3 plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova', 300, `${method}_interaction_f2f3`)
    logStep('Validating interaction f2×f3 plot metrics...')
    const interactionF2F3Comparison = await validatePlotAgainstMethodBaseline(
      driver,
      'multifactorial_anova',
      method,
      'interaction_f2f3',
      plotTolerance
    )
    logSuccess(`All ${interactionF2F3Comparison.totalMetrics} interaction f2×f3 metrics validated`)
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
  logStep('Starting Multifactorial ANOVA adjustment method validation...')

  for (const entry of METHODS_TO_RUN) {
    await runSingleMethod(entry)
  }

  logSuccess('COMPLETE: Multifactorial ANOVA adjustment methods validated')
}

runTest().catch(err => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
