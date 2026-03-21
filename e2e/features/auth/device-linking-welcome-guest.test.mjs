import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { assertWelcomeGuestEntry } from '../../utils/device-auth-workflow.mjs'

async function runTest() {
  let driver
  let webdriver

  try {
    logStep('Starting first-launch guest entry verification...')
    const result = await setupTest({ resetAuth: true, showWelcome: true })
    driver = result.driver
    webdriver = result.webdriver

    await assertWelcomeGuestEntry(driver)

    logSuccess('First-launch guest entry remains available')
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver, { resetAuth: true, showWelcome: true })
    }
  }
}

runTest().catch((error) => {
  console.error('[Test] Execution failed:', error)
  process.exit(1)
})
