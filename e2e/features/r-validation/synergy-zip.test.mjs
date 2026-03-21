/**
 * R Baseline Validation: Synergy ZIP (Zero Interaction Potency)
 * Validates synergy metrics against R baseline (7% tolerance for pharmacology)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runSynergyZIP, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

// 7% tolerance for pharmacology tests
const PHARMACOLOGY_TOLERANCE = 0.07

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Synergy ZIP R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'synergy_zip')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Synergy ZIP Test via UI...')
    await runSynergyZIP(driver, {})

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'synergy_zip', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting ZIP synergy contour plot...')
    await selectPlotFromGalleryByTitle(driver, 'ZIP Synergy Contour')

    logStep('Exporting ZIP synergy contour screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_zip', 300, 'contour')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating ZIP synergy contour plot metrics...')
    const plotComparison = await validatePlotAgainstRBaseline(driver, 'synergy_zip', 'synergy_contour', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${plotComparison.totalMetrics} plot metrics validated`)

    logStep('Selecting ZIP synergy heatmap plot...')
    await selectPlotFromGalleryByTitle(driver, 'ZIP Synergy Heatmap')

    logStep('Exporting ZIP synergy heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_zip', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating ZIP synergy heatmap plot metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(driver, 'synergy_zip', 'synergy_heatmap', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${heatmapComparison.totalMetrics} heatmap plot metrics validated`)

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
