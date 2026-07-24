/**
 * Validation Service
 *
 * Implements the 5-layer validation system from original easyCris:
 * 1. Structural Validation - Data structure and format
 * 2. Type Validation - Column types and data types
 * 3. Range Validation - Numeric ranges, missing values
 * 4. Statistical Validation - Assumptions (normality, homogeneity)
 * 5. Test-Specific Validation - Test-specific requirements
 *
 * This service performs CLIENT-SIDE validation before sending to backend.
 * Backend performs additional validation for security and data integrity.
 */

import type {
  StatisticalTest,
  TestParameter,
  ValidationResult,
} from '@/store/analysis-store'
import type { Dataset, ColumnMetadata } from '@/store/data-store'
import { classifyColumn, ColumnDataType, type ColumnClassification } from './columnDataService'

/**
 * Validation error with layer context
 */
export interface ValidationError {
  layer:
    | 'structural'
    | 'type'
    | 'range'
    | 'statistical'
    | 'test-specific'
  field?: string
  message: string
  severity: 'error' | 'warning'
}

/**
 * User-friendly guidance messages for validation errors
 * Uses 6-type column classification from columnDataService
 */
export const GuidanceMessages = {
  categoricalInNumericTest: (colName: string, classification: ColumnClassification) =>
    `Column "${colName}" is ${classification.dataType} (${classification.uniqueValueCount} unique values). ` +
    `For numeric tests, consider: ${classification.suggestedTests.join(', ')}.`,

  numericInCategoricalTest: (colName: string) =>
    `Column "${colName}" appears numeric but you selected a categorical test. ` +
    `Consider using T-Test, ANOVA, or Correlation instead.`,

  emptyColumn: (colName: string) =>
    `Column "${colName}" has no data. Please select a different column.`,

  binaryInContinuousTest: (colName: string) =>
    `Column "${colName}" is binary (2 unique values). ` +
    `Consider using Chi-Square Test or Independent T-Test instead.`,

  ordinalInParametricTest: (colName: string) =>
    `Column "${colName}" appears to be ordinal (Likert scale). ` +
    `Consider using Spearman Correlation or Mann-Whitney U Test for better accuracy.`,

  insufficientUniqueValues: (colName: string, uniqueCount: number) =>
    `Column "${colName}" has only ${uniqueCount} unique values. ` +
    `Most statistical tests require more variation.`,

  mixedDataWarning: (colName: string, numericRatio: number) =>
    `Column "${colName}" is ${(numericRatio * 100).toFixed(0)}% numeric. ` +
    `Clean the data (remove non-numeric values) or encode categorically.`,

  missingDataWarning: (colName: string, missingPercent: number) =>
    `Column "${colName}" has ${missingPercent.toFixed(1)}% missing values. ` +
    `Results may be unreliable. Consider removing rows or imputing values.`,
}

/**
 * Test suggestions based on column type
 */
export const Suggestions = {
  forCategorical: ['Chi-Square Test', "Fisher's Exact Test", 'Logistic Regression'],
  forNumeric: ['T-Test', 'ANOVA', 'Linear Regression', 'Pearson Correlation'],
  forBinary: ['Chi-Square Test', 'Independent T-Test', 'Logistic Regression'],
  forOrdinal: ['Spearman Correlation', 'Mann-Whitney U', 'Kruskal-Wallis'],
  forMixed: ['Clean data first', 'Encode as categorical', 'Remove non-numeric rows'],
}

/**
 * Validation Service
 */
export const validationService = {
  /**
   * Validate all layers for a statistical test
   *
   * @param test - Statistical test definition
   * @param parameters - Test parameters
   * @param dataset - Current dataset
   * @returns Validation result with errors and warnings
   */
  async validateAll(
    test: StatisticalTest,
    parameters: Record<string, unknown>,
    dataset: Dataset | null
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []

    // Layer 1: Structural Validation
    const structuralErrors = this.validateStructure(test, parameters, dataset)
    errors.push(...structuralErrors.filter(e => e.severity === 'error'))
    warnings.push(...structuralErrors.filter(e => e.severity === 'warning'))

    // Short-circuit if structural validation fails
    if (structuralErrors.some(e => e.severity === 'error')) {
      return {
        isValid: false,
        layer: 'structural',
        errors: errors.map(e => e.message),
        warnings: warnings.map(w => w.message),
        timestamp: new Date(),
      }
    }

    // Layer 2: Type Validation
    const typeErrors = this.validateTypes(test, parameters, dataset!)
    errors.push(...typeErrors.filter(e => e.severity === 'error'))
    warnings.push(...typeErrors.filter(e => e.severity === 'warning'))

    if (typeErrors.some(e => e.severity === 'error')) {
      return {
        isValid: false,
        layer: 'type',
        errors: errors.map(e => e.message),
        warnings: warnings.map(w => w.message),
        timestamp: new Date(),
      }
    }

    // Layer 3: Range Validation
    const rangeErrors = this.validateRanges(test, parameters, dataset!)
    errors.push(...rangeErrors.filter(e => e.severity === 'error'))
    warnings.push(...rangeErrors.filter(e => e.severity === 'warning'))

    if (rangeErrors.some(e => e.severity === 'error')) {
      return {
        isValid: false,
        layer: 'range',
        errors: errors.map(e => e.message),
        warnings: warnings.map(w => w.message),
        timestamp: new Date(),
      }
    }

    // Layer 4: Statistical Validation (assumptions)
    // NOTE: This requires actual data analysis - delegate to backend
    // For client-side, just warn about common issues

    // Layer 5: Test-Specific Validation
    const testSpecificErrors = this.validateTestSpecific(
      test,
      parameters,
      dataset!
    )
    errors.push(...testSpecificErrors.filter(e => e.severity === 'error'))
    warnings.push(...testSpecificErrors.filter(e => e.severity === 'warning'))

    const isValid = errors.length === 0

    return {
      isValid,
      layer: isValid ? null : 'test-specific',
      errors: errors.map(e => e.message),
      warnings: warnings.map(w => w.message),
      timestamp: new Date(),
    }
  },

  /**
   * Layer 1: Structural Validation
   * Checks: Dataset exists, required parameters present, column count
   */
  validateStructure(
    test: StatisticalTest,
    parameters: Record<string, unknown>,
    dataset: Dataset | null
  ): ValidationError[] {
    const errors: ValidationError[] = []

    // Dataset exists
    if (!dataset) {
      errors.push({
        layer: 'structural',
        message: 'No dataset loaded. Please import data first.',
        severity: 'error',
      })
      return errors // Short-circuit
    }

    const actualRowCount = dataset.dataRowCount ?? dataset.rowCount

    // Required parameters present
    for (const param of test.parameters.filter(p => p.required)) {
      if (
        parameters[param.name] === undefined ||
        parameters[param.name] === null ||
        parameters[param.name] === ''
      ) {
        errors.push({
          layer: 'structural',
          field: param.name,
          message: `Required parameter "${param.name}" is missing.`,
          severity: 'error',
        })
      }
    }

    // Column count requirement
    if (dataset.columnCount < test.requiredColumns) {
      errors.push({
        layer: 'structural',
        message: `Test requires at least ${test.requiredColumns} columns, but dataset has only ${dataset.columnCount}.`,
        severity: 'error',
      })
    }

    // Minimum row count (general rule: need at least 3 observations)
    if (actualRowCount < 3) {
      errors.push({
        layer: 'structural',
        message: `Dataset has only ${actualRowCount} rows. Most statistical tests require at least 3 observations.`,
        severity: 'error',
      })
    }

    return errors
  },

  /**
   * Layer 2: Type Validation
   * Checks: Column types match test requirements, parameter types correct
   */
  validateTypes(
    test: StatisticalTest,
    parameters: Record<string, unknown>,
    dataset: Dataset
  ): ValidationError[] {
    const errors: ValidationError[] = []

    // Validate parameter types
    for (const param of test.parameters) {
      const value = parameters[param.name]
      if (value === undefined || value === null) continue // Handled in structural

      const actualType = typeof value
      const expectedType = this.getExpectedJSType(param.type)

      if (param.type === 'column' || param.type === 'columns') {
        // Column reference validation
        const columnNames = Array.isArray(value) ? value : [value]
        for (const colName of columnNames) {
          const column = dataset.columns.find(c => c.name === colName)
          if (!column) {
            errors.push({
              layer: 'type',
              field: param.name,
              message: `Column "${colName}" not found in dataset.`,
              severity: 'error',
            })
          }
        }
      } else if (expectedType && actualType !== expectedType) {
        errors.push({
          layer: 'type',
          field: param.name,
          message: `Parameter "${param.name}" expects ${expectedType}, got ${actualType}.`,
          severity: 'error',
        })
      }
    }

    // Validate required column types (if test specifies)
    if (test.requiredColumnTypes) {
      const selectedColumns = this.getSelectedColumns(parameters, dataset, test)

      for (let i = 0; i < test.requiredColumnTypes.length; i++) {
        const requiredType = test.requiredColumnTypes[i]
        const column = selectedColumns[i]

        if (column && column.type !== requiredType) {
          errors.push({
            layer: 'type',
            field: column.name,
            message: `Column "${column.name}" must be ${requiredType}, but is ${column.type}.`,
            severity: 'error',
          })
        }
      }
    }

    return errors
  },

  /**
   * Layer 3: Range Validation
   * Checks: Numeric ranges, sample sizes, missing values
   */
  validateRanges(
    test: StatisticalTest,
    parameters: Record<string, unknown>,
    dataset: Dataset
  ): ValidationError[] {
    const errors: ValidationError[] = []

    // Validate numeric parameter ranges
    for (const param of test.parameters) {
      const value = parameters[param.name]
      if (value === undefined || value === null) continue

      if (
        param.type === 'numeric' &&
        typeof value === 'number'
      ) {
        if (param.min !== undefined && value < param.min) {
          errors.push({
            layer: 'range',
            field: param.name,
            message: `Parameter "${param.name}" (${value}) is below minimum (${param.min}).`,
            severity: 'error',
          })
        }
        if (param.max !== undefined && value > param.max) {
          errors.push({
            layer: 'range',
            field: param.name,
            message: `Parameter "${param.name}" (${value}) is above maximum (${param.max}).`,
            severity: 'error',
          })
        }
      }
    }

    // Check for excessive missing data
    const actualRowCount = dataset.dataRowCount ?? dataset.rowCount
    const selectedColumns = this.getSelectedColumns(parameters, dataset, test)
    for (const column of selectedColumns) {
      if (column.statistics?.missing) {
        const missingPercent =
          (column.statistics.missing / Math.max(actualRowCount, 1)) * 100
        if (missingPercent > 50) {
          errors.push({
            layer: 'range',
            field: column.name,
            message: `Column "${column.name}" has ${missingPercent.toFixed(1)}% missing values. Results may be unreliable.`,
            severity: 'warning',
          })
        }
      }
    }

    return errors
  },

  /**
   * Layer 4: Statistical Validation
   * NOTE: Actual assumption tests (normality, homogeneity) require data analysis.
   * This is delegated to the backend Python service.
   * Client-side only performs basic checks.
   */
  validateStatisticalAssumptions(
    test: StatisticalTest,
    dataset: Dataset
  ): ValidationError[] {
    const warnings: ValidationError[] = []

    const sampleSize = dataset.dataRowCount ?? dataset.rowCount

    // Sample size warnings for parametric tests
    if (test.family === 'parametric' && sampleSize < 30) {
      warnings.push({
        layer: 'statistical',
        message: `Small sample size (n=${sampleSize}). Consider using nonparametric tests.`,
        severity: 'warning',
      })
    }

    return warnings
  },

  /**
   * Layer 5: Test-Specific Validation
   * Custom validation rules per test family
   */
  validateTestSpecific(
    test: StatisticalTest,
    parameters: Record<string, unknown>,
    dataset: Dataset
  ): ValidationError[] {
    const errors: ValidationError[] = []

    switch (test.family) {
      case 'anova':
        // ANOVA: Need at least 2 groups
        if (test.id.includes('one-way')) {
          const groupColumn = this.getColumnByParameter(
            parameters,
            'groupColumn',
            dataset
          )
          if (groupColumn && groupColumn.statistics?.unique) {
            if (groupColumn.statistics.unique < 2) {
              errors.push({
                layer: 'test-specific',
                message: 'ANOVA requires at least 2 groups.',
                severity: 'error',
              })
            }
          }
        }
        break

      case 'regression':
        // Regression: Need sufficient observations (rule of thumb: 10-20 per predictor)
        if (test.id.includes('multiple')) {
          const predictorCount =
            (parameters.predictorColumns as string[])?.length || 0
          const minObservations = predictorCount * 10

          const actualRows = dataset.dataRowCount ?? dataset.rowCount
          if (actualRows < minObservations) {
            errors.push({
              layer: 'test-specific',
              message: `Multiple regression with ${predictorCount} predictors needs at least ${minObservations} observations. Current: ${actualRows}.`,
              severity: 'warning',
            })
          }
        }
        break

      case 'survival':
        // Survival: Need event and time columns
        if (!parameters.timeColumn || !parameters.eventColumn) {
          errors.push({
            layer: 'test-specific',
            message: 'Survival analysis requires both time and event columns.',
            severity: 'error',
          })
        }
        break

      case 'pharmacology':
        // Dose-response: Need dose and response columns
        if (!parameters.doseColumn || !parameters.responseColumn) {
          errors.push({
            layer: 'test-specific',
            message:
              'Dose-response analysis requires both dose and response columns.',
            severity: 'error',
          })
        }
        break
    }

    return errors
  },

  /**
   * Helper: Get expected JavaScript type from parameter type
   */
  getExpectedJSType(
    paramType: TestParameter['type']
  ): 'string' | 'number' | 'boolean' | 'object' | null {
    const typeMap: Record<string, 'string' | 'number' | 'boolean' | 'object'> = {
      numeric: 'number',
      categorical: 'string',
      boolean: 'boolean',
      column: 'string',
      columns: 'object', // Array of strings
    }
    return typeMap[paramType] || null
  },

  /**
   * Helper: Get selected columns from parameters
   * IMPORTANT: Only considers parameters with type='column' or 'columns'
   * to avoid treating numeric strings like "0.05" as column names
   */
  getSelectedColumns(
    parameters: Record<string, unknown>,
    dataset: Dataset,
    test?: StatisticalTest
  ): ColumnMetadata[] {
    const columns: ColumnMetadata[] = []

    // If test definition provided, filter by parameter type
    if (test) {
      for (const param of test.parameters) {
        if (param.type !== 'column' && param.type !== 'columns') continue

        const value = parameters[param.name]
        if (!value) continue

        if (typeof value === 'string') {
          const column = dataset.columns.find(c => c.name === value)
          if (column) columns.push(column)
        } else if (Array.isArray(value)) {
          for (const colName of value) {
            if (typeof colName === 'string') {
              const column = dataset.columns.find(c => c.name === colName)
              if (column) columns.push(column)
            }
          }
        }
      }
      return columns
    }

    // Fallback: Without test definition, assume string/array values are columns
    // (Legacy behavior - less precise but prevents breaking changes)
    for (const [_key, value] of Object.entries(parameters)) {
      if (typeof value === 'string') {
        const column = dataset.columns.find(c => c.name === value)
        if (column) columns.push(column)
      } else if (Array.isArray(value)) {
        for (const colName of value) {
          if (typeof colName === 'string') {
            const column = dataset.columns.find(c => c.name === colName)
            if (column) columns.push(column)
          }
        }
      }
    }

    return columns
  },

  /**
   * Helper: Get column by parameter name
   */
  getColumnByParameter(
    parameters: Record<string, unknown>,
    paramName: string,
    dataset: Dataset
  ): ColumnMetadata | null {
    const value = parameters[paramName]
    if (typeof value === 'string') {
      return dataset.columns.find(c => c.name === value) || null
    }
    return null
  },
}

/**
 * Test-specific validators using 6-type column classification
 * These use columnDataService for enhanced type detection
 */

/**
 * Validate T-Test columns
 * Checks for numeric data, binary warnings, missing data
 */
export function validateTTest(
  column1: string,
  column2: string | undefined,
  dataset: Dataset,
  rowData: Map<number, Record<string, unknown>>
): ValidationError[] {
  const errors: ValidationError[] = []

  // Classify column1
  const col1 = dataset.columns.find(c => c.name === column1)
  if (!col1) return [{ layer: 'structural', message: 'Column not found', severity: 'error' }]

  const classification1 = classifyColumn(col1.id, col1.name, rowData)

  // Check if numeric
  if (classification1.dataType === ColumnDataType.Empty) {
    errors.push({
      layer: 'type',
      message: GuidanceMessages.emptyColumn(column1),
      severity: 'error',
    })
  } else if (classification1.dataType === ColumnDataType.Categorical) {
    errors.push({
      layer: 'type',
      message: GuidanceMessages.categoricalInNumericTest(column1, classification1),
      severity: 'error',
    })
  } else if (classification1.dataType === ColumnDataType.Binary) {
    errors.push({
      layer: 'type',
      message: GuidanceMessages.binaryInContinuousTest(column1),
      severity: 'warning',
    })
  } else if (classification1.dataType === ColumnDataType.Mixed) {
    errors.push({
      layer: 'type',
      message: GuidanceMessages.mixedDataWarning(column1, classification1.numericRatio),
      severity: 'warning',
    })
  }

  // Check missing data
  if (classification1.hasMissingData) {
    const missingPercent = (classification1.missingValues / classification1.totalValues) * 100
    if (missingPercent > 10) {
      errors.push({
        layer: 'range',
        message: GuidanceMessages.missingDataWarning(column1, missingPercent),
        severity: 'warning',
      })
    }
  }

  // If paired t-test, validate column2
  if (column2) {
    const col2 = dataset.columns.find(c => c.name === column2)
    if (!col2) return errors

    const classification2 = classifyColumn(col2.id, col2.name, rowData)

    if (classification2.dataType === ColumnDataType.Categorical) {
      errors.push({
        layer: 'type',
        message: GuidanceMessages.categoricalInNumericTest(column2, classification2),
        severity: 'error',
      })
    }
  }

  return errors
}

/**
 * Validate ANOVA columns
 * Dependent variable must be numeric, grouping variable must have ≥2 groups
 */
export function validateANOVA(
  dependentColumn: string,
  groupColumn: string,
  dataset: Dataset,
  rowData: Map<number, Record<string, unknown>>
): ValidationError[] {
  const errors: ValidationError[] = []

  // Validate dependent variable (numeric)
  const depCol = dataset.columns.find(c => c.name === dependentColumn)
  if (!depCol)
    return [{ layer: 'structural', message: 'Dependent column not found', severity: 'error' }]

  const depClassification = classifyColumn(depCol.id, depCol.name, rowData)

  if (depClassification.dataType !== ColumnDataType.Numeric) {
    errors.push({
      layer: 'type',
      message: `Dependent variable must be numeric. "${dependentColumn}" is ${depClassification.dataType}.`,
      severity: 'error',
    })
  }

  // Validate grouping variable (categorical with ≥2 groups)
  const grpCol = dataset.columns.find(c => c.name === groupColumn)
  if (!grpCol) return errors

  const grpClassification = classifyColumn(grpCol.id, grpCol.name, rowData)

  if (grpClassification.uniqueValueCount < 2) {
    errors.push({
      layer: 'test-specific',
      message: 'ANOVA requires at least 2 groups.',
      severity: 'error',
    })
  }

  if (
    grpClassification.dataType === ColumnDataType.Numeric &&
    grpClassification.uniqueValueCount > 10
  ) {
    errors.push({
      layer: 'type',
      message: GuidanceMessages.numericInCategoricalTest(groupColumn),
      severity: 'warning',
    })
  }

  return errors
}

/**
 * Validate Correlation columns
 * Both columns must be numeric with sufficient unique values
 */
export function validateCorrelation(
  column1: string,
  column2: string,
  dataset: Dataset,
  rowData: Map<number, Record<string, unknown>>
): ValidationError[] {
  const errors: ValidationError[] = []

  // Both columns must be numeric
  for (const colName of [column1, column2]) {
    const col = dataset.columns.find(c => c.name === colName)
    if (!col) continue

    const classification = classifyColumn(col.id, col.name, rowData)

    if (classification.dataType === ColumnDataType.Ordinal) {
      errors.push({
        layer: 'type',
        message: GuidanceMessages.ordinalInParametricTest(colName),
        severity: 'warning',
      })
    } else if (classification.dataType !== ColumnDataType.Numeric) {
      errors.push({
        layer: 'type',
        message: `Correlation requires numeric columns. "${colName}" is ${classification.dataType}.`,
        severity: 'error',
      })
    }

    if (classification.uniqueValueCount < 5) {
      errors.push({
        layer: 'test-specific',
        message: GuidanceMessages.insufficientUniqueValues(
          colName,
          classification.uniqueValueCount
        ),
        severity: 'warning',
      })
    }
  }

  return errors
}

export default validationService
