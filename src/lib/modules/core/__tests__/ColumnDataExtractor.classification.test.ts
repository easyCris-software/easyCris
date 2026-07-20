/**
 * ColumnDataExtractor - Column Classification Tests
 *
 * Tests classifyColumn method which determines column data types:
 * - Empty (no valid values)
 * - Binary (exactly 2 unique values)
 * - Ordinal (Likert-like scales: all integers, 3-10 unique, max <= 10)
 * - Numeric (all numeric values)
 * - Categorical (all text/categorical values)
 * - Mixed (some numeric, some categorical - data quality issue)
 */

import { describe, it, expect } from 'vitest'
import { ColumnDataExtractor } from '../ColumnDataExtractor'
import { ColumnDataType } from '../types'

describe('ColumnDataExtractor.classifyColumn', () => {
  // =========================================================================
  // EMPTY COLUMN DETECTION
  // =========================================================================
  describe('Empty column detection', () => {
    it('should classify column with no rows as Empty', () => {
      // Arrange
      const rows: any[][] = []

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'EmptyCol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
      expect(result.uniqueValueCount).toBe(0)
    })

    it('should classify column with all null values as Empty', () => {
      // Arrange
      const rows = [[null], [null], [null]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NullCol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
      expect(result.missingValues).toBe(3)
      expect(result.hasMissingData).toBe(true)
    })

    it('should classify column with all "NA" values as Empty', () => {
      // Arrange
      const rows = [['NA'], ['N/A'], ['na'], ['n/a']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NACol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
      expect(result.missingValues).toBe(4)
    })

    it('should classify column with all empty strings as Empty', () => {
      // Arrange
      const rows = [[''], ['  '], [''], ['']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'EmptyStrCol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
    })

    it('should classify column with mixed missing indicators as Empty', () => {
      // Arrange
      const rows = [[null], ['NA'], ['Missing'], ['.'], ['-'], ['NaN']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'MixedMissingCol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
      expect(result.missingValues).toBe(6)
    })
  })

  // =========================================================================
  // BINARY DETECTION (exactly 2 unique values)
  // =========================================================================
  describe('Binary column detection', () => {
    it('should classify column with 2 numeric values as Binary', () => {
      // Arrange
      const rows = [[0], [1], [0], [1], [0]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'BinaryNumeric', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Binary)
      expect(result.isBinary).toBe(true)
      expect(result.uniqueValueCount).toBe(2)
      expect(result.uniqueValues).toEqual(['0', '1'])
    })

    it('should classify column with 2 text values as Binary', () => {
      // Arrange
      const rows = [['Yes'], ['No'], ['Yes'], ['No']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'BinaryText', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Binary)
      expect(result.isBinary).toBe(true)
      expect(result.uniqueValueCount).toBe(2)
      expect(result.uniqueValues).toEqual(['No', 'Yes']) // Sorted alphabetically
    })

    it('should classify column with 2 values (numeric strings) as Binary', () => {
      // Arrange
      const rows = [['10'], ['20'], ['10'], ['20'], ['10']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'BinaryNumericStr', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Binary)
      expect(result.isBinary).toBe(true)
      expect(result.uniqueValueCount).toBe(2)
    })

    it('should suggest appropriate tests for binary columns', () => {
      // Arrange
      const rows = [['Control'], ['Treatment'], ['Control']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Group', rows)

      // Assert
      expect(result.suggestedTests).toContain('Binary Logistic Regression (as outcome)')
      expect(result.suggestedTests).toContain('Chi-Square Test')
      expect(result.suggestedTests).toContain("Fisher's Exact Test")
      expect(result.suggestedTests).toContain('McNemar Test (paired data)')
    })

    it('should classify binary with missing values correctly', () => {
      // Arrange
      const rows = [['Yes'], [null], ['No'], ['Yes'], [null], ['No']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'BinaryWithNA', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Binary)
      expect(result.totalValues).toBe(4) // Only non-missing
      expect(result.missingValues).toBe(2)
      expect(result.uniqueValueCount).toBe(2)
    })
  })

  // =========================================================================
  // ORDINAL DETECTION (Likert-like scales)
  // =========================================================================
  describe('Ordinal column detection (Likert-like scales)', () => {
    it('should classify 5-point Likert scale as Ordinal', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [5], [1], [3], [5]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Likert5', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Ordinal)
      expect(result.isOrdinal).toBe(true)
      expect(result.uniqueValueCount).toBe(5)
      expect(result.allIntegerValues).toBe(true)
      expect(result.maxNumericValue).toBe(5)
    })

    it('should classify 7-point scale as Ordinal', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [5], [6], [7], [4], [5]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Scale7', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Ordinal)
      expect(result.isOrdinal).toBe(true)
      expect(result.uniqueValueCount).toBe(7)
    })

    it('should classify 10-point scale as Ordinal', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Scale10', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Ordinal)
      expect(result.isOrdinal).toBe(true)
      expect(result.uniqueValueCount).toBe(10)
      expect(result.maxNumericValue).toBe(10)
    })

    it('should NOT classify as Ordinal if max value > 10', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [11]] // max > 10

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NotOrdinal1', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric) // Regular numeric instead
      expect(result.isOrdinal).toBe(false)
    })

    it('should NOT classify as Ordinal if < 3 unique values', () => {
      // Arrange
      const rows = [[1], [2], [1], [2]] // Only 2 unique values

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NotOrdinal2', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Binary) // Binary instead
      expect(result.isOrdinal).toBe(false)
    })

    it('should NOT classify as Ordinal if > 10 unique values', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10], [1]] // 10 unique, but 11th unique would fail
      const rows2 = [...rows, [0]] // 11 unique values

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NotOrdinal3', rows2)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric) // Regular numeric
      expect(result.isOrdinal).toBe(false)
    })

    it('should NOT classify as Ordinal if values are not all integers', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [4.5]] // 4.5 is not an integer

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NotOrdinal4', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.isOrdinal).toBe(false)
      expect(result.allIntegerValues).toBe(false)
    })

    it('should suggest appropriate tests for ordinal columns', () => {
      // Arrange
      const rows = [[1], [2], [3], [4], [5]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Ordinal', rows)

      // Assert
      expect(result.suggestedTests).toContain('Spearman Correlation (ordinal)')
      expect(result.suggestedTests).toContain("Kendall's Tau (ordinal)")
      expect(result.suggestedTests).toContain('Mann-Whitney U Test')
      expect(result.suggestedTests).toContain('Kruskal-Wallis Test')
      expect(result.suggestedTests).toContain('Wilcoxon Signed-Rank Test')
      expect(result.suggestedTests).toContain('Friedman Test')
    })
  })

  // =========================================================================
  // NUMERIC DETECTION
  // =========================================================================
  describe('Numeric column detection', () => {
    it('should classify column with all numeric values as Numeric', () => {
      // Arrange
      const rows = [[10.5], [20.3], [30.7], [15.2]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NumericCol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.numericValues).toBe(4)
      expect(result.categoricalValues).toBe(0)
      expect(result.numericRatio).toBe(1.0)
    })

    it('should calculate min/max for numeric columns', () => {
      // Arrange
      const rows = [[10], [50], [25], [75], [5]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NumericRange', rows)

      // Assert
      expect(result.minNumericValue).toBe(5)
      expect(result.maxNumericValue).toBe(75)
    })

    it('should detect all-integer numeric columns', () => {
      // Arrange
      const rows = [[10], [20], [30], [40], [50], [60]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'IntegerCol', rows)

      // Assert
      expect(result.allIntegerValues).toBe(true)
    })

    it('should detect mixed integer/decimal as non-integer', () => {
      // Arrange
      const rows = [[10], [20.5], [30], [40]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'MixedIntDecimal', rows)

      // Assert
      expect(result.allIntegerValues).toBe(false)
    })

    it('should handle negative numbers as Numeric', () => {
      // Arrange
      const rows = [[-10], [20], [-5], [15]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithNegatives', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.minNumericValue).toBe(-10)
    })

    it('should handle scientific notation as Numeric', () => {
      // Arrange
      const rows = [[1e-5], [2e-5], [3e-5]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Scientific', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.numericValues).toBe(3)
    })

    it('should suggest appropriate tests for numeric columns', () => {
      // Arrange
      const rows = [[10], [20], [30], [40], [50]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Numeric', rows)

      // Assert
      expect(result.suggestedTests).toContain('Descriptive Statistics')
      expect(result.suggestedTests).toContain('t-Test')
      expect(result.suggestedTests).toContain('ANOVA')
      expect(result.suggestedTests).toContain('Correlation Analysis')
      expect(result.suggestedTests).toContain('Linear Regression')
    })

    it('should handle numeric column with missing values', () => {
      // Arrange
      const rows = [[10], [null], [20], ['NA'], [30]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NumericWithNA', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.totalValues).toBe(3) // Only non-missing
      expect(result.missingValues).toBe(2)
      expect(result.hasMissingData).toBe(true)
    })
  })

  // =========================================================================
  // CATEGORICAL DETECTION
  // =========================================================================
  describe('Categorical column detection', () => {
    it('should classify column with all text values as Categorical', () => {
      // Arrange
      const rows = [['Red'], ['Blue'], ['Green'], ['Red'], ['Yellow']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Color', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Categorical)
      expect(result.categoricalValues).toBe(5)
      expect(result.numericValues).toBe(0)
      expect(result.uniqueValueCount).toBe(4)
    })

    it('should classify 3+ text values as Categorical (not Binary)', () => {
      // Arrange
      const rows = [['Low'], ['Medium'], ['High'], ['Low']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Level', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Categorical)
      expect(result.uniqueValueCount).toBe(3)
      expect(result.isBinary).toBe(false)
    })

    it('should count unique categorical values correctly', () => {
      // Arrange
      const rows = [['A'], ['B'], ['C'], ['A'], ['B'], ['A']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Category', rows)

      // Assert
      expect(result.uniqueValueCount).toBe(3)
      expect(result.uniqueValues).toEqual(['A', 'B', 'C']) // Sorted
    })

    it('should suggest appropriate tests for categorical columns', () => {
      // Arrange
      const rows = [['Low'], ['Medium'], ['High']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Category', rows)

      // Assert
      expect(result.suggestedTests).toContain('Chi-Square Test')
      expect(result.suggestedTests).toContain("Fisher's Exact Test (if 2×2)")
      expect(result.suggestedTests).toContain('Multinomial Logistic Regression (as outcome)')
      expect(result.suggestedTests).toContain('Two-Way ANOVA (as factor)')
    })

    it('should handle high-cardinality categorical (many levels)', () => {
      // Arrange
      const levels = Array.from({ length: 50 }, (_, i) => `Level${i}`)
      const rows = levels.map(level => [level])

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'HighCard', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Categorical)
      expect(result.uniqueValueCount).toBe(50)
    })

    it('should handle categorical with missing values', () => {
      // Arrange
      const rows = [['Red'], [null], ['Blue'], ['NA'], ['Green']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'ColorWithNA', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Categorical)
      expect(result.totalValues).toBe(3)
      expect(result.missingValues).toBe(2)
      expect(result.uniqueValueCount).toBe(3)
    })
  })

  // =========================================================================
  // MIXED DETECTION (data quality issue)
  // =========================================================================
  describe('Mixed column detection (data quality issue)', () => {
    it('should classify column with mixed numeric and text as Mixed', () => {
      // Arrange
      const rows = [[10], ['abc'], [20], ['def'], [30]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'MixedCol', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Mixed)
      expect(result.numericValues).toBe(3)
      expect(result.categoricalValues).toBe(2)
      expect(result.numericRatio).toBe(0.6) // 3/5
    })

    it('should suggest data quality review for mixed columns', () => {
      // Arrange
      const rows = [[10], ['text'], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Mixed', rows)

      // Assert
      expect(result.suggestedTests).toContain('Review data quality')
    })

    it('should calculate numeric ratio for mixed columns', () => {
      // Arrange
      const rows = [[10], [20], [30], [40], ['text'], ['abc']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'MixedRatio', rows)

      // Assert
      expect(result.numericRatio).toBeCloseTo(0.667, 2) // 4/6
    })
  })

  // =========================================================================
  // MISSING VALUE HANDLING
  // =========================================================================
  describe('Missing value handling', () => {
    it('should recognize null as missing', () => {
      // Arrange
      const rows = [[10], [null], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithNull', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(1)
      expect(result.hasMissingData).toBe(true)
    })

    it('should recognize "NA" variants as missing', () => {
      // Arrange
      const rows = [[10], ['NA'], ['N/A'], ['na'], ['n/a'], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithNA', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(4)
    })

    it('should recognize "Missing" as missing', () => {
      // Arrange
      const rows = [[10], ['Missing'], ['missing'], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithMissing', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(2)
    })

    it('should recognize "null", "NULL", "Null" strings as missing', () => {
      // Arrange
      const rows = [[10], ['null'], ['NULL'], ['Null'], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithNullStr', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(3)
    })

    it('should recognize ".", "-" as missing', () => {
      // Arrange
      const rows = [[10], ['.'], ['-'], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithDotDash', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(2)
    })

    it('should recognize "NaN" variants as missing', () => {
      // Arrange
      const rows = [[10], ['NaN'], ['nan'], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithNaN', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(2)
    })

    it('should recognize empty strings as missing', () => {
      // Arrange
      const rows = [[10], [''], ['  '], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'WithEmptyStr', rows)

      // Assert
      expect(result.totalValues).toBe(2)
      expect(result.missingValues).toBe(2)
    })

    it('should handle all missing values', () => {
      // Arrange
      const rows = [[null], ['NA'], ['Missing'], ['.'], ['-']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'AllMissing', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
      expect(result.missingValues).toBe(5)
      expect(result.hasMissingData).toBe(true)
    })
  })

  // =========================================================================
  // UNIQUE VALUE COUNTING
  // =========================================================================
  describe('Unique value counting', () => {
    it('should count unique values correctly for numeric column', () => {
      // Arrange
      const rows = [[10], [20], [10], [30], [20], [10]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'NumericUnique', rows)

      // Assert
      expect(result.uniqueValueCount).toBe(3) // 10, 20, 30
      expect(result.uniqueValues).toEqual(['10', '20', '30']) // As strings, sorted
    })

    it('should count unique values correctly for categorical column', () => {
      // Arrange
      const rows = [['Red'], ['Blue'], ['Red'], ['Green'], ['Blue']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'CategoricalUnique', rows)

      // Assert
      expect(result.uniqueValueCount).toBe(3)
      expect(result.uniqueValues).toEqual(['Blue', 'Green', 'Red']) // Sorted
    })

    it('should exclude missing values from unique count', () => {
      // Arrange
      const rows = [[10], [null], [20], ['NA'], [10]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'UniqueWithNA', rows)

      // Assert
      expect(result.uniqueValueCount).toBe(2) // Only 10 and 20
    })

    it('should sort unique values alphabetically', () => {
      // Arrange
      const rows = [['Z'], ['A'], ['M'], ['B']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'SortTest', rows)

      // Assert
      expect(result.uniqueValues).toEqual(['A', 'B', 'M', 'Z'])
    })
  })

  // =========================================================================
  // EDGE CASES
  // =========================================================================
  describe('Edge cases', () => {
    it('should handle empty rows array', () => {
      // Arrange
      const rows: any[][] = []

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'EmptyRows', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
      expect(result.missingValues).toBe(0)
    })

    it('should handle column index beyond row length', () => {
      // Arrange
      const rows = [[10, 20], [30, 40]] // Only 2 columns

      // Act - try to access column index 5
      const result = ColumnDataExtractor.classifyColumn(5, 'OutOfBounds', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Empty)
      expect(result.totalValues).toBe(0)
    })

    it('should handle single value column', () => {
      // Arrange
      const rows = [[10]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'SingleValue', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.uniqueValueCount).toBe(1)
    })

    it('should handle single unique value repeated', () => {
      // Arrange
      const rows = [[10], [10], [10], [10]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'AllSame', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.uniqueValueCount).toBe(1)
    })

    it('should handle whitespace in values correctly', () => {
      // Arrange
      const rows = [[' Red '], ['Blue'], [' Red'], ['Green ']]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'Whitespace', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Categorical)
      expect(result.uniqueValueCount).toBe(3)
      expect(result.uniqueValues).toEqual(['Blue', 'Green', 'Red']) // Trimmed and sorted
    })

    it('should handle large dataset efficiently', () => {
      // Arrange - 10,000 rows
      const rows = Array.from({ length: 10000 }, (_, i) => [i % 100])

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'LargeDataset', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.totalValues).toBe(10000)
      expect(result.uniqueValueCount).toBe(100)
    })

    it('should handle rows with varying lengths', () => {
      // Arrange
      const rows = [[10], [20, 30], [40, 50, 60], [70]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(0, 'VaryingLengths', rows)

      // Assert
      expect(result.dataType).toBe(ColumnDataType.Numeric)
      expect(result.totalValues).toBe(4)
    })

    it('should preserve column index and name in result', () => {
      // Arrange
      const rows = [[10], [20]]

      // Act
      const result = ColumnDataExtractor.classifyColumn(3, 'TestColumn', rows)

      // Assert
      expect(result.columnIndex).toBe(3)
      expect(result.columnName).toBe('TestColumn')
    })
  })
})
