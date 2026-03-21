/**
 * R Baseline Validation: Scheirer-Ray-Hare Test
 * Validates 44 metrics (statistical + grouped_bar plots) against R baseline
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
import { runScheirerRayHareTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Scheirer-Ray-Hare Test R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'scheirer_ray_hare')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Scheirer-Ray-Hare Test via UI...')
    await runScheirerRayHareTest(driver, {
      valueColumn: 'value',
      factor1Column: 'factor1',
      factor2Column: 'factor2'
    })

    // Wait for results to appear (data-stat nodes render in plot)
    await waitForResults(driver)

    // Validate statistical metrics against R baseline (before switching tabs)
    logStep('Validating statistical metrics...')
    const comparison = await validateAgainstRBaseline(driver, 'scheirer_ray_hare', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // Switch to Plots tab for plot validation
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Plot should be auto-selected (only 1 plot in gallery)
    // Wait a moment for plot to render
    await driver.sleep(500)

    // Export plot screenshot for visual comparison with R
    logStep('Exporting plot screenshot...')
    await exportPlotScreenshot(driver, 'scheirer_ray_hare', 300)

    // Validate plot metrics against R baseline (uses data-plot-stats attributes)
    logStep('Validating plot metrics...')
    const plotComparison = await validatePlotAgainstRBaseline(driver, 'scheirer_ray_hare', 'grouped_bar', 0.01)
    logSuccess(`All ${plotComparison.totalMetrics} plot metrics validated`)

    logSuccess(`COMPLETE: ${comparison.totalMetrics} statistical + ${plotComparison.totalMetrics} plot metrics validated`)

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
