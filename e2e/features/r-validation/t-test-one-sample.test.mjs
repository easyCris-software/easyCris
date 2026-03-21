/**
 * R Baseline Validation: One-Sample T-Test
 * Validates 49 metrics (statistical + column_scatter/histogram plots) against R baseline
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
import { runOneSampleTTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotType } from '../../utils/plot-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting One-Sample T-Test R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 't_test_one_sample')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running One-Sample T-Test via UI...')
    await runOneSampleTTest(driver, {
      valueColumn: 'value',
      testValue: 0
    })

    await waitForResults(driver)

    // Validate statistical metrics against R baseline
    logStep('Validating statistical metrics...')
    const comparison = await validateAgainstRBaseline(driver, 't_test_one_sample', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // Switch to Plots tab to validate column_scatter and histogram plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Export and validate Column Scatter plot
    logStep('Selecting Column Scatter plot type...')
    await selectPlotType(driver, 'column_scatter')
    logStep('Exporting Column Scatter plot screenshot...')
    await exportPlotScreenshot(driver, 't_test_one_sample', 300, 'column_scatter')
    logStep('Validating column scatter plot metrics...')
    const columnScatterComparison = await validatePlotAgainstRBaseline(driver, 't_test_one_sample', 'column_scatter', 0.01)
    logSuccess(`All ${columnScatterComparison.totalMetrics} column scatter plot metrics validated`)

    // Export and validate Histogram plot
    logStep('Selecting Histogram plot type...')
    await selectPlotType(driver, 'histogram')
    logStep('Exporting Histogram plot screenshot...')
    await exportPlotScreenshot(driver, 't_test_one_sample', 300, 'histogram')
    logStep('Validating histogram plot metrics...')
    const histogramComparison = await validatePlotAgainstRBaseline(driver, 't_test_one_sample', 'histogram', 0.10)
    logSuccess(`All ${histogramComparison.totalMetrics} histogram plot metrics validated`)

    logSuccess(`COMPLETE: ${comparison.totalMetrics} statistical + ${columnScatterComparison.totalMetrics} column scatter + ${histogramComparison.totalMetrics} histogram metrics validated`)

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
