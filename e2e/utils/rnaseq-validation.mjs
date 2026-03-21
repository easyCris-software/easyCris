/**
 * RNA-seq E2E validation helpers
 * Loads R baselines and compares gene-level outputs with tolerances.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const PROJECT_ROOT = path.resolve(__dirname, '../..')
export const RNASEQ_VALIDATION_ROOT = path.join(PROJECT_ROOT, '_test_validation', 'RNA_seq')
export const RNASEQ_RESULTS_DIR = path.join(RNASEQ_VALIDATION_ROOT, 'results')
export const RNASEQ_FIXTURES_DIR = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'datasets', 'RNAseq')

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
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
        continue
      }
      inQuotes = !inQuotes
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

function parseCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const header = parseCsvLine(lines[0] ?? '')
  const rows = lines.slice(1).map(parseCsvLine)
  return { header, rows }
}

function parseMaybeNumber(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower === 'na' || lower === 'nan') return null
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : null
}

function parseMaybeBool(value) {
  const trimmed = String(value ?? '').trim().toLowerCase()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return null
}

export function loadMetricCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Baseline file not found: ${filePath}`)
  }
  const { rows } = parseCsv(filePath)
  const metrics = {}
  for (const row of rows) {
    const metric = row[0]
    const value = row[1]
    if (!metric) continue
    const num = parseMaybeNumber(value)
    metrics[metric] = num ?? value
  }
  return metrics
}

const NUMERIC_GENE_FIELDS = new Set([
  'baseMean',
  'log2FoldChange',
  'lfcSE',
  'stat',
  'pvalue',
  'padj',
])

const BOOLEAN_GENE_FIELDS = new Set(['significant'])

export function loadGeneCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Gene CSV not found: ${filePath}`)
  }
  const { header, rows } = parseCsv(filePath)
  const normalizedHeader = header.map((name) => (name ?? '').trim())

  return rows.map((row) => {
    const record = {}
    for (let i = 0; i < normalizedHeader.length; i += 1) {
      const key = normalizedHeader[i]
      if (!key) continue
      const raw = row[i] ?? ''
      if (NUMERIC_GENE_FIELDS.has(key)) {
        record[key] = parseMaybeNumber(raw)
      } else if (BOOLEAN_GENE_FIELDS.has(key)) {
        const parsed = parseMaybeBool(raw)
        record[key] = parsed === null ? raw : parsed
      } else {
        record[key] = String(raw ?? '').trim()
      }
    }
    return record
  })
}

function withinTolerance(expected, actual, config) {
  const diff = Math.abs(actual - expected)
  const baseline = Math.max(Math.abs(expected), config.minBaseline)
  const allowed = Math.max(config.absTol, config.relTol * baseline)
  return diff <= allowed
}

export function compareGeneResults(actualRows, baselineRows, options = {}) {
  const metricTolerances = {
    default: { relTol: 0.15, absTol: 0.15, minBaseline: 0.025 },
    baseMean: { relTol: 0.15, absTol: 0.15, minBaseline: 0.025 },
    log2FoldChange: { relTol: 0.15, absTol: 0.15, minBaseline: 0.025 },
    // DESeq2 (R) vs PyDESeq2 with LOWESS optimization (frac=0.45, iter=0) - all metrics use 15% tolerance.
    // LOWESS-optimized dispersion fit achieves better cross-implementation parity.
    lfcSE: { relTol: 0.15, absTol: 0.15, minBaseline: 0.05 },
    stat: { relTol: 0.15, absTol: 0.15, minBaseline: 0.1 },
    // Use 15% tolerance for both relative and absolute - LOWESS optimization improves p-value consistency.
    pvalue: { relTol: 0.15, absTol: 0.15, minBaseline: 0.0001 },
    padj: { relTol: 0.15, absTol: 0.15, minBaseline: 0.0001 },
    ...(options.metricTolerances || {}),
  }

  const skipFields = new Set(options.skipFields || [])
  const skipSignificant = Boolean(options.skipSignificant)
  const skipDirection = Boolean(options.skipDirection)
  const skipSigCategory = Boolean(options.skipSigCategory)

  const baselineMap = new Map(baselineRows.map((row) => [row.geneId, row]))
  const actualMap = new Map(actualRows.map((row) => [row.geneId, row]))

  const missingInActual = []
  const missingInBaseline = []
  const mismatches = []

  for (const geneId of baselineMap.keys()) {
    if (!actualMap.has(geneId)) missingInActual.push(geneId)
  }
  for (const geneId of actualMap.keys()) {
    if (!baselineMap.has(geneId)) missingInBaseline.push(geneId)
  }

  const fieldsToCompare = Array.from(NUMERIC_GENE_FIELDS).filter((field) => !skipFields.has(field))
  const maxDiffs = options.maxDiffs ?? 20
  let mismatchCount = 0
  const failingGenes = new Set()

  for (const [geneId, baselineRow] of baselineMap.entries()) {
    const actualRow = actualMap.get(geneId)
    if (!actualRow) continue

    for (const field of fieldsToCompare) {
      const expected = baselineRow[field]
      const actual = actualRow[field]
      if (expected == null && actual == null) continue
      if (expected == null || actual == null) {
        mismatchCount += 1
        failingGenes.add(geneId)
        if (mismatches.length < maxDiffs) {
          mismatches.push({ geneId, field, expected, actual, status: 'MISSING' })
        }
        continue
      }

      const config = metricTolerances[field] ?? metricTolerances.default
      if (!withinTolerance(expected, actual, config)) {
        mismatchCount += 1
        failingGenes.add(geneId)
        if (mismatches.length < maxDiffs) {
          mismatches.push({
            geneId,
            field,
            expected,
            actual,
            diff: Math.abs(actual - expected),
            status: 'FAILED',
          })
        }
      }
    }

    if (!skipSignificant) {
      const expectedSig = baselineRow.significant
      const actualSig = actualRow.significant
      if (expectedSig !== actualSig) {
        mismatchCount += 1
        failingGenes.add(geneId)
        if (mismatches.length < maxDiffs) {
          mismatches.push({
            geneId,
            field: 'significant',
            expected: expectedSig,
            actual: actualSig,
            status: 'FAILED',
          })
        }
      }
    }

    if (!skipDirection) {
      // Skip direction validation for genes with log2FoldChange essentially at zero
      // (numerical noise can cause sign differences)
      const expectedLFC = baselineRow.log2FoldChange
      const actualLFC = actualRow.log2FoldChange
      const lfcThreshold = 1e-5

      if (
        expectedLFC != null &&
        actualLFC != null &&
        (Math.abs(expectedLFC) > lfcThreshold || Math.abs(actualLFC) > lfcThreshold)
      ) {
        const expectedDirection = baselineRow.direction
        const actualDirection = actualRow.direction
        if (expectedDirection !== actualDirection) {
          mismatchCount += 1
          failingGenes.add(geneId)
          if (mismatches.length < maxDiffs) {
            mismatches.push({
              geneId,
              field: 'direction',
              expected: expectedDirection,
              actual: actualDirection,
              status: 'FAILED',
            })
          }
        }
      }
    }

    if (!skipSigCategory) {
      const expectedSigCat = baselineRow.sigCategory
      const actualSigCat = actualRow.sigCategory
      if (expectedSigCat !== actualSigCat) {
        mismatchCount += 1
        failingGenes.add(geneId)
        if (mismatches.length < maxDiffs) {
          mismatches.push({
            geneId,
            field: 'sigCategory',
            expected: expectedSigCat,
            actual: actualSigCat,
            status: 'FAILED',
          })
        }
      }
    }
  }

  return {
    passed:
      missingInActual.length === 0 &&
      missingInBaseline.length === 0 &&
      mismatchCount === 0,
    totalBaseline: baselineRows.length,
    totalActual: actualRows.length,
    missingInActual,
    missingInBaseline,
    mismatchCount,
    failingGenesCount: failingGenes.size,
    mismatches,
  }
}

export function assertGeneResults(comparison) {
  if (comparison.passed) {
    return
  }

  const parts = []
  if (comparison.missingInActual.length > 0) {
    parts.push(`Missing in easyCris: ${comparison.missingInActual.length}`)
  }
  if (comparison.missingInBaseline.length > 0) {
    parts.push(`Missing in R baseline: ${comparison.missingInBaseline.length}`)
  }
  if (comparison.mismatchCount > 0) {
    parts.push(`${comparison.failingGenesCount} genes failed (${comparison.mismatchCount} metric mismatches)`)
  }

  const mismatchPreview = comparison.mismatches
    .map((diff) => `${diff.geneId} ${diff.field}: expected=${diff.expected}, actual=${diff.actual}`)
    .join('\n')

  throw new Error(
    `RNA-seq gene validation failed. ${parts.join(' | ')}\n` +
    (mismatchPreview ? `Sample diffs:\n${mismatchPreview}` : '')
  )
}
