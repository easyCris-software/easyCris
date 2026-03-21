/**
 * R Baseline Validation: Kruskal-Wallis H Test
 * Validates 88 metrics (statistical + bar/box/violin plots) against R baseline
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runKruskalWallisTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotType } from '../../utils/plot-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Kruskal-Wallis H Test R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'kruskal_wallis')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Kruskal-Wallis H Test via UI...')
    await runKruskalWallisTest(driver, {
      valueColumn: 'value',
      groupColumn: 'group'
    })

    await waitForResults(driver)

    // Validate statistical metrics against R baseline
    logStep('Validating statistical metrics...')
    const comparison = await validateAgainstRBaseline(driver, 'kruskal_wallis', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // Switch to Plots tab to validate bar/box/violin plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Export and validate Bar plot
    logStep('Selecting Bar plot type...')
    await selectPlotType(driver, 'bar')
    logStep('Exporting Bar plot screenshot...')
    await exportPlotScreenshot(driver, 'kruskal_wallis', 300, 'bar')
    logStep('Validating bar plot metrics...')
    const barPlotComparison = await validatePlotAgainstRBaseline(driver, 'kruskal_wallis', 'bar', 0.01)
    logSuccess(`All ${barPlotComparison.totalMetrics} bar plot metrics validated`)

    // Export and validate Box plot
    logStep('Selecting Box plot type...')
    await selectPlotType(driver, 'box')
    logStep('Exporting Box plot screenshot...')
    await exportPlotScreenshot(driver, 'kruskal_wallis', 300, 'box')
    logStep('Validating box plot metrics...')
    const boxPlotComparison = await validatePlotAgainstRBaseline(driver, 'kruskal_wallis', 'box', 0.01)
    logSuccess(`All ${boxPlotComparison.totalMetrics} box plot metrics validated`)

    // Export and validate Violin plot
    logStep('Selecting Violin plot type...')
    await selectPlotType(driver, 'violin')
    logStep('Exporting Violin plot screenshot...')
    await exportPlotScreenshot(driver, 'kruskal_wallis', 300, 'violin')
    logStep('Validating violin plot metrics...')
    const violinPlotComparison = await validatePlotAgainstRBaseline(driver, 'kruskal_wallis', 'violin', 0.01)
    logSuccess(`All ${violinPlotComparison.totalMetrics} violin plot metrics validated`)

    logSuccess(`COMPLETE: ${comparison.totalMetrics} statistical + ${barPlotComparison.totalMetrics} bar + ${boxPlotComparison.totalMetrics} box + ${violinPlotComparison.totalMetrics} violin metrics validated`)

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
