/**
 * R Baseline Validation: Synergy Bliss Independence
 * Validates synergy metrics against R baseline (7% tolerance for pharmacology)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runSynergyBliss, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

// 7% tolerance for pharmacology tests
const PHARMACOLOGY_TOLERANCE = 0.07

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Synergy Bliss R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'synergy_bliss')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Synergy Bliss Test via UI...')
    await runSynergyBliss(driver, {})

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'synergy_bliss', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting Bliss synergy contour plot...')
    await selectPlotFromGalleryByTitle(driver, 'Bliss Synergy Contour')

    logStep('Exporting Bliss synergy contour screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_bliss', 300, 'contour')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Bliss synergy contour plot metrics...')
    const plotComparison = await validatePlotAgainstRBaseline(driver, 'synergy_bliss', 'synergy_contour', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${plotComparison.totalMetrics} plot metrics validated`)

    logStep('Selecting Bliss synergy heatmap plot...')
    await selectPlotFromGalleryByTitle(driver, 'Bliss Synergy Heatmap')

    logStep('Exporting Bliss synergy heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_bliss', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Bliss synergy heatmap plot metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(driver, 'synergy_bliss', 'synergy_heatmap', PHARMACOLOGY_TOLERANCE)
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
