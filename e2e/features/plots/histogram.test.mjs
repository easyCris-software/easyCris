/**
 * E2E Test: Histogram Validation
 *
 * Validates that histograms render correct bins matching R baseline.
 */

import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { loadPlotFixture } from '../../utils/fixtures.mjs'
import { createPlotFromData, waitForPlot } from '../../utils/plot-workflow.mjs'
import { loadPlotBaseline, getPlotStats, savePlotScreenshot } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Histogram E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture
    await loadPlotFixture(driver, 'histogram')
    logStep('Loaded histogram fixture')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('histogram_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_points} points, ${rBaseline.bin_count} bins`)

    // 3. Create histogram
    await createPlotFromData(driver, {
      plotType: 'histogram',
      columns: { x: 'value' },
      title: 'Histogram Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')

    // 5. Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'histogram')

    // 6. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}, bin_count=${stats.bin_count}`)

    // 6. Validate plot structure
    if (plotStats.plotType !== 'histogram') {
      throw new Error(`Expected plot type 'histogram', got '${plotStats.plotType}'`)
    }
    if (plotStats.sourceType !== 'user_derived') {
      throw new Error(`Expected source type 'user_derived', got '${plotStats.sourceType}'`)
    }

    // 7. Validate data points (Plotly stores raw points, not bins)
    if (stats.n !== rBaseline.n_points) {
      throw new Error(`Point count mismatch: expected ${rBaseline.n_points}, got ${stats.n}`)
    }

    // 8. Validate bin count
    if (stats.bin_count !== rBaseline.bin_count) {
      throw new Error(`Bin count mismatch: expected ${rBaseline.bin_count}, got ${stats.bin_count}`)
    }

    // 9. Validate statistics (mean, std)
    const tolerance = 0.01
    if (stats.value_mean !== undefined && rBaseline.value_mean !== undefined) {
      const meanDiff = Math.abs(stats.value_mean - rBaseline.value_mean)
      if (meanDiff > tolerance) {
        throw new Error(`Value mean mismatch: expected ${rBaseline.value_mean}, got ${stats.value_mean} (diff: ${meanDiff})`)
      }
    }
    if (stats.value_std !== undefined && rBaseline.value_std !== undefined) {
      const stdDiff = Math.abs(stats.value_std - rBaseline.value_std)
      if (stdDiff > tolerance) {
        throw new Error(`Value std mismatch: expected ${rBaseline.value_std}, got ${stats.value_std} (diff: ${stdDiff})`)
      }
    }

    // 10. Validate KDE density curve stats
    const kdeTolerance = 0.01  // 1% relative tolerance for KDE
    if (stats.kde_bandwidth !== undefined && rBaseline.kde_bandwidth !== undefined) {
      const bandwidthRelDiff = Math.abs(stats.kde_bandwidth - rBaseline.kde_bandwidth) / rBaseline.kde_bandwidth
      if (bandwidthRelDiff > kdeTolerance) {
        throw new Error(`KDE bandwidth mismatch: expected ${rBaseline.kde_bandwidth.toFixed(4)}, got ${stats.kde_bandwidth.toFixed(4)} (rel diff: ${(bandwidthRelDiff * 100).toFixed(2)}%)`)
      }
    }
    if (stats.kde_points !== undefined && rBaseline.kde_points !== undefined) {
      if (stats.kde_points !== rBaseline.kde_points) {
        throw new Error(`KDE points mismatch: expected ${rBaseline.kde_points}, got ${stats.kde_points}`)
      }
    }
    if (stats.kde_max_density !== undefined && rBaseline.kde_max_density !== undefined) {
      const maxDensityRelDiff = Math.abs(stats.kde_max_density - rBaseline.kde_max_density) / rBaseline.kde_max_density
      if (maxDensityRelDiff > kdeTolerance) {
        throw new Error(`KDE max density mismatch: expected ${rBaseline.kde_max_density.toFixed(6)}, got ${stats.kde_max_density.toFixed(6)} (rel diff: ${(maxDensityRelDiff * 100).toFixed(2)}%)`)
      }
    }
    if (stats.kde_mean_density !== undefined && rBaseline.kde_mean_density !== undefined) {
      const meanDensityRelDiff = Math.abs(stats.kde_mean_density - rBaseline.kde_mean_density) / rBaseline.kde_mean_density
      if (meanDensityRelDiff > kdeTolerance) {
        throw new Error(`KDE mean density mismatch: expected ${rBaseline.kde_mean_density.toFixed(6)}, got ${stats.kde_mean_density.toFixed(6)} (rel diff: ${(meanDensityRelDiff * 100).toFixed(2)}%)`)
      }
    }

    logSuccess('Histogram + KDE density validation passed')
    logSuccess(`  Points: ${stats.n} (expected ${rBaseline.n_points})`)
    logSuccess(`  Bins: ${stats.bin_count} (expected ${rBaseline.bin_count})`)
    if (stats.value_mean !== undefined) {
      logSuccess(`  Value mean: ${stats.value_mean.toFixed(2)} (expected ${rBaseline.value_mean.toFixed(2)})`)
    }
    if (stats.value_std !== undefined) {
      logSuccess(`  Value std: ${stats.value_std.toFixed(2)} (expected ${rBaseline.value_std.toFixed(2)})`)
    }
    if (stats.kde_bandwidth !== undefined) {
      logSuccess(`  KDE bandwidth: ${stats.kde_bandwidth.toFixed(4)} (expected ${rBaseline.kde_bandwidth.toFixed(4)})`)
    }
    if (stats.kde_points !== undefined) {
      logSuccess(`  KDE points: ${stats.kde_points} (expected ${rBaseline.kde_points})`)
    }
    if (stats.kde_max_density !== undefined) {
      logSuccess(`  KDE max density: ${stats.kde_max_density.toFixed(6)} (expected ${rBaseline.kde_max_density.toFixed(6)})`)
    }
    if (stats.kde_mean_density !== undefined) {
      logSuccess(`  KDE mean density: ${stats.kde_mean_density.toFixed(6)} (expected ${rBaseline.kde_mean_density.toFixed(6)})`)
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
