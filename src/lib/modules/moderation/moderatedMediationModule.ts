/**
 * Moderated Mediation Analysis Module (Model 7)
 *
 * First-Stage Moderated Mediation: X × W → M → Y
 * Tests whether the indirect effect of X on Y through M depends on W.
 * W moderates the X → M path (first stage of mediation).
 *
 * Requirements:
 * - Minimum 4 columns: IV (X), Moderator (W), Mediator (M), DV (Y)
 * - Optional: Covariates
 * - All columns must be numeric (continuous or binary)
 *
 * Outputs:
 * - Path coefficients (X, W, X×W → M; M → Y)
 * - Conditional indirect effects at W values (-1 SD, Mean, +1 SD)
 * - Index of moderated mediation with bootstrap CI
 * - Simple slopes for X → M at different W levels
 *
 * Python Backend: statistics_module.moderation.moderated_mediation()
 * Validation Status: 65/65 metrics validated against validation baseline
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
 * Moderated Mediation Analysis Module (Model 7)
 *
 * Implements first-stage moderated mediation analysis (Model 7).
 * Estimates conditional indirect effects and tests whether mediation depends on a moderator.
 *
 * Use Cases:
 * - Testing when mediation occurs (Does the mechanism vary by context?)
 * - Identifying boundary conditions for indirect effects
 * - Conditional process analysis with interaction in first stage
 */
export const moderatedMediationModule: ITestModule = {
  moduleId: 'moderated_mediation_model7',

  /**
   * Validate column selection for Moderated Mediation Analysis
   *
   * Validation Rules:
   * 1. Minimum 4 columns required (IV, Moderator, Mediator, DV)
   * 2. Block multi-level categorical IV/W/M/DV (uniqueValueCount > 2)
   * 3. Allow binary categorical with encoding prompt
   * 4. Allow multi-level categorical covariates with k-1 dummy encoding
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // 1. Check minimum column count
    if (columns.length < 4) {
      return {
        isValid: false,
        errors: [
          `Moderated Mediation requires at least 4 columns (IV + Moderator + Mediator + DV). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 4 columns (numeric or binary categorical) in order:',
          '  1. Independent Variable (X) - predictor',
          '  2. Moderator (W) - moderates X → M path',
          '  3. Mediator (M) - transmits conditional effect',
          '  4. Dependent Variable (Y) - outcome',
          'Optional: Add covariates after DV',
        ],
      }
    }

    const ivCol = columns[0]!
    const moderatorCol = columns[1]!
    const mediatorCol = columns[2]!
    const dvCol = columns[3]!
    const covariates = columns.slice(4)

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

    // 3. Block multi-level categorical Moderator
    if (
      moderatorCol.dataType === ColumnDataType.Categorical &&
      moderatorCol.uniqueValueCount > 2
    ) {
      return {
        isValid: false,
        errors: [
          `Moderator '${moderatorCol.columnName}' is multi-level categorical (${moderatorCol.uniqueValueCount} levels). Only binary categorical or continuous moderator supported.`,
        ],
        warnings: [],
        suggestions: ['Use a binary categorical (2 levels) or numeric moderator'],
      }
    }

    // 4. Block multi-level categorical Mediator
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

    // 5. Block multi-level categorical DV
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

    // 6. Allow binary categorical IV/W/M/DV with encoding
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
      (moderatorCol.dataType === ColumnDataType.Binary ||
        moderatorCol.dataType === ColumnDataType.Categorical) &&
      moderatorCol.isBinary
    ) {
      warnings.push(
        `Moderator '${moderatorCol.columnName}' is binary categorical. You will be prompted to map values to 0/1.`
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

    // 7. Check for binary DV (logistic outcome model)
    const isBinaryDV = dvCol.isBinary && dvCol.uniqueValueCount === 2
    if (isBinaryDV) {
      warnings.push(
        `DV '${dvCol.columnName}' is binary. Logistic regression will be used for the outcome model.`
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
      `Moderated Mediation with ${covariates.length} covariate(s). Recommended: N ≥ ${covariates.length * 50 + 150} for stable bootstrap estimates.`
    )

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Moderated Mediation Analysis
   *
   * Extracts data for IV, Moderator, Mediator, DV, and optional covariates.
   * Detects binary DV for logistic outcome model.
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (n_boot, confidence, seed, center_predictor, center_moderator, probe_values)
   * @returns Payload for Python backend or error
   */
  buildPayload(
    columns: ColumnClassification[],
    selectedColumnIndices: number[],
    rows: any[],
    parameters: Record<string, any>
  ): BuildPayloadResult {
    try {
      if (columns.length < 4 || selectedColumnIndices.length < 4) {
        return {
          success: false,
          error: 'Moderated Mediation requires at least 4 columns (IV + Moderator + Mediator + DV)',
        }
      }

      const resolveLocalIndex = (name: string | undefined, fallback: number) => {
        if (!name) return fallback
        const idx = columns.findIndex(
          (col) => col.columnName === name || col.columnId === name
        )
        return idx >= 0 ? idx : fallback
      }

      const predictorName = parameters.predictor_name as string | undefined
      const moderatorName = parameters.moderator_name as string | undefined
      const mediatorName = parameters.mediator_name as string | undefined
      const outcomeName = parameters.outcome_name as string | undefined

      const ivLocalIndex = resolveLocalIndex(predictorName, 0)
      const moderatorLocalIndex = resolveLocalIndex(moderatorName, 1)
      const mediatorLocalIndex = resolveLocalIndex(mediatorName, 2)
      const dvLocalIndex = resolveLocalIndex(outcomeName, 3)

      const ivIndex = selectedColumnIndices[ivLocalIndex]
      const moderatorIndex = selectedColumnIndices[moderatorLocalIndex]
      const mediatorIndex = selectedColumnIndices[mediatorLocalIndex]
      const dvIndex = selectedColumnIndices[dvLocalIndex]

      if (
        ivIndex === undefined ||
        moderatorIndex === undefined ||
        mediatorIndex === undefined ||
        dvIndex === undefined
      ) {
        return {
          success: false,
          error:
            'Selected moderated mediation columns could not be mapped to dataset indices.',
        }
      }

      const coreLocalIndices = new Set([
        ivLocalIndex,
        moderatorLocalIndex,
        mediatorLocalIndex,
        dvLocalIndex,
      ])
      const covariateLocalIndices = columns
        .map((_, idx) => idx)
        .filter((idx) => !coreLocalIndices.has(idx))

      // Columns are already ordered by selection; use local positions for metadata
      const ivCol = columns[ivLocalIndex]!
      const moderatorCol = columns[moderatorLocalIndex]!
      const mediatorCol = columns[mediatorLocalIndex]!
      const dvCol = columns[dvLocalIndex]!

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

      // Encode Moderator if binary categorical
      if (
        (moderatorCol.dataType === ColumnDataType.Binary ||
          moderatorCol.dataType === ColumnDataType.Categorical) &&
        moderatorCol.isBinary
      ) {
        const encoding = parameters.moderator_encoding as
          | { eventValue: string; censoredValue: string }
          | undefined
        if (encoding) {
          categorical_encodings[moderatorCol.columnName] = {
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
      const moderatorEncoding = categorical_encodings[moderatorCol.columnName]
      const mediatorEncoding = categorical_encodings[mediatorCol.columnName]
      const dvEncoding = categorical_encodings[dvCol.columnName]

      const covariateMeta = covariateLocalIndices.map((covLocalIdx, index) => {
        const covCol = columns[covLocalIdx]!
        const covIdx = selectedColumnIndices[covLocalIdx]
        if (covIdx === undefined) {
          throw new Error('Covariate column index could not be resolved.')
        }
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
        const wNum = normalizeNumericValue(row[moderatorIndex], moderatorEncoding)
        const mNum = normalizeNumericValue(row[mediatorIndex], mediatorEncoding)
        const yNum = normalizeNumericValue(row[dvIndex], dvEncoding)

        if (xNum === null || wNum === null || mNum === null || yNum === null) {
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
      const W: number[] = []
      const M: number[] = []
      const Y: number[] = []

      for (const rowIdx of validRowIndices) {
        const row = rows[rowIdx]!
        X.push(normalizeNumericValue(row[ivIndex], ivEncoding)!)
        W.push(normalizeNumericValue(row[moderatorIndex], moderatorEncoding)!)
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
      const payload = {
        test: 'moderated_mediation_model7',
        data: {
          outcome_data: Y,
          predictor_data: X,
          moderator_data: W,
          mediator_data: M,
          outcome_name: dvCol.columnName,
          predictor_name: ivCol.columnName,
          moderator_name: moderatorCol.columnName,
          mediator_name: mediatorCol.columnName,
          control_data: controlData.length > 0 ? controlData : undefined,
          control_names: controlNames.length > 0 ? controlNames : undefined,
          categorical_encodings:
            Object.keys(categorical_encodings).length > 0 ? categorical_encodings : undefined,
        },
        parameters: {
          n_boot: parameters.n_boot ?? 5000,
          confidence: parameters.confidence ?? 0.95,
          seed: parameters.seed ?? 12345,
          center_predictor: parameters.center_predictor ?? false, // validation baseline: no centering
          center_moderator: parameters.center_moderator ?? false, // validation baseline: no centering
          logit: isBinaryDV,
          ...(parameters.probe_values !== undefined ? { probe_values: parameters.probe_values } : {}),
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
   * Default parameters for Moderated Mediation Analysis
   *
   * @returns Default bootstrap iterations, confidence level, seed, centering, and probe values
   */
  defaultParameters(): Record<string, any> {
    return {
      n_boot: 5000, // Bootstrap samples for indirect effect CI
      confidence: 0.95, // 95% confidence level
      seed: 12345, // Reproducible bootstrap results
      center_predictor: false, // Match validation baseline (no centering in model fit)
      center_moderator: false, // Match validation baseline (no centering in model fit)
    }
  },
}
