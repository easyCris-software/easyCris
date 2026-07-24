/**
 * 3-Parameter Logistic (3PL) Dose-Response Module
 *
 * Fits a 3-parameter logistic curve to dose-response data.
 * The bottom parameter is fixed (not fitted). By default:
 * - If dose=0 controls are present, uses their mean as the fixed bottom
 * - Otherwise defaults to 0.0
 * - User can override with an explicit bottom_fixed value
 *
 * Model: response = bottom + (top - bottom) / (1 + (dose/IC50)^hill)
 *
 * Requirements:
 * - Exactly 2 numeric columns (dose, response)
 * - All doses must be ≥ 0 (0 allowed as control, negatives not allowed)
 * - Minimum 4 positive dose levels (controls at dose=0 don't count)
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import { TestValidator } from '../core/TestValidator'

/**
 * 3PL Dose-Response Module
 */
export const doseResponse3plModule: ITestModule = {
  moduleId: 'dose_response_3pl',

  /**
   * Validate column selection for 3PL Dose-Response
   *
   * Validation Rules:
   * 1. Exactly 2 columns required (dose, response)
   * 2. Both columns must be numeric
   * 3. Minimum sample size warning if < 4 points
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count
    const countResult = TestValidator.checkColumnCount(columns, 2, '3PL Dose-Response')
    if (countResult) return countResult

    // Check both columns are numeric
    const numericResult = TestValidator.checkAllNumeric(columns, '3PL Dose-Response')
    if (numericResult) return numericResult

    // Check for ordinal warning
    const ordinalResult = TestValidator.checkOrdinalWarning(
      columns,
      '3PL Dose-Response',
      false // No nonparametric alternative for dose-response
    )

    // Check minimum sample size
    // ColumnClassification.totalValues is already non-missing (see ColumnDataExtractor),
    // so do NOT subtract missingValues (that double-counts and can go negative).
    const minN = Math.min(columns[0]!.totalValues, columns[1]!.totalValues)

    const warnings: string[] = []
    const suggestions: string[] = []

    if (minN < 4) {
      return {
        isValid: false,
        errors: [`Insufficient data: ${minN} points. 3PL Dose-Response requires at least 4 data points.`],
        warnings: [],
        suggestions: ['Add more dose-response measurements'],
      }
    }

    if (minN < 6) {
      warnings.push(`Small sample size (${minN} points) may result in unreliable parameter estimates.`)
      suggestions.push('Consider collecting more data points for robust curve fitting.')
    }

    // Combine with ordinal warnings if any
    if (ordinalResult) {
      warnings.push(...ordinalResult.warnings)
      suggestions.push(...ordinalResult.suggestions)
    }

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for 3PL Dose-Response
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices [dose, response]
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, bottom_fixed)
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
          error: '3PL Dose-Response requires exactly 2 columns (dose, response)',
        }
      }

      // Extract and align dose/response data (removes rows with missing values)
      const alignedData = alignDoseResponseData(
        selectedColumnIndices[0]!,
        selectedColumnIndices[1]!,
        rows
      )

      if (alignedData.doses.length === 0) {
        return {
          success: false,
          error: 'No valid data after removing missing values.',
        }
      }

      if (alignedData.doses.length < 4) {
        return {
          success: false,
          error: `Insufficient sample size: ${alignedData.doses.length} points. Minimum 4 required.`,
        }
      }

      // Validate doses are non-negative (0 allowed as control; negatives not allowed)
      const negativeDoses = alignedData.doses.filter(d => d < 0)
      if (negativeDoses.length > 0) {
        return {
          success: false,
          error: `Dose values must be ≥ 0. Found ${negativeDoses.length} negative values.`,
        }
      }

      // Count positive doses (controls at dose=0 don't count toward minimum)
      // Python uses ZERO_DOSE_TOLERANCE = 1e-15 for numerical stability
      const ZERO_DOSE_TOLERANCE = 1e-15
      const positiveDoses = alignedData.doses.filter(d => d >= ZERO_DOSE_TOLERANCE)
      const controlDoses = alignedData.doses.filter(d => d < ZERO_DOSE_TOLERANCE)

      const MIN_POSITIVE_3PL = 4
      if (positiveDoses.length < MIN_POSITIVE_3PL) {
        return {
          success: false,
          error: `Need at least ${MIN_POSITIVE_3PL} positive dose levels (dose > 0). ` +
            `Found ${positiveDoses.length}. Controls (dose=0) don't count toward minimum.` +
            (controlDoses.length > 0 ? ` You have ${controlDoses.length} control point(s).` : ''),
        }
      }

      // Build Python payload
      // Only include bottom_fixed when user explicitly set a value
      // If omitted, Python will use control_mean (if controls present) or 0.0
      const payloadParams: Record<string, any> = {
        alpha: parameters.alpha ?? 0.05,
      }
      if (parameters.bottom_fixed !== null && parameters.bottom_fixed !== undefined) {
        payloadParams.bottom_fixed = parameters.bottom_fixed
      }

      const payload = {
        test: 'dose_response_3pl',
        data: {
          doses: alignedData.doses,
          responses: alignedData.responses,
          dose_column: columns[0]!.columnName,
          response_column: columns[1]!.columnName,
          fitting_method: parameters.fitting_method ?? 'log_dose',
        },
        parameters: payloadParams,
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
   * Default parameters for 3PL Dose-Response
   *
   * bottom_fixed: null means Python will auto-detect:
   * - Use control_mean if dose=0 controls are present
   * - Otherwise use 0.0
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      bottom_fixed: null,
      fitting_method: 'log_dose',
    }
  },
}

/**
 * Helper: Align dose and response arrays, removing rows with missing values
 */
function alignDoseResponseData(
  doseColumnIndex: number,
  responseColumnIndex: number,
  rows: any[]
): { doses: number[]; responses: number[] } {
  const doses: number[] = []
  const responses: number[] = []

  for (const row of rows) {
    const doseVal = row[doseColumnIndex]
    const respVal = row[responseColumnIndex]

    // Skip if either value is missing
    if (doseVal === null || doseVal === undefined || doseVal === '') continue
    if (respVal === null || respVal === undefined || respVal === '') continue

    const doseNum = typeof doseVal === 'number' ? doseVal : parseFloat(String(doseVal))
    const respNum = typeof respVal === 'number' ? respVal : parseFloat(String(respVal))

    // Skip if either fails to parse
    if (isNaN(doseNum) || isNaN(respNum)) continue

    doses.push(doseNum)
    responses.push(respNum)
  }

  return { doses, responses }
}
