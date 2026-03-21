/**
 * R Baseline Validation: Descriptive Statistics
 * Validates 16 metrics against R mean(), sd(), median(), quantile(), etc.
 *
 * Validated Metrics (16):
 * - n, mean, median
 * - std (R: std_dev), sem (R: std_error), variance
 * - min, max, range
 * - q1, q3, iqr
 * - skewness, kurtosis
 * - ci_lower (R: ci_95_lower), ci_upper (R: ci_95_upper)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runDistributionTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'
import { By } from 'selenium-webdriver'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Descriptive Statistics R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'descriptive_stats')
    logStep(`Loaded fixture: descriptive_stats with ${fixture.validatedMetrics} expected metrics`)

    // Run test via UI - uses single numeric column
    logStep('Running Descriptive Statistics via UI...')
    await runDistributionTest(driver, 'descriptive_stats', 'value')

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (16 metrics)
    const comparison = await validateAgainstRBaseline(driver, 'descriptive_stats', 0.0001)
    logSuccess(`PASS: All ${comparison.totalMetrics} metrics validated against R baseline`)

    // Switch to Plots tab and validate plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Wait for plot gallery (3 plots)
    await driver.wait(async () => {
      const plotCards = await driver.findElements(
        By.css('div[role="button"][aria-label^="Select plot:"]')
      )
      return plotCards.length >= 3
    }, 10000, 'Plot gallery did not render 3 plots')

    // Histogram plot
    logStep('Selecting histogram plot...')
    await selectPlotFromGalleryByTitle(driver, 'Histogram (Density)')
    await exportPlotScreenshot(driver, 'descriptive_stats', 300, 'histogram')
    const histComparison = await validatePlotAgainstRBaseline(driver, 'descriptive_stats', 'histogram', 0.01)
    logSuccess(`Histogram plot metrics validated (${histComparison.totalMetrics} metrics)`)

    // Box plot
    logStep('Selecting box plot...')
    await selectPlotFromGalleryByTitle(driver, 'Box Plot')
    await exportPlotScreenshot(driver, 'descriptive_stats', 300, 'box')
    const boxComparison = await validatePlotAgainstRBaseline(driver, 'descriptive_stats', 'box', 0.01)
    logSuccess(`Box plot metrics validated (${boxComparison.totalMetrics} metrics)`)

    // Violin plot
    logStep('Selecting violin plot...')
    await selectPlotFromGalleryByTitle(driver, 'Violin Plot')
    await exportPlotScreenshot(driver, 'descriptive_stats', 300, 'violin')
    const violinComparison = await validatePlotAgainstRBaseline(driver, 'descriptive_stats', 'violin', 0.01)
    logSuccess(`Violin plot metrics validated (${violinComparison.totalMetrics} metrics)`)

    logSuccess(
      `COMPLETE: ${comparison.totalMetrics} stats + ${histComparison.totalMetrics + boxComparison.totalMetrics + violinComparison.totalMetrics} plot metrics validated`
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
