/**
 * Mediation Analysis Module (Model 4)
 *
 * Simple Mediation: X → M → Y
 * Tests whether the effect of X on Y is mediated through M.
 *
 * Requirements:
 * - Minimum 3 columns: IV (X), Mediator (M), DV (Y)
 * - Optional: Covariates
 * - All columns must be numeric (continuous or binary)
 *
 * Outputs:
 * - Path coefficients (a, b, c', c)
 * - Indirect effect (ACME) with bootstrap confidence intervals
 * - Direct effect (ADE)
 * - Total effect
 * - Proportion mediated
 * - Sobel test
 *
 * Python Backend: statistics_module.mediation.mediation_analysis()
 * Validation Status: 18/18 metrics validated against validation baseline
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import { ColumnDataType } from '../core/types'

/**
 * Mediation Analysis Module (Model 4)
 *
 * Implements simple mediation analysis (Model 4).
 * Estimates the extent to which the effect of X on Y is transmitted through M.
 *
 * Use Cases:
 * - Testing intervention mechanisms (Does treatment affect outcome via symptom reduction?)
 * - Understanding causal pathways (Does education affect income via job skills?)
 * - Identifying mediating processes in experimental and observational studies
 */
export const mediationModule: ITestModule = {
  moduleId: 'mediation_model4',

  /**
   * Validate column selection for Mediation Analysis
   *
   * Validation Rules:
   * 1. Minimum 3 columns required (IV, Mediator, DV)
   * 2. Block multi-level categorical IV/M/DV (uniqueValueCount > 2)
   * 3. Allow binary categorical with encoding prompt
   * 4. Allow multi-level categorical covariates with k-1 dummy encoding
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // 1. Check minimum column count
    if (columns.length < 3) {
      return {
        isValid: false,
        errors: [
          `Mediation requires at least 3 columns (IV + Mediator + DV). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 3 columns (numeric or binary categorical) in order:',
          '  1. Independent Variable (X) - predictor',
          '  2. Mediator (M) - transmits effect',
          '  3. Dependent Variable (Y) - outcome',
          'Optional: Add covariates after DV',
        ],
      }
    }

    const ivCol = columns[0]!
    const mediatorCol = columns[1]!
    const dvCol = columns[2]!
    const covariates = columns.slice(3)

    const warnings: string[] = []
    const suggestions: string[] = []

    // 2. Block multi-level categorical IV
    if (ivCol.dataType === ColumnDataType.Categorical && ivCol.uniqueValueCount > 2) {
      return {
        isValid: false,
        errors: [
          `IV '${ivCol.columnName}' is multi-level categorical (${ivCol.uniqueValueCount} levels). Only binary categorical or continuous IV supported.`,
        ],
        warnings: [],
        suggestions: ['Use a binary categorical (2 levels) or numeric IV'],
      }
    }

    // 3. Block multi-level categorical Mediator
    if (
      mediatorCol.dataType === ColumnDataType.Categorical &&
      mediatorCol.uniqueValueCount > 2
    ) {
      return {
        isValid: false,
        errors: [
          `Mediator '${mediatorCol.columnName}' is multi-level categorical (${mediatorCol.uniqueValueCount} levels). Only binary categorical or continuous mediator supported.`,
        ],
        warnings: [],
        suggestions: ['Use a binary categorical (2 levels) or numeric mediator'],
      }
    }

    // 4. Block multi-level categorical DV
    if (dvCol.dataType === ColumnDataType.Categorical && dvCol.uniqueValueCount > 2) {
      return {
        isValid: false,
        errors: [
          `DV '${dvCol.columnName}' is multi-level categorical (${dvCol.uniqueValueCount} levels). Only binary categorical or continuous DV supported.`,
        ],
        warnings: [],
        suggestions: ['Use a binary categorical (2 levels) or numeric DV'],
      }
    }

    // 6. Allow binary categorical IV/M/DV with encoding
    if (
      (ivCol.dataType === ColumnDataType.Binary ||
        ivCol.dataType === ColumnDataType.Categorical) &&
      ivCol.isBinary
    ) {
      warnings.push(
        `IV '${ivCol.columnName}' is binary categorical. You will be prompted to map values to 0/1.`
      )
    }
    if (
      (mediatorCol.dataType === ColumnDataType.Binary ||
        mediatorCol.dataType === ColumnDataType.Categorical) &&
      mediatorCol.isBinary
    ) {
      warnings.push(
        `Mediator '${mediatorCol.columnName}' is binary categorical. You will be prompted to map values to 0/1.`
      )
    }

    // 7. Check for binary DV (logistic mediation not used for baseline parity)
    const isBinaryDV = dvCol.isBinary && dvCol.uniqueValueCount === 2
    if (isBinaryDV) {
      warnings.push(
        `DV '${dvCol.columnName}' is binary. OLS mediation will be used (logistic mediation disabled for baseline parity).`
      )
      if (
        dvCol.dataType === ColumnDataType.Binary ||
        dvCol.dataType === ColumnDataType.Categorical
      ) {
        warnings.push(
          `DV '${dvCol.columnName}' is binary categorical. You will be prompted to map values to 0/1.`
        )
      }
    }

    // 8. Allow multi-level categorical covariates with dummy encoding
    for (const cov of covariates) {
      if (cov.dataType === ColumnDataType.Categorical && cov.uniqueValueCount > 2) {
        suggestions.push(
          `Covariate '${cov.columnName}' will be dummy-coded (k-1 = ${cov.uniqueValueCount - 1} dummies).`
        )
      }
    }

    // 9. Sample size recommendation
    suggestions.push(
      `Mediation with ${covariates.length} covariate(s). Recommended: N ≥ ${covariates.length * 50 + 100} for stable bootstrap estimates.`
    )

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Mediation Analysis
   *
   * Extracts data for IV, Mediator, DV, and optional covariates.
   * Detects binary DV (logistic mediation disabled; OLS used for baseline parity).
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (n_boot, confidence, seed)
   * @returns Payload for Python backend or error
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
          error: 'Mediation requires at least 3 columns (IV + Mediator + DV)',
        }
      }

      const ivIndex = selectedColumnIndices[0]!
      const mediatorIndex = selectedColumnIndices[1]!
      const dvIndex = selectedColumnIndices[2]!
      const covariateIndices = selectedColumnIndices.slice(3)

      // Columns are already ordered by selection; use local positions for metadata
      const ivCol = columns[0]!
      const mediatorCol = columns[1]!
      const dvCol = columns[2]!

      // Build categorical_encodings map
      const categorical_encodings: Record<string, Record<string, number>> = {}

      // Encode IV if binary categorical
      if (
        (ivCol.dataType === ColumnDataType.Binary ||
          ivCol.dataType === ColumnDataType.Categorical) &&
        ivCol.isBinary
      ) {
        const encoding = parameters.iv_encoding as
          | { eventValue: string; censoredValue: string }
          | undefined
        if (encoding) {
          categorical_encodings[ivCol.columnName] = {
            [encoding.censoredValue]: 0,
            [encoding.eventValue]: 1,
          }
        }
      }

      // Encode Mediator if binary categorical
      if (
        (mediatorCol.dataType === ColumnDataType.Binary ||
          mediatorCol.dataType === ColumnDataType.Categorical) &&
        mediatorCol.isBinary
      ) {
        const encoding = parameters.mediator_encoding as
          | { eventValue: string; censoredValue: string }
          | undefined
        if (encoding) {
          categorical_encodings[mediatorCol.columnName] = {
            [encoding.censoredValue]: 0,
            [encoding.eventValue]: 1,
          }
        }
      }

      // Encode DV if binary categorical
      const isBinaryDV = dvCol.isBinary && dvCol.uniqueValueCount === 2
      if (
        isBinaryDV &&
        (dvCol.dataType === ColumnDataType.Binary ||
          dvCol.dataType === ColumnDataType.Categorical)
      ) {
        const encoding = parameters.dv_encoding as
          | { eventValue: string; censoredValue: string }
          | undefined
        if (encoding) {
          categorical_encodings[dvCol.columnName] = {
            [encoding.censoredValue]: 0,
            [encoding.eventValue]: 1,
          }
        }
      }

      const isMissingValue = (value: unknown): boolean => {
        if (value === null || value === undefined) return true
        if (typeof value === 'string' && value.trim() === '') return true
        if (typeof value === 'number' && Number.isNaN(value)) return true
        return false
      }

      const normalizeNumericValue = (
        value: unknown,
        encoding?: Record<string, number>
      ): number | null => {
        if (isMissingValue(value)) return null
        if (encoding) {
          const key = String(value)
          if (Object.prototype.hasOwnProperty.call(encoding, key)) {
            return encoding[key] ?? null
          }
        }
        if (typeof value === 'boolean') return value ? 1 : 0
        const num = typeof value === 'number' ? value : Number(value)
        return Number.isFinite(num) ? num : null
      }

      const ivEncoding = categorical_encodings[ivCol.columnName]
      const mediatorEncoding = categorical_encodings[mediatorCol.columnName]
      const dvEncoding = categorical_encodings[dvCol.columnName]

      const covariateMeta = covariateIndices.map((covIdx, index) => {
        const covCol = columns[index + 3]!
        let encoding: Record<string, number> | undefined
        if (
          (covCol.dataType === ColumnDataType.Binary ||
            covCol.dataType === ColumnDataType.Categorical) &&
          covCol.isBinary
        ) {
          const paramEncoding = parameters[`covariate_${index}_encoding`] as
            | { eventValue: string; censoredValue: string }
            | undefined
          if (paramEncoding) {
            encoding = {
              [paramEncoding.censoredValue]: 0,
              [paramEncoding.eventValue]: 1,
            }
            categorical_encodings[covCol.columnName] = encoding
          }
        }
        return { covIdx, covCol, encoding, paramIndex: index }
      })

      // Extract data with listwise deletion
      const validRowIndices: number[] = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        const xNum = normalizeNumericValue(row[ivIndex], ivEncoding)
        const mNum = normalizeNumericValue(row[mediatorIndex], mediatorEncoding)
        const yNum = normalizeNumericValue(row[dvIndex], dvEncoding)

        if (xNum === null || mNum === null || yNum === null) {
          continue
        }

        let hasCovariateMissing = false
        for (const covariate of covariateMeta) {
          const covVal = row[covariate.covIdx]
          if (
            covariate.covCol.dataType === ColumnDataType.Categorical &&
            covariate.covCol.uniqueValueCount > 2
          ) {
            if (isMissingValue(covVal)) {
              hasCovariateMissing = true
              break
            }
            continue
          }
          const covNum = normalizeNumericValue(covVal, covariate.encoding)
          if (covNum === null) {
            hasCovariateMissing = true
            break
          }
        }

        if (hasCovariateMissing) {
          continue
        }

        validRowIndices.push(i)
      }

      // Extract data from valid rows, applying categorical encoding
      const X: number[] = []
      const M: number[] = []
      const Y: number[] = []

      for (const rowIdx of validRowIndices) {
        const row = rows[rowIdx]!
        X.push(normalizeNumericValue(row[ivIndex], ivEncoding)!)
        M.push(normalizeNumericValue(row[mediatorIndex], mediatorEncoding)!)
        Y.push(normalizeNumericValue(row[dvIndex], dvEncoding)!)
      }

      // Validate sufficient data
      if (validRowIndices.length === 0) {
        return {
          success: false,
          error:
            'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      // Check minimum sample size (relaxed to match Python backend: 20 minimum)
      const minN = 20
      if (validRowIndices.length < minN) {
        return {
          success: false,
          error: `Insufficient sample size: ${validRowIndices.length} observations. Minimum required: ${minN}.`,
        }
      }

      // Extract and encode covariates
      const controlData: number[][] = []
      const controlNames: string[] = []

      for (const covariate of covariateMeta) {
        const covIdx = covariate.covIdx
        const covCol = covariate.covCol
        const covParamIndex = covariate.paramIndex

        if (covCol.dataType === ColumnDataType.Categorical && covCol.uniqueValueCount > 2) {
          // Multi-level categorical: dummy encode (k-1)
          const uniqueValues = [
            ...new Set(validRowIndices.map((rowIdx) => String(rows[rowIdx]![covIdx]))),
          ].sort()
          const baseline =
            (parameters[`covariate_${covParamIndex}_baseline`] as string) ||
            uniqueValues[0]!

          // Create k-1 dummy columns (exclude baseline)
          for (const level of uniqueValues) {
            if (level === baseline) continue
            const dummyData = validRowIndices.map((rowIdx) =>
              String(rows[rowIdx]![covIdx]) === level ? 1 : 0
            )
            controlData.push(dummyData)
            controlNames.push(`${covCol.columnName}_${level}`)
          }

          // Store encoding for display
          const encoding: Record<string, number> = {}
          uniqueValues.forEach((val, idx) => {
            encoding[val] = idx
          })
          categorical_encodings[covCol.columnName] = encoding
        } else if (covariate.encoding) {
          // Binary categorical: encode 0/1
          const encodedData = validRowIndices.map(
            (rowIdx) => normalizeNumericValue(rows[rowIdx]![covIdx], covariate.encoding) ?? 0
          )
          controlData.push(encodedData)
          controlNames.push(covCol.columnName)
        } else {
          // Numeric covariate: pass through
          controlData.push(
            validRowIndices.map(
              (rowIdx) => normalizeNumericValue(rows[rowIdx]![covIdx]) ?? 0
            )
          )
          controlNames.push(covCol.columnName)
        }
      }

      // Build Python payload
      // Force OLS for ACME/ADE parity with R's mediation::mediate (Model 4 baseline).
      // Logistic mediation changes effect definitions and bootstrap behavior.
      const useLogit = false
      const payload = {
        test: 'mediation_model4',
        data: {
          outcome_data: Y,
          predictor_data: X,
          mediator_data: M,
          outcome_name: dvCol.columnName,
          predictor_name: ivCol.columnName,
          mediator_name: mediatorCol.columnName,
          control_data: controlData.length > 0 ? controlData : undefined,
          control_names: controlNames.length > 0 ? controlNames : undefined,
          categorical_encodings:
            Object.keys(categorical_encodings).length > 0 ? categorical_encodings : undefined,
        },
        parameters: {
          n_boot: parameters.n_boot ?? 5000,
          confidence: parameters.confidence ?? 0.95,
          logit: useLogit,
          seed: parameters.seed ?? 12345,
          bootstrap_direct_effect: true, // For R validation parity
          bootstrap_prop_mediated: true, // For R validation parity
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
   * Default parameters for Mediation Analysis
   *
   * @returns Default bootstrap iterations, confidence level, and seed
   */
  defaultParameters(): Record<string, any> {
    return {
      n_boot: 5000, // Bootstrap samples for indirect effect CI
      confidence: 0.95, // 95% confidence level
      seed: 12345, // Reproducible bootstrap results
    }
  },
}
