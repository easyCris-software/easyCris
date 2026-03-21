/**
 * Debug: Check what data-stat attributes are actually in the results table
 */

import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'
import { runIndependentTTest, waitForResults } from './utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 't_test_two_sample')
    logStep(`Fixture loaded: ${fixture.name}`)

    logStep('Running Independent T-Test workflow...')
    await runIndependentTTest(driver)

    logStep('Waiting for results...')
    await waitForResults(driver)

    // Debug: Check what data-stat attributes exist
    const dataStatInfo = await driver.executeScript(() => {
      const table = document.querySelector('[data-testid="results-table"]')

      if (!table) {
        return { error: 'Results table not found' }
      }

      const statCells = table.querySelectorAll('[data-stat]')

      const info = {
        totalCells: statCells.length,
        attributes: [],
        sampleValues: []
      }

      for (const cell of statCells) {
        const statName = cell.getAttribute('data-stat')
        const statValue = cell.textContent.trim()

        info.attributes.push(statName)

        // Store first 10 for inspection
        if (info.sampleValues.length < 10) {
          info.sampleValues.push({
            name: statName,
            value: statValue,
            parsed: parseFloat(statValue.replace('<', '').replace(/,/g, ''))
          })
        }
      }

      return info
    })

    console.log('\n=== DATA-STAT ATTRIBUTE DEBUG ===')
    console.log(JSON.stringify(dataStatInfo, null, 2))

    logStep('Debug complete - keeping app open for 30s')
    await driver.sleep(30000)

  } catch (error) {
    console.error(`TEST FAILED: ${error.message}`)
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
