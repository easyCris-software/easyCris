/**
 * Contingency Table Builder
 *
 * Shared utility for building contingency tables from categorical data.
 * Used by chi-square, Fisher's exact, and McNemar tests.
 *
 * Key Features:
 * - Works with column arrays from cacheService (not rows array)
 * - Honors dataRowCount to exclude buffer rows
 * - Label preservation (stores original case-sensitive labels)
 * - Case-insensitive counting with optional normalization
 * - Pairwise deletion (automatically removes rows with missing values)
 * - Flexible table dimensions (2×2, 2×N, N×M)
 * - Symmetric table support (for McNemar's test)
 */

import { isMissingValue } from '../core/ColumnDataExtractor'

export interface ContingencyTableResult {
  /** Contingency table as 2D array (rows × columns) */
  table: number[][]
  /** Row labels (sorted alphabetically, original case preserved) */
  rowLabels: string[]
  /** Column labels (sorted alphabetically, original case preserved) */
  colLabels: string[]
  /** Total number of observations counted (after missing value removal) */
  n: number
}

export interface ContingencyTableOptions {
  /** If true, treat labels case-insensitively ("Yes" and "yes" are the same) */
  caseInsensitive?: boolean
  /** Maximum number of rows to process (dataRowCount, excludes buffer rows) */
  maxRows?: number
}

/**
 * Build contingency table from two categorical columns
 *
 * General purpose builder that creates contingency tables of any dimension.
 * Used by Chi-Square Independence Test for tables of any size.
 *
 * Algorithm:
 * 1. Scan both columns to collect unique values (with optional case normalization)
 * 2. Remove rows with missing values in either column (pairwise deletion)
 * 3. Sort labels alphabetically
 * 4. Build frequency table counting co-occurrences
 *
 * IMPORTANT: Works with column arrays from cacheService, bounded by maxRows to exclude buffer rows.
 *
 * @param col1Data - First categorical column (array of values)
 * @param col2Data - Second categorical column (array of values)
 * @param options - Optional configuration (caseInsensitive, maxRows)
 * @returns Contingency table with labels, or null if no valid data
 *
 * @example
 * const table = buildContingencyTable(column1, column2, { maxRows: dataRowCount })
 * // Returns: { table: [[10, 5], [3, 12]], rowLabels: ['A', 'B'], colLabels: ['X', 'Y'], n: 30 }
 */
export function buildContingencyTable(
  col1Data: any[],
  col2Data: any[],
  options?: ContingencyTableOptions
): ContingencyTableResult | null {
  const caseInsensitive = options?.caseInsensitive ?? false
  const maxRows = options?.maxRows ?? Math.min(col1Data.length, col2Data.length)

  // Track original labels (case-preserved) mapped to normalized keys
  const col1OriginalLabels = new Map<string, string>() // normalizedKey -> original label
  const col2OriginalLabels = new Map<string, string>()
  const col1Keys = new Set<string>() // Normalized keys for counting
  const col2Keys = new Set<string>()

  // Helper to normalize labels
  const normalizeLabel = (value: any): string | null => {
    if (isMissingValue(value)) return null
    const str = String(value).trim()
    if (str === '') return null
    return caseInsensitive ? str.toLowerCase() : str
  }

  // First pass: collect unique values
  for (let i = 0; i < maxRows; i++) {
    if (i >= col1Data.length || i >= col2Data.length) break

    const val1 = col1Data[i]
    const val2 = col2Data[i]

    const key1 = normalizeLabel(val1)
    const key2 = normalizeLabel(val2)

    if (key1 === null || key2 === null) continue

    if (!col1OriginalLabels.has(key1)) {
      col1OriginalLabels.set(key1, String(val1).trim()) // Store first occurrence's original case
    }
    if (!col2OriginalLabels.has(key2)) {
      col2OriginalLabels.set(key2, String(val2).trim())
    }

    col1Keys.add(key1)
    col2Keys.add(key2)
  }

  // No valid data found
  if (col1Keys.size === 0 || col2Keys.size === 0) {
    return null
  }

  // Sort normalized keys alphabetically
  const sortedCol1Keys = Array.from(col1Keys).sort()
  const sortedCol2Keys = Array.from(col2Keys).sort()

  // Get original labels in sorted order
  const rowLabels = sortedCol1Keys.map(key => col1OriginalLabels.get(key)!)
  const colLabels = sortedCol2Keys.map(key => col2OriginalLabels.get(key)!)

  // Create mapping for fast lookup (using normalized keys)
  const rowIndexMap = new Map<string, number>()
  const colIndexMap = new Map<string, number>()

  sortedCol1Keys.forEach((key, idx) => rowIndexMap.set(key, idx))
  sortedCol2Keys.forEach((key, idx) => colIndexMap.set(key, idx))

  // Initialize contingency table with zeros
  const table: number[][] = []
  for (let i = 0; i < rowLabels.length; i++) {
    table.push(new Array(colLabels.length).fill(0))
  }

  // Second pass: count occurrences
  let totalCount = 0
  for (let i = 0; i < maxRows; i++) {
    if (i >= col1Data.length || i >= col2Data.length) break

    const val1 = col1Data[i]
    const val2 = col2Data[i]

    const key1 = normalizeLabel(val1)
    const key2 = normalizeLabel(val2)

    if (key1 === null || key2 === null) continue

    const rowIdx = rowIndexMap.get(key1)
    const colIdx = colIndexMap.get(key2)

    if (rowIdx !== undefined && colIdx !== undefined) {
      table[rowIdx]![colIdx]!++
      totalCount++
    }
  }

  return {
    table,
    rowLabels,
    colLabels,
    n: totalCount,
  }
}

/**
 * Build 2×2 contingency table from two categorical columns
 *
 * Specialized builder for Fisher's Exact Test.
 * Enforces strict 2×2 dimension requirement.
 *
 * @param col1Data - First categorical column (array of values)
 * @param col2Data - Second categorical column (array of values)
 * @param options - Optional configuration (caseInsensitive, maxRows)
 * @returns 2×2 contingency table with labels, or null if not exactly 2×2
 *
 * @example
 * const table = build2x2Table(column1, column2, { maxRows: dataRowCount })
 * // Returns: { table: [[10, 5], [3, 12]], rowLabels: ['No', 'Yes'], colLabels: ['Control', 'Treatment'], n: 30 }
 * // Returns null if either column has != 2 categories
 */
export function build2x2Table(
  col1Data: any[],
  col2Data: any[],
  options?: ContingencyTableOptions
): ContingencyTableResult | null {
  const result = buildContingencyTable(col1Data, col2Data, options)

  if (!result) {
    return null
  }

  // Enforce 2×2 dimension
  if (result.table.length !== 2 || result.table[0]!.length !== 2) {
    return null
  }

  return result
}

/**
 * Build symmetric 2×2 contingency table from two categorical columns
 *
 * Specialized builder for McNemar's Test.
 * Enforces symmetric requirement: row and column labels must be identical.
 *
 * Algorithm:
 * 1. Collect unique values from BOTH columns (union)
 * 2. Use the same sorted labels for both rows and columns
 * 3. Build frequency table with symmetric structure
 *
 * This ensures proper alignment for before/after paired measurements
 * where both columns measure the same variable at different times.
 *
 * @param col1Data - First categorical column (before measurement)
 * @param col2Data - Second categorical column (after measurement)
 * @param options - Optional configuration (caseInsensitive, maxRows)
 * @returns Symmetric 2×2 contingency table, or null if not exactly 2×2
 *
 * @example
 * // Before: ['No', 'Yes', 'No', 'Yes']
 * // After:  ['No', 'No', 'Yes', 'Yes']
 * const table = buildSymmetric2x2Table(column1, column2, { maxRows: dataRowCount })
 * // Returns: { table: [[1, 1], [1, 1]], rowLabels: ['No', 'Yes'], colLabels: ['No', 'Yes'], n: 4 }
 */
export function buildSymmetric2x2Table(
  col1Data: any[],
  col2Data: any[],
  options?: ContingencyTableOptions
): ContingencyTableResult | null {
  const caseInsensitive = options?.caseInsensitive ?? false
  const maxRows = options?.maxRows ?? Math.min(col1Data.length, col2Data.length)

  // Track original labels (case-preserved) mapped to normalized keys
  const originalLabels = new Map<string, string>() // normalizedKey -> original label
  const labelKeys = new Set<string>() // Normalized keys for counting

  // Helper to normalize labels
  const normalizeLabel = (value: any): string | null => {
    if (isMissingValue(value)) return null
    const str = String(value).trim()
    if (str === '') return null
    return caseInsensitive ? str.toLowerCase() : str
  }

  // First pass: collect unique values from BOTH columns (union)
  for (let i = 0; i < maxRows; i++) {
    if (i >= col1Data.length || i >= col2Data.length) break

    const val1 = col1Data[i]
    const val2 = col2Data[i]

    const key1 = normalizeLabel(val1)
    const key2 = normalizeLabel(val2)

    if (key1 !== null) {
      if (!originalLabels.has(key1)) {
        originalLabels.set(key1, String(val1).trim())
      }
      labelKeys.add(key1)
    }

    if (key2 !== null) {
      if (!originalLabels.has(key2)) {
        originalLabels.set(key2, String(val2).trim())
      }
      labelKeys.add(key2)
    }
  }

  // No valid data found
  if (labelKeys.size === 0) {
    return null
  }

  // Sort normalized keys alphabetically
  const sortedKeys = Array.from(labelKeys).sort()

  // Enforce 2×2 dimension for McNemar
  if (sortedKeys.length !== 2) {
    return null
  }

  // Get original labels in sorted order (symmetric: same labels for rows and columns)
  const labels = sortedKeys.map(key => originalLabels.get(key)!)
  const rowLabels = labels
  const colLabels = labels

  // Create mapping for fast lookup (using normalized keys)
  const indexMap = new Map<string, number>()
  sortedKeys.forEach((key, idx) => indexMap.set(key, idx))

  // Initialize contingency table with zeros
  const table: number[][] = []
  for (let i = 0; i < labels.length; i++) {
    table.push(new Array(labels.length).fill(0))
  }

  // Second pass: count occurrences
  let totalCount = 0
  for (let i = 0; i < maxRows; i++) {
    if (i >= col1Data.length || i >= col2Data.length) break

    const val1 = col1Data[i]
    const val2 = col2Data[i]

    const key1 = normalizeLabel(val1)
    const key2 = normalizeLabel(val2)

    if (key1 === null || key2 === null) continue

    const rowIdx = indexMap.get(key1)
    const colIdx = indexMap.get(key2)

    if (rowIdx !== undefined && colIdx !== undefined) {
      table[rowIdx]![colIdx]!++
      totalCount++
    }
  }

  return {
    table,
    rowLabels,
    colLabels,
    n: totalCount,
  }
}
