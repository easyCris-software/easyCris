/**
 * E2E Test: Grouped Bar Chart Validation
 *
 * Validates that grouped bar charts render correct grouped data matching R baseline.
 */

import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { loadPlotFixture } from '../../utils/fixtures.mjs'
import { createPlotFromData, waitForPlot } from '../../utils/plot-workflow.mjs'
import { loadPlotBaseline, getPlotStats, savePlotScreenshot } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Grouped Bar Chart E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture
    await loadPlotFixture(driver, 'grouped_bar')
    logStep('Loaded grouped bar chart fixture')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('grouped_bar_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_points} points, ${rBaseline.n_categories} categories, ${rBaseline.n_groups} groups`)

    // 3. Create grouped bar chart
    await createPlotFromData(driver, {
      plotType: 'grouped_bar',
      columns: { x: 'category', y: 'value', group: 'group' },
      title: 'Grouped Bar Chart Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')
    // Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'grouped_bar')

    // 5. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}, category_count=${stats.category_count}, group_count=${stats.group_count}`)

    // 6. Validate plot structure
    if (plotStats.plotType !== 'grouped_bar') {
      throw new Error(`Expected plot type 'grouped_bar', got '${plotStats.plotType}'`)
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

    logSuccess('Grouped bar chart validation passed')
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
