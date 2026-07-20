/**
 * Multifactorial ANOVA Module
 *
 * Phase 3 Batch 6 Implementation:
 * ✅ validateSelection() - validates 1 numeric DV + 3+ categorical factors
 * ✅ buildPayload() - uses extractDependentAndFactors helper
 * ✅ defaultParameters() - returns { alpha: 0.05, max_depth: 3 }
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
 * Multifactorial ANOVA Module
 *
 * Analysis of Variance for examining the effects of three or more independent
 * categorical factors and their interactions on a continuous dependent variable.
 *
 * Requirements:
 * - Minimum 4 columns required:
 *   1. Dependent variable (numeric/continuous)
 *   2-N. Factors (categorical with 2+ levels each)
 *
 * Tests Multiple Effects:
 * - Main effects for each factor
 * - Two-way interactions (e.g., Factor1 × Factor2)
 * - Three-way interactions (e.g., Factor1 × Factor2 × Factor3)
 * - Higher-order interactions (configurable via max_interaction_depth)
 *
 * Assumptions:
 * - Independence of observations
 * - Normality within each cell (factor combination)
 * - Homogeneity of variances across cells (Levene's test performed)
 * - Balanced or unbalanced design supported
 *
 * Interpretation:
 * - Significant main effect: Factor affects the dependent variable
 * - Significant interaction: Effect of factors depends on other factors
 * - Higher-order interactions are often difficult to interpret
 * - Use max_interaction_depth parameter to limit complexity
 *
 * Practical Considerations:
 * - With N factors, there are 2^N - 1 possible effects to test
 * - 3 factors = 7 effects (3 main + 3 two-way + 1 three-way)
 * - 4 factors = 15 effects (4 main + 6 two-way + 4 three-way + 1 four-way)
 * - Cell counts can become very small with many factors
 */
export const multifactorialAnovaModule: ITestModule = {
  moduleId: 'multifactorial_anova',

  /**
   * Validate column selection for Multifactorial ANOVA
   *
   * Validation Rules:
   * 1. Minimum 4 columns required (DV + 3+ factors)
 * 2. Requires at least one numeric/ordinal dependent variable
 * 3. Requires 3+ categorical factors (order independent)
   * 4. Each factor must have at least 2 levels
   * 5. Warn about design complexity
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    const emptyColumns = columns.filter(col => col.dataType === ColumnDataType.Empty)
    if (emptyColumns.length > 0) {
      return {
        isValid: false,
        errors: emptyColumns.map(
          col => `Column '${col.columnName}' has no data. Remove empty columns from the selection.`
        ),
        warnings: [],
        suggestions: ['Select columns with actual data for multifactorial ANOVA.'],
      }
    }

    // Check minimum column count
    if (columns.length < 4) {
      return {
        isValid: false,
        errors: [
          `Multifactorial ANOVA requires at least 4 columns (1 DV + 3+ factors). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 4 columns:',
          '  1. Dependent variable (numeric/ordinal)',
          '  2-N. Factor variables (categorical, 3 or more)',
          'For 2 factors, use Two-Way ANOVA instead.',
        ],
      }
    }

    const dvCandidates = columns.filter((col) => {
      if (col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal) {
        return true
      }
      // Allow numeric-coded binaries as DV (all values numeric)
      if (
        col.dataType === ColumnDataType.Binary &&
        typeof col.numericValues === 'number' &&
        col.numericValues ===
          Math.max(
            0,
            ((col.numericValues ?? 0) + (col.categoricalValues ?? 0)) ||
              ((col.totalValues ?? 0) - (col.missingValues ?? 0))
          )
      ) {
        return true
      }
      // Allow mixed columns that are mostly numeric (fallback for messy data)
      if (
        col.dataType === ColumnDataType.Mixed &&
        (col.numericRatio ?? 0) >= TYPE_CLASSIFICATION_RULES.mixedRatioForNumericFallback
      ) {
        return true
      }
      return false
    })
    const factorCandidates = columns.filter(
      col =>
        col.dataType === ColumnDataType.Categorical ||
        col.dataType === ColumnDataType.Binary
    )
    const invalidColumns = columns.filter(
      col => !dvCandidates.includes(col) && !factorCandidates.includes(col)
    )

    if (dvCandidates.length === 0) {
      return {
        isValid: false,
        errors: ['Multifactorial ANOVA requires at least one numeric/ordinal dependent variable.'],
        warnings: [],
        suggestions: ['Select a numeric or ordinal column to use as the dependent variable.'],
      }
    }

    if (invalidColumns.length > 0) {
      return {
        isValid: false,
        errors: invalidColumns.map(
          col => `Column '${col.columnName}' must be numeric/ordinal (DV) or categorical/binary (factor). Found: ${col.dataType}.`
        ),
        warnings: [],
        suggestions: ['Remove columns that are mixed or incompatible with ANOVA.'],
      }
    }

    if (factorCandidates.length < 3) {
      return {
        isValid: false,
        errors: [
          `Multifactorial ANOVA requires at least 3 categorical factors. Found: ${factorCandidates.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 3 categorical or binary factor columns.',
          'For 2 factors, use Two-Way ANOVA instead.',
        ],
      }
    }

    for (const factor of factorCandidates) {
      if (factor.uniqueValueCount < 2) {
        return {
          isValid: false,
          errors: [
            `Factor '${factor.columnName}' has only ${factor.uniqueValueCount} level. Each factor requires at least 2 levels.`,
          ],
          warnings: [],
          suggestions: [`Ensure '${factor.columnName}' has at least 2 distinct categories.`],
        }
      }
    }

    // Calculate design complexity
    const numFactors = factorCandidates.length
    const cellCount = factorCandidates.reduce(
      (product, factor) => product * factor.uniqueValueCount,
      1
    )
    const numEffects = Math.pow(2, numFactors) - 1 // Total possible effects

    // Add warnings and suggestions
    const warnings: string[] = []
    const suggestions: string[] = []

    if (dvCandidates.length > 1) {
      warnings.push(
        `Multiple numeric/ordinal columns selected (${dvCandidates.length}). You will be asked to choose the dependent variable.`
      )
    }

    const allDvOrdinal = dvCandidates.every(candidate => candidate.isOrdinal)
    if (allDvOrdinal) {
      warnings.push(
        'All dependent variable candidates appear to be ordinal (Likert scale). Multifactorial ANOVA assumes continuous interval/ratio data.'
      )
    }

    // Warn about complex designs
    if (numFactors > 4) {
      warnings.push(
        `Design has ${numFactors} factors, resulting in ${numEffects} possible effects. Consider reducing the number of factors for interpretability.`
      )
    }

    if (cellCount > 50) {
      warnings.push(
        `Very large design with ${cellCount} cells. Sample size must be sufficient to populate all cells.`
      )
    }

    // Add design information
    const factorLevelCounts = factorCandidates.map(f => f.uniqueValueCount).join(' x ')
    suggestions.push(
      `Design: ${factorLevelCounts} (${numFactors} factors, ${cellCount} cells, up to ${numEffects} effects)`
    )

    suggestions.push(
      `Use max_interaction_depth parameter to limit interaction complexity (default: 3)`
    )

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Multifactorial ANOVA
   *
   * Extracts aligned dependent variable and factor arrays.
   * Factors are sent as a dictionary (Python expects this format).
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, max_depth)
   * @returns Payload for Python backend or error
   */
  buildPayload(
    columns: ColumnClassification[],
    selectedColumnIndices: number[],
    rows: any[],
    parameters: Record<string, any>
  ): BuildPayloadResult {
    try {
      if (columns.length < 4 || selectedColumnIndices.length < 4) {
        return {
          success: false,
          error: 'Multifactorial ANOVA requires at least 4 columns (1 DV + 3+ factors)',
        }
      }

      // Reorder factors based on explicit factor role mapping (if provided)
      // This ensures Primary (x-axis), Secondary (series), and Facets (panels) are correctly ordered
      let orderedColumns = [...columns]
      let orderedIndices = [...selectedColumnIndices]

      const factorMapping = parameters.factor_role_mapping as
        | { primary: string; secondary: string; facets: string[] }
        | undefined

      if (factorMapping) {
        // Find indices of mapped factors
        const primaryIdx = columns.findIndex(
          (col, i) => i > 0 && col.columnId === factorMapping.primary
        )
        const secondaryIdx = columns.findIndex(
          (col, i) => i > 0 && col.columnId === factorMapping.secondary
        )

        // Find facet indices in mapped order
        const facets = Array.isArray(factorMapping.facets) ? factorMapping.facets : []
        const facetIndices: number[] = []
        for (const facetId of facets) {
          const idx = columns.findIndex((col, i) => i > 0 && col.columnId === facetId)
          if (idx > 0) {
            facetIndices.push(idx)
          }
        }

        // Reorder: [DV, Primary, Secondary, ...Facets]
        if (
          primaryIdx > 0 &&
          secondaryIdx > 0 &&
          facetIndices.length === facets.length &&
          facetIndices.length > 0
        ) {
          const facetColumns = facetIndices.map(idx => columns[idx]!)
          const facetColumnIndices = facetIndices.map(idx => selectedColumnIndices[idx]!)

          orderedColumns = [
            columns[0]!,
            columns[primaryIdx]!,
            columns[secondaryIdx]!,
            ...facetColumns,
          ]
          orderedIndices = [
            selectedColumnIndices[0]!,
            selectedColumnIndices[primaryIdx]!,
            selectedColumnIndices[secondaryIdx]!,
            ...facetColumnIndices,
          ]
        }
      }

      const dependentIndex = orderedIndices[0]!
      const factorIndices = orderedIndices.slice(1)
      const factorColumnNames = orderedColumns.slice(1).map(col => col.columnName)

      // Extract aligned data with pairwise deletion
      // Pass actual column names for proper metadata keys
      const result = ColumnDataExtractor.extractDependentAndFactors(
        dependentIndex,
        factorIndices,
        rows,
        factorColumnNames // Actual column names for metadata
      )

      // Validate sufficient data
      if (result.summary.validRows === 0) {
        return {
          success: false,
          error:
            'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      // Check minimum sample size
      // Calculate actual cell count from extracted factor levels (not assumed 2^n)
      const cellCount = Object.values(result.factorLevels).reduce(
        (product, levels) => product * levels.length,
        1
      )
      const minObsPerCell = 1 // Minimum 1 observation per cell
      const minSampleSize = cellCount * minObsPerCell

      if (result.summary.validRows < minSampleSize) {
        return {
          success: false,
          error: `Insufficient sample size: ${result.summary.validRows} observations. Design has ${cellCount} cells, requiring at least ${minSampleSize} observations (${minObsPerCell} per cell).`,
        }
      }

      // Validate cell counts - ensure every factor combination has observations
      // For multifactor designs, this validates the full Cartesian product
      const cellValidation = ColumnDataExtractor.validateFactorialDesignCellCounts(
        result.factors,
        result.factorNames,
        1 // Minimum 1 observation per cell (multifactor designs often have sparse cells)
      )

      if (!cellValidation.isValid) {
        return {
          success: false,
          error: `Empty cells detected in factorial design. ${cellValidation.message}`,
        }
      }

      // Encode categorical factors as integers for Python
      // Python expects integer codes [0, 1, 2, ...], not string labels
      const encodedFactors: Record<string, number[]> = {}
      const factorLevelLabels: Record<string, string[]> = {}

      for (const factorName of factorColumnNames) {
        const factorStrings = result.factors[factorName]!
        const factorLevels = Array.from(result.factorLevels[factorName] || [])

        // Encode strings to integer codes
        encodedFactors[factorName] = factorStrings.map(val => factorLevels.indexOf(val))

        // Store labels as array for Python
        factorLevelLabels[factorName] = factorLevels
      }

      // Encode Dunnett control levels to match integer-encoded factor data.
      // Factor data is encoded as indices (0,1,2...), so control levels must use the same encoding.
      let encodedControlLevels: Record<string, string> | undefined
      if (parameters.control_levels) {
        encodedControlLevels = {}
        for (const [factorName, levelLabel] of Object.entries(parameters.control_levels)) {
          if (!levelLabel) continue
          const levelValue = String(levelLabel)
          const levels = factorLevelLabels[factorName] || []
          const idx = levels.indexOf(levelValue)
          encodedControlLevels[factorName] = idx >= 0 ? String(idx) : levelValue
        }
      }

      // Build Python payload
      // Python expects integer-encoded factors with lookup dict
      const payload = {
        test: 'multifactorial_anova',
        data: {
          dependent: result.dependent,
          factors: encodedFactors, // Integer-encoded: {"Treatment": [0,1,0,1], "Time": [0,1,2,0]}
          dependent_name: orderedColumns[0]!.columnName,
          factor_names: factorColumnNames,
          factor_levels: factorLevelLabels, // Arrays: {"Treatment": ["A","B"], "Time": ["X","Y","Z"]}
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
          max_depth: parameters.max_depth ?? 3, // Max interaction depth
          simple_effects: parameters.simple_effects, // User-selected simple effects from dialog
          posthoc_adjustment: parameters.posthoc_adjustment ?? 'tukey',
          posthoc_q:
            parameters.posthoc_adjustment === 'fdr_bh'
              ? (parameters.posthoc_q ?? 0.05)
              : undefined,
          control_levels: encodedControlLevels ?? parameters.control_levels,
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
   * Default parameters for Multifactorial ANOVA
   *
   * @returns Default alpha level and max interaction depth
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      max_depth: 3, // Limit to 3-way interactions by default
      posthoc_adjustment: 'tukey',
      control_levels: null,
      posthoc_q: 0.05,
    }
  },
}
