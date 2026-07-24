/**
 * Moderation Analysis Module (Model 1)
 *
 * Simple Moderation: X × W → Y
 * Tests whether the effect of X on Y depends on the level of W.
 *
 * Requirements:
 * - Minimum 3 columns: IV (X), Moderator (W), DV (Y)
 * - Optional: Covariates
 * - All columns must be numeric (continuous or binary)
 *
 * Outputs:
 * - Regression coefficients (X, W, X×W interaction)
 * - Simple slopes at -1 SD, Mean, +1 SD of W
 * - Johnson-Neyman regions of significance
 * - R², F-statistic, model fit
 *
 * Python Backend: statistics_module.moderation.simple_moderation()
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
 * Moderation Analysis Module (Model 1)
 *
 * Implements simple moderation analysis (Model 1).
 * Estimates the extent to which the effect of X on Y depends on W.
 *
 * Use Cases:
 * - Testing interaction effects (Does treatment effect vary by age?)
 * - Identifying boundary conditions (When does X affect Y?)
 * - Conditional process analysis in experimental and observational studies
 */
export const moderationModule: ITestModule = {
  moduleId: 'moderation_model1',

  /**
   * Validate column selection for Moderation Analysis
   *
   * Validation Rules:
   * 1. Minimum 3 columns required (IV, Moderator, DV)
   * 2. Block multi-level categorical IV/W/DV (uniqueValueCount > 2)
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
          `Moderation requires at least 3 columns (IV + Moderator + DV). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 3 columns (numeric or binary categorical) in order:',
          '  1. Independent Variable (X) - predictor',
          '  2. Moderator (W) - conditions the effect of X',
          '  3. Dependent Variable (Y) - outcome',
          'Optional: Add covariates after DV',
        ],
      }
    }

    const ivCol = columns[0]!
    const moderatorCol = columns[1]!
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

    // 5. Allow binary categorical IV/W/DV with encoding
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

    // 6. Check for binary DV (logistic moderation)
    const isBinaryDV = dvCol.isBinary && dvCol.uniqueValueCount === 2
    if (isBinaryDV) {
      warnings.push(
        `DV '${dvCol.columnName}' is binary. Logistic moderation will be used.`
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

    // 7. Allow multi-level categorical covariates with dummy encoding
    for (const cov of covariates) {
      if (cov.dataType === ColumnDataType.Categorical && cov.uniqueValueCount > 2) {
        suggestions.push(
          `Covariate '${cov.columnName}' will be dummy-coded (k-1 = ${cov.uniqueValueCount - 1} dummies).`
        )
      }
    }

    // 8. Sample size recommendation
    suggestions.push(
      `Moderation with ${covariates.length} covariate(s). Recommended: N ≥ ${covariates.length * 50 + 100} for stable estimates.`
    )

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Moderation Analysis
   *
   * Extracts data for IV, Moderator, DV, and optional covariates.
   * Detects binary DV for logistic moderation.
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (center_predictor, center_moderator, probe_values, jn_interval, confidence)
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
          error: 'Moderation requires at least 3 columns (IV + Moderator + DV)',
        }
      }

      const ivIndex = selectedColumnIndices[0]!
      const moderatorIndex = selectedColumnIndices[1]!
      const dvIndex = selectedColumnIndices[2]!
      const covariateIndices = selectedColumnIndices.slice(3)

      // Columns are already ordered by selection; use local positions for metadata
      const ivCol = columns[0]!
      const moderatorCol = columns[1]!
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
        const wNum = normalizeNumericValue(row[moderatorIndex], moderatorEncoding)
        const yNum = normalizeNumericValue(row[dvIndex], dvEncoding)

        if (xNum === null || wNum === null || yNum === null) {
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
      const Y: number[] = []

      for (const rowIdx of validRowIndices) {
        const row = rows[rowIdx]!
        X.push(normalizeNumericValue(row[ivIndex], ivEncoding)!)
        W.push(normalizeNumericValue(row[moderatorIndex], moderatorEncoding)!)
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
        test: 'moderation_model1',
        data: {
          outcome_data: Y,
          predictor_data: X,
          moderator_data: W,
          outcome_name: dvCol.columnName,
          predictor_name: ivCol.columnName,
          moderator_name: moderatorCol.columnName,
          control_data: controlData.length > 0 ? controlData : undefined,
          control_names: controlNames.length > 0 ? controlNames : undefined,
          categorical_encodings:
            Object.keys(categorical_encodings).length > 0 ? categorical_encodings : undefined,
        },
        parameters: {
          center_predictor: parameters.center_predictor ?? false,
          center_moderator: parameters.center_moderator ?? false,
          jn_interval: parameters.jn_interval ?? [-3, 3], // Johnson-Neyman search range
          confidence: parameters.confidence ?? 0.95,
          seed: parameters.seed ?? 12345,
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
   * Default parameters for Moderation Analysis
   *
   * @returns Default centering, probe values, JN interval, and confidence level
   */
  defaultParameters(): Record<string, any> {
    return {
      center_predictor: false, // Match validation baseline (no centering in model fit)
      center_moderator: false, // Match validation baseline (no centering in model fit)
      jn_interval: [-3, 3], // Johnson-Neyman search range (in SD units)
      confidence: 0.95, // 95% confidence level
      seed: 12345, // Match validation default seed
    }
  },
}
