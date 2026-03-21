/**
 * E2E Test: Q-Q Plot Statistics Validation
 *
 * Tests that Q-Q plots contain correct computed statistics
 * (mean, std, n for the sample data).
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'
import { waitForResults } from '../../utils/ui-workflow.mjs'
import {
  navigateToPlots,
  waitForPlot,
  extractPlotStats
} from '../../utils/plot-validation.mjs'
import { By, until } from 'selenium-webdriver'

async function runNormalityTest(driver, options) {
  const { valueColumn } = options

  // Open test selector
  const testSelector = await driver.wait(
    until.elementLocated(By.css('[data-testid="test-selector"]')),
    5000
  )
  await testSelector.click()

  // Select normality test
  const normalityOption = await driver.wait(
    until.elementLocated(By.css('[data-value="normality_shapiro"], [data-testid="normality_shapiro"]')),
    5000
  )
  await normalityOption.click()

  // Select value column
  const valueDropdown = await driver.wait(
    until.elementLocated(By.css('[data-testid="value-column-select"]')),
    5000
  )
  await valueDropdown.click()

  const valueOption = await driver.wait(
    until.elementLocated(By.css(`[data-value="${valueColumn}"]`)),
    5000
  )
  await valueOption.click()

  // Run test
  const runButton = await driver.wait(
    until.elementLocated(By.css('[data-testid="run-test-button"]')),
    5000
  )
  await runButton.click()
}

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Q-Q Plot E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    // Load a fixture with numeric data
    const fixture = await loadFixture(driver, 'normality_all')
    logStep('Loaded normality fixture')

    // Run normality test to generate Q-Q plot
    logStep('Running normality test to generate Q-Q plot...')
    await runNormalityTest(driver, {
      valueColumn: 'values'
    })

    await waitForResults(driver)
    logStep('Normality test completed')

    // Navigate to plots panel
    await navigateToPlots(driver)

    // Wait for plot to render
    await waitForPlot(driver)
    await savePlotScreenshot(driver, 'qq-plot')

    // Extract plot statistics
    const plotData = await extractPlotStats(driver)

    // Verify Q-Q plot statistics
    const stats = plotData.stats || {}
    const statCount = Object.keys(stats).length

    if (statCount === 0) {
      logFailure('No statistics extracted from Q-Q plot')
      throw new Error('Q-Q plot has no computed statistics')
    }

    logSuccess(`Q-Q plot has ${statCount} computed statistics`)

    // Log statistics
    console.log('[Q-Q Plot] Computed statistics:')
    for (const [key, value] of Object.entries(stats)) {
      console.log(`  ${key}: ${value}`)
    }

    // Q-Q plot should have mean, std, n
    const requiredStats = ['mean', 'std', 'n']
    const missingStats = requiredStats.filter(s => !(s in stats))

    if (missingStats.length > 0) {
      logFailure(`Q-Q plot missing required statistics: ${missingStats.join(', ')}`)
      throw new Error(`Missing statistics: ${missingStats.join(', ')}`)
    }

    logSuccess('Q-Q plot validation passed')

  } catch (error) {
    logFailure(`Test failed: ${error.message}`)
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
