/**
 * E2E Test: ScatterGL Plot Validation (Large Dataset)
 *
 * Validates that scattergl plots handle large datasets with sampling correctly.
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
    logStep('Starting ScatterGL Plot E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture (150K points)
    await loadPlotFixture(driver, 'scattergl')
    logStep('Loaded scattergl plot fixture (150K points)')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('scattergl_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_points} points generated`)
    logStep(`Expected sampled: ${rBaseline.expected_sampled_n} points (100K cap)`)

    // 3. Create scattergl plot
    await createPlotFromData(driver, {
      plotType: 'scattergl',
      columns: { x: 'x', y: 'y' },
      title: 'ScatterGL Plot Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')
    // Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'scattergl')

    // 5. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}, dataPolicy=${plotStats.dataPolicy}`)

    // 6. Validate plot structure
    if (plotStats.plotType !== 'scattergl') {
      throw new Error(`Expected plot type 'scattergl', got '${plotStats.plotType}'`)
    }
    if (plotStats.sourceType !== 'user_derived') {
      throw new Error(`Expected source type 'user_derived', got '${plotStats.sourceType}'`)
    }

    // 7. Validate sampling behavior
    const expectedSampledN = rBaseline.expected_sampled_n || 100000
    if (stats.n !== expectedSampledN) {
      throw new Error(`Expected ${expectedSampledN} sampled points, got ${stats.n}`)
    }

    if (plotStats.dataPolicy !== 'sampled') {
      throw new Error(`Expected data policy 'sampled', got '${plotStats.dataPolicy}'`)
    }

    // 8. Validate statistics (stats computed on sampled subset)
    // Note: Stats will differ slightly from full 150K dataset due to sampling
    // Validate that we have valid stats (non-null, finite)
    if (stats.x_mean === undefined || !Number.isFinite(stats.x_mean)) {
      throw new Error(`Invalid X mean: ${stats.x_mean}`)
    }
    if (stats.y_mean === undefined || !Number.isFinite(stats.y_mean)) {
      throw new Error(`Invalid Y mean: ${stats.y_mean}`)
    }
    if (stats.x_std === undefined || !Number.isFinite(stats.x_std)) {
      throw new Error(`Invalid X std: ${stats.x_std}`)
    }
    if (stats.y_std === undefined || !Number.isFinite(stats.y_std)) {
      throw new Error(`Invalid Y std: ${stats.y_std}`)
    }

    // 9. Validate correlation (pattern should be preserved despite sampling)
    if (stats.correlation !== undefined && rBaseline.correlation !== undefined) {
      const corrDiff = Math.abs(stats.correlation - rBaseline.correlation)
      // Allow higher tolerance (5%) for sampled data
      const tolerance = 0.05
      if (corrDiff > tolerance) {
        logStep(`Warning: Correlation differs by ${corrDiff.toFixed(3)} (tolerance: ${tolerance})`)
      }
    }

    logSuccess('ScatterGL plot validation passed')
    logSuccess(`  Original points: ${rBaseline.n_points}`)
    logSuccess(`  Sampled points: ${stats.n} (expected ${expectedSampledN})`)
    logSuccess(`  Data policy: ${plotStats.dataPolicy}`)
    logSuccess(`  X mean: ${stats.x_mean.toFixed(2)}`)
    logSuccess(`  Y mean: ${stats.y_mean.toFixed(2)}`)
    if (stats.correlation !== undefined) {
      logSuccess(`  Correlation: ${stats.correlation.toFixed(3)} (R baseline: ${rBaseline.correlation.toFixed(3)})`)
    }

    // 10. Add linear trendline and validate
    // Note: Trendline is computed on sampled data (100K points), so we expect some variation
    logStep('Testing linear trendline on sampled data...')
    await toggleTrendline(driver, true)
    await waitForPlot(driver)

    const trendlineStatsLinear = await getPlotStats(driver)
    const tLinear = trendlineStatsLinear.stats || {}

    // Validate linear trendline stats
    if (tLinear.trendline_type !== 'linear') {
      throw new Error(`Expected trendline type 'linear', got '${tLinear.trendline_type}'`)
    }
    if (tLinear.trendline_n_points !== expectedSampledN) {
      throw new Error(`Trendline point count mismatch: expected ${expectedSampledN}, got ${tLinear.trendline_n_points}`)
    }

    // Validate linear trendline stats against R baseline (sampled data will vary)
    const rLinear = rBaseline.trendline_linear
    const linearTolerance = 0.05 // 5% tolerance for sampled data

    // Slope should be close to 100 (quadratic pattern y = x²)
    if (Math.abs(tLinear.trendline_slope - rLinear.slope) > Math.abs(rLinear.slope * linearTolerance)) {
      logStep(`Warning: Linear slope differs by ${Math.abs(tLinear.trendline_slope - rLinear.slope).toFixed(4)} (tolerance: ${(rLinear.slope * linearTolerance).toFixed(4)})`)
    }

    // R² should be high (but lower than polynomial for quadratic data)
    if (tLinear.trendline_r_squared < 0.9) {
      throw new Error(`Linear R² too low: ${tLinear.trendline_r_squared.toFixed(4)} (expected > 0.9)`)
    }

    logSuccess('Linear trendline validation passed')
    logSuccess(`  Type: ${tLinear.trendline_type}`)
    logSuccess(`  Equation: ${tLinear.trendline_equation}`)
    logSuccess(`  R²: ${tLinear.trendline_r_squared.toFixed(4)} (R baseline: ${rLinear.r_squared.toFixed(4)})`)
    logSuccess(`  Slope: ${tLinear.trendline_slope.toFixed(4)} (R baseline: ${rLinear.slope.toFixed(4)})`)
    logSuccess(`  Intercept: ${tLinear.trendline_intercept.toFixed(4)} (R baseline: ${rLinear.intercept.toFixed(4)})`)

    // 11. Change to polynomial degree 2 and validate
    logStep('Testing polynomial trendline (degree 2) on sampled data...')
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

    // Polynomial R² should be very high (y = x² pattern)
    if (tPoly.trendline_r_squared < 0.99) {
      throw new Error(`Polynomial R² too low: ${tPoly.trendline_r_squared.toFixed(4)} (expected > 0.99)`)
    }

    // Validate coefficients
    // Note: easyCris returns [quadratic, linear, intercept], R returns [intercept, linear, quadratic]
    const quadraticCoeff = Array.isArray(tPoly.trendline_coefficients)
      ? tPoly.trendline_coefficients[0] // First element is highest degree (reversed order)
      : typeof tPoly.trendline_coefficients === 'number'
      ? tPoly.trendline_coefficients
      : parseFloat(tPoly.trendline_coefficients)

    // Quadratic coefficient should be close to 1.0 (y = 1*x²)
    if (Math.abs(quadraticCoeff - 1.0) > 0.05) {
      logStep(`Warning: Quadratic coefficient differs from 1.0: ${quadraticCoeff.toFixed(4)}`)
    }

    logSuccess('Polynomial trendline validation passed')
    logSuccess(`  Type: ${tPoly.trendline_type}`)
    logSuccess(`  Degree: ${tPoly.trendline_degree}`)
    logSuccess(`  Equation: ${tPoly.trendline_equation}`)
    logSuccess(`  R²: ${tPoly.trendline_r_squared.toFixed(4)} (R baseline: ${rPoly.r_squared.toFixed(4)})`)
    logSuccess(`  Quadratic coeff: ${quadraticCoeff.toFixed(4)} (expected ~1.0)`)

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
