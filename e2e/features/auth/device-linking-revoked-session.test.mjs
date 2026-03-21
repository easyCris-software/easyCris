import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { revokeApprovedDeviceLink } from '../../utils/device-approval-helper.mjs'
import {
  assertInvalidState,
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
    logStep('Starting revoked desktop device-link fallback flow...')
    const result = await setupTest({ resetAuth: true, showWelcome: true })
    driver = result.driver
    webdriver = result.webdriver

    await openFirstLaunchLinkFlow(driver)
    await waitForPairingCode(driver)
    approvedDeviceLink = await waitForLinkedState(driver)
    await clickVisibleText(driver, 'Continue')

    await revokeApprovedDeviceLink(approvedDeviceLink)

    const relaunched = await relaunchPreservingAuthState(driver, webdriver)
    driver = relaunched.driver
    webdriver = relaunched.webdriver

    await assertInvalidState(driver)
    approvedDeviceLink = null

    logSuccess('Revoked linked device falls back out of linked mode')
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
