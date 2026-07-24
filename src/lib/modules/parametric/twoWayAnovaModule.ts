/**
 * Two-Way ANOVA Module
 *
 * Phase 3 Batch 6 Implementation:
 * ✅ validateSelection() - validates 1 numeric DV + 2 categorical factors
 * ✅ buildPayload() - uses extractDependentAndFactors helper
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
import { TYPE_CLASSIFICATION_RULES } from '@/lib/classification/typeRules'

/**
 * Two-Way ANOVA Module
 *
 * Analysis of Variance for examining the effects of two independent categorical
 * factors and their interaction on a continuous dependent variable.
 *
 * Requirements:
 * - Exactly 3 columns required:
 *   1. Dependent variable (numeric/continuous)
 *   2. Factor 1 (categorical with 2+ levels)
 *   3. Factor 2 (categorical with 2+ levels)
 *
 * Tests Three Effects:
 * 1. Main effect of Factor 1
 * 2. Main effect of Factor 2
 * 3. Interaction effect (Factor 1 × Factor 2)
 *
 * Assumptions:
 * - Independence of observations
 * - Normality within each cell (factor combination)
 * - Homogeneity of variances across cells (Levene's test performed)
 * - Balanced or unbalanced design supported
 *
 * Interpretation:
 * - Significant main effect: Factor affects the dependent variable
 * - Significant interaction: Effect of one factor depends on the other
 * - Post-hoc tests: Use Tukey HSD for pairwise comparisons
 *
 * Non-parametric alternative: Scheirer-Ray-Hare Test
 */
export const twoWayAnovaModule: ITestModule = {
  moduleId: 'two_way_anova',

  /**
   * Validate column selection for Two-Way ANOVA
   *
   * Validation Rules:
   * 1. Exactly 3 columns required (DV + 2 factors)
   * 2. Column 1 must be numeric (dependent variable)
   * 3. Columns 2-3 must be categorical (factors)
   * 4. Each factor must have at least 2 levels
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count
    if (columns.length !== 3) {
      return {
        isValid: false,
        errors: [
          `Two-Way ANOVA requires exactly 3 columns. Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select exactly 3 columns:',
          '  1. Dependent variable (numeric)',
          '  2. Factor 1 (categorical)',
          '  3. Factor 2 (categorical)',
        ],
      }
    }

    const dependent = columns[0]!
    const factor1 = columns[1]!
    const factor2 = columns[2]!

    // Validate dependent variable is numeric (allow mostly-numeric mixed/binary coded)
    const dependentIsNumeric =
      dependent.dataType === ColumnDataType.Numeric ||
      dependent.dataType === ColumnDataType.Ordinal ||
      (dependent.dataType === ColumnDataType.Binary &&
        typeof dependent.numericValues === 'number' &&
        dependent.numericValues ===
          Math.max(
            0,
            ((dependent.numericValues ?? 0) + (dependent.categoricalValues ?? 0)) ||
              ((dependent.totalValues ?? 0) - (dependent.missingValues ?? 0))
          )) ||
      (dependent.dataType === ColumnDataType.Mixed &&
        (dependent.numericRatio ?? 0) >= TYPE_CLASSIFICATION_RULES.mixedRatioForNumericFallback)

    if (!dependentIsNumeric) {
      return {
        isValid: false,
        errors: [
          `Dependent variable '${dependent.columnName}' must be numeric (found: ${dependent.dataType}).`,
        ],
        warnings: [],
        suggestions: [
          'The first column should be your continuous outcome variable.',
          'Select a numeric column for the dependent variable.',
        ],
      }
    }

    // Validate factor 1 is categorical
    if (
      factor1.dataType !== ColumnDataType.Categorical &&
      factor1.dataType !== ColumnDataType.Binary
    ) {
      return {
        isValid: false,
        errors: [
          `Factor 1 '${factor1.columnName}' must be categorical (found: ${factor1.dataType}).`,
        ],
        warnings: [],
        suggestions: [
          'Factor columns should contain group labels (e.g., Treatment A, Treatment B).',
          'Select a categorical column for Factor 1.',
        ],
      }
    }

    // Validate factor 2 is categorical
    if (
      factor2.dataType !== ColumnDataType.Categorical &&
      factor2.dataType !== ColumnDataType.Binary
    ) {
      return {
        isValid: false,
        errors: [
          `Factor 2 '${factor2.columnName}' must be categorical (found: ${factor2.dataType}).`,
        ],
        warnings: [],
        suggestions: [
          'Factor columns should contain group labels (e.g., Male, Female).',
          'Select a categorical column for Factor 2.',
        ],
      }
    }

    // Check minimum levels per factor
    if (factor1.uniqueValueCount < 2) {
      return {
        isValid: false,
        errors: [
          `Factor 1 '${factor1.columnName}' has only ${factor1.uniqueValueCount} level. Each factor requires at least 2 levels.`,
        ],
        warnings: [],
        suggestions: ['Ensure Factor 1 has at least 2 distinct categories.'],
      }
    }

    if (factor2.uniqueValueCount < 2) {
      return {
        isValid: false,
        errors: [
          `Factor 2 '${factor2.columnName}' has only ${factor2.uniqueValueCount} level. Each factor requires at least 2 levels.`,
        ],
        warnings: [],
        suggestions: ['Ensure Factor 2 has at least 2 distinct categories.'],
      }
    }

    // Add ordinal warning for dependent variable
    const warnings: string[] = []
    if (dependent.isOrdinal) {
      warnings.push(
        `Dependent variable '${dependent.columnName}' appears to be ordinal (Likert scale). Two-Way ANOVA assumes continuous interval/ratio data.`
      )
    }

    // Add suggestions about design
    const suggestions: string[] = []
    const cellCount = factor1.uniqueValueCount * factor2.uniqueValueCount
    suggestions.push(
      `Design: ${factor1.uniqueValueCount} × ${factor2.uniqueValueCount} factorial (${cellCount} cells)`
    )

    if (cellCount > 20) {
      warnings.push(
        `Large design with ${cellCount} cells. Consider reducing factor levels or using a different approach.`
      )
    }

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Two-Way ANOVA
   *
   * Extracts aligned dependent variable and factor arrays.
   * Factors are kept as string arrays (Python handles dummy coding).
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
      if (columns.length !== 3 || selectedColumnIndices.length !== 3) {
        return {
          success: false,
          error: 'Two-Way ANOVA requires exactly 3 columns',
        }
      }

      // Reorder factors based on explicit factor role mapping (if provided)
      // This ensures Factor A (primary/x-axis) and Factor B (secondary/grouping) are correctly assigned
      let orderedColumns = [...columns]
      let orderedIndices = [...selectedColumnIndices]

      const factorMapping = parameters.factor_role_mapping as
        | { factorA: string; factorB: string }
        | undefined

      if (factorMapping) {
        // Find indices of mapped factors
        const factorAIdx = columns.findIndex(
          (col, i) => i > 0 && col.columnId === factorMapping.factorA
        )
        const factorBIdx = columns.findIndex(
          (col, i) => i > 0 && col.columnId === factorMapping.factorB
        )

        if (factorAIdx > 0 && factorBIdx > 0) {
          // Reorder: [DV, Factor A, Factor B]
          orderedColumns = [columns[0]!, columns[factorAIdx]!, columns[factorBIdx]!]
          orderedIndices = [
            selectedColumnIndices[0]!,
            selectedColumnIndices[factorAIdx]!,
            selectedColumnIndices[factorBIdx]!,
          ]
        }
      }

      const dependentIndex = orderedIndices[0]!
      const factor1Index = orderedIndices[1]!
      const factor2Index = orderedIndices[2]!

      const factor1Name = orderedColumns[1]!.columnName
      const factor2Name = orderedColumns[2]!.columnName

      // Extract aligned data with pairwise deletion
      // Pass actual column names for proper metadata keys
      const result = ColumnDataExtractor.extractDependentAndFactors(
        dependentIndex,
        [factor1Index, factor2Index],
        rows,
        [factor1Name, factor2Name] // Actual column names for metadata
      )

      // Validate sufficient data
      if (result.summary.validRows === 0) {
        return {
          success: false,
          error:
            'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      // Check minimum sample size (need at least 2 per cell ideally)
      if (result.summary.validRows < 6) {
        return {
          success: false,
          error: `Insufficient sample size: ${result.summary.validRows} observations. Two-Way ANOVA requires sufficient observations per cell (ideally 2+ per cell).`,
        }
      }

      // Validate cell counts - ensure every factor combination has observations
      const cellValidation = ColumnDataExtractor.validateFactorialDesignCellCounts(
        result.factors,
        result.factorNames,
        2 // Minimum 2 observations per cell for reliable ANOVA
      )

      if (!cellValidation.isValid) {
        return {
          success: false,
          error: `Empty cells detected in factorial design. ${cellValidation.message}`,
        }
      }

      // Encode categorical factors as integers for Python
      // Python expects integer codes [0, 1, 2, ...], not string labels
      const factor1Strings = result.factors[factor1Name]!
      const factor2Strings = result.factors[factor2Name]!

      const factor1Levels = Array.from(result.factorLevels[factor1Name] || [])
      const factor2Levels = Array.from(result.factorLevels[factor2Name] || [])

      const factor1Encoded = factor1Strings.map(val => factor1Levels.indexOf(val))
      const factor2Encoded = factor2Strings.map(val => factor2Levels.indexOf(val))

      // Build factor_level_labels for Python
      // Python expects: {"Treatment": ["A", "B"], "Time": ["X", "Y", "Z"]}
      const factorLevelLabels: Record<string, string[]> = {
        [factor1Name]: factor1Levels,
        [factor2Name]: factor2Levels,
      }

      // Build Python payload
      // Python expects integer-encoded factors with lookup dict
      const payload = {
        test: 'two_way_anova',
        data: {
          dependent: result.dependent,
          factor1: factor1Encoded,  // Integer codes [0, 1, 0, 1, ...]
          factor2: factor2Encoded,  // Integer codes [0, 1, 2, 0, 1, 2, ...]
          dependent_name: orderedColumns[0]!.columnName,
          factor1_name: factor1Name,
          factor2_name: factor2Name,
          factor_levels: factorLevelLabels,  // {Treatment: {0: "A", 1: "B"}, Time: {0: "X", 1: "Y", 2: "Z"}}
        },
        parameters: {
          ...parameters,
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
   * Default parameters for Two-Way ANOVA
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      posthoc_adjustment: 'tukey',
      control_levels: null,
      posthoc_q: 0.05,
    }
  },
}
