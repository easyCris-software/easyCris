/**
 * Smoke Test: Startup Clean State
 * Verifies E2E startup/reset leaves zero datasets before any fixture load.
 */

import { setupTest, cleanupTest, verifyCleanState } from '../utils/selenium-setup.mjs'
import { logStep, logSuccess } from '../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting startup clean-state smoke test...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)
    logSuccess('Startup clean-state verified (0 datasets)')
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
