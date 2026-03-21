import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import {
  assertGuestState,
  clickVisibleText,
  openFirstLaunchLinkFlow,
  openPreferencesAccountPane,
  relaunchPreservingAuthState,
  waitForLinkedState,
  waitForPairingCode,
} from '../../utils/device-auth-workflow.mjs'

async function runTest() {
  let driver
  let webdriver
  let approvedDeviceLink = null

  try {
    logStep('Starting desktop device-link sign-out fallback flow...')
    const result = await setupTest({ resetAuth: true, showWelcome: true })
    driver = result.driver
    webdriver = result.webdriver

    await openFirstLaunchLinkFlow(driver)
    await waitForPairingCode(driver)
    approvedDeviceLink = await waitForLinkedState(driver)
    await clickVisibleText(driver, 'Continue')

    await openPreferencesAccountPane(driver)
    await clickVisibleText(driver, 'Sign out this device')
    await assertGuestState(driver)

    const relaunched = await relaunchPreservingAuthState(driver, webdriver)
    driver = relaunched.driver
    webdriver = relaunched.webdriver

    await assertGuestState(driver)
    approvedDeviceLink = null

    logSuccess('Desktop sign-out returns to guest mode')
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
