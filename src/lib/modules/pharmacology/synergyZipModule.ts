/**
 * ZIP (Zero Interaction Potency) Synergy Module
 *
 * Calculates drug synergy using ZIP model.
 *
 * ZIP combines concepts from Bliss and Loewe models.
 * Fits dose-response curves to single agents and calculates
 * deviation from expected additive effect.
 *
 * Requirements:
 * - Either:
 *   - 3 numeric columns: dose_a, dose_b, combo_response (with boundary rows dose_a=0 or dose_b=0), OR
 *   - 5 numeric columns: dose_a, dose_b, combo_response, response_a, response_b (explicit single-agent columns)
 *
 * Note: ZIP requires dose concentrations to fit individual
 * dose-response curves for each drug.
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import {
  validateSynergySelection,
  extractSynergyData,
  pivotToSynergyPayload,
} from './synergyUtils'

/**
 * ZIP Synergy Module
 */
export const synergyZipModule: ITestModule = {
  moduleId: 'synergy_zip',

  /**
   * Validate column selection for ZIP Synergy
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return validateSynergySelection(columns, 'ZIP (Zero Interaction Potency) Synergy')
  },

  /**
   * Build Python payload for ZIP Synergy
   *
   * ZIP requires dose concentrations for curve fitting.
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
          error:
            'ZIP Synergy requires at least 3 columns: Drug A Dose, Drug B Dose, Combined Response.',
        }
      }

      const hasExplicitSingleAgents = columns.length >= 5 && selectedColumnIndices.length >= 5

      // Extract data
      const rawData = extractSynergyData(
        selectedColumnIndices[0]!,
        selectedColumnIndices[1]!,
        selectedColumnIndices[2]!,
        rows,
        hasExplicitSingleAgents ? selectedColumnIndices[3] : undefined,
        hasExplicitSingleAgents ? selectedColumnIndices[4] : undefined
      )

      if (rawData.dose_a.length === 0) {
        return {
          success: false,
          error: 'No valid data after removing missing values.',
        }
      }

      // Pivot to matrix format with validation
      const pivotResult = pivotToSynergyPayload(
        rawData.dose_a,
        rawData.dose_b,
        rawData.response,
        {
          includeZeroEdges: true,
          responseA: rawData.response_a,
          responseB: rawData.response_b,
        }
      )

      if (!pivotResult.success) {
        return {
          success: false,
          error: pivotResult.error,
        }
      }

      // Build Python payload (includes doses for ZIP)
      const payload = {
        test: 'synergy_zip',
        data: {
          doses_a: pivotResult.doses_a,
          doses_b: pivotResult.doses_b,
          responses_a: pivotResult.responses_a,
          responses_b: pivotResult.responses_b,
          combo_matrix: pivotResult.combo_matrix,
          drug_a_name: columns[0]!.columnName,
          drug_b_name: columns[1]!.columnName,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
        metadata: {
          warnings: pivotResult.warnings,
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
   * Default parameters for ZIP Synergy
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
