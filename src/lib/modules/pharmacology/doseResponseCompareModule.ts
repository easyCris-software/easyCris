/**
 * Dose-Response Model Comparison Module
 *
 * Fits all 3 dose-response models (3PL, 4PL, 5PL) and compares them
 * using AIC and BIC criteria.
 *
 * Requirements:
 * - Exactly 2 numeric columns (dose, response)
 * - All doses must be ≥ 0 (0 allowed as control, negatives not allowed)
 * - Minimum 4 data points
 *
 * Output:
 * - Parameters for each fitted model
 * - AIC/BIC comparison table
 * - Recommendation based on criteria
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
 * Dose-Response Model Comparison Module
 */
export const doseResponseCompareModule: ITestModule = {
  moduleId: 'dose_response_compare',

  /**
   * Validate column selection for Model Comparison
   *
   * Uses same validation as 4PL (middle ground).
   * 5PL will be fitted only if sufficient data (8+ points).
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count
    const countResult = TestValidator.checkColumnCount(columns, 2, 'Dose-Response Comparison')
    if (countResult) return countResult

    // Check both columns are numeric
    const numericResult = TestValidator.checkAllNumeric(columns, 'Dose-Response Comparison')
    if (numericResult) return numericResult

    // Check minimum sample size
    // ColumnClassification.totalValues is already non-missing (see ColumnDataExtractor),
    // so do NOT subtract missingValues (that double-counts and can go negative).
    const minN = Math.min(columns[0]!.totalValues, columns[1]!.totalValues)

    const warnings: string[] = []
    const suggestions: string[] = []

    if (minN < 4) {
      return {
        isValid: false,
        errors: [`Insufficient data: ${minN} points. Model Comparison requires at least 4 data points.`],
        warnings: [],
        suggestions: ['Add more dose-response measurements'],
      }
    }

    if (minN < 8) {
      warnings.push(
        `Sample size (${minN} points) may be insufficient for 5PL model. 5PL will be skipped or may show unstable estimates.`
      )
      suggestions.push('Consider collecting more data for comprehensive model comparison.')
    }

    // Check for ordinal warning
    const ordinalResult = TestValidator.checkOrdinalWarning(
      columns,
      'Dose-Response Comparison',
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
   * Build Python payload for Model Comparison
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
          error: 'Dose-Response Comparison requires exactly 2 columns (dose, response)',
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

      // Build Python payload
      const payload = {
        test: 'dose_response_compare',
        data: {
          doses: alignedData.doses,
          responses: alignedData.responses,
          dose_column: columns[0]!.columnName,
          response_column: columns[1]!.columnName,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
          // Python backend will decide which models to fit based on sample size
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
   * Default parameters for Model Comparison
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
