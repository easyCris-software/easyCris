/**
 * ColumnDataExtractor - Regression Extraction Tests
 *
 * Tests extractRegressionPredictors method which handles:
 * - Categorical dependent variable encoding (Phase 4 critical fix)
 * - Dummy variable encoding (k-1) for categorical predictors (Phase 4 critical fix)
 * - Pairwise deletion
 * - Summary metadata
 */

import { describe, it, expect } from 'vitest'
import { ColumnDataExtractor } from '../ColumnDataExtractor'
import { ColumnDataType } from '../types'
import { makeColumnClassification, makeRegressionRows } from '@/test-utils/factories'

describe('ColumnDataExtractor.extractRegressionPredictors', () => {
  // =========================================================================
  // CATEGORICAL DEPENDENT VARIABLE ENCODING (Phase 4 Critical Fix)
  // =========================================================================
  describe('Categorical dependent variable encoding', () => {
    it('should encode binary DV with labels "Yes/No" to 0/1', () => {
      // Arrange
      const rows = [
        ['No', 10],
        ['Yes', 20],
        ['No', 30],
        ['Yes', 40],
      ]
      const depColumn = makeColumnClassification({
        columnName: 'Outcome',
        dataType: ColumnDataType.Binary,
        isBinary: true,
        uniqueValueCount: 2,
      })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Age',
          dataType: ColumnDataType.Numeric,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(
        0, // depIndex
        [1], // predIndices
        rows,
        depColumn,
        predColumns
      )

      // Assert
      expect(result.dependent).toEqual([0, 1, 0, 1]) // No=0, Yes=1 (alphabetical)
      expect(result.dependentMapping).toEqual({ no: 0, yes: 1 })
      expect(result.dependentReverse).toEqual({ 0: 'No', 1: 'Yes' })
      expect(result.summary.validRows).toBe(4)
    })

    it('should encode binary DV with labels "Control/Drug" to 0/1', () => {
      // Arrange
      const rows = [
        ['Control', 10],
        ['Drug', 20],
        ['Control', 30],
      ]
      const depColumn = makeColumnClassification({
        dataType: ColumnDataType.Binary,
        isBinary: true,
      })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.dependent).toEqual([0, 1, 0]) // Control=0, Drug=1
      expect(result.dependentMapping).toEqual({ control: 0, drug: 1 })
      expect(result.dependentReverse).toEqual({ 0: 'Control', 1: 'Drug' })
    })

    it('should encode binary DV with labels "True/False" to 0/1', () => {
      // Arrange
      const rows = [
        ['True', 10],
        ['False', 20],
        ['True', 30],
      ]
      const depColumn = makeColumnClassification({
        dataType: ColumnDataType.Binary,
        isBinary: true,
      })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.dependent).toEqual([1, 0, 1]) // False=0, True=1 (alphabetical)
      expect(result.dependentMapping).toEqual({ false: 0, true: 1 })
    })

    it('should encode 3-level categorical DV to 0/1/2', () => {
      // Arrange
      const rows = [
        ['Low', 10],
        ['Medium', 20],
        ['High', 30],
        ['Low', 40],
      ]
      const depColumn = makeColumnClassification({
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
      })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.dependent).toEqual([1, 2, 0, 1]) // High=0, Low=1, Medium=2 (alphabetical)
      expect(result.dependentMapping).toEqual({ high: 0, low: 1, medium: 2 })
      expect(result.dependentReverse).toEqual({ 0: 'High', 1: 'Low', 2: 'Medium' })
    })

    it('should preserve alphabetical order for categorical DV encoding', () => {
      // Arrange
      const rows = [
        ['Z', 10],
        ['A', 20],
        ['M', 30],
      ]
      const depColumn = makeColumnClassification({
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
      })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert - should be sorted alphabetically
      expect(result.dependentMapping).toEqual({ a: 0, m: 1, z: 2 })
      expect(result.dependent).toEqual([2, 0, 1])
    })
  })

  // =========================================================================
  // DUMMY VARIABLE ENCODING (Phase 4 Critical Fix)
  // =========================================================================
  describe('Dummy variable encoding for categorical predictors', () => {
    it('should generate k-1 dummy variables for categorical predictor', () => {
      // Arrange - 3-level categorical predictor should generate 2 dummies
      const rows = [
        [10, 'Control'],
        [20, 'High'],
        [30, 'Low'],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.predictorNames).toEqual(['Treatment_High', 'Treatment_Low'])
      expect(result.dummyVariableInfo).toEqual({
        Treatment: {
          baselineLevel: 'Control', // First sorted level
          dummyLevels: ['High', 'Low'],
        },
      })
    })

    it('should use first sorted level as baseline (all dummies = 0)', () => {
      // Arrange
      const rows = [
        [10, 'Control'], // Baseline (Control < High < Low)
        [20, 'High'],
        [30, 'Low'],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Treatment',
          dataType: ColumnDataType.Categorical,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert - Control row should have all dummies = 0
      expect(result.predictors['Treatment_High']).toEqual([0, 1, 0])
      expect(result.predictors['Treatment_Low']).toEqual([0, 0, 1])
    })

    it('should create dummy variables in alphabetical order', () => {
      // Arrange - levels: A, B, C, D → baseline=A, dummies=B,C,D
      const rows = [
        [10, 'D'],
        [20, 'A'],
        [30, 'C'],
        [40, 'B'],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Category',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 4,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.predictorNames).toEqual(['Category_B', 'Category_C', 'Category_D'])
      expect(result.dummyVariableInfo).toBeDefined()
      expect(result.dummyVariableInfo?.Category).toBeDefined()
      expect(result.dummyVariableInfo?.Category?.baselineLevel).toBe('A')
      expect(result.dummyVariableInfo?.Category?.dummyLevels).toEqual(['B', 'C', 'D'])
    })

    it('should set exactly one dummy to 1, rest to 0 for each row', () => {
      // Arrange
      const rows = [
        [10, 'Low'],
        [20, 'Medium'],
        [30, 'High'],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Level',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert - each row should have sum of dummies = 0 (baseline) or 1 (other level)
      // Row 0: Low → Level_Low=1, Level_Medium=0
      expect(result.predictors['Level_Low']![0]).toBe(1)
      expect(result.predictors['Level_Medium']![0]).toBe(0)

      // Row 1: Medium → Level_Low=0, Level_Medium=1
      expect(result.predictors['Level_Low']![1]).toBe(0)
      expect(result.predictors['Level_Medium']![1]).toBe(1)

      // Row 2: High (baseline) → all dummies=0
      expect(result.predictors['Level_Low']![2]).toBe(0)
      expect(result.predictors['Level_Medium']![2]).toBe(0)
    })

    it('should handle high-cardinality categorical (20 levels → 19 dummies)', () => {
      // Arrange - create rows with 20 different levels
      const levels = Array.from({ length: 20 }, (_, i) => `Level${i}`)
      const rows = levels.map(level => [10, level])

      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Factor',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 20,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.predictorNames).toHaveLength(19) // 20-1 = 19 dummies
      expect(result.dummyVariableInfo).toBeDefined()
      expect(result.dummyVariableInfo?.Factor).toBeDefined()
      expect(result.dummyVariableInfo?.Factor?.dummyLevels).toHaveLength(19)
      expect(result.dummyVariableInfo?.Factor?.baselineLevel).toBe('Level0') // First alphabetically
    })

    it('should handle mixed numeric and categorical predictors', () => {
      // Arrange
      const rows = [
        [10, 25, 'Control'],
        [20, 30, 'High'],
        [30, 35, 'Low'],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Age',
          dataType: ColumnDataType.Numeric,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1, 2], rows, depColumn, predColumns)

      // Assert
      expect(result.predictorNames).toEqual(['Age', 'Treatment_High', 'Treatment_Low'])
      expect(result.predictors['Age']).toEqual([25, 30, 35])
      expect(result.predictors['Treatment_High']).toEqual([0, 1, 0])
      expect(result.predictors['Treatment_Low']).toEqual([0, 0, 1])
    })
  })

  // =========================================================================
  // PAIRWISE DELETION
  // =========================================================================
  describe('Missing data handling (pairwise deletion)', () => {
    it('should drop row with missing DV and valid predictors', () => {
      // Arrange
      const rows = [
        [10, 25],
        [null, 30],
        [20, 35],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.dependent).toEqual([10, 20])
    })

    it('should drop row with valid DV and missing predictor', () => {
      // Arrange
      const rows = [
        [10, 25],
        [20, null],
        [30, 35],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.dependent).toEqual([10, 30])
    })

    it('should drop row with missing in any column', () => {
      // Arrange - 3 columns: DV + 2 predictors
      const rows = [
        [10, 25, 100], // Valid
        [null, 30, 110], // Missing DV
        [20, null, 120], // Missing pred1
        [30, 35, null], // Missing pred2
        [40, 40, 140], // Valid
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1, 2], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(3)
      expect(result.dependent).toEqual([10, 40])
    })

    it('should track skippedRows correctly', () => {
      // Arrange
      const rows = Array.from({ length: 100 }, (_, i) => [i < 50 ? null : i, i * 2])
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(50)
      expect(result.summary.skippedRows).toBe(50)
    })

    it('should ensure validRows + skippedRows = totalRows', () => {
      // Arrange
      const rows = makeRegressionRows(200, {
        dv: 'numeric',
        predictors: [{ type: 'numeric' }, { type: 'categorical', levels: ['A', 'B', 'C'] }],
        missingRate: 0.2, // 20% missing
      })
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1, 2], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows + result.summary.skippedRows).toBe(result.summary.totalRows)
      expect(result.summary.totalRows).toBe(200)
    })
  })

  // =========================================================================
  // SUMMARY METADATA
  // =========================================================================
  describe('Summary metadata', () => {
    it('should report correct validRows after pairwise deletion', () => {
      // Arrange
      const rows = makeRegressionRows(100, {
        dv: 'numeric',
        predictors: [{ type: 'numeric' }],
        missingRate: 0, // No missing data
      })
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(100)
      expect(result.dependent).toHaveLength(100)
    })

    it('should report correct totalRows before deletion', () => {
      // Arrange
      const rows = makeRegressionRows(150, {
        dv: 'numeric',
        predictors: [{ type: 'numeric' }],
        missingRate: 0.3,
      })
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.totalRows).toBe(150)
    })

    it('should report correct skippedRows', () => {
      // Arrange - exactly 10 rows with missing data
      const validRows = Array.from({ length: 90 }, (_, i) => [i, i * 2])
      const invalidRows = Array.from({ length: 10 }, () => [null, 100])
      const rows = [...validRows, ...invalidRows]

      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.skippedRows).toBe(10)
    })
  })

  // =========================================================================
  // EDGE CASES
  // =========================================================================
  describe('Edge cases', () => {
    it('should handle empty rows array', () => {
      // Arrange
      const rows: any[][] = []
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(0)
      expect(result.summary.totalRows).toBe(0)
      expect(result.dependent).toEqual([])
    })

    it('should handle all rows with missing data', () => {
      // Arrange
      const rows = Array.from({ length: 50 }, () => [null, null])
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert
      expect(result.summary.validRows).toBe(0)
      expect(result.summary.skippedRows).toBe(50)
    })

    it('should handle categorical predictor with only one observed level after pairwise deletion', () => {
      // Arrange - all rows with level 'B' have missing DV, only 'A' remains
      const rows = [
        [10, 'A'],
        [null, 'B'],
        [20, 'A'],
        [null, 'B'],
      ]
      const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
      const predColumns = [
        makeColumnClassification({
          columnName: 'Factor',
          dataType: ColumnDataType.Categorical,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractRegressionPredictors(0, [1], rows, depColumn, predColumns)

      // Assert - should still create dummies based on all original levels, but only 'A' appears in data
      expect(result.summary.validRows).toBe(2)
      // Note: Implementation may vary - could either:
      // 1. Create dummies for all observed levels (including dropped rows)
      // 2. Create dummies only for levels in valid rows
      // Check actual behavior
      expect(result.predictorNames.length).toBeGreaterThan(0)
    })
  })
})
