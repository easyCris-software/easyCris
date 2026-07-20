/**
 * Cox Proportional Hazards Regression Module
 *
 * Phase 4 Implementation:
 * ✅ validateSelection() - validates time + event + covariates
 * ✅ buildPayload() - uses extractSurvivalData helper
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 *
 * Cox Regression:
 * - Semi-parametric model for survival analysis
 * - Estimates hazard ratios for covariates
 * - Does not assume specific baseline hazard distribution
 * - Assumes proportional hazards (hazard ratio constant over time)
 */

import type {
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  BuildPayloadResult,
  ValidateOptions,
} from '../core/types'
import { ColumnDataType } from '../core/types'
import { ColumnDataExtractor } from '../core/ColumnDataExtractor'


/**
 * Cox Proportional Hazards Module
 *
 * Models the effect of covariates on survival time.
 * Estimates hazard ratios (HR) for each covariate.
 *
 * Requirements:
 * - Minimum 3 columns: time-to-event + event indicator + 1+ covariates
 * - Time must be non-negative numeric
 * - Event must be binary (2 unique values). Non-numeric labels are allowed and will be mapped.
 * - Covariates can be numeric or categorical (auto-encoded)
 *
 * Outputs:
 * - Hazard ratios with confidence intervals
 * - Coefficients, standard errors, z-scores, p-values
 * - Concordance index (C-index) for model performance
 * - Partial likelihood ratio test
 * - Schoenfeld residuals test for proportional hazards assumption
 *
 * Use Cases:
 * - Clinical trials: effect of treatment on survival controlling for age, stage
 * - Adjusting for confounders in survival analysis
 * - Identifying prognostic factors
 */
export const coxRegressionModule: ITestModule = {
  moduleId: 'cox_regression',

  /**
   * Validate column selection for Cox Regression
   *
   * Validation Rules:
   * 1. Minimum 3 columns required (time + event + 1+ covariates)
   * 2. Time column must be numeric
   * 3. Event column must be binary (2 unique values)
   * 4. Covariate columns can be numeric or categorical
   * 5. Sufficient sample size for number of covariates
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    // Check column count
    if (columns.length < 3) {
      return {
        isValid: false,
        errors: [
          `Cox Regression requires at least 3 columns (time + event + 1+ covariates). Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 3 columns:',
          '  1. Time-to-event (numeric, non-negative)',
          '  2. Event indicator (binary: 0=censored, 1=event)',
          '  3+. Covariates (numeric or categorical)',
        ],
      }
    }

    const timeCol = columns[0]!
    const eventCol = columns[1]!
    const covariates = columns.slice(2)

    // Validate time column
    if (timeCol.dataType !== ColumnDataType.Numeric) {
      return {
        isValid: false,
        errors: [
          `Time column '${timeCol.columnName}' must be numeric (found: ${timeCol.dataType}).`,
        ],
        warnings: [],
        suggestions: ['Time-to-event should be a positive numeric value.'],
      }
    }

    // Validate event column
    if (eventCol.uniqueValueCount !== 2) {
      return {
        isValid: false,
        errors: [
          `Event column '${eventCol.columnName}' must be binary with exactly 2 values. Found ${eventCol.uniqueValueCount} unique values.`,
        ],
        warnings: [],
        suggestions: [
          'Event indicator should have exactly 2 unique values.',
          'If values are not 0/1 or true/false, you will be prompted to map event vs censored.',
        ],
      }
    }

    // Validate covariates
    for (let i = 0; i < covariates.length; i++) {
      const covariate = covariates[i]!

      if (covariate.dataType === ColumnDataType.Empty) {
        return {
          isValid: false,
          errors: [`Covariate '${covariate.columnName}' is empty.`],
          warnings: [],
          suggestions: [],
        }
      }

      if (covariate.uniqueValueCount < 2) {
        return {
          isValid: false,
          errors: [
            `Covariate '${covariate.columnName}' has only ${covariate.uniqueValueCount} unique value. Need at least 2 for regression.`,
          ],
          warnings: [],
          suggestions: [],
        }
      }
    }

    // Check minimum sample size
    // Rule of thumb: Need at least 10 events per covariate
    const nCovariates = covariates.length
    const minEvents = nCovariates * 10

    const suggestions: string[] = []
    const warnings: string[] = []

    suggestions.push(
      `Cox Regression with ${nCovariates} covariate(s). Recommended: at least ${minEvents} events for reliable estimates.`
    )

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  /**
   * Build Python payload for Cox Regression
   *
   * Extracts aligned time, event, and covariate data.
   * Numeric covariates are used as-is.
   * Categorical covariates would be encoded (currently simplified - numeric only).
   *
   * @param columns - Classified columns (already validated)
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha)
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
          error: 'Cox Regression requires at least 3 columns (time + event + 1+ covariates)',
        }
      }

      const timeIndex = selectedColumnIndices[0]!
      const eventIndex = selectedColumnIndices[1]!
      const covariateIndices = selectedColumnIndices.slice(2)
      const covariateColumns = columns.slice(2)

      const eventEncoding = parameters.event_encoding as
        | { eventValue: string; censoredValue: string; wasEncoded?: boolean }
        | undefined
      const covariateEncodings = parameters.covariate_encodings as
        | Record<string, { trueValue: string; falseValue: string; wasEncoded?: boolean }>
        | undefined

      // Extract survival data with covariates
      const result = ColumnDataExtractor.extractSurvivalData(
        timeIndex,
        eventIndex,
        rows,
        undefined, // No group column for Cox
        covariateIndices,
        undefined, // No group column classification
        covariateColumns,
        eventEncoding ? { eventValue: eventEncoding.eventValue, censoredValue: eventEncoding.censoredValue } : undefined,
        covariateEncodings
      )

      // Validate sufficient data
      if (result.summary.validRows === 0) {
        return {
          success: false,
          error:
            'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      // Check minimum sample size
      // NOTE: Use actual parameter count (result.covariateNames) after dummy expansion
      const actualParamCount = result.covariateNames!.length
      const minSampleSize = actualParamCount * 10
      if (result.summary.validRows < minSampleSize) {
        return {
          success: false,
          error: `Insufficient sample size: ${result.summary.validRows} observations. With ${actualParamCount} model parameters (after dummy encoding), need at least ${minSampleSize} observations.`,
        }
      }

      // Check that at least some events occurred
      if (result.summary.nEvents === 0) {
        return {
          success: false,
          error: `No events observed in data. All ${result.summary.validRows} observations are censored. Cannot fit Cox model.`,
        }
      }

      // Check minimum events per covariate
      // Rule of thumb: 5-10 events per parameter (using actual parameter count after dummy expansion)
      const minEvents = actualParamCount * 5
      if (result.summary.nEvents < minEvents) {
        return {
          success: false,
          error: `Insufficient events: ${result.summary.nEvents} events observed. With ${actualParamCount} model parameters (after dummy encoding), need at least ${minEvents} events.`,
        }
      }

      // Build Python payload
      // Python expects covariates as a dictionary: { "CovName": [values] }
      // Categorical covariates are already encoded as dummy variables
      const payload = {
        test: 'cox_regression',
        data: {
          times: result.times,
          events: result.events,
          covariates: result.covariates!, // Already a dict with dummy variables
          time_name: columns[0]!.columnName,
          event_name: columns[1]!.columnName,
          covariate_names: result.covariateNames!,
          categorical_mappings: result.categoricalMappings,
          dummy_variable_info: result.dummyVariableInfo,
        },
        parameters: {
          alpha: parameters.alpha ?? 0.05,
          ...(eventEncoding ? { event_encoding: eventEncoding } : {}),
        },
      }

      return {
        success: true,
        payload,
        encodingMappings: result.categoricalMappings
          ? new Map(
              Object.entries(result.categoricalMappings).map(([k, v]) => [
                k,
                new Map(Object.entries(v)),
              ])
            )
          : undefined,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  },

  /**
   * Default parameters for Cox Regression
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
