/**
 * E2E Test: Stacked Bar Chart Validation
 *
 * Validates that stacked bar charts render correct stacked data matching R baseline.
 */

import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { loadPlotFixture } from '../../utils/fixtures.mjs'
import { createPlotFromData, waitForPlot } from '../../utils/plot-workflow.mjs'
import { loadPlotBaseline, getPlotStats, savePlotScreenshot } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Stacked Bar Chart E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture
    await loadPlotFixture(driver, 'stacked_bar')
    logStep('Loaded stacked bar chart fixture')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('stacked_bar_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_points} points, ${rBaseline.n_categories} categories, ${rBaseline.n_groups} groups`)

    // 3. Create stacked bar chart
    await createPlotFromData(driver, {
      plotType: 'stacked_bar',
      columns: { x: 'category', y: 'value', color: 'group' },
      title: 'Stacked Bar Chart Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')
    // Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'stacked_bar')

    // 5. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}, category_count=${stats.category_count}, group_count=${stats.group_count}`)

    // 6. Validate plot structure
    if (plotStats.plotType !== 'stacked_bar') {
      throw new Error(`Expected plot type 'stacked_bar', got '${plotStats.plotType}'`)
    }
    if (plotStats.sourceType !== 'user_derived') {
      throw new Error(`Expected source type 'user_derived', got '${plotStats.sourceType}'`)
    }

    // 7. Validate data points
    if (stats.n !== rBaseline.n_points) {
      throw new Error(`Point count mismatch: expected ${rBaseline.n_points}, got ${stats.n}`)
    }

    // 8. Validate category count
    if (stats.category_count !== rBaseline.n_categories) {
      throw new Error(`Category count mismatch: expected ${rBaseline.n_categories}, got ${stats.category_count}`)
    }

    // 9. Validate group count
    if (stats.group_count !== rBaseline.n_groups) {
      throw new Error(`Group count mismatch: expected ${rBaseline.n_groups}, got ${stats.group_count}`)
    }

    // 10. Validate value statistics
    const tolerance = 0.01
    if (stats.value_sum !== undefined && rBaseline.value_sum !== undefined) {
      const sumDiff = Math.abs(stats.value_sum - rBaseline.value_sum)
      if (sumDiff > tolerance) {
        throw new Error(`Value sum mismatch: expected ${rBaseline.value_sum}, got ${stats.value_sum} (diff: ${sumDiff})`)
      }
    }
    if (stats.value_mean !== undefined && rBaseline.value_mean !== undefined) {
      const meanDiff = Math.abs(stats.value_mean - rBaseline.value_mean)
      if (meanDiff > tolerance) {
        throw new Error(`Value mean mismatch: expected ${rBaseline.value_mean}, got ${stats.value_mean} (diff: ${meanDiff})`)
      }
    }

    logSuccess('Stacked bar chart validation passed')
    logSuccess(`  Points: ${stats.n} (expected ${rBaseline.n_points})`)
    logSuccess(`  Categories: ${stats.category_count} (expected ${rBaseline.n_categories})`)
    logSuccess(`  Groups: ${stats.group_count} (expected ${rBaseline.n_groups})`)
    if (stats.value_sum !== undefined) {
      logSuccess(`  Value sum: ${stats.value_sum} (expected ${rBaseline.value_sum})`)
    }
    if (stats.value_mean !== undefined) {
      logSuccess(`  Value mean: ${stats.value_mean.toFixed(2)} (expected ${rBaseline.value_mean.toFixed(2)})`)
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
