/**
 * R Baseline Validation: Chi-Square Independence Test
 * Validates metrics against R chisq.test() baseline
 *
 * Tests: chi_squared, degrees_of_freedom, p_value, cramers_v (4 metrics)
 * Plots: mosaic, grouped_bar, heatmap (3 plots)
 * R Settings: correct=FALSE (no Yates correction)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runCategoricalTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Chi-Square Independence R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'chi_square')
    logStep(`Loaded fixture: chi_square`)

    // Run test via UI
    logStep('Running Chi-Square Independence via UI...')
    await runCategoricalTest(driver, 'chi_square', ['group', 'outcome'])

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (4 metrics)
    const comparison = await validateAgainstRBaseline(driver, 'chi_square', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // === PLOT VALIDATION ===
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Plot 1: Mosaic Plot
    logStep('Selecting Mosaic Plot...')
    await selectPlotFromGalleryByTitle(driver, 'Mosaic Plot')

    logStep('Exporting mosaic plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'chi_square', 300, 'mosaic')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating mosaic plot metrics...')
    const mosaicComparison = await validatePlotAgainstRBaseline(driver, 'chi_square', 'mosaic', 0.01)
    logSuccess(`All ${mosaicComparison.totalMetrics} mosaic plot metrics validated`)

    // Plot 2: Grouped Bar Chart
    logStep('Selecting Grouped Bar Chart...')
    await selectPlotFromGalleryByTitle(driver, 'Grouped Bar Chart')

    logStep('Exporting grouped bar screenshot...')
    try {
      await exportPlotScreenshot(driver, 'chi_square', 300, 'grouped_bar')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating grouped bar plot metrics...')
    const groupedBarComparison = await validatePlotAgainstRBaseline(driver, 'chi_square', 'grouped_bar', 0.01)
    logSuccess(`All ${groupedBarComparison.totalMetrics} grouped bar plot metrics validated`)

    // Plot 3: Residual Heatmap
    logStep('Selecting Residual Heatmap...')
    await selectPlotFromGalleryByTitle(driver, 'Observed vs Expected (Std Residuals)')

    logStep('Exporting heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'chi_square', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating heatmap plot metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(driver, 'chi_square', 'heatmap', 0.01)
    logSuccess(`All ${heatmapComparison.totalMetrics} heatmap plot metrics validated`)

    logSuccess(`Chi-Square Independence: ${comparison.totalMetrics} statistical + ${mosaicComparison.totalMetrics + groupedBarComparison.totalMetrics + heatmapComparison.totalMetrics} plot metrics validated`)

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
