/**
 * Nelson-Aalen Cumulative Hazard Module
 *
 * Phase 4 Implementation:
 * ✅ validateSelection() - validates time + event + optional group
 * ✅ buildPayload() - uses extractSurvivalData helper
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 *
 * Nelson-Aalen Estimator:
 * - Non-parametric method for estimating cumulative hazard function
 * - Alternative to Kaplan-Meier (focuses on hazard rather than survival)
 * - Useful for understanding hazard rate over time
 * - Handles censored data
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


/**
 * Nelson-Aalen Module
 *
 * Estimates cumulative hazard function from time-to-event data.
 * The cumulative hazard H(t) represents the accumulated risk up to time t.
 *
 * Requirements:
 * - Minimum 2 columns: time-to-event (numeric) + event indicator (binary)
 * - Optional 3rd column: grouping variable (categorical) for comparison
 * - Time must be non-negative
 * - Event must be binary (2 unique values). Non-numeric labels are allowed and will be mapped.
 *
 * Outputs:
 * - Cumulative hazard curves (time points, H(t), CI)
 * - Can be transformed to survival: S(t) = exp(-H(t))
 * - Group comparison tests (if groups provided)
 *
 * Comparison with Kaplan-Meier:
 * - KM directly estimates survival S(t)
 * - Nelson-Aalen estimates cumulative hazard H(t)
 * - Both provide equivalent information: S(t) = exp(-H(t))
 * - Nelson-Aalen may have better properties for small samples
 *
 * Use Cases:
 * - Reliability analysis: cumulative failure rate
 * - Epidemiology: cumulative incidence
 * - When hazard interpretation is more natural than survival
 */
export const nelsonAalenModule: ITestModule = {
  moduleId: 'nelson_aalen',

  /**
   * Validate column selection for Nelson-Aalen
   *
   * Validation Rules:
   * 1. Minimum 2 columns required (time + event)
   * 2. Optional 3rd column for grouping
   * 3. Time column must be numeric
   * 4. Event column must be binary (2 unique values)
   * 5. Group column (if provided) must be categorical
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count
    if (columns.length < 2) {
      return {
        isValid: false,
        errors: [
          `Nelson-Aalen requires at least 2 columns (time + event). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 2 columns:',
          '  1. Time-to-event (numeric, non-negative)',
          '  2. Event indicator (binary: 0=censored, 1=event)',
          'Optional 3rd column: Group (categorical) for comparing cumulative hazard',
        ],
      }
    }

    if (columns.length > 3) {
      return {
        isValid: false,
        errors: [
          `Nelson-Aalen accepts at most 3 columns (time + event + group). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select 2-3 columns only.',
          'For multiple covariates, use Cox Regression instead.',
        ],
      }
    }

    const timeCol = columns[0]!
    const eventCol = columns[1]!
    const groupCol = columns.length === 3 ? columns[2] : undefined

    // Validate time column
    if (timeCol.dataType !== ColumnDataType.Numeric) {
      return {
        isValid: false,
        errors: [
          `Time column '${timeCol.columnName}' must be numeric (found: ${timeCol.dataType}).`,
        ],
        warnings: [],
        suggestions: ['Time-to-event should be a positive numeric value.'],
      }
    }

    // Validate event column
    if (eventCol.uniqueValueCount !== 2) {
      return {
        isValid: false,
        errors: [
          `Event column '${eventCol.columnName}' must be binary with exactly 2 values (0=censored, 1=event). Found ${eventCol.uniqueValueCount} unique values.`,
        ],
        warnings: [],
        suggestions: [
          'Event indicator should be coded as:',
          '  • 0 = censored (no event)',
          '  • 1 = event occurred',
          'If values are not 0/1 or true/false, you will be prompted to map event vs censored.',
        ],
      }
    }

    // Validate optional group column
    if (groupCol) {
      if (
        groupCol.dataType !== ColumnDataType.Categorical &&
        groupCol.dataType !== ColumnDataType.Binary
      ) {
        return {
          isValid: false,
          errors: [
            `Group column '${groupCol.columnName}' must be categorical (found: ${groupCol.dataType}).`,
          ],
          warnings: [],
          suggestions: [
            'Group column should contain category labels for comparing cumulative hazard.',
          ],
        }
      }

      if (groupCol.uniqueValueCount < 2) {
        return {
          isValid: false,
          errors: [
            `Group column '${groupCol.columnName}' has only ${groupCol.uniqueValueCount} level. Need at least 2 groups for comparison.`,
          ],
          warnings: [],
          suggestions: [],
        }
      }

      if (groupCol.uniqueValueCount > 10) {
        return {
          isValid: false,
          errors: [
            `Group column '${groupCol.columnName}' has too many levels (${groupCol.uniqueValueCount}). Maximum 10 groups allowed.`,
          ],
          warnings: [],
          suggestions: [
            'For many categorical variables, use Cox Regression with covariates instead.',
          ],
        }
      }
    }

    const suggestions: string[] = []
    const warnings: string[] = []

    if (groupCol) {
      suggestions.push(
        `Nelson-Aalen with ${groupCol.uniqueValueCount} groups: Cumulative hazard curves will be compared.`
      )
    } else {
      suggestions.push(
        `Single-group Nelson-Aalen: Will estimate overall cumulative hazard function.`
      )
    }

    suggestions.push(
      `Cumulative hazard H(t) represents accumulated risk. Related to survival by S(t) = exp(-H(t)).`
    )

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Nelson-Aalen
   *
   * Extracts aligned time, event, and optional group data.
   * Ensures event is binary (2 values) and normalized to 0/1.
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
          error: 'Nelson-Aalen requires at least 2 columns (time + event)',
        }
      }

      const timeIndex = selectedColumnIndices[0]!
      const eventIndex = selectedColumnIndices[1]!
      const groupIndex = columns.length === 3 ? selectedColumnIndices[2] : undefined
      const groupColumn = columns.length === 3 ? columns[2] : undefined

      const eventEncoding = parameters.event_encoding as
        | { eventValue: string; censoredValue: string; wasEncoded?: boolean }
        | undefined

      // Extract survival data
      const result = ColumnDataExtractor.extractSurvivalData(
        timeIndex,
        eventIndex,
        rows,
        groupIndex,
        undefined, // No covariates for Nelson-Aalen
        groupColumn,
        undefined,
        eventEncoding ? { eventValue: eventEncoding.eventValue, censoredValue: eventEncoding.censoredValue } : undefined,
        undefined
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
      if (result.summary.validRows < 10) {
        return {
          success: false,
          error: `Insufficient sample size: ${result.summary.validRows} observations. Nelson-Aalen requires at least 10 observations.`,
        }
      }

      // Check that at least some events occurred
      if (result.summary.nEvents === 0) {
        return {
          success: false,
          error: `No events observed in data. All ${result.summary.validRows} observations are censored. Cannot estimate cumulative hazard.`,
        }
      }

      // Build Python payload
      const payload = {
        test: 'nelson_aalen',
        data: {
          times: result.times,
          events: result.events,
          time_name: columns[0]!.columnName,
          event_name: columns[1]!.columnName,
          groups: result.groups,
          group_name: result.groups ? columns[2]!.columnName : undefined,
          group_levels: result.groupLevels,
          custom_time_points: parameters.custom_time_points ?? [],
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
          ...(eventEncoding ? { event_encoding: eventEncoding } : {}),
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
   * Default parameters for Nelson-Aalen
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
