import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { loadRBaseline, extractStatsFromUI } from './utils/r-validation.mjs'
import { runDoseResponse3PL, waitForResults } from './utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver
  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    await loadFixture(driver, 'dose_response_3pl')
    await runDoseResponse3PL(driver, {})
    await waitForResults(driver)

    // Load baseline and extract from UI
    const baseline = await loadRBaseline('dose_response_3pl')
    const actual = await extractStatsFromUI(driver, 'dose_response_3pl')

    console.log('\n=== VALUE BY VALUE COMPARISON ===')
    console.log('Metric                 | R Baseline    | easyCris      | Diff        | % Diff')
    console.log('-----------------------|---------------|---------------|-------------|--------')

    for (const [metric, expected] of Object.entries(baseline)) {
      if (typeof expected !== 'number') continue
      const actualVal = actual[metric]
      const diff = actualVal !== undefined ? Math.abs(actualVal - expected) : NaN
      const pctDiff = actualVal !== undefined && expected !== 0
        ? ((diff / Math.abs(expected)) * 100).toFixed(2) + '%'
        : 'N/A'
      const status = actualVal === undefined ? 'MISSING'
        : diff <= 0.0001 ? 'PASS'
        : diff <= expected * 0.06 ? 'WARN ~6%'
        : 'FAIL'
      console.log(
        metric.padEnd(22) + ' | ' +
        expected.toString().padStart(13) + ' | ' +
        (actualVal?.toFixed(4) || 'NaN').padStart(13) + ' | ' +
        (diff?.toFixed(4) || 'N/A').padStart(11) + ' | ' +
        pctDiff.padStart(6) + ' | ' + status
      )
    }

    console.log('\n=== TOLERANCE ISSUE ===')
    console.log('Current tolerance: 0.06 (ABSOLUTE)')
    console.log('AIC diff: 2.0 > 0.06 absolute → FAILS (but 2.5% relative → would PASS at 6%)')
    console.log('BIC diff: 2.89 > 0.06 absolute → FAILS (but 3.5% relative → would PASS at 6%)')

  } finally {
    if (driver && webdriver) await cleanupTest(driver, webdriver)
  }
}

runTest().catch(err => { console.error(err); process.exit(1) })
