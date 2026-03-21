/**
 * E2E Test: Scatter Plot Validation
 *
 * Validates that scatter plots render correct data points matching R baseline.
 */

import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { loadPlotFixture } from '../../utils/fixtures.mjs'
import {
  createPlotFromData,
  waitForPlot,
  toggleTrendline,
  changeTrendlineType,
  changeTrendlineDegree,
} from '../../utils/plot-workflow.mjs'
import { loadPlotBaseline, getPlotStats, savePlotScreenshot } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Scatter Plot E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture
    await loadPlotFixture(driver, 'scatter')
    logStep('Loaded scatter plot fixture')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('scatter_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_points} points`)

    // 3. Create scatter plot
    await createPlotFromData(driver, {
      plotType: 'scatter',
      columns: { x: 'x', y: 'y' },
      title: 'Scatter Plot Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')

    // 5. Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'scatter')

    // 6. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}`)

    // 7. Validate plot structure
    if (plotStats.plotType !== 'scatter') {
      throw new Error(`Expected plot type 'scatter', got '${plotStats.plotType}'`)
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

    logSuccess('Scatter plot validation passed')
    logSuccess(`  Points: ${stats.n} (expected ${rBaseline.n_points})`)
    logSuccess(`  X mean: ${stats.x_mean.toFixed(2)} (expected ${rBaseline.x_mean.toFixed(2)})`)
    logSuccess(`  Y mean: ${stats.y_mean.toFixed(2)} (expected ${rBaseline.y_mean.toFixed(2)})`)
    logSuccess(`  X std: ${stats.x_std.toFixed(2)} (expected ${rBaseline.x_std.toFixed(2)})`)
    logSuccess(`  Y std: ${stats.y_std.toFixed(2)} (expected ${rBaseline.y_std.toFixed(2)})`)
    if (stats.correlation !== undefined) {
      logSuccess(`  Correlation: ${stats.correlation.toFixed(3)} (expected ${rBaseline.correlation.toFixed(3)})`)
    }

    // 10. Add linear trendline and validate
    logStep('Testing linear trendline...')
    await toggleTrendline(driver, true)
    await waitForPlot(driver)

    const trendlineStatsLinear = await getPlotStats(driver)
    const tLinear = trendlineStatsLinear.stats || {}

    // Validate linear trendline stats
    if (tLinear.trendline_type !== 'linear') {
      throw new Error(`Expected trendline type 'linear', got '${tLinear.trendline_type}'`)
    }
    if (tLinear.trendline_n_points !== rBaseline.n_points) {
      throw new Error(`Trendline point count mismatch: expected ${rBaseline.n_points}, got ${tLinear.trendline_n_points}`)
    }

    // Validate linear trendline stats against R baseline
    const rLinear = rBaseline.trendline_linear
    const linearTolerance = 0.01 // 1% tolerance for slope/intercept/r²

    if (Math.abs(tLinear.trendline_slope - rLinear.slope) > linearTolerance) {
      throw new Error(`Linear slope mismatch: expected ${rLinear.slope.toFixed(4)}, got ${tLinear.trendline_slope.toFixed(4)}`)
    }
    if (Math.abs(tLinear.trendline_intercept - rLinear.intercept) > linearTolerance) {
      throw new Error(`Linear intercept mismatch: expected ${rLinear.intercept.toFixed(4)}, got ${tLinear.trendline_intercept.toFixed(4)}`)
    }
    if (Math.abs(tLinear.trendline_r_squared - rLinear.r_squared) > linearTolerance) {
      throw new Error(`Linear R² mismatch: expected ${rLinear.r_squared.toFixed(4)}, got ${tLinear.trendline_r_squared.toFixed(4)}`)
    }

    logSuccess('Linear trendline validation passed')
    logSuccess(`  Type: ${tLinear.trendline_type}`)
    logSuccess(`  Equation: ${tLinear.trendline_equation}`)
    logSuccess(`  R²: ${tLinear.trendline_r_squared.toFixed(4)} (expected ${rLinear.r_squared.toFixed(4)})`)
    logSuccess(`  Slope: ${tLinear.trendline_slope.toFixed(4)} (expected ${rLinear.slope.toFixed(4)})`)
    logSuccess(`  Intercept: ${tLinear.trendline_intercept.toFixed(4)} (expected ${rLinear.intercept.toFixed(4)})`)

    // 11. Change to polynomial degree 2 and validate
    logStep('Testing polynomial trendline (degree 2)...')
    await changeTrendlineType(driver, 'polynomial')
    await waitForPlot(driver)

    const trendlineStatsPoly = await getPlotStats(driver)
    const tPoly = trendlineStatsPoly.stats || {}

    // Validate polynomial trendline stats
    if (tPoly.trendline_type !== 'polynomial') {
      throw new Error(`Expected trendline type 'polynomial', got '${tPoly.trendline_type}'`)
    }
    if (tPoly.trendline_degree !== 2) {
      throw new Error(`Expected degree 2, got ${tPoly.trendline_degree}`)
    }

    // Validate polynomial trendline stats against R baseline
    const rPoly = rBaseline.trendline_poly2
    const polyTolerance = 0.01 // 1% tolerance for coefficients/r²

    if (Math.abs(tPoly.trendline_r_squared - rPoly.r_squared) > polyTolerance) {
      throw new Error(`Polynomial R² mismatch: expected ${rPoly.r_squared.toFixed(4)}, got ${tPoly.trendline_r_squared.toFixed(4)}`)
    }

    // Validate highest-degree coefficient (quadratic term)
    // Note: easyCris returns [quadratic, linear, intercept], R returns [intercept, linear, quadratic]
    const quadraticCoeff = Array.isArray(tPoly.trendline_coefficients)
      ? tPoly.trendline_coefficients[0] // First element is highest degree (reversed order)
      : typeof tPoly.trendline_coefficients === 'number'
      ? tPoly.trendline_coefficients
      : parseFloat(tPoly.trendline_coefficients)

    const rQuadraticCoeff = rPoly.coefficients[2] // R baseline: [intercept, linear, quadratic]

    if (Math.abs(quadraticCoeff - rQuadraticCoeff) > polyTolerance) {
      throw new Error(`Quadratic coefficient mismatch: expected ${rQuadraticCoeff.toFixed(6)}, got ${quadraticCoeff.toFixed(6)}`)
    }

    logSuccess('Polynomial trendline validation passed')
    logSuccess(`  Type: ${tPoly.trendline_type}`)
    logSuccess(`  Degree: ${tPoly.trendline_degree}`)
    logSuccess(`  Equation: ${tPoly.trendline_equation}`)
    logSuccess(`  R²: ${tPoly.trendline_r_squared.toFixed(4)} (expected ${rPoly.r_squared.toFixed(4)})`)
    logSuccess(`  Quadratic coeff: ${quadraticCoeff.toFixed(6)} (expected ${rQuadraticCoeff.toFixed(6)})`)

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
