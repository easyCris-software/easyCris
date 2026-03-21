/**
 * E2E Test: Pie Chart Validation
 *
 * Validates that pie charts render correct proportions matching R baseline.
 */

import { setupTest, cleanupTest } from '../../utils/selenium-setup.mjs'
import { loadPlotFixture } from '../../utils/fixtures.mjs'
import { createPlotFromData, waitForPlot } from '../../utils/plot-workflow.mjs'
import { loadPlotBaseline, getPlotStats, savePlotScreenshot } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, logFailure } from '../../utils/assertions.mjs'

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Pie Chart E2E validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    // 1. Load fixture
    await loadPlotFixture(driver, 'pie')
    logStep('Loaded pie chart fixture')

    // 2. Load R baseline
    const rBaseline = loadPlotBaseline('pie_r_baseline.json')
    logStep(`R baseline: ${rBaseline.n_slices} slices`)

    // 3. Create pie chart
    await createPlotFromData(driver, {
      plotType: 'pie',
      columns: { theta: 'value', color: 'category' },
      title: 'Pie Chart Validation'
    })

    // 4. Wait for plot to render
    await waitForPlot(driver)
    logStep('Plot rendered')
    // Save plot screenshot for visual comparison
    await savePlotScreenshot(driver, 'pie')

    // 5. Extract plot statistics via existing data-plot-stats node
    const plotStats = await getPlotStats(driver)
    const stats = plotStats.stats || {}
    logStep(`Extracted plot stats: n=${stats.n}, category_count=${stats.category_count}`)

    // 6. Validate plot structure
    if (plotStats.plotType !== 'pie') {
      throw new Error(`Expected plot type 'pie', got '${plotStats.plotType}'`)
    }
    if (plotStats.sourceType !== 'user_derived') {
      throw new Error(`Expected source type 'user_derived', got '${plotStats.sourceType}'`)
    }

    // 7. Validate slice count
    if (stats.category_count !== rBaseline.n_slices) {
      throw new Error(`Slice count mismatch: expected ${rBaseline.n_slices}, got ${stats.category_count}`)
    }

    // 8. Validate value statistics
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

    logSuccess('Pie chart validation passed')
    logSuccess(`  Slices: ${stats.category_count} (expected ${rBaseline.n_slices})`)
    if (stats.value_sum !== undefined) {
      logSuccess(`  Total value: ${stats.value_sum} (expected ${rBaseline.value_sum})`)
    }
    if (stats.value_mean !== undefined) {
      logSuccess(`  Average value: ${stats.value_mean.toFixed(2)} (expected ${rBaseline.value_mean.toFixed(2)})`)
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
