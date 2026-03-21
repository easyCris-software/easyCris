/**
 * One-Way ANOVA Module
 *
 * Phase 3 Batch 4 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - supports both wide-format and long-format
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 *
 * DUAL FORMAT SUPPORT:
 * - Wide format: 2+ numeric columns (each column = group)
 * - Long format: 1 numeric column + 1 categorical column (group labels)
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
 * One-Way ANOVA Module
 *
 * Analysis of Variance for comparing means across multiple independent groups.
 * Tests whether there are statistically significant differences between group means.
 *
 * TWO DATA FORMATS SUPPORTED:
 *
 * 1. Wide Format (multiple numeric columns):
 *    Control | Drug A | Drug B
 *    --------+--------+-------
 *       5.2  |   6.1  |  7.3
 *       4.9  |   5.8  |  6.9
 *
 * 2. Long Format (value + group column):
 *    Score | Treatment
 *    ------+----------
 *      5.2 | Control
 *      6.1 | Drug A
 *      7.3 | Drug B
 *      4.9 | Control
 *
 * Requirements:
 * - Wide: 2+ numeric columns (each = group)
 * - Long: 1 numeric column + 1 categorical column
 *
 * Assumptions:
 * - Independence of observations
 * - Normality within each group (robust to moderate violations)
 * - Homogeneity of variances (Levene's test performed automatically)
 *
 * Interpretation:
 * - Significant F-test: At least one group mean differs from others
 * - Use post-hoc tests (Tukey HSD) to identify which groups differ
 *
 * Non-parametric alternative: Kruskal-Wallis Test
 */
export const oneWayAnovaModule: ITestModule = {
  moduleId: 'one_way_anova',

  /**
   * Validate column selection for One-Way ANOVA
   *
   * Phase 3: Uses TestValidator shared helpers
   *
   * Validation Rules:
   * 1. Long format: Exactly 2 columns (1 numeric + 1 categorical)
   * 2. Wide format: Minimum 2 numeric columns (each = group)
   * 3. Ordinal data generates warning (suggests Kruskal-Wallis instead)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check for long format first (1 numeric + 1 categorical)
    const longFormat = TestValidator.detectLongFormat(columns)

    if (longFormat) {
      // Long format detected
      const warnings: string[] = []
      const suggestions: string[] = []

      // Add high cardinality warning if present
      if (longFormat.warning) {
        warnings.push(longFormat.warning)
      }

      // Check minimum groups
      if (longFormat.groupCount < 2) {
        return {
          isValid: false,
          errors: [
            `Categorical column has only ${longFormat.groupCount} group. One-Way ANOVA requires at least 2 groups.`,
          ],
          warnings: [],
          suggestions: ['Ensure the grouping column has at least 2 distinct categories.'],
        }
      }

      // Add format detection suggestion
      suggestions.push(
        `Long format detected: ${longFormat.groupCount} groups identified. Both wide-format (multiple columns) and long-format (value + group) are supported.`
      )

      // Check for ordinal data (suggest Kruskal-Wallis)
      const numericCol = columns[longFormat.numericIndex]!
      if (numericCol.isOrdinal) {
        warnings.push(
          'Numeric column appears to be ordinal (Likert scale). One-Way ANOVA assumes continuous interval/ratio data.'
        )
        suggestions.push('Consider using Kruskal-Wallis Test for ordinal data.')
      }

      return {
        isValid: true,
        errors: [],
        warnings,
        suggestions,
      }
    }

    // Fall back to wide format validation (2+ numeric columns)
    if (columns.length < 2) {
      return {
        isValid: false,
        errors: [`One-Way ANOVA requires at least 2 groups (columns). Selected: ${columns.length}.`],
        warnings: [],
        suggestions: [
          'Wide format: Select 2 or more numeric columns, each representing a different group.',
          'Long format: Select 1 numeric column (values) and 1 categorical column (group labels).',
        ],
      }
    }

    // Wide format: Check all columns are numeric
    const numericCheck = TestValidator.checkAllNumeric(columns, 'One-Way ANOVA')
    if (numericCheck && !numericCheck.isValid) {
      // If validation failed with categorical column, suggest long format
      return {
        ...numericCheck,
        suggestions: [
          ...(numericCheck.suggestions || []),
          'Tip: If you have 1 numeric column and 1 categorical column, select both for long-format ANOVA.',
        ],
      }
    }

    // Add ordinal warning for wide format
    const ordinalCheck = TestValidator.checkOrdinalWarning(columns, 'One-Way ANOVA', true)
    if (ordinalCheck && ordinalCheck.warnings.length > 0) {
      return {
        isValid: true,
        errors: [],
        warnings: ordinalCheck.warnings,
        suggestions: ['Consider using Kruskal-Wallis Test for ordinal data.'],
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: [],
    }
  },

  /**
   * Build Python payload for One-Way ANOVA
   *
   * Supports both wide-format and long-format data.
   * Both formats transform into the same Python payload structure.
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
      // Check for explicit column mapping from the dialog (for long format)
      const mapping = parameters.one_way_anova_mapping as
        | {
            group?: string | null
            outcome?: string | null
            posthoc_adjustment?: string | null
            posthoc_q?: number | null
            control_level?: string | null
          }
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

      // Detect format
      const longFormat = TestValidator.detectLongFormat(columns)

      let groups: number[][]
      let groupNames: string[]

      if (longFormat) {
        // Long format: Transform categorical groups into wide-format arrays
        let numericColIndex: number
        let categoricalColIndex: number

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

          categoricalColIndex = groupIdx
          numericColIndex = outcomeIdx
        } else {
          // Fall back to auto-detection
          numericColIndex = selectedColumnIndices[longFormat.numericIndex]!
          categoricalColIndex = selectedColumnIndices[longFormat.categoricalIndex]!
        }

        const result = ColumnDataExtractor.buildGroupsFromLongFormat(
          numericColIndex,
          categoricalColIndex,
          rows
        )

        groups = result.groups
        groupNames = result.groupNames

        // Validate groups
        if (groups.length < 2) {
          return {
            success: false,
            error: `Only ${groups.length} group found after removing missing values. One-Way ANOVA requires at least 2 groups.`,
          }
        }

        // Check if we have sufficient data
        if (groups.some(group => group.length === 0)) {
          return {
            success: false,
            error: 'No valid data in at least one group after removing missing values.',
          }
        }

        // Check minimum sample size per group
        const minGroupSize = Math.min(...groups.map(group => group.length))
        if (minGroupSize < 2) {
          return {
            success: false,
            error: `Insufficient sample size in at least one group: minimum ${minGroupSize} observations. Each group requires at least 2 observations.`,
          }
        }
      } else {
        // Wide format: Each column = group
        if (columns.length < 2 || selectedColumnIndices.length < 2) {
          return {
            success: false,
            error: 'One-Way ANOVA requires at least 2 groups',
          }
        }

        // Extract aligned data from all columns (pairwise deletion across ALL columns)
        const { data } = ColumnDataExtractor.extractAlignedData(
          selectedColumnIndices,
          rows
        )

        groups = data
        groupNames = columns.map(col => col.columnName)

        // Check if we have sufficient data
        if (groups.length === 0 || groups.some(group => group.length === 0)) {
          return {
            success: false,
            error: 'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
          }
        }

        // Check minimum sample size per group
        const minGroupSize = Math.min(...groups.map(group => group.length))
        if (minGroupSize < 2) {
          return {
            success: false,
            error: `Insufficient sample size in at least one group: minimum ${minGroupSize} observations. Each group requires at least 2 observations.`,
          }
        }
      }

      // Build Python payload (same structure for both formats)
      // Note: group_labels must be in parameters (metadata) for Python to receive them
      // Backend router must forward this (currently frozen - requires approval to fix)
      const variableName = longFormat
        ? columns[longFormat.numericIndex]?.columnName
        : 'Observation'
      const payload = {
        test: 'one_way_anova',
        data: {
          groups,
          // Keep group_names in data for backward compatibility
          group_names: groupNames,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
          // Send group_labels in parameters so backend can forward to Python metadata
          // Python expects: group_labels in **metadata (parametric.py line 345)
          // Backend needs fix to forward: stats_backend.py line 151
          group_labels: groupNames,
          // Post-hoc adjustment method selection (Phase 2)
          // Options: tukey (default), bonferroni, holm, holm-sidak, sidak, dunnett
          posthoc_adjustment:
            mapping?.posthoc_adjustment ?? parameters.posthoc_adjustment ?? 'tukey',
          posthoc_q:
            (mapping?.posthoc_adjustment ?? parameters.posthoc_adjustment) === 'fdr_bh'
              ? (mapping?.posthoc_q ?? parameters.posthoc_q ?? 0.05)
              : undefined,
          // Control level for Dunnett (required when posthoc_adjustment='dunnett')
          control_level: mapping?.control_level ?? parameters.control_level,
        },
        metadata: {
          variable_name: variableName,
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
   * Default parameters for One-Way ANOVA
   *
   * @returns Default alpha level and post-hoc settings
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      // Post-hoc adjustment method: tukey, bonferroni, holm, holm-sidak, sidak, dunnett
      posthoc_adjustment: 'tukey',
      // Control level for Dunnett (null = not set, required when using dunnett)
      control_level: null,
      // FDR q-value (only used when posthoc_adjustment='fdr_bh')
      posthoc_q: 0.05,
    }
  },
}
