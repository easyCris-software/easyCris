/**
 * Regression Module Contract Tests
 *
 * Tests the contract between TypeScript regression module and Python backend:
 * - validateSelection(): Column validation logic
 * - buildPayload(): Payload construction for linear/logistic regression
 * - defaultParameters(): Default alpha value
 *
 * These tests verify module behavior WITHOUT calling Python backend.
 */

import { describe, it, expect } from 'vitest'
import { regressionModule } from '../regressionModule'
import { ColumnDataType } from '../../core/types'
import { makeColumnClassification, makeRegressionRows } from '@/test-utils/factories'

describe('regressionModule', () => {
  // =========================================================================
  // VALIDATE SELECTION
  // =========================================================================
  describe('validateSelection', () => {
    describe('Column count validation', () => {
      it('should fail when < 2 columns selected', () => {
        // Arrange
        const columns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain('at least 2 columns')
        expect(result.suggestions).toContain('Select at least 2 columns:')
      })

      it('should pass with exactly 2 columns (simple regression)', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ columnName: 'Outcome', dataType: ColumnDataType.Numeric, uniqueValueCount: 50 }),
          makeColumnClassification({ columnName: 'Predictor', dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('Linear Regression')
      })

      it('should pass with 3+ columns (multiple regression)', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Categorical }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })
    })

    describe('Dependent variable validation', () => {
      it('should fail when DV is empty', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ columnName: 'EmptyDV', dataType: ColumnDataType.Empty }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'EmptyDV' is empty")
      })

      it('should fail when DV has only 1 unique value', () => {
        // Arrange
        const columns = [
          makeColumnClassification({
            columnName: 'ConstantDV',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 1,
          }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'ConstantDV' has only 1 unique value")
      })

      it('should detect linear regression for continuous DV', () => {
        // Arrange
        const columns = [
          makeColumnClassification({
            columnName: 'Age',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('Linear Regression')
        expect(result.suggestions[0]).toContain("'Age'")
      })

      it('should detect binary logistic for binary DV', () => {
        // Arrange
        const columns = [
          makeColumnClassification({
            columnName: 'Outcome',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('Binary Logistic Regression')
        expect(result.suggestions[0]).toContain('2 levels')
      })

      it('should detect multinomial logistic for 3+ level categorical DV', () => {
        // Arrange
        const columns = [
          makeColumnClassification({
            columnName: 'Status',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('Multinomial Logistic Regression')
        expect(result.suggestions[0]).toContain('3 levels')
      })

      it('should warn when ordinal DV used with linear regression', () => {
        // Arrange
        const columns = [
          makeColumnClassification({
            columnName: 'Likert',
            dataType: ColumnDataType.Ordinal,
            isOrdinal: true,
            uniqueValueCount: 5,
          }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.warnings[0]).toContain("'Likert' appears ordinal")
        expect(result.warnings[0]).toContain('Consider binary/multinomial logistic')
      })
    })

    describe('Predictor validation', () => {
      it('should fail when predictor is empty', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'EmptyPred', dataType: ColumnDataType.Empty }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'EmptyPred' is empty")
      })

      it('should fail when predictor has only 1 unique value', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({
            columnName: 'ConstantPred',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 1,
          }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'ConstantPred' has only 1 unique value")
      })

      it('should warn about ordinal predictors', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({
            columnName: 'LikertScale',
            dataType: ColumnDataType.Ordinal,
            isOrdinal: true,
            uniqueValueCount: 5,
          }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.warnings[0]).toContain("'LikertScale' appears ordinal")
        expect(result.warnings[0]).toContain('treated as categorical')
      })

      it('should allow numeric predictors', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })

      it('should allow categorical predictors', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Categorical, uniqueValueCount: 3 }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })

      it('should allow mixed numeric and categorical predictors', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Categorical }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })
    })

    describe('Sample size warnings', () => {
      it('should warn when sample size is small for linear regression', () => {
        // Arrange - 3 predictors need N ≥ 30 (10 × 3)
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric, uniqueValueCount: 20, totalValues: 25 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.warnings).toContainEqual(
          expect.stringContaining('Sample size (N=25')
        )
        expect(result.warnings).toContainEqual(
          expect.stringContaining('Recommended: N ≥ 30')
        )
      })

      it('should warn when sample size is small for logistic regression', () => {
        // Arrange - 2 predictors need N ≥ 30 (15 × 2)
        const columns = [
          makeColumnClassification({
            dataType: ColumnDataType.Binary,
            totalValues: 25,
          }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.warnings).toContainEqual(
          expect.stringContaining('Sample size (N=25')
        )
        expect(result.warnings).toContainEqual(
          expect.stringContaining('Recommended: N ≥ 30')
        )
      })

      it('should not warn when sample size is adequate', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric, totalValues: 100 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = regressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.warnings.filter(w => w.includes('Sample size'))).toHaveLength(0)
      })
    })
  })

  // =========================================================================
  // BUILD PAYLOAD
  // =========================================================================
  describe('buildPayload', () => {
    describe('Simple linear regression (1 predictor)', () => {
      it('should build payload for simple linear regression', () => {
        // Arrange
        const rows = makeRegressionRows(100, {
          dv: 'numeric',
          predictors: [{ type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Y', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'X', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1]
        const parameters = { alpha: 0.05 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('linear_regression')
        expect(result.payload?.data).toHaveProperty('x')
        expect(result.payload?.data).toHaveProperty('y')
        expect(result.payload?.data.predictor_name).toBe('X')
        expect(result.payload?.data.dependent_name).toBe('Y')
        expect(result.payload?.parameters.alpha).toBe(0.05)
      })
    })

    describe('Multiple linear regression (2+ predictors)', () => {
      it('should build payload with numeric predictors', () => {
        // Arrange
        const rows = makeRegressionRows(100, {
          dv: 'numeric',
          predictors: [{ type: 'numeric' }, { type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Y', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'X1', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'X2', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.01 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('multiple_linear_regression')
        expect(result.payload?.data.X).toBeDefined()
        expect(result.payload?.data.X).toHaveLength(100)
        expect(result.payload?.data.X[0]).toHaveLength(2) // 2 predictors
        expect(result.payload?.data.predictor_names).toEqual(['X1', 'X2'])
        expect(result.payload?.parameters.alpha).toBe(0.01)
      })

      it('should build payload with categorical predictor (dummy coding)', () => {
        // Arrange
        const rows = makeRegressionRows(100, {
          dv: 'numeric',
          predictors: [
            { type: 'numeric' },
            { type: 'categorical', levels: ['Control', 'Drug', 'Placebo'] },
          ],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Score', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05, outcomeEncoding: { No: 0, Yes: 1 } }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('multiple_linear_regression')
        expect(result.payload?.data.predictor_names).toContain('Age')
        expect(result.payload?.data.predictor_names).toContain('Treatment_Drug')
        expect(result.payload?.data.predictor_names).toContain('Treatment_Placebo')
        expect(result.payload?.data.dummy_variable_info).toBeDefined()
        expect(result.payload?.data.dummy_variable_info.Treatment).toEqual({
          baselineLevel: 'Control',
          dummyLevels: ['Drug', 'Placebo'],
        })
      })
    })

    describe('Binary logistic regression', () => {
      it('should build payload for binary logistic regression', () => {
        // Arrange - Need 2+ predictors for logistic_regression (1 predictor uses simple linear_regression)
        const rows = makeRegressionRows(200, {
          dv: 'binary',
          dvLevels: ['No', 'Yes'],
          predictors: [{ type: 'numeric' }, { type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({
            columnName: 'Outcome',
            dataType: ColumnDataType.Binary,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Weight', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05, outcomeEncoding: { No: 0, Yes: 1 } }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('logistic_regression')
        expect(result.payload?.data.X).toBeDefined()
        expect(result.payload?.data.y).toBeDefined()
        expect(result.payload?.data.dependent_mapping).toBeDefined()
        expect(result.payload?.data.dependent_reverse).toBeDefined()
      })

      it('should succeed when minority class has sufficient events', () => {
        // Arrange - 20 "Yes" outcomes, sufficient for 2 predictors (need 20 = 2 * 10)
        const rows = [
          ...Array.from({ length: 80 }, () => ['No', 25, 70]),
          ...Array.from({ length: 20 }, () => ['Yes', 30, 60]),
        ]
        const columns = [
          makeColumnClassification({
            columnName: 'Outcome',
            dataType: ColumnDataType.Binary,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Weight', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05, outcomeEncoding: { No: 0, Yes: 1 } }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('logistic_regression')
      })
    })

    describe('Multinomial logistic regression', () => {
      it('should build payload for multinomial logistic regression', () => {
        // Arrange - Need 2+ predictors for logistic_multinomial (1 predictor uses simple linear_regression)
        const rows = [
          ...Array.from({ length: 100 }, () => ['Low', 25, 70]),
          ...Array.from({ length: 100 }, () => ['Medium', 30, 75]),
          ...Array.from({ length: 100 }, () => ['High', 35, 80]),
        ]
        const columns = [
          makeColumnClassification({
            columnName: 'Status',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
          makeColumnClassification({ columnName: 'Score', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Weight', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05, outcomeEncoding: { Low: 0, Medium: 1, High: 2 } }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('logistic_multinomial')
        expect(result.payload?.data.X).toBeDefined()
        expect(result.payload?.data.y).toBeDefined()
        expect(result.payload?.data.dependent_mapping).toBeDefined()
      })

      it('should succeed when all classes have sufficient events', () => {
        // Arrange - Balanced: 100 Low, 100 Medium, 100 High (need 20 per class for 2 predictors)
        const rows = [
          ...Array.from({ length: 100 }, () => ['Low', 25, 70]),
          ...Array.from({ length: 100 }, () => ['Medium', 30, 75]),
          ...Array.from({ length: 100 }, () => ['High', 35, 80]),
        ]
        const columns = [
          makeColumnClassification({
            columnName: 'Status',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
          makeColumnClassification({ columnName: 'Score', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Weight', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05, outcomeEncoding: { Low: 0, Medium: 1, High: 2 } }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('logistic_multinomial')
      })
    })

    describe('Error handling', () => {
      it('should fail when < 2 columns provided', () => {
        // Arrange
        const rows = [[10], [20]]
        const columns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]
        const indices = [0]
        const parameters = { alpha: 0.05 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(false)
        expect(result.error).toContain('at least 2 columns')
      })

      it('should fail when all rows have missing data', () => {
        // Arrange
        const rows = Array.from({ length: 100 }, () => [null, null])
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1]
        const parameters = { alpha: 0.05 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(false)
        expect(result.error).toContain('No valid data after removing missing values')
      })

      it('should warn when sample size is below recommended after pairwise deletion', () => {
        // Arrange - 3 predictors recommended 30 observations, only 20 valid
        const validRows = makeRegressionRows(20, {
          dv: 'numeric',
          predictors: [{ type: 'numeric' }, { type: 'numeric' }, { type: 'numeric' }],
        })
        const invalidRows = Array.from({ length: 80 }, () => [null, null, null, null])
        const rows = [...validRows, ...invalidRows]
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2, 3]
        const parameters = { alpha: 0.05 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.metadata?.warnings?.[0]).toContain(
          'Sample size (N=20) is low for 3 predictors'
        )
      })
    })

    describe('Encoding mappings', () => {
      it('should return encodingMappings for categorical predictors', () => {
        // Arrange
        const rows = makeRegressionRows(100, {
          dv: 'numeric',
          predictors: [{ type: 'categorical', levels: ['A', 'B', 'C'] }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Y', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({
            columnName: 'Group',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
        ]
        const indices = [0, 1]
        const parameters = { alpha: 0.05 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.encodingMappings).toBeDefined()
        expect(result.encodingMappings?.get('Group')).toBeDefined()
      })

      it('should return empty encodingMappings when all predictors are numeric', () => {
        // Arrange
        const rows = makeRegressionRows(100, {
          dv: 'numeric',
          predictors: [{ type: 'numeric' }, { type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric, uniqueValueCount: 50 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = regressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        // When no categorical predictors, categoricalMappings is empty object, which creates empty Map
        expect(result.encodingMappings).toBeDefined()
        expect(result.encodingMappings?.size).toBe(0)
      })
    })
  })

  // =========================================================================
  // DEFAULT PARAMETERS
  // =========================================================================
  describe('defaultParameters', () => {
    it('should return default alpha of 0.05', () => {
      // Act
      const params = regressionModule.defaultParameters()

      // Assert
      expect(params).toEqual({ alpha: 0.05 })
    })
  })
})
