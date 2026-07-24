/**
 * 5-Parameter Logistic (5PL) Dose-Response Module
 *
 * Fits a 5-parameter logistic curve to dose-response data.
 * Includes asymmetry parameter for asymmetric dose-response curves.
 *
 * Model: response = bottom + (top - bottom) / (1 + (dose/IC50)^hill)^asymmetry
 *
 * Requirements:
 * - Exactly 2 numeric columns (dose, response)
 * - All doses must be ≥ 0 (0 allowed as control, negatives not allowed)
 * - Minimum 8 data points (strict - due to 5 parameters)
 *
 * Warnings:
 * - 8-11 points: unstable estimates warning
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
 * 5PL Dose-Response Module
 */
export const doseResponse5plModule: ITestModule = {
  moduleId: 'dose_response_5pl',

  /**
   * Validate column selection for 5PL Dose-Response
   *
   * Validation Rules:
   * 1. Exactly 2 columns required (dose, response)
   * 2. Both columns must be numeric
   * 3. Minimum 8 data points (strict for 5PL)
   * 4. Warning if 8-11 points (unstable estimates)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count
    const countResult = TestValidator.checkColumnCount(columns, 2, '5PL Dose-Response')
    if (countResult) return countResult

    // Check both columns are numeric
    const numericResult = TestValidator.checkAllNumeric(columns, '5PL Dose-Response')
    if (numericResult) return numericResult

    // Check minimum sample size (strict for 5PL)
    // ColumnClassification.totalValues is already non-missing (see ColumnDataExtractor),
    // so do NOT subtract missingValues (that double-counts and can go negative).
    const minN = Math.min(columns[0]!.totalValues, columns[1]!.totalValues)

    const warnings: string[] = []
    const suggestions: string[] = []

    // 5PL requires minimum 8 data points (5 parameters + degrees of freedom)
    if (minN < 8) {
      return {
        isValid: false,
        errors: [
          `Insufficient data: ${minN} points. 5PL Dose-Response requires at least 8 data points due to the additional asymmetry parameter.`,
        ],
        warnings: [],
        suggestions: [
          'Add more dose-response measurements',
          'Consider using 4PL model if fewer data points available',
        ],
      }
    }

    // Warning for marginal sample sizes (8-11 points)
    if (minN >= 8 && minN <= 11) {
      warnings.push(
        `Marginal sample size (${minN} points). 5PL parameter estimates may be unstable.`
      )
      suggestions.push(
        'Consider using 4PL model for more stable estimates with this sample size.'
      )
    }

    // Check for ordinal warning
    const ordinalResult = TestValidator.checkOrdinalWarning(
      columns,
      '5PL Dose-Response',
      false
    )
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
   * Build Python payload for 5PL Dose-Response
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
          error: '5PL Dose-Response requires exactly 2 columns (dose, response)',
        }
      }

      // Align dose and response arrays
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

      // Strict minimum for 5PL
      if (alignedData.doses.length < 8) {
        return {
          success: false,
          error: `Insufficient sample size: ${alignedData.doses.length} points. 5PL requires minimum 8 data points.`,
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

      const MIN_POSITIVE_5PL = 8
      if (positiveDoses.length < MIN_POSITIVE_5PL) {
        return {
          success: false,
          error: `Need at least ${MIN_POSITIVE_5PL} positive dose levels (dose > 0). ` +
            `Found ${positiveDoses.length}. Controls (dose=0) don't count toward minimum. ` +
            `Use 4PL (requires 4) or 3PL (requires 4) for fewer points.` +
            (controlDoses.length > 0 ? ` You have ${controlDoses.length} control point(s).` : ''),
        }
      }

      // Build Python payload
      const payload = {
        test: 'dose_response_5pl',
        data: {
          doses: alignedData.doses,
          responses: alignedData.responses,
          dose_column: columns[0]!.columnName,
          response_column: columns[1]!.columnName,
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
   * Default parameters for 5PL Dose-Response
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
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

    if (doseVal === null || doseVal === undefined || doseVal === '') continue
    if (respVal === null || respVal === undefined || respVal === '') continue

    const doseNum = typeof doseVal === 'number' ? doseVal : parseFloat(String(doseVal))
    const respNum = typeof respVal === 'number' ? respVal : parseFloat(String(respVal))

    if (isNaN(doseNum) || isNaN(respNum)) continue

    doses.push(doseNum)
    responses.push(respNum)
  }

  return { doses, responses }
}
