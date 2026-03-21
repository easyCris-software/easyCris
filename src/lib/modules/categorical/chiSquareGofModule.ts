/**
 * Chi-Square Goodness of Fit Test Module
 *
 * Phase 3 Batch 5 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - builds frequency table from categorical column
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import { ColumnDataType } from '../core/types'

const GOF_CATEGORY_COUNTS_SENTINEL = '__CATEGORY_COUNTS__'

/**
 * Chi-Square Goodness of Fit Test Module
 *
 * Tests whether observed frequencies in a categorical variable match
 * an expected distribution (uniform by default, or user-specified).
 *
 * Requirements:
 * - Exactly 1 categorical/binary column
 * - At least 2 distinct categories
 * - Each category should have at least 5 expected observations (rule of thumb)
 *
 * Use Cases:
 * - Testing if dice rolls are fair (uniform distribution)
 * - Testing if survey responses match expected proportions
 * - Testing if observed outcomes match theoretical distribution
 *
 * Assumptions:
 * - Observations are independent
 * - Expected frequency ≥ 5 for each category (rule of thumb)
 *
 * Interpretation:
 * - Significant result: Observed frequencies differ from expected
 * - Non-significant: Data consistent with expected distribution
 *
 * Related Test: Chi-Square Test of Independence (compares two categorical variables)
 */
export const chiSquareGofModule: ITestModule = {
  moduleId: 'chi_square_gof',

  /**
   * Validate column selection for Chi-Square Goodness of Fit
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. Either:
   *    - 1 categorical/binary column (frequency derived from raw categories), OR
   *    - 1 numeric counts column (with optional categorical labels + expected proportions)
   * 2. At least 2 categories required
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    if (columns.length === 1) {
      const col = columns[0]!

      // Allow either categorical labels or numeric observed counts
      if (
        col.dataType !== ColumnDataType.Categorical &&
        col.dataType !== ColumnDataType.Binary &&
        col.dataType !== ColumnDataType.Numeric &&
        col.dataType !== ColumnDataType.Ordinal
      ) {
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' is not categorical or numeric (type: ${col.dataType}). Chi-Square Goodness of Fit requires categorical data or numeric counts.`,
          ],
          warnings: [],
          suggestions: [
            'Select a categorical or binary column',
            'Select a numeric column of observed counts',
          ],
        }
      }

      if (col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal) {
        return {
          isValid: true,
          errors: [],
          warnings: [],
          suggestions: [
            'Observed counts will be read directly from the numeric column.',
            'Category labels will be auto-generated unless a label column is selected.',
          ],
        }
      }

      // Check minimum categories (need at least 2)
      if (col.uniqueValueCount < 2) {
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' has only ${col.uniqueValueCount} unique value. Chi-Square Goodness of Fit requires at least 2 categories.`,
          ],
          warnings: [],
          suggestions: ['Select a column with at least 2 distinct categories'],
        }
      }

      // Add suggestion about expected frequencies
      const suggestions: string[] = []
      if (col.uniqueValueCount >= 2) {
        suggestions.push(
          `Test will check if ${col.uniqueValueCount} observed categories match expected distribution (uniform by default).`
        )
      }

      // Warn if many categories (might violate expected frequency assumption)
      const warnings: string[] = []
      if (col.uniqueValueCount > 20) {
        warnings.push(
          `Column has ${col.uniqueValueCount} categories. Chi-Square Goodness of Fit works best with fewer categories. Ensure expected frequency >= 5 per category.`
        )
      }

      return {
        isValid: true,
        errors: [],
        warnings,
        suggestions,
      }
    }

    const numericCols = columns.filter(
      col => col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal
    )
    if (numericCols.length === 0) {
      return {
        isValid: false,
        errors: [
          'Chi-Square Goodness of Fit requires a numeric counts column when selecting multiple columns.',
        ],
        warnings: [],
        suggestions: [
          'Select a numeric column containing observed counts',
          'Optionally include a categorical label column and expected proportions',
        ],
      }
    }

    if (numericCols.length > 2) {
      return {
        isValid: false,
        errors: [
          `Chi-Square Goodness of Fit supports at most 2 numeric columns (observed counts + optional expected proportions). Selected: ${numericCols.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select a single observed counts column',
          'Optionally include one expected proportions column',
        ],
      }
    }

    const warnings: string[] = []
    const suggestions: string[] = [
      'Observed counts will be read directly from the numeric column.',
      'Optional expected proportions column will be used if provided; otherwise uniform expected frequencies are assumed.',
    ]

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Chi-Square Goodness of Fit
   *
   * Extracts frequency counts from categorical column or reads observed counts directly.
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, expected frequencies)
   * @returns Payload for Python backend or error
   */
  buildPayload(
    columns: ColumnClassification[],
    selectedColumnIndices: number[],
    rows: any[],
    parameters: Record<string, any>
  ): BuildPayloadResult {
    try {
      if (columns.length !== selectedColumnIndices.length || columns.length < 1) {
        return {
          success: false,
          error: 'Chi-Square Goodness of Fit requires at least 1 selected column.',
        }
      }

      const mapping = (parameters.gof_mapping ?? parameters.gofMapping) as
        | {
            category?: string | null
            observed?: string | null
            expected?: string | null
          }
        | undefined

      const findSelectedIndex = (idOrName: string | null | undefined): number | null => {
        if (!idOrName) {
          return null
        }
        const columnIndex = columns.findIndex(
          (col) => col.columnId === idOrName || col.columnName === idOrName
        )
        if (columnIndex === -1) {
          return null
        }
        return selectedColumnIndices[columnIndex] ?? null
      }

      const findColumn = (idOrName: string | null | undefined): ColumnClassification | null => {
        if (!idOrName) {
          return null
        }
        return (
          columns.find((col) => col.columnId === idOrName || col.columnName === idOrName) ?? null
        )
      }

      if (mapping?.observed) {
        if (mapping.observed === GOF_CATEGORY_COUNTS_SENTINEL) {
          const categoryIndex = findSelectedIndex(mapping.category)
          if (categoryIndex === null) {
            return {
              success: false,
              error: 'Category column not found for derived counts.',
            }
          }

          const frequencyCounts = new Map<string, number>()
          const categoryOrder: string[] = []

          for (const row of rows as any[][]) {
            if (!row || categoryIndex >= row.length) {
              continue
            }

            const rawValue = row[categoryIndex]
            const strValue = String(rawValue).trim()

            if (
              strValue === '' ||
              strValue === 'NA' ||
              strValue === 'N/A' ||
              strValue === 'null' ||
              rawValue === null ||
              rawValue === undefined
            ) {
              continue
            }

            if (!frequencyCounts.has(strValue)) {
              frequencyCounts.set(strValue, 0)
              categoryOrder.push(strValue)
            }

            frequencyCounts.set(strValue, frequencyCounts.get(strValue)! + 1)
          }

          if (categoryOrder.length < 2) {
            return {
              success: false,
              error: 'Chi-Square Goodness of Fit requires at least 2 categories.',
            }
          }

          const observed = categoryOrder.map((category) => frequencyCounts.get(category)!)
          const expected = parameters.expected || null

          if (expected !== null) {
            if (!Array.isArray(expected)) {
              return {
                success: false,
                error: 'Expected frequencies must be an array of numbers.',
              }
            }

            if (expected.length !== observed.length) {
              return {
                success: false,
                error: `Expected frequencies length (${expected.length}) must match observed categories (${observed.length}).`,
              }
            }

            if (expected.some((e: any) => typeof e !== 'number' || e <= 0)) {
              return {
                success: false,
                error: 'All expected frequencies must be positive numbers.',
              }
            }
          }

          return {
            success: true,
            payload: {
              test: 'chi_square_gof',
              data: {
                observed,
                expected,
                category_labels: categoryOrder,
                column_name: findColumn(mapping.category)?.columnName ?? 'Category',
              },
              parameters: {
                alpha: parameters.alpha ?? 0.05,
              },
            },
          }
        }

        const observedIndex = findSelectedIndex(mapping.observed)
        if (observedIndex === null) {
          return {
            success: false,
            error: 'Observed counts column not found.',
          }
        }

        const expectedIndex =
          mapping.expected ? findSelectedIndex(mapping.expected) : null
        if (mapping.expected && expectedIndex === null) {
          return {
            success: false,
            error: 'Expected proportions column not found.',
          }
        }

        const categoryIndex =
          mapping.category ? findSelectedIndex(mapping.category) : null
        if (mapping.category && categoryIndex === null) {
          return {
            success: false,
            error: 'Category labels column not found.',
          }
        }

        const observed: number[] = []
        const expected: number[] = []
        const categoryLabels: string[] = []

        for (let rowIdx = 0; rowIdx < (rows as any[][]).length; rowIdx++) {
          const row = (rows as any[][])[rowIdx]
          if (!row || observedIndex >= row.length) {
            continue
          }

          const observedRaw = row[observedIndex]
          const observedValue = typeof observedRaw === 'number' ? observedRaw : Number(observedRaw)
          if (Number.isNaN(observedValue) || observedValue < 0) {
            continue
          }

          if (expectedIndex !== null) {
            const expectedRaw = row[expectedIndex]
            const expectedValue = typeof expectedRaw === 'number' ? expectedRaw : Number(expectedRaw)
            if (Number.isNaN(expectedValue) || expectedValue <= 0) {
              continue
            }
            expected.push(expectedValue)
          }

          if (categoryIndex !== null && categoryIndex < row.length) {
            const label = String(row[categoryIndex] ?? '').trim()
            categoryLabels.push(label || `Category ${observed.length + 1}`)
          } else {
            categoryLabels.push(`Category ${observed.length + 1}`)
          }

          observed.push(observedValue)
        }

        if (observed.length < 2) {
          return {
            success: false,
            error: 'Chi-Square Goodness of Fit requires at least 2 observed categories.',
          }
        }

        if (expectedIndex !== null && expected.length !== observed.length) {
          return {
            success: false,
            error: 'Expected proportions column has missing values. Ensure all rows have expected proportions.',
          }
        }

        return {
          success: true,
          payload: {
            test: 'chi_square_gof',
            data: {
              observed,
              expected: expectedIndex !== null ? expected : parameters.expected ?? null,
              category_labels: categoryLabels,
              column_name:
                findColumn(mapping.category)?.columnName ??
                findColumn(mapping.observed)?.columnName ??
                'Observed Counts',
            },
            parameters: {
              alpha: parameters.alpha ?? 0.05,
            },
          },
        }
      }

      if (columns.length === 1) {
        const columnIndex = selectedColumnIndices[0]!
        const col = columns[0]!

        // Build frequency table from categorical data
        const frequencyCounts = new Map<string, number>()
        const categoryOrder: string[] = []

        // Iterate through rows and count frequencies (rows is 2D array: rows[rowIdx][colIdx])
        for (const row of rows as any[][]) {
          // Check if row exists and has data at this column
          if (!row || columnIndex >= row.length) {
            continue
          }

          const rawValue = row[columnIndex]
          const strValue = String(rawValue).trim()

          // Skip missing/empty values
          if (
            strValue === '' ||
            strValue === 'NA' ||
            strValue === 'N/A' ||
            strValue === 'null' ||
            rawValue === null ||
            rawValue === undefined
          ) {
            continue
          }

          // Add to frequency count
          if (!frequencyCounts.has(strValue)) {
            frequencyCounts.set(strValue, 0)
            categoryOrder.push(strValue)
          }

          frequencyCounts.set(strValue, frequencyCounts.get(strValue)! + 1)
        }

        // Validate we have sufficient data
        if (categoryOrder.length === 0) {
          return {
            success: false,
            error: 'No valid categorical data found. All values are missing or empty.',
          }
        }

        if (categoryOrder.length < 2) {
          return {
            success: false,
            error: `Only ${categoryOrder.length} category found after removing missing values. Chi-Square Goodness of Fit requires at least 2 categories.`,
          }
        }

        // Extract observed frequencies (preserve category order)
        const observed = categoryOrder.map(category => frequencyCounts.get(category)!)

        // Check for expected frequencies in parameters
        const expected = parameters.expected || null

        // Validate expected frequencies if provided
        if (expected !== null) {
          if (!Array.isArray(expected)) {
            return {
              success: false,
              error: 'Expected frequencies must be an array of numbers.',
            }
          }

          if (expected.length !== observed.length) {
            return {
              success: false,
              error: `Expected frequencies length (${expected.length}) must match observed categories (${observed.length}).`,
            }
          }

          // Check all expected values are positive
          if (expected.some((e: any) => typeof e !== 'number' || e <= 0)) {
            return {
              success: false,
              error: 'All expected frequencies must be positive numbers.',
            }
          }
        }

        // Build Python payload
        const payload = {
          test: 'chi_square_gof',
          data: {
            observed,
            expected, // null for uniform distribution, or array of expected counts/proportions
            category_labels: categoryOrder,
            column_name: col.columnName,
          },
          parameters: {
            alpha: parameters.alpha ?? 0.05,
          },
        }

        return {
          success: true,
          payload,
        }
      }

      const numericCols = columns
        .map((col, idx) => ({ col, idx }))
        .filter(
          ({ col }) =>
            col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal
        )

      if (numericCols.length === 0) {
        return {
          success: false,
          error: 'No numeric counts column found. Select a numeric observed counts column.',
        }
      }

      const observedIndex = selectedColumnIndices[numericCols[0]!.idx]!
      const expectedIndex =
        numericCols.length > 1 ? selectedColumnIndices[numericCols[1]!.idx]! : null
      const labelCol = columns.find(col =>
        col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary
      )
      const labelIndex = labelCol
        ? selectedColumnIndices[columns.indexOf(labelCol)]!
        : null

      const observed: number[] = []
      const expected: number[] = []
      const categoryLabels: string[] = []

      for (let rowIdx = 0; rowIdx < (rows as any[][]).length; rowIdx++) {
        const row = (rows as any[][])[rowIdx]
        if (!row || observedIndex >= row.length) {
          continue
        }

        const observedRaw = row[observedIndex]
        const observedValue = typeof observedRaw === 'number' ? observedRaw : Number(observedRaw)
        if (Number.isNaN(observedValue) || observedValue < 0) {
          continue
        }

        if (expectedIndex !== null) {
          const expectedRaw = row[expectedIndex]
          const expectedValue = typeof expectedRaw === 'number' ? expectedRaw : Number(expectedRaw)
          if (Number.isNaN(expectedValue) || expectedValue <= 0) {
            continue
          }
          expected.push(expectedValue)
        }

        if (labelIndex !== null && labelIndex < row.length) {
          categoryLabels.push(String(row[labelIndex]).trim())
        } else {
          categoryLabels.push(`Category ${observed.length + 1}`)
        }

        observed.push(observedValue)
      }

      if (observed.length < 2) {
        return {
          success: false,
          error: 'Chi-Square Goodness of Fit requires at least 2 observed categories.',
        }
      }

      if (expectedIndex !== null && expected.length !== observed.length) {
        return {
          success: false,
          error: 'Expected proportions column has missing values. Ensure all rows have expected proportions.',
        }
      }

      const payload = {
        test: 'chi_square_gof',
        data: {
          observed,
          expected: expectedIndex !== null ? expected : parameters.expected ?? null,
          category_labels: categoryLabels,
          column_name: labelCol?.columnName ?? 'Observed Counts',
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
      }

      return {
        success: true,
        payload,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  },

  /**
   * Default parameters for Chi-Square Goodness of Fit
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      expected: null, // null = uniform distribution (default)
    }
  },
}
