import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import {
  assertLinkedState,
  clickVisibleText,
  openFirstLaunchLinkFlow,
  relaunchPreservingAuthState,
  waitForLinkedState,
  waitForPairingCode,
} from '../../utils/device-auth-workflow.mjs'

async function runTest() {
  let driver
  let webdriver
  let approvedDeviceLink = null

  try {
    logStep('Starting desktop device-link restart persistence flow...')
    const result = await setupTest({ resetAuth: true, showWelcome: true })
    driver = result.driver
    webdriver = result.webdriver

    await openFirstLaunchLinkFlow(driver)
    await waitForPairingCode(driver)
    approvedDeviceLink = await waitForLinkedState(driver)
    await clickVisibleText(driver, 'Continue')

    const relaunched = await relaunchPreservingAuthState(driver, webdriver)
    driver = relaunched.driver
    webdriver = relaunched.webdriver

    await assertLinkedState(driver)

    logSuccess('Desktop device-link survives restart')
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver, {
        resetAuth: true,
        showWelcome: false,
        approvedDeviceLink,
      })
    }
  }
}

runTest().catch((error) => {
  console.error('[Test] Execution failed:', error)
  process.exit(1)
})
