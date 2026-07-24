/**
 * Synergy Module Utilities
 *
 * Shared validation and pivot logic for all synergy tests.
 * Implements:
 * - Tolerance-based dose comparison
 * - Missing-cell validation
 * - Replicate aggregation with mean
 */

import type {
  ColumnClassification,
  TestValidationResult,
} from '../core/types'
import { TestValidator } from '../core/TestValidator'

/**
 * Tolerance for floating-point dose comparison
 */
const DOSE_TOLERANCE = 1e-9

/**
 * Compare two dose values with tolerance
 */
export function dosesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < DOSE_TOLERANCE
}

/**
 * Result of synergy pivot operation
 */
export interface SynergyPivotResult {
  success: boolean
  error?: string
  doses_a?: number[]
  doses_b?: number[]
  responses_a?: number[]
  responses_b?: number[]
  combo_matrix?: number[][]
  warnings?: string[]
  // Sparse mode fields
  sparse_mode?: boolean
  sparse_data?: {
    dose_a: number[]
    dose_b: number[]
    response_a: number[]
    response_b: number[]
    combo_response: number[]
  }
}

export interface SynergyPivotOptions {
  /**
   * When true, builds a full grid including 0-dose edges (required by Loewe/ZIP implementations).
   * When false, builds the non-zero-only combo grid (common for Bliss/HSA).
   */
  includeZeroEdges: boolean
  /**
   * Optional single-agent response columns aligned to the combo rows.
   * Used when the dataset does not contain explicit boundary rows (dose_a==0 or dose_b==0).
   */
  responseA?: Array<number | undefined>
  responseB?: Array<number | undefined>
}

/**
 * Validate synergy column selection
 *
 * Common validation for all synergy tests:
 * 1. At least 3 numeric (or binary) columns required (mapped via SynergyColumnMapperDialog):
 *    - Drug A Dose
 *    - Drug B Dose
 *    - Combined Response
 * 2. Optional (recommended for sparse screens): 2 additional numeric (or binary) columns:
 *    - Drug A Single-Agent Response
 *    - Drug B Single-Agent Response
 * 2. All columns must be numeric or binary (0/1)
 */
export function validateSynergySelection(
  columns: ColumnClassification[],
  testName: string
): TestValidationResult {
  if (columns.length < 3) {
    return {
      isValid: false,
      errors: [
        `${testName} requires at least 3 columns: Drug A Dose, Drug B Dose, Combined Response. Selected: ${columns.length}.`,
      ],
      warnings: [],
      suggestions: [
        'Select at least 3 numeric columns, then use the column mapper dialog to assign each to the appropriate field.',
      ],
    }
  }

  // Check all columns are numeric (binary 0/1 is allowed)
  const numericResult = TestValidator.checkAllNumeric(columns, testName, { allowBinary: true })
  if (numericResult) return numericResult

  // Check for minimum data points
  // ColumnClassification.totalValues is already non-missing (see ColumnDataExtractor),
  // so do NOT subtract missingValues (that double-counts and can go negative).
  const minN = Math.min(...columns.map(c => c.totalValues))

  if (minN < 5) {
    return {
      isValid: false,
      errors: [
        `Insufficient data: ${minN} rows. ${testName} requires at least 5 data points (2 single-agent + combination).`,
      ],
      warnings: [],
      suggestions: [
        'Boundary mode: include single-agent boundary rows (doseA=0 or doseB=0) plus combinations.',
        'Explicit mode (sparse screens): include responseA/responseB columns for each combination row.',
      ],
    }
  }

  return {
    isValid: true,
    errors: [],
    warnings: [],
    suggestions: [],
  }
}

/**
 * Extract and align synergy data from rows
 */
export function extractSynergyData(
  doseAIndex: number,
  doseBIndex: number,
  responseIndex: number,
  rows: any[],
  responseAIndex?: number,
  responseBIndex?: number
): {
  dose_a: number[]
  dose_b: number[]
  response: Array<number | undefined>
  response_a?: Array<number | undefined>
  response_b?: Array<number | undefined>
} {
  const dose_a: number[] = []
  const dose_b: number[] = []
  const response: Array<number | undefined> = []
  const response_a: Array<number | undefined> = []
  const response_b: Array<number | undefined> = []

  for (const row of rows) {
    const daVal = row[doseAIndex]
    const dbVal = row[doseBIndex]
    const respVal = row[responseIndex]

    // Skip if any value is missing
    if (daVal === null || daVal === undefined || daVal === '') continue
    if (dbVal === null || dbVal === undefined || dbVal === '') continue

    const daNum = typeof daVal === 'number' ? daVal : parseFloat(String(daVal))
    const dbNum = typeof dbVal === 'number' ? dbVal : parseFloat(String(dbVal))

    // Skip if any fails to parse
    if (isNaN(daNum) || isNaN(dbNum)) continue

    dose_a.push(daNum)
    dose_b.push(dbNum)

    // Combined response is optional: allow rows that only provide single-agent responses.
    if (respVal === null || respVal === undefined || respVal === '') {
      response.push(undefined)
    } else {
      const respNum = typeof respVal === 'number' ? respVal : parseFloat(String(respVal))
      response.push(Number.isFinite(respNum) ? respNum : undefined)
    }

    if (responseAIndex !== undefined) {
      const v = row[responseAIndex]
      if (v === null || v === undefined || v === '') {
        response_a.push(undefined)
      } else {
        const n = typeof v === 'number' ? v : parseFloat(String(v))
        response_a.push(Number.isFinite(n) ? n : undefined)
      }
    }

    if (responseBIndex !== undefined) {
      const v = row[responseBIndex]
      if (v === null || v === undefined || v === '') {
        response_b.push(undefined)
      } else {
        const n = typeof v === 'number' ? v : parseFloat(String(v))
        response_b.push(Number.isFinite(n) ? n : undefined)
      }
    }
  }

  const result: any = { dose_a, dose_b, response }
  if (responseAIndex !== undefined) result.response_a = response_a
  if (responseBIndex !== undefined) result.response_b = response_b
  return result
}

/**
 * Check if we can use sparse synergy mode
 *
 * Sparse mode is used when:
 * 1. ResponseA and ResponseB columns are provided
 * 2. All values are defined (no missing data)
 * 3. We don't need a full grid (Bliss/HSA work with sparse data)
 *
 * This is statistically sound for real-life sparse combo screens.
 */
function trySparseSynergyMode(
  dose_a: number[],
  dose_b: number[],
  response: Array<number | undefined>,
  options: SynergyPivotOptions
): SynergyPivotResult | null {
  // Need explicit response columns
  if (!options.responseA || !options.responseB) {
    return null
  }

  // Filter to valid rows (all fields defined and non-zero doses)
  const validRows: number[] = []
  for (let i = 0; i < dose_a.length; i++) {
    const da = dose_a[i]
    const db = dose_b[i]
    const resp = response[i]
    const respA = options.responseA[i]
    const respB = options.responseB[i]

    // Skip if any value is missing
    if (da === undefined || db === undefined || resp === undefined || respA === undefined || respB === undefined) {
      continue
    }

    // Skip zero doses (these are boundary conditions, not combo data)
    if (dosesEqual(da, 0) || dosesEqual(db, 0)) {
      continue
    }

    validRows.push(i)
  }

  // Need at least 3 combinations for meaningful synergy analysis
  if (validRows.length < 3) {
    return null
  }

  // Extract sparse data
  const sparse_dose_a: number[] = []
  const sparse_dose_b: number[] = []
  const sparse_response_a: number[] = []
  const sparse_response_b: number[] = []
  const sparse_combo: number[] = []

  for (const i of validRows) {
    sparse_dose_a.push(dose_a[i]!)
    sparse_dose_b.push(dose_b[i]!)
    sparse_response_a.push(options.responseA![i]!)
    sparse_response_b.push(options.responseB![i]!)
    sparse_combo.push(response[i]!)
  }

  return {
    success: true,
    sparse_mode: true,
    sparse_data: {
      dose_a: sparse_dose_a,
      dose_b: sparse_dose_b,
      response_a: sparse_response_a,
      response_b: sparse_response_b,
      combo_response: sparse_combo,
    },
    warnings: [
      `Sparse mode: Analyzing ${validRows.length} combination points without requiring full dose matrix. ` +
      `This is appropriate for real-life sparse combo screens.`
    ],
  }
}

/**
 * Pivot plate list data to synergy matrix format
 *
 * Implements:
 * - Tolerance-based dose matching
 * - Missing-cell validation
 * - Replicate aggregation with mean
 * - Sparse mode for real-life combo data
 */
export function pivotToSynergyPayload(
  dose_a: number[],
  dose_b: number[],
  response: Array<number | undefined>,
  options: SynergyPivotOptions
): SynergyPivotResult {
  // Try sparse mode only for non-zero interior grids (Bliss/HSA).
  // Loewe/ZIP expect a full matrix with 0-dose edges and should NOT use sparse mode.
  if (!options.includeZeroEdges) {
    const sparseResult = trySparseSynergyMode(dose_a, dose_b, response, options)
    if (sparseResult) {
      return sparseResult
    }
  }

  // Fall back to full grid pivot
  const warnings: string[] = []

  function uniqueSortedWithTolerance(values: number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b)
    const unique: number[] = []
    for (const value of sorted) {
      const last = unique[unique.length - 1]
      if (last === undefined || !dosesEqual(value, last)) {
        unique.push(value)
      }
    }
    return unique
  }

  // Get unique sorted doses (excluding 0 for matrix, but including 0 for boundaries)
  const allDosesA = uniqueSortedWithTolerance(dose_a)
  const allDosesB = uniqueSortedWithTolerance(dose_b)

  // Interior doses (excluding 0) for combo matrix
  const nonZeroDosesA = allDosesA.filter(d => d > 0)
  const nonZeroDosesB = allDosesB.filter(d => d > 0)

  // Check boundary data exists
  const hasDoseBZero = allDosesB.some(d => dosesEqual(d, 0))
  const hasDoseAZero = allDosesA.some(d => dosesEqual(d, 0))

  if (nonZeroDosesA.length < 2) {
    return {
      success: false,
      error: `Insufficient Drug A doses: ${nonZeroDosesA.length}. Need at least 2 non-zero dose levels.`,
    }
  }

  if (nonZeroDosesB.length < 2) {
    return {
      success: false,
      error: `Insufficient Drug B doses: ${nonZeroDosesB.length}. Need at least 2 non-zero dose levels.`,
    }
  }

  // Helper: find all matching rows and aggregate replicates
  function getResponseWithReplicateHandling(
    targetDoseA: number,
    targetDoseB: number
  ): { value: number; replicateCount: number } | null {
    const matchingValues: number[] = []

    for (let i = 0; i < dose_a.length; i++) {
      if (dosesEqual(dose_a[i]!, targetDoseA) && dosesEqual(dose_b[i]!, targetDoseB)) {
        const v = response[i]
        if (v === undefined) continue
        matchingValues.push(v)
      }
    }

    if (matchingValues.length === 0) return null
    if (matchingValues.length === 1) {
      return { value: matchingValues[0]!, replicateCount: 1 }
    }

    // Aggregate replicates with mean
    const sum = matchingValues.reduce((acc, v) => acc + v, 0)
    const mean = sum / matchingValues.length
    return { value: mean, replicateCount: matchingValues.length }
  }

  // Track replicate aggregations
  let totalReplicateCells = 0

  const hasExplicitSingleAgents = Boolean(options.responseA && options.responseB)

  function getSingleAgentA(da: number): { value: number; replicateCount: number } | null {
    const boundary = hasDoseBZero ? getResponseWithReplicateHandling(da, 0) : null
    if (boundary) return boundary
    if (!options.responseA) return null
    const matching: number[] = []
    for (let i = 0; i < dose_a.length; i++) {
      const v = options.responseA[i]
      if (v === undefined) continue
      if (dosesEqual(dose_a[i]!, da)) matching.push(v)
    }
    if (matching.length === 0) return null
    if (matching.length === 1) return { value: matching[0]!, replicateCount: 1 }
    const mean = matching.reduce((a, b) => a + b, 0) / matching.length
    return { value: mean, replicateCount: matching.length }
  }

  function getSingleAgentB(db: number): { value: number; replicateCount: number } | null {
    const boundary = hasDoseAZero ? getResponseWithReplicateHandling(0, db) : null
    if (boundary) return boundary
    if (!options.responseB) return null
    const matching: number[] = []
    for (let i = 0; i < dose_b.length; i++) {
      const v = options.responseB[i]
      if (v === undefined) continue
      if (dosesEqual(dose_b[i]!, db)) matching.push(v)
    }
    if (matching.length === 0) return null
    if (matching.length === 1) return { value: matching[0]!, replicateCount: 1 }
    const mean = matching.reduce((a, b) => a + b, 0) / matching.length
    return { value: mean, replicateCount: matching.length }
  }

  if (!hasExplicitSingleAgents && (!hasDoseAZero || !hasDoseBZero)) {
    return {
      success: false,
      error:
        'Missing single-agent data. Provide boundary rows (dose_a=0 and dose_b=0) OR select optional response_a/response_b columns.',
    }
  }

  const dosesA = options.includeZeroEdges ? [0, ...nonZeroDosesA] : nonZeroDosesA
  const dosesB = options.includeZeroEdges ? [0, ...nonZeroDosesB] : nonZeroDosesB

  const responses_a: number[] = []
  for (const da of dosesA) {
    if (options.includeZeroEdges && dosesEqual(da, 0)) {
      const base = getResponseWithReplicateHandling(0, 0)
      if (!base) {
        warnings.push('Missing control response at dose_a=0, dose_b=0; assumed 0 for baseline')
        responses_a.push(0)
      } else {
        responses_a.push(base.value)
      }
      continue
    }
    const r = getSingleAgentA(da)
    if (!r)
      return {
        success: false,
        error:
          `Missing Drug A single-agent response for dose_a=${da}. ` +
          `Provide a boundary row (dose_b=0) or use explicit single-agent columns (responseA/responseB).`,
      }
    responses_a.push(r.value)
    if (r.replicateCount > 1) totalReplicateCells++
  }

  const responses_b: number[] = []
  for (const db of dosesB) {
    if (options.includeZeroEdges && dosesEqual(db, 0)) {
      const base = getResponseWithReplicateHandling(0, 0)
      if (!base) {
        warnings.push('Missing control response at dose_a=0, dose_b=0; assumed 0 for baseline')
        responses_b.push(0)
      } else {
        responses_b.push(base.value)
      }
      continue
    }
    const r = getSingleAgentB(db)
    if (!r)
      return {
        success: false,
        error:
          `Missing Drug B single-agent response for dose_b=${db}. ` +
          `Provide a boundary row (dose_a=0) or use explicit single-agent columns (responseA/responseB).`,
      }
    responses_b.push(r.value)
    if (r.replicateCount > 1) totalReplicateCells++
  }

  // Build combo_matrix: [n_doses_a x n_doses_b]
  const combo_matrix: number[][] = []
  for (const da of dosesA) {
    const row: number[] = []
    for (const db of dosesB) {
      if (options.includeZeroEdges) {
        if (dosesEqual(da, 0) && dosesEqual(db, 0)) {
          row.push(responses_a[0]!)
          continue
        }
        if (dosesEqual(db, 0)) {
          row.push(responses_a[dosesA.findIndex(x => dosesEqual(x, da))]!)
          continue
        }
        if (dosesEqual(da, 0)) {
          row.push(responses_b[dosesB.findIndex(x => dosesEqual(x, db))]!)
          continue
        }
      }

      const r = getResponseWithReplicateHandling(da, db)
      if (!r) return { success: false, error: `Missing response for dose_a=${da}, dose_b=${db} (combination)` }
      row.push(r.value)
      if (r.replicateCount > 1) totalReplicateCells++
    }
    combo_matrix.push(row)
  }

  // Add replicate warning if applicable
  if (totalReplicateCells > 0) {
    warnings.push(
      `Replicates detected at ${totalReplicateCells} dose combinations; aggregated using mean`
    )
  }

  return {
    success: true,
    doses_a: dosesA,
    doses_b: dosesB,
    responses_a,
    responses_b,
    combo_matrix,
    warnings,
  }
}
