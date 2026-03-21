/**
 * R Baseline Validation: Mediation Analysis (PROCESS Model 4)
 * Validates mediation metrics against R baseline (mediation package)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runMediationModel4Test, waitForResults } from '../../utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Mediation Analysis (Model 4) R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'mediation_model4')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Mediation Analysis via UI...')
    await runMediationModel4Test(driver, {
      mapping: { outcome: 'y', predictor: 'x', mediator: 'm' }
    })

    await waitForResults(driver, 90000) // 90 seconds for bootstrap analysis

    // Bootstrap metrics use wider tolerance due to Monte Carlo variance; analytical metrics use 0.0001
    const comparison = await validateAgainstRBaseline(driver, 'mediation_model4', {
      defaultTolerance: 0.0001,
      bootstrapTolerance: 0.3,
      bootstrapMetrics: [
        'indirect_effect',
        'indirect_ci_lower',
        'indirect_ci_upper',
        'indirect_p',
        'direct_ci_lower',
        'direct_ci_upper',
        'direct_p',
        'total_ci_lower',
        'total_ci_upper',
        'prop_mediated',
        'prop_mediated_ci_lower',
        'prop_mediated_ci_upper'
      ]
    })
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)
  } catch (error) {
    console.error(`[Test] FAILED: ${error.message}`)
    throw error
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch(err => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
