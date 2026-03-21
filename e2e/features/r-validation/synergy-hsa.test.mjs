/**
 * R Baseline Validation: Synergy HSA (Highest Single Agent)
 * Validates synergy metrics against R baseline (7% tolerance for pharmacology)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runSynergyHSA, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

// 7% tolerance for pharmacology tests
const PHARMACOLOGY_TOLERANCE = 0.07

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Synergy HSA R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'synergy_hsa')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Synergy HSA Test via UI...')
    await runSynergyHSA(driver, {})

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'synergy_hsa', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting HSA synergy contour plot...')
    await selectPlotFromGalleryByTitle(driver, 'HSA Synergy Contour')

    logStep('Exporting HSA synergy contour screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_hsa', 300, 'contour')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating HSA synergy contour plot metrics...')
    const plotComparison = await validatePlotAgainstRBaseline(driver, 'synergy_hsa', 'synergy_contour', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${plotComparison.totalMetrics} plot metrics validated`)

    logStep('Selecting HSA synergy heatmap plot...')
    await selectPlotFromGalleryByTitle(driver, 'HSA Synergy Heatmap')

    logStep('Exporting HSA synergy heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_hsa', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating HSA synergy heatmap plot metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(driver, 'synergy_hsa', 'synergy_heatmap', PHARMACOLOGY_TOLERANCE)
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
