/**
 * R Baseline Validation: Outlier Detection
 * Validates 12 metrics against R IQR, Z-score, MAD, grubbs.test()
 *
 * Validated Metrics (12):
 * - n
 * - q1, q3, iqr
 * - lower_fence, upper_fence
 * - iqr_outlier_count, z_outlier_count
 * - mad, mad_outlier_count
 * - grubbs_g, grubbs_p
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
    logStep('Starting Outlier Detection R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'outlier_detection')
    logStep(`Loaded fixture: outlier_detection with ${fixture.validatedMetrics} expected metrics`)

    // Run test via UI - uses single numeric column
    logStep('Running Outlier Detection via UI...')
    await runDistributionTest(driver, 'outlier_detection', 'value')

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (12 metrics)
    const comparison = await validateAgainstRBaseline(driver, 'outlier_detection', 0.0001)
    logSuccess(`PASS: All ${comparison.totalMetrics} metrics validated against R baseline`)

    // Switch to Plots tab and validate plots
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Wait for plot gallery (2 plots)
    await driver.wait(async () => {
      const plotCards = await driver.findElements(
        By.css('div[role="button"][aria-label^="Select plot:"]')
      )
      return plotCards.length >= 2
    }, 10000, 'Plot gallery did not render 2 plots')

    // Box plot
    logStep('Selecting box plot...')
    await selectPlotFromGalleryByTitle(driver, 'Box Plot (Outliers)')
    await exportPlotScreenshot(driver, 'outlier_detection', 300, 'box')
    const boxComparison = await validatePlotAgainstRBaseline(driver, 'outlier_detection', 'box', 0.01)
    logSuccess(`Box plot metrics validated (${boxComparison.totalMetrics} metrics)`)

    // Column scatter plot
    logStep('Selecting column scatter plot...')
    await selectPlotFromGalleryByTitle(driver, 'Outlier Scatter')
    await exportPlotScreenshot(driver, 'outlier_detection', 300, 'column_scatter')
    const scatterComparison = await validatePlotAgainstRBaseline(driver, 'outlier_detection', 'column_scatter', 0.01)
    logSuccess(`Column scatter metrics validated (${scatterComparison.totalMetrics} metrics)`)

    logSuccess(
      `COMPLETE: ${comparison.totalMetrics} stats + ${boxComparison.totalMetrics + scatterComparison.totalMetrics} plot metrics validated`
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
