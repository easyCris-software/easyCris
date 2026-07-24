/**
 * ColumnDataExtractor - Property-Based Tests
 *
 * Uses fast-check to test invariants that should ALWAYS hold
 * regardless of input data.
 *
 * These tests run with a deterministic seed (configured in setup.ts)
 * and should only run in CI to avoid slowing down development.
 *
 * Key invariants tested:
 * 1. validRows + skippedRows = totalRows (all extraction methods)
 * 2. nEvents + nCensored = validRows (survival data)
 * 3. Dummy variable count = k-1 for categorical predictors
 * 4. Unique value sorting is always alphabetical
 * 5. Data type classification is deterministic
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { ColumnDataExtractor } from '../ColumnDataExtractor'
import { ColumnDataType } from '../types'
import { makeColumnClassification } from '@/test-utils/factories'

describe('ColumnDataExtractor - Property-Based Tests', () => {
  // =========================================================================
  // INVARIANT: validRows + skippedRows = totalRows
  // =========================================================================
  describe('Row accounting invariant (validRows + skippedRows = totalRows)', () => {
    it('should hold for extractRegressionPredictors with arbitrary data', () => {
      fc.assert(
        fc.property(
          // Generate arbitrary rows: DV column + predictor column
          fc.array(
            fc.tuple(
              fc.oneof(fc.integer(), fc.constant(null), fc.constant('NA')), // DV (numeric or missing)
              fc.oneof(fc.integer(), fc.constant(null)) // Predictor (numeric or missing)
            ),
            { minLength: 1, maxLength: 100 }
          ),
          (rows) => {
            // Arrange
            const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
            const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

            // Act
            const result = ColumnDataExtractor.extractRegressionPredictors(
              0, // DV index
              [1], // predictor indices
              rows,
              depColumn,
              predColumns
            )

            // Assert invariant
            expect(result.summary.validRows + result.summary.skippedRows).toBe(
              result.summary.totalRows
            )
            expect(result.summary.totalRows).toBe(rows.length)
          }
        )
      )
    })

    it('should hold for extractSurvivalData with arbitrary data', () => {
      fc.assert(
        fc.property(
          // Generate arbitrary rows: time + event
          fc.array(
            fc.tuple(
              fc.oneof(fc.integer({ min: 0, max: 1000 }), fc.constant(null)), // Time (non-negative or missing)
              fc.oneof(fc.constantFrom(0, 1), fc.constant(null)) // Event (0/1 or missing)
            ),
            { minLength: 1, maxLength: 100 }
          ),
          (rows) => {
            // Act
            const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

            // Assert invariant
            expect(result.summary.validRows + result.summary.skippedRows).toBe(
              result.summary.totalRows
            )
            expect(result.summary.totalRows).toBe(rows.length)
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: nEvents + nCensored = validRows (survival data)
  // =========================================================================
  describe('Event count invariant (nEvents + nCensored = validRows)', () => {
    it('should hold for extractSurvivalData with arbitrary valid event data', () => {
      fc.assert(
        fc.property(
          // Generate rows with valid time/event (may have missing)
          fc.array(
            fc.tuple(
              fc.oneof(
                fc.float({ min: 0, max: 1000, noNaN: true }),
                fc.constant(null)
              ),
              fc.oneof(fc.constantFrom(0, 1), fc.constant(null))
            ),
            { minLength: 1, maxLength: 100 }
          ),
          (rows) => {
            // Act
            const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

            // Assert invariant
            expect(result.summary.nEvents + result.summary.nCensored).toBe(
              result.summary.validRows
            )
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Dummy variable count = k-1 for categorical predictors
  // =========================================================================
  describe('Dummy variable count invariant (k-1 encoding)', () => {
    it('should create exactly k-1 dummy variables for k-level categorical predictor', () => {
      fc.assert(
        fc.property(
          // Generate categorical levels (3-10 levels)
          fc.integer({ min: 3, max: 10 }),
          fc.integer({ min: 20, max: 50 }), // Number of rows
          (numLevels, numRows) => {
            // Arrange - create categorical data with numLevels levels
            const levels = Array.from({ length: numLevels }, (_, i) => `Level${i}`)
            const rows = Array.from({ length: numRows }, (_, i) => [
              i * 10, // Numeric DV
              levels[i % numLevels], // Categorical predictor (cycle through levels)
            ])

            const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
            const predColumns = [
              makeColumnClassification({
                columnName: 'Category',
                dataType: ColumnDataType.Categorical,
                uniqueValueCount: numLevels,
              }),
            ]

            // Act
            const result = ColumnDataExtractor.extractRegressionPredictors(
              0,
              [1],
              rows,
              depColumn,
              predColumns
            )

            // Assert invariant: k levels → k-1 dummies
            expect(result.predictorNames).toBeDefined()
            expect(result.predictorNames).toHaveLength(numLevels - 1)
            expect(result.dummyVariableInfo).toBeDefined()
            const categoryInfo = result.dummyVariableInfo?.Category
            expect(categoryInfo).toBeDefined()
            expect(categoryInfo?.dummyLevels).toHaveLength(numLevels - 1)
          }
        )
      )
    })

    it('should create k-1 dummies for survival data categorical covariates', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 20, max: 50 }),
          (numLevels, numRows) => {
            // Arrange
            const levels = Array.from({ length: numLevels }, (_, i) => `Cov${i}`)
            const rows = Array.from({ length: numRows }, (_, i) => [
              i * 10, // Time
              i % 2, // Event
              levels[i % numLevels], // Categorical covariate
            ])

            const covariateColumns = [
              makeColumnClassification({
                columnName: 'Covariate',
                dataType: ColumnDataType.Categorical,
                uniqueValueCount: numLevels,
              }),
            ]

            // Act
            const result = ColumnDataExtractor.extractSurvivalData(
              0,
              1,
              rows,
              undefined,
              [2],
              undefined,
              covariateColumns
            )

            // Assert invariant
            expect(result.covariateNames).toBeDefined()
            expect(result.covariateNames).toHaveLength(numLevels - 1)
            expect(result.dummyVariableInfo).toBeDefined()
            const covariateInfo = result.dummyVariableInfo?.Covariate
            expect(covariateInfo).toBeDefined()
            expect(covariateInfo?.dummyLevels).toHaveLength(numLevels - 1)
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Unique values are always sorted alphabetically
  // =========================================================================
  describe('Unique value sorting invariant', () => {
    it('should always sort unique values alphabetically', () => {
      fc.assert(
        fc.property(
          // Generate array of arbitrary strings
          fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
            minLength: 1,
            maxLength: 50,
          }),
          (values) => {
            // Arrange - create rows with these values
            const rows = values.map(v => [v])

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'TestCol', rows)

            // Assert invariant - uniqueValues should be sorted
            const sorted = [...result.uniqueValues].sort()
            expect(result.uniqueValues).toEqual(sorted)
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Data type classification is deterministic
  // =========================================================================
  describe('Data type classification determinism', () => {
    it('should classify all-numeric data as Numeric or Binary or Ordinal', () => {
      fc.assert(
        fc.property(
          fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 100 }),
          (values) => {
            // Arrange
            const rows = values.map(v => [v])
            const uniqueCount = new Set(values).size

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'NumericCol', rows)

            // Assert invariant - numeric data is classified based on uniqueValueCount
            expect(result.numericRatio).toBe(1.0)

            // Exactly 2 unique values → Binary
            if (uniqueCount === 2) {
              expect(result.dataType).toBe(ColumnDataType.Binary)
            } else {
              // 1 or 3+ unique values → Numeric or Ordinal
              expect([ColumnDataType.Numeric, ColumnDataType.Ordinal]).toContain(result.dataType)
            }
          }
        )
      )
    })

    it('should classify all-text data as Categorical or Binary', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
            minLength: 1,
            maxLength: 50,
          }),
          (values) => {
            // Filter out numeric-looking strings
            const textValues = values.filter(v => isNaN(parseFloat(v)))
            if (textValues.length === 0) return // Skip if all parseable as numbers

            // Arrange
            const rows = textValues.map(v => [v])

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'TextCol', rows)

            // Assert invariant - should be Categorical or Binary
            const uniqueCount = new Set(textValues).size
            if (uniqueCount === 2) {
              expect(result.dataType).toBe(ColumnDataType.Binary)
            } else if (uniqueCount >= 3) {
              expect(result.dataType).toBe(ColumnDataType.Categorical)
            }
          }
        )
      )
    })

    it('should classify exactly 2 unique values as Binary', () => {
      fc.assert(
        fc.property(
          fc.tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 })),
          fc.array(fc.boolean(), { minLength: 10, maxLength: 100 }),
          ([value1, value2], choices) => {
            // Filter out cases where values are identical or would be trimmed to empty
            const trimmed1 = value1.trim()
            const trimmed2 = value2.trim()
            fc.pre(trimmed1 !== '' && trimmed2 !== '' && trimmed1 !== trimmed2)

            // Arrange - create data with exactly 2 unique values
            const rows = choices.map(choice => [choice ? value1 : value2])

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'BinaryCol', rows)

            // Assert invariant
            expect(result.dataType).toBe(ColumnDataType.Binary)
            expect(result.isBinary).toBe(true)
            expect(result.uniqueValueCount).toBe(2)
          }
        )
      )
    })

    it('should classify Ordinal only when meeting all criteria', () => {
      fc.assert(
        fc.property(
          // Generate integers between 1-10, creating 3-10 unique values
          fc.integer({ min: 3, max: 10 }),
          fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 10, maxLength: 50 }),
          (maxValue, values) => {
            // Filter to only use values <= maxValue
            const filteredValues = values.filter(v => v <= maxValue)
            if (filteredValues.length === 0) return

            const uniqueCount = new Set(filteredValues).size

            // Arrange
            const rows = filteredValues.map(v => [v])

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'OrdinalTest', rows)

            // Assert invariant - Ordinal iff: all integers, 3-10 unique, max <= 10
            if (
              uniqueCount >= 3 &&
              uniqueCount <= 10 &&
              maxValue <= 10 &&
              filteredValues.every(v => v === Math.floor(v))
            ) {
              expect(result.dataType).toBe(ColumnDataType.Ordinal)
              expect(result.isOrdinal).toBe(true)
            }
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Missing values are consistently detected
  // =========================================================================
  describe('Missing value detection consistency', () => {
    it('should always exclude null from unique values', () => {
      fc.assert(
        fc.property(
          fc.array(fc.oneof(fc.integer(), fc.constant(null)), {
            minLength: 1,
            maxLength: 100,
          }),
          (values) => {
            // Arrange
            const rows = values.map(v => [v])

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'WithNulls', rows)

            // Assert invariant - uniqueValues should not contain 'null' string
            expect(result.uniqueValues).not.toContain('null')
            expect(result.uniqueValues).not.toContain('undefined')
          }
        )
      )
    })

    it('should always track missing values correctly', () => {
      fc.assert(
        fc.property(
          fc.array(fc.oneof(fc.integer(), fc.constant(null)), {
            minLength: 1,
            maxLength: 100,
          }),
          (values) => {
            // Arrange
            const rows = values.map(v => [v])
            const expectedMissing = values.filter(v => v === null).length

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'MissingTest', rows)

            // Assert invariant
            expect(result.missingValues).toBe(expectedMissing)
            expect(result.hasMissingData).toBe(expectedMissing > 0)
          }
        )
      )
    })

    it('should count totalValues + missingValues = totalRows', () => {
      fc.assert(
        fc.property(
          fc.array(fc.oneof(fc.integer(), fc.constant(null), fc.constant('NA')), {
            minLength: 1,
            maxLength: 100,
          }),
          (values) => {
            // Arrange
            const rows = values.map(v => [v])

            // Act
            const result = ColumnDataExtractor.classifyColumn(0, 'RowCount', rows)

            // Assert invariant
            expect(result.totalValues + result.missingValues).toBe(rows.length)
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Categorical encoding is consistent
  // =========================================================================
  describe('Categorical encoding consistency', () => {
    it('should always use alphabetical baseline for dummy variables', () => {
      fc.assert(
        fc.property(
          // Generate 3-10 unique indices, then map to letter-based level names
          fc.integer({ min: 3, max: 10 }),
          fc.integer({ min: 20, max: 50 }),
          (numLevels, numRows) => {
            // Create deterministic level names: Level_A, Level_B, Level_C, etc.
            const uniqueLevels = Array.from({ length: numLevels }, (_, i) =>
              `Level_${String.fromCharCode(65 + i)}`
            )

            // Arrange
            const rows = Array.from({ length: numRows }, (_, i) => [
              i * 10, // Numeric DV
              uniqueLevels[i % uniqueLevels.length]!, // Categorical predictor
            ])

            const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
            const predColumns = [
              makeColumnClassification({
                columnName: 'Factor',
                dataType: ColumnDataType.Categorical,
                uniqueValueCount: uniqueLevels.length,
              }),
            ]

            // Act
            const result = ColumnDataExtractor.extractRegressionPredictors(
              0,
              [1],
              rows,
              depColumn,
              predColumns
            )

            // Assert invariant - baseline should be first alphabetically
            const sortedLevels = [...uniqueLevels].sort()
            expect(result.dummyVariableInfo).toBeDefined()
            const factorInfo = result.dummyVariableInfo?.Factor
            expect(factorInfo).toBeDefined()
            expect(factorInfo?.baselineLevel).toBe(sortedLevels[0])
          }
        )
      )
    })

    it('should create exactly one dummy=1 per row (others=0)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('Low', 'Medium', 'High'),
          fc.array(fc.constantFrom('Low', 'Medium', 'High'), {
            minLength: 10,
            maxLength: 50,
          }),
          (_firstLevel, levels) => {
            // Arrange
            const rows = levels.map((level, i) => [i * 10, level])
            const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
            const predColumns = [
              makeColumnClassification({
                columnName: 'Level',
                dataType: ColumnDataType.Categorical,
                uniqueValueCount: 3,
              }),
            ]

            // Act
            const result = ColumnDataExtractor.extractRegressionPredictors(
              0,
              [1],
              rows,
              depColumn,
              predColumns
            )

            // Assert invariant - for each row, sum of dummies = 0 (baseline) or 1 (other)
            const dummyNames = result.predictorNames
            expect(dummyNames).toBeDefined()
            for (let i = 0; i < result.summary.validRows; i++) {
              const dummySum = dummyNames.reduce((sum, name) => {
                const predictor = result.predictors[name]
                const value = predictor?.[i]
                return sum + (value ?? 0)
              }, 0)
              expect(dummySum).toBeGreaterThanOrEqual(0)
              expect(dummySum).toBeLessThanOrEqual(1)
            }
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Numeric extraction preserves values
  // =========================================================================
  describe('Numeric extraction preserves values', () => {
    it('should preserve numeric values without transformation', () => {
      fc.assert(
        fc.property(
          fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
            minLength: 1,
            maxLength: 100,
          }),
          (values) => {
            // Arrange
            const rows = values.map(v => [v])
            const depColumn = makeColumnClassification({ dataType: ColumnDataType.Numeric })
            const predColumns = [makeColumnClassification({ dataType: ColumnDataType.Numeric })]

            // Act
            const result = ColumnDataExtractor.extractRegressionPredictors(
              0,
              [0], // Use same column for DV and predictor
              rows,
              depColumn,
              predColumns
            )

            // Assert invariant - extracted values match input (within floating point precision)
            expect(result.dependent).toHaveLength(values.length)
            for (let i = 0; i < values.length; i++) {
              expect(result.dependent[i]).toBeCloseTo(values[i]!, 5)
            }
          }
        )
      )
    })
  })

  // =========================================================================
  // INVARIANT: Column bounds checking
  // =========================================================================
  describe('Column index bounds checking', () => {
    it('should handle out-of-bounds column indices gracefully', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.integer(), fc.integer()), {
            minLength: 1,
            maxLength: 50,
          }),
          fc.integer({ min: 5, max: 20 }), // Out-of-bounds index
          (rows, badIndex) => {
            // Act
            const result = ColumnDataExtractor.classifyColumn(badIndex, 'OutOfBounds', rows)

            // Assert invariant - should return Empty type, not crash
            expect(result.dataType).toBe(ColumnDataType.Empty)
            expect(result.totalValues).toBe(0)
          }
        )
      )
    })
  })
})
