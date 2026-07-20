/**
 * McNemar's Test Module
 *
 * Phase 3 Batch 2 (Correctness Fix):
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with symmetric contingency table builder
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import { TestValidator } from '../core/TestValidator'
import { buildSymmetric2x2Table } from './contingencyTableBuilder'

/**
 * McNemar's Test Module
 *
 * Test for paired nominal data (before/after measurements on same subjects).
 * Evaluates changes in binary outcomes (e.g., pre-treatment vs post-treatment).
 *
 * Requirements:
 * - Exactly 2 categorical columns (paired measurements)
 * - Each column must have exactly 2 categories
 * - Both columns must share identical category labels (symmetric)
 * - Data must be paired (same subjects, before/after)
 *
 * Note: For unpaired 2×2 tables, use Fisher's Exact Test instead.
 */
export const mcnemarModule: ITestModule = {
  moduleId: 'mcnemar',

  /**
   * Validate column selection for McNemar's Test
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. Exactly 2 columns required (before and after measurements)
   * 2. Both columns must be categorical (not continuous numeric)
   * 3. Each column must have exactly 2 categories (2×2 table)
   * 4. Both columns must share identical category labels (symmetric requirement)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Use shared helpers for basic checks
    const basicValidation = TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 2, "McNemar's Test"),
      TestValidator.checkAllCategorical(columns, "McNemar's Test"),
      TestValidator.checkMinCategories(columns, 2, "McNemar's Test"),
    ])

    // If basic validation failed, return immediately
    if (!basicValidation.isValid) {
      return basicValidation
    }

    // McNemar-specific: Check for exactly 2 categories per column
    const col1 = columns[0]!
    const col2 = columns[1]!

    if (col1.uniqueValueCount !== 2 || col2.uniqueValueCount !== 2) {
      return {
        isValid: false,
        errors: [
          `McNemar's Test requires exactly 2 categories in each column (2×2 table). Column '${col1.columnName}' has ${col1.uniqueValueCount} categories, '${col2.columnName}' has ${col2.uniqueValueCount} categories.`,
        ],
        warnings: [],
        suggestions: [
          'Ensure each column has exactly 2 distinct categories (e.g., Yes/No, Before/After)',
          'Both columns should measure the same variable at different times',
        ],
      }
    }

    // McNemar-specific: Check for symmetric categories (both columns have same labels)
    const col1Categories = new Set(col1.uniqueValues.map(v => String(v).toLowerCase()))
    const col2Categories = new Set(col2.uniqueValues.map(v => String(v).toLowerCase()))

    // Check if sets are equal
    const areSymmetric =
      col1Categories.size === col2Categories.size &&
      [...col1Categories].every(cat => col2Categories.has(cat))

    if (!areSymmetric) {
      const col1Labels = Array.from(col1Categories).join(', ')
      const col2Labels = Array.from(col2Categories).join(', ')

      return {
        isValid: false,
        errors: [
          `McNemar's Test requires both columns to have identical category labels (symmetric table). Column '${col1.columnName}' has [${col1Labels}], '${col2.columnName}' has [${col2Labels}].`,
        ],
        warnings: [],
        suggestions: [
          'Ensure both columns use the same category labels (e.g., both use "Yes"/"No", not "Yes"/"No" vs "True"/"False")',
          'McNemar tests changes in paired binary outcomes - both measurements should use the same scale',
        ],
      }
    }

    // All checks passed
    return {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: [
        'McNemar\'s Test analyzes changes in paired binary outcomes (e.g., before/after treatment)',
      ],
    }
  },

  /**
   * Build Python payload for McNemar's Test
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, mcnemar_mapping)
   * @returns Payload for Python backend or error
   */
  buildPayload(
    columns: ColumnClassification[],
    selectedColumnIndices: number[],
    rows: any[],
    parameters: Record<string, any>
  ): BuildPayloadResult {
    try {
      if (columns.length !== 2 || selectedColumnIndices.length !== 2) {
        return {
          success: false,
          error: "McNemar's Test requires exactly 2 columns",
        }
      }

      // Check for explicit column mapping from the dialog
      const mapping = (parameters.mcnemar_mapping ?? parameters.mcnemarMapping) as
        | { before?: string | null; after?: string | null }
        | undefined

      // Helper to find column index by id or name
      const findColumnIndex = (idOrName: string | null | undefined): number | null => {
        if (!idOrName) return null
        const colIdx = columns.findIndex(
          (col) => col.columnId === idOrName || col.columnName === idOrName
        )
        if (colIdx === -1) return null
        return selectedColumnIndices[colIdx] ?? null
      }

      // Helper to find column by id or name
      const findColumn = (idOrName: string | null | undefined): ColumnClassification | null => {
        if (!idOrName) return null
        return columns.find((col) => col.columnId === idOrName || col.columnName === idOrName) ?? null
      }

      let beforeIndex: number
      let afterIndex: number
      let beforeColumn: ColumnClassification
      let afterColumn: ColumnClassification

      if (mapping?.before && mapping?.after) {
        // Use explicit mapping from dialog
        const beforeIdx = findColumnIndex(mapping.before)
        const afterIdx = findColumnIndex(mapping.after)
        const beforeCol = findColumn(mapping.before)
        const afterCol = findColumn(mapping.after)

        if (beforeIdx === null || afterIdx === null || !beforeCol || !afterCol) {
          return {
            success: false,
            error: 'Before or After column not found in selection.',
          }
        }

        beforeIndex = beforeIdx
        afterIndex = afterIdx
        beforeColumn = beforeCol
        afterColumn = afterCol
      } else {
        // Fall back to positional (first = before, second = after)
        beforeIndex = selectedColumnIndices[0]!
        afterIndex = selectedColumnIndices[1]!
        beforeColumn = columns[0]!
        afterColumn = columns[1]!
      }

      // Extract column arrays from rows (rows is 2D array: rows[rowIdx][colIdx])
      const beforeData: any[] = []
      const afterData: any[] = []

      for (const row of rows as any[][]) {
        beforeData.push(row[beforeIndex])
        afterData.push(row[afterIndex])
      }

      // Build symmetric 2×2 contingency table using shared utility
      const result = buildSymmetric2x2Table(beforeData, afterData, {
        caseInsensitive: true,
        maxRows: rows.length,
      })

      if (!result) {
        return {
          success: false,
          error: 'No valid data or table is not symmetric 2×2. Check that each column has exactly 2 categories, both columns share identical labels, and no missing values.',
        }
      }

      if (result.table.length !== 2 || result.table[0]!.length !== 2) {
        return {
          success: false,
          error: 'McNemar\'s Test requires a 2×2 contingency table. Ensure each column has exactly 2 categories.',
        }
      }

      // Verify symmetry (row and column labels match)
      const rowLabelsLower = result.rowLabels.map(l => l.toLowerCase())
      const colLabelsLower = result.colLabels.map(l => l.toLowerCase())

      const isSymmetric = rowLabelsLower.length === colLabelsLower.length &&
        rowLabelsLower.every((label, idx) => label === colLabelsLower[idx])

      if (!isSymmetric) {
        return {
          success: false,
          error: `McNemar's Test requires symmetric table (identical row/column labels). Got rows: [${result.rowLabels.join(', ')}], columns: [${result.colLabels.join(', ')}]`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'mcnemar',
        data: {
          table: result.table,
          row_labels: result.rowLabels,
          col_labels: result.colLabels,
          row_variable: beforeColumn.columnName,
          col_variable: afterColumn.columnName,
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
   * Default parameters for McNemar's Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}

