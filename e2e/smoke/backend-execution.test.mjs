/**
 * Smoke Test: Backend Execution (Release-safe command-level)
 * Verifies the Rust command bridge can execute a real statistical backend call
 * without depending on renderer store globals or E2E shim APIs.
 */

import { until } from 'selenium-webdriver'
import { setupTest, cleanupTest } from '../utils/selenium-setup.mjs'
import { logStep, logSuccess, assertTrue } from '../utils/assertions.mjs'

async function invokeTauriCommand(driver, command, payload = {}) {
  const response = await driver.executeAsyncScript((cmd, args, done) => {
    const internalInvoke = window.__TAURI_INTERNALS__?.invoke
    const publicInvoke = window.__TAURI__?.core?.invoke
    const invoke = typeof internalInvoke === 'function'
      ? internalInvoke
      : (typeof publicInvoke === 'function' ? publicInvoke : null)

    if (!invoke) {
      done({
        ok: false,
        error: 'No Tauri invoke bridge found in renderer context',
      })
      return
    }

    Promise.resolve(invoke(cmd, args))
      .then((result) => done({ ok: true, result }))
      .catch((error) => {
        done({
          ok: false,
          error: String(error?.message || error),
          details: error ?? null,
        })
      })
  }, command, payload)

  return response
}

async function runTest() {
  let driver, webdriver
  try {
    logStep('Starting backend execution smoke test (command-level)...')
    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver

    await driver.wait(until.elementLocated({ css: '[data-testid="app-loaded"]' }), 10000)

    const availableTests = await invokeTauriCommand(driver, 'get_available_tests', {})
    assertTrue(availableTests?.ok, `get_available_tests failed: ${availableTests?.error || 'unknown error'}`)
    assertTrue(Array.isArray(availableTests?.result), 'get_available_tests did not return an array')
    assertTrue(availableTests.result.length > 0, 'get_available_tests returned no tests')
    assertTrue(
      availableTests.result.some((test) => test?.name === 'independent_ttest'),
      'independent_ttest is missing from available tests'
    )
    logStep(`get_available_tests returned ${availableTests.result.length} entries`)

    const runResult = await invokeTauriCommand(driver, 'run_statistical_test', {
      testName: 'independent_ttest',
      data: { group1: [1.2, 2.3, 3.1], group2: [4.1, 5.2, 4.8] },
      parameters: { alpha: 0.05, equal_var: true },
      arrowDataPath: null,
    })

    assertTrue(
      runResult?.ok,
      `run_statistical_test failed: ${runResult?.error || 'unknown error'} ${runResult?.details ? JSON.stringify(runResult.details) : ''}`
    )
    assertTrue(
      runResult?.result && typeof runResult.result === 'object',
      'run_statistical_test did not return an object result'
    )
    assertTrue(
      !('success' in runResult.result) || runResult.result.success !== false,
      `run_statistical_test returned backend error payload: ${JSON.stringify(runResult.result)}`
    )
    logSuccess('Backend execution smoke passed (command-level invoke)')
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch(err => {
  console.error('[Test] FAILED:', err.message)
  process.exit(1)
})
