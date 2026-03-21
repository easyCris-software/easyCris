/**
 * ColumnDataExtractor - Survival Data Extraction Tests
 *
 * Tests extractSurvivalData method which handles:
 * - Time/event validation (negative times, non-binary events rejected)
 * - Group handling (kept as strings, not encoded)
 * - Categorical covariate encoding (k-1 dummies for Cox regression)
 * - Pairwise deletion
 * - Event count tracking (nEvents + nCensored = validRows)
 * - Summary metadata
 */

import { describe, it, expect } from 'vitest'
import { ColumnDataExtractor } from '../ColumnDataExtractor'
import { ColumnDataType } from '../types'
import { makeColumnClassification, makeSurvivalRows } from '@/test-utils/factories'

describe('ColumnDataExtractor.extractSurvivalData', () => {
  // =========================================================================
  // TIME/EVENT VALIDATION
  // =========================================================================
  describe('Time/Event validation', () => {
    it('should accept valid time (non-negative) and binary event (0 or 1)', () => {
      // Arrange
      const rows = [
        [10.5, 1], // Event at time 10.5
        [20.0, 0], // Censored at time 20.0
        [0.0, 1], // Event at time 0 (valid edge case)
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(
        0, // timeColumnIndex
        1, // eventColumnIndex
        rows
      )

      // Assert
      expect(result.times).toEqual([10.5, 20.0, 0.0])
      expect(result.events).toEqual([1, 0, 1])
      expect(result.summary.validRows).toBe(3)
      expect(result.summary.nEvents).toBe(2)
      expect(result.summary.nCensored).toBe(1)
    })

    it('should reject negative time values', () => {
      // Arrange
      const rows = [
        [10, 1], // Valid
        [-5, 1], // Invalid - negative time
        [20, 0], // Valid
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.times).toEqual([10, 20])
    })

    it('should reject non-binary event values (only 0 and 1 allowed)', () => {
      // Arrange
      const rows = [
        [10, 1], // Valid
        [20, 2], // Invalid - event must be 0 or 1
        [30, 0], // Valid
        [40, 0.5], // Invalid - event must be 0 or 1
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(2)
      expect(result.times).toEqual([10, 30])
      expect(result.events).toEqual([1, 0])
    })

    it('should reject non-numeric time values', () => {
      // Arrange
      const rows = [
        [10, 1], // Valid
        ['abc', 1], // Invalid - non-numeric time
        [20, 0], // Valid
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
    })

    it('should reject non-numeric event values', () => {
      // Arrange
      const rows = [
        [10, 1], // Valid
        [20, 'Yes'], // Invalid - non-numeric event
        [30, 0], // Valid
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
    })

    it('should reject Infinity and NaN time values', () => {
      // Arrange
      const rows = [
        [10, 1], // Valid
        [Infinity, 1], // Invalid
        [20, 0], // Valid
        [NaN, 1], // Invalid
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(2)
    })
  })

  // =========================================================================
  // GROUP HANDLING (kept as strings, not encoded)
  // =========================================================================
  describe('Group handling', () => {
    it('should extract groups as strings without encoding', () => {
      // Arrange
      const rows = [
        [10, 1, 'Control'],
        [20, 0, 'Treatment'],
        [30, 1, 'Control'],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(
        0, // time
        1, // event
        rows,
        2 // groupColumnIndex
      )

      // Assert
      expect(result.groups).toEqual(['Control', 'Treatment', 'Control'])
      expect(result.groupLevels).toEqual(['Control', 'Treatment']) // Sorted unique
    })

    it('should handle high-cardinality groups (many levels)', () => {
      // Arrange - 20 different group levels
      const levels = Array.from({ length: 20 }, (_, i) => `Group${i}`)
      const rows = levels.map((level, i) => [i * 10, i % 2, level])

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, 2)

      // Assert
      expect(result.groups).toHaveLength(20)
      expect(result.groupLevels).toHaveLength(20)
      expect(result.groupLevels).toEqual(levels.sort()) // Should be sorted
    })

    it('should drop row with missing group value', () => {
      // Arrange
      const rows = [
        [10, 1, 'Control'],
        [20, 0, null], // Missing group
        [30, 1, 'Treatment'],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, 2)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.groups).toEqual(['Control', 'Treatment'])
    })

    it('should not include groups when groupColumnIndex is undefined', () => {
      // Arrange
      const rows = [
        [10, 1],
        [20, 0],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.groups).toBeUndefined()
      expect(result.groupLevels).toBeUndefined()
    })
  })

  // =========================================================================
  // CATEGORICAL COVARIATE ENCODING (k-1 dummies for Cox regression)
  // =========================================================================
  describe('Categorical covariate encoding for Cox regression', () => {
    it('should generate k-1 dummy variables for categorical covariate', () => {
      // Arrange - 3-level categorical covariate should generate 2 dummies
      const rows = [
        [10, 1, 'Low'],
        [20, 0, 'Medium'],
        [30, 1, 'High'],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Stage',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(
        0, // time
        1, // event
        rows,
        undefined, // no group
        [2], // covariate indices
        undefined, // no group column classification
        covariateColumns
      )

      // Assert
      expect(result.covariateNames).toEqual(['Stage_Low', 'Stage_Medium'])
      expect(result.dummyVariableInfo).toEqual({
        Stage: {
          baselineLevel: 'High', // First sorted level
          dummyLevels: ['Low', 'Medium'],
        },
      })
    })

    it('should use first sorted level as baseline (all dummies = 0)', () => {
      // Arrange
      const rows = [
        [10, 1, 'Control'], // Baseline (Control < Drug < Placebo)
        [20, 0, 'Drug'],
        [30, 1, 'Placebo'],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Treatment',
          dataType: ColumnDataType.Categorical,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert - Control row should have all dummies = 0
      expect(result.covariates!.Treatment_Drug).toEqual([0, 1, 0])
      expect(result.covariates!.Treatment_Placebo).toEqual([0, 0, 1])
    })

    it('should handle binary covariates with k-1 encoding', () => {
      // Arrange - Binary categorical should create 1 dummy
      const rows = [
        [10, 1, 'No'],
        [20, 0, 'Yes'],
        [30, 1, 'No'],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Smoker',
          dataType: ColumnDataType.Binary,
          isBinary: true,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert
      expect(result.covariateNames).toEqual(['Smoker_Yes'])
      expect(result.dummyVariableInfo).toEqual({
        Smoker: {
          baselineLevel: 'No', // First sorted
          dummyLevels: ['Yes'],
        },
      })
      expect(result.covariates!.Smoker_Yes).toEqual([0, 1, 0])
    })

    it('should set exactly one dummy to 1, rest to 0 for each row', () => {
      // Arrange
      const rows = [
        [10, 1, 'Stage1'],
        [20, 0, 'Stage2'],
        [30, 1, 'Stage3'],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Disease',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert
      // Row 0: Stage1 (baseline) → all dummies = 0
      expect(result.covariates!.Disease_Stage2![0]).toBe(0)
      expect(result.covariates!.Disease_Stage3![0]).toBe(0)

      // Row 1: Stage2 → Disease_Stage2=1, Disease_Stage3=0
      expect(result.covariates!.Disease_Stage2![1]).toBe(1)
      expect(result.covariates!.Disease_Stage3![1]).toBe(0)

      // Row 2: Stage3 → Disease_Stage2=0, Disease_Stage3=1
      expect(result.covariates!.Disease_Stage2![2]).toBe(0)
      expect(result.covariates!.Disease_Stage3![2]).toBe(1)
    })

    it('should handle mixed numeric and categorical covariates', () => {
      // Arrange
      const rows = [
        [10, 1, 65, 'Low'],
        [20, 0, 70, 'High'],
        [30, 1, 55, 'Medium'],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Age',
          dataType: ColumnDataType.Numeric,
        }),
        makeColumnClassification({
          columnName: 'Risk',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(
        0, // time
        1, // event
        rows,
        undefined,
        [2, 3], // Age, Risk
        undefined,
        covariateColumns
      )

      // Assert
      expect(result.covariateNames).toEqual(['Age', 'Risk_Low', 'Risk_Medium'])
      expect(result.covariates!.Age).toEqual([65, 70, 55])
      expect(result.covariates!.Risk_Low).toEqual([1, 0, 0])
      expect(result.covariates!.Risk_Medium).toEqual([0, 0, 1])
    })

    it('should handle high-cardinality categorical covariate (20 levels → 19 dummies)', () => {
      // Arrange
      const levels = Array.from({ length: 20 }, (_, i) => `Level${i}`)
      const rows = levels.map((level, i) => [i * 10, i % 2, level])
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Gene',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 20,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert
      expect(result.covariateNames).toHaveLength(19) // 20-1 = 19 dummies
      expect(result.dummyVariableInfo).toBeDefined()
      expect(result.dummyVariableInfo?.Gene).toBeDefined()
      expect(result.dummyVariableInfo?.Gene?.dummyLevels).toHaveLength(19)
      expect(result.dummyVariableInfo?.Gene?.baselineLevel).toBe('Level0')
    })
  })

  // =========================================================================
  // NUMERIC COVARIATES (kept as-is, no encoding)
  // =========================================================================
  describe('Numeric covariates', () => {
    it('should extract numeric covariates without modification', () => {
      // Arrange
      const rows = [
        [10, 1, 65, 120],
        [20, 0, 70, 130],
        [30, 1, 55, 110],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Age',
          dataType: ColumnDataType.Numeric,
        }),
        makeColumnClassification({
          columnName: 'Weight',
          dataType: ColumnDataType.Numeric,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2, 3], undefined, covariateColumns)

      // Assert
      expect(result.covariateNames).toEqual(['Age', 'Weight'])
      expect(result.covariates!.Age).toEqual([65, 70, 55])
      expect(result.covariates!.Weight).toEqual([120, 130, 110])
      expect(result.dummyVariableInfo).toBeUndefined() // No categorical covariates
    })

    it('should reject non-numeric values in numeric covariate column', () => {
      // Arrange
      const rows = [
        [10, 1, 65],
        [20, 0, 'abc'], // Invalid - non-numeric
        [30, 1, 55],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Age',
          dataType: ColumnDataType.Numeric,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.covariates!.Age).toEqual([65, 55])
    })
  })

  // =========================================================================
  // PAIRWISE DELETION
  // =========================================================================
  describe('Missing data handling (pairwise deletion)', () => {
    it('should drop row with missing time', () => {
      // Arrange
      const rows = [
        [10, 1],
        [null, 0],
        [20, 1],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.times).toEqual([10, 20])
    })

    it('should drop row with missing event', () => {
      // Arrange
      const rows = [
        [10, 1],
        [20, null],
        [30, 0],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.events).toEqual([1, 0])
    })

    it('should drop row with missing covariate', () => {
      // Arrange
      const rows = [
        [10, 1, 65],
        [20, 0, null], // Missing covariate
        [30, 1, 55],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Age',
          dataType: ColumnDataType.Numeric,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(1)
      expect(result.covariates!.Age).toEqual([65, 55])
    })

    it('should drop row with missing in any column', () => {
      // Arrange - 5 columns: time, event, group, cov1, cov2
      const rows = [
        [10, 1, 'Control', 65, 120], // Valid
        [null, 0, 'Treatment', 70, 130], // Missing time
        [20, null, 'Control', 75, 140], // Missing event
        [30, 1, null, 80, 150], // Missing group
        [40, 0, 'Treatment', null, 160], // Missing cov1
        [50, 1, 'Control', 85, null], // Missing cov2
        [60, 0, 'Treatment', 90, 170], // Valid
      ]
      const covariateColumns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, 2, [3, 4], undefined, covariateColumns)

      // Assert
      expect(result.summary.validRows).toBe(2)
      expect(result.summary.skippedRows).toBe(5)
      expect(result.times).toEqual([10, 60])
    })

    it('should ensure validRows + skippedRows = totalRows', () => {
      // Arrange
      const rows = makeSurvivalRows(200, {
        eventRate: 0.6,
        covariates: [{ type: 'numeric' }, { type: 'categorical', levels: ['A', 'B', 'C'] }],
        missingRate: 0.2, // 20% missing
      })
      const covariateColumns = [
        makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        makeColumnClassification({ dataType: ColumnDataType.Categorical }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2, 3], undefined, covariateColumns)

      // Assert
      expect(result.summary.validRows + result.summary.skippedRows).toBe(result.summary.totalRows)
      expect(result.summary.totalRows).toBe(200)
    })
  })

  // =========================================================================
  // EVENT COUNT TRACKING (nEvents + nCensored = validRows)
  // =========================================================================
  describe('Event count tracking', () => {
    it('should correctly count events and censored observations', () => {
      // Arrange
      const rows = [
        [10, 1], // Event
        [20, 0], // Censored
        [30, 1], // Event
        [40, 1], // Event
        [50, 0], // Censored
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.nEvents).toBe(3)
      expect(result.summary.nCensored).toBe(2)
      expect(result.summary.nEvents + result.summary.nCensored).toBe(result.summary.validRows)
    })

    it('should ensure nEvents + nCensored = validRows (invariant)', () => {
      // Arrange
      const rows = makeSurvivalRows(100, {
        eventRate: 0.7, // 70% event rate
        missingRate: 0.1, // 10% missing
      })

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.nEvents + result.summary.nCensored).toBe(result.summary.validRows)
    })

    it('should handle all events (no censoring)', () => {
      // Arrange
      const rows = Array.from({ length: 50 }, (_, i) => [i * 10, 1])

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.nEvents).toBe(50)
      expect(result.summary.nCensored).toBe(0)
    })

    it('should handle all censored (no events)', () => {
      // Arrange
      const rows = Array.from({ length: 50 }, (_, i) => [i * 10, 0])

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.nEvents).toBe(0)
      expect(result.summary.nCensored).toBe(50)
    })
  })

  // =========================================================================
  // SUMMARY METADATA
  // =========================================================================
  describe('Summary metadata', () => {
    it('should report correct validRows after pairwise deletion', () => {
      // Arrange
      const rows = makeSurvivalRows(100, {
        eventRate: 0.5,
        missingRate: 0, // No missing data
      })

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(100)
      expect(result.times).toHaveLength(100)
      expect(result.events).toHaveLength(100)
    })

    it('should report correct totalRows before deletion', () => {
      // Arrange
      const rows = makeSurvivalRows(150, {
        eventRate: 0.6,
        missingRate: 0.3,
      })

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.totalRows).toBe(150)
    })

    it('should report correct skippedRows', () => {
      // Arrange - exactly 10 rows with missing data
      const validRows = Array.from({ length: 90 }, (_, i) => [i * 10, i % 2])
      const invalidRows = Array.from({ length: 10 }, () => [null, 1])
      const rows = [...validRows, ...invalidRows]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

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

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(0)
      expect(result.summary.totalRows).toBe(0)
      expect(result.times).toEqual([])
      expect(result.events).toEqual([])
    })

    it('should handle all rows with missing data', () => {
      // Arrange
      const rows = Array.from({ length: 50 }, () => [null, null])

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(0)
      expect(result.summary.skippedRows).toBe(50)
    })

    it('should handle single valid row', () => {
      // Arrange
      const rows = [[10.5, 1]]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.summary.validRows).toBe(1)
      expect(result.times).toEqual([10.5])
      expect(result.events).toEqual([1])
      expect(result.summary.nEvents).toBe(1)
      expect(result.summary.nCensored).toBe(0)
    })

    it('should handle categorical covariate with only one observed level after pairwise deletion', () => {
      // Arrange - all rows with level 'B' have missing time, only 'A' remains
      const rows = [
        [10, 1, 'A'],
        [null, 0, 'B'],
        [20, 1, 'A'],
        [null, 1, 'B'],
      ]
      const covariateColumns = [
        makeColumnClassification({
          columnName: 'Factor',
          dataType: ColumnDataType.Categorical,
        }),
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, undefined, [2], undefined, covariateColumns)

      // Assert - should still create dummies based on all original levels
      expect(result.summary.validRows).toBe(2)
      expect(result.covariateNames!.length).toBeGreaterThan(0)
    })

    it('should handle no covariates specified', () => {
      // Arrange
      const rows = [
        [10, 1],
        [20, 0],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows)

      // Assert
      expect(result.covariates).toBeUndefined()
      expect(result.covariateNames).toBeUndefined()
      expect(result.dummyVariableInfo).toBeUndefined()
    })

    it('should handle group column with single level', () => {
      // Arrange - all rows have same group
      const rows = [
        [10, 1, 'Control'],
        [20, 0, 'Control'],
        [30, 1, 'Control'],
      ]

      // Act
      const result = ColumnDataExtractor.extractSurvivalData(0, 1, rows, 2)

      // Assert
      expect(result.groups).toEqual(['Control', 'Control', 'Control'])
      expect(result.groupLevels).toEqual(['Control'])
    })
  })
})
