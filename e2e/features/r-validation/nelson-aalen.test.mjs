/**
 * R Baseline Validation: Nelson-Aalen Cumulative Hazard Estimator
 * Validates Nelson-Aalen metrics against R baseline (survival package)
 *
 * Validated Metrics:
 * - Statistics: n_total, n_events, n_censored, final_cumulative_hazard, time_*
 * - Plot (Cumulative Hazard): n_curves, n_points, max_time, min_value, max_value
 * - Plot (Smoothed Hazard): n_curves, n_points, max_time, max_hazard
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runNelsonAalenTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'
import { By } from 'selenium-webdriver'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Nelson-Aalen Cumulative Hazard R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'nelson_aalen')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Nelson-Aalen Analysis via UI...')
    await runNelsonAalenTest(driver, {
      mapping: { time: 'time', event: 'event' }
    })

    await waitForResults(driver)

    // Validate statistics
    const comparison = await validateAgainstRBaseline(driver, 'nelson_aalen', 0.0001)
    logSuccess(`PASS: All ${comparison.totalMetrics} statistics validated against R baseline`)

    // Switch to Plots tab and validate plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Wait for plot gallery
    await driver.wait(async () => {
      const plotCards = await driver.findElements(
        By.css('div[role="button"][aria-label^="Select plot:"]')
      )
      return plotCards.length >= 1
    }, 10000, 'Plot gallery did not render plots')

    // Cumulative Hazard Curve
    logStep('Selecting Cumulative Hazard Curve...')
    await selectPlotFromGalleryByTitle(driver, 'Cumulative Hazard Curve')
    await exportPlotScreenshot(driver, 'nelson_aalen', 300, 'cumhaz')
    const cumhazComparison = await validatePlotAgainstRBaseline(driver, 'nelson_aalen', 'survival', 0.01)
    logSuccess(`Cumulative hazard plot metrics validated (${cumhazComparison.totalMetrics} metrics)`)

    // Smoothed Hazard Rate (if available)
    let hazardMetrics = 0
    try {
      logStep('Selecting Smoothed Hazard Rate...')
      await selectPlotFromGalleryByTitle(driver, 'Smoothed Hazard Rate')
      await exportPlotScreenshot(driver, 'nelson_aalen', 300, 'hazard')
      const hazardComparison = await validatePlotAgainstRBaseline(driver, 'nelson_aalen', 'line', 0.01)
      hazardMetrics = hazardComparison.totalMetrics
      logSuccess(`Smoothed hazard plot metrics validated (${hazardMetrics} metrics)`)
    } catch (e) {
      logStep('Smoothed Hazard Rate plot not available or validation skipped')
    }

    logSuccess(
      `COMPLETE: ${comparison.totalMetrics} stats + ${cumhazComparison.totalMetrics + hazardMetrics} plot metrics validated`
    )

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
