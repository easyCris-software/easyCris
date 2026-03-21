/**
 * R Baseline Validation: Multifactorial ANOVA (Unbalanced, LS Means)
 * Validates metrics against unbalanced R baseline and asserts LS Means rendering.
 */

import fs from 'fs'
import path from 'path'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { importFromValidation } from '../../utils/fixtures.mjs'
import { extractStatsFromUI, extractPlotStatsFromUI, compareToRBaseline, assertValidation, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runMultifactorialANOVA, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByType, selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

function loadBaseline() {
  const baselinePath = path.join(
    process.cwd(),
    'e2e',
    'fixtures',
    'baselines',
    'multifactorial_anova_unbalanced_r_baseline.json'
  )
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing baseline: ${baselinePath}`)
  }
  return JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
}

async function assertLsMeansTable(driver) {
  const found = await driver.executeScript(() => {
    const titles = Array.from(document.querySelectorAll('.ecp-title')).map(el =>
      (el.textContent || '').trim()
    )
    return titles.includes('LS Means (Estimated Marginal Means)')
  })
  if (!found) {
    throw new Error('LS Means table not found for unbalanced dataset')
  }
}

function loadPlotBaseline(testName, plotType) {
  const fileName =
    plotType === 'interaction_f1f2'
      ? 'r_plot_stats_interaction_f1f2.csv'
      : plotType === 'interaction_f1f3'
        ? 'r_plot_stats_interaction_f1f3.csv'
        : plotType === 'interaction_f2f3'
          ? 'r_plot_stats_interaction_f2f3.csv'
          : 'r_plot_stats.csv'
  const baselinePath = path.join(
    process.cwd(),
    '_test_validation',
    'Group1_Hypothesis_Testing',
    testName,
    'results_unbalanced',
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

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Multifactorial ANOVA unbalanced validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)

    await importFromValidation(driver, 'multifactorial_anova', { datasetFile: 'dataset_unbalanced.csv' })

    await runMultifactorialANOVA(driver, {
      valueColumn: 'value',
      simpleEffects: [
        { mainFactor: 'factor1', withinFactor: 'factor2' },
        { mainFactor: 'factor2', withinFactor: 'factor1' },
      ],
    })

    await waitForResults(driver)

    await assertLsMeansTable(driver)

    const baseline = loadBaseline()
    const actual = await extractStatsFromUI(driver, 'multifactorial_anova')
    const comparison = compareToRBaseline(actual, baseline, 0.0001)
    assertValidation(comparison)

    logSuccess(`Stats validated: ${comparison.totalMetrics} metrics (unbalanced)`)

    // Switch to Plots tab to validate faceted grouped bar + interaction plots (LS Means)
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
    await exportPlotScreenshot(driver, 'multifactorial_anova_unbalanced', 300, 'unbalanced_faceted_grouped_bar')
    logStep('Validating faceted grouped bar plot metrics...')
    const groupedBarBaseline = loadPlotBaseline('multifactorial_anova', 'grouped_bar')
    const groupedBarActual = await extractPlotStatsFromUI(driver, 'grouped_bar')
    const groupedBarComparison = compareToRBaseline(groupedBarActual, groupedBarBaseline, plotTolerance)
    assertValidation(groupedBarComparison)
    logSuccess(`Faceted grouped bar validated (${groupedBarComparison.totalMetrics} metrics)`)

    logStep('Selecting Interaction plot: factor1 × factor2...')
    await selectPlotFromGalleryByTitle(driver, 'factor1 × factor2')
    logStep('Exporting Interaction f1×f2 plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova_unbalanced', 300, 'unbalanced_interaction_f1f2')
    logStep('Validating interaction f1×f2 plot metrics...')
    const interactionF1F2Baseline = loadPlotBaseline('multifactorial_anova', 'interaction_f1f2')
    const interactionF1F2Actual = await extractPlotStatsFromUI(driver, 'interaction_f1f2')
    const interactionF1F2Comparison = compareToRBaseline(interactionF1F2Actual, interactionF1F2Baseline, plotTolerance)
    assertValidation(interactionF1F2Comparison)
    logSuccess(`Interaction f1×f2 validated (${interactionF1F2Comparison.totalMetrics} metrics)`)

    logStep('Selecting Interaction plot: factor1 × factor3...')
    await selectPlotFromGalleryByTitle(driver, 'factor1 × factor3')
    logStep('Exporting Interaction f1×f3 plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova_unbalanced', 300, 'unbalanced_interaction_f1f3')
    logStep('Validating interaction f1×f3 plot metrics...')
    const interactionF1F3Baseline = loadPlotBaseline('multifactorial_anova', 'interaction_f1f3')
    const interactionF1F3Actual = await extractPlotStatsFromUI(driver, 'interaction_f1f3')
    const interactionF1F3Comparison = compareToRBaseline(interactionF1F3Actual, interactionF1F3Baseline, plotTolerance)
    assertValidation(interactionF1F3Comparison)
    logSuccess(`Interaction f1×f3 validated (${interactionF1F3Comparison.totalMetrics} metrics)`)

    logStep('Selecting Interaction plot: factor2 × factor3...')
    await selectPlotFromGalleryByTitle(driver, 'factor2 × factor3')
    logStep('Exporting Interaction f2×f3 plot screenshot...')
    await exportPlotScreenshot(driver, 'multifactorial_anova_unbalanced', 300, 'unbalanced_interaction_f2f3')
    logStep('Validating interaction f2×f3 plot metrics...')
    const interactionF2F3Baseline = loadPlotBaseline('multifactorial_anova', 'interaction_f2f3')
    const interactionF2F3Actual = await extractPlotStatsFromUI(driver, 'interaction_f2f3')
    const interactionF2F3Comparison = compareToRBaseline(interactionF2F3Actual, interactionF2F3Baseline, plotTolerance)
    assertValidation(interactionF2F3Comparison)
    logSuccess(`Interaction f2×f3 validated (${interactionF2F3Comparison.totalMetrics} metrics)`)

    logSuccess(`COMPLETE: ${comparison.totalMetrics} stats metrics + plot validation (unbalanced)`)
  } catch (error) {
    console.error(`[Test] FAILED: ${error.message}`)
    throw error
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch(err => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
