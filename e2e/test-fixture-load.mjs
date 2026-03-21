/**
 * Debug test to see what happens after loading a fixture
 */

import { setupTest, cleanupTest } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting fixture load debug test...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // Load fixture
    const fixture = await loadFixture(driver, 't_test_two_sample')
    logStep(`Fixture loaded: ${fixture.name}`)

    // Wait a bit for UI to update
    await driver.sleep(2000)

    // Check what's actually on the page
    const pageInfo = await driver.executeScript(() => {
      const info = {
        title: document.title,
        bodyText: document.body.innerText.substring(0, 500),
        gridElements: {
          gdgCell: document.querySelectorAll('.gdg-cell').length,
          glideGrid: document.querySelectorAll('[class*="glide"]').length,
          canvas: document.querySelectorAll('canvas').length,
          dataGrid: document.querySelectorAll('[class*="data-grid"]').length,
          spreadsheet: document.querySelectorAll('[class*="spreadsheet"]').length,
        },
        hasE2E: typeof window.__E2E__,
        datasetCount: window.__E2E__?.getDatasetCount?.() || 'N/A',
        storeState: {
          hasDataStore: typeof window.useDataStore !== 'undefined',
          currentDataset: window.useDataStore?.getState?.()?.currentDataset?.name || 'N/A',
        }
      }
      return info
    })

    console.log('\n=== PAGE INFO ===')
    console.log(JSON.stringify(pageInfo, null, 2))

    // Try to get dataset count via E2E API
    const datasetCount = await driver.executeScript(() => {
      return window.__E2E__.getDatasetCount()
    })
    logStep(`Dataset count from E2E API: ${datasetCount}`)

    logStep('Debug test complete - check output above')

  } catch (error) {
    console.error(`TEST FAILED: ${error.message}`)
    console.error(error.stack)
    throw error
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch(err => {
  console.error('Execution failed:', err)
  process.exit(1)
})
