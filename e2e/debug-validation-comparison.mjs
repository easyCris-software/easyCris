/**
 * Debug: Show detailed value-by-value comparison for validation
 */

import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { loadRBaseline, extractStatsFromUI, compareToRBaseline } from './utils/r-validation.mjs'
import { logStep } from './utils/assertions.mjs'
import { runIndependentTTest, waitForResults } from './utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    await loadFixture(driver, 't_test_two_sample')
    await runIndependentTTest(driver)
    await waitForResults(driver)

    const baseline = await loadRBaseline('t_test_two_sample')
    const actual = await extractStatsFromUI(driver, 't_test_two_sample')
    const comparison = compareToRBaseline(actual, baseline, 0.0001)

    // Show ALL metrics sorted by pass/fail
    console.log('\n=== PASSING METRICS (13/37) ===')
    const passing = []
    const failing = []

    for (const [metric, expectedValue] of Object.entries(baseline)) {
      if (typeof expectedValue !== 'number') continue

      const actualValue = actual[metric]
      const diff = actualValue !== undefined ? Math.abs(actualValue - expectedValue) : NaN

      const status = {
        metric,
        expected: expectedValue,
        actual: actualValue ?? NaN,
        diff: diff,
        passed: diff <= 0.0001
      }

      if (status.passed) {
        passing.push(status)
      } else {
        failing.push(status)
      }
    }

    // Show passing
    for (const m of passing) {
      console.log(`  ✅ ${m.metric}: expected=${m.expected}, actual=${m.actual}, diff=${m.diff.toFixed(6)}`)
    }

    console.log('\n=== FAILING METRICS (24/37) ===')
    for (const m of failing) {
      console.log(`  ❌ ${m.metric}: expected=${m.expected}, actual=${m.actual}, diff=${m.diff.toFixed(6)}`)
    }

    console.log(`\n=== SUMMARY ===`)
    console.log(`Total: 37 metrics`)
    console.log(`Passing: ${passing.length}`)
    console.log(`Failing: ${failing.length}`)

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
