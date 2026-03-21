/**
 * Smoke Test: E2E Shim Verification
 * In release mode: verifies window.__E2E__ is absent
 * In e2e mode: verifies window.__E2E__ API functionality
 */

import { setupTest, cleanupTest } from '../utils/selenium-setup.mjs'
import { until } from 'selenium-webdriver'
import { logStep, logSuccess, assertTrue, assertEqual } from '../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver
  const expectShim = process.env.E2E_EXPECT_SHIM === '1'

  try {
    logStep('Starting E2E shim verification test...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // Wait for app to load
    await driver.wait(until.elementLocated({ css: 'body' }), 10000)

    const title = await driver.getTitle()
    logStep(`App loaded - Title: "${title}"`)

    const e2eType = await driver.executeScript(() => typeof window.__E2E__)
    logStep(`Sanity check: typeof window.__E2E__ = "${e2eType}"`)

    if (!expectShim) {
      assertTrue(e2eType === 'undefined', 'window.__E2E__ must not be exposed in release smoke mode')
      logSuccess('Release smoke contract verified (shim-free)')
      return
    }

    // Sanity check: Call getDatasetCount()
    const datasetCountResult = await driver.executeScript(() => {
      try {
        const count = window.__E2E__.getDatasetCount()
        return { success: true, count }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    logStep(`Sanity check: getDatasetCount() returned: ${JSON.stringify(datasetCountResult)}`)

    // Test 1: Check if E2E shim exists
    const shimExists = await driver.executeScript(() => typeof window.__E2E__ === 'object')
    assertTrue(shimExists, 'E2E shim should exist')
    logSuccess('Test 1: window.__E2E__ exists = true')

    // Test 2: Check all 4 API methods exist
    const hasAllMethods = await driver.executeScript(() => {
      return (
        typeof window.__E2E__?.loadFixture === 'function' &&
        typeof window.__E2E__?.runTest === 'function' &&
        typeof window.__E2E__?.getDatasetCount === 'function' &&
        typeof window.__E2E__?.clearAllData === 'function'
      )
    })
    assertTrue(hasAllMethods, 'All E2E API methods should exist')
    logSuccess('Test 2: All 4 API methods exist = true')

    // Test 3: Initial dataset count (might have persisted data)
    const initialCount = await driver.executeScript(() => window.__E2E__.getDatasetCount())
    logSuccess(`Test 3: Initial dataset count = ${initialCount}`)

    // Test 4: Clear all data
    await driver.executeScript(() => window.__E2E__.clearAllData())
    logSuccess('Test 4: Cleared all data')

    // Test 5: Verify count is now 0
    const countAfterClear = await driver.executeScript(() => window.__E2E__.getDatasetCount())
    assertEqual(countAfterClear, 0, 'Dataset count should be 0 after clearing')
    logSuccess('Test 5: Dataset count after clear = 0')

    logSuccess('E2E shim verification passed')

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
