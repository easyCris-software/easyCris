/**
 * Anderson-Darling Normality Test Module
 *
 * Phase 0 Implementation (Group 5 Wiring):
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with extractNumericDataWithTracking()
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import { ColumnDataExtractor } from '../core/ColumnDataExtractor'
import { TestValidator } from '../core/TestValidator'

/**
 * Anderson-Darling Normality Test Module
 *
 * Tests whether a sample comes from a normally distributed population.
 * More weight to tail deviations than Kolmogorov-Smirnov test.
 *
 * Requirements:
 * - Exactly 1 numeric column
 * - Column must be numeric (not categorical/binary)
 * - Column must have data (not empty)
 * - Minimum 8 observations
 *
 * Interpretation:
 * - p > 0.05: Data is consistent with normal distribution
 * - p ≤ 0.05: Data deviates significantly from normality
 */
export const andersonDarlingModule: ITestModule = {
  moduleId: 'normality_ad',

  /**
   * Validate column selection for Anderson-Darling Test
   *
   * Validation Rules:
   * 1. Exactly 1 column required
   * 2. Column must be numeric (not categorical/binary/empty)
   * 3. Ordinal data allowed but generates info suggestion
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Normality tests work on single numeric columns
    const result = TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 1, 'Anderson-Darling Test'),
      TestValidator.checkAllNumeric(columns, 'Anderson-Darling Test'),
    ])

    // Add info suggestion for ordinal data
    const hasOrdinal = columns.some(col => col.isOrdinal)
    if (result.isValid && hasOrdinal) {
      return {
        ...result,
        suggestions: [
          'Ordinal data (Likert scales) may not be truly continuous. Normality tests are most appropriate for interval/ratio data.',
        ],
      }
    }

    return result
  },

  /**
   * Build Python payload for Anderson-Darling Test
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
      if (columns.length !== 1 || selectedColumnIndices.length !== 1) {
        return {
          success: false,
          error: 'Anderson-Darling Test requires exactly 1 column',
        }
      }

      // Extract numeric data from the single column
      const { data } = ColumnDataExtractor.extractNumericDataWithTracking(
        selectedColumnIndices[0]!,
        rows
      )

      // Check if we have sufficient data
      if (data.length === 0) {
        return {
          success: false,
          error: 'No valid data after removing missing values. Check for missing/invalid data in selected column.',
        }
      }

      if (data.length < 8) {
        return {
          success: false,
          error: `Insufficient sample size: ${data.length} observations. Anderson-Darling requires at least 8 observations.`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'normality_ad',
        data: {
          values: data,
          variable_name: columns[0]!.columnName,
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
   * Default parameters for Anderson-Darling Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
