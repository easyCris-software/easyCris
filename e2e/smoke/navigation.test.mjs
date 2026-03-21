/**
 * Smoke Test: Navigation
 * Verifies all critical UI elements are present
 */

import { setupTest, cleanupTest } from '../utils/selenium-setup.mjs'
import { until } from 'selenium-webdriver'
import { logStep, logSuccess, assertElementExists } from '../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting navigation test...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // Wait for app to load
    await driver.wait(until.elementLocated({ css: '[data-testid="app-loaded"]' }), 10000)
    logStep('App loaded')

    // Verify critical UI elements exist
    await assertElementExists(driver, '[data-testid="run-analysis-button"]')
    logSuccess('Run Analysis button found')

    // Note: results-panel and results-table only appear after running a test
    // For smoke test, just verify the app loads and main UI elements are present

    logSuccess('All critical UI elements present')

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
