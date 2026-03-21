/**
 * Shapiro-Wilk Normality Test Module
 *
 * Ported from Avalonia:
 * - TestValidator.cs::ValidateNormalityTests() - uses ValidateDescriptiveStatistics (line 231)
 *
 * Phase 3 Implementation:
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
 * Shapiro-Wilk Normality Test Module
 *
 * Tests whether a sample comes from a normally distributed population.
 * Most powerful test for normality, especially for small sample sizes.
 *
 * Requirements:
 * - Exactly 1 numeric column
 * - Column must be numeric (not categorical/binary)
 * - Column must have data (not empty)
 * - Minimum 3 observations (preferably 20+)
 *
 * Interpretation:
 * - p > 0.05: Data is consistent with normal distribution
 * - p ≤ 0.05: Data deviates significantly from normality
 */
export const shapiroWilkModule: ITestModule = {
  moduleId: 'normality_shapiro',

  /**
   * Validate column selection for Shapiro-Wilk Test
   *
   * Phase 3: Uses TestValidator shared helpers
   * Same as Descriptive Statistics (per Avalonia line 231)
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
      TestValidator.checkColumnCount(columns, 1, 'Shapiro-Wilk Test'),
      TestValidator.checkAllNumeric(columns, 'Shapiro-Wilk Test'),
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
   * Build Python payload for Shapiro-Wilk Test
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
          error: 'Shapiro-Wilk Test requires exactly 1 column',
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

      if (data.length < 3) {
        return {
          success: false,
          error: `Insufficient sample size: ${data.length} observations. Shapiro-Wilk requires at least 3 observations (preferably 20+).`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'normality_shapiro',
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
   * Default parameters for Shapiro-Wilk Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
