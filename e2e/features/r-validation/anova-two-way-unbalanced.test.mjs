/**
 * R Baseline Validation: Two-Way ANOVA (Unbalanced, LS Means)
 * Validates metrics against unbalanced R baseline and asserts LS Means rendering.
 */

import fs from 'fs'
import path from 'path'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { importFromValidation } from '../../utils/fixtures.mjs'
import { extractStatsFromUI, extractPlotStatsFromUI, compareToRBaseline, assertValidation, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runTwoWayANOVA, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotType } from '../../utils/plot-workflow.mjs'

function loadBaseline() {
  const baselinePath = path.join(
    process.cwd(),
    'e2e',
    'fixtures',
    'baselines',
    'anova_two_way_unbalanced_r_baseline.json'
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
  const fileName = plotType === 'interaction' ? 'r_plot_stats_interaction.csv' : 'r_plot_stats.csv'
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
    logStep('Starting Two-Way ANOVA unbalanced validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)

    await importFromValidation(driver, 'anova_two_way', { datasetFile: 'dataset_unbalanced.csv' })

    await runTwoWayANOVA(driver, {
      valueColumn: 'value',
      factor1Column: 'factor1',
      factor2Column: 'factor2',
    })

    await waitForResults(driver)

    await assertLsMeansTable(driver)

    const baseline = loadBaseline()
    const actual = await extractStatsFromUI(driver, 'anova_two_way')
    const comparison = compareToRBaseline(actual, baseline, 0.0001)
    assertValidation(comparison)

    logSuccess(`Stats validated: ${comparison.totalMetrics} metrics (unbalanced)`)

    // Switch to Plots tab to validate grouped bar + interaction plots (LS Means)
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    const plotTolerance = 0.01

    logStep('Selecting Grouped Bar plot type...')
    await selectPlotType(driver, 'grouped_bar')
    logStep('Exporting Grouped Bar plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_two_way_unbalanced', 300, 'unbalanced_grouped_bar')
    logStep('Validating grouped bar plot metrics...')
    const groupedBarBaseline = loadPlotBaseline('anova_two_way', 'grouped_bar')
    const groupedBarActual = await extractPlotStatsFromUI(driver, 'grouped_bar')
    const groupedBarComparison = compareToRBaseline(groupedBarActual, groupedBarBaseline, plotTolerance)
    assertValidation(groupedBarComparison)
    logSuccess(`Grouped bar plot validated (${groupedBarComparison.totalMetrics} metrics)`)

    logStep('Selecting Interaction plot type...')
    await selectPlotType(driver, 'interaction')
    logStep('Exporting Interaction plot screenshot...')
    await exportPlotScreenshot(driver, 'anova_two_way_unbalanced', 300, 'unbalanced_interaction')
    logStep('Validating interaction plot metrics...')
    const interactionBaseline = loadPlotBaseline('anova_two_way', 'interaction')
    const interactionActual = await extractPlotStatsFromUI(driver, 'interaction')
    const interactionComparison = compareToRBaseline(interactionActual, interactionBaseline, plotTolerance)
    assertValidation(interactionComparison)
    logSuccess(`Interaction plot validated (${interactionComparison.totalMetrics} metrics)`)

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
