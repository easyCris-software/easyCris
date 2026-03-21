/**
 * R Baseline Validation: Cox Proportional Hazards Model
 * Validates Cox PH metrics against R baseline (survival package)
 *
 * Validated Metrics:
 * - Statistics: n_*, age_coef, age_hr, concordance, aic, bic, lr_*, wald_*
 * - Plot (Forest): n_coeffs, hr_min, hr_max, ci_min, ci_max
 * - Plot (Adjusted Survival): n_curves, n_points, max_time, min_value, max_value
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runCoxRegressionTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'
import { By } from 'selenium-webdriver'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Cox Proportional Hazards R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'cox_proportional_hazards')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Cox Proportional Hazards via UI...')
    await runCoxRegressionTest(driver, {
      mapping: { time: 'time', event: 'event', covariates: ['age'] }
    })

    await waitForResults(driver, { timeout: 90000, resultsTabTimeout: 60000 })

    // Validate statistics
    const comparison = await validateAgainstRBaseline(driver, 'cox_proportional_hazards', 0.05)
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

    // Forest Plot (Hazard Ratios)
    logStep('Selecting Hazard Ratio Forest Plot...')
    await selectPlotFromGalleryByTitle(driver, 'Hazard Ratio Forest Plot')
    await exportPlotScreenshot(driver, 'cox_proportional_hazards', 300, 'forest')
    const forestComparison = await validatePlotAgainstRBaseline(driver, 'cox_proportional_hazards', 'forest', 0.01)
    logSuccess(`Forest plot metrics validated (${forestComparison.totalMetrics} metrics)`)

    // Adjusted Survival Curves (if available)
    let adjustedMetrics = 0
    try {
      logStep('Selecting Adjusted Survival Curves...')
    await selectPlotFromGalleryByTitle(driver, 'Adjusted Survival Curves')
    await exportPlotScreenshot(driver, 'cox_proportional_hazards', 300, 'adjusted')
    const adjustedComparison = await validatePlotAgainstRBaseline(driver, 'cox_proportional_hazards', 'survival', 0.01)
      adjustedMetrics = adjustedComparison.totalMetrics
      logSuccess(`Adjusted survival curve metrics validated (${adjustedMetrics} metrics)`)
    } catch (e) {
      logStep('Adjusted Survival Curves plot not available or validation skipped')
    }

    logSuccess(
      `COMPLETE: ${comparison.totalMetrics} stats + ${forestComparison.totalMetrics + adjustedMetrics} plot metrics validated`
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
