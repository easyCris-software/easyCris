/**
 * R Baseline Validation: Simple Linear Regression
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
    logStep('Starting Simple Linear Regression R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const config = loadRegressionConfig().linear_regression

    const fixture = await loadFixture(driver, 'linear_regression')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Simple Linear Regression via UI...')
    driver.__dvSelectionOverride = config.dv
    driver.__factorEncodingOverride = config.factorBaselines
    await runRegressionTest(driver, 'linear_regression', [config.dv, ...config.predictors])

    await waitForResults(driver)

    const comparison = await validateAgainstRBaseline(driver, 'linear_regression', 0.0001)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting regression scatter plot...')
    await selectPlotFromGalleryByTitle(driver, 'Regression Scatter with Fit')

    logStep('Exporting regression scatter screenshot...')
    try {
      await exportPlotScreenshot(driver, 'linear_regression', 300, 'scatter')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating regression scatter plot metrics...')
    const scatterComparison = await validatePlotAgainstRBaseline(driver, 'linear_regression', 'scatter', 0.01)
    logSuccess(`All ${scatterComparison.totalMetrics} scatter metrics validated`)

    logStep('Selecting residual plot...')
    await selectPlotFromGalleryByTitle(driver, 'Residual vs Fitted')

    logStep('Exporting residual plot screenshot...')
    try {
      await exportPlotScreenshot(driver, 'linear_regression', 300, 'residual')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating residual plot metrics...')
    const residualComparison = await validatePlotAgainstRBaseline(driver, 'linear_regression', 'residual', 0.01)
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
