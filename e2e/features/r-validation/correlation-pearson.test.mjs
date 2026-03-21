/**
 * R Baseline Validation: Correlation Analysis (combined UI flow)
 * Validates Pearson correlation metrics against R baseline
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
    logStep('Starting Correlation Analysis (Pearson) R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const config = loadRegressionConfig().correlation_pearson

    const fixture = await loadFixture(driver, 'correlation_pearson')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Correlation Analysis via UI...')
    await runCorrelationTest(driver, 'correlation_pearson', config.columns)

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'correlation_pearson', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting Pearson correlation scatter...')
    await selectPlotFromGalleryByTitle(driver, 'Pearson Correlation Scatter')

    logStep('Exporting Pearson correlation scatter screenshot...')
    try {
      await exportPlotScreenshot(driver, 'correlation_pearson', 300, 'scatter')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Pearson correlation scatter metrics...')
    const scatterComparison = await validatePlotAgainstRBaseline(driver, 'correlation_pearson', 'scatter', 0.01)
    logSuccess(`All ${scatterComparison.totalMetrics} scatter metrics validated`)

    logStep('Selecting Pearson correlation heatmap...')
    await selectPlotFromGalleryByTitle(driver, 'Pearson Correlation Heatmap')

    logStep('Exporting Pearson correlation heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'correlation_pearson', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Pearson correlation heatmap metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(driver, 'correlation_pearson', 'heatmap', 0.01)
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
