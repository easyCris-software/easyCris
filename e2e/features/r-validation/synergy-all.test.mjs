/**
 * R Baseline Validation: Synergy All Methods
 * Validates all synergy models (Bliss, HSA, Loewe, ZIP) against R baseline (7% tolerance)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runSynergyAll, waitForResults } from '../../utils/ui-workflow.mjs'

// 7% tolerance for pharmacology tests
const PHARMACOLOGY_TOLERANCE = 0.07

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Synergy All Methods R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'synergy_all')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Synergy All Methods Test via UI...')
    await runSynergyAll(driver, {})

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'synergy_all', PHARMACOLOGY_TOLERANCE)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

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
