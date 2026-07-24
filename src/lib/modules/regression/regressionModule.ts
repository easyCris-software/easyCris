/**
 * Regression Module (Linear + Logistic)
 *
 * Phase 4 Implementation:
 * ✅ validateSelection() - validates DV + predictors
 * ✅ buildPayload() - uses extractRegressionPredictors helper
 * ✅ defaultParameters() - returns { alpha: 0.05 }
 *
 * Supports:
 * - Simple Linear Regression (1 numeric predictor)
 * - Multiple Linear Regression (2+ predictors, mixed numeric/categorical)
 * - Binary Logistic Regression (binary DV, 1+ predictors)
 * - Multinomial Logistic Regression (categorical DV with 3+ levels)
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
 * Regression Module
 *
 * Unified module for linear and logistic regression.
 * Automatically detects regression type based on dependent variable:
 * - Continuous DV → Linear Regression
 * - Binary DV → Binary Logistic Regression
 * - Categorical DV (3+ levels) → Multinomial Logistic Regression
 *
 * Requirements:
 * - Minimum 2 columns (1 DV + 1+ predictors)
 * - DV must be numeric for linear, numeric/binary/categorical for logistic
 * - Predictors can be numeric or categorical (auto-encoded)
 *
 * Categorical Encoding:
 * - Baseline encoding: first level alphabetically = 0, others ascend
 * - Stored in categoricalMappings for result decoding
 *
 * Python Backend:
 * - linear_regression: single predictor → x[], y[]
 * - multiple_linear_regression: multiple predictors → X[][], y[]
 * - logistic_regression: binary outcome → X[][], y[]
 * - logistic_multinomial: 3+ outcome levels → X[][], y[]
 */
export const regressionModule: ITestModule = {
  moduleId: 'regression', // Generic ID, actual test determined at runtime

  /**
   * Validate column selection for Regression
   *
   * Validation Rules:
   * 1. Minimum 2 columns required (DV + 1+ predictors)
   * 2. First column is dependent variable (numeric for linear, any for logistic)
   * 3. Remaining columns are predictors (numeric or categorical)
   * 4. For logistic: warn if predictors include ordinal (suggest numeric coding)
   */
  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    const result: TestValidationResult = {
      isValid: false,
      errors: [],
      warnings: [],
      suggestions: [],
    }

    // Check minimum columns
    if (columns.length < 2) {
      result.errors.push(
        `Regression requires at least 2 columns (1 dependent + 1+ predictors). Selected: ${columns.length}.`
      )
      result.suggestions.push(
        'Select at least 2 columns:',
        '  1. Dependent variable (outcome)',
        '  2+. Predictor variables (independent variables)'
      )
      return result
    }

    const dependent = columns[0]!
    const predictors = columns.slice(1)

    // Validate dependent variable exists and has data
    if (dependent.dataType === ColumnDataType.Empty) {
      result.errors.push(`Dependent variable '${dependent.columnName}' is empty.`)
      return result
    }

    // Check for sufficient variance in DV
    if (dependent.uniqueValueCount < 2) {
      result.errors.push(
        `Dependent variable '${dependent.columnName}' has only ${dependent.uniqueValueCount} unique value. Need at least 2 for regression.`
      )
      return result
    }

    // Determine regression type based on DV
    let regressionType: 'linear' | 'logistic_binary' | 'logistic_multinomial'
    if (
      dependent.dataType === ColumnDataType.Numeric ||
      dependent.dataType === ColumnDataType.Ordinal
    ) {
      // Continuous or ordinal with many levels → linear
      if (dependent.uniqueValueCount > 10) {
        regressionType = 'linear'
      } else if (dependent.isBinary || dependent.uniqueValueCount === 2) {
        regressionType = 'logistic_binary'
      } else {
        // 3-10 unique values → could be ordinal or multinomial
        if (dependent.isOrdinal) {
          regressionType = 'linear'
          result.warnings.push(
            `Dependent variable '${dependent.columnName}' appears ordinal with ${dependent.uniqueValueCount} levels. Using linear regression. Consider binary/multinomial logistic if outcome is categorical.`
          )
        } else {
          regressionType = 'logistic_multinomial'
        }
      }
    } else if (dependent.dataType === ColumnDataType.Binary) {
      regressionType = 'logistic_binary'
    } else if (dependent.dataType === ColumnDataType.Categorical) {
      if (dependent.uniqueValueCount === 2) {
        regressionType = 'logistic_binary'
      } else {
        regressionType = 'logistic_multinomial'
      }
    } else {
      result.errors.push(
        `Dependent variable '${dependent.columnName}' has unsupported data type: ${dependent.dataType}.`
      )
      return result
    }

    // Validate predictors
    for (let i = 0; i < predictors.length; i++) {
      const predictor = predictors[i]!

      if (predictor.dataType === ColumnDataType.Empty) {
        result.errors.push(`Predictor '${predictor.columnName}' is empty.`)
        return result
      }

      if (predictor.uniqueValueCount < 2) {
        result.errors.push(
          `Predictor '${predictor.columnName}' has only ${predictor.uniqueValueCount} unique value. Need at least 2 for regression.`
        )
        return result
      }

      // Warn about ordinal predictors (suggest numeric coding)
      if (predictor.isOrdinal && predictor.uniqueValueCount <= 10) {
        result.warnings.push(
          `Predictor '${predictor.columnName}' appears ordinal. It will be treated as categorical (dummy coded). Consider converting to numeric if order matters.`
        )
      }
    }

    // Check minimum sample size (pre-extraction estimate)
    // Rule of thumb: N ≥ 10 × (number of predictors) for linear, 15 × for logistic
    // NOTE: This uses totalValues before pairwise deletion; actual N may be lower
    const minSampleSize =
      regressionType === 'linear'
        ? predictors.length * 10
        : predictors.length * 15

    const totalRows = dependent.totalValues
    if (totalRows < minSampleSize) {
      result.warnings.push(
        `Sample size (N=${totalRows} before removing missing data) is small for ${predictors.length} predictors. Recommended: N ≥ ${minSampleSize}. Actual N may be lower after pairwise deletion.`
      )
    }

    // Add suggestions about regression type
    if (regressionType === 'linear') {
      result.suggestions.push(
        `Linear Regression: Predicting continuous outcome '${dependent.columnName}' from ${predictors.length} predictor(s).`
      )
    } else if (regressionType === 'logistic_binary') {
      result.suggestions.push(
        `Binary Logistic Regression: Predicting binary outcome '${dependent.columnName}' (2 levels) from ${predictors.length} predictor(s).`
      )
    } else {
      result.suggestions.push(
        `Multinomial Logistic Regression: Predicting categorical outcome '${dependent.columnName}' (${dependent.uniqueValueCount} levels) from ${predictors.length} predictor(s).`
      )
    }

    result.isValid = true
    return result
  },

  /**
   * Build Python payload for Regression
   *
   * Extracts aligned dependent + predictors with categorical encoding.
   * Determines test type based on dependent variable characteristics.
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
      const warnings: string[] = []

      if (columns.length < 2 || selectedColumnIndices.length < 2) {
        return {
          success: false,
          error: 'Regression requires at least 2 columns (1 DV + 1+ predictors)',
        }
      }

      const dependentIndex = selectedColumnIndices[0]!
      const predictorIndices = selectedColumnIndices.slice(1)
      const dependentColumn = columns[0]!
      const predictorColumns = columns.slice(1)

      // Extract encodings from parameters (user-selected baselines from dialogs)
      const factorEncodings = parameters.factorEncodings as
        | Record<string, Record<string, number>>
        | undefined
      const outcomeEncoding = parameters.outcomeEncoding as
        | Record<string, number>
        | undefined

      // Extract regression data with categorical encoding
      const result = ColumnDataExtractor.extractRegressionPredictors(
        dependentIndex,
        predictorIndices,
        rows,
        dependentColumn,
        predictorColumns,
        factorEncodings, // Pass user-selected predictor encodings
        outcomeEncoding // Pass user-selected outcome encoding (logistic)
      )

      // Validate sufficient data
      if (result.summary.validRows === 0) {
        return {
          success: false,
          error:
            'No valid data after removing missing values. Check for missing/invalid data in selected columns.',
        }
      }

      // Count unique values in dependent (after extraction)
      const dependentUnique = new Set(result.dependent).size

      // Tier 1 Validation: Block logistic regression if outcomeEncoding is missing.
      // Outcome encoding defines which class is baseline/event and is required for correct interpretation.
      const isLinearDv =
        dependentColumn.dataType === ColumnDataType.Numeric ||
        dependentColumn.dataType === ColumnDataType.Ordinal
      if (!isLinearDv && dependentUnique < 2) {
        return {
          success: false,
          error:
            `Dependent variable '${dependentColumn.columnName}' has only ${dependentUnique} class after removing missing values. ` +
            'Logistic regression requires at least 2 outcome classes.',
        }
      }

      // Check minimum sample size (hard floor for any regression)
      const minSampleSize = Math.max(10, predictorIndices.length + 2)
      if (result.summary.validRows < minSampleSize) {
        return {
          success: false,
          error: `Insufficient sample size: ${result.summary.validRows} observations. With ${predictorIndices.length} predictors, need at least ${minSampleSize} observations.`,
        }
      }

      // Warn if below recommended linear regression sample size
      if (isLinearDv) {
        const recommendedMin = predictorIndices.length * 10
        if (result.summary.validRows < recommendedMin) {
          warnings.push(
            `Sample size (N=${result.summary.validRows}) is low for ${predictorIndices.length} predictors. Recommended: N >= ${recommendedMin}. Estimates/p-values may be unstable.`
          )
        }
      }

      const forceMultiple =
        isLinearDv &&
        predictorIndices.length === 1 &&
        result.predictorNames.length > 1

      if (forceMultiple) {
        const predictorLabel = predictorColumns[0]?.columnName ?? 'predictor'
        const levelCount = predictorColumns[0]?.uniqueValueCount
        const levelText = typeof levelCount === 'number' ? `${levelCount} levels` : 'multiple levels'
        warnings.push(
          `Predictor '${predictorLabel}' has ${levelText} and expands to ${result.predictorNames.length} dummy variables. Running Multiple Linear Regression.`
        )
      }

      // Determine regression type based on dependent variable
      let testName: string
      let payloadData: Record<string, any>

      const willUseLogistic = !isLinearDv

      if (willUseLogistic && !outcomeEncoding) {
        return {
          success: false,
          error:
            'Logistic regression requires outcome encoding to be specified. ' +
            'Please select a baseline level for the dependent variable to ensure correct odds ratio interpretation.',
        }
      }

      if (isLinearDv && predictorIndices.length === 1 && !forceMultiple) {
        // Simple linear regression (single predictor)
        testName = 'linear_regression'
        const predictorName = result.predictorNames[0]!
        payloadData = {
          x: result.predictors[predictorName]!, // Single predictor array
          y: result.dependent,
          predictor_name: predictorName,
          dependent_name: dependentColumn.columnName,
          dummy_variable_info: result.dummyVariableInfo,
        }
      } else if (isLinearDv) {
        // Multiple linear regression (continuous DV)
        testName = 'multiple_linear_regression'

        // Convert predictors dict to 2D array (Python expects X as 2D)
        const X: number[][] = []
        const n = result.summary.validRows
        for (let i = 0; i < n; i++) {
          const row: number[] = []
          for (const predictorName of result.predictorNames) {
            row.push(result.predictors[predictorName]![i]!)
          }
          X.push(row)
        }

        payloadData = {
          X, // 2D array of predictors
          y: result.dependent,
          predictor_names: result.predictorNames,
          dependent_name: dependentColumn.columnName,
          categorical_mappings: result.categoricalMappings,
          dummy_variable_info: result.dummyVariableInfo,
        }
      } else if (dependentUnique === 2) {
        // Binary logistic regression
        testName = 'logistic_regression'

        // Check event count balance (both outcome classes need sufficient observations)
        const eventCounts = new Map<number, number>()
        for (const val of result.dependent) {
          eventCounts.set(val, (eventCounts.get(val) || 0) + 1)
        }
        const minEventCount = Math.min(...Array.from(eventCounts.values()))
        const minEventsPerPredictor = 10 // Rule of thumb: 10 events per predictor
        const requiredMinEvents = result.predictorNames.length * minEventsPerPredictor

        if (minEventCount < requiredMinEvents) {
          warnings.push(
            `Low event count: minority class has ${minEventCount} observations for ${result.predictorNames.length} predictors (recommended ≥ ${requiredMinEvents}). Estimates/p-values may be unstable; consider fewer predictors or more data.`
          )
        }

        // Convert predictors dict to 2D array
        const X: number[][] = []
        const n = result.summary.validRows
        for (let i = 0; i < n; i++) {
          const row: number[] = []
          for (const predictorName of result.predictorNames) {
            row.push(result.predictors[predictorName]![i]!)
          }
          X.push(row)
        }

        payloadData = {
          X,
          y: result.dependent,
          predictor_names: result.predictorNames,
          dependent_name: dependentColumn.columnName,
          categorical_mappings: result.categoricalMappings,
          dependent_mapping: result.dependentMapping,
          dependent_reverse: result.dependentReverse,
          dummy_variable_info: result.dummyVariableInfo,
        }
      } else {
        // Multinomial logistic regression
        testName = 'logistic_multinomial'

        // Check event count for each outcome class
        const eventCounts = new Map<number, number>()
        for (const val of result.dependent) {
          eventCounts.set(val, (eventCounts.get(val) || 0) + 1)
        }
        const minEventCount = Math.min(...Array.from(eventCounts.values()))
        const minEventsPerPredictor = 10 // Rule of thumb: 10 events per predictor per class
        const requiredMinEvents = result.predictorNames.length * minEventsPerPredictor

        if (minEventCount < requiredMinEvents) {
          warnings.push(
            `Low event count: smallest outcome class has ${minEventCount} observations for ${result.predictorNames.length} predictors (recommended ≥ ${requiredMinEvents} per class). Estimates/p-values may be unstable; consider fewer predictors or more data.`
          )
        }

        // Convert predictors dict to 2D array
        const X: number[][] = []
        const n = result.summary.validRows
        for (let i = 0; i < n; i++) {
          const row: number[] = []
          for (const predictorName of result.predictorNames) {
            row.push(result.predictors[predictorName]![i]!)
          }
          X.push(row)
        }

        payloadData = {
          X,
          y: result.dependent,
          predictor_names: result.predictorNames,
          dependent_name: dependentColumn.columnName,
          categorical_mappings: result.categoricalMappings,
          dependent_mapping: result.dependentMapping,
          dependent_reverse: result.dependentReverse,
          dummy_variable_info: result.dummyVariableInfo,
        }
      }

      const payload = {
        test: testName,
        data: payloadData,
        parameters: {
          alpha: parameters.alpha ?? 0.05,
        },
        metadata: warnings.length > 0 ? { warnings } : undefined,
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
   * Default parameters for Regression
   *
   * @returns Default alpha level (significance threshold)
   */
  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
    }
  },
}
