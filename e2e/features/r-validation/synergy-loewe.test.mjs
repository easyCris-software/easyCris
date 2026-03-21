/**
 * R Baseline Validation: Synergy Loewe Additivity
 * Validates synergy metrics against R baseline (7% tolerance for pharmacology)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runSynergyLoewe, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

// 7% tolerance for pharmacology tests
const PHARMACOLOGY_TOLERANCE = 0.07

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Synergy Loewe R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'synergy_loewe')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Synergy Loewe Test via UI...')
    await runSynergyLoewe(driver, {})

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'synergy_loewe', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${comparison.totalMetrics} statistical metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting Loewe synergy contour plot...')
    await selectPlotFromGalleryByTitle(driver, 'Loewe Synergy Contour')

    logStep('Exporting Loewe synergy contour screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_loewe', 300, 'contour')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Loewe synergy contour plot metrics...')
    const contourComparison = await validatePlotAgainstRBaseline(
      driver,
      'synergy_loewe',
      'synergy_contour',
      PHARMACOLOGY_TOLERANCE
    )
    logSuccess(`All ${contourComparison.totalMetrics} contour plot metrics validated`)

    logStep('Selecting Loewe synergy heatmap plot...')
    await selectPlotFromGalleryByTitle(driver, 'Loewe Synergy Heatmap')

    logStep('Exporting Loewe synergy heatmap screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_loewe', 300, 'heatmap')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Loewe synergy heatmap plot metrics...')
    const heatmapComparison = await validatePlotAgainstRBaseline(
      driver,
      'synergy_loewe',
      'synergy_heatmap',
      PHARMACOLOGY_TOLERANCE
    )
    logSuccess(`All ${heatmapComparison.totalMetrics} heatmap plot metrics validated`)

    logStep('Selecting Loewe isobologram plot...')
    await selectPlotFromGalleryByTitle(driver, 'Loewe Isobologram')

    logStep('Exporting Loewe isobologram screenshot...')
    try {
      await exportPlotScreenshot(driver, 'synergy_loewe', 300, 'isobologram')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating Loewe isobologram plot metrics...')
    const isoComparison = await validatePlotAgainstRBaseline(
      driver,
      'synergy_loewe',
      'loewe_isobologram',
      PHARMACOLOGY_TOLERANCE
    )
    logSuccess(`All ${isoComparison.totalMetrics} isobologram plot metrics validated`)

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
