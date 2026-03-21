import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import {
  openPreferencesAccountLinkFlow,
  waitForPairingCode,
  waitForLinkedState,
} from '../../utils/device-auth-workflow.mjs'

async function runTest() {
  let driver
  let webdriver
  let approvedDeviceLink = null

  try {
    logStep('Starting Preferences > Account device-linking flow...')
    const result = await setupTest({ resetAuth: true, showWelcome: true })
    driver = result.driver
    webdriver = result.webdriver

    await openPreferencesAccountLinkFlow(driver)
    await waitForPairingCode(driver)
    approvedDeviceLink = await waitForLinkedState(driver)

    logSuccess('Preferences > Account device-linking flow completed')
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver, {
        resetAuth: true,
        showWelcome: true,
        approvedDeviceLink,
      })
    }
  }
}

runTest().catch((error) => {
  console.error('[Test] Execution failed:', error)
  process.exit(1)
})
