/**
 * Column Data Service
 *
 * Centralized service for cell value access, type classification, and validation.
 * Mirrors Avalonia's ColumnDataExtractor pattern (670+ lines) for consistency.
 *
 * Based on: easyCris.Avalonia/easyCris.Shared/Services/ColumnDataExtractor.cs
 */
import {
  TYPE_CLASSIFICATION_RULES,
  isLikertInteger,
  normalizeCategoryToken,
  parseStrictNumber,
} from '@/lib/classification/typeRules'

// ========== MISSING VALUE DETECTION ==========

/**
 * Global missing value indicators (Avalonia Line 23-35)
 * Standardizes missing data representation across CSV/TSV/Excel imports
 */
const MISSING_VALUE_INDICATORS = new Set([
  'na',
  'n/a',
  'missing',
  'null',
  '.',
  '-',
  'nan',
  '#n/a',
  '#na',
  '', // Empty string
])

export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  const str = String(value).trim()
  if (str === '') return true
  return MISSING_VALUE_INDICATORS.has(str.toLowerCase())
}

// ========== COLUMN DATA TYPE CLASSIFICATION ==========

/**
 * Column data types (Avalonia Line 134-149)
 * 6-type enhanced classification system
 */
export enum ColumnDataType {
  Numeric = 'numeric', // All values parse as double, >10 unique
  Categorical = 'categorical', // Non-numeric strings or <50% numeric
  Binary = 'binary', // Exactly 2 unique values (0/1, Yes/No, Male/Female)
  Ordinal = 'ordinal', // Small set of integers (1-5, 1-7) suggesting Likert scale
  Mixed = 'mixed', // Some numeric, some categorical (>50% but not all)
  Empty = 'empty', // All null/empty
}

/**
 * Column classification result (Avalonia Line 150-175)
 */
export interface ColumnClassification {
  columnId: string
  columnName: string
  dataType: ColumnDataType
  detectedType?: ColumnDataType
  overrideType?: ColumnDataType
  effectiveType?: ColumnDataType
  totalValues: number
  numericValues: number
  categoricalValues: number
  missingValues: number
  uniqueValueCount: number
  uniqueValues: string[]

  // Enhanced detection
  isBinary: boolean
  isOrdinal: boolean
  isConstant?: boolean
  hasMissingData: boolean
  numericRatio: number
  minNumericValue?: number
  maxNumericValue?: number
  suggestedTests: string[]
  dataQualityPercent: number  // FIX: Percentage of non-missing values (0-100)
}

/**
 * Column classification stats from backend (DuckDB or in-memory)
 */
export interface ColumnClassificationStats {
  columnId: string
  totalRows: number
  nonNullCount: number
  distinctCount: number
  distinctCountCaseFolded?: number
  distinctValues?: string[]
  numericCount: number
  minValue?: number | null
  maxValue?: number | null
  integerCount?: number | null
  firstNonMissingRow?: number | null
  lastNonMissingRow?: number | null
}

export function applyColumnTypeOverride(
  classification: ColumnClassification,
  overrideType?: ColumnDataType | null
): ColumnClassification {
  const detectedType = classification.detectedType ?? classification.dataType
  const effectiveType = overrideType ?? detectedType
  return {
    ...classification,
    dataType: effectiveType,
    detectedType,
    overrideType: overrideType ?? undefined,
    effectiveType,
    isBinary: effectiveType === ColumnDataType.Binary || (effectiveType === detectedType && classification.isBinary),
    isOrdinal: effectiveType === ColumnDataType.Ordinal || (effectiveType === detectedType && classification.isOrdinal),
  }
}

/**
 * Classify column using backend-provided stats
 * Mirrors classifyColumn() logic but avoids full row scans in the frontend.
 */
export function classifyColumnFromStats(
  columnId: string,
  columnName: string,
  stats: ColumnClassificationStats
): ColumnClassification {
  const nonMissingCount = Math.max(0, stats.nonNullCount)
  const firstNonMissingRow =
    typeof stats.firstNonMissingRow === 'number' && Number.isFinite(stats.firstNonMissingRow)
      ? Math.max(0, Math.trunc(stats.firstNonMissingRow))
      : null
  const lastNonMissingRow =
    typeof stats.lastNonMissingRow === 'number' && Number.isFinite(stats.lastNonMissingRow)
      ? Math.max(0, Math.trunc(stats.lastNonMissingRow))
      : null
  const windowSpan =
    firstNonMissingRow !== null &&
    lastNonMissingRow !== null &&
    lastNonMissingRow >= firstNonMissingRow
      ? lastNonMissingRow - firstNonMissingRow + 1
      : null
  const totalValues = windowSpan !== null ? windowSpan : Math.max(0, stats.totalRows)
  const missingValues = Math.max(0, totalValues - nonMissingCount)
  const numericValues = Math.max(0, stats.numericCount)
  const categoricalValues = Math.max(0, nonMissingCount - numericValues)
  const normalizedDistinctEntries = Array.isArray(stats.distinctValues)
    ? new Map(
      stats.distinctValues
        .map((value) => String(value).trim())
        .filter((value) => !isMissingValue(value))
        .map((value) => [normalizeCategoryToken(value), value] as const)
    )
    : null
  const uniqueCount = Math.max(
    0,
    stats.distinctCountCaseFolded ?? stats.distinctCount
  )

  const numericRatio = nonMissingCount > 0 ? numericValues / nonMissingCount : 0
  const isBinary = uniqueCount === 2
  const integerCount = typeof stats.integerCount === 'number'
    ? Math.max(0, stats.integerCount)
    : null

  const minNumeric =
    typeof stats.minValue === 'number' && Number.isFinite(stats.minValue)
      ? stats.minValue
      : undefined
  const maxNumeric =
    typeof stats.maxValue === 'number' && Number.isFinite(stats.maxValue)
      ? stats.maxValue
      : undefined

  // Ordinal heuristic: all numeric, small unique set, and bounded integer-like range.
  const isOrdinal =
    numericRatio === 1 &&
    uniqueCount >= TYPE_CLASSIFICATION_RULES.ordinalMinLevels &&
    uniqueCount <= TYPE_CLASSIFICATION_RULES.ordinalMaxLevels &&
    minNumeric !== undefined &&
    maxNumeric !== undefined &&
    minNumeric >= TYPE_CLASSIFICATION_RULES.ordinalMinValue &&
    maxNumeric <= TYPE_CLASSIFICATION_RULES.ordinalMaxValue &&
    integerCount !== null &&
    integerCount === numericValues

  let dataType: ColumnDataType
  const suggestedTests: string[] = []

  if (nonMissingCount === 0) {
    dataType = ColumnDataType.Empty
    suggestedTests.push('Remove this column before analysis')
  } else if (isBinary) {
    dataType = ColumnDataType.Binary
    suggestedTests.push(
      'Chi-Square Test',
      "Fisher's Exact Test",
      'Logistic Regression (as dependent)',
      'Independent T-Test (as grouping variable)'
    )
  } else if (isOrdinal) {
    dataType = ColumnDataType.Ordinal
    suggestedTests.push(
      'Spearman Correlation',
      'Kruskal-Wallis Test',
      'Mann-Whitney U Test',
      'Ordinal Regression'
    )
  } else if (numericRatio >= TYPE_CLASSIFICATION_RULES.numericRatioForNumeric) {
    dataType = ColumnDataType.Numeric
    suggestedTests.push('T-Test', 'ANOVA', 'Linear Regression', 'Pearson Correlation')
  } else if (numericRatio <= TYPE_CLASSIFICATION_RULES.numericRatioForCategorical) {
    dataType = ColumnDataType.Categorical
    suggestedTests.push("Chi-Square Test", "Fisher's Exact Test", 'Multinomial Regression')
  } else {
    dataType = ColumnDataType.Mixed
    suggestedTests.push(
      'Convert to numeric (drop non-numeric rows)',
      'Convert to categorical (encode numeric as bins)'
    )
  }

  const dataQualityPercent =
    totalValues > 0 ? ((totalValues - missingValues) / totalValues) * 100 : 0

  const distinctValues = normalizedDistinctEntries
    ? Array.from(normalizedDistinctEntries.values()).slice(0, 50)
    : []

  return {
    columnId,
    columnName,
    dataType,
    detectedType: dataType,
    effectiveType: dataType,
    totalValues,
    numericValues,
    categoricalValues,
    missingValues,
    uniqueValueCount: uniqueCount,
    uniqueValues: distinctValues,
    isBinary,
    isOrdinal,
    isConstant: uniqueCount <= 1,
    hasMissingData: missingValues > 0,
    numericRatio,
    minNumericValue: minNumeric,
    maxNumericValue: maxNumeric,
    suggestedTests,
    dataQualityPercent,
  }
}

/**
 * Classify column data type with enhanced detection
 * Based on Avalonia's EnhancedClassification (Line 521-672)
 */
export function classifyColumn(
  columnId: string,
  columnName: string,
  rowData: Map<number, Record<string, unknown>>
): ColumnClassification {
  // Extract column values in row-index order so we can detect missing values *between* values
  // and ignore leading/trailing empty rows (common when users paste into sparse sheets).
  const orderedEntries = Array.from(rowData.entries()).sort(([a], [b]) => a - b)
  const allValues = orderedEntries.map(([_, row]) => row?.[columnId])

  // Find effective data window for this column: first..last non-missing value.
  let firstNonMissing = -1
  let lastNonMissing = -1
  for (let i = 0; i < allValues.length; i++) {
    if (!isMissingValue(allValues[i])) {
      firstNonMissing = i
      break
    }
  }
  for (let i = allValues.length - 1; i >= 0; i--) {
    if (!isMissingValue(allValues[i])) {
      lastNonMissing = i
      break
    }
  }

  const values =
    firstNonMissing >= 0 && lastNonMissing >= firstNonMissing
      ? allValues.slice(firstNonMissing, lastNonMissing + 1)
      : []

  // IMPORTANT: totalValues is scoped to the effective data window (between first & last value).
  // This prevents trailing/leading blanks from inflating missing counts/percentages.
  const totalValues = values.length
  let numericValues = 0
  let categoricalValues = 0
  let missingValues = 0
  const uniqueValuesByKey = new Map<string, string>()
  const numericUniqueValues = new Set<number>()

  let minNumeric: number | undefined
  let maxNumeric: number | undefined

  // Scan values within the effective window
  for (const value of values) {
    if (isMissingValue(value)) {
      // Missing value BETWEEN first and last value (internal gap)
      missingValues++
      continue
    }

    const str = String(value).trim()
    uniqueValuesByKey.set(normalizeCategoryToken(str), str)

    // Try numeric parse
    const num = parseStrictNumber(str)
    if (num !== null) {
      numericValues++
      numericUniqueValues.add(num)

      if (minNumeric === undefined || num < minNumeric) minNumeric = num
      if (maxNumeric === undefined || num > maxNumeric) maxNumeric = num
    } else {
      categoricalValues++
    }
  }

  const nonMissingCount = totalValues > 0 ? totalValues - missingValues : 0
  const numericRatio = nonMissingCount > 0 ? numericValues / nonMissingCount : 0
  const uniqueCount = uniqueValuesByKey.size

  // Binary detection: exactly 2 unique values
  const isBinary = uniqueCount === 2

  // Ordinal detection: 3-10 integer values, all ≤ 10 (Likert-like)
  const isOrdinal =
    numericRatio === 1 &&
    uniqueCount >= TYPE_CLASSIFICATION_RULES.ordinalMinLevels &&
    uniqueCount <= TYPE_CLASSIFICATION_RULES.ordinalMaxLevels &&
    Array.from(numericUniqueValues).every(isLikertInteger)

  // Type determination
  let dataType: ColumnDataType
  const suggestedTests: string[] = []

  if (nonMissingCount === 0) {
    dataType = ColumnDataType.Empty
    suggestedTests.push('Remove this column before analysis')
  } else if (isBinary) {
    dataType = ColumnDataType.Binary
    suggestedTests.push(
      'Chi-Square Test',
      "Fisher's Exact Test",
      'Logistic Regression (as dependent)',
      'Independent T-Test (as grouping variable)'
    )
  } else if (isOrdinal) {
    dataType = ColumnDataType.Ordinal
    suggestedTests.push(
      'Spearman Correlation',
      'Kruskal-Wallis Test',
      'Mann-Whitney U Test',
      'Ordinal Regression'
    )
  } else if (numericRatio >= TYPE_CLASSIFICATION_RULES.numericRatioForNumeric) {
    // At least 95% numeric = treat as numeric
    dataType = ColumnDataType.Numeric
    suggestedTests.push('T-Test', 'ANOVA', 'Linear Regression', 'Pearson Correlation')
  } else if (numericRatio <= TYPE_CLASSIFICATION_RULES.numericRatioForCategorical) {
    // 50% or less numeric = categorical
    dataType = ColumnDataType.Categorical
    suggestedTests.push("Chi-Square Test", "Fisher's Exact Test", 'Multinomial Regression')
  } else {
    // Between 50-95% = mixed
    dataType = ColumnDataType.Mixed
    suggestedTests.push(
      'Convert to numeric (drop non-numeric rows)',
      'Convert to categorical (encode numeric as bins)'
    )
  }

  // FIX: Calculate data quality percentage (0-100)
  // Quality is computed within the effective window (not across padded/unrelated rows).
  const dataQualityPercent =
    totalValues > 0 ? ((totalValues - missingValues) / totalValues) * 100 : 0

  return {
    columnId,
    columnName,
    dataType,
    detectedType: dataType,
    effectiveType: dataType,
    totalValues,
    numericValues,
    categoricalValues,
    missingValues,
    uniqueValueCount: uniqueCount,
    uniqueValues: Array.from(uniqueValuesByKey.values()).slice(0, 50), // Max 50 unique samples
    isBinary,
    isOrdinal,
    isConstant: uniqueCount <= 1,
    hasMissingData: missingValues > 0,
    numericRatio,
    minNumericValue: minNumeric,
    maxNumericValue: maxNumeric,
    suggestedTests,
    dataQualityPercent,  // FIX: Include quality percentage
  }
}

// ========== DATA EXTRACTION WITH VALIDATION ==========

/**
 * Data extraction summary (Avalonia Line 10-75)
 * Tracks data quality and issues
 */
export interface DataExtractionSummary {
  validValues: number
  missingValues: number
  unparseableValues: number
  pairwiseRowDrops: number

  missingValueRowIndices: number[]
  unparseableValueRowIndices: number[]
  unparseableExamples: string[]

  totalRows: number
  usableRowCount: number
  dataQualityPercent: number
}

/**
 * Extract numeric data from column with tracking
 * Based on Avalonia's ExtractNumericDataWithTracking (Line 258-340)
 */
export function extractNumericData(
  columnId: string,
  rowData: Map<number, Record<string, unknown>>,
  encoding?: Map<string, number> // For categorical → numeric conversion
): { data: number[]; summary: DataExtractionSummary } {
  const data: number[] = []
  const summary: DataExtractionSummary = {
    validValues: 0,
    missingValues: 0,
    unparseableValues: 0,
    pairwiseRowDrops: 0,
    missingValueRowIndices: [],
    unparseableValueRowIndices: [],
    unparseableExamples: [],
    totalRows: rowData.size,
    usableRowCount: 0,
    dataQualityPercent: 0,
  }

  let rowIndex = 0
  for (const [_, row] of rowData) {
    const value = row[columnId]

    // Missing value check
    if (isMissingValue(value)) {
      summary.missingValues++
      summary.missingValueRowIndices.push(rowIndex)
      rowIndex++
      continue
    }

    // Try numeric parse
    const str = String(value).trim()

    // Encoding lookup (for categorical → numeric)
    if (encoding && encoding.has(str)) {
      data.push(encoding.get(str)!)
      summary.validValues++
    } else {
      const num = Number(str)
      if (!isNaN(num) && isFinite(num)) {
        data.push(num)
        summary.validValues++
      } else {
        // Unparseable value
        summary.unparseableValues++
        summary.unparseableValueRowIndices.push(rowIndex)

        if (summary.unparseableExamples.length < 5) {
          summary.unparseableExamples.push(str)
        }
      }
    }

    rowIndex++
  }

  summary.usableRowCount = summary.validValues
  summary.dataQualityPercent =
    summary.totalRows > 0 ? (summary.usableRowCount / summary.totalRows) * 100 : 0

  return { data, summary }
}

/**
 * Extract aligned numeric data from multiple columns
 * Based on Avalonia's ExtractAlignedNumericData (Line 387-513)
 *
 * CRITICAL: Row-synchronous filtering
 * If ANY column has missing/invalid data in a row, drop that row from ALL columns
 */
export function extractAlignedNumericData(
  columnIds: string[],
  rowData: Map<number, Record<string, unknown>>,
  encodings?: Map<string, Map<string, number>>
): { data: number[][]; summaries: DataExtractionSummary[] } {
  const columnCount = columnIds.length
  const allData: number[][] = Array.from({ length: columnCount }, () => [])

  const summaries: DataExtractionSummary[] = columnIds.map(() => ({
    validValues: 0,
    missingValues: 0,
    unparseableValues: 0,
    pairwiseRowDrops: 0,
    missingValueRowIndices: [],
    unparseableValueRowIndices: [],
    unparseableExamples: [],
    totalRows: rowData.size,
    usableRowCount: 0,
    dataQualityPercent: 0,
  }))

  let rowIndex = 0
  for (const [_, row] of rowData) {
    const rowValues: (number | null)[] = []
    let rowValid = true

    // Extract all column values for this row
    for (let colIdx = 0; colIdx < columnCount; colIdx++) {
      const columnId = columnIds[colIdx]
      if (!columnId) {
        rowValues.push(null)
        rowValid = false
        continue
      }
      const value = row[columnId]
      const encoding = encodings?.get(columnId)

      // Missing check
      if (isMissingValue(value)) {
        const summary = summaries[colIdx]
        if (summary) {
          summary.missingValues++
          summary.missingValueRowIndices.push(rowIndex)
        }
        rowValid = false
        rowValues.push(null)
        continue
      }

      // Parse numeric
      const str = String(value).trim()
      let num: number | null = null

      if (encoding && encoding.has(str)) {
        num = encoding.get(str)!
      } else {
        const parsed = Number(str)
        if (!isNaN(parsed) && isFinite(parsed)) {
          num = parsed
        } else {
          const summary = summaries[colIdx]
          if (summary) {
            summary.unparseableValues++
            summary.unparseableValueRowIndices.push(rowIndex)

            if (summary.unparseableExamples.length < 5) {
              summary.unparseableExamples.push(str)
            }
          }

          rowValid = false
        }
      }

      rowValues.push(num)
    }

    // Only include row if ALL columns have valid data
    if (rowValid) {
      for (let colIdx = 0; colIdx < columnCount; colIdx++) {
        const summary = summaries[colIdx]
        const columnData = allData[colIdx]
        if (!summary || !columnData) continue
        const value = rowValues[colIdx]
        if (value === null || value === undefined) continue
        columnData.push(value)
        summary.validValues++
      }
    } else {
      // Row dropped due to missing/invalid data in at least one column
      for (let colIdx = 0; colIdx < columnCount; colIdx++) {
        if (rowValues[colIdx] === null) {
          const summary = summaries[colIdx]
          if (summary) {
            summary.pairwiseRowDrops++
          }
        }
      }
    }

    rowIndex++
  }

  // Update summary stats
  for (const summary of summaries) {
    summary.usableRowCount = summary.validValues
    summary.dataQualityPercent =
      summary.totalRows > 0 ? (summary.usableRowCount / summary.totalRows) * 100 : 0
  }

  return { data: allData, summaries }
}

// ========== BOUNDARY DETECTION ==========

/**
 * Find last non-empty row (Avalonia Line 45-120)
 * Scans backwards to exclude trailing empty rows
 */
export function findLastNonEmptyRow(
  columnIds: string[],
  rowData: Map<number, Record<string, unknown>>
): number {
  const rowIndices = Array.from(rowData.keys()).sort((a, b) => b - a) // Descending

  for (const rowIdx of rowIndices) {
    const row = rowData.get(rowIdx)
    if (!row) continue

    // Check if ANY column has data
    for (const columnId of columnIds) {
      const value = row[columnId]
      if (!isMissingValue(value)) {
        return rowIdx + 1 // 1-based count
      }
    }
  }

  return 0 // No data found
}

/**
 * Create categorical encoding (string → number mapping)
 * Useful for converting categorical variables to numeric for certain tests
 */
export function createCategoricalEncoding(
  columnId: string,
  rowData: Map<number, Record<string, unknown>>
): Map<string, number> {
  const uniqueValuesByKey = new Map<string, string>()

  // Collect unique non-missing values
  for (const row of rowData.values()) {
    const value = row[columnId]
    if (!isMissingValue(value)) {
      const label = String(value).trim()
      uniqueValuesByKey.set(normalizeCategoryToken(label), label)
    }
  }

  // Create encoding (alphabetical order)
  const sorted = Array.from(uniqueValuesByKey.values()).sort()
  const encoding = new Map<string, number>()

  sorted.forEach((value, index) => {
    encoding.set(value, index)
  })

  return encoding
}
