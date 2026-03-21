/**
 * R Baseline Validation: McNemar's Test
 * Validates metrics against R mcnemar.test() baseline
 *
 * Tests: chi_squared, p_value, exact_p_value, discordant_b, discordant_c (5 metrics)
 * Plots: grouped_bar (1 plot)
 * R Settings: correct=FALSE (no continuity correction)
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
    logStep("Starting McNemar's Test R validation...")

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'mcnemar')
    logStep(`Loaded fixture: mcnemar`)

    // Run test via UI - requires paired data (before/after)
    logStep("Running McNemar's Test via UI...")
    await runCategoricalTest(driver, 'mcnemar', ['before', 'after'])

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (5 metrics)
    const comparison = await validateAgainstRBaseline(driver, 'mcnemar', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // === PLOT VALIDATION ===
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Plot 1: Paired Bar Chart
    logStep('Selecting Paired Bar Chart...')
    await selectPlotFromGalleryByTitle(driver, 'Paired Bar Chart')

    logStep('Exporting paired bar screenshot...')
    try {
      await exportPlotScreenshot(driver, 'mcnemar', 300, 'grouped_bar')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating paired bar plot metrics...')
    const pairedBarComparison = await validatePlotAgainstRBaseline(driver, 'mcnemar', 'grouped_bar', 0.01)
    logSuccess(`All ${pairedBarComparison.totalMetrics} paired bar plot metrics validated`)

    logSuccess(`McNemar: ${comparison.totalMetrics} statistical + ${pairedBarComparison.totalMetrics} plot metrics validated`)

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
