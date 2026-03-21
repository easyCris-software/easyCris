/**
 * Pearson Correlation Module
 *
 * Phase 3 Batch 4 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with extractAlignedData()
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
 * Pearson Correlation Module
 *
 * Measures the strength and direction of linear relationship between two continuous variables.
 * Produces correlation coefficient (r) ranging from -1 (perfect negative) to +1 (perfect positive).
 *
 * Requirements:
 * - Exactly 2 numeric columns (x and y variables)
 * - Both columns must be numeric (continuous data preferred)
 * - Data should be approximately bivariate normal
 * - Linear relationship (use scatterplot to verify)
 *
 * Assumptions:
 * - Linearity: Relationship is linear (not curved)
 * - Normality: Both variables approximately normally distributed
 * - Homoscedasticity: Variance is constant across range
 * - No extreme outliers
 *
 * Interpretation:
 * - |r| = 0.00-0.19: Very weak correlation
 * - |r| = 0.20-0.39: Weak correlation
 * - |r| = 0.40-0.59: Moderate correlation
 * - |r| = 0.60-0.79: Strong correlation
 * - |r| = 0.80-1.00: Very strong correlation
 *
 * Non-parametric alternatives: Spearman or Kendall correlation
 */
export const pearsonModule: ITestModule = {
  moduleId: 'correlation_pearson',

  /**
   * Validate column selection for Pearson Correlation
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. 2-20 columns required (2 for pairwise, 3+ for correlation matrix heatmap)
   * 2. All columns must be numeric (not categorical/binary/empty)
   * 3. Ordinal data generates warning (suggests Spearman instead)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return TestValidator.combineResults([
      TestValidator.checkColumnCountRange(columns, 2, 20, 'Pearson Correlation'),
      TestValidator.checkAllNumeric(columns, 'Pearson Correlation'),
      TestValidator.checkOrdinalWarning(columns, 'Pearson Correlation', true),
    ])
  },

  /**
   * Build Python payload for Pearson Correlation
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
      if (columns.length < 2 || selectedColumnIndices.length < 2) {
        return {
          success: false,
          error: 'Pearson Correlation requires at least 2 columns',
        }
      }

      // Extract aligned data from all selected columns (pairwise deletion)
      const { data } = ColumnDataExtractor.extractAlignedData(
        selectedColumnIndices,
        rows
      )

      const n_total = rows.length
      const n_used = data[0]?.length ?? 0

      // Check if we have sufficient data
      if (n_used === 0) {
        return {
          success: false,
          error: 'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      if (n_used < 3) {
        return {
          success: false,
          error: `Insufficient sample size: ${n_used} observations. Correlation requires at least 3 observations.`,
        }
      }

      // Always extract first two columns for pairwise stats (keeps tables working)
      const x = data[0]!
      const y = data[1]!

      // Build Python payload
      // Include n_total and n_used for pairwise deletion reporting
      const payloadData: Record<string, any> = {
        x: x,
        y: y,
        x_name: columns[0]!.columnName,
        y_name: columns[1]!.columnName,
        n_total: n_total, // Total rows before pairwise deletion
        n_used: n_used, // Valid observations after pairwise deletion
      }

      // If 3+ columns, add full matrix for correlation heatmap
      if (columns.length >= 3) {
        payloadData.matrix = data // Array of arrays: [[col1...], [col2...], ...]
        payloadData.matrix_labels = columns.map(col => col.columnName)
      }

      const payload = {
        test: 'correlation_pearson',
        data: payloadData,
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
   * Default parameters for Pearson Correlation
   *
   * @returns Default alpha level (for confidence intervals)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
