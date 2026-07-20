/**
 * Friedman Test Module
 *
 * Phase 3 Batch 6 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - wide-format support (3+ numeric columns)
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 *
 * CURRENT FORMAT SUPPORT:
 * - Wide format: 3+ numeric columns (each column = condition, each row = subject)
 *
 * FUTURE ENHANCEMENT:
 * - Long format: 1 numeric + 2 categorical (Value + Subject + Condition)
 *   Requires complex balanced-subject detection (see Avalonia TryExtractDataForFriedmanLongFormat)
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
 * Friedman Test Module
 *
 * Non-parametric test for repeated measures (within-subjects design).
 * Tests whether distributions differ across related groups/conditions.
 *
 * WIDE FORMAT (Current Implementation):
 * Each column represents a different condition/time point.
 * Each row represents the same subject measured across all conditions.
 *
 * Example:
 *   Pre | Post | Follow-up
 *   ----|------|----------
 *   5.2 |  6.1 |   7.3
 *   4.9 |  5.8 |   6.9
 *   (Each row = same subject across 3 conditions)
 *
 * Requirements:
 * - Minimum 3 columns (3 conditions/time points)
 * - All columns must be numeric (ordinal data is ideal)
 * - Each row must have data for all conditions (pairwise deletion)
 *
 * Advantages over Repeated Measures ANOVA:
 * - No normality assumption (distribution-free)
 * - Robust to outliers
 * - Ideal for ordinal data (Likert scales)
 * - Works well with skewed distributions
 *
 * Interpretation:
 * - Significant result: At least one condition differs from others
 * - Use post-hoc tests (Nemenyi, Wilcoxon pairwise) to identify differences
 * - Kendall's W (coefficient of concordance) measures effect size
 *
 * Parametric alternative: Repeated Measures ANOVA
 */
export const friedmanModule: ITestModule = {
  moduleId: 'friedman',

  /**
   * Validate column selection for Friedman Test
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. Minimum 3 columns required (3+ conditions)
   * 2. All columns must be numeric (ordinal data is ideal)
   * 3. Positive suggestion for ordinal data
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check minimum columns
    if (columns.length < 3) {
      return {
        isValid: false,
        errors: [
          `Friedman Test requires at least 3 conditions (columns). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Wide format: Select 3 or more numeric columns, each representing a different condition/time point.',
          'Each row should represent the same subject measured across all conditions.',
        ],
      }
    }

    // Check all columns are numeric
    const numericCheck = TestValidator.checkAllNumeric(columns, 'Friedman Test')
    if (numericCheck && !numericCheck.isValid) {
      return numericCheck
    }

    // Add positive suggestion for ordinal data
    const hasOrdinal = columns.some(col => col.isOrdinal)
    const suggestions: string[] = []

    if (hasOrdinal) {
      suggestions.push(
        'Friedman Test is ideal for ordinal repeated measures data (Likert scales measured across time/conditions). It uses ranks instead of raw values.'
      )
    }

    suggestions.push(
      `Testing ${columns.length} repeated conditions. Each row should represent the same subject across all conditions.`
    )

    return {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions,
    }
  },

  /**
   * Build Python payload for Friedman Test
   *
   * Wide format: Each column = condition, each row = subject
   * Extracts aligned data with pairwise deletion (subjects with ANY missing condition are excluded)
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
      if (columns.length < 3 || selectedColumnIndices.length < 3) {
        return {
          success: false,
          error: 'Friedman Test requires at least 3 conditions',
        }
      }

      // Extract aligned data from all columns (pairwise deletion across ALL conditions)
      // Each column = condition, each row = subject
      const { data } = ColumnDataExtractor.extractAlignedData(
        selectedColumnIndices,
        rows
      )

      // Check if we have sufficient data
      if (data.length === 0 || data.some(condition => condition.length === 0)) {
        return {
          success: false,
          error:
            'No valid data after removing missing values. Each subject must have measurements for ALL conditions.',
        }
      }

      // Check minimum sample size (need at least 3 subjects for meaningful test)
      const numSubjects = data[0]!.length
      if (numSubjects < 3) {
        return {
          success: false,
          error: `Insufficient sample size: ${numSubjects} subjects. Friedman Test requires at least 3 subjects (rows).`,
        }
      }

      // Build Python payload
      // Python expects groups = array of arrays, where each array is a condition
      const payload = {
        test: 'friedman',
        data: {
          groups: data, // Array of condition arrays
          group_names: columns.map(col => col.columnName), // Condition labels
          num_subjects: numSubjects,
          num_conditions: data.length,
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
   * Default parameters for Friedman Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
