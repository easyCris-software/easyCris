/**
 * Fixture Loading Utilities
 * Uses manifest-based loading for deterministic tests
 *
 * FIX 4: Manifest-driven fixture loading
 * FIX 5: Added importFromValidation for direct CSV import
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation infrastructure (655 metrics).
 * Contains fixture loading utilities for all 10 Group 1 hypothesis tests.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getFixture, getBaselineMetricCount } from './manifest.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const GROUP3_CONFIG_PATH = path.join(PROJECT_ROOT, 'e2e/fixtures/metadata/group3.json')
const PLOT_VALIDATION_ROOT = path.join(PROJECT_ROOT, '_test_validation', 'Plots')

function resolveValidationCsvForFixture(fixture) {
  const fixtureFile = String(fixture?.file || '')
  const match = fixtureFile.match(/^datasets\/([^/]+)\/([^/]+)\//)
  if (!match) return null

  const groupDir = match[1]
  const testDir = match[2]

  // RNA-seq fixtures have dedicated workflows and should not use statistics CSV fallback.
  if (groupDir.toLowerCase() === 'rnaseq') {
    return null
  }

  const validationDataDir = path.join(PROJECT_ROOT, '_test_validation', groupDir, testDir, 'data')
  if (!fs.existsSync(validationDataDir)) {
    return null
  }

  const preferred = path.join(validationDataDir, 'dataset_01.csv')
  if (fs.existsSync(preferred)) {
    return preferred
  }

  const csvCandidates = fs
    .readdirSync(validationDataDir)
    .filter((entry) => entry.toLowerCase().endsWith('.csv'))
    .sort()

  if (csvCandidates.length === 0) {
    return null
  }

  return path.join(validationDataDir, csvCandidates[0])
}

/**
 * Map test names to validation groups
 */
const TEST_TO_GROUP = {
  // Group 1: Hypothesis Testing
  anova_one_way: 'Group1_Hypothesis_Testing',
  anova_two_way: 'Group1_Hypothesis_Testing',
  lmm_anova: 'Group1_Hypothesis_Testing',
  t_test_one_sample: 'Group1_Hypothesis_Testing',
  t_test_two_sample: 'Group1_Hypothesis_Testing',
  t_test_paired: 'Group1_Hypothesis_Testing',
  mann_whitney: 'Group1_Hypothesis_Testing',
  wilcoxon_signed_rank: 'Group1_Hypothesis_Testing',
  kruskal_wallis: 'Group1_Hypothesis_Testing',
  scheirer_ray_hare: 'Group1_Hypothesis_Testing',
  multifactorial_anova: 'Group1_Hypothesis_Testing',

  // Group 2: Pharmacology
  dose_response_3pl: 'Group2_Pharmacology',
  dose_response_4pl: 'Group2_Pharmacology',
  dose_response_5pl: 'Group2_Pharmacology',
  dose_response_compare: 'Group2_Pharmacology',
  synergy_bliss: 'Group2_Pharmacology',
  synergy_hsa: 'Group2_Pharmacology',
  synergy_loewe: 'Group2_Pharmacology',
  synergy_zip: 'Group2_Pharmacology',
  synergy_all: 'Group2_Pharmacology',

  // Group 3: Regression & Correlation
  correlation_pearson: 'Group3_Regression_Correlation',
  correlation_spearman: 'Group3_Regression_Correlation',
  correlation_kendall: 'Group3_Regression_Correlation',

  // Group 6: Survival Analysis
  kaplan_meier: 'Group6_Survival',
  cox_proportional_hazards: 'Group6_Survival',
  nelson_aalen: 'Group6_Survival',
}

const TEST_TO_VALIDATION_DIR = {
  lmm_anova: 'linear_mixed_models',
}

export function getValidationDirForTest(testName) {
  return TEST_TO_VALIDATION_DIR[testName] ?? testName
}

/**
 * Import data directly from _test_validation CSV
 * This bypasses the need for pre-created .ecp fixtures
 *
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testName - Test name (e.g., 'anova_one_way')
 * @returns {Promise<object>} Metadata including expected metric count
 */
export async function importFromValidation(driver, testName, options = {}) {
  const group = TEST_TO_GROUP[testName]
  if (!group) {
    throw new Error(`Unknown test name: ${testName}. Add it to TEST_TO_GROUP mapping.`)
  }

  const datasetFile = options.datasetFile || 'dataset_01.csv'

  // Build path to validation CSV
  const validationDir = getValidationDirForTest(testName)
  const csvPath = path.join(PROJECT_ROOT, '_test_validation', group, validationDir, 'data', datasetFile)

  console.log(`[Fixtures] Importing from validation: ${testName}`)
  console.log(`[Fixtures] CSV path: ${csvPath}`)

  // Clear existing data first
  await driver.executeScript(() => {
    if (!window.__E2E__) {
      throw new Error('window.__E2E__ is not available. Ensure the app was built with VITE_E2E_ENABLED=true')
    }
    return window.__E2E__.clearAllData().then(() => {
      // Defensive cleanup to avoid stale results between adjustment runs.
      const resultsStore = window.useResultsStore?.getState?.()
      const plotsStore = window.usePlotsStore?.getState?.()
      const analysisStore = window.useAnalysisStore?.getState?.()
      resultsStore?.clearAllResults?.()
      plotsStore?.clearPlots?.()
      analysisStore?.clearHistory?.()
    })
  })

  // Wait for state to settle
  await driver.sleep(500)

  // Import CSV
  await driver.executeScript((csvPath) => {
    return window.__E2E__.importCSV(csvPath)
  }, csvPath)

  // Wait for import to complete
  await driver.sleep(1500)

  // Verify import
  const datasetCount = await driver.executeScript(() => {
    return window.__E2E__.getDatasetCount()
  })

  if (datasetCount === 0) {
    throw new Error(`Failed to import CSV from: ${csvPath}`)
  }

  console.log(`[Fixtures] Imported: ${testName} (${datasetCount} dataset(s))`)

  // Get expected metric count from baseline
  const validatedMetrics = getBaselineMetricCount(testName)

  return {
    name: testName,
    group,
    validationDir,
    csvPath,
    datasets: datasetCount,
    validatedMetrics,
  }
}

/**
 * Load a fixture into the app via window.__E2E__ API
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} fixtureName - Fixture name from manifest (e.g., 'anova_two_way')
 * @returns {Promise<object>} Fixture metadata
 */
export async function loadFixture(driver, fixtureName) {
  // Get fixture metadata from manifest
  const fixture = getFixture(fixtureName)

  // Build absolute path to .ecp file
  const fullPath = path.join(PROJECT_ROOT, 'e2e/fixtures', fixture.file)

  console.log(`[Fixtures] Loading: ${fixtureName} (${fixture.validatedMetrics || 0} metrics)`)

  // Call window.__E2E__.loadFixture() in the app
  await driver.executeScript((ecpPath) => {
    if (!window.__E2E__) {
      throw new Error('window.__E2E__ is not available. Ensure the app was built with VITE_E2E_ENABLED=true')
    }
    return window.__E2E__.loadFixture(ecpPath)
  }, fullPath)

  // Some .ecp fixtures can fail to load datasets (e.g., missing project-adjacent data files).
  // Centralized fallback: import matching validation CSV so downstream tests keep one workflow.
  let fallbackCsvPath = null
  let fallbackUsed = false
  const datasetCountAfterFixture = await driver.executeScript(() => {
    return window.__E2E__?.getDatasetCount?.() || 0
  })

  if (datasetCountAfterFixture === 0) {
    fallbackCsvPath = resolveValidationCsvForFixture(fixture)
    if (fallbackCsvPath) {
      console.warn(
        `[Fixtures] Fixture opened with zero datasets: ${fixtureName}. Falling back to CSV import: ${fallbackCsvPath}`
      )

      await driver.executeScript(() => {
        return window.__E2E__.clearAllData()
      })
      await driver.sleep(300)
      await driver.executeScript((csvPath) => {
        return window.__E2E__.importCSV(csvPath)
      }, fallbackCsvPath)

      await driver.wait(async () => {
        const count = await driver.executeScript(() => window.__E2E__?.getDatasetCount?.() || 0)
        return count > 0
      }, 10000, `CSV fallback import did not create datasets for fixture: ${fixtureName}`)

      fallbackUsed = true
    } else {
      console.warn(
        `[Fixtures] Fixture opened with zero datasets and no validation CSV fallback was found: ${fixtureName}`
      )
    }
  }

  console.log(
    `[Fixtures] Loaded: ${fixtureName}${fallbackUsed ? ' (via CSV fallback)' : ''}`
  )

  // Return metadata for test to use
  return {
    ...fixture,
    fallbackUsed,
    fallbackCsvPath,
  }
}

/**
 * Load a plot fixture (.ecp file) for E2E testing
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} plotType - Plot type directory name (e.g., 'scatter', 'bar', 'grouped_bar')
 * @returns {Promise<object>} Plot fixture metadata
 */
export async function loadPlotFixture(driver, plotType) {
  // Build path to .ecp file in datasets/Plots
  const ecpPath = path.join(PROJECT_ROOT, 'e2e/fixtures/datasets/Plots', plotType, `${plotType}.ecp`)

  console.log(`[Fixtures] Loading plot fixture: ${plotType}`)
  console.log(`[Fixtures] .ecp path: ${ecpPath}`)

  // Verify file exists
  if (!fs.existsSync(ecpPath)) {
    throw new Error(`Plot fixture not found: ${ecpPath}`)
  }

  // Load fixture via window.__E2E__ API
  await driver.executeScript((ecpPath) => {
    if (!window.__E2E__) {
      throw new Error('window.__E2E__ is not available. Ensure the app was built with VITE_E2E_ENABLED=true')
    }
    return window.__E2E__.loadFixture(ecpPath)
  }, ecpPath)

  // Wait for fixture to load
  await driver.sleep(1000)

  // Verify load
  const datasetCount = await driver.executeScript(() => {
    return window.__E2E__?.getDatasetCount?.() || 0
  })

  if (datasetCount === 0) {
    throw new Error(`Failed to load plot fixture: ${plotType}`)
  }

  console.log(`[Fixtures] Plot fixture loaded: ${plotType} (${datasetCount} dataset(s))`)
  return { plotType, ecpPath, datasets: datasetCount }
}

/**
 * Import a plot fixture directly from _test_validation/Plots (CSV)
 * @deprecated Use loadPlotFixture() instead to load .ecp fixtures
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} plotType - Plot type directory name (e.g., 'scatter', 'bar')
 */
export async function importPlotFixture(driver, plotType) {
  const csvPath = path.join(PLOT_VALIDATION_ROOT, plotType, 'data', 'dataset_01.csv')

  console.log(`[Fixtures] Importing plot fixture: ${plotType}`)
  console.log(`[Fixtures] CSV path: ${csvPath}`)

  await driver.executeScript(() => {
    if (!window.__E2E__) {
      throw new Error('window.__E2E__ is not available. Ensure the app was built with VITE_E2E_ENABLED=true')
    }
    return window.__E2E__.clearAllData()
  })

  await driver.sleep(500)

  await driver.executeScript((csvPath) => {
    return window.__E2E__.importCSV(csvPath)
  }, csvPath)

  await driver.sleep(1500)

  const datasetCount = await driver.executeScript(() => {
    return window.__E2E__?.getDatasetCount?.() || 0
  })

  if (datasetCount === 0) {
    throw new Error(`Failed to import plot fixture: ${plotType}`)
  }

  console.log(`[Fixtures] Plot fixture imported: ${plotType}`)
  return { plotType, csvPath, datasets: datasetCount }
}

/**
 * Verify fixture loaded correctly
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} fixture - Fixture metadata from manifest
 */
export async function verifyFixtureLoaded(driver, fixture) {
  const datasetCount = await driver.executeScript(() => {
    return window.__E2E__.getDatasetCount()
  })

  const expectedCount = fixture.datasets || 1

  if (datasetCount !== expectedCount) {
    throw new Error(
      `Fixture load verification failed: expected ${expectedCount} dataset(s), got ${datasetCount}`
    )
  }

  console.log(`[Fixtures] Verified: ${fixture.name} (${datasetCount} dataset(s))`)
}

/**
 * Load Group 3 regression/correlation test config.
 * Provides deterministic column selection and encoding choices.
 */
export function loadRegressionConfig() {
  const raw = fs.readFileSync(GROUP3_CONFIG_PATH, 'utf-8')
  return JSON.parse(raw)
}
