/**
 * R Baseline Validation: Dose-Response 3PL
 * Validates 36 metrics (32 statistical + 4 plot) against R baseline (7% tolerance)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runDoseResponse3PL, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByType } from '../../utils/plot-validation.mjs'

// 7% tolerance for pharmacology tests
const PHARMACOLOGY_TOLERANCE = 0.07

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Dose-Response 3PL R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'dose_response_3pl')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Dose-Response 3PL Test via UI...')
    await runDoseResponse3PL(driver, {})

    await waitForResults(driver)

    // Validate statistical metrics against R baseline
    logStep('Validating statistical metrics...')
    const comparison = await validateAgainstRBaseline(driver, 'dose_response_3pl', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    // Switch to Plots tab to validate dose-response curve
    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    // Select dose-response curve from gallery
    logStep('Selecting dose-response curve plot...')
    await selectPlotFromGalleryByType(driver, 'doseresponse')

    // Export plot screenshot
    logStep('Exporting dose-response curve screenshot...')
    await exportPlotScreenshot(driver, 'dose_response_3pl', 300, 'doseresponse')

    // Validate plot metrics
    logStep('Validating plot metrics...')
    const plotComparison = await validatePlotAgainstRBaseline(driver, 'dose_response_3pl', null, PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${plotComparison.totalMetrics} plot metrics validated`)

    logSuccess(`COMPLETE: ${comparison.totalMetrics} statistical + ${plotComparison.totalMetrics} plot metrics validated`)

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
