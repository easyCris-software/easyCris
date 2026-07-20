/**
 * TestValidator Tests
 *
 * Tests all validation helpers used across statistical test modules:
 * - Column count validation (exact and range)
 * - Data type validation (numeric, categorical)
 * - Category count validation
 * - Ordinal data warnings
 * - Fisher's Exact Test suggestions (2×2 tables)
 * - Long-format detection (ANOVA/Kruskal-Wallis)
 * - Result combination logic
 */

import { describe, it, expect } from 'vitest'
import { TestValidator } from '../TestValidator'
import { ColumnDataType } from '../types'
import { makeColumnClassification, makeClassifications } from '@/test-utils/factories'

describe('TestValidator', () => {
  // =========================================================================
  // COLUMN COUNT VALIDATION (exact)
  // =========================================================================
  describe('checkColumnCount', () => {
    it('should pass when column count matches expected', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ columnName: 'Col1' }),
        makeColumnClassification({ columnName: 'Col2' }),
      ]

      // Act
      const result = TestValidator.checkColumnCount(columns, 2, 'Test')

      // Assert
      expect(result).toBeNull() // Null = validation passed
    })

    it('should fail when too few columns selected', () => {
      // Arrange
      const columns = [makeColumnClassification()]

      // Act
      const result = TestValidator.checkColumnCount(columns, 2, 't-Test')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors).toHaveLength(1)
      expect(result!.errors[0]).toContain('t-Test requires exactly 2 columns')
      expect(result!.errors[0]).toContain('1 selected')
    })

    it('should fail when too many columns selected', () => {
      // Arrange
      const columns = [
        makeColumnClassification(),
        makeColumnClassification(),
        makeColumnClassification(),
      ]

      // Act
      const result = TestValidator.checkColumnCount(columns, 2, 'Correlation')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain('Correlation requires exactly 2 columns')
      expect(result!.errors[0]).toContain('3 selected')
    })

    it('should handle singular vs plural correctly in error messages', () => {
      // Arrange - Test singular (1 column)
      const columns = [makeColumnClassification(), makeColumnClassification()]

      // Act
      const result = TestValidator.checkColumnCount(columns, 1, 'Normality Test')

      // Assert
      expect(result!.errors[0]).toContain('requires exactly 1 column') // Singular

      // Arrange - Test plural (3 columns)
      const result2 = TestValidator.checkColumnCount(columns, 3, 'ANOVA')

      // Assert
      expect(result2!.errors[0]).toContain('requires exactly 3 columns') // Plural
    })

    it('should provide helpful suggestions', () => {
      // Arrange
      const columns = [makeColumnClassification()]

      // Act
      const result = TestValidator.checkColumnCount(columns, 2, 'Test')

      // Assert
      expect(result!.suggestions).toContain('Select 2 columns for comparison')
    })
  })

  // =========================================================================
  // COLUMN COUNT VALIDATION (range)
  // =========================================================================
  describe('checkColumnCountRange', () => {
    it('should pass when column count is within range', () => {
      // Arrange
      const columns = [
        makeColumnClassification(),
        makeColumnClassification(),
        makeColumnClassification(),
      ]

      // Act
      const result = TestValidator.checkColumnCountRange(columns, 2, 5, 'ANOVA')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass at minimum boundary', () => {
      // Arrange
      const columns = [makeColumnClassification(), makeColumnClassification()]

      // Act
      const result = TestValidator.checkColumnCountRange(columns, 2, 5, 'Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass at maximum boundary', () => {
      // Arrange
      const columns = Array.from({ length: 5 }, () => makeColumnClassification())

      // Act
      const result = TestValidator.checkColumnCountRange(columns, 2, 5, 'Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should fail when below minimum', () => {
      // Arrange
      const columns = [makeColumnClassification()]

      // Act
      const result = TestValidator.checkColumnCountRange(columns, 2, 5, 'ANOVA')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain('ANOVA requires between 2 and 5 columns')
      expect(result!.errors[0]).toContain('1 selected')
    })

    it('should fail when above maximum', () => {
      // Arrange
      const columns = Array.from({ length: 10 }, () => makeColumnClassification())

      // Act
      const result = TestValidator.checkColumnCountRange(columns, 2, 5, 'Test')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain('requires between 2 and 5 columns')
      expect(result!.errors[0]).toContain('10 selected')
    })
  })

  // =========================================================================
  // NUMERIC DATA TYPE VALIDATION
  // =========================================================================
  describe('checkAllNumeric', () => {
    it('should pass when all columns are Numeric', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 't-Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass when all columns are Ordinal (treated as numeric)', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Ordinal, isOrdinal: true }),
        makeColumnClassification({ dataType: ColumnDataType.Ordinal, isOrdinal: true }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 't-Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass when mixing Numeric and Ordinal', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ dataType: ColumnDataType.Ordinal, isOrdinal: true }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 'Correlation')

      // Assert
      expect(result).toBeNull()
    })

    it('should fail when column is Categorical', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ columnName: 'Color', dataType: ColumnDataType.Categorical }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 't-Test')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain("Column 'Color' contains categorical data")
      expect(result!.errors[0]).toContain('t-Test requires numeric data')
    })

    it('should fail when column is Binary', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ columnName: 'Treatment', dataType: ColumnDataType.Binary, isBinary: true }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 'Correlation')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain("Column 'Treatment' contains binary data")
    })

    it('should fail when column is Empty', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ columnName: 'EmptyCol', dataType: ColumnDataType.Empty }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 't-Test')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain("Column 'EmptyCol' is empty")
    })

    it('should suggest appropriate alternative tests', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
      ]

      // Act
      const result = TestValidator.checkAllNumeric(columns, 't-Test')

      // Assert
      expect(result!.suggestions).toContain('Use Chi-Square Test for categorical data')
      expect(result!.suggestions).toContain('Use Mann-Whitney U Test for ordinal data')
    })
  })

  // =========================================================================
  // CATEGORICAL DATA TYPE VALIDATION
  // =========================================================================
  describe('checkAllCategorical', () => {
    it('should pass when all columns are Categorical', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass when all columns are Binary', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true }),
        makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass when mixing Categorical and Binary', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
        makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass when column is Ordinal (treated as categorical)', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Ordinal, isOrdinal: true }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should fail when column is continuous Numeric', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
        makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric, isOrdinal: false }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain("Column 'Age' contains continuous numeric data")
      expect(result!.errors[0]).toContain('Chi-Square Test requires categorical data')
    })

    it('should fail when column is Empty', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ columnName: 'EmptyCol', dataType: ColumnDataType.Empty }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain("Column 'EmptyCol' is empty")
    })

    it('should suggest appropriate alternative tests', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
      ]

      // Act
      const result = TestValidator.checkAllCategorical(columns, 'Chi-Square Test')

      // Assert
      expect(result!.suggestions).toContain('Use Correlation Analysis for numeric data')
      expect(result!.suggestions).toContain('Consider binning numeric data into categories if appropriate')
    })
  })

  // =========================================================================
  // MINIMUM CATEGORIES VALIDATION
  // =========================================================================
  describe('checkMinCategories', () => {
    it('should pass when all columns have sufficient categories', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ uniqueValueCount: 3 }),
        makeColumnClassification({ uniqueValueCount: 5 }),
      ]

      // Act
      const result = TestValidator.checkMinCategories(columns, 3, 'ANOVA')

      // Assert
      expect(result).toBeNull()
    })

    it('should pass at minimum boundary', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ uniqueValueCount: 3 }),
      ]

      // Act
      const result = TestValidator.checkMinCategories(columns, 3, 'Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should fail when column has too few categories', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ columnName: 'Group', uniqueValueCount: 2 }),
      ]

      // Act
      const result = TestValidator.checkMinCategories(columns, 3, 'ANOVA')

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(false)
      expect(result!.errors[0]).toContain("Column 'Group' has only 2 unique values")
      expect(result!.errors[0]).toContain('ANOVA requires at least 3')
    })

    it('should handle singular vs plural in error messages', () => {
      // Arrange - 1 unique value
      const columns = [
        makeColumnClassification({ columnName: 'Constant', uniqueValueCount: 1 }),
      ]

      // Act
      const result = TestValidator.checkMinCategories(columns, 2, 'Test')

      // Assert
      expect(result!.errors[0]).toContain('has only 1 unique value') // Singular

      // Arrange - 2 unique values
      const columns2 = [
        makeColumnClassification({ columnName: 'Binary', uniqueValueCount: 2 }),
      ]

      // Act
      const result2 = TestValidator.checkMinCategories(columns2, 3, 'Test')

      // Assert
      expect(result2!.errors[0]).toContain('has only 2 unique values') // Plural
    })
  })

  // =========================================================================
  // ORDINAL DATA WARNINGS
  // =========================================================================
  describe('checkOrdinalWarning', () => {
    it('should return null when no columns are ordinal', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric, isOrdinal: false }),
        makeColumnClassification({ dataType: ColumnDataType.Numeric, isOrdinal: false }),
      ]

      // Act
      const result = TestValidator.checkOrdinalWarning(columns, 't-Test')

      // Assert
      expect(result).toBeNull()
    })

    it('should return warning when ordinal data detected (preferNonparametric=true)', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ dataType: ColumnDataType.Ordinal, isOrdinal: true }),
        makeColumnClassification({ dataType: ColumnDataType.Numeric, isOrdinal: false }),
      ]

      // Act
      const result = TestValidator.checkOrdinalWarning(columns, 't-Test', true)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(true) // Still valid, just a warning
      expect(result!.warnings).toHaveLength(1)
      expect(result!.warnings[0]).toContain('appear to be ordinal (Likert scale)')
      expect(result!.warnings[0]).toContain('t-Test assumes continuous interval/ratio data')
    })

    it('should suggest nonparametric alternative when preferNonparametric=true', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ isOrdinal: true }),
      ]

      // Act
      const result = TestValidator.checkOrdinalWarning(columns, 't-Test', true)

      // Assert
      expect(result!.suggestions).toContain('Consider using Mann-Whitney U Test for ordinal data')
    })

    it('should return null when preferNonparametric=false', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ isOrdinal: true }),
      ]

      // Act
      const result = TestValidator.checkOrdinalWarning(columns, 'Linear Regression', false)

      // Assert
      expect(result).toBeNull()
    })

    it('should detect ordinal even when mixed with non-ordinal', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ isOrdinal: false }),
        makeColumnClassification({ isOrdinal: false }),
        makeColumnClassification({ isOrdinal: true }), // One ordinal
      ]

      // Act
      const result = TestValidator.checkOrdinalWarning(columns, 'ANOVA', true)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.warnings).toHaveLength(1)
    })
  })

  // =========================================================================
  // FISHER'S EXACT TEST SUGGESTION (2×2 tables)
  // =========================================================================
  describe('checkFisherExactSuggestion', () => {
    it('should suggest Fisher for 2×2 contingency table', () => {
      // Arrange - both columns have exactly 2 unique values
      const columns = [
        makeColumnClassification({ uniqueValueCount: 2 }),
        makeColumnClassification({ uniqueValueCount: 2 }),
      ]

      // Act
      const result = TestValidator.checkFisherExactSuggestion(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isValid).toBe(true) // Still allow Chi-Square
      expect(result!.warnings[0]).toContain("For 2×2 contingency tables, Fisher's Exact Test is more accurate")
      expect(result!.suggestions[0]).toContain("Consider using Fisher's Exact Test instead")
    })

    it('should return null for 2×3 table', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ uniqueValueCount: 2 }),
        makeColumnClassification({ uniqueValueCount: 3 }),
      ]

      // Act
      const result = TestValidator.checkFisherExactSuggestion(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should return null for 3×3 table', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ uniqueValueCount: 3 }),
        makeColumnClassification({ uniqueValueCount: 3 }),
      ]

      // Act
      const result = TestValidator.checkFisherExactSuggestion(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should return null when more than 2 columns', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ uniqueValueCount: 2 }),
        makeColumnClassification({ uniqueValueCount: 2 }),
        makeColumnClassification({ uniqueValueCount: 2 }),
      ]

      // Act
      const result = TestValidator.checkFisherExactSuggestion(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should return null when fewer than 2 columns', () => {
      // Arrange
      const columns = [
        makeColumnClassification({ uniqueValueCount: 2 }),
      ]

      // Act
      const result = TestValidator.checkFisherExactSuggestion(columns)

      // Assert
      expect(result).toBeNull()
    })
  })

  // =========================================================================
  // LONG-FORMAT DETECTION (ANOVA/Kruskal-Wallis)
  // =========================================================================
  describe('detectLongFormat', () => {
    it('should detect long format: numeric first, categorical second', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Score', type: ColumnDataType.Numeric, uniqueCount: 50 },
        { name: 'Treatment', type: ColumnDataType.Categorical, uniqueCount: 3 },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isLongFormat).toBe(true)
      expect(result!.numericIndex).toBe(0)
      expect(result!.categoricalIndex).toBe(1)
      expect(result!.groupCount).toBe(3)
    })

    it('should detect long format: categorical first, numeric second', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Group', type: ColumnDataType.Categorical, uniqueCount: 4 },
        { name: 'Value', type: ColumnDataType.Numeric, uniqueCount: 100 },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isLongFormat).toBe(true)
      expect(result!.numericIndex).toBe(1)
      expect(result!.categoricalIndex).toBe(0)
      expect(result!.groupCount).toBe(4)
    })

    it('should detect long format with Binary categorical', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Score', type: ColumnDataType.Numeric },
        { name: 'Treatment', type: ColumnDataType.Binary, binary: true, uniqueCount: 2 },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isLongFormat).toBe(true)
      expect(result!.groupCount).toBe(2)
    })

    it('should detect long format with Ordinal numeric', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Likert', type: ColumnDataType.Ordinal, ordinal: true, uniqueCount: 5 },
        { name: 'Group', type: ColumnDataType.Categorical, uniqueCount: 3 },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.isLongFormat).toBe(true)
      expect(result!.numericIndex).toBe(0)
    })

    it('should return null when both columns are numeric', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Age', type: ColumnDataType.Numeric },
        { name: 'Weight', type: ColumnDataType.Numeric },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should return null when both columns are categorical', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Color', type: ColumnDataType.Categorical },
        { name: 'Size', type: ColumnDataType.Categorical },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should return null when more than 2 columns', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Score', type: ColumnDataType.Numeric },
        { name: 'Group', type: ColumnDataType.Categorical },
        { name: 'Age', type: ColumnDataType.Numeric },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should return null when fewer than 2 columns', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Score', type: ColumnDataType.Numeric },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).toBeNull()
    })

    it('should warn about high cardinality (>50 groups)', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Score', type: ColumnDataType.Numeric },
        { name: 'Gene', type: ColumnDataType.Categorical, uniqueCount: 100 },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.warning).toBeDefined()
      expect(result!.warning).toContain('High cardinality factor: 100 groups detected')
    })

    it('should not warn about normal cardinality (<=50 groups)', () => {
      // Arrange
      const columns = makeClassifications([
        { name: 'Score', type: ColumnDataType.Numeric },
        { name: 'Group', type: ColumnDataType.Categorical, uniqueCount: 10 },
      ])

      // Act
      const result = TestValidator.detectLongFormat(columns)

      // Assert
      expect(result).not.toBeNull()
      expect(result!.warning).toBeUndefined()
    })
  })

  // =========================================================================
  // RESULT COMBINATION LOGIC
  // =========================================================================
  describe('combineResults', () => {
    it('should return success when all validations pass (all null)', () => {
      // Arrange
      const results = [null, null, null]

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.isValid).toBe(true)
      expect(combined.errors).toHaveLength(0)
      expect(combined.warnings).toHaveLength(0)
      expect(combined.suggestions).toHaveLength(0)
    })

    it('should return first error when validation fails', () => {
      // Arrange
      const results = [
        null, // Pass
        {
          isValid: false,
          errors: ['Error 1'],
          warnings: [],
          suggestions: ['Suggestion 1'],
        },
        {
          isValid: false,
          errors: ['Error 2'],
          warnings: [],
          suggestions: ['Suggestion 2'],
        },
      ]

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.isValid).toBe(false)
      expect(combined.errors).toEqual(['Error 1']) // First error only
      expect(combined.suggestions).toEqual(['Suggestion 1'])
    })

    it('should combine all warnings when no errors', () => {
      // Arrange
      const results = [
        null, // Pass
        {
          isValid: true,
          errors: [],
          warnings: ['Warning 1'],
          suggestions: ['Suggestion 1'],
        },
        {
          isValid: true,
          errors: [],
          warnings: ['Warning 2'],
          suggestions: ['Suggestion 2'],
        },
      ]

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.isValid).toBe(true)
      expect(combined.warnings).toEqual(['Warning 1', 'Warning 2'])
      expect(combined.suggestions).toEqual(['Suggestion 1', 'Suggestion 2'])
    })

    it('should remove duplicate warnings', () => {
      // Arrange
      const results = [
        {
          isValid: true,
          errors: [],
          warnings: ['Warning 1', 'Warning 2'],
          suggestions: [],
        },
        {
          isValid: true,
          errors: [],
          warnings: ['Warning 1', 'Warning 3'], // Duplicate Warning 1
          suggestions: [],
        },
      ]

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.warnings).toHaveLength(3) // Not 4
      expect(combined.warnings).toContain('Warning 1')
      expect(combined.warnings).toContain('Warning 2')
      expect(combined.warnings).toContain('Warning 3')
    })

    it('should remove duplicate suggestions', () => {
      // Arrange
      const results = [
        {
          isValid: true,
          errors: [],
          warnings: [],
          suggestions: ['Suggestion A', 'Suggestion B'],
        },
        {
          isValid: true,
          errors: [],
          warnings: [],
          suggestions: ['Suggestion A', 'Suggestion C'], // Duplicate A
        },
      ]

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.suggestions).toHaveLength(3) // Not 4
      expect(combined.suggestions).toContain('Suggestion A')
      expect(combined.suggestions).toContain('Suggestion B')
      expect(combined.suggestions).toContain('Suggestion C')
    })

    it('should return first error result including its warnings', () => {
      // Arrange
      const results = [
        {
          isValid: true,
          errors: [],
          warnings: ['Warning 1'],
          suggestions: [],
        },
        {
          isValid: false,
          errors: ['Error 1'],
          warnings: ['Warning 2'], // Included (part of error result)
          suggestions: ['Suggestion 2'],
        },
      ]

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.isValid).toBe(false)
      expect(combined.errors).toEqual(['Error 1'])
      expect(combined.warnings).toEqual(['Warning 2']) // Error result returned as-is
    })

    it('should handle empty results array', () => {
      // Arrange
      const results: Array<any> = []

      // Act
      const combined = TestValidator.combineResults(results)

      // Assert
      expect(combined.isValid).toBe(true)
      expect(combined.errors).toHaveLength(0)
      expect(combined.warnings).toHaveLength(0)
    })
  })
})
