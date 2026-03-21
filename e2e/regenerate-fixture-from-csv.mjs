/**
 * Regenerate .ecp fixture from R validation CSV
 * This ensures the fixture matches the data R is using for baseline
 */

import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { logStep } from './utils/assertions.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

async function runTest() {
  let driver, webdriver

  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    // Path to the R validation CSV
    const csvPath = path.join(PROJECT_ROOT, '_test_validation/Group1_Hypothesis_Testing/t_test_two_sample/data/dataset_01.csv')
    logStep(`Importing CSV: ${csvPath}`)

    // Import CSV using window.__E2E__ API
    await driver.executeScript((csvFilePath) => {
      if (!window.__E2E__) {
        throw new Error('window.__E2E__ is not available')
      }
      return window.__E2E__.importCSV(csvFilePath)
    }, csvPath)

    // Wait for import to complete
    await driver.sleep(2000)

    // Verify data loaded
    const rowCount = await driver.executeScript(() => {
      const state = window.useDataStore?.getState()
      return state?.currentDataset?.rowCount || 0
    })

    logStep(`Dataset loaded: ${rowCount} rows`)

    // Save as .ecp fixture
    const outputPath = path.join(PROJECT_ROOT, 'e2e/fixtures/t_test_two_sample.ecp')
    logStep(`Saving fixture: ${outputPath}`)

    await driver.executeScript((ecpPath) => {
      if (!window.__E2E__) {
        throw new Error('window.__E2E__ is not available')
      }
      return window.__E2E__.saveProject(ecpPath)
    }, outputPath)

    logStep('Fixture regenerated successfully!')
    console.log('\n✅ Next steps:')
    console.log('1. Run R baseline: "C:/Program Files/R/R-4.5.1/bin/Rscript.exe" _test_validation/Group1_Hypothesis_Testing/t_test_two_sample/r/run_test.R')
    console.log('2. Run E2E validation test: node e2e/features/r-validation/t-test-two-sample.test.mjs')

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
