/**
 * R Baseline Validation: Normality (All 5 Tests)
 * Validates 11 metrics against R shapiro.test(), ks.test(), AndersonDarlingTest(),
 * CramerVonMisesTest(), jarque.test()
 *
 * Validated Metrics (11):
 * - n
 * - shapiro_w, shapiro_p (Shapiro-Wilk)
 * - ks_d, ks_p (Kolmogorov-Smirnov)
 * - ad_a, ad_p (Anderson-Darling)
 * - cvm_w, cvm_p (Cramer-von Mises)
 * - jb_stat, jb_p (Jarque-Bera)
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
    logStep('Starting Normality (All Tests) R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'normality_all')
    logStep(`Loaded fixture: normality_all with ${fixture.validatedMetrics} expected metrics`)

    // Run test via UI - uses single numeric column
    logStep('Running Normality (All Tests) via UI...')
    await runDistributionTest(driver, 'normality_all', 'value')

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (11 metrics - all 5 normality tests)
    // Note: ks_p/cvm_p have ~1% precision variance between R nortest and Python scipy
    const comparison = await validateAgainstRBaseline(driver, 'normality_all', 0.01)
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

    // Q-Q plot
    logStep('Selecting Q-Q plot...')
    await selectPlotFromGalleryByTitle(driver, 'Q-Q Plot')
    await exportPlotScreenshot(driver, 'normality_all', 300, 'qq')
    const qqComparison = await validatePlotAgainstRBaseline(driver, 'normality_all', 'qq', 0.01)
    logSuccess(`Q-Q plot metrics validated (${qqComparison.totalMetrics} metrics)`)

    // Histogram plot
    logStep('Selecting histogram plot...')
    await selectPlotFromGalleryByTitle(driver, 'Histogram (Density)')
    await exportPlotScreenshot(driver, 'normality_all', 300, 'histogram')
    const histComparison = await validatePlotAgainstRBaseline(driver, 'normality_all', 'histogram', 0.01)
    logSuccess(`Histogram plot metrics validated (${histComparison.totalMetrics} metrics)`)

    logSuccess(
      `COMPLETE: ${comparison.totalMetrics} stats + ${qqComparison.totalMetrics + histComparison.totalMetrics} plot metrics validated`
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
