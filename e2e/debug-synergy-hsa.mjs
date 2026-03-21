import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { loadRBaseline, extractStatsFromUI } from './utils/r-validation.mjs'
import { runSynergyHSA, waitForResults } from './utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver
  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    await loadFixture(driver, 'synergy_hsa')
    await runSynergyHSA(driver, {})
    await waitForResults(driver)

    // Load baseline and extract from UI
    const baseline = await loadRBaseline('synergy_hsa')
    const actual = await extractStatsFromUI(driver, 'synergy_hsa')

    console.log('\n=== SYNERGY HSA VALUE BY VALUE ===')
    console.log('Metric                 | R Baseline    | easyCris      | Diff        | % Diff  | Status')
    console.log('-----------------------|---------------|---------------|-------------|---------|-------')

    for (const [metric, expected] of Object.entries(baseline)) {
      if (typeof expected !== 'number') continue
      const actualVal = actual[metric]
      const diff = actualVal !== undefined ? Math.abs(actualVal - expected) : NaN
      const pctDiff = actualVal !== undefined && expected !== 0
        ? ((diff / Math.abs(expected)) * 100).toFixed(2) + '%'
        : 'N/A'

      const status = actualVal === undefined ? 'MISSING'
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

    // Debug: Show all extracted metrics
    console.log('\n=== ALL EXTRACTED METRICS ===')
    console.log(JSON.stringify(actual, null, 2))

  } finally {
    if (driver && webdriver) await cleanupTest(driver, webdriver)
  }
}

runTest().catch(err => { console.error(err); process.exit(1) })
