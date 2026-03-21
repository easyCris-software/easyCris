/**
 * One Sample T-Test Module
 *
 * Phase 3 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with extractNumericDataWithTracking()
 * ✅ defaultParameters() - returns { alpha: 0.05, population_mean: 0 }
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
 * One Sample T-Test Module
 *
 * Tests whether a sample mean differs from a known population mean.
 *
 * Requirements:
 * - Exactly 1 numeric column
 * - Column must be numeric (not categorical/binary)
 * - Column must have data (not empty)
 *
 * Warnings:
 * - Ordinal data generates warning (suggests Wilcoxon Signed-Rank instead)
 */
export const oneSampleTTestModule: ITestModule = {
  moduleId: 'one_sample_ttest',

  /**
   * Validate column selection for One Sample T-Test
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. Exactly 1 column required
   * 2. Column must be numeric (not categorical/binary/empty)
   * 3. Ordinal data generates warning but allows test to run
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 1, 'One Sample T-Test'),
      TestValidator.checkAllNumeric(columns, 'One Sample T-Test'),
      TestValidator.checkOrdinalWarning(columns, 'One Sample T-Test', true),
    ])
  },

  /**
   * Build Python payload for One Sample T-Test
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, population_mean)
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
          error: 'One Sample T-Test requires exactly 1 column',
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

      if (data.length < 2) {
        return {
          success: false,
          error: `Insufficient sample size: ${data.length} observations. Minimum 2 observations required.`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'one_sample_ttest',
        data: {
          values: data,
          variable_name: columns[0]!.columnName,
        },
        parameters: {
          population_mean: parameters.population_mean ?? 0,
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
   * Default parameters for One Sample T-Test
   *
   * @returns Default alpha level and population mean
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      population_mean: 0,
    }
  },
}
