/**
 * HSA (Highest Single Agent) Synergy Module
 *
 * Calculates drug synergy using Highest Single Agent reference model.
 *
 * HSA expected effect: max(E_A, E_B)
 * Synergy score: Observed - Expected (positive = synergy)
 *
 * Requirements:
 * - Either:
 *   - 3 numeric columns: dose_a, dose_b, combo_response (with boundary rows dose_a=0 or dose_b=0), OR
 *   - 5 numeric columns: dose_a, dose_b, combo_response, response_a, response_b (explicit single-agent columns)
 *
 * Note: HSA does not require dose concentrations -
 * only response values. Payload kept minimal.
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
 * HSA Synergy Module
 */
export const synergyHsaModule: ITestModule = {
  moduleId: 'synergy_hsa',

  /**
   * Validate column selection for HSA Synergy
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    return validateSynergySelection(columns, 'HSA (Highest Single Agent) Synergy')
  },

  /**
   * Build Python payload for HSA Synergy
   *
   * HSA only needs response values - no dose concentrations required.
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
            'HSA Synergy requires at least 3 columns: Drug A Dose, Drug B Dose, Combined Response.',
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

      if (!pivotResult.responses_a || !pivotResult.responses_b || !pivotResult.combo_matrix) {
        return {
          success: false,
          error: 'Failed to build HSA synergy payload: missing pivoted response data.',
        }
      }

      // Build Python payload
      const payload: any = {
        test: 'synergy_hsa',
        data: {
          drug_a_name: columns[0]!.columnName,
          drug_b_name: columns[1]!.columnName,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
        metadata: {
          warnings: pivotResult.warnings || [],
        },
      }

      // Add warning if 5-column format is used (not suitable for response-based models)
      if (hasExplicitSingleAgents) {
        payload.metadata.warnings.push(
          'Note: HSA (Highest Single Agent) uses raw response values without curve fitting. ' +
          'The 5-column format may not be suitable here as it provides the same results as 3-column boundary format (4PL will be adapted automatically). ' +
          'Consider using Loewe or ZIP models if 4PL dose-response curve fitting is needed.'
        )
      }

      // Sparse mode: send row-by-row data
      if (pivotResult.sparse_mode && pivotResult.sparse_data) {
        payload.data.sparse_mode = true
        payload.data.dose_a = pivotResult.sparse_data.dose_a
        payload.data.dose_b = pivotResult.sparse_data.dose_b
        payload.data.response_a = toInhibitionArray(pivotResult.sparse_data.response_a)
        payload.data.response_b = toInhibitionArray(pivotResult.sparse_data.response_b)
        payload.data.combo_response = toInhibitionArray(pivotResult.sparse_data.combo_response)
      } else {
        // Dense mode: send matrix data
        payload.data.responses_a = toInhibitionArray(pivotResult.responses_a)
        payload.data.responses_b = toInhibitionArray(pivotResult.responses_b)
        payload.data.combo_matrix = toInhibitionMatrix(pivotResult.combo_matrix)
        payload.data.doses_a = pivotResult.doses_a
        payload.data.doses_b = pivotResult.doses_b
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
   * Default parameters for HSA Synergy
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
