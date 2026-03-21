/**
 * Create E2E fixture from validation test data
 *
 * Usage: node e2e/scripts/create-fixture.mjs <group> <test>
 * Example: node e2e/scripts/create-fixture.mjs Group1_Hypothesis_Testing anova_one_way
 */

import { setupTest, teardownTest } from '../utils/setup.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

async function createFixture(group, testName) {
  let driver, webdriver

  try {
    console.log(`[CreateFixture] Creating fixture for ${group}/${testName}...`)

    // Setup WebDriver + Tauri app
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // Build paths
    const csvPath = path.join(PROJECT_ROOT, '_test_validation', group, testName, 'data', 'dataset_01.csv')
    const fixtureDir = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'datasets', group, testName)
    const ecpPath = path.join(fixtureDir, `${testName}.ecp`)

    console.log(`[CreateFixture] CSV source: ${csvPath}`)
    console.log(`[CreateFixture] Fixture destination: ${ecpPath}`)

    // Clear any existing data
    await driver.executeScript(() => {
      return window.__E2E__.clearAllData()
    })

    // Wait a moment for state to settle
    await driver.sleep(500)

    // Import the CSV
    console.log(`[CreateFixture] Importing CSV...`)
    await driver.executeScript((csvPath) => {
      return window.__E2E__.importCSV(csvPath)
    }, csvPath)

    // Wait for import to complete
    await driver.sleep(2000)

    // Verify import
    const datasetCount = await driver.executeScript(() => {
      return window.__E2E__.getDatasetCount()
    })

    console.log(`[CreateFixture] Imported ${datasetCount} dataset(s)`)

    if (datasetCount === 0) {
      throw new Error('Failed to import CSV - no datasets found')
    }

    // Use keyboard shortcut to trigger Save As (Ctrl+Shift+S)
    console.log(`[CreateFixture] Triggering Save As...`)

    // Find the body element to send keys
    const body = await driver.findElement(webdriver.By.css('body'))

    // Send Ctrl+Shift+S
    await body.sendKeys(webdriver.Key.chord(webdriver.Key.CONTROL, webdriver.Key.SHIFT, 's'))

    // Wait for save dialog
    await driver.sleep(1000)

    // The Tauri save dialog should open - we need to handle it
    // Since this is a native dialog, we may need to use a different approach

    console.log(`[CreateFixture] Note: Save dialog should be open. Complete save manually.`)
    console.log(`[CreateFixture] Save to: ${ecpPath}`)

    // Wait for user to complete save
    await driver.sleep(10000)

    console.log(`[CreateFixture] Fixture creation complete!`)

  } catch (error) {
    console.error(`[CreateFixture] Error: ${error.message}`)
    throw error
  } finally {
    await teardownTest(driver)
  }
}

// Parse command line args
const args = process.argv.slice(2)
if (args.length < 2) {
  console.log('Usage: node e2e/scripts/create-fixture.mjs <group> <test>')
  console.log('Example: node e2e/scripts/create-fixture.mjs Group1_Hypothesis_Testing anova_one_way')
  process.exit(1)
}

createFixture(args[0], args[1])
