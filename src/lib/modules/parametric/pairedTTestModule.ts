/**
 * Paired Samples T-Test Module
 *
 * Ported from Avalonia:
 * - TestValidator.cs::ValidateForTest() - uses same validation as Independent T-Test (line 722)
 *
 * Phase 3 Implementation:
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
 * Paired Samples T-Test Module
 *
 * Compares means of two matched/paired samples (e.g., before/after measurements).
 *
 * Supported formats:
 * - Long format: 1 numeric column + 1 categorical/binary column (exactly 2 values)
 * - Wide format: 2 numeric columns (each row is a paired observation)
 *
 * Example:
 *   Blood_Pressure | Time
 *   ---------------|------
 *   120            | Pre
 *   145            | Pre
 *   110            | Post
 *   125            | Post
 *
 * Requirements:
 * - Exactly 2 columns
 * - Long format: categorical column must have exactly 2 unique values
 * - Wide format: both columns numeric
 * - Both groups must have equal n (validated during payload build)
 *
 * Warnings:
 * - Ordinal data generates warning (suggests Wilcoxon Signed-Rank instead)
 */
export const pairedTTestModule: ITestModule = {
  moduleId: 'paired_ttest',

  /**
   * Validate column selection for Paired Samples T-Test
   *
   * Supports long and wide formats.
   *
   * Validation Rules:
   * 1. Exactly 2 columns required
   * 2. One must be numeric, one must be categorical/binary
   * 3. Categorical column must have exactly 2 unique values
   * 4. Ordinal data generates warning (suggests Wilcoxon)
   * 5. Note: Equal sample sizes validated during payload building
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count first
    if (columns.length !== 2) {
      return {
        isValid: false,
        errors: [`Paired Samples T-Test requires exactly 2 columns. Selected: ${columns.length}.`],
        warnings: [],
        suggestions: [
          'Select 1 numeric column (dependent variable) and 1 categorical column (time/condition with 2 values).',
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
          `Paired Samples T-Test requires either (1 numeric + 1 categorical) or (2 numeric) columns. Found: ${numericCount} numeric, ${categoricalCount} categorical.`,
        ],
        warnings: [],
        suggestions: [
          'Long format: select 1 numeric column (what you\'re measuring) and 1 categorical/binary column (time/condition).',
          'Wide format: select 2 numeric columns (e.g., Pre and Post).',
        ],
      }
    }

    const warnings: string[] = []
    const suggestions: string[] = []

    if (isWideFormat) {
      suggestions.push('✓ Wide format detected: pairing by row order across two numeric columns.')

      const hasOrdinal = numericColumns.some((col) => col.isOrdinal)
      if (hasOrdinal) {
        warnings.push(
          'Numeric columns appear to be ordinal (Likert scale). Paired Samples T-Test assumes continuous interval/ratio data.'
        )
        suggestions.push('Consider using Wilcoxon Signed-Rank Test for ordinal data.')
      }

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
        errors: ['Paired Samples T-Test requires long or wide format inputs.'],
        warnings: [],
        suggestions: [],
      }
    }

    // Long format detected - now validate group count

    // Add high cardinality warning if present
    if (longFormat.warning) {
      warnings.push(longFormat.warning)
    }

    // Check exactly 2 groups (paired t-test requirement)
    if (longFormat.groupCount !== 2) {
      return {
        isValid: false,
        errors: [
          `Paired Samples T-Test requires exactly 2 time points. Categorical column has ${longFormat.groupCount} unique values.`,
        ],
        warnings: [],
        suggestions: [
          longFormat.groupCount < 2
            ? 'The time/condition column must have exactly 2 distinct values (e.g., Pre/Post, Before/After).'
            : `For ${longFormat.groupCount} time points, use Repeated Measures ANOVA instead.`,
        ],
      }
    }

    // Success - add confirmation message
    suggestions.push(
      `✓ Long format detected: 2 time points identified. Equal sample sizes will be validated.`
    )

    // Check for ordinal data (suggest Wilcoxon)
    const numericCol = columns[longFormat.numericIndex]!
    if (numericCol.isOrdinal) {
      warnings.push(
        'Numeric column appears to be ordinal (Likert scale). Paired Samples T-Test assumes continuous interval/ratio data.'
      )
      suggestions.push('Consider using Wilcoxon Signed-Rank Test for ordinal data.')
    }

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Paired Samples T-Test
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
          error: 'Paired Samples T-Test requires exactly 2 columns',
        }
      }

      const isNumericColumn = (col: ColumnClassification) =>
        col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal

      const numericIndices = columns
        .map((col, index) => ({ col, index }))
        .filter(({ col }) => isNumericColumn(col))

      const isWideFormat = numericIndices.length === 2 && columns.length === 2

      // Check for explicit column mapping from the dialog
      const mapping = (parameters.paired_ttest_mapping ?? parameters.pairedTtestMapping) as
        | { group?: string | null; outcome?: string | null; pair_id?: string | null }
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
      let pairIdColIndex: number | null = null
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
            error: 'Paired Samples T-Test requires two numeric columns in wide format.',
          }
        }

        const aligned = ColumnDataExtractor.extractAlignedData([col1Index, col2Index], rows)
        const group1Data = aligned.data[0] ?? []
        const group2Data = aligned.data[1] ?? []

        if (group1Data.length === 0 || group2Data.length === 0) {
          return {
            success: false,
            error: 'No valid data in at least one column after removing missing values.',
          }
        }

        if (group1Data.length < 2) {
          return {
            success: false,
            error: `Insufficient sample size: ${group1Data.length} pairs. Minimum 2 pairs required.`,
          }
        }

        const payload = {
          test: 'paired_ttest',
          data: {
            group1: group1Data,
            group2: group2Data,
            group1_name: col1.columnName,
            group2_name: col2.columnName,
          },
          parameters: {
            alpha: parameters.alpha ?? 0.05,
          },
          metadata: {
            format: 'wide',
            variable_name: col1.columnName,
            pairing: 'row_order',
            warnings: [
              'Wide format pairs rows by position. Ensure each row represents a matched pair.',
            ],
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
        const pairIdx = findColumnIndex(mapping.pair_id)
        const groupCol = findColumn(mapping.group)
        const outcomeCol = findColumn(mapping.outcome)

        if (groupIdx === null || outcomeIdx === null || !groupCol || !outcomeCol) {
          return {
            success: false,
            error: 'Time/Condition or Outcome column not found in selection.',
          }
        }

        categoricalColIndex = groupIdx
        numericColIndex = outcomeIdx
        pairIdColIndex = pairIdx
        categoricalColumn = groupCol
        numericColumn = outcomeCol
      } else {
        // Fall back to auto-detection
        const longFormat = TestValidator.detectLongFormat(columns)

        if (!longFormat) {
          return {
            success: false,
            error: 'Paired Samples T-Test requires 1 numeric column and 1 categorical column.',
          }
        }

        numericColIndex = selectedColumnIndices[longFormat.numericIndex]!
        categoricalColIndex = selectedColumnIndices[longFormat.categoricalIndex]!
        numericColumn = columns[longFormat.numericIndex]!
        categoricalColumn = columns[longFormat.categoricalIndex]!
      }

      const result =
        pairIdColIndex !== null
          ? ColumnDataExtractor.buildPairedGroupsFromLongFormat(
              numericColIndex,
              categoricalColIndex,
              pairIdColIndex,
              rows
            )
          : ColumnDataExtractor.buildPairedGroupsFromLongFormatByOrder(
              numericColIndex,
              categoricalColIndex,
              rows
            )

      // Validate exactly 2 groups
      if (result.groups.length !== 2) {
        return {
          success: false,
          error: `Paired Samples T-Test requires exactly 2 time points. Found ${result.groups.length} groups: ${result.groupNames.join(', ')}`,
        }
      }

      const group1Data = result.groups[0]!
      const group2Data = result.groups[1]!
      const group1Name = result.groupNames[0]!
      const group2Name = result.groupNames[1]!

      // Variable name is the dependent (numeric) column name
      const variableName = numericColumn.columnName
      const timeVariable = categoricalColumn.columnName

      // Validate data
      if (group1Data.length === 0 || group2Data.length === 0) {
        return {
          success: false,
          error: 'No valid data in at least one time point after removing missing values.',
        }
      }

      // CRITICAL: Paired t-test requires EQUAL sample sizes
      if (group1Data.length !== group2Data.length) {
        return {
          success: false,
          error: `Paired Samples T-Test requires equal sample sizes. Found: ${group1Name} (n=${group1Data.length}), ${group2Name} (n=${group2Data.length}). Ensure each subject has data for both time points.`,
        }
      }

      if (group1Data.length < 2) {
        return {
          success: false,
          error: `Insufficient sample size: ${group1Data.length} pairs. Minimum 2 pairs required.`,
        }
      }

      // Build Python payload
      const rowOrderWarning =
        pairIdColIndex === null
          ? [
              'Pair/Subject ID not provided. Pairing uses row order within each time point; ensure data are aligned.',
            ]
          : undefined

      const payload = {
        test: 'paired_ttest',
        data: {
          group1: group1Data,
          group2: group2Data,
          group1_name: group1Name,
          group2_name: group2Name,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
        metadata: {
          format: 'long',
          variable_name: variableName,
          time_variable: timeVariable,
          pairing: pairIdColIndex !== null ? 'subject_id' : 'row_order',
          warnings: rowOrderWarning,
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
   * Default parameters for Paired Samples T-Test
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
