/**
 * Debug test to see what happens when clicking Perform Test button
 */

import { setupTest, cleanupTest } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'
import { until } from 'selenium-webdriver'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting button click debug test...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // Load fixture
    const fixture = await loadFixture(driver, 't_test_two_sample')
    logStep(`Fixture loaded`)

    // Wait for data to be active
    await driver.wait(async () => {
      const ready = await driver.executeScript(() => {
        const datasetCount = window.__E2E__?.getDatasetCount?.() || 0
        const canvasCount = document.querySelectorAll('canvas').length
        const bodyText = document.body.innerText
        const hasRowColInfo = bodyText.includes('rows') && bodyText.includes('columns')
        return datasetCount > 0 && canvasCount > 0 && hasRowColInfo
      })
      return ready
    }, 15000)
    logStep('Dataset active')

    await driver.sleep(1000)

    // Find and click button
    const button = await driver.wait(
      until.elementLocated({ css: '[data-testid="run-analysis-button"]' }),
      10000
    )

    const isDisabled = await button.getAttribute('disabled')
    logStep(`Button disabled attribute: ${isDisabled}`)

    await button.click()
    logStep('Button clicked')

    // Wait a bit
    await driver.sleep(2000)

    // Check what dialogs/elements appeared
    const pageState = await driver.executeScript(() => {
      return {
        dialogElements: {
          confirmButton: !!document.querySelector('[data-testid="confirm-test-selection"]'),
          anyDialog: document.querySelectorAll('[role="dialog"]').length,
          anyOverlay: document.querySelectorAll('[data-radix-dialog-overlay]').length,
          anyContent: document.querySelectorAll('[data-radix-dialog-content]').length,
        },
        bodyText: document.body.innerText.substring(0, 1000),
      }
    })

    console.log('\n=== AFTER BUTTON CLICK ===')
    console.log(JSON.stringify(pageState, null, 2))

  } catch (error) {
    console.error(`TEST FAILED: ${error.message}`)
    console.error(error.stack)
  } finally {
    // Don't cleanup - keep app open
    logStep('Test complete - app staying open for inspection')
    console.log('Press Ctrl+C to close')
    await new Promise(resolve => setTimeout(resolve, 60000))
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch(err => {
  console.error('Execution failed:', err)
  process.exit(1)
})
