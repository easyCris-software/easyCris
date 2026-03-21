/**
 * R Baseline Validation: Moderation Analysis (PROCESS Model 1)
 * Validates moderation metrics against R baseline (lm with interaction)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runModerationModel1Test, waitForResults } from '../../utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Moderation Analysis (Model 1) R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'moderation_model1')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Moderation Analysis via UI...')
    await runModerationModel1Test(driver, {
      mapping: { outcome: 'y', predictor: 'x', moderator: 'w' }
    })

    await waitForResults(driver)

    // All metrics are analytical (no bootstrap), use 0.0001 tolerance
    const comparison = await validateAgainstRBaseline(driver, 'moderation_model1', 0.0001)
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
