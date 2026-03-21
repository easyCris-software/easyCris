/**
 * R Baseline Validation: Multiple Linear Regression
 * Validates metrics against R baseline
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture, loadRegressionConfig } from '../../utils/fixtures.mjs'
import { validateAgainstRBaseline, validatePlotAgainstRBaseline, exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runRegressionTest, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import { selectPlotFromGalleryByTitle } from '../../utils/plot-validation.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Multiple Linear Regression R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const config = loadRegressionConfig().multiple_linear_regression

    const fixture = await loadFixture(driver, 'multiple_linear_regression')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Multiple Linear Regression via UI...')
    driver.__dvSelectionOverride = config.dv
    driver.__factorEncodingOverride = config.factorBaselines
    await runRegressionTest(driver, 'multiple_linear_regression', [config.dv, ...config.predictors])

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'multiple_linear_regression', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting coefficient forest plot...')
    await selectPlotFromGalleryByTitle(driver, 'Coefficient Forest Plot')

    logStep('Exporting coefficient forest screenshot...')
    try {
      await exportPlotScreenshot(driver, 'multiple_linear_regression', 300, 'forest')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating coefficient forest plot metrics...')
    const forestComparison = await validatePlotAgainstRBaseline(driver, 'multiple_linear_regression', 'forest', 0.01)
    logSuccess(`All ${forestComparison.totalMetrics} forest metrics validated`)

    logStep('Selecting residual plot...')
    await selectPlotFromGalleryByTitle(driver, 'Residual vs Fitted')

    logStep('Exporting residual plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'multiple_linear_regression', 300, 'residual')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating residual plot metrics...')
    const residualComparison = await validatePlotAgainstRBaseline(driver, 'multiple_linear_regression', 'residual', 0.01)
    logSuccess(`All ${residualComparison.totalMetrics} residual metrics validated`)
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
