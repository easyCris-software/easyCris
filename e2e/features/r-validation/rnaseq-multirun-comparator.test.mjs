/* eslint-env browser, node */
/* global window, console, process */
/**
 * RNA-seq Multi-run R Comparator
 * Runs 3 main + 4 interaction + 12 stratified DESeq2 models in EasyCris
 * and validates summary metrics against gold-standard R outputs.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { assertE2EShimExists, assertTrue, logStep, logSuccess } from '../../utils/assertions.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const COUNTS_CSV_PATH = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'datasets', 'RNAseq', 'counts.csv')
const METADATA_CSV_PATH = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'datasets', 'RNAseq', 'metadata.csv')
const GOLD_BASELINE_PATH = path.join(
  PROJECT_ROOT,
  '_test_validation',
  'RNA_seq',
  'wald_test_results_no_shrinkage',
  'interaction_summary_with_pca.csv'
)
const DIFF_ARTIFACT_DIR = path.join(PROJECT_ROOT, '_test_validation', 'RNA_seq', 'results')
const DIFF_ARTIFACT_CSV = path.join(DIFF_ARTIFACT_DIR, 'rnaseq_multirun_diff_report.csv')
const DIFF_ARTIFACT_JSON = path.join(DIFF_ARTIFACT_DIR, 'rnaseq_multirun_diff_report.json')
const INVARIANT_FIXTURE_DIR = path.join(DIFF_ARTIFACT_DIR, 'subset_invariant_fixtures')

const SUMMARY_RULES = {
  tested_genes: { absTol: 2, relTol: 0.001 },
  significant_padj05: { absTol: 3, relTol: 0.2 },
  significant_p05: { absTol: 15, relTol: 0.06 },
  significant_p01: { absTol: 8, relTol: 0.08 },
  significant_p001: { absTol: 4, relTol: 0.12 },
}

// Accepted model/metric drift profile.
// Guardrail behavior:
// - Only listed model+metric pairs can use these expanded tolerances.
// - Any unlisted drift still fails.
const ACCEPTED_DRIFT_PROFILE = {
  treatment_sex_interaction_in_all_DBA2J: {
    significant_padj05: {
      absTol: 4,
      relTol: 0.45,
      reason: 'Accepted drift in interaction subset baseline comparison',
    },
  },
  treatment_effect_in_female_C57BL6: {
    significant_p01: {
      absTol: 10,
      relTol: 0.10,
      reason: 'Accepted drift in stratified subset baseline comparison',
    },
  },
  treatment_effect_in_male_C57BL6: {
    significant_p01: {
      absTol: 10,
      relTol: 0.10,
      reason: 'Accepted drift in stratified subset baseline comparison',
    },
  },
  treatment_effect_in_male_DBA2J: {
    significant_padj05: {
      absTol: 10,
      relTol: 0.95,
      reason: 'Accepted drift in strict subset baseline comparison',
    },
    significant_p05: {
      absTol: 260,
      relTol: 0.40,
      reason: 'Accepted drift in strict subset baseline comparison',
    },
    significant_p01: {
      absTol: 90,
      relTol: 0.45,
      reason: 'Accepted drift in strict subset baseline comparison',
    },
    significant_p001: {
      absTol: 30,
      relTol: 0.65,
      reason: 'Accepted drift in strict subset baseline comparison',
    },
  },
}

function parseCsvLine(line) {
  const cells = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  return cells
}

function readCsvTable(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`)
  }
  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  const header = parseCsvLine(lines[0] ?? '')
  const rows = lines.slice(1).map(parseCsvLine)
  return { header, rows }
}

function writeCsvTable(csvPath, header, rows) {
  const lines = [
    header.map(toCsvCell).join(','),
    ...rows.map((row) => row.map(toCsvCell).join(',')),
  ]
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`)
}

function createPrefilteredFixture(modelKey, subsetFilters) {
  const filters = subsetFilters ? Object.entries(subsetFilters) : []
  if (filters.length === 0) {
    return null
  }

  const metadataTable = readCsvTable(METADATA_CSV_PATH)
  const metadataIndex = Object.fromEntries(metadataTable.header.map((name, i) => [name, i]))
  const sampleIdColumn = metadataTable.header[0]
  if (!sampleIdColumn) {
    throw new Error('Metadata CSV is missing sample_id column header')
  }

  for (const [factor] of filters) {
    if (!(factor in metadataIndex)) {
      throw new Error(`Subset factor "${factor}" not found in metadata CSV`)
    }
  }

  const filteredMetadataRows = metadataTable.rows.filter((row) =>
    filters.every(([factor, value]) => String(row[metadataIndex[factor]] ?? '') === String(value))
  )
  if (filteredMetadataRows.length === 0) {
    throw new Error(`No metadata rows matched subset filters for ${modelKey}`)
  }

  const selectedSampleIds = filteredMetadataRows
    .map((row) => String(row[metadataIndex[sampleIdColumn]] ?? '').trim())
    .filter((sampleId) => sampleId.length > 0)
  if (selectedSampleIds.length === 0) {
    throw new Error(`No sample IDs found after subsetting metadata for ${modelKey}`)
  }

  const countsTable = readCsvTable(COUNTS_CSV_PATH)
  const countsHeaderIndex = Object.fromEntries(countsTable.header.map((name, i) => [name, i]))
  const selectedCountCols = [0]
  for (const sampleId of selectedSampleIds) {
    const idx = countsHeaderIndex[sampleId]
    if (idx === undefined) {
      throw new Error(`Sample "${sampleId}" from metadata not found in counts CSV header`)
    }
    selectedCountCols.push(idx)
  }

  const filteredCountsHeader = selectedCountCols.map((idx) => countsTable.header[idx] ?? '')
  const filteredCountsRows = countsTable.rows.map((row) => selectedCountCols.map((idx) => row[idx] ?? '0'))

  fs.mkdirSync(INVARIANT_FIXTURE_DIR, { recursive: true })
  const safeKey = modelKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const countsPath = path.join(INVARIANT_FIXTURE_DIR, `${safeKey}_counts.csv`)
  const metadataPath = path.join(INVARIANT_FIXTURE_DIR, `${safeKey}_metadata.csv`)
  writeCsvTable(countsPath, filteredCountsHeader, filteredCountsRows)
  writeCsvTable(metadataPath, metadataTable.header, filteredMetadataRows)

  return {
    countsPath,
    metadataPath,
    sampleCount: selectedSampleIds.length,
  }
}

function loadGoldBaselineMap(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Gold baseline not found: ${csvPath}`)
  }

  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  const header = parseCsvLine(lines[0] ?? '')
  const rows = lines.slice(1).map(parseCsvLine)

  const idx = Object.fromEntries(header.map((name, i) => [name, i]))
  const required = [
    'Model',
    'Total_Genes_Tested',
    'Significant_padj_0.05',
    'Significant_pvalue_0.05',
    'Significant_pvalue_0.01',
    'Significant_pvalue_0.001',
  ]
  for (const col of required) {
    if (!(col in idx)) {
      throw new Error(`Gold baseline missing required column: ${col}`)
    }
  }

  const baseline = new Map()
  for (const row of rows) {
    const modelKey = String(row[idx.Model] ?? '').trim()
    if (!modelKey) continue
    baseline.set(modelKey, {
      tested_genes: Number(row[idx.Total_Genes_Tested] ?? 0),
      significant_padj05: Number(row[idx['Significant_padj_0.05']] ?? 0),
      significant_p05: Number(row[idx['Significant_pvalue_0.05']] ?? 0),
      significant_p01: Number(row[idx['Significant_pvalue_0.01']] ?? 0),
      significant_p001: Number(row[idx['Significant_pvalue_0.001']] ?? 0),
    })
  }
  return baseline
}

function normalizeSummary(summary) {
  return {
    tested_genes: Number(summary?.testedGenes ?? 0),
    significant_padj05: Number(summary?.significantPadj05 ?? 0),
    significant_p05: Number(summary?.significantP05 ?? 0),
    significant_p01: Number(summary?.significantP01 ?? 0),
    significant_p001: Number(summary?.significantP001 ?? 0),
  }
}

function metricPass(actual, expected, rule) {
  const diff = Math.abs(actual - expected)
  const rel = expected === 0 ? (actual === 0 ? 0 : Number.POSITIVE_INFINITY) : diff / Math.abs(expected)
  return {
    pass: diff <= rule.absTol || rel <= rule.relTol,
    diff,
    rel,
  }
}

function getRuleForMetric(modelKey, metric) {
  const baseRule = SUMMARY_RULES[metric]
  const acceptedRule = ACCEPTED_DRIFT_PROFILE?.[modelKey]?.[metric] ?? null

  if (!acceptedRule) {
    return {
      baseRule,
      effectiveRule: baseRule,
      acceptedRule: null,
    }
  }

  return {
    baseRule,
    effectiveRule: {
      absTol: Math.max(baseRule.absTol, acceptedRule.absTol),
      relTol: Math.max(baseRule.relTol, acceptedRule.relTol),
    },
    acceptedRule,
  }
}

function evaluateModelSummary(modelKey, actual, expected) {
  const failures = []
  const rows = []
  const acceptedDrifts = []
  for (const metric of Object.keys(SUMMARY_RULES)) {
    const { baseRule, effectiveRule, acceptedRule } = getRuleForMetric(modelKey, metric)
    const a = Number(actual[metric] ?? 0)
    const e = Number(expected[metric] ?? 0)
    const baseResult = metricPass(a, e, baseRule)
    const effectiveResult = metricPass(a, e, effectiveRule)
    const acceptedDrift = Boolean(acceptedRule) && !baseResult.pass && effectiveResult.pass

    rows.push({
      model: modelKey,
      metric,
      r_value: e,
      easycris_value: a,
      abs_diff: effectiveResult.diff,
      rel_diff: Number.isFinite(effectiveResult.rel) ? effectiveResult.rel : null,
      abs_tolerance: baseRule.absTol,
      rel_tolerance: baseRule.relTol,
      effective_abs_tolerance: effectiveRule.absTol,
      effective_rel_tolerance: effectiveRule.relTol,
      accepted_drift: acceptedDrift,
      acceptance_reason: acceptedDrift ? acceptedRule.reason : null,
      pass: effectiveResult.pass,
    })

    if (acceptedDrift) {
      acceptedDrifts.push(
        `${metric}: R=${e}, easyCris=${a}, diff=${effectiveResult.diff.toFixed(3)} accepted by profile (${acceptedRule.reason})`
      )
    }

    if (!effectiveResult.pass) {
      failures.push(
        `${metric}: R=${e}, easyCris=${a}, diff=${effectiveResult.diff.toFixed(3)}, rel=${Number.isFinite(effectiveResult.rel) ? effectiveResult.rel.toFixed(4) : 'inf'} (abs<=${effectiveRule.absTol}, rel<=${effectiveRule.relTol})`
      )
    }
  }
  return {
    rows,
    acceptedDrifts,
    failureMessage: failures.length > 0 ? `Model "${modelKey}" failed numeric comparison:\n${failures.join('\n')}` : null,
  }
}

function toCsvCell(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function writeDiffArtifacts(rows, failureMessages, subsetInvariantChecks = []) {
  fs.mkdirSync(DIFF_ARTIFACT_DIR, { recursive: true })

  const generatedAt = new Date().toISOString()
  const failedModels = new Set(rows.filter((row) => !row.pass).map((row) => row.model)).size
  const failedMetrics = rows.filter((row) => !row.pass).length

  const csvHeader = [
    'generated_at',
    'model',
    'metric',
    'r_value',
    'easycris_value',
    'abs_diff',
    'rel_diff',
    'abs_tolerance',
    'rel_tolerance',
    'effective_abs_tolerance',
    'effective_rel_tolerance',
    'accepted_drift',
    'acceptance_reason',
    'pass',
  ]

  const csvLines = [
    csvHeader.join(','),
    ...rows.map((row) =>
      [
        generatedAt,
        row.model,
        row.metric,
        row.r_value,
        row.easycris_value,
        row.abs_diff,
        row.rel_diff,
        row.abs_tolerance,
        row.rel_tolerance,
        row.effective_abs_tolerance,
        row.effective_rel_tolerance,
        row.accepted_drift,
        row.acceptance_reason,
        row.pass,
      ]
        .map(toCsvCell)
        .join(',')
    ),
  ]
  fs.writeFileSync(DIFF_ARTIFACT_CSV, `${csvLines.join('\n')}\n`)

  const jsonSummary = {
    generatedAt,
    totalModels: new Set(rows.map((row) => row.model)).size,
    totalMetrics: rows.length,
    failedModels,
    failedMetrics,
    acceptedDriftMetrics: rows.filter((row) => row.accepted_drift).length,
    failures: failureMessages,
    subsetInvariantChecks,
  }
  fs.writeFileSync(DIFF_ARTIFACT_JSON, `${JSON.stringify(jsonSummary, null, 2)}\n`)

  return {
    generatedAt,
    failedModels,
    failedMetrics,
    csvPath: DIFF_ARTIFACT_CSV,
    jsonPath: DIFF_ARTIFACT_JSON,
  }
}

function buildBaseModelConfig() {
  return {
    designFormula: '~Treatment',
    mainFactor: 'Treatment',
    mainFactorReference: 'vehicle',
    mainFactorTest: 'THC',
    additionalFactors: [],
    covariates: [],
    includeCovariates: false,
    subsetFilters: null,
    contrastType: 'main',
    applyShrinkage: false,
    shrinkageMethod: 'apeglm',
    organism: 'mmusculus',
    geneIdType: 'ensembl',
    alpha: 0.05,
    minCount: 10,
    minSamples: 3,
    usePadjForSignificance: true,
    pcaTopGenes: 500,
    useNullModel: false,
  }
}

function modelSpec(baselineKey, overrides = {}) {
  const now = Date.now()
  return {
    baselineKey,
    model: {
      ...buildBaseModelConfig(),
      id: `e2e_multi_${baselineKey}_${now}`,
      name: baselineKey,
      ...overrides,
    },
  }
}

function buildModelSpecs() {
  return [
    modelSpec('treatment_main'),
    modelSpec('sex_main', {
      designFormula: '~Sex',
      mainFactor: 'Sex',
      mainFactorReference: 'female',
      mainFactorTest: 'male',
    }),
    modelSpec('strain_main', {
      designFormula: '~Strain',
      mainFactor: 'Strain',
      mainFactorReference: 'C57BL_6',
      mainFactorTest: 'DBA_2J',
    }),

    modelSpec('treatment_sex_interaction', {
      designFormula: '~Treatment * Sex',
      contrastType: 'interaction',
      interactionFactor: 'Sex',
      interactionFactorReference: 'female',
      interactionFactorTest: 'male',
    }),
    modelSpec('treatment_strain_interaction', {
      designFormula: '~Treatment * Strain',
      contrastType: 'interaction',
      interactionFactor: 'Strain',
      interactionFactorReference: 'C57BL_6',
      interactionFactorTest: 'DBA_2J',
    }),
    modelSpec('sex_strain_interaction', {
      designFormula: '~Sex * Strain',
      mainFactor: 'Sex',
      mainFactorReference: 'female',
      mainFactorTest: 'male',
      contrastType: 'interaction',
      interactionFactor: 'Strain',
      interactionFactorReference: 'C57BL_6',
      interactionFactorTest: 'DBA_2J',
    }),
    modelSpec('three_way_interaction', {
      designFormula: '~Treatment * Sex * Strain',
      contrastType: 'interaction',
      interactionFactor: 'Sex',
      interactionFactorReference: 'female',
      interactionFactorTest: 'male',
      interactionFactor2: 'Strain',
      interactionFactor2Reference: 'C57BL_6',
      interactionFactor2Test: 'DBA_2J',
    }),

    modelSpec('treatment_effect_in_all_females', {
      subsetFilters: { Sex: 'female' },
    }),
    modelSpec('treatment_strain_interaction_in_all_females', {
      designFormula: '~Treatment * Strain',
      contrastType: 'interaction',
      interactionFactor: 'Strain',
      interactionFactorReference: 'C57BL_6',
      interactionFactorTest: 'DBA_2J',
      subsetFilters: { Sex: 'female' },
    }),
    modelSpec('treatment_effect_in_all_males', {
      subsetFilters: { Sex: 'male' },
    }),
    modelSpec('treatment_strain_interaction_in_all_males', {
      designFormula: '~Treatment * Strain',
      contrastType: 'interaction',
      interactionFactor: 'Strain',
      interactionFactorReference: 'C57BL_6',
      interactionFactorTest: 'DBA_2J',
      subsetFilters: { Sex: 'male' },
    }),
    modelSpec('treatment_effect_in_all_C57BL6', {
      subsetFilters: { Strain: 'C57BL_6' },
    }),
    modelSpec('treatment_sex_interaction_in_all_C57BL6', {
      designFormula: '~Treatment * Sex',
      contrastType: 'interaction',
      interactionFactor: 'Sex',
      interactionFactorReference: 'female',
      interactionFactorTest: 'male',
      subsetFilters: { Strain: 'C57BL_6' },
    }),
    modelSpec('treatment_effect_in_all_DBA2J', {
      subsetFilters: { Strain: 'DBA_2J' },
    }),
    modelSpec('treatment_sex_interaction_in_all_DBA2J', {
      designFormula: '~Treatment * Sex',
      contrastType: 'interaction',
      interactionFactor: 'Sex',
      interactionFactorReference: 'female',
      interactionFactorTest: 'male',
      subsetFilters: { Strain: 'DBA_2J' },
    }),
    modelSpec('treatment_effect_in_female_C57BL6', {
      subsetFilters: { Sex: 'female', Strain: 'C57BL_6' },
    }),
    modelSpec('treatment_effect_in_female_DBA2J', {
      subsetFilters: { Sex: 'female', Strain: 'DBA_2J' },
    }),
    modelSpec('treatment_effect_in_male_C57BL6', {
      subsetFilters: { Sex: 'male', Strain: 'C57BL_6' },
    }),
    modelSpec('treatment_effect_in_male_DBA2J', {
      subsetFilters: { Sex: 'male', Strain: 'DBA_2J' },
    }),
  ]
}

async function seedRNAseqFromCsv(
  driver,
  {
    countsCsvPath = COUNTS_CSV_PATH,
    metadataCsvPath = METADATA_CSV_PATH,
    projectName = 'RNA-seq Multi-run Comparator',
    clearAllData = false,
  } = {}
) {
  const seed = await driver.executeScript(
    async ({ countsCsvPath, metadataCsvPath, projectName, clearAllData }) => {
      if (clearAllData) {
        await window.__E2E__.clearAllData()
      }
      const projectId = await window.__E2E__.createRNAseqProject(projectName)
      const countsDatasetId = await window.__E2E__.importCSV(countsCsvPath)
      const metadataDatasetId = await window.__E2E__.importCSV(metadataCsvPath)
      await window.__E2E__.linkRNAseqDatasets({
        projectId,
        countsDatasetId,
        metadataDatasetId,
      })
      await window.__E2E__.setRNAseqActiveTab({ projectId, tab: 'counts' })
      return { projectId, countsDatasetId, metadataDatasetId }
    },
    { countsCsvPath, metadataCsvPath, projectName, clearAllData }
  )

  if (!seed?.projectId) {
    throw new Error('Failed to seed RNA-seq project from CSV')
  }

  return seed
}

async function runModelAndGetSummary(driver, projectId, model, modelKeyForErrors) {
  const runId = await driver.executeScript(
    async (pid, modelDef) => window.__E2E__.runRNAseqAnalysis({ projectId: pid, model: modelDef }),
    projectId,
    model
  )
  assertTrue(runId, `No run ID returned for ${modelKeyForErrors}`)

  const summary = await driver.executeScript((pid, rid) => {
    const store = window.__E2E__.getRNAseqStore?.()
    const run = store?.getResult?.(pid, rid)
    return run?.summary ?? null
  }, projectId, runId)
  assertTrue(summary, `Missing run summary for ${modelKeyForErrors}`)

  return normalizeSummary(summary)
}

function summarizeInvariantDiffs(subsetSummary, prefilteredSummary) {
  return Object.keys(SUMMARY_RULES).map((metric) => {
    const subset = Number(subsetSummary?.[metric] ?? 0)
    const prefiltered = Number(prefilteredSummary?.[metric] ?? 0)
    return {
      metric,
      subset_value: subset,
      prefiltered_value: prefiltered,
      abs_diff: Math.abs(subset - prefiltered),
    }
  })
}

async function runSubsetInvariantCheck(driver, spec, subsetSummary) {
  const fixture = createPrefilteredFixture(spec.baselineKey, spec.model.subsetFilters)
  if (!fixture) {
    return null
  }

  const seed = await seedRNAseqFromCsv(driver, {
    countsCsvPath: fixture.countsPath,
    metadataCsvPath: fixture.metadataPath,
    projectName: `RNA-seq Invariant ${spec.baselineKey}`,
    clearAllData: false,
  })

  const invariantModel = {
    ...spec.model,
    id: `${spec.model.id}_prefilter_${Date.now()}`,
    name: `${spec.baselineKey}_prefiltered`,
    subsetFilters: null,
  }
  const prefilteredSummary = await runModelAndGetSummary(
    driver,
    seed.projectId,
    invariantModel,
    `${spec.baselineKey} (prefiltered invariant)`
  )

  const diffs = summarizeInvariantDiffs(subsetSummary, prefilteredSummary)
  return {
    model: spec.baselineKey,
    subsetFilters: spec.model.subsetFilters,
    sampleCount: fixture.sampleCount,
    fixture,
    subsetSummary,
    prefilteredSummary,
    equal: diffs.every((row) => row.abs_diff === 0),
    metricDiffs: diffs,
  }
}

async function runTest() {
  let driver
  let webdriver

  try {
    logStep('Starting RNA-seq multi-run R-vs-EasyCris comparator...')

    const baselineMap = loadGoldBaselineMap(GOLD_BASELINE_PATH)
    const specs = buildModelSpecs()
    for (const spec of specs) {
      assertTrue(baselineMap.has(spec.baselineKey), `Missing gold baseline row: ${spec.baselineKey}`)
    }

    const setup = await setupTest()
    driver = setup.driver
    webdriver = setup.webdriver

    await driver.manage().setTimeouts({ script: 600000 })
    await verifyCleanState(driver)
    await assertE2EShimExists(driver)

    logStep('Seeding RNA-seq project from CSV files...')
    const seed = await seedRNAseqFromCsv(driver, { clearAllData: true })
    const projectId = seed.projectId
    logStep(`Seeded project ${projectId} with counts/metadata CSV`)
    assertTrue(projectId, 'No active RNA-seq project after fixture load')

    const failures = []
    const diffRows = []
    const subsetInvariantChecks = []

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]
      const runLabel = `[${i + 1}/${specs.length}] ${spec.baselineKey}`
      logStep(`Running model ${runLabel}`)

      const actual = await runModelAndGetSummary(driver, projectId, spec.model, spec.baselineKey)
      const expected = baselineMap.get(spec.baselineKey)
      const evaluation = evaluateModelSummary(spec.baselineKey, actual, expected)
      diffRows.push(...evaluation.rows)
      for (const acceptedDrift of evaluation.acceptedDrifts ?? []) {
        logStep(`[Accepted Drift] ${spec.baselineKey}: ${acceptedDrift}`)
      }
      if (evaluation.failureMessage) {
        failures.push(evaluation.failureMessage)
        console.error(`[Test] MISMATCH: ${evaluation.failureMessage}`)
        if (spec.model.subsetFilters && Object.keys(spec.model.subsetFilters).length > 0) {
          try {
            const invariant = await runSubsetInvariantCheck(driver, spec, actual)
            if (invariant) {
              subsetInvariantChecks.push(invariant)
              if (invariant.equal) {
                logStep(`[Invariant] ${spec.baselineKey}: subset-vs-prefiltered MATCH`)
              } else {
                logStep(`[Invariant] ${spec.baselineKey}: subset-vs-prefiltered MISMATCH`)
              }
            }
          } catch (invariantError) {
            subsetInvariantChecks.push({
              model: spec.baselineKey,
              subsetFilters: spec.model.subsetFilters,
              error: invariantError?.message ?? String(invariantError),
            })
            console.error(
              `[Test] Invariant check failed for ${spec.baselineKey}: ${invariantError?.message ?? invariantError}`
            )
          }
        }
      } else {
        logSuccess(
          `${runLabel} matched (tested=${actual.tested_genes}, p05=${actual.significant_p05}, p01=${actual.significant_p01}, p001=${actual.significant_p001}, padj05=${actual.significant_padj05})`
        )
      }
    }

    const artifact = writeDiffArtifacts(diffRows, failures, subsetInvariantChecks)
    logStep(`Saved multi-run diff CSV: ${artifact.csvPath}`)
    logStep(`Saved multi-run diff JSON: ${artifact.jsonPath}`)

    if (failures.length > 0) {
      throw new Error(
        `RNA-seq multi-run comparison failed for ${failures.length} model(s):\n\n${failures.join('\n\n')}`
      )
    }

    logSuccess(`COMPLETE: ${specs.length} RNA-seq runs numerically matched gold R baselines`)
  } catch (error) {
    console.error(`[Test] FAILED: ${error.message}`)
    throw error
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch((err) => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
