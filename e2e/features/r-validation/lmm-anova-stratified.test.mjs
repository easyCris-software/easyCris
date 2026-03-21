/**
 * R Baseline Validation: Stratified LMM ANOVA
 * Validates stratified omnibus + simple-effects numeric metrics against R baseline.
 */

import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { importFromValidation } from '../../utils/fixtures.mjs'
import { extractStatsFromUI, loadRBaseline, compareToRBaseline, assertValidation } from '../../utils/r-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { runLmmAnova, waitForResults } from '../../utils/ui-workflow.mjs'

const TOLERANCE_CONFIG = {
  defaultTolerance: 0.001,
  defaultToleranceMode: 'absolute',
  metricToleranceOverrides: [
    { pattern: '_(num_df|den_df|df)$', tolerance: 0.2, mode: 'absolute' },
    { pattern: '_(f_value|t_ratio|estimate|se)$', tolerance: 0.02, mode: 'relative' },
    { pattern: '_(p|p_raw)$', tolerance: 0.00005, mode: 'absolute' },
  ],
}
const EXPECTED_STRATA = 4
const ADJUSTMENT_METHOD_CONFIGS = [
  { method: 'tukey', expectedSimpleRowsPerStratum: 9 },
  { method: 'bonferroni', expectedSimpleRowsPerStratum: 9 },
  { method: 'holm', expectedSimpleRowsPerStratum: 9 },
  { method: 'holm-sidak', expectedSimpleRowsPerStratum: 9 },
  { method: 'sidak', expectedSimpleRowsPerStratum: 9 },
  { method: 'fdr_bh', expectedSimpleRowsPerStratum: 9 },
  {
    method: 'dunnett',
    expectedSimpleRowsPerStratum: 7,
    controlLevels: {
      treatment: 'A',
      day: 'D0',
    },
  },
]

function baselineMethodSuffix(method) {
  return String(method).replace(/[^a-z0-9_]+/gi, '_').toLowerCase()
}

function assertSimpleEffectsCoverage(actual, expectedSimpleRowsPerStratum) {
  for (let stratum = 1; stratum <= EXPECTED_STRATA; stratum += 1) {
    const estimateMatches = Object.keys(actual)
      .filter((key) => key.startsWith(`st${stratum}_se`) && key.endsWith('_estimate'))
      .sort()

    if (estimateMatches.length < expectedSimpleRowsPerStratum) {
      throw new Error(
        `Simple-effects coverage missing for stratum st${stratum}: expected >= ${expectedSimpleRowsPerStratum} estimate rows, found ${estimateMatches.length}`
      )
    }

    for (let effect = 1; effect <= expectedSimpleRowsPerStratum; effect += 1) {
      const estimateKey = `st${stratum}_se${effect}_estimate`
      const rawPKey = `st${stratum}_se${effect}_p_raw`
      const adjustedPKey = `st${stratum}_se${effect}_p`
      if (actual[estimateKey] === undefined || actual[rawPKey] === undefined || actual[adjustedPKey] === undefined) {
        throw new Error(
          `Simple-effects metrics missing for st${stratum} se${effect}: expected keys ${estimateKey}, ${rawPKey}, ${adjustedPKey}`
        )
      }
    }
  }
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+-\s+/g, ' vs ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function canonicalEffect(value) {
  const normalized = normalizeText(value).replace(/:/g, ' x ')
  if (!normalized.includes(' x ')) return normalized
  const parts = normalized
    .split(' x ')
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  return parts.join(' x ')
}

function canonicalComparisonIdentity(value) {
  const normalized = normalizeText(value)
    .replace(/\s+vs\s+/g, ' - ')
    .replace(/\s*-\s*/g, ' - ')
  const parts = normalized
    .split(' - ')
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  return parts.join(' - ')
}

async function extractRawStatsFromUI(driver) {
  return driver.executeScript(() => {
    const output = {}
    const cells = document.querySelectorAll('[data-stat]')
    for (const cell of cells) {
      const key = cell.getAttribute('data-stat')
      if (!key) continue
      const raw = cell.getAttribute('data-value')
      output[key] = raw == null ? (cell.textContent || '').trim() : String(raw)
    }
    return output
  })
}

function assertSemanticContracts(rawStats, baseline) {
  const semanticEntries = Object.entries(baseline).filter(([, value]) => typeof value === 'string')
  if (semanticEntries.length === 0) {
    throw new Error('Baseline semantic contract is empty; expected string identity keys.')
  }

  for (const [key, expectedRaw] of semanticEntries) {
    const actualRaw = rawStats[key]
    if (actualRaw === undefined) {
      throw new Error(`Missing semantic key in UI output: ${key}`)
    }

    const expected = key.endsWith('_source')
      ? canonicalEffect(expectedRaw)
      : key.endsWith('_label')
        ? canonicalComparisonIdentity(expectedRaw)
        : normalizeText(expectedRaw)
    const actual = key.endsWith('_source')
      ? canonicalEffect(actualRaw)
      : key.endsWith('_label')
        ? canonicalComparisonIdentity(actualRaw)
        : normalizeText(actualRaw)
    if (expected !== actual) {
      throw new Error(`Semantic mismatch for ${key}: expected "${expectedRaw}", actual "${actualRaw}"`)
    }
  }
}

async function runSingleConfig(adjustmentConfig) {
  let driver
  let webdriver

  try {
    logStep(`Starting stratified LMM ANOVA R-validation (${adjustmentConfig.method})...`)
    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver

    await verifyCleanState(driver)

    await importFromValidation(driver, 'lmm_anova', { datasetFile: 'dataset_01.csv' })

    await runLmmAnova(driver, {
      dependentColumn: 'value',
      subjectColumn: 'subject',
      predictorColumns: ['treatment', 'day'],
      predictorTypes: {
        treatment: 'categorical',
        day: 'categorical',
      },
      stratifyColumns: ['strain', 'sex'],
      interactionDepth: 2,
      dfMethod: 'satterthwaite',
      reml: false,
      randomEffectsMode: 'random_intercept',
      adjustmentMethod: adjustmentConfig.method,
      controlLevels: adjustmentConfig.controlLevels,
      simpleEffects: [
        { factor: 'treatment', within: 'day' },
        { factor: 'day', within: 'treatment' },
      ],
    })

    await waitForResults(driver)

    const baseline = await loadRBaseline(`lmm_anova_${baselineMethodSuffix(adjustmentConfig.method)}`)
    const actual = await extractStatsFromUI(driver, 'lmm_anova')
    const rawStats = await extractRawStatsFromUI(driver)
    assertSemanticContracts(rawStats, baseline)
    assertSimpleEffectsCoverage(actual, adjustmentConfig.expectedSimpleRowsPerStratum)

    const comparison = compareToRBaseline(actual, baseline, TOLERANCE_CONFIG)
    assertValidation(comparison)
    logSuccess(`✅ Stratified LMM (${adjustmentConfig.method}) matched ${comparison.totalMetrics} metrics`)
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

async function runTest() {
  for (const methodConfig of ADJUSTMENT_METHOD_CONFIGS) {
    await runSingleConfig(methodConfig)
  }
  logSuccess('COMPLETE: Stratified LMM R-validation passed for all adjustment methods')
}

runTest().catch((error) => {
  console.error('[Test] Execution failed:', error)
  process.exit(1)
})
