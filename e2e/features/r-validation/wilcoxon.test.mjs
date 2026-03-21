/**
 * R Baseline Validation: Wilcoxon Signed-Rank Test
 * Validates 30 metrics (statistical + plot) against R baseline
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runWilcoxonTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotType } from '../../utils/plot-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Wilcoxon Signed-Rank Test R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'wilcoxon_signed_rank')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Wilcoxon Signed-Rank Test via UI...')
    await runWilcoxonTest(driver, {
      valueColumn: 'value',
      groupColumn: 'condition'
    })

    await waitForResults(driver)

    // Validate statistical metrics against R baseline
    logStep('Validating statistical metrics...')
    const comparison = await validateAgainstRBaseline(driver, 'wilcoxon_signed_rank', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // Switch to Plots tab to validate box/violin plots (differences)
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Export and validate Box plot
    logStep('Selecting Box plot type...')
    await selectPlotType(driver, 'box')
    logStep('Exporting Box plot screenshot...')
    await exportPlotScreenshot(driver, 'wilcoxon_signed_rank', 300, 'box')
    logStep('Validating box plot metrics...')
    const boxPlotComparison = await validatePlotAgainstRBaseline(driver, 'wilcoxon_signed_rank', 'box', 0.01)
    logSuccess(`All ${boxPlotComparison.totalMetrics} box plot metrics validated`)

    // Export and validate Violin plot
    logStep('Selecting Violin plot type...')
    await selectPlotType(driver, 'violin')
    logStep('Exporting Violin plot screenshot...')
    await exportPlotScreenshot(driver, 'wilcoxon_signed_rank', 300, 'violin')
    logStep('Validating violin plot metrics...')
    const violinPlotComparison = await validatePlotAgainstRBaseline(driver, 'wilcoxon_signed_rank', 'violin', 0.01)
    logSuccess(`All ${violinPlotComparison.totalMetrics} violin plot metrics validated`)

    logSuccess(`COMPLETE: ${comparison.totalMetrics} statistical + ${boxPlotComparison.totalMetrics} box + ${violinPlotComparison.totalMetrics} violin metrics validated`)

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
