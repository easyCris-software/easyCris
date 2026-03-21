/**
 * E2E Test: Line Chart Validation
 *
 * Validates that line charts render correct data points matching R baseline.
 */

import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { loadPlotFixture } from '../../utils/fixtures.mjs'
import { createPlotFromData, waitForPlot } from '../../utils/plot-workflow.mjs'
import { loadPlotBaseline, getPlotStats, savePlotScreenshot } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Line Chart E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture
    await loadPlotFixture(driver, 'line')
    logStep('Loaded line chart fixture')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('line_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_points} points`)

    // 3. Create line chart
    await createPlotFromData(driver, {
      plotType: 'line',
      columns: { x: 'x', y: 'y' },
      title: 'Line Chart Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')

    // 5. Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'line')

    // 6. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}`)

    // 6. Validate plot structure
    if (plotStats.plotType !== 'line') {
      throw new Error(`Expected plot type 'line', got '${plotStats.plotType}'`)
    }
    if (plotStats.sourceType !== 'user_derived') {
      throw new Error(`Expected source type 'user_derived', got '${plotStats.sourceType}'`)
    }

    // 7. Validate data points (compare stats to R baseline)
    if (stats.n !== rBaseline.n_points) {
      throw new Error(`Point count mismatch: expected ${rBaseline.n_points}, got ${stats.n}`)
    }

    // 8. Validate statistics (2 decimal tolerance)
    const tolerance = 0.01
    const xMeanDiff = Math.abs(stats.x_mean - rBaseline.x_mean)
    const yMeanDiff = Math.abs(stats.y_mean - rBaseline.y_mean)
    const xStdDiff = Math.abs(stats.x_std - rBaseline.x_std)
    const yStdDiff = Math.abs(stats.y_std - rBaseline.y_std)

    if (xMeanDiff > tolerance) {
      throw new Error(`X mean mismatch: expected ${rBaseline.x_mean}, got ${stats.x_mean} (diff: ${xMeanDiff})`)
    }
    if (yMeanDiff > tolerance) {
      throw new Error(`Y mean mismatch: expected ${rBaseline.y_mean}, got ${stats.y_mean} (diff: ${yMeanDiff})`)
    }
    if (xStdDiff > tolerance) {
      throw new Error(`X std mismatch: expected ${rBaseline.x_std}, got ${stats.x_std} (diff: ${xStdDiff})`)
    }
    if (yStdDiff > tolerance) {
      throw new Error(`Y std mismatch: expected ${rBaseline.y_std}, got ${stats.y_std} (diff: ${yStdDiff})`)
    }

    // 9. Validate correlation (if computed by plot builder)
    if (stats.correlation !== undefined && rBaseline.correlation !== undefined) {
      const corrDiff = Math.abs(stats.correlation - rBaseline.correlation)
      if (corrDiff > tolerance) {
        throw new Error(`Correlation mismatch: expected ${rBaseline.correlation}, got ${stats.correlation} (diff: ${corrDiff})`)
      }
    }

    logSuccess('Line chart validation passed')
    logSuccess(`  Points: ${stats.n} (expected ${rBaseline.n_points})`)
    logSuccess(`  X mean: ${stats.x_mean.toFixed(2)} (expected ${rBaseline.x_mean.toFixed(2)})`)
    logSuccess(`  Y mean: ${stats.y_mean.toFixed(2)} (expected ${rBaseline.y_mean.toFixed(2)})`)
    logSuccess(`  X std: ${stats.x_std.toFixed(2)} (expected ${rBaseline.x_std.toFixed(2)})`)
    logSuccess(`  Y std: ${stats.y_std.toFixed(2)} (expected ${rBaseline.y_std.toFixed(2)})`)
    if (stats.correlation !== undefined) {
      logSuccess(`  Correlation: ${stats.correlation.toFixed(3)} (expected ${rBaseline.correlation.toFixed(3)})`)
    }

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
