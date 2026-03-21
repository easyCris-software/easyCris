/**
 * R Baseline Validation: Kaplan-Meier Survival Analysis
 * Validates Kaplan-Meier metrics against R baseline (survival package)
 *
 * Validated Metrics:
 * - Statistics: n_total, n_events, n_censored, median_*, logrank_*
 * - Plot (Survival Curve): n_curves, n_points, max_time, min_value, max_value
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runKaplanMeierTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'
import { By } from 'selenium-webdriver'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Kaplan-Meier Survival Analysis R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'kaplan_meier')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Kaplan-Meier Analysis via UI...')
    await runKaplanMeierTest(driver, {
      mapping: { time: 'time', event: 'event', group: 'group' }
    })

    await waitForResults(driver)

    // Validate statistics
    const comparison = await validateAgainstRBaseline(driver, 'kaplan_meier', 0.0001)
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

    // Kaplan-Meier Survival Curve
    logStep('Selecting Kaplan-Meier Survival Curve...')
    await selectPlotFromGalleryByTitle(driver, 'Kaplan-Meier Survival Curve')
    await exportPlotScreenshot(driver, 'kaplan_meier', 300, 'survival')
    const survivalComparison = await validatePlotAgainstRBaseline(driver, 'kaplan_meier', 'survival', 0.01)
    logSuccess(`Survival curve plot metrics validated (${survivalComparison.totalMetrics} metrics)`)

    logSuccess(
      `COMPLETE: ${comparison.totalMetrics} stats + ${survivalComparison.totalMetrics} plot metrics validated`
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
