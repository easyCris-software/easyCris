/**
 * R Baseline Validation: Chi-Square Goodness of Fit
 * Validates metrics against R chisq.test() baseline (uniform expected)
 *
 * Tests: chi_squared, degrees_of_freedom, p_value (3 metrics)
 * Plots: line, grouped_bar (2 plots)
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
    logStep('Starting Chi-Square Goodness of Fit R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'chi_square_gof')
    logStep(`Loaded fixture: chi_square_gof`)

    // Run test via UI - GOF uses observed counts + expected proportions
    logStep('Running Chi-Square Goodness of Fit via UI...')
    await runCategoricalTest(driver, 'chi_square_gof', ['category', 'observed', 'expected_proportion'])

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (3 metrics)
    const comparison = await validateAgainstRBaseline(driver, 'chi_square_gof', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // === PLOT VALIDATION ===
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Plot 1: Chi-Square Distribution
    logStep('Selecting Chi-Square Distribution plot...')
    await selectPlotFromGalleryByTitle(driver, 'Chi-Square Distribution')

    logStep('Exporting distribution plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'chi_square_gof', 300, 'line')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating distribution plot metrics...')
    const distComparison = await validatePlotAgainstRBaseline(driver, 'chi_square_gof', 'line', 0.01)
    logSuccess(`All ${distComparison.totalMetrics} distribution plot metrics validated`)

    // Plot 2: Observed vs Expected Bar
    logStep('Selecting Observed vs Expected bar plot...')
    await selectPlotFromGalleryByTitle(driver, 'Observed vs Expected')

    logStep('Exporting bar plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'chi_square_gof', 300, 'grouped_bar')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating bar plot metrics...')
    const barComparison = await validatePlotAgainstRBaseline(driver, 'chi_square_gof', 'grouped_bar', 0.01)
    logSuccess(`All ${barComparison.totalMetrics} bar plot metrics validated`)

    logSuccess(`Chi-Square GOF: ${comparison.totalMetrics} statistical + ${distComparison.totalMetrics + barComparison.totalMetrics} plot metrics validated`)

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
