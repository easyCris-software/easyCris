/**
 * Debug test to see full flow and what dialog appears
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

    logStep('Workflow complete - waiting 5s to see what happened...')
    await driver.sleep(5000)

    // Check page state
    const state = await driver.executeScript(() => {
      return {
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(d => ({
          visible: d.offsetParent !== null,
          text: d.innerText.substring(0, 200)
        })),
        bodySnippet: document.body.innerText.substring(0, 1500),
        hasResults: !!document.querySelector('[data-testid="results-table"]'),
        hasResultsPanel: !!document.querySelector('[data-testid="results-panel"]'),
      }
    })

    console.log('\n=== PAGE STATE AFTER WORKFLOW ===')
    console.log(JSON.stringify(state, null, 2))

    logStep('Check complete - keeping app open for 30s')
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
