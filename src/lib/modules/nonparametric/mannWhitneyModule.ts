/**
 * Mann-Whitney U Test Module
 *
 * Ported from Avalonia:
 * - TestValidator.cs::ValidateForTest() - line 755-756 (uses same validation as t-test)
 * - MannWhitneyModule.cs (Phase 0: validation only, payload building deferred)
 *
 * Phase 3 Implementation:
 * ✅ validateSelection() - uses TestValidator shared helpers
 * ✅ buildPayload() - implemented with buildGroupsFromLongFormat()
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
 * Mann-Whitney U Test Module
 *
 * Non-parametric alternative to Independent T-Test for comparing two independent groups.
 * Does not assume normal distribution - uses rank-based approach.
 *
 * Supported formats:
 * - Long format: 1 numeric column + 1 categorical/binary column (exactly 2 groups)
 * - Wide format: 2 numeric columns (each column is a group)
 *
 * Example:
 *   Satisfaction | Treatment
 *   -------------|----------
 *   4            | Control
 *   5            | Drug
 *   3            | Control
 *   4            | Drug
 *
 * Requirements:
 * - Exactly 2 columns: 1 numeric + 1 categorical/binary
 * - Categorical column must have exactly 2 unique values
 * - Unequal sample sizes are OK (unpaired test)
 *
 * Ideal for:
 * - Ordinal data (Likert scales)
 * - Non-normal distributions
 * - Small sample sizes
 * - Independent groups (unpaired)
 */
export const mannWhitneyModule: ITestModule = {
  moduleId: 'mann_whitney',

  /**
 * Validate column selection for Mann-Whitney U Test
 *
 * Supports long and wide formats.
   *
   * Validation Rules:
   * 1. Exactly 2 columns required
   * 2. One must be numeric, one must be categorical/binary
   * 3. Categorical column must have exactly 2 unique values
   * 4. Ordinal data is ideal (positive suggestion)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count first
    if (columns.length !== 2) {
      return {
        isValid: false,
        errors: [`Mann-Whitney U Test requires exactly 2 columns. Selected: ${columns.length}.`],
        warnings: [],
        suggestions: [
          'Select 1 numeric column (dependent variable) and 1 categorical column (grouping variable with 2 groups).',
        ],
      }
    }

    const numericColumns = columns.filter(
      c => c.dataType === ColumnDataType.Numeric || c.dataType === ColumnDataType.Ordinal
    )
    const categoricalColumns = columns.filter(
      c => c.dataType === ColumnDataType.Categorical || c.dataType === ColumnDataType.Binary
    )

    const isWideFormat = numericColumns.length === 2 && categoricalColumns.length === 0

    // Detect long format (1 numeric + 1 categorical)
    const longFormat = TestValidator.detectLongFormat(columns)

    if (!longFormat && !isWideFormat) {
      // Not long or wide format - provide helpful error
      const numericCount = numericColumns.length
      const categoricalCount = categoricalColumns.length

      return {
        isValid: false,
        errors: [
          `Mann-Whitney U Test requires either (1 numeric + 1 categorical) or (2 numeric) columns. Found: ${numericCount} numeric, ${categoricalCount} categorical.`,
        ],
        warnings: [],
        suggestions: [
          'Long format: select 1 numeric column (what you\'re measuring) and 1 categorical/binary column (group membership).',
          'Wide format: select 2 numeric columns (each column is a group).',
        ],
      }
    }

    const warnings: string[] = []
    const suggestions: string[] = []

    if (isWideFormat) {
      suggestions.push('✓ Wide format detected: two numeric columns treated as independent groups.')
      suggestions.push(
        '✓ Ideal for ordinal data: Mann-Whitney U Test uses ranks and does not assume normality.'
      )

      return {
        isValid: true,
        errors: [],
        warnings,
        suggestions,
      }
    }

    if (!longFormat) {
      return {
        isValid: false,
        errors: ['Mann-Whitney U Test requires long or wide format inputs.'],
        warnings: [],
        suggestions: [],
      }
    }

    // Long format detected - now validate group count

    // Add high cardinality warning if present
    if (longFormat.warning) {
      warnings.push(longFormat.warning)
    }

    // Check exactly 2 groups (Mann-Whitney requirement)
    if (longFormat.groupCount !== 2) {
      return {
        isValid: false,
        errors: [
          `Mann-Whitney U Test requires exactly 2 groups. Categorical column has ${longFormat.groupCount} unique values.`,
        ],
        warnings: [],
        suggestions: [
          longFormat.groupCount < 2
            ? 'The grouping column must have exactly 2 distinct categories.'
            : `For ${longFormat.groupCount} groups, use Kruskal-Wallis Test instead.`,
        ],
      }
    }

    // Success - add confirmation message
    suggestions.push(
      `✓ Long format detected: 2 groups identified from categorical column.`
    )

    // Mann-Whitney-specific: Add positive suggestion for ordinal data
    const numericCol = columns[longFormat.numericIndex]!
    if (numericCol.isOrdinal) {
      suggestions.push(
        '✓ Ideal for ordinal data: Mann-Whitney U Test uses ranks and does not assume normality.'
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
   * Build Python payload for Mann-Whitney U Test
   *
   * Supports long and wide formats.
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
      if (columns.length !== 2 || selectedColumnIndices.length !== 2) {
        return {
          success: false,
          error: 'Mann-Whitney U Test requires exactly 2 columns',
        }
      }

      const isNumericColumn = (col: ColumnClassification) =>
        col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal

      const numericIndices = columns
        .map((col, index) => ({ col, index }))
        .filter(({ col }) => isNumericColumn(col))

      const isWideFormat = numericIndices.length === 2 && columns.length === 2

      // Check for explicit column mapping from the dialog
      const mapping = (parameters.mann_whitney_mapping ??
        parameters.mannWhitneyMapping ??
        parameters.ttest_mapping ??
        parameters.ttestMapping) as
        | { group?: string | null; outcome?: string | null }
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

      let numericColIndex: number
      let categoricalColIndex: number
      let numericColumn: ColumnClassification
      let categoricalColumn: ColumnClassification

      if (isWideFormat) {
        const wideGroupIdx = mapping?.group ? findColumnIndex(mapping.group) : null
        const wideOutcomeIdx = mapping?.outcome ? findColumnIndex(mapping.outcome) : null
        const wideGroupCol = mapping?.group ? findColumn(mapping.group) : null
        const wideOutcomeCol = mapping?.outcome ? findColumn(mapping.outcome) : null

        const firstNumeric = numericIndices[0]
        const secondNumeric = numericIndices[1]

        const col1Index = wideGroupIdx ?? selectedColumnIndices[firstNumeric!.index]!
        const col2Index = wideOutcomeIdx ?? selectedColumnIndices[secondNumeric!.index]!
        const col1 = wideGroupCol ?? firstNumeric!.col
        const col2 = wideOutcomeCol ?? secondNumeric!.col

        if (col1Index === null || col2Index === null || !col1 || !col2) {
          return {
            success: false,
            error: 'Mann-Whitney U Test requires two numeric columns in wide format.',
          }
        }

        const col1Data = ColumnDataExtractor.extractNumericDataWithTracking(col1Index, rows).data
        const col2Data = ColumnDataExtractor.extractNumericDataWithTracking(col2Index, rows).data

        if (col1Data.length === 0 || col2Data.length === 0) {
          return {
            success: false,
            error: 'No valid data in at least one column after removing missing values.',
          }
        }

        if (col1Data.length < 2 || col2Data.length < 2) {
          return {
            success: false,
            error: `Insufficient sample size. ${col1.columnName}: ${col1Data.length}, ${col2.columnName}: ${col2Data.length}. Minimum 2 observations per group required.`,
          }
        }

        const payload = {
          test: 'mann_whitney',
          data: {
            data1: col1Data,
            data2: col2Data,
            group_name1: col1.columnName,
            group_name2: col2.columnName,
          },
          parameters: {
            alpha: parameters.alpha ?? 0.05,
          },
          metadata: {
            format: 'wide',
            variable_name: 'Value',
            grouping_variable: 'Group',
          },
        }

        return {
          success: true,
          payload,
        }
      }

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
        categoricalColumn = groupCol
        numericColumn = outcomeCol
      } else {
        // Fall back to auto-detection
        const longFormat = TestValidator.detectLongFormat(columns)

        if (!longFormat) {
          return {
            success: false,
            error: 'Mann-Whitney U Test requires 1 numeric column and 1 categorical column.',
          }
        }

        numericColIndex = selectedColumnIndices[longFormat.numericIndex]!
        categoricalColIndex = selectedColumnIndices[longFormat.categoricalIndex]!
        numericColumn = columns[longFormat.numericIndex]!
        categoricalColumn = columns[longFormat.categoricalIndex]!
      }

      const result = ColumnDataExtractor.buildGroupsFromLongFormatPreserveOrder(
        numericColIndex,
        categoricalColIndex,
        rows
      )

      // Validate exactly 2 groups
      if (result.groups.length !== 2) {
        return {
          success: false,
          error: `Mann-Whitney U Test requires exactly 2 groups. Found ${result.groups.length} groups: ${result.groupNames.join(', ')}`,
        }
      }

      const group1Data = result.groups[0]!
      const group2Data = result.groups[1]!
      const group1Name = result.groupNames[0]!
      const group2Name = result.groupNames[1]!

      // Variable name is the dependent (numeric) column name
      const variableName = numericColumn.columnName
      const groupingVariable = categoricalColumn.columnName

      // Validate data
      if (group1Data.length === 0 || group2Data.length === 0) {
        return {
          success: false,
          error: 'No valid data in at least one group after removing missing values.',
        }
      }

      if (group1Data.length < 2 || group2Data.length < 2) {
        return {
          success: false,
          error: `Insufficient sample size. ${group1Name}: ${group1Data.length}, ${group2Name}: ${group2Data.length}. Minimum 2 observations per group required.`,
        }
      }

      // Build Python payload (backend expects data1/data2)
      const payload = {
        test: 'mann_whitney',
        data: {
          data1: group1Data,
          data2: group2Data,
          group_name1: group1Name,
          group_name2: group2Name,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
        metadata: {
          format: 'long',
          variable_name: variableName,
          grouping_variable: groupingVariable,
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
   * Default parameters for Mann-Whitney U Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
