/**
 * R Baseline Validation: Fisher's Exact Test
 * Validates metrics against R fisher.test() baseline
 *
 * Tests: odds_ratio, p_value, ci_95_lower, ci_95_upper (4 metrics)
 * Plots: line, grouped_bar, forest (3 plots)
 * R Settings: alternative="two.sided", conf.int=TRUE, conf.level=0.95
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
    logStep("Starting Fisher's Exact Test R validation...")

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    // Load fixture
    const fixture = await loadFixture(driver, 'fishers_exact')
    logStep(`Loaded fixture: fishers_exact`)

    // Run test via UI - requires 2x2 table
    logStep("Running Fisher's Exact Test via UI...")
    await runCategoricalTest(driver, 'fishers_exact', ['group', 'outcome'])

    // Wait for results
    await waitForResults(driver)

    // Validate against R baseline (4 metrics)
    // Use 2% relative tolerance for CI bounds (numerical method differences between R and scipy)
    const comparison = await validateAgainstRBaseline(driver, 'fishers_exact', 0.02)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // === PLOT VALIDATION ===
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Plot 1: Chi-Square Distribution
    logStep('Selecting Chi-Square Distribution plot...')
    await selectPlotFromGalleryByTitle(driver, 'Chi-Square Distribution')

    logStep('Exporting distribution plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'fishers_exact', 300, 'line')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating distribution plot metrics...')
    const distComparison = await validatePlotAgainstRBaseline(driver, 'fishers_exact', 'line', 0.01)
    logSuccess(`All ${distComparison.totalMetrics} distribution plot metrics validated`)

    // Plot 2: Grouped Bar Chart
    logStep('Selecting Grouped Bar Chart...')
    await selectPlotFromGalleryByTitle(driver, 'Grouped Bar Chart')

    logStep('Exporting grouped bar screenshot...')
    try {
      await exportPlotScreenshot(driver, 'fishers_exact', 300, 'grouped_bar')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating grouped bar plot metrics...')
    const groupedBarComparison = await validatePlotAgainstRBaseline(driver, 'fishers_exact', 'grouped_bar', 0.01)
    logSuccess(`All ${groupedBarComparison.totalMetrics} grouped bar plot metrics validated`)

    // Plot 3: Odds Ratio Forest Plot
    logStep('Selecting Odds Ratio Forest Plot...')
    await selectPlotFromGalleryByTitle(driver, 'Odds Ratio Forest Plot')

    logStep('Exporting forest plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'fishers_exact', 300, 'forest')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating forest plot metrics...')
    const forestComparison = await validatePlotAgainstRBaseline(driver, 'fishers_exact', 'forest', 0.02)
    logSuccess(`All ${forestComparison.totalMetrics} forest plot metrics validated`)

    logSuccess(`Fisher's Exact: ${comparison.totalMetrics} statistical + ${distComparison.totalMetrics + groupedBarComparison.totalMetrics + forestComparison.totalMetrics} plot metrics validated`)

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
