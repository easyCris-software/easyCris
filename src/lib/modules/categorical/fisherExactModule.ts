/**
 * Fisher's Exact Test Module
 *
 * Phase 3 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with contingency table builder
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
import { build2x2Table } from './contingencyTableBuilder'

/**
 * Fisher's Exact Test Module
 *
 * Exact test for independence in 2×2 contingency tables.
 * More accurate than Chi-Square for small sample sizes.
 *
 * Requirements:
 * - Exactly 2 categorical columns
 * - Each column must have exactly 2 categories
 * - Both columns must have data (not empty)
 *
 * IMPORTANT: Fisher >2×2 behavior
 * - This module REQUIRES strictly 2×2 tables (hard requirement)
 * - If columns have >2 categories, validation will FAIL with error
 * - Users should use Chi-Square Independence Test for larger tables
 * - No "warn and continue" behavior - this is by design for correctness
 *
 * Case Sensitivity:
 * - Labels are case-SENSITIVE by default ("Yes" ≠ "yes")
 * - Users can see both "Yes" and "yes" as separate categories
 * - This allows users to detect data inconsistencies
 * - To enable case-insensitive counting, modify buildPayload caseInsensitive option
 *
 * Note: For tables larger than 2×2, use Chi-Square Test instead.
 */
export const fisherExactModule: ITestModule = {
  moduleId: 'fishers_exact',

  /**
   * Validate column selection for Fisher's Exact Test
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. Exactly 2 columns required
   * 2. Both columns must be categorical (not continuous numeric)
   * 3. Each column must have exactly 2 categories (2×2 table)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Use shared helpers for basic checks
    const basicValidation = TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 2, "Fisher's Exact Test"),
      TestValidator.checkAllCategorical(columns, "Fisher's Exact Test"),
      TestValidator.checkMinCategories(columns, 2, "Fisher's Exact Test"),
    ])

    // If basic validation failed, return immediately
    if (!basicValidation.isValid) {
      return basicValidation
    }

    // Fisher-specific: Check for exactly 2 categories per column (2×2 table)
    const col1 = columns[0]!
    const col2 = columns[1]!

    if (col1.uniqueValueCount !== 2 || col2.uniqueValueCount !== 2) {
      return {
        isValid: false,
        errors: [
          `Fisher's Exact Test requires exactly 2 categories in each column (2×2 table). Column '${col1.columnName}' has ${col1.uniqueValueCount} categories, '${col2.columnName}' has ${col2.uniqueValueCount} categories.`,
        ],
        warnings: [],
        suggestions: [
          'Use Chi-Square Test for tables larger than 2×2',
          'Ensure each column has exactly 2 distinct categories',
        ],
      }
    }

    // All checks passed
    return {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: [],
    }
  },

  /**
   * Build Python payload for Fisher's Exact Test
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, fisher_mapping)
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
          error: "Fisher's Exact Test requires exactly 2 columns",
        }
      }

      // Check for explicit column mapping from the dialog
      const mapping = (parameters.fisher_mapping ?? parameters.fisherMapping) as
        | { group?: string | null; outcome?: string | null }
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

      let groupIndex: number
      let outcomeIndex: number
      let groupColumn: ColumnClassification
      let outcomeColumn: ColumnClassification

      if (mapping?.group && mapping?.outcome) {
        // Use explicit mapping from dialog
        const groupIdx = findColumnIndex(mapping.group)
        const outcomeIdx = findColumnIndex(mapping.outcome)
        const groupCol = findColumn(mapping.group)
        const outcomeCol = findColumn(mapping.outcome)

        if (groupIdx === null || outcomeIdx === null || !groupCol || !outcomeCol) {
          return {
            success: false,
            error: 'Group or Outcome column not found in selection.',
          }
        }

        groupIndex = groupIdx
        outcomeIndex = outcomeIdx
        groupColumn = groupCol
        outcomeColumn = outcomeCol
      } else {
        // Fall back to positional (first = group, second = outcome)
        groupIndex = selectedColumnIndices[0]!
        outcomeIndex = selectedColumnIndices[1]!
        groupColumn = columns[0]!
        outcomeColumn = columns[1]!
      }

      // Extract column arrays from rows (rows is 2D array: rows[rowIdx][colIdx])
      const groupData: any[] = []
      const outcomeData: any[] = []

      for (const row of rows as any[][]) {
        groupData.push(row[groupIndex])
        outcomeData.push(row[outcomeIndex])
      }

      // Build 2×2 contingency table using shared utility
      const result = build2x2Table(groupData, outcomeData, {
        caseInsensitive: false,
        maxRows: rows.length,
      })

      if (!result) {
        return {
          success: false,
          error: 'No valid data or table is not 2×2. Check that each column has exactly 2 categories and no missing values.',
        }
      }

      if (result.table.length !== 2 || result.table[0]!.length !== 2) {
        return {
          success: false,
          error: 'Fisher\'s Exact Test requires a 2×2 contingency table. Ensure each column has exactly 2 categories.',
        }
      }

      // Build Python payload
      const payload = {
        test: 'fishers_exact',
        data: {
          table: result.table,
          row_labels: result.rowLabels,
          col_labels: result.colLabels,
          row_variable: groupColumn.columnName,
          col_variable: outcomeColumn.columnName,
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
   * Default parameters for Fisher's Exact Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}

