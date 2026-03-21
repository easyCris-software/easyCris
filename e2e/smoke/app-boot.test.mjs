/**
 * Smoke Test: App Boot
 * Verifies the Tauri app launches and matches the expected shim contract
 */

import { setupTest, cleanupTest } from '../utils/selenium-setup.mjs'
import { until } from 'selenium-webdriver'
import { logStep, logSuccess, assertTrue } from '../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver
  const expectShim = process.env.E2E_EXPECT_SHIM === '1'

  try {
    logStep('Starting app boot test...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // Wait for app to load
    await driver.wait(until.elementLocated({ css: '[data-testid="app-loaded"]' }), 10000)
    logStep('App loaded - data-testid="app-loaded" found')

    // Get page title
    const title = await driver.getTitle()
    logStep(`Page title: "${title}"`)

    const e2eType = await driver.executeScript(() => typeof window.__E2E__)
    logStep(`typeof window.__E2E__: ${e2eType}`)

    if (expectShim) {
      assertTrue(e2eType === 'object', 'window.__E2E__ should exist in E2E mode')

      const apiMethods = await driver.executeScript(() => {
        if (!window.__E2E__) return []
        return Object.keys(window.__E2E__)
      })
      logStep(`E2E API methods: ${apiMethods.join(', ')}`)

      const requiredMethods = ['loadFixture', 'runTest', 'getDatasetCount', 'clearAllData']
      for (const method of requiredMethods) {
        assertTrue(apiMethods.includes(method), `window.__E2E__.${method} should exist`)
      }

      logSuccess('App booted successfully with E2E shim')
    } else {
      assertTrue(e2eType === 'undefined', 'window.__E2E__ should not be exposed in release mode')
      logSuccess('App booted successfully with shim-free release contract')
    }

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
