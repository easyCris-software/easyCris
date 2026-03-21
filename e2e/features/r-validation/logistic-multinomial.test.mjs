/**
 * R Baseline Validation: Multinomial Logistic Regression
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
    logStep('Starting Multinomial Logistic Regression R validation...')

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver
    await verifyCleanState(driver)

    const config = loadRegressionConfig().logistic_multinomial

    const fixture = await loadFixture(driver, 'logistic_multinomial')
    logStep(`Loaded fixture with ${fixture.validatedMetrics} expected metrics`)

    logStep('Running Multinomial Logistic Regression via UI...')
    driver.__dvSelectionOverride = config.dv
    driver.__outcomeEncodingOverride = config.outcomeEncoding
    driver.__factorEncodingOverride = config.factorBaselines
    await runRegressionTest(driver, 'logistic_multinomial', [config.dv, ...config.predictors])

    await waitForResults(driver, 60000)

    // Use 1% relative tolerance for logistic regression (Wald Chi-Sq z² amplifies small z differences)
    const comparison = await validateAgainstRBaseline(driver, 'logistic_multinomial', 0.01)
    logSuccess(`All ${comparison.totalMetrics} metrics validated`)

    logStep('Switching to Plots tab...')
    await switchToPlotsTab(driver)

    logStep('Selecting odds ratio forest plot...')
    await selectPlotFromGalleryByTitle(driver, 'Odds Ratio Forest Plot by Class')

    logStep('Exporting odds ratio forest screenshot...')
    try {
      await exportPlotScreenshot(driver, 'logistic_multinomial', 300, 'forest')
    } catch (e) {
      console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
    }

    logStep('Validating odds ratio forest plot metrics...')
    const forestComparison = await validatePlotAgainstRBaseline(driver, 'logistic_multinomial', 'forest', 0.01)
    logSuccess(`All ${forestComparison.totalMetrics} forest metrics validated`)

    let rocSelected = false
    try {
      logStep('Selecting ROC curves plot...')
      await selectPlotFromGalleryByTitle(driver, 'ROC Curves (One-vs-Rest)')
      rocSelected = true
    } catch (e) {
      console.warn('[Test] ROC curves plot not found, falling back to predicted probabilities:', e.message)
    }

    if (rocSelected) {
      logStep('Exporting ROC curves screenshot...')
      try {
        await exportPlotScreenshot(driver, 'logistic_multinomial', 300, 'roc')
      } catch (e) {
        console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
      }

      logStep('Validating ROC curves plot metrics...')
      const rocComparison = await validatePlotAgainstRBaseline(driver, 'logistic_multinomial', 'scatter', 0.01)
      logSuccess(`All ${rocComparison.totalMetrics} ROC metrics validated`)
    } else {
      logStep('Selecting predicted probabilities plot...')
      await selectPlotFromGalleryByTitle(driver, 'Predicted Probabilities')

      logStep('Exporting predicted probabilities screenshot...')
      try {
        await exportPlotScreenshot(driver, 'logistic_multinomial', 300, 'probabilities')
      } catch (e) {
        console.warn('[Test] Screenshot export failed (non-fatal):', e.message)
      }

      logStep('Validating predicted probabilities plot metrics...')
      const probComparison = await validatePlotAgainstRBaseline(driver, 'logistic_multinomial', 'line', 0.01)
      logSuccess(`All ${probComparison.totalMetrics} probability metrics validated`)
    }
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
