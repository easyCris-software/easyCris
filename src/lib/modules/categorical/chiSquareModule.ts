/**
 * Chi-Square Independence Test Module
 *
 * Ported from Avalonia:
 * - TestValidator.cs::ValidateChiSquareTest() (lines 332-383)
 * - ChiSquareIndependenceModule.cs (Phase 0: validation only, payload building deferred)
 *
 * Phase 1+2 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers (Phase 2)
 * ✅ buildPayload() - implemented with contingency table builder (Phase 1)
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
import { buildContingencyTable } from './contingencyTableBuilder'

/**
 * Chi-Square Independence Test Module
 *
 * Tests whether two categorical variables are independent (associated).
 *
 * Requirements:
 * - Exactly 2 categorical columns
 * - Each column must have at least 2 categories
 * - Both columns must have data (not empty)
 *
 * Warnings:
 * - For 2×2 tables, Fisher's Exact Test is more accurate
 */
export const chiSquareModule: ITestModule = {
  moduleId: 'chi_square',

  /**
   * Validate column selection for Chi-Square Independence Test
   *
   * Phase 2: Uses TestValidator shared helpers for centralized validation logic
   *
   * Validation Rules:
   * 1. Exactly 2 columns required
   * 2. Both columns must be categorical (not continuous numeric)
   * 3. Each column must have at least 2 categories
   * 4. Warning for 2×2 tables (suggests Fisher's Exact Test)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 2, 'Chi-Square Test'),
      TestValidator.checkAllCategorical(columns, 'Chi-Square Test'),
      TestValidator.checkMinCategories(columns, 2, 'Chi-Square Test'),
      TestValidator.checkFisherExactSuggestion(columns),
    ])
  },

  /**
   * Build Python payload for Chi-Square Independence Test
   *
   * Phase 1: IMPLEMENTED
   * Builds a contingency table from two categorical columns
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha)
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
          error: 'Chi-Square Test requires exactly 2 columns',
        }
      }

      const mapping = (parameters.chi_square_mapping ?? parameters.chiSquareMapping) as
        | {
            group?: string
            outcome?: string
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

      const mappedGroupIndex = findSelectedIndex(mapping?.group)
      const mappedOutcomeIndex = findSelectedIndex(mapping?.outcome)

      const col1Index = mappedGroupIndex ?? selectedColumnIndices[0]!
      const col2Index = mappedOutcomeIndex ?? selectedColumnIndices[1]!

      // Extract column arrays from rows (rows is 2D array: rows[rowIdx][colIdx])
      const col1Data: any[] = []
      const col2Data: any[] = []

      for (const row of rows as any[][]) {
        col1Data.push(row[col1Index])
        col2Data.push(row[col2Index])
      }

      // Build contingency table using shared utility
      // Case-sensitive by default (users can see "Yes" vs "yes" as different)
      const result = buildContingencyTable(col1Data, col2Data, {
        caseInsensitive: false,
        maxRows: rows.length, // Bound by actual data rows (excludes buffer rows if controller passes correct data)
      })

      if (!result) {
        return {
          success: false,
          error: 'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      if (result.table.length === 0 || result.table[0]!.length === 0) {
        return {
          success: false,
          error: 'Insufficient data to build contingency table.',
        }
      }

      const groupColumn =
        columns.find((col) => col.columnId === mapping?.group || col.columnName === mapping?.group) ??
        columns[0]!
      const outcomeColumn =
        columns.find((col) => col.columnId === mapping?.outcome || col.columnName === mapping?.outcome) ??
        columns[1]!

      // Build Python payload
      const payload = {
        test: 'chi_square',
        data: {
          observed: result.table,
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
   * Default parameters for Chi-Square Independence Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}

