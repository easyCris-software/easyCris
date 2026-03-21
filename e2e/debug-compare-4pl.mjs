import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { loadRBaseline, extractStatsFromUI } from './utils/r-validation.mjs'
import { runDoseResponse4PL, waitForResults } from './utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver
  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    await loadFixture(driver, 'dose_response_4pl')
    await runDoseResponse4PL(driver, {})
    await waitForResults(driver)

    // Load baseline and extract from UI
    const baseline = await loadRBaseline('dose_response_4pl')
    const actual = await extractStatsFromUI(driver, 'dose_response_4pl')

    console.log('\n=== 4PL VALUE BY VALUE COMPARISON ===')
    console.log('Metric                 | R Baseline    | easyCris      | Diff        | % Diff  | Status')
    console.log('-----------------------|---------------|---------------|-------------|---------|-------')

    for (const [metric, expected] of Object.entries(baseline)) {
      if (typeof expected !== 'number') continue
      const actualVal = actual[metric]
      const diff = actualVal !== undefined ? Math.abs(actualVal - expected) : NaN
      const pctDiff = actualVal !== undefined && expected !== 0
        ? ((diff / Math.abs(expected)) * 100).toFixed(2) + '%'
        : 'N/A'

      // Check for sign issue (values are same magnitude but opposite sign)
      const signIssue = actualVal !== undefined &&
        Math.abs(Math.abs(actualVal) - Math.abs(expected)) < 0.001 &&
        actualVal * expected < 0

      const status = actualVal === undefined ? 'MISSING'
        : signIssue ? 'SIGN DIFF'
        : diff <= 0.0001 ? 'PASS'
        : diff <= Math.abs(expected) * 0.06 ? 'PASS ~6%'
        : 'FAIL'

      console.log(
        metric.padEnd(22) + ' | ' +
        expected.toString().padStart(13) + ' | ' +
        (actualVal?.toFixed(4) || 'NaN').padStart(13) + ' | ' +
        (diff?.toFixed(4) || 'N/A').padStart(11) + ' | ' +
        pctDiff.padStart(7) + ' | ' + status
      )
    }

  } finally {
    if (driver && webdriver) await cleanupTest(driver, webdriver)
  }
}

runTest().catch(err => { console.error(err); process.exit(1) })
