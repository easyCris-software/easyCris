/**
 * Debug: Check what columns are actually in the t_test_two_sample fixture
 */

import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    logStep('Loading fixture...')
    await loadFixture(driver, 't_test_two_sample')

    // Wait for data to load
    await driver.sleep(2000)

    // Get column information from the datastore
    const columnInfo = await driver.executeScript(() => {
      const state = window.useDataStore?.getState()
      if (!state || !state.currentDataset) {
        return { error: 'No dataset loaded' }
      }

      const dataset = state.currentDataset
      return {
        name: dataset.name,
        rowCount: dataset.rowCount,
        columns: dataset.columns.map(col => ({
          name: col.name,
          type: col.type,
          id: col.id
        })),
        sampleData: dataset.columns.slice(0, 2).map(col => ({
          name: col.name,
          firstValues: dataset.data[col.name]?.slice(0, 5)
        }))
      }
    })

    console.log('\n=== FIXTURE COLUMN INFO ===')
    console.log(JSON.stringify(columnInfo, null, 2))

  } catch (error) {
    console.error(`FAILED: ${error.message}`)
    console.error(error.stack)
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
