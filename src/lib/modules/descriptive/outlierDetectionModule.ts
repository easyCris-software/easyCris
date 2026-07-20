/**
 * Outlier Detection Module
 *
 * Phase 3 Batch 3 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with extractNumericDataWithTracking()
 * ✅ defaultParameters() - returns { alpha: 0.05, methods: ['iqr', 'zscore', 'modified_zscore'] }
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
 * Outlier Detection Module
 *
 * Identifies outliers using multiple statistical methods:
 * - IQR (Interquartile Range): Values beyond Q1 - 1.5×IQR or Q3 + 1.5×IQR
 * - Z-score: Values with |z| > threshold (typically 3)
 * - Modified Z-score: Robust version using median absolute deviation (MAD)
 *
 * Requirements:
 * - Exactly 1 numeric column
 * - Column must be numeric (not categorical/binary)
 * - Column must have data (not empty)
 * - Minimum 4 observations (for IQR calculation)
 *
 * Use Cases:
 * - Data quality assessment
 * - Identifying extreme values before analysis
 * - Detecting measurement errors or data entry mistakes
 *
 * Methods Comparison:
 * - IQR: Non-parametric, robust to skewed distributions
 * - Z-score: Parametric, assumes normal distribution
 * - Modified Z-score: Robust alternative to Z-score, less affected by outliers
 */
export const outlierDetectionModule: ITestModule = {
  moduleId: 'outlier_detection',

  /**
   * Validate column selection for Outlier Detection
   *
   * Phase 3: Uses TestValidator shared helpers
   * Same validation as descriptive statistics (single numeric column)
   *
   * Validation Rules:
   * 1. Exactly 1 column required
   * 2. Column must be numeric (not categorical/binary/empty)
   * 3. Ordinal data allowed (can detect outliers in ordinal scales)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Outlier detection works on single numeric columns
    return TestValidator.combineResults([
      TestValidator.checkColumnCount(columns, 1, 'Outlier Detection'),
      TestValidator.checkAllNumeric(columns, 'Outlier Detection'),
    ])
  },

  /**
   * Build Python payload for Outlier Detection
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, methods)
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
          error: 'Outlier Detection requires exactly 1 column',
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

      if (data.length < 4) {
        return {
          success: false,
          error: `Insufficient sample size: ${data.length} observations. Outlier detection requires at least 4 observations (for IQR calculation).`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'outlier_detection',
        data: {
          values: data,
          variable_name: columns[0]!.columnName,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
          methods: parameters.methods ?? ['iqr', 'zscore', 'modified_zscore'],
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
   * Default parameters for Outlier Detection
   *
   * @returns Default alpha level and detection methods
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      methods: ['iqr', 'zscore', 'modified_zscore'],
    }
  },
}
