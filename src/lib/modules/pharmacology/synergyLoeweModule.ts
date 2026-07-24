/**
 * Loewe Additivity Synergy Module
 *
 * Calculates drug synergy using Loewe additivity model (isobole analysis).
 *
 * Loewe assumes: dose_a/IC50_A + dose_b/IC50_B = 1 for additive effect
 * Synergy: Combination Index < 1 (same effect with less drug)
 *
 * Requirements:
 * - Either:
 *   - 3 numeric columns: dose_a, dose_b, combo_response (with boundary rows dose_a=0 or dose_b=0), OR
 *   - 5 numeric columns: dose_a, dose_b, combo_response, response_a, response_b (explicit single-agent columns)
 *
 * Note: Loewe requires dose concentrations to calculate isoboles
 * and fit individual dose-response curves.
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
 * Loewe Additivity Synergy Module
 */
export const synergyLoeweModule: ITestModule = {
  moduleId: 'synergy_loewe',

  /**
   * Validate column selection for Loewe Synergy
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return validateSynergySelection(columns, 'Loewe Additivity Synergy')
  },

  /**
   * Build Python payload for Loewe Synergy
   *
   * Loewe requires dose concentrations for isobole calculation.
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
            'Loewe Synergy requires at least 3 columns: Drug A Dose, Drug B Dose, Combined Response.',
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

      // Build Python payload (includes doses for Loewe)
      const payload = {
        test: 'synergy_loewe',
        data: {
          doses_a: pivotResult.doses_a,
          doses_b: pivotResult.doses_b,
          responses_a: pivotResult.responses_a,
          responses_b: pivotResult.responses_b,
          combo_matrix: pivotResult.combo_matrix,
          data_type: parameters.data_type ?? 'viability',
          fitting_method: parameters.fitting_method ?? 'log_dose',
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
   * Default parameters for Loewe Synergy
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
