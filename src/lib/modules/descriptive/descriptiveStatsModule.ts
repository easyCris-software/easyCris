/**
 * Descriptive Statistics Module
 *
 * Phase 3 Batch 3 Implementation:
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
 * Descriptive Statistics Module
 *
 * Calculates comprehensive summary statistics for a numeric variable.
 *
 * Provides:
 * - Central tendency: Mean, median, mode
 * - Dispersion: Standard deviation, variance, range, IQR
 * - Distribution shape: Skewness, kurtosis
 * - Confidence intervals for mean
 * - Sample size and missing value counts
 *
 * Requirements:
 * - Exactly 1 numeric column
 * - Column must be numeric (not categorical/binary)
 * - Column must have data (not empty)
 * - Minimum 2 observations for meaningful statistics
 *
 * Use Case:
 * - Exploratory data analysis
 * - Understanding data distribution before statistical tests
 * - Reporting sample characteristics
 */
export const descriptiveStatsModule: ITestModule = {
  moduleId: 'descriptive_stats',

  /**
   * Validate column selection for Descriptive Statistics
   *
   * Phase 3: Uses TestValidator shared helpers
   * Same validation as normality tests (single numeric column)
   *
   * Validation Rules:
   * 1. Exactly 1 column required
   * 2. Column must be numeric (not categorical/binary/empty)
   * 3. Ordinal data allowed (descriptive stats work on ordinal scales)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Descriptive statistics work on single numeric columns
    return TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 1, 'Descriptive Statistics'),
      TestValidator.checkAllNumeric(columns, 'Descriptive Statistics'),
    ])
  },

  /**
   * Build Python payload for Descriptive Statistics
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha for confidence intervals)
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
          error: 'Descriptive Statistics requires exactly 1 column',
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
          error: `Insufficient sample size: ${data.length} observation(s). Minimum 2 observations required for meaningful statistics.`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'descriptive_stats',
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
   * Default parameters for Descriptive Statistics
   *
   * @returns Default alpha level (for confidence intervals)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
