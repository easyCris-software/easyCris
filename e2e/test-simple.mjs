/**
 * Simple test to verify basic functionality
 */

import { setupTest, cleanupTest } from './utils/selenium-setup.mjs'
import { logStep, logSuccess } from './utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    console.log('=== TEST START ===')
    logStep('Test starting')

    console.log('=== CALLING SETUPTEST ===')
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    console.log('=== SETUPTEST COMPLETE ===')
    logStep('Setup complete')

    // Simple check
    const title = await driver.getTitle()
    console.log(`Title: ${title}`)

    logSuccess('Test passed!')
    console.log('=== TEST END ===')

  } catch (error) {
    console.error(`TEST FAILED: ${error.message}`)
    console.error(error.stack)
    throw error
  } finally {
    if (driver && webdriver) {
      console.log('=== CLEANUP START ===')
      await cleanupTest(driver, webdriver)
      console.log('=== CLEANUP END ===')
    }
  }
}

runTest().catch(err => {
  console.error('Execution failed:', err)
  process.exit(1)
})
