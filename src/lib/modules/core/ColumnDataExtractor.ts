/**
 * Column Data Extractor
 *
 * Ported from Avalonia ColumnDataExtractor.cs
 * Provides column classification and data extraction utilities
 */

import {
  ColumnDataType,
  type ColumnClassification,
  type DataExtractionSummary,
} from './types'
import {
  TYPE_CLASSIFICATION_RULES,
  isLikertInteger,
  normalizeCategoryToken,
  parseStrictNumber,
} from '@/lib/classification/typeRules'

/**
 * Missing value indicators (case-insensitive)
 * Matches Avalonia _missingValueIndicators
 */
const MISSING_VALUE_INDICATORS = new Set([
  'na', 'n/a',
  'missing',
  'null',
  '.', '-',
  'nan',
  '#n/a', '#na'
])

/**
 * Determines whether a value should be treated as missing
 */
export function isMissingValue(value: any): boolean {
  if (value === null || value === undefined) {
    return true
  }

  const strValue = String(value).trim()

  if (strValue === '') {
    return true
  }

  return MISSING_VALUE_INDICATORS.has(strValue.toLowerCase())
}

/**
 * Classify a column to determine its data type
 * Ported from Avalonia ClassifyColumnEnhanced()
 *
 * @param columnIndex - Zero-based column index in the dataset
 * @param columnName - Name/header of the column
 * @param rows - Array of rows (each row is an array of values)
 * @returns Column classification with type and metadata
 */
export function classifyColumn(
  columnIndex: number,
  columnName: string,
  rows: any[][]
): ColumnClassification {
  const result: ColumnClassification = {
    columnIndex,
    columnName,
    dataType: ColumnDataType.Empty,
    totalValues: 0,
    numericValues: 0,
    categoricalValues: 0,
    missingValues: 0,
    uniqueValueCount: 0,
    isBinary: false,
    isOrdinal: false,
    hasMissingData: false,
    numericRatio: 0,
    allIntegerValues: false,
    uniqueValues: [],
    suggestedTests: [],
  }

  const uniqueValuesMap = new Map<string, string>()
  const numericValues: number[] = []
  let numericCount = 0
  let categoricalCount = 0
  let totalNonEmptyCount = 0
  const totalRowCount = rows.length

  // Scan all rows
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]

    // Check if row exists and has data at this column index
    if (!row || columnIndex >= row.length) {
      continue
    }

    const rawValue = row[columnIndex]

    // Check for missing values
    if (isMissingValue(rawValue)) {
      continue
    }

    const value = String(rawValue).trim()

    if (value === '') {
      continue
    }

    totalNonEmptyCount++
    uniqueValuesMap.set(normalizeCategoryToken(value), value)

    // Try to parse as numeric
    const numValue = parseStrictNumber(value)
    if (numValue !== null) {
      numericCount++
      numericValues.push(numValue)
    } else {
      categoricalCount++
    }
  }

  // Basic counts
  result.totalValues = totalNonEmptyCount
  result.missingValues = totalRowCount - totalNonEmptyCount
  result.hasMissingData = result.missingValues > 0
  result.numericValues = numericCount
  result.categoricalValues = categoricalCount
  result.uniqueValueCount = uniqueValuesMap.size
  result.uniqueValues = Array.from(uniqueValuesMap.values()).sort()
  result.numericRatio = totalNonEmptyCount > 0
    ? numericCount / totalNonEmptyCount
    : 0
  result.isConstant = result.uniqueValueCount <= 1

  // Determine data type with enhanced logic

  // Empty column
  if (totalNonEmptyCount === 0) {
    result.dataType = ColumnDataType.Empty
    result.detectedType = result.dataType
    result.effectiveType = result.dataType
    return result
  }

  // Binary (exactly 2 unique values)
  if (result.uniqueValueCount === 2) {
    result.isBinary = true
    result.dataType = ColumnDataType.Binary
    result.detectedType = result.dataType
    result.effectiveType = result.dataType
    result.suggestedTests.push('Binary Logistic Regression (as outcome)')
    result.suggestedTests.push('Chi-Square Test')
    result.suggestedTests.push("Fisher's Exact Test")
    result.suggestedTests.push('McNemar Test (paired data)')
    return result
  }

  // All numeric
  if (numericCount > 0) {
    result.minNumericValue = Math.min(...numericValues)
    result.maxNumericValue = Math.max(...numericValues)
    result.allIntegerValues = numericValues.every(v => v === Math.floor(v))
  }

  const isOrdinal =
    result.numericRatio === 1 &&
    result.uniqueValueCount >= TYPE_CLASSIFICATION_RULES.ordinalMinLevels &&
    result.uniqueValueCount <= TYPE_CLASSIFICATION_RULES.ordinalMaxLevels &&
    numericValues.every(isLikertInteger)

  if (isOrdinal) {
    result.isOrdinal = true
    result.dataType = ColumnDataType.Ordinal
    result.detectedType = result.dataType
    result.effectiveType = result.dataType
    result.suggestedTests.push('Descriptive Statistics')
    result.suggestedTests.push('Spearman Correlation (ordinal)')
    result.suggestedTests.push("Kendall's Tau (ordinal)")
    result.suggestedTests.push('Mann-Whitney U Test')
    result.suggestedTests.push('Kruskal-Wallis Test')
    result.suggestedTests.push('Wilcoxon Signed-Rank Test')
    result.suggestedTests.push('Friedman Test')
    result.suggestedTests.push('Scheirer-Ray-Hare Test')
    result.suggestedTests.push('Linear Regression (as numeric)')
    result.suggestedTests.push('Normality Tests')
    return result
  }

  if (result.numericRatio >= TYPE_CLASSIFICATION_RULES.numericRatioForNumeric) {
    result.dataType = ColumnDataType.Numeric
    result.detectedType = result.dataType
    result.effectiveType = result.dataType
    result.suggestedTests.push('Descriptive Statistics')
    result.suggestedTests.push('t-Test')
    result.suggestedTests.push('ANOVA')
    result.suggestedTests.push('Correlation Analysis')
    result.suggestedTests.push('Linear Regression')
    return result
  }

  if (result.numericRatio <= TYPE_CLASSIFICATION_RULES.numericRatioForCategorical) {
    result.dataType = ColumnDataType.Categorical
    result.detectedType = result.dataType
    result.effectiveType = result.dataType
    result.suggestedTests.push('Chi-Square Test')
    result.suggestedTests.push("Fisher's Exact Test (if 2×2)")

    if (result.uniqueValueCount >= 3) {
      result.suggestedTests.push('Multinomial Logistic Regression (as outcome)')
    }

    // Categorical variables can be used as factors/predictors (requires baseline encoding)
    result.suggestedTests.push('Two-Way ANOVA (as factor)')
    result.suggestedTests.push('Scheirer-Ray-Hare (as factor)')

    if (result.uniqueValueCount === 2) {
      // Binary categorical can be predictor in regression
      result.suggestedTests.push('Binary Logistic Regression (as predictor)')
      result.suggestedTests.push('Multiple Linear Regression (as predictor)')
    } else if (result.uniqueValueCount >= 3) {
      // Multi-level categorical requires dummy encoding as predictor
      result.suggestedTests.push('Multiple Linear Regression (as predictor, requires baseline)')
    }

    return result
  }

  // Mixed (some numeric, some categorical)
  result.dataType = ColumnDataType.Mixed
  result.detectedType = result.dataType
  result.effectiveType = result.dataType
  result.suggestedTests.push('Review data quality')
  return result
}

/**
 * Column Data Extractor class
 * Provides static methods for column classification and data extraction
 */
export class ColumnDataExtractor {
  /**
   * Classify a column to determine its data type
   * @param columnIndex - Zero-based column index
   * @param columnName - Column name/header
   * @param rows - Array of rows (each row is an array of values)
   * @returns Column classification
   */
  static classifyColumn(
    columnIndex: number,
    columnName: string,
    rows: any[][]
  ): ColumnClassification {
    return classifyColumn(columnIndex, columnName, rows)
  }

  /**
   * Extract numeric data from a single column with tracking
   * Ported from Avalonia ColumnDataExtractor.ExtractNumericDataWithTracking()
   *
   * @param columnIndex - Zero-based column index in the dataset
   * @param rows - Array of rows (each row is an array of values)
   * @param encoding - Optional encoding map for categorical values
   * @returns Extracted numeric data and summary statistics
   */
  static extractNumericDataWithTracking(
    columnIndex: number,
    rows: any[][],
    encoding?: Map<string, number>
  ): { data: number[]; summary: DataExtractionSummary } {
    const data: number[] = []
    const summary: DataExtractionSummary = {
      validValues: 0,
      missingValues: 0,
      totalRows: rows.length,
      missingIndices: [],
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]

      // Check if row exists and has data at this column index
      if (!row || columnIndex >= row.length) {
        summary.missingValues++
        summary.missingIndices.push(rowIndex)
        continue
      }

      const rawValue = row[columnIndex]

      // Check for missing values
      if (isMissingValue(rawValue)) {
        summary.missingValues++
        summary.missingIndices.push(rowIndex)
        continue
      }

      const value = String(rawValue).trim()

      if (value === '') {
        summary.missingValues++
        summary.missingIndices.push(rowIndex)
        continue
      }

      // If encoding exists, use it for categorical data
      if (encoding && encoding.has(value)) {
        const encodedValue = encoding.get(value)!
        data.push(encodedValue)
        summary.validValues++
        continue
      }

      // Otherwise try to parse as numeric
      const numValue = parseStrictNumber(value)
      if (numValue !== null) {
        data.push(numValue)
        summary.validValues++
      } else {
        // Unparseable value - treat as missing
        summary.missingValues++
        summary.missingIndices.push(rowIndex)
      }
    }

    return { data, summary }
  }

  /**
   * Extract categorical data with encoding
   * Creates numeric encoding for categorical values (baseline encoding)
   *
   * @param columnIndex - Zero-based column index in the dataset
   * @param rows - Array of rows (each row is an array of values)
   * @param baselineValue - Optional baseline value to encode as 0 (others get 1, 2, 3...)
   * @returns Encoded data, encoding map, and summary statistics
   */
  static extractCategoricalDataWithEncoding(
    columnIndex: number,
    rows: any[][],
    baselineValue?: string
  ): { data: number[]; encoding: Map<string, number>; summary: DataExtractionSummary } {
    // First pass: collect unique values
    const uniqueValues = new Set<string>()

    for (const row of rows) {
      if (!row || columnIndex >= row.length) {
        continue
      }

      const rawValue = row[columnIndex]
      if (isMissingValue(rawValue)) {
        continue
      }

      const value = String(rawValue).trim()
      if (value !== '') {
        uniqueValues.add(value)
      }
    }

    // Create encoding map (baseline = 0, others = 1, 2, 3...)
    const encoding = new Map<string, number>()
    const sortedValues = Array.from(uniqueValues).sort()

    // If baseline specified, encode it as 0 first
    if (baselineValue && uniqueValues.has(baselineValue)) {
      encoding.set(baselineValue, 0)
      let code = 1
      for (const value of sortedValues) {
        if (value !== baselineValue) {
          encoding.set(value, code++)
        }
      }
    } else {
      // No baseline - encode in alphabetical order
      sortedValues.forEach((value, index) => {
        encoding.set(value, index)
      })
    }

    // Second pass: extract data using encoding
    const result = this.extractNumericDataWithTracking(columnIndex, rows, encoding)

    return {
      data: result.data,
      encoding,
      summary: {
        ...result.summary,
        encoding,
        reversedEncoding: new Map(Array.from(encoding.entries()).map(([k, v]) => [v, k])),
      },
    }
  }

  /**
   * Extract aligned data from multiple columns (pairwise deletion)
   * Ported from Avalonia ColumnDataExtractor.ExtractAlignedNumericData()
   *
   * Ensures all returned vectors have identical length by skipping rows where
   * ANY column has missing/invalid data.
   *
   * @param columnIndices - Array of zero-based column indices
   * @param rows - Array of rows (each row is an array of values)
   * @param encodingMappings - Optional map of column name -> encoding map
   * @returns Aligned data arrays and summaries (one per column)
   */
  static extractAlignedData(
    columnIndices: number[],
    rows: any[][],
    encodingMappings?: Map<string, Map<string, number>>
  ): { data: number[][]; summaries: DataExtractionSummary[] } {
    if (columnIndices.length === 0) {
      return { data: [], summaries: [] }
    }

    // Initialize result arrays - one per column
    const result: number[][] = []
    const summaries: DataExtractionSummary[] = []

    for (let i = 0; i < columnIndices.length; i++) {
      result.push([])
      summaries.push({
        validValues: 0,
        missingValues: 0,
        totalRows: rows.length,
        missingIndices: [],
      })
    }

    // Iterate rows once, collect all columns simultaneously
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]
      const rowValues: number[] = []
      let rowIsValid = true

      // Check all columns for this row
      for (let colIdx = 0; colIdx < columnIndices.length; colIdx++) {
        const columnIndex = columnIndices[colIdx]!

        // Check if row exists and has data at this column index
        if (!row || columnIndex >= row.length) {
          summaries[colIdx]!.missingValues++
          summaries[colIdx]!.missingIndices.push(rowIndex)
          rowIsValid = false
          break
        }

        const rawValue = row[columnIndex]

        // Check for missing values
        if (isMissingValue(rawValue)) {
          summaries[colIdx]!.missingValues++
          summaries[colIdx]!.missingIndices.push(rowIndex)
          rowIsValid = false
          break
        }

        const value = String(rawValue).trim()

        if (value === '') {
          summaries[colIdx]!.missingValues++
          summaries[colIdx]!.missingIndices.push(rowIndex)
          rowIsValid = false
          break
        }

        // Check if encoding exists for this column
        const encoding = encodingMappings?.get(columnIndex.toString())

        let numericValue: number

        if (encoding && encoding.has(value)) {
          numericValue = encoding.get(value)!
        } else {
          const parsed = parseStrictNumber(value)
          if (parsed === null) {
            // Unparseable value
            summaries[colIdx]!.missingValues++
            summaries[colIdx]!.missingIndices.push(rowIndex)
            rowIsValid = false
            break
          }
          numericValue = parsed
        }

        rowValues.push(numericValue)
      }

      // If row is valid for ALL columns, add it to results
      if (rowIsValid) {
        for (let colIdx = 0; colIdx < columnIndices.length; colIdx++) {
          result[colIdx]!.push(rowValues[colIdx]!)
          summaries[colIdx]!.validValues++
        }
      }
    }

    return { data: result, summaries }
  }

  /**
   * Build groups from long-format data (value column + group column)
   * Used for ANOVA and Kruskal-Wallis tests when data is in long format
   *
   * Long format example:
   *   Score | Treatment
   *   ------+----------
   *     5.2 | Control
   *     6.1 | Drug A
   *     7.3 | Drug B
   *     4.9 | Control
   *
   * Transforms into wide format: [[5.2, 4.9, ...], [6.1, ...], [7.3, ...]]
   *
   * @param numericColumnIndex - Index of numeric values column
   * @param categoricalColumnIndex - Index of categorical group column
   * @param rows - Array of rows (each row is an array of values)
   * @returns Grouped data, group names, and summary statistics
   */
  static buildGroupsFromLongFormat(
    numericColumnIndex: number,
    categoricalColumnIndex: number,
    rows: any[][]
  ): {
    groups: number[][]
    groupNames: string[]
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
      groupCounts: Map<string, number>
    }
  } {
    const groupedValuesByKey = new Map<string, number[]>()
    const groupDisplayByKey = new Map<string, string>()
    const groupCounts = new Map<string, number>()
    let validRows = 0
    let skippedRows = 0

    // Iterate through rows and group by category
    for (const row of rows) {
      // Validate row exists
      if (!row) {
        skippedRows++
        continue
      }

      // Validate indices
      if (
        numericColumnIndex >= row.length ||
        categoricalColumnIndex >= row.length
      ) {
        skippedRows++
        continue
      }

      const categoryRaw = row[categoricalColumnIndex]
      const numericRaw = row[numericColumnIndex]

      // Skip rows with missing values (pairwise deletion)
      if (isMissingValue(categoryRaw) || isMissingValue(numericRaw)) {
        skippedRows++
        continue
      }

      const categoryStr = String(categoryRaw).trim()
      const numericStr = String(numericRaw).trim()

      // Skip empty values
      if (categoryStr === '' || numericStr === '') {
        skippedRows++
        continue
      }

      // Parse numeric value
      const numericValue = parseStrictNumber(numericStr)
      if (numericValue === null) {
        skippedRows++
        continue
      }

      const categoryKey = normalizeCategoryToken(categoryStr)
      const displayLabel = groupDisplayByKey.get(categoryKey) ?? categoryStr
      if (!groupDisplayByKey.has(categoryKey)) {
        groupDisplayByKey.set(categoryKey, categoryStr)
      }

      if (!groupedValuesByKey.has(categoryKey)) {
        groupedValuesByKey.set(categoryKey, [])
        groupCounts.set(displayLabel, 0)
      }

      groupedValuesByKey.get(categoryKey)!.push(numericValue)
      groupCounts.set(displayLabel, (groupCounts.get(displayLabel) ?? 0) + 1)
      validRows++
    }

    const sortedKeys = Array.from(groupedValuesByKey.keys()).sort((a, b) => {
      const labelA = groupDisplayByKey.get(a) ?? a
      const labelB = groupDisplayByKey.get(b) ?? b
      if (labelA < labelB) return -1
      if (labelA > labelB) return 1
      return 0
    })
    const groupNames = sortedKeys.map((key) => groupDisplayByKey.get(key) ?? key)
    const groups = sortedKeys.map((key) => groupedValuesByKey.get(key)!)

    return {
      groups,
      groupNames,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
        groupCounts,
      },
    }
  }

  /**
   * Build paired groups from long-format data using an explicit pair/subject ID.
   * Ensures pairing by ID and applies pairwise deletion across the two groups.
   *
   * @param numericColumnIndex - Index of numeric values column
   * @param categoricalColumnIndex - Index of categorical group column (must have exactly 2 levels)
   * @param pairIdColumnIndex - Index of pair/subject ID column
   * @param rows - Array of rows (each row is an array of values)
   * @returns Grouped paired data, group names (in first-seen order), and summary statistics
   */
  static buildPairedGroupsFromLongFormat(
    numericColumnIndex: number,
    categoricalColumnIndex: number,
    pairIdColumnIndex: number,
    rows: any[][]
  ): {
    groups: number[][]
    groupNames: string[]
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
      groupCounts: Map<string, number>
      pairedRows: number
      unpairedRows: number
      duplicatePairs: number
    }
  } {
    const groupKeys: string[] = []
    const groupIndex = new Map<string, number>()
    const groupDisplayByKey = new Map<string, string>()
    const groupCounts = new Map<string, number>()
    const pairMap = new Map<string, { values: Map<string, number>; duplicate: boolean }>()
    let validRows = 0
    let skippedRows = 0

    for (const row of rows) {
      if (!row) {
        skippedRows++
        continue
      }

      if (
        numericColumnIndex >= row.length ||
        categoricalColumnIndex >= row.length ||
        pairIdColumnIndex >= row.length
      ) {
        skippedRows++
        continue
      }

      const categoryRaw = row[categoricalColumnIndex]
      const numericRaw = row[numericColumnIndex]
      const pairRaw = row[pairIdColumnIndex]

      if (isMissingValue(categoryRaw) || isMissingValue(numericRaw) || isMissingValue(pairRaw)) {
        skippedRows++
        continue
      }

      const categoryStr = String(categoryRaw).trim()
      const numericStr = String(numericRaw).trim()
      const pairIdStr = String(pairRaw).trim()

      if (categoryStr === '' || numericStr === '' || pairIdStr === '') {
        skippedRows++
        continue
      }

      const numericValue = parseStrictNumber(numericStr)
      if (numericValue === null) {
        skippedRows++
        continue
      }

      const categoryKey = normalizeCategoryToken(categoryStr)
      const displayLabel = groupDisplayByKey.get(categoryKey) ?? categoryStr
      if (!groupDisplayByKey.has(categoryKey)) {
        groupDisplayByKey.set(categoryKey, categoryStr)
      }

      if (!groupIndex.has(categoryKey)) {
        groupIndex.set(categoryKey, groupKeys.length)
        groupKeys.push(categoryKey)
      }

      if (!groupCounts.has(displayLabel)) {
        groupCounts.set(displayLabel, 0)
      }
      groupCounts.set(displayLabel, (groupCounts.get(displayLabel) ?? 0) + 1)

      const pairEntry = pairMap.get(pairIdStr) ?? {
        values: new Map<string, number>(),
        duplicate: false,
      }

      if (pairEntry.values.has(categoryKey)) {
        pairEntry.duplicate = true
      } else {
        pairEntry.values.set(categoryKey, numericValue)
      }

      pairMap.set(pairIdStr, pairEntry)
      validRows++
    }

    const groups: number[][] = groupKeys.map(() => [])
    let pairedRows = 0
    let unpairedRows = 0
    let duplicatePairs = 0

    for (const pairEntry of pairMap.values()) {
      if (pairEntry.duplicate) {
        duplicatePairs++
        continue
      }

      let hasAll = true
      for (const groupKey of groupKeys) {
        if (!pairEntry.values.has(groupKey)) {
          hasAll = false
          break
        }
      }

      if (!hasAll) {
        unpairedRows++
        continue
      }

      groupKeys.forEach((groupKey, index) => {
        groups[index]!.push(pairEntry.values.get(groupKey)!)
      })
      pairedRows++
    }

    const groupNames = groupKeys.map((key) => groupDisplayByKey.get(key) ?? key)

    return {
      groups,
      groupNames,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
        groupCounts,
        pairedRows,
        unpairedRows,
        duplicatePairs,
      },
    }
  }

  /**
   * Build groups from long-format data while preserving first-seen group order.
   *
   * @param numericColumnIndex - Index of numeric values column
   * @param categoricalColumnIndex - Index of categorical group column
   * @param rows - Array of rows (each row is an array of values)
   * @returns Grouped data, group names (in first-seen order), and summary statistics
   */
  static buildGroupsFromLongFormatPreserveOrder(
    numericColumnIndex: number,
    categoricalColumnIndex: number,
    rows: any[][]
  ): {
    groups: number[][]
    groupNames: string[]
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
      groupCounts: Map<string, number>
    }
  } {
    const groupedValuesByKey = new Map<string, number[]>()
    const groupDisplayByKey = new Map<string, string>()
    const groupCounts = new Map<string, number>()
    let validRows = 0
    let skippedRows = 0

    for (const row of rows) {
      if (!row) {
        skippedRows++
        continue
      }

      if (
        numericColumnIndex >= row.length ||
        categoricalColumnIndex >= row.length
      ) {
        skippedRows++
        continue
      }

      const categoryRaw = row[categoricalColumnIndex]
      const numericRaw = row[numericColumnIndex]

      if (isMissingValue(categoryRaw) || isMissingValue(numericRaw)) {
        skippedRows++
        continue
      }

      const categoryStr = String(categoryRaw).trim()
      const numericStr = String(numericRaw).trim()

      if (categoryStr === '' || numericStr === '') {
        skippedRows++
        continue
      }

      const numericValue = parseStrictNumber(numericStr)
      if (numericValue === null) {
        skippedRows++
        continue
      }

      const categoryKey = normalizeCategoryToken(categoryStr)
      const displayLabel = groupDisplayByKey.get(categoryKey) ?? categoryStr
      if (!groupDisplayByKey.has(categoryKey)) {
        groupDisplayByKey.set(categoryKey, categoryStr)
      }

      if (!groupedValuesByKey.has(categoryKey)) {
        groupedValuesByKey.set(categoryKey, [])
        groupCounts.set(displayLabel, 0)
      }

      groupedValuesByKey.get(categoryKey)!.push(numericValue)
      groupCounts.set(displayLabel, (groupCounts.get(displayLabel) ?? 0) + 1)
      validRows++
    }

    const groupKeys = Array.from(groupedValuesByKey.keys())
    const groupNames = groupKeys.map((key) => groupDisplayByKey.get(key) ?? key)
    const groups = groupKeys.map((key) => groupedValuesByKey.get(key)!)

    return {
      groups,
      groupNames,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
        groupCounts,
      },
    }
  }

  /**
   * Build paired groups from long-format data by row order (no subject ID).
   * Preserves the first-seen group order and skips rows with missing values.
   *
   * @param numericColumnIndex - Index of numeric values column
   * @param categoricalColumnIndex - Index of categorical group column (must have exactly 2 levels)
   * @param rows - Array of rows (each row is an array of values)
   * @returns Grouped data, group names (in first-seen order), and summary statistics
   */
  static buildPairedGroupsFromLongFormatByOrder(
    numericColumnIndex: number,
    categoricalColumnIndex: number,
    rows: any[][]
  ): {
    groups: number[][]
    groupNames: string[]
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
      groupCounts: Map<string, number>
    }
  } {
    const groupKeys: string[] = []
    const groupIndex = new Map<string, number>()
    const groupDisplayByKey = new Map<string, string>()
    const groupCounts = new Map<string, number>()
    const groups: number[][] = []
    let validRows = 0
    let skippedRows = 0

    for (const row of rows) {
      if (!row) {
        skippedRows++
        continue
      }

      if (numericColumnIndex >= row.length || categoricalColumnIndex >= row.length) {
        skippedRows++
        continue
      }

      const categoryRaw = row[categoricalColumnIndex]
      const numericRaw = row[numericColumnIndex]

      if (isMissingValue(categoryRaw) || isMissingValue(numericRaw)) {
        skippedRows++
        continue
      }

      const categoryStr = String(categoryRaw).trim()
      const numericStr = String(numericRaw).trim()

      if (categoryStr === '' || numericStr === '') {
        skippedRows++
        continue
      }

      const numericValue = parseStrictNumber(numericStr)
      if (numericValue === null) {
        skippedRows++
        continue
      }

      const categoryKey = normalizeCategoryToken(categoryStr)
      const displayLabel = groupDisplayByKey.get(categoryKey) ?? categoryStr
      if (!groupDisplayByKey.has(categoryKey)) {
        groupDisplayByKey.set(categoryKey, categoryStr)
      }

      let idx = groupIndex.get(categoryKey)
      if (idx === undefined) {
        idx = groupKeys.length
        groupIndex.set(categoryKey, idx)
        groupKeys.push(categoryKey)
        groups.push([])
        groupCounts.set(displayLabel, 0)
      }

      groups[idx]!.push(numericValue)
      groupCounts.set(displayLabel, (groupCounts.get(displayLabel) ?? 0) + 1)
      validRows++
    }

    const groupNames = groupKeys.map((key) => groupDisplayByKey.get(key) ?? key)

    return {
      groups,
      groupNames,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
        groupCounts,
      },
    }
  }

  /**
   * Extract dependent variable and factor variables for factorial ANOVA / Scheirer tests
   * Used for Two-Way ANOVA, Multifactorial ANOVA, Scheirer-Ray-Hare
   *
   * Extracts 1 numeric dependent variable + N categorical factor variables.
   * Keeps factors as string arrays (no numeric encoding) - Python handles dummy coding.
   * Applies pairwise deletion across all columns.
   *
   * @param dependentColumnIndex - Index of numeric dependent variable
   * @param factorColumnIndices - Indices of categorical factor columns
   * @param rows - Array of rows (each row is an array of values)
   * @param factorColumnNames - Optional actual column names for factors (for metadata keys)
   * @returns Aligned dependent array, factor arrays, and metadata
   */
  static extractDependentAndFactors(
    dependentColumnIndex: number,
    factorColumnIndices: number[],
    rows: any[][],
    factorColumnNames?: string[]
  ): {
    dependent: number[]
    factors: Record<string, string[]>
    factorNames: string[]
    factorLevels: Record<string, string[]>
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
    }
  } {
    const dependent: number[] = []
    const factors: Record<string, string[]> = {}
    const factorLevels: Record<string, Set<string>> = {}
    const factorDisplayByNormalized: Record<string, Map<string, string>> = {}
    const factorNames: string[] = []

    let validRows = 0
    let skippedRows = 0

    // Initialize factor arrays and level tracking
    // Use actual column names if provided, otherwise fall back to generic factor1, factor2, etc.
    for (let i = 0; i < factorColumnIndices.length; i++) {
      const factorName =
        factorColumnNames && i < factorColumnNames.length
          ? factorColumnNames[i]!
          : `factor${i + 1}`
      factorNames.push(factorName)
      factors[factorName] = []
      factorLevels[factorName] = new Set<string>()
      factorDisplayByNormalized[factorName] = new Map<string, string>()
    }

    // Iterate through rows with pairwise deletion
    for (const row of rows) {
      if (!row) {
        skippedRows++
        continue
      }

      // Check dependent column
      if (dependentColumnIndex >= row.length) {
        skippedRows++
        continue
      }

      const dependentRaw = row[dependentColumnIndex]
      if (isMissingValue(dependentRaw)) {
        skippedRows++
        continue
      }

      const dependentStr = String(dependentRaw).trim()
      if (dependentStr === '') {
        skippedRows++
        continue
      }

      const dependentValue = parseStrictNumber(dependentStr)
      if (dependentValue === null) {
        skippedRows++
        continue
      }

      // Check all factor columns
      const factorValues: string[] = []
      let rowIsValid = true

      for (let i = 0; i < factorColumnIndices.length; i++) {
        const factorIndex = factorColumnIndices[i]!
        const factorName = factorNames[i]!
        if (factorIndex >= row.length) {
          rowIsValid = false
          break
        }

        const factorRaw = row[factorIndex]
        if (isMissingValue(factorRaw)) {
          rowIsValid = false
          break
        }

        const factorStr = String(factorRaw).trim()
        if (factorStr === '') {
          rowIsValid = false
          break
        }

        const normalizedFactorValue = normalizeCategoryToken(factorStr)
        const displayMap = factorDisplayByNormalized[factorName]!
        if (!displayMap.has(normalizedFactorValue)) {
          displayMap.set(normalizedFactorValue, factorStr)
        }
        factorValues.push(displayMap.get(normalizedFactorValue)!)
      }

      if (!rowIsValid) {
        skippedRows++
        continue
      }

      // Row is valid - add to results
      dependent.push(dependentValue)

      for (let i = 0; i < factorNames.length; i++) {
        const factorName = factorNames[i]!
        const factorValue = factorValues[i]!
        factors[factorName]!.push(factorValue)
        factorLevels[factorName]!.add(factorValue)
      }

      validRows++
    }

    // Convert factor levels Sets to sorted arrays
    const factorLevelsOutput: Record<string, string[]> = {}
    for (const factorName of factorNames) {
      factorLevelsOutput[factorName] = Array.from(factorLevels[factorName]!).sort()
    }

    return {
      dependent,
      factors,
      factorNames,
      factorLevels: factorLevelsOutput,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
      },
    }
  }

  /**
   * Validate factorial design cell counts
   *
   * Ensures every factor combination (cell) has at least some observations.
   * Prevents silent failures where statsmodels drops empty cells or crashes.
   *
   * @param factors - Factor arrays (aligned, same length)
   * @param factorNames - Factor names (keys for factors object)
   * @param minCellSize - Minimum observations per cell (default: 1)
   * @returns Validation result with cell count details
   */
  static validateFactorialDesignCellCounts(
    factors: Record<string, string[]>,
    factorNames: string[],
    minCellSize: number = 1
  ): {
    isValid: boolean
    cellCounts: Record<string, number>
    emptyCells: string[]
    underpoweredCells: string[]
    totalCells: number
    message?: string
  } {
    // Build cell counts map
    const cellCounts: Record<string, number> = {}
    const n = factors[factorNames[0]!]?.length ?? 0

    // Count observations in each cell
    for (let i = 0; i < n; i++) {
      // Build cell key from all factor values at this row
      const cellKey = factorNames.map(fname => factors[fname]![i]).join(' × ')
      cellCounts[cellKey] = (cellCounts[cellKey] ?? 0) + 1
    }

    // Build expected cells (Cartesian product of all factor levels)
    const factorLevels: string[][] = factorNames.map(fname => {
      const levels = new Set<string>()
      for (const value of factors[fname]!) {
        levels.add(value)
      }
      return Array.from(levels).sort()
    })

    // Generate all possible cell combinations
    const expectedCells: string[] = []
    const generateCombinations = (partial: string[], depth: number) => {
      if (depth === factorNames.length) {
        expectedCells.push(partial.join(' × '))
        return
      }
      for (const level of factorLevels[depth]!) {
        generateCombinations([...partial, level], depth + 1)
      }
    }
    generateCombinations([], 0)

    // Find empty and underpowered cells
    const emptyCells: string[] = []
    const underpoweredCells: string[] = []

    for (const cellKey of expectedCells) {
      const count = cellCounts[cellKey] ?? 0
      if (count === 0) {
        emptyCells.push(cellKey)
      } else if (count < minCellSize) {
        underpoweredCells.push(cellKey)
      }
    }

    // Determine validation result
    const isValid = emptyCells.length === 0

    let message: string | undefined
    if (!isValid) {
      message = `Design has ${emptyCells.length} empty cell(s) out of ${expectedCells.length} total: ${emptyCells.slice(0, 3).join(', ')}${emptyCells.length > 3 ? '...' : ''}`
    } else if (underpoweredCells.length > 0) {
      message = `Warning: ${underpoweredCells.length} cell(s) have fewer than ${minCellSize} observation(s): ${underpoweredCells.slice(0, 3).join(', ')}${underpoweredCells.length > 3 ? '...' : ''}`
    }

    return {
      isValid,
      cellCounts,
      emptyCells,
      underpoweredCells,
      totalCells: expectedCells.length,
      message,
    }
  }

  /**
   * Extract regression predictors (dependent + predictors) with dummy variable encoding
   *
   * Used for linear and logistic regression.
   * Trusts ColumnClassification instead of re-scanning data.
   * Generates dummy variables (k-1 columns) for categorical predictors.
   * Encodes categorical dependent variables for logistic regression.
   *
   * @param dependentColumnIndex - Index of dependent variable
   * @param predictorColumnIndices - Indices of predictor columns
   * @param rows - Array of rows
   * @param dependentColumn - ColumnClassification for dependent variable
   * @param predictorColumns - ColumnClassification array for predictors
   * @param factorEncodings - Optional user-selected encodings for categorical predictors (overrides alphabetical)
   * @param outcomeEncoding - Optional user-selected encoding for categorical DV (overrides alphabetical)
   * @returns Aligned dependent, predictors (with dummy variables), metadata
   */
  static extractRegressionPredictors(
    dependentColumnIndex: number,
    predictorColumnIndices: number[],
    rows: any[][],
    dependentColumn: ColumnClassification,
    predictorColumns: ColumnClassification[],
    // Optional encoding overrides (user-selected baselines from dialog)
    factorEncodings?: Record<string, Record<string, number>>,
    outcomeEncoding?: Record<string, number>
  ): {
    dependent: number[]
    predictors: Record<string, number[]>
    predictorNames: string[]
    dependentMapping?: Record<string, number>
    dependentReverse?: Record<number, string>
    categoricalMappings: Record<string, Record<string, number>>
    reverseMappings: Record<string, Record<number, string>>
    dummyVariableInfo: Record<string, { baselineLevel: string; dummyLevels: string[] }>
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
    }
  } {
    const dependent: number[] = []
    const predictors: Record<string, number[]> = {}
    const categoricalMappings: Record<string, Record<string, number>> = {}
    const reverseMappings: Record<string, Record<number, string>> = {}
    const dummyVariableInfo: Record<string, { baselineLevel: string; dummyLevels: string[] }> = {}
    const predictorNames: string[] = []

    let validRows = 0
    let skippedRows = 0
    let dependentMapping: Record<string, number> | undefined
    let dependentReverse: Record<number, string> | undefined

    // Collect unknown category levels for diagnostics (warn once per column).
    const unknownDvLevels = new Set<string>()
    const unknownPredictorLevels = new Map<string, Set<string>>() // columnName -> levels

    // Build encoding for categorical dependent variable (for logistic regression)
    const isDependentCategorical =
      dependentColumn.dataType === ColumnDataType.Categorical ||
      dependentColumn.dataType === ColumnDataType.Binary

    if (isDependentCategorical) {
      if (outcomeEncoding) {
        // Use user-provided encoding (from dialog)
        // Normalize keys for case-insensitive lookup, preserve original labels in reverse
        dependentMapping = {}
        dependentReverse = {}
        for (const [level, code] of Object.entries(outcomeEncoding)) {
          const normalizedKey = level.trim().toLowerCase()
          dependentMapping[normalizedKey] = code
          dependentReverse[code] = level // Preserve original label for display
        }
      } else {
        // Fallback: scan unique values and use alphabetical order
        // Case normalization: use trim().toLowerCase() for keys, preserve first-seen display label
        const normalizedToDisplay = new Map<string, string>() // normalizedKey -> first-seen displayLabel
        for (const row of rows) {
          if (!row || dependentColumnIndex >= row.length) continue
          const val = row[dependentColumnIndex]
          if (isMissingValue(val)) continue
          const displayLabel = String(val).trim()
          if (displayLabel === '') continue
          const normalizedKey = displayLabel.toLowerCase()
          if (!normalizedToDisplay.has(normalizedKey)) {
            normalizedToDisplay.set(normalizedKey, displayLabel) // First occurrence wins
          }
        }

        // Sort by normalized key for deterministic ordering
        const sortedNormalizedKeys = Array.from(normalizedToDisplay.keys()).sort()
        dependentMapping = {}
        dependentReverse = {}
        sortedNormalizedKeys.forEach((normalizedKey, idx) => {
          dependentMapping![normalizedKey] = idx
          dependentReverse![idx] = normalizedToDisplay.get(normalizedKey)!
        })
      }
    }

    // Build encoding maps for categorical predictors
    // Dummy encoding: k-1 dummy variables, baseline level (code=0) is reference
    for (let i = 0; i < predictorColumns.length; i++) {
      const col = predictorColumns[i]!
      const name = col.columnName

      if (
        col.dataType === ColumnDataType.Categorical ||
        col.dataType === ColumnDataType.Binary
      ) {
        let encoding: Record<string, number>
        let reverse: Record<number, string>
        let baselineLevel: string
        let dummyLevels: string[]

        const userEncoding = factorEncodings?.[name]
        if (userEncoding) {
          // Use user-provided encoding (from dialog)
          // Normalize keys for case-insensitive lookup, preserve original labels in reverse
          encoding = {}
          reverse = {}
          for (const [level, code] of Object.entries(userEncoding)) {
            const normalizedKey = level.trim().toLowerCase()
            encoding[normalizedKey] = code
            reverse[code] = level // Preserve original label for display
          }

          // Find baseline (level with code 0) - use original label from userEncoding
          const baselineEntry = Object.entries(userEncoding).find(([_, code]) => code === 0)
          baselineLevel = baselineEntry ? baselineEntry[0] : Object.values(reverse)[0]!

          // Dummy levels are all non-baseline levels (code > 0) - use original labels
          dummyLevels = Object.entries(userEncoding)
            .filter(([_, code]) => code !== 0)
            .sort(([, a], [, b]) => a - b) // Sort by code
            .map(([level]) => level)
        } else {
          // Fallback: scan unique values and use alphabetical order
          // Case normalization: use trim().toLowerCase() for keys, preserve first-seen display label
          const normalizedToDisplay = new Map<string, string>() // normalizedKey -> first-seen displayLabel
          const colIndex = predictorColumnIndices[i]!
          for (const row of rows) {
            if (!row || colIndex >= row.length) continue
            const val = row[colIndex]
            if (isMissingValue(val)) continue
            const displayLabel = String(val).trim()
            if (displayLabel === '') continue
            const normalizedKey = displayLabel.toLowerCase()
            if (!normalizedToDisplay.has(normalizedKey)) {
              normalizedToDisplay.set(normalizedKey, displayLabel) // First occurrence wins
            }
          }

          // Sort by normalized key for deterministic ordering
          const sortedNormalizedKeys = Array.from(normalizedToDisplay.keys()).sort()
          if (sortedNormalizedKeys.length < 2) {
            // Not enough levels for categorical predictor
            continue
          }

          // Baseline is first level (index 0), use display label
          baselineLevel = normalizedToDisplay.get(sortedNormalizedKeys[0]!)!
          // Dummy levels are non-baseline, use display labels
          dummyLevels = sortedNormalizedKeys.slice(1).map(k => normalizedToDisplay.get(k)!)

          // Store encoding: baseline=0, others get their own index (normalized keys)
          encoding = {}
          reverse = {}
          sortedNormalizedKeys.forEach((normalizedKey, idx) => {
            encoding[normalizedKey] = idx
            reverse[idx] = normalizedToDisplay.get(normalizedKey)!
          })
        }

        categoricalMappings[name] = encoding
        reverseMappings[name] = reverse
        dummyVariableInfo[name] = { baselineLevel, dummyLevels }

        // Initialize dummy variable arrays
        for (const dummyLevel of dummyLevels) {
          const dummyName = `${name}_${dummyLevel}`
          predictorNames.push(dummyName)
          predictors[dummyName] = []
        }
      } else {
        // Numeric predictor - single column
        predictorNames.push(name)
        predictors[name] = []
      }
    }

    // Extract aligned data with pairwise deletion
    for (const row of rows) {
      if (!row) {
        skippedRows++
        continue
      }

      // Extract dependent value
      if (dependentColumnIndex >= row.length) {
        skippedRows++
        continue
      }

      const dependentRaw = row[dependentColumnIndex]
      if (isMissingValue(dependentRaw)) {
        skippedRows++
        continue
      }

      const dependentStr = String(dependentRaw).trim()
      if (dependentStr === '') {
        skippedRows++
        continue
      }

      let dependentValue: number
      if (isDependentCategorical) {
        // Encode categorical DV (case-insensitive lookup)
        const normalizedKey = dependentStr.toLowerCase()
        const code = dependentMapping![normalizedKey]
        if (code === undefined) {
          unknownDvLevels.add(dependentStr)
          skippedRows++
          continue
        }
        dependentValue = code
      } else {
        // Numeric DV
        const parsed = parseStrictNumber(dependentStr)
        if (parsed === null) {
          skippedRows++
          continue
        }
        dependentValue = parsed
      }

      // Extract predictor values (with dummy encoding for categoricals)
      const predictorValues: Record<string, number> = {}
      let rowIsValid = true

      for (let i = 0; i < predictorColumns.length; i++) {
        const col = predictorColumns[i]!
        const colIndex = predictorColumnIndices[i]!

        if (colIndex >= row.length) {
          rowIsValid = false
          break
        }

        const raw = row[colIndex]
        if (isMissingValue(raw)) {
          rowIsValid = false
          break
        }

        const str = String(raw).trim()
        if (str === '') {
          rowIsValid = false
          break
        }

        if (
          col.dataType === ColumnDataType.Categorical ||
          col.dataType === ColumnDataType.Binary
        ) {
          // Categorical predictor - generate dummy variables (case-insensitive lookup)
          const encoding = categoricalMappings[col.columnName]
          if (!encoding) {
            rowIsValid = false
            break
          }

          const normalizedStr = str.toLowerCase()
          const code = encoding[normalizedStr]
          if (code === undefined) {
            const colName = col.columnName
            if (!unknownPredictorLevels.has(colName)) {
              unknownPredictorLevels.set(colName, new Set<string>())
            }
            unknownPredictorLevels.get(colName)!.add(str)
            rowIsValid = false
            break
          }

          const dummyInfo = dummyVariableInfo[col.columnName]!
          // If baseline level, all dummies = 0
          // Otherwise, set corresponding dummy = 1 (compare normalized values)
          for (const dummyLevel of dummyInfo.dummyLevels) {
            const dummyName = `${col.columnName}_${dummyLevel}`
            predictorValues[dummyName] = normalizedStr === dummyLevel.toLowerCase() ? 1 : 0
          }
        } else {
          // Numeric predictor
          const value = parseStrictNumber(str)
          if (value === null) {
            rowIsValid = false
            break
          }
          predictorValues[col.columnName] = value
        }
      }

      if (!rowIsValid) {
        skippedRows++
        continue
      }

      // Row is valid - add to results
      dependent.push(dependentValue)
      for (const predictorName of predictorNames) {
        predictors[predictorName]!.push(predictorValues[predictorName]!)
      }
      validRows++
    }

    // Emit warnings once per column to avoid log spam on large datasets.
    if (unknownDvLevels.size > 0) {
      console.warn(
        `[extractRegressionPredictors] Unknown DV levels skipped: ` +
          `${Array.from(unknownDvLevels).slice(0, 10).join(', ')}` +
          `${unknownDvLevels.size > 10 ? ' (…)' : ''}`
      )
    }

    if (unknownPredictorLevels.size > 0) {
      for (const [colName, levels] of unknownPredictorLevels.entries()) {
        console.warn(
          `[extractRegressionPredictors] Unknown levels skipped in "${colName}": ` +
            `${Array.from(levels).slice(0, 10).join(', ')}` +
            `${levels.size > 10 ? ' (…)' : ''}`
        )
      }
    }

    return {
      dependent,
      predictors,
      predictorNames,
      dependentMapping,
      dependentReverse,
      categoricalMappings,
      reverseMappings,
      dummyVariableInfo,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
      },
    }
  }

  /**
   * Extract survival analysis data (time + event + optional group + covariates)
   *
   * Used for Kaplan-Meier, Cox Regression, Nelson-Aalen.
   * Ensures event column is binary (0/1).
   * Applies pairwise deletion across all columns.
   * Categorical covariates are encoded as k-1 dummy variables.
   *
   * @param timeColumnIndex - Index of time-to-event column
   * @param eventColumnIndex - Index of event indicator column (0=censored, 1=event)
   * @param rows - Array of rows
   * @param groupColumnIndex - Optional grouping column index
   * @param covariateColumnIndices - Optional covariate column indices
   * @param groupColumn - Optional ColumnClassification for group (to detect categorical)
   * @param covariateColumns - Optional ColumnClassification array for covariates
   * @param eventEncoding - Optional manual mapping for binary labels (event/censored)
   * @returns Aligned time, event, group, covariates, metadata
   */
  static extractSurvivalData(
    timeColumnIndex: number,
    eventColumnIndex: number,
    rows: any[][],
    groupColumnIndex?: number,
    covariateColumnIndices?: number[],
    _groupColumn?: ColumnClassification, // Unused: groups always kept as strings
    covariateColumns?: ColumnClassification[],
    eventEncoding?: { eventValue: string; censoredValue: string },
    covariateEncodings?: Record<string, { trueValue: string; falseValue: string }>
  ): {
    times: number[]
    events: number[]
    groups?: string[]
    covariates?: Record<string, number[]>
    covariateNames?: string[]
    categoricalMappings?: Record<string, Record<string, number>>
    dummyVariableInfo?: Record<string, { baselineLevel: string; dummyLevels: string[] }>
    groupLevels?: string[]
    summary: {
      totalRows: number
      validRows: number
      skippedRows: number
      nEvents: number
      nCensored: number
    }
  } {
    const times: number[] = []
    const events: number[] = []
    const groups: string[] = []
    const covariates: Record<string, number[]> = {}
    const categoricalMappings: Record<string, Record<string, number>> = {}
    const dummyVariableInfo: Record<string, { baselineLevel: string; dummyLevels: string[] }> = {}
    const covariateNames: string[] = []
    const groupLevels = new Set<string>()

    let validRows = 0
    let skippedRows = 0
    let nEvents = 0
    let nCensored = 0

    // Build dummy variable structure for categorical covariates
    if (covariateColumnIndices && covariateColumns) {
      for (let i = 0; i < covariateColumnIndices.length; i++) {
        const col = covariateColumns[i]
        if (!col) continue

        const covariateEncoding = covariateEncodings?.[col.columnName]
        const isCategorical =
          !covariateEncoding &&
          (col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary)

        if (covariateEncoding) {
          // Treat encoded binary covariates as numeric 0/1
          covariateNames.push(col.columnName)
          covariates[col.columnName] = []
        } else if (isCategorical) {
          // Scan for unique levels
          const levels = new Set<string>()
          const colIndex = covariateColumnIndices[i]!
          for (const row of rows) {
            if (!row || colIndex >= row.length) continue
            const val = row[colIndex]
            if (isMissingValue(val)) continue
            const str = String(val).trim()
            if (str !== '') {
              levels.add(str)
            }
          }

          const sortedLevels = Array.from(levels).sort()
          if (sortedLevels.length < 2) {
            // Treat as invalid - will be caught during extraction
            continue
          }

          // Generate k-1 dummy variables
          const baselineLevel = sortedLevels[0]!
          const dummyLevels = sortedLevels.slice(1)

          dummyVariableInfo[col.columnName] = { baselineLevel, dummyLevels }

          // Build encoding map
          const encoding: Record<string, number> = {}
          sortedLevels.forEach((level, idx) => {
            encoding[level] = idx
          })
          categoricalMappings[col.columnName] = encoding

          // Initialize dummy variable arrays
          for (const dummyLevel of dummyLevels) {
            const dummyName = `${col.columnName}_${dummyLevel}`
            covariateNames.push(dummyName)
            covariates[dummyName] = []
          }
        } else {
          // Numeric covariate
          covariateNames.push(col.columnName)
          covariates[col.columnName] = []
        }
      }
    }

    const normalizeBinaryEventValue = (value: unknown): 0 | 1 | null => {
      if (value === null || value === undefined) return null
      if (typeof value === 'boolean') return value ? 1 : 0
      const str = String(value).trim()
      if (str === '') return null
      const lower = str.toLowerCase()

      if (eventEncoding) {
        if (lower === eventEncoding.eventValue.trim().toLowerCase()) return 1
        if (lower === eventEncoding.censoredValue.trim().toLowerCase()) return 0
      }

      if (lower === '1' || lower === 'true') return 1
      if (lower === '0' || lower === 'false') return 0

      const numeric = Number(lower)
      if (!Number.isNaN(numeric) && (numeric === 0 || numeric === 1)) {
        return numeric as 0 | 1
      }

      return null
    }

    const normalizeBinaryCovariateValue = (
      value: unknown,
      encoding: { trueValue: string; falseValue: string }
    ): 0 | 1 | null => {
      if (value === null || value === undefined) return null
      if (typeof value === 'boolean') return value ? 1 : 0
      const str = String(value).trim()
      if (str === '') return null
      const lower = str.toLowerCase()

      if (lower === encoding.trueValue.trim().toLowerCase()) return 1
      if (lower === encoding.falseValue.trim().toLowerCase()) return 0

      if (lower === '1' || lower === 'true') return 1
      if (lower === '0' || lower === 'false') return 0

      const numeric = Number(lower)
      if (!Number.isNaN(numeric) && (numeric === 0 || numeric === 1)) {
        return numeric as 0 | 1
      }

      return null
    }

    // Extract aligned data
    for (const row of rows) {
      if (!row) {
        skippedRows++
        continue
      }

      // Check time column
      if (timeColumnIndex >= row.length) {
        skippedRows++
        continue
      }

      const timeRaw = row[timeColumnIndex]
      if (isMissingValue(timeRaw)) {
        skippedRows++
        continue
      }

      const timeStr = String(timeRaw).trim()
      if (timeStr === '') {
        skippedRows++
        continue
      }

      const timeValue = parseStrictNumber(timeStr)
      if (timeValue === null || timeValue < 0) {
        skippedRows++
        continue
      }

      // Check event column
      if (eventColumnIndex >= row.length) {
        skippedRows++
        continue
      }

      const eventRaw = row[eventColumnIndex]
      if (isMissingValue(eventRaw)) {
        skippedRows++
        continue
      }

      const eventValue = normalizeBinaryEventValue(eventRaw)
      if (eventValue === null) {
        skippedRows++
        continue
      }

      // Check optional group column
      let groupValue: string | undefined
      if (groupColumnIndex !== undefined) {
        if (groupColumnIndex >= row.length) {
          skippedRows++
          continue
        }

        const groupRaw = row[groupColumnIndex]
        if (isMissingValue(groupRaw)) {
          skippedRows++
          continue
        }

        groupValue = String(groupRaw).trim()
        if (groupValue === '') {
          skippedRows++
          continue
        }
      }

      // Check optional covariate columns
      const covariateValues: Record<string, number> = {}
      let rowIsValid = true

      if (covariateColumnIndices && covariateColumns) {
        for (let i = 0; i < covariateColumnIndices.length; i++) {
          const idx = covariateColumnIndices[i]!
          const col = covariateColumns[i]
          if (!col) {
            rowIsValid = false
            break
          }

          if (idx >= row.length) {
            rowIsValid = false
            break
          }

          const raw = row[idx]
          if (isMissingValue(raw)) {
            rowIsValid = false
            break
          }

          const str = String(raw).trim()
          if (str === '') {
            rowIsValid = false
            break
          }

          const covariateEncoding = covariateEncodings?.[col.columnName]
          if (covariateEncoding) {
            const mapped = normalizeBinaryCovariateValue(raw, covariateEncoding)
            if (mapped === null) {
              rowIsValid = false
              break
            }
            covariateValues[col.columnName] = mapped
            continue
          }

          const isCategorical = dummyVariableInfo[col.columnName] !== undefined

          if (isCategorical) {
            // Categorical covariate - set dummy variables
            const dummyInfo = dummyVariableInfo[col.columnName]!
            // All dummies default to 0 (baseline), then set appropriate dummy to 1
            for (const dummyLevel of dummyInfo.dummyLevels) {
              const dummyName = `${col.columnName}_${dummyLevel}`
              covariateValues[dummyName] = str === dummyLevel ? 1 : 0
            }
          } else {
            // Numeric covariate
            const value = parseStrictNumber(str)
            if (value === null) {
              rowIsValid = false
              break
            }
            covariateValues[col.columnName] = value
          }
        }
      }

      if (!rowIsValid) {
        skippedRows++
        continue
      }

      // Row is valid - add to results
      times.push(timeValue)
      events.push(eventValue)

      if (eventValue === 1) {
        nEvents++
      } else {
        nCensored++
      }

      if (groupValue !== undefined) {
        groups.push(groupValue)
        groupLevels.add(groupValue)
      }

      if (covariateColumnIndices && covariateColumns) {
        for (const name of covariateNames) {
          covariates[name]!.push(covariateValues[name]!)
        }
      }

      validRows++
    }

    return {
      times,
      events,
      groups: groupColumnIndex !== undefined ? groups : undefined,
      covariates: covariateColumnIndices ? covariates : undefined,
      covariateNames: covariateColumnIndices ? covariateNames : undefined,
      categoricalMappings: Object.keys(categoricalMappings).length > 0 ? categoricalMappings : undefined,
      dummyVariableInfo: Object.keys(dummyVariableInfo).length > 0 ? dummyVariableInfo : undefined,
      groupLevels: groupColumnIndex !== undefined ? Array.from(groupLevels).sort() : undefined,
      summary: {
        totalRows: rows.length,
        validRows,
        skippedRows,
        nEvents,
        nCensored,
      },
    }
  }
}
