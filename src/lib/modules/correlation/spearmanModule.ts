/**
 * Spearman Correlation Module
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
import { ColumnDataType } from '../core/types'
import { ColumnDataExtractor } from '../core/ColumnDataExtractor'
import { TestValidator } from '../core/TestValidator'

/**
 * Spearman Correlation Module
 *
 * Non-parametric measure of monotonic relationship between two variables.
 * Produces rank correlation coefficient (rho/ρ) ranging from -1 to +1.
 *
 * Requirements:
 * - Exactly 2 numeric columns (x and y variables)
 * - Both columns must be numeric (ordinal data is ideal)
 * - Monotonic relationship (not necessarily linear)
 *
 * Advantages over Pearson:
 * - No normality assumption (distribution-free)
 * - Robust to outliers (uses ranks)
 * - Ideal for ordinal data (Likert scales)
 * - Detects monotonic (not just linear) relationships
 * - Works well with skewed distributions
 *
 * Interpretation:
 * - |ρ| = 0.00-0.19: Very weak correlation
 * - |ρ| = 0.20-0.39: Weak correlation
 * - |ρ| = 0.40-0.59: Moderate correlation
 * - |ρ| = 0.60-0.79: Strong correlation
 * - |ρ| = 0.80-1.00: Very strong correlation
 *
 * Note: Values tend to be slightly lower than Pearson when relationship is linear
 *
 * Alternative: Kendall's tau (better for small samples with many ties)
 */
export const spearmanModule: ITestModule = {
  moduleId: 'correlation_spearman',

  /**
   * Validate column selection for Spearman Correlation
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. 2-20 columns required (2 for pairwise, 3+ for correlation matrix heatmap)
   * 2. All columns must be numeric (ordinal data is ideal)
   * 3. Positive suggestion for ordinal data
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    const result = TestValidator.combineResults([
      TestValidator.checkColumnCountRange(columns, 2, 20, 'Spearman Correlation'),
      TestValidator.checkAllNumeric(columns, 'Spearman Correlation', { allowBinary: true }),
      TestValidator.checkOrdinalTieWarning(columns, 'Spearman Correlation', {
        suggestKendall: true,
      }),
    ])

    // Add positive suggestion for ordinal data
    const hasOrdinal = columns.some(col => col.isOrdinal)
    if (result.isValid && hasOrdinal) {
      return {
        ...result,
        suggestions: [
          'Spearman Correlation is ideal for ordinal data (Likert scales). It uses ranks and does not assume linearity or normality.',
        ],
      }
    }

    return result
  },

  /**
   * Build Python payload for Spearman Correlation
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
          error: 'Spearman Correlation requires at least 2 columns',
        }
      }

      const encodingMappings = new Map<string, Map<string, number>>()
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i]!
        if (
          col.dataType === ColumnDataType.Binary &&
          col.numericRatio < 1 &&
          col.uniqueValues.length >= 2
        ) {
          const mapping = new Map<string, number>()
          col.uniqueValues.forEach((value, idx) => {
            mapping.set(value, idx)
          })
          encodingMappings.set(selectedColumnIndices[i]!.toString(), mapping)
        }
      }

      // Extract aligned data from all selected columns (pairwise deletion)
      const { data } = ColumnDataExtractor.extractAlignedData(
        selectedColumnIndices,
        rows,
        encodingMappings.size > 0 ? encodingMappings : undefined
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
        test: 'correlation_spearman',
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
   * Default parameters for Spearman Correlation
   *
   * @returns Default alpha level (for confidence intervals)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
