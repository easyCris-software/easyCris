/**
 * R Baseline Validation: Moderated Mediation (PROCESS Model 7)
 * Validates moderated mediation metrics against R baseline (mediation package with covariates)
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runModeratedMediationModel7Test, waitForResults } from '../../utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Moderated Mediation (Model 7) R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const fixture = await loadFixture(driver, 'moderated_mediation_model7')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Moderated Mediation via UI...')
    await runModeratedMediationModel7Test(driver, {
      mapping: { outcome: 'y', predictor: 'x', mediator: 'm', moderator: 'w' }
    })

    await waitForResults(driver, 90000) // 90 seconds for bootstrap analysis

    // Bootstrap metrics use wider tolerance due to Monte Carlo variance; analytical metrics use 0.0001
    const comparison = await validateAgainstRBaseline(driver, 'moderated_mediation_model7', {
      defaultTolerance: 0.0001,
      bootstrapTolerance: 0.2,
      bootstrapMetrics: [
        'indirect_low_w',
        'indirect_low_ci_lower',
        'indirect_low_ci_upper',
        'indirect_low_p',
        'indirect_high_w',
        'indirect_high_ci_lower',
        'indirect_high_ci_upper',
        'indirect_high_p',
        'index_mod_med'  // Bootstrap-derived, use 0.01 tolerance
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
