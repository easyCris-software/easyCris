/**
 * R Baseline Validation: Correlation Analysis (Kendall)
 * Validates Kendall correlation metrics and heatmap plot against R baseline
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture, loadRegressionConfig } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runCorrelationTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Correlation Analysis (Kendall) R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const config = loadRegressionConfig().correlation_kendall

    const fixture = await loadFixture(driver, 'correlation_kendall')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Correlation Analysis via UI...')
    await runCorrelationTest(driver, 'correlation_kendall', config.columns)

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'correlation_kendall', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting Kendall correlation heatmap...')
    await selectPlotFromGalleryByTitle(driver, 'Kendall Correlation Heatmap')

    logStep('Exporting Kendall correlation heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'correlation_kendall', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Kendall correlation heatmap metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(driver, 'correlation_kendall', 'heatmap', 0.01)
    logSuccess(`All ${heatmapComparison.totalMetrics} heatmap metrics validated`)
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
