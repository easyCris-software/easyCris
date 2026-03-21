/**
 * Synergy All Methods Module
 *
 * Runs all 4 synergy methods (Bliss, HSA, Loewe, ZIP) and returns
 * comprehensive comparison.
 *
 * Requirements:
 * - Either:
 *   - 3 numeric columns: dose_a, dose_b, combo_response (with boundary rows dose_a=0 or dose_b=0), OR
 *   - 5 numeric columns: dose_a, dose_b, combo_response, response_a, response_b (explicit single-agent columns)
 *
 * Note: Includes doses since Loewe/ZIP require them.
 * Returns all 4 synergy methods in a single analysis.
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
 * Synergy All Methods Module
 */
export const synergyAllModule: ITestModule = {
  moduleId: 'synergy_all',

  /**
   * Validate column selection for Synergy All
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return validateSynergySelection(columns, 'Synergy Analysis (All Methods)')
  },

  /**
   * Build Python payload for Synergy All
   *
   * Uses the "separate payloads" format supported by `drug_combo.synergy_analysis_json`
   * so that no legacy slicing/conversion is applied.
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
            'Synergy Analysis requires at least 3 columns: Drug A Dose, Drug B Dose, Combined Response.',
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

      const toInhibition = (value: number) => 100 - value
      const toInhibitionArray = (values: number[]) => values.map(toInhibition)
      const toInhibitionMatrix = (matrix: number[][]) =>
        matrix.map(row => row.map(toInhibition))

      // Bliss/HSA expect inhibition inputs; keep full grid for R parity.
      const fullGridPivot = pivotToSynergyPayload(
        rawData.dose_a,
        rawData.dose_b,
        rawData.response,
        {
          includeZeroEdges: true,
          responseA: rawData.response_a,
          responseB: rawData.response_b,
        }
      )

      if (!fullGridPivot.success) {
        return {
          success: false,
          error: fullGridPivot.error,
        }
      }

      if (!fullGridPivot.responses_a || !fullGridPivot.responses_b || !fullGridPivot.combo_matrix) {
        return {
          success: false,
          error: 'Failed to build synergy payload: missing pivoted response data.',
        }
      }

      const warnings = [...(fullGridPivot.warnings ?? [])]

      // Build Python payload using the "new path" in synergy_analysis_json
      const payload = {
        test: 'synergy_all',
        data: {
          analysis_type: 'all',
          hsa: {
            responses_a: toInhibitionArray(fullGridPivot.responses_a),
            responses_b: toInhibitionArray(fullGridPivot.responses_b),
            combo_matrix: toInhibitionMatrix(fullGridPivot.combo_matrix),
            doses_a: fullGridPivot.doses_a,
            doses_b: fullGridPivot.doses_b,
          },
          bliss: {
            responses_a: toInhibitionArray(fullGridPivot.responses_a),
            responses_b: toInhibitionArray(fullGridPivot.responses_b),
            combo_matrix: toInhibitionMatrix(fullGridPivot.combo_matrix),
            doses_a: fullGridPivot.doses_a,
            doses_b: fullGridPivot.doses_b,
          },
          loewe: {
            doses_a: fullGridPivot.doses_a,
            doses_b: fullGridPivot.doses_b,
            responses_a: fullGridPivot.responses_a,
            responses_b: fullGridPivot.responses_b,
            combo_matrix: fullGridPivot.combo_matrix,
            data_type: parameters.data_type ?? 'viability',
            fitting_method: parameters.fitting_method ?? 'log_dose',
          },
          zip: {
            doses_a: fullGridPivot.doses_a,
            doses_b: fullGridPivot.doses_b,
            responses_a: fullGridPivot.responses_a,
            responses_b: fullGridPivot.responses_b,
            combo_matrix: fullGridPivot.combo_matrix,
          },
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
        metadata: {
          warnings,
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
   * Default parameters for Synergy All
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
