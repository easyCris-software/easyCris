/**
 * Cox Regression Module Contract Tests
 *
 * Tests the contract between TypeScript Cox regression module and Python backend:
 * - validateSelection(): Time + event + covariate validation
 * - buildPayload(): Payload construction with categorical covariate encoding
 * - defaultParameters(): Default alpha value
 *
 * These tests verify module behavior WITHOUT calling Python backend.
 */

import { describe, it, expect } from 'vitest'
import { coxRegressionModule } from '../coxRegressionModule'
import { ColumnDataType } from '../../core/types'
import { makeColumnClassification, makeSurvivalRows } from '@/test-utils/factories'

describe('coxRegressionModule', () => {
  // =========================================================================
  // VALIDATE SELECTION
  // =========================================================================
  describe('validateSelection', () => {
    describe('Column count validation', () => {
      it('should fail when < 3 columns selected', () => {
        // Arrange - Only time + event, no covariates
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain('at least 3 columns')
        expect(result.suggestions).toContain('Select at least 3 columns:')
      })

      it('should pass with exactly 3 columns (time + event + 1 covariate)', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ columnName: 'Time', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Event', dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('Cox Regression with 1 covariate(s)')
      })

      it('should pass with 4+ columns (multiple covariates)', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Categorical }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('Cox Regression with 3 covariate(s)')
        expect(result.suggestions[0]).toContain('at least 30 events')
      })
    })

    describe('Time column validation', () => {
      it('should fail when time column is not numeric', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ columnName: 'TimeCategory', dataType: ColumnDataType.Categorical }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'TimeCategory' must be numeric")
      })

      it('should pass when time column is numeric', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ columnName: 'Months', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })
    })

    describe('Event column validation', () => {
      it('should fail when event column is not binary', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Status', dataType: ColumnDataType.Categorical, uniqueValueCount: 3 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'Status' must be binary with exactly 2 values")
        expect(result.errors[0]).toContain('Found 3 unique values')
      })

      it('should pass when event column is binary', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })

      it('should pass when event column has exactly 2 unique values (even if not classified as Binary)', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })
    })

    describe('Covariate validation', () => {
      it('should fail when covariate is empty', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ columnName: 'EmptyCovariate', dataType: ColumnDataType.Empty }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'EmptyCovariate' is empty")
      })

      it('should fail when covariate has only 1 unique value', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ columnName: 'ConstantCovariate', dataType: ColumnDataType.Numeric, uniqueValueCount: 1 }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(false)
        expect(result.errors[0]).toContain("'ConstantCovariate' has only 1 unique value")
      })

      it('should allow numeric covariates', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })

      it('should allow categorical covariates', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ columnName: 'Treatment', dataType: ColumnDataType.Categorical, uniqueValueCount: 3 }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })

      it('should allow mixed numeric and categorical covariates', () => {
        // Arrange
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Categorical }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
      })
    })

    describe('Sample size recommendations', () => {
      it('should recommend minimum events per covariate', () => {
        // Arrange - 3 covariates need at least 30 events
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, isBinary: true, uniqueValueCount: 2 }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]

        // Act
        const result = coxRegressionModule.validateSelection(columns)

        // Assert
        expect(result.isValid).toBe(true)
        expect(result.suggestions[0]).toContain('at least 30 events')
      })
    })
  })

  // =========================================================================
  // BUILD PAYLOAD
  // =========================================================================
  describe('buildPayload', () => {
    describe('Numeric covariates', () => {
      it('should build payload with single numeric covariate', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Time', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Event', dataType: ColumnDataType.Binary }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('cox_regression')
        expect(result.payload?.data.times).toBeDefined()
        expect(result.payload?.data.events).toBeDefined()
        expect(result.payload?.data.covariates).toBeDefined()
        expect(result.payload?.data.covariate_names).toEqual(['Age'])
        expect(result.payload?.parameters.alpha).toBe(0.05)
      })

      it('should build payload with multiple numeric covariates', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'numeric' }, { type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Time', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Event', dataType: ColumnDataType.Binary }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Weight', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2, 3]
        const parameters = { alpha: 0.01 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.data.covariate_names).toEqual(['Age', 'Weight'])
        expect(result.payload?.parameters.alpha).toBe(0.01)
      })
    })

    describe('Categorical covariates (dummy encoding)', () => {
      it('should build payload with categorical covariate (k-1 dummies)', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'categorical', levels: ['Control', 'Drug', 'Placebo'] }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Time', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Event', dataType: ColumnDataType.Binary }),
          makeColumnClassification({ columnName: 'Treatment', dataType: ColumnDataType.Categorical, uniqueValueCount: 3 }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.data.covariate_names).toContain('Treatment_Drug')
        expect(result.payload?.data.covariate_names).toContain('Treatment_Placebo')
        expect(result.payload?.data.covariate_names).toHaveLength(2) // k-1 dummies
        expect(result.payload?.data.dummy_variable_info).toBeDefined()
        expect(result.payload?.data.dummy_variable_info.Treatment).toEqual({
          baselineLevel: 'Control',
          dummyLevels: ['Drug', 'Placebo'],
        })
      })

      it('should build payload with mixed numeric and categorical covariates', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [
            { type: 'numeric' },
            { type: 'categorical', levels: ['A', 'B'] },
          ],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Time', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Event', dataType: ColumnDataType.Binary }),
          makeColumnClassification({ columnName: 'Age', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Group', dataType: ColumnDataType.Binary, uniqueValueCount: 2 }),
        ]
        const indices = [0, 1, 2, 3]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.data.covariate_names).toContain('Age')
        expect(result.payload?.data.covariate_names).toContain('Group_B')
        expect(result.payload?.data.covariate_names).toHaveLength(2)
      })
    })

    describe('Error handling', () => {
      it('should fail when < 3 columns provided', () => {
        // Arrange
        const rows = [[10, 1], [20, 0]]
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
        ]
        const indices = [0, 1]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(false)
        expect(result.error).toContain('at least 3 columns')
      })

      it('should fail when all rows have missing data', () => {
        // Arrange
        const rows = Array.from({ length: 100 }, () => [null, null, null])
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(false)
        expect(result.error).toContain('No valid data after removing missing values')
      })

      it('should fail when insufficient sample size (after dummy expansion)', () => {
        // Arrange - 3-level categorical creates 2 dummies = 2 parameters, need 20 observations
        const rows = makeSurvivalRows(15, {
          eventRate: 0.6,
          covariates: [{ type: 'categorical', levels: ['A', 'B', 'C'] }],
        })
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ dataType: ColumnDataType.Categorical, uniqueValueCount: 3 }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(false)
        expect(result.error).toContain('Insufficient sample size')
        expect(result.error).toContain('15 observations')
        expect(result.error).toContain('need at least 20')
      })

      it('should fail when no events observed', () => {
        // Arrange - All censored (event = 0)
        const rows = Array.from({ length: 100 }, (_, i) => [i * 10, 0, 25])
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(false)
        expect(result.error).toContain('No events observed in data')
        expect(result.error).toContain('All 100 observations are censored')
      })

      it('should succeed when sufficient events per parameter', () => {
        // Arrange - 1 parameter after dummy expansion (Binary → 1 dummy), 8 events (need 5)
        const validRows = Array.from({ length: 8 }, (_, i) => [i * 10, 1, 'A']) // 8 events
        const censoredRows = Array.from({ length: 42 }, (_, i) => [(i + 8) * 10, 0, 'B']) // 42 censored
        const rows = [...validRows, ...censoredRows]
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ dataType: ColumnDataType.Binary, uniqueValueCount: 2 }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.test).toBe('cox_regression')
        // 8 events >= 5 required (1 parameter * 5 events/param)
      })
    })

    describe('Encoding mappings', () => {
      it('should return encodingMappings for categorical covariates', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'categorical', levels: ['Low', 'Medium', 'High'] }],
        })
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ columnName: 'Stage', dataType: ColumnDataType.Categorical, uniqueValueCount: 3 }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.encodingMappings).toBeDefined()
        expect(result.encodingMappings?.get('Stage')).toBeDefined()
      })

      it('should not return encodingMappings when all covariates are numeric', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'numeric' }, { type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2, 3]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.encodingMappings).toBeUndefined()
      })
    })

    describe('Payload structure', () => {
      it('should include column names in payload', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ columnName: 'Months', dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ columnName: 'Death', dataType: ColumnDataType.Binary }),
          makeColumnClassification({ columnName: 'PatientAge', dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = { alpha: 0.05 }

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.data.time_name).toBe('Months')
        expect(result.payload?.data.event_name).toBe('Death')
        expect(result.payload?.data.covariate_names).toEqual(['PatientAge'])
      })

      it('should use default alpha when not provided', () => {
        // Arrange
        const rows = makeSurvivalRows(100, {
          eventRate: 0.6,
          covariates: [{ type: 'numeric' }],
        })
        const columns = [
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
          makeColumnClassification({ dataType: ColumnDataType.Binary }),
          makeColumnClassification({ dataType: ColumnDataType.Numeric }),
        ]
        const indices = [0, 1, 2]
        const parameters = {} // No alpha provided

        // Act
        const result = coxRegressionModule.buildPayload(columns, indices, rows, parameters)

        // Assert
        expect(result.success).toBe(true)
        expect(result.payload?.parameters.alpha).toBe(0.05)
      })
    })
  })

  // =========================================================================
  // DEFAULT PARAMETERS
  // =========================================================================
  describe('defaultParameters', () => {
    it('should return default alpha of 0.05', () => {
      // Act
      const params = coxRegressionModule.defaultParameters()

      // Assert
      expect(params).toEqual({ alpha: 0.05 })
    })
  })
})
