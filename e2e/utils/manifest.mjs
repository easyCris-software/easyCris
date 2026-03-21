/**
 * Fixture Manifest Loader
 * Single source of truth for fixture metadata
 *
 * ✅ FIX 4: Enforce manifest-based loading for deterministic tests
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const MANIFEST_PATH = path.resolve(__dirname, '../fixtures/manifest.json')

let cachedManifest = null

/**
 * Load fixture manifest
 */
export function loadManifest() {
  if (cachedManifest) return cachedManifest

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Fixture manifest not found: ${MANIFEST_PATH}`)
  }

  const json = fs.readFileSync(MANIFEST_PATH, 'utf-8')
  cachedManifest = JSON.parse(json)

  console.log(`[Manifest] Loaded ${cachedManifest.fixtures.length} fixtures`)

  return cachedManifest
}

/**
 * Get fixture by name (REQUIRED)
 * @param {string} name - Fixture name from manifest
 * @returns {object} Fixture metadata
 * @throws {Error} If fixture not found
 */
export function getFixture(name) {
  const manifest = loadManifest()
  const fixture = manifest.fixtures.find(f => f.name === name)

  if (!fixture) {
    const available = manifest.fixtures.map(f => f.name).join(', ')
    throw new Error(`Fixture not found: "${name}". Available: ${available}`)
  }

  return fixture
}

/**
 * Get all fixtures
 * @returns {array} All fixtures from manifest
 */
export function getAllFixtures() {
  const manifest = loadManifest()
  return manifest.fixtures
}

/**
 * Get fixtures by family
 * @param {string} family - Test family (e.g., 'hypothesis_testing')
 * @returns {array} Filtered fixtures
 */
export function getFixturesByFamily(family) {
  const manifest = loadManifest()
  return manifest.fixtures.filter(f => f.family === family)
}

/**
 * Validate manifest integrity
 * Checks that all .ecp files and R baselines exist
 * @throws {Error} If validation fails
 */
export function validateManifest() {
  const manifest = loadManifest()
  const PROJECT_ROOT = path.resolve(__dirname, '../..')
  const errors = []

  for (const fixture of manifest.fixtures) {
    // Check .ecp file
    const ecpPath = path.resolve(PROJECT_ROOT, 'e2e/fixtures', fixture.file)
    if (!fs.existsSync(ecpPath)) {
      errors.push(`Missing fixture file: ${fixture.file}`)
    }

    // Check R baseline (if specified)
    if (fixture.rBaseline) {
      const baselinePath = path.resolve(PROJECT_ROOT, 'e2e/fixtures', fixture.rBaseline)
      if (!fs.existsSync(baselinePath)) {
        errors.push(`Missing R baseline: ${fixture.rBaseline}`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Manifest validation failed:\n  ${errors.join('\n  ')}`)
  }

  console.log('[Manifest] All fixtures validated')
}

/**
 * Get manifest stats
 * @returns {object} Manifest statistics
 */
export function getManifestStats() {
  const manifest = loadManifest()
  return manifest.stats
}

/**
 * Get baseline metric count by reading the R baseline JSON file
 * @param {string} testName - Test name (e.g., 'anova_one_way')
 * @returns {number} Number of metrics in baseline
 */
export function getBaselineMetricCount(testName) {
  const PROJECT_ROOT = path.resolve(__dirname, '../..')
  const baselinePath = path.join(PROJECT_ROOT, 'e2e/fixtures/baselines', `${testName}_r_baseline.json`)

  if (!fs.existsSync(baselinePath)) {
    console.warn(`[Manifest] Baseline not found: ${baselinePath}`)
    return 0
  }

  try {
    const json = fs.readFileSync(baselinePath, 'utf-8')
    const baseline = JSON.parse(json)
    const metricCount = Object.keys(baseline).length
    return metricCount
  } catch (error) {
    console.warn(`[Manifest] Failed to read baseline: ${error.message}`)
    return 0
  }
}
