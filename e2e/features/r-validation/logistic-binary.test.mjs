/**
 * R Baseline Validation: Binary Logistic Regression
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
    logStep('Starting Binary Logistic Regression R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const config = loadRegressionConfig().logistic_binary

    const fixture = await loadFixture(driver, 'logistic_binary')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Binary Logistic Regression via UI...')
    driver.__dvSelectionOverride = config.dv
    driver.__outcomeEncodingOverride = config.outcomeEncoding
    driver.__factorEncodingOverride = config.factorBaselines
    await runRegressionTest(driver, 'logistic_regression', [config.dv, ...config.predictors])

    await waitForResults(driver)

    // Use 1% relative tolerance for logistic regression (Wald Chi-Sq z² amplifies small z differences)
    const comparison = await validateAgainstRBaseline(driver, 'logistic_binary', 0.01)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting odds ratio forest plot...')
    await selectPlotFromGalleryByTitle(driver, 'Odds Ratio Forest Plot')

    logStep('Exporting odds ratio forest screenshot...')
    try {
      await exportPlotScreenshot(driver, 'logistic_binary', 300, 'forest')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating odds ratio forest plot metrics...')
    const forestComparison = await validatePlotAgainstRBaseline(driver, 'logistic_binary', 'forest', 0.01)
    logSuccess(`All ${forestComparison.totalMetrics} forest metrics validated`)

    logStep('Selecting ROC curve plot...')
    await selectPlotFromGalleryByTitle(driver, 'ROC Curve')

    logStep('Exporting ROC curve screenshot...')
    try {
      await exportPlotScreenshot(driver, 'logistic_binary', 300, 'roc')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating ROC curve plot metrics...')
    const rocComparison = await validatePlotAgainstRBaseline(driver, 'logistic_binary', 'scatter', 0.01)
    logSuccess(`All ${rocComparison.totalMetrics} ROC metrics validated`)
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
