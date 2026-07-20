/**
 * Contract tests for nelsonAalenModule
 *
 * These tests verify the module's contract (validateSelection, buildPayload, defaultParameters)
 * WITHOUT calling the Python backend. We test the TypeScript logic that prepares data
 * and validates selections before Python execution.
 *
 * Test Coverage:
 * - validateSelection: Column count, time/event/group validation
 * - buildPayload: Single group, multiple groups, error handling, payload structure
 * - defaultParameters: Default alpha value
 */

import { describe, it, expect } from 'vitest'
import { nelsonAalenModule } from '../nelsonAalenModule'
import { ColumnDataType } from '../../core/types'
import { makeColumnClassification, makeSurvivalRows } from '@/test-utils/factories'

describe('nelsonAalenModule', () => {
  describe('validateSelection', () => {
    describe('Column count validation', () => {
      it('should fail when < 2 columns selected', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          'Nelson-Aalen requires at least 2 columns (time + event). Selected: 1.'
        )
        expect(result.suggestions).toContain('Select at least 2 columns:')
      })

      it('should pass with exactly 2 columns (time + event)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
        expect(result.errors).toHaveLength(0)
        expect(result.suggestions).toContain(
          'Single-group Nelson-Aalen: Will estimate overall cumulative hazard function.'
        )
        expect(result.suggestions).toContain(
          'Cumulative hazard H(t) represents accumulated risk. Related to survival by S(t) = exp(-H(t)).'
        )
      })

      it('should pass with exactly 3 columns (time + event + group)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
        expect(result.errors).toHaveLength(0)
        expect(result.suggestions).toContain(
          'Nelson-Aalen with 3 groups: Cumulative hazard curves will be compared.'
        )
      })

      it('should fail when > 3 columns selected', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
          makeColumnClassification({
            columnName: 'Age',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 40,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          'Nelson-Aalen accepts at most 3 columns (time + event + group). Selected: 4.'
        )
        expect(result.suggestions).toContain(
          'For multiple covariates, use Cox Regression instead.'
        )
      })
    })

    describe('Time column validation', () => {
      it('should fail when time column is not numeric', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 10,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          "Time column 'Time' must be numeric (found: Categorical)."
        )
        expect(result.suggestions).toContain(
          'Time-to-event should be a positive numeric value.'
        )
      })

      it('should pass when time column is numeric', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
      })
    })

    describe('Event column validation', () => {
      it('should fail when event column is not binary', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Categorical,
            isBinary: false,
            uniqueValueCount: 3,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          "Event column 'Event' must be binary with exactly 2 values (0=censored, 1=event). Found 3 unique values."
        )
        expect(result.suggestions).toContain('Event indicator should be coded as:')
      })

      it('should pass when event column has exactly 2 unique values', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
      })

      it('should pass when event column has 2 unique values but not marked as binary', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Categorical,
            isBinary: false,
            uniqueValueCount: 2,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
      })
    })

    describe('Group column validation', () => {
      it('should fail when group column is numeric', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Age',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 40,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          "Group column 'Age' must be categorical (found: Numeric)."
        )
        expect(result.suggestions).toContain(
          'Group column should contain category labels for comparing cumulative hazard.'
        )
      })

      it('should fail when group column has only 1 level', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 1,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          "Group column 'Treatment' has only 1 level. Need at least 2 groups for comparison."
        )
      })

      it('should fail when group column has > 10 levels', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Site',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 15,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(false)
        expect(result.errors).toContain(
          "Group column 'Site' has too many levels (15). Maximum 10 groups allowed."
        )
        expect(result.suggestions).toContain(
          'For many categorical variables, use Cox Regression with covariates instead.'
        )
      })

      it('should pass when group column is categorical with 2-10 levels', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
      })

      it('should pass when group column is binary', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const result = nelsonAalenModule.validateSelection(columns)

        expect(result.isValid).toBe(true)
      })
    })
  })

  describe('buildPayload', () => {
    describe('Single-group cumulative hazard analysis', () => {
      it('should build payload without group column', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]

        // Create survival data: 50 observations, 60% event rate
        const rows = makeSurvivalRows(50, { eventRate: 0.6 })

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)
        expect(result.payload).toBeDefined()
        expect(result.payload?.test).toBe('nelson_aalen')

        // Validate payload structure
        expect(result.payload?.data.times).toBeInstanceOf(Array)
        expect(result.payload?.data.events).toBeInstanceOf(Array)
        expect(result.payload?.data.times.length).toBe(result.payload?.data.events.length)
        expect(result.payload?.data.times.length).toBeGreaterThanOrEqual(10)

        // Should have no groups for single-group analysis
        expect(result.payload?.data.groups).toBeUndefined()
        expect(result.payload?.data.group_name).toBeUndefined()
        expect(result.payload?.data.group_levels).toBeUndefined()

        // Column names
        expect(result.payload?.data.time_name).toBe('Time')
        expect(result.payload?.data.event_name).toBe('Event')

        // Parameters
        expect(result.payload?.parameters.alpha).toBe(0.05)
      })

      it('should handle high censoring rate (few events)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]

        // Low event rate (10% events, 90% censored)
        const rows = makeSurvivalRows(50, { eventRate: 0.1 })

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)
        expect(result.payload).toBeDefined()

        // Should still work with at least 1 event
        const eventCount = result.payload?.data.events.filter((e: number) => e === 1).length
        expect(eventCount).toBeGreaterThanOrEqual(1)
      })
    })

    describe('Multi-group cumulative hazard analysis', () => {
      it('should build payload with group column (2 groups)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1, 2]

        // Create survival data with 2 groups
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          groupLevels: ['Control', 'Treatment'],
        })

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)
        expect(result.payload).toBeDefined()
        expect(result.payload?.test).toBe('nelson_aalen')

        // Validate group data
        expect(result.payload?.data.groups).toBeInstanceOf(Array)
        expect(result.payload?.data.groups?.length).toBe(result.payload?.data.times.length)
        expect(result.payload?.data.group_name).toBe('Treatment')
        expect(result.payload?.data.group_levels).toEqual(['Control', 'Treatment'])

        // Validate all groups are present
        const uniqueGroups = [...new Set(result.payload?.data.groups)]
        expect(uniqueGroups).toHaveLength(2)
        expect(uniqueGroups).toContain('Control')
        expect(uniqueGroups).toContain('Treatment')
      })

      it('should build payload with group column (3 groups)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
          makeColumnClassification({
            columnName: 'Treatment',
            dataType: ColumnDataType.Categorical,
            uniqueValueCount: 3,
          }),
        ]

        const indices = [0, 1, 2]

        // Create survival data with 3 groups
        const rows = makeSurvivalRows(150, {
          eventRate: 0.5,
          groupLevels: ['Control', 'Low Dose', 'High Dose'],
        })

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)
        expect(result.payload).toBeDefined()

        expect(result.payload?.data.group_levels).toEqual(['Control', 'High Dose', 'Low Dose'])

        const uniqueGroups = [...new Set(result.payload?.data.groups)]
        expect(uniqueGroups).toHaveLength(3)
      })
    })

    describe('Error handling', () => {
      it('should fail when < 2 columns provided', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
        ]

        const indices = [0]
        const rows = makeSurvivalRows(50, { eventRate: 0.6 })
        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(false)
        expect(result.error).toContain('Nelson-Aalen requires at least 2 columns (time + event)')
      })

      it('should fail when all rows have missing data', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]

        // All rows have null/undefined values
        const rows = Array.from({ length: 50 }, () => [null, null])

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(false)
        expect(result.error).toContain('No valid data after removing missing values')
      })

      it('should fail when insufficient sample size (< 10 observations)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 5,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]

        // Only 8 observations (< 10)
        const rows = makeSurvivalRows(8, { eventRate: 0.5 })

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(false)
        expect(result.error).toContain('Insufficient sample size')
        expect(result.error).toContain('Nelson-Aalen requires at least 10 observations')
      })

      it('should fail when no events observed (all censored)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]

        // All censored (0% event rate)
        const rows = makeSurvivalRows(50, { eventRate: 0.0 })

        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(false)
        expect(result.error).toContain('No events observed in data')
        expect(result.error).toContain('All 50 observations are censored')
        expect(result.error).toContain('Cannot estimate cumulative hazard')
      })
    })

    describe('Payload structure validation', () => {
      it('should include all required payload fields', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]
        const rows = makeSurvivalRows(50, { eventRate: 0.6 })
        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)

        // Required top-level fields
        expect(result.payload).toHaveProperty('test')
        expect(result.payload).toHaveProperty('data')
        expect(result.payload).toHaveProperty('parameters')

        // Required data fields
        expect(result.payload?.data).toHaveProperty('times')
        expect(result.payload?.data).toHaveProperty('events')
        expect(result.payload?.data).toHaveProperty('time_name')
        expect(result.payload?.data).toHaveProperty('event_name')

        // Required parameter fields
        expect(result.payload?.parameters).toHaveProperty('alpha')
      })

      it('should use custom alpha parameter when provided', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]
        const rows = makeSurvivalRows(50, { eventRate: 0.6 })
        const parameters = { alpha: 0.01 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)
        expect(result.payload?.parameters.alpha).toBe(0.01)
      })

      it('should default to alpha = 0.05 when not provided', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]
        const rows = makeSurvivalRows(50, { eventRate: 0.6 })
        const parameters = {}

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)
        expect(result.payload?.parameters.alpha).toBe(0.05)
      })
    })

    describe('Event encoding validation', () => {
      it('should preserve binary event encoding (0/1)', () => {
        const columns = [
          makeColumnClassification({
            columnName: 'Time',
            dataType: ColumnDataType.Numeric,
            uniqueValueCount: 50,
          }),
          makeColumnClassification({
            columnName: 'Event',
            dataType: ColumnDataType.Binary,
            isBinary: true,
            uniqueValueCount: 2,
          }),
        ]

        const indices = [0, 1]
        const rows = makeSurvivalRows(50, { eventRate: 0.6 })
        const parameters = { alpha: 0.05 }

        const result = nelsonAalenModule.buildPayload(columns, indices, rows, parameters)

        expect(result.success).toBe(true)

        // Events should only be 0 or 1
        const events = result.payload?.data.events
        expect(events).toBeInstanceOf(Array)

        for (const event of events ?? []) {
          expect(event === 0 || event === 1).toBe(true)
        }

        // Should have both censored and events
        const hasEvents = events?.some((e: number) => e === 1)
        const hasCensored = events?.some((e: number) => e === 0)
        expect(hasEvents).toBe(true)
        expect(hasCensored).toBe(true)
      })
    })
  })

  describe('defaultParameters', () => {
    it('should return default alpha of 0.05', () => {
      const params = nelsonAalenModule.defaultParameters()

      expect(params).toHaveProperty('alpha')
      expect(params.alpha).toBe(0.05)
    })

    it('should return an object with only alpha parameter', () => {
      const params = nelsonAalenModule.defaultParameters()

      expect(Object.keys(params)).toEqual(['alpha'])
    })
  })
})
