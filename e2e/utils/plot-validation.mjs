/**
 * Plot Validation Utility
 * Extracts statistics from plot's hidden data-plot-stats node for E2E validation
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation infrastructure (655 metrics).
 * Contains plot stats extraction and validation logic (358 plot metrics).
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import { By, until } from 'selenium-webdriver'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASELINES_DIR = path.join(__dirname, '../fixtures/baselines')
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const PLOTS_VALIDATION_ROOT = path.join(PROJECT_ROOT, '_test_validation', 'Plots')

/**
 * Navigate to the Plots panel
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
export async function navigateToPlots(driver) {
  console.log('[Plot Validation] Navigating to Plots panel...')

  // Click on the Plots view in the navigator tree
  const plotsTab = await driver.wait(
    until.elementLocated(By.xpath('//button[.//span[normalize-space()="Plots"]]')),
    5000,
    'Plots tab not found'
  )
  await plotsTab.click()

  // Wait for plots panel to be visible
  await driver.wait(
    until.elementLocated(By.css('[data-testid="plots-panel"]')),
    5000,
    'Plots panel not visible'
  )

  console.log('[Plot Validation] Plots panel visible')
}

/**
 * Wait for a plot to be generated and displayed
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {number} timeout - Timeout in ms (default: 10000)
 */
export async function waitForPlot(driver, timeout = 10000) {
  console.log('[Plot Validation] Waiting for plot to render...')

  await driver.wait(
    until.elementLocated(By.css('[data-plot-stats]')),
    timeout,
    'Plot stats node not found - plot may not have rendered'
  )

  // Additional wait for Plotly to finish rendering
  await driver.sleep(500)

  console.log('[Plot Validation] Plot rendered')
}

/**
 * Export plot as PNG using the download button above the plot
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} plotType - Plot type (e.g., 'scatter', 'bar', 'histogram')
 * @param {number} dpi - DPI setting (96, 300, or 600) - defaults to 300
 */
export async function exportPlotAsPNG(driver, plotType, dpi = 300) {
  console.log(`[Plot Validation] Exporting ${plotType} plot as PNG (${dpi} DPI)...`)

  try {
    const outputPath = path.join(
      PLOTS_VALIDATION_ROOT,
      plotType,
      'results',
      'easycris_plot.png'
    )

    const exported = await driver.executeScript(
      (outputPath, dpi) => {
        if (!window.__E2E__?.exportPlotPng) return null
        return window.__E2E__.exportPlotPng({ outputPath, dpi })
      },
      outputPath,
      dpi
    )

    if (exported) {
      console.log(`[Plot Validation] Plot exported to ${outputPath}`)
      return outputPath
    }

    // Wait for any overlays to clear
    await driver.wait(async () => {
      const overlays = await driver.findElements(
        By.css('[data-slot="dialog-overlay"][data-state="open"]')
      )
      return overlays.length === 0
    }, 10000)

    // Find and click the download button
    const downloadButton = await driver.wait(
      until.elementLocated(By.css('[data-testid="plot-download-button"]')),
      5000,
      'Download button not found'
    )
    await driver.wait(until.elementIsVisible(downloadButton), 5000)
    await downloadButton.click()
    await driver.sleep(500)

    // Find "Export as PNG" text element (DropdownMenuSubTrigger)
    // Use a simpler XPath that just looks for the text without requiring specific roles
    const exportPngItem = await driver.wait(
      until.elementLocated(
        By.xpath('//*[normalize-space(text())="Export as PNG"]')
      ),
      5000,
      'Export as PNG menu item not found'
    )

    // Hover over it to open submenu
    const actions = driver.actions({ async: true })
    await actions.move({ origin: exportPngItem }).perform()
    await driver.sleep(500)

    // Click on the appropriate DPI option
    let dpiText
    if (dpi === 96) {
      dpiText = 'Screen (96 DPI)'
    } else if (dpi === 600) {
      dpiText = '600 DPI'
    } else {
      dpiText = '300 DPI'
    }

    const dpiMenuItem = await driver.wait(
      until.elementLocated(
        By.xpath(`//*[normalize-space(text())="${dpiText}"]`)
      ),
      5000,
      `${dpiText} menu item not found`
    )
    await dpiMenuItem.click()

    // Wait for export to complete
    await driver.sleep(2000)

    console.log(`[Plot Validation] Plot exported to working directory (${dpi} DPI)`)
    return outputPath
  } catch (error) {
    console.error(`[Plot Validation] Failed to export plot: ${error.message}`)
    throw error
  }
}

/**
 * Alias for backward compatibility
 * @deprecated Use exportPlotAsPNG instead
 */
export async function savePlotScreenshot(driver, plotType) {
  return await exportPlotAsPNG(driver, plotType)
}

/**
 * Extract statistics from the plot's hidden data-plot-stats node
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @returns {object} Extracted metadata with stats payload
 */
export async function extractPlotStats(driver) {
  console.log('[Plot Validation] Extracting plot statistics...')

  const extracted = await driver.executeScript(() => {
    const plotStatsNode = document.querySelector('[data-plot-stats]')

    if (!plotStatsNode) {
      return { error: 'Plot stats node not found' }
    }

    const stats = {}
    const result = {
      plotType: plotStatsNode.getAttribute('data-plot-type'),
      plotId: plotStatsNode.getAttribute('data-plot-id'),
      sourceType: plotStatsNode.getAttribute('data-source-type'),
      testType: plotStatsNode.getAttribute('data-test-type'),
      dataPolicy: plotStatsNode.getAttribute('data-data-policy'),
      stats,
    }

    // Extract all data-* attributes that contain statistics
    // Keep snake_case to match R baselines
    for (const attr of plotStatsNode.attributes) {
      if (attr.name.startsWith('data-') &&
          !['data-plot-stats', 'data-plot-type', 'data-plot-id',
            'data-source-type', 'data-test-type', 'data-data-policy'].includes(attr.name)) {
        const statName = attr.name.replace('data-', '').replace(/-/g, '_')
        const rawValue = attr.value
        if (rawValue.includes(',')) {
          const parts = rawValue.split(',').map(part => parseFloat(part.trim()))
          const allNumbers = parts.length > 0 && parts.every(num => !isNaN(num))
          stats[statName] = allNumbers ? parts : rawValue
        } else {
          const value = parseFloat(rawValue)
          if (!isNaN(value)) {
            stats[statName] = value
          } else if (rawValue) {
            // Keep non-numeric values as strings
            stats[statName] = rawValue
          }
        }
      }
    }

    return result
  })

  if (extracted.error) {
    console.error(`[Plot Validation] ${extracted.error}`)
    return extracted
  }

  console.log(`[Plot Validation] Extracted ${Object.keys(extracted.stats || {}).length} statistics`)
  console.log(`[Plot Validation] Plot type: ${extracted.plotType}, Source: ${extracted.sourceType}`)

  return extracted
}

/**
 * Validate plot statistics against expected values
 * @param {object} extracted - Extracted plot statistics
 * @param {object} expected - Expected statistics
 * @param {number} tolerance - Relative tolerance for comparison (default: 0.0001)
 * @returns {object} Validation results
 */
export function validatePlotStats(extracted, expected, tolerance = 0.0001) {
  const results = {
    passed: [],
    failed: [],
    missing: [],
    extra: []
  }

  const extractedStats = extracted.stats || {}

  // Check expected values
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key.startsWith('_')) continue // Skip debug/metadata keys

    if (!(key in extractedStats)) {
      results.missing.push({ key, expected: expectedValue })
      continue
    }

    const actualValue = extractedStats[key]
    const diff = Math.abs(actualValue - expectedValue)
    const relDiff = expectedValue !== 0 ? diff / Math.abs(expectedValue) : diff

    if (relDiff <= tolerance) {
      results.passed.push({ key, expected: expectedValue, actual: actualValue })
    } else {
      results.failed.push({ key, expected: expectedValue, actual: actualValue, diff: relDiff })
    }
  }

  // Check for extra values not in expected
  for (const key of Object.keys(extractedStats)) {
    if (!(key in expected)) {
      results.extra.push({ key, value: extractedStats[key] })
    }
  }

  // Summary
  const total = results.passed.length + results.failed.length + results.missing.length
  const success = results.failed.length === 0 && results.missing.length === 0

  console.log(`[Plot Validation] Results: ${results.passed.length}/${total} passed`)
  if (results.failed.length > 0) {
    console.log(`[Plot Validation] Failed: ${results.failed.map(f => f.key).join(', ')}`)
  }
  if (results.missing.length > 0) {
    console.log(`[Plot Validation] Missing: ${results.missing.map(m => m.key).join(', ')}`)
  }

  return {
    success,
    total,
    ...results
  }
}

/**
 * Get the active plot from the gallery
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {number} index - Plot index to select (0-based)
 */
export async function selectPlotFromGallery(driver, index = 0) {
  console.log(`[Plot Validation] Selecting plot at index ${index}...`)

  const plotCards = await driver.findElements(
    By.css('div[role="button"][aria-label^="Select plot:"]')
  )

  if (plotCards.length === 0) {
    throw new Error('No plots found in gallery')
  }

  if (index >= plotCards.length) {
    throw new Error(`Plot index ${index} out of range (${plotCards.length} plots available)`)
  }

  const targetCard = plotCards[index]
  const targetType = await targetCard.getAttribute('data-plot-type')
  const targetTitle = await targetCard.getAttribute('data-plot-title')
  const isAlreadyActive = (await targetCard.getAttribute('aria-pressed')) === 'true'

  if (isAlreadyActive) {
    console.log(`[Plot Validation] Plot ${index + 1} already active, skipping selection`)
  } else {
    await targetCard.click()
    await driver.sleep(300) // Wait for selection animation
  }

  // Wait for plot stats node to match target plot (by type or title)
  await driver.wait(async () => {
    const plotStatsNode = await driver.findElements(By.css('[data-plot-stats]'))
    if (plotStatsNode.length === 0) return false

    const activeType = await plotStatsNode[0].getAttribute('data-plot-type')
    const activeTitle = await plotStatsNode[0].getAttribute('data-plot-title')
    return activeType === targetType || activeTitle === targetTitle
  }, 5000, `Plot stats did not update to match selected plot (type: ${targetType}, title: ${targetTitle})`)

  console.log(`[Plot Validation] Selected plot ${index + 1} of ${plotCards.length}`)
}

export async function selectPlotFromGalleryByType(driver, plotType) {
  console.log(`[Plot Validation] Selecting plot by type: ${plotType}...`)

  const plotCards = await driver.findElements(
    By.css('div[role="button"][aria-label^="Select plot:"]')
  )
  if (plotCards.length === 0) {
    throw new Error('No plots found in gallery')
  }

  let targetCard = null
  for (const card of plotCards) {
    const cardType = await card.getAttribute('data-plot-type')
    if (cardType === plotType) {
      targetCard = card
      break
    }
  }

  if (!targetCard) {
    throw new Error(`Plot with type ${plotType} not found in gallery`)
  }

  const isAlreadyActive = (await targetCard.getAttribute('aria-pressed')) === 'true'
  if (isAlreadyActive) {
    console.log(`[Plot Validation] Plot type ${plotType} already active, skipping selection`)
  } else {
    await targetCard.click()
    await driver.sleep(300)
  }

  const targetTitle = await targetCard.getAttribute('data-plot-title')
  await driver.wait(async () => {
    const plotStatsNode = await driver.findElements(By.css('[data-plot-stats]'))
    if (plotStatsNode.length === 0) return false
    const activeType = await plotStatsNode[0].getAttribute('data-plot-type')
    const activeTitle = await plotStatsNode[0].getAttribute('data-plot-title')
    return activeType === plotType || activeTitle === targetTitle
  }, 5000, `Plot stats did not update to match selected plot type: ${plotType}`)

  console.log(`[Plot Validation] Selected plot type: ${plotType}`)
}

/**
 * Select a plot from the gallery by title (partial match)
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} titlePattern - Title pattern to match (partial)
 */
export async function selectPlotFromGalleryByTitle(driver, titlePattern) {
  console.log(`[Plot Validation] Selecting plot by title pattern: ${titlePattern}...`)

  const plotCards = await driver.findElements(
    By.css('div[role="button"][aria-label^="Select plot:"]')
  )
  if (plotCards.length === 0) {
    throw new Error('No plots found in gallery')
  }

  let targetCard = null
  for (const card of plotCards) {
    const cardTitle = await card.getAttribute('data-plot-title')
    if (cardTitle && cardTitle.includes(titlePattern)) {
      targetCard = card
      break
    }
  }

  if (!targetCard) {
    throw new Error(`Plot with title containing '${titlePattern}' not found in gallery`)
  }

  const targetTitle = await targetCard.getAttribute('data-plot-title')
  const isAlreadyActive = (await targetCard.getAttribute('aria-pressed')) === 'true'
  if (isAlreadyActive) {
    console.log(`[Plot Validation] Plot '${targetTitle}' already active, skipping selection`)
  } else {
    await targetCard.click()
    await driver.sleep(800) // Wait for plot to render
  }

  // Wait for card to be marked as active
  await driver.wait(async () => {
    const pressed = await targetCard.getAttribute('aria-pressed')
    return pressed === 'true'
  }, 5000, `Plot card did not become active: ${targetTitle}`)

  console.log(`[Plot Validation] Selected plot: ${targetTitle}`)
}

/**
 * Verify plot metadata matches expectations
 * @param {object} extracted - Extracted plot data
 * @param {object} expectedMeta - Expected metadata
 */
export function verifyPlotMetadata(extracted, expectedMeta) {
  const errors = []

  if (expectedMeta.plotType && extracted.plotType !== expectedMeta.plotType) {
    errors.push(`Plot type mismatch: expected ${expectedMeta.plotType}, got ${extracted.plotType}`)
  }

  if (expectedMeta.sourceType && extracted.sourceType !== expectedMeta.sourceType) {
    errors.push(`Source type mismatch: expected ${expectedMeta.sourceType}, got ${extracted.sourceType}`)
  }

  if (expectedMeta.testType && extracted.testType !== expectedMeta.testType) {
    errors.push(`Test type mismatch: expected ${expectedMeta.testType}, got ${extracted.testType}`)
  }

  if (errors.length > 0) {
    throw new Error(`Plot metadata validation failed:\n${errors.join('\n')}`)
  }

  console.log('[Plot Validation] Metadata validation passed')
}

/**
 * Alias for extractPlotStats (for consistency with plan naming)
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @returns {object} Extracted statistics
 */
export async function getPlotStats(driver) {
  return await extractPlotStats(driver)
}

/**
 * Load plot baseline from JSON file
 * @param {string} baselineName - Baseline filename (e.g., 'scatter_r_baseline.json')
 * @returns {object} Baseline data
 */
export function loadPlotBaseline(baselineName) {
  const baselinePath = path.join(BASELINES_DIR, baselineName)

  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Plot baseline not found: ${baselinePath}`)
  }

  const json = fs.readFileSync(baselinePath, 'utf-8')
  const baseline = JSON.parse(json)

  console.log(`[Plot Validation] Loaded baseline: ${baselineName}`)

  return baseline
}

export default {
  navigateToPlots,
  waitForPlot,
  extractPlotStats,
  getPlotStats, // Alias
  validatePlotStats,
  selectPlotFromGallery,
  verifyPlotMetadata,
  loadPlotBaseline,
  exportPlotAsPNG,
  savePlotScreenshot // Alias for exportPlotAsPNG
}
