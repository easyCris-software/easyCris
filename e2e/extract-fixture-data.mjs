/**
 * Extract data from .ecp fixture and save as CSV for R baseline generation
 */

import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'
import fs from 'fs'
import path from 'path'

async function runTest() {
  let driver, webdriver

  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    logStep('Loading fixture...')
    await loadFixture(driver, 't_test_two_sample')

    // Wait for data to load in the store
    logStep('Waiting for dataset to be available in store...')
    await driver.wait(async () => {
      const hasData = await driver.executeScript(() => {
        const state = window.useDataStore?.getState()
        return !!(state && state.currentDataset && state.currentDataset.rowCount > 0)
      })
      return hasData
    }, 10000, 'Dataset did not load in store within 10 seconds')

    logStep('Extracting data from fixture...')
    const data = await driver.executeScript(() => {
      // Get the current dataset from the data store
      const state = window.useDataStore?.getState()
      if (!state || !state.currentDataset) {
        throw new Error('No dataset loaded')
      }

      const dataset = state.currentDataset
      const rows = []

      // Extract all rows
      for (let i = 0; i < dataset.rowCount; i++) {
        const row = {}
        for (const col of dataset.columns) {
          row[col.name] = dataset.data[col.name]?.[i]
        }
        rows.push(row)
      }

      return {
        columns: dataset.columns.map(c => c.name),
        rows: rows
      }
    })

    logStep(`Extracted ${data.rows.length} rows, ${data.columns.length} columns`)

    // Convert to CSV
    const csvLines = []
    csvLines.push(data.columns.join(','))

    for (const row of data.rows) {
      const values = data.columns.map(col => row[col] ?? '')
      csvLines.push(values.join(','))
    }

    const csv = csvLines.join('\n')

    // Save to validation folder
    const outputPath = path.resolve('_test_validation/Group1_Hypothesis_Testing/t_test_two_sample/data/dataset_from_ecp.csv')
    fs.writeFileSync(outputPath, csv, 'utf-8')

    logStep(`Saved CSV to: ${outputPath}`)
    console.log('\n=== CSV PREVIEW ===')
    console.log(csv.split('\n').slice(0, 15).join('\n'))
    console.log(`... (${data.rows.length} total rows)`)

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
