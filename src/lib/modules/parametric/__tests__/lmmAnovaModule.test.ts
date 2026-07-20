import { describe, it, expect } from 'vitest'
import { getTestDefinition, TEST_GROUPS } from '@/config/testRegistry'
import { moduleRegistry } from '@/lib/modules/core/ModuleRegistry'
import { lmmAnovaModule } from '../lmmAnovaModule'
import { ColumnDataType } from '../../core/types'
import { makeColumnClassification } from '@/test-utils/factories'

function makeRows() {
  return [
    { value: 1.1, sample_id: 'S1', treatment: 'Control', sex: 'M', day_num: 0 },
    { value: 1.4, sample_id: 'S1', treatment: 'Control', sex: 'M', day_num: 1 },
    { value: 1.7, sample_id: 'S2', treatment: 'Drug', sex: 'F', day_num: 0 },
    { value: 2.0, sample_id: 'S2', treatment: 'Drug', sex: 'F', day_num: 1 },
    { value: 2.1, sample_id: 'S3', treatment: 'Control', sex: 'F', day_num: 0 },
    { value: 2.5, sample_id: 'S3', treatment: 'Control', sex: 'F', day_num: 1 },
  ]
}

describe('lmmAnovaModule', () => {
  it('registers lmm_anova as a parametric hypothesis test with a dedicated module', async () => {
    const testDef = getTestDefinition('lmm_anova')

    expect(testDef).toBeDefined()
    expect(testDef?.displayName).toBe('Linear Mixed Model')
    expect(testDef?.family).toBe('parametric')
    expect(testDef?.moduleId).toBe('lmm_anova')
    expect(TEST_GROUPS.find(group => group.id === 'hypothesis_testing')?.testIds).toContain('lmm_anova')

    const module = await moduleRegistry.getModule('lmm_anova')
    expect(module?.moduleId).toBe('lmm_anova')
  })

  describe('validateSelection', () => {
    it('fails when fewer than 3 candidate columns are selected', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
      ]

      const result = lmmAnovaModule.validateSelection(columns)

      expect(result.isValid).toBe(false)
      expect(result.errors[0]).toContain('at least 3 columns')
    })

    it('passes with mixed candidate columns and suggests LMM configuration', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'day_num',
          columnId: 'day_num',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 2,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.validateSelection(columns)

      expect(result.isValid).toBe(true)
      expect(result.suggestions[0]).toContain('Linear Mixed Model')
    })
  })

  describe('buildPayload', () => {
    it('fails when stratified mode is requested without stratification factors', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['treatment'],
          predictorTypes: { treatment: 'categorical' },
          stratified: true,
          stratifyBy: [],
          reml: false,
          interactionDepth: 1,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/at least one stratification factor/i)
    })

    it('fails when a requested stratification factor is not categorical', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Sex Code',
          columnId: 'sex_code',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 2,
          uniqueValues: ['0', '1'],
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['treatment'],
          predictorTypes: { treatment: 'categorical' },
          stratified: true,
          stratifyBy: ['sex_code'],
          reml: false,
          interactionDepth: 1,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/must be categorical/i)
    })

    it('fails when a requested stratification factor has fewer than two profiled levels', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Sex',
          columnId: 'sex',
          dataType: ColumnDataType.Binary,
          uniqueValueCount: 1,
          uniqueValues: ['F'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
          isBinary: true,
        }),
      ]

      const singleLevelRows = makeRows().map(row => ({
        ...row,
        sex: 'F',
      }))

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], singleLevelRows, {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['treatment'],
          predictorTypes: { treatment: 'categorical' },
          stratified: true,
          stratifyBy: ['sex'],
          reml: false,
          interactionDepth: 1,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/at least two levels/i)
    })

    it('does not reject stratification when profile metadata lacks levels but analyzed rows include 2+ levels', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Sex',
          columnId: 'sex',
          dataType: ColumnDataType.Binary,
          uniqueValueCount: 0,
          uniqueValues: [],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
          isBinary: true,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['treatment'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
          },
          stratified: true,
          stratifyBy: ['sex'],
          reml: false,
          interactionDepth: 1,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
        },
      })

      expect(result.success).toBe(true)
      expect(result.payload?.parameters.stratify_by).toEqual(['Sex'])
    })

    it('includes stratification columns in backend predictors while keeping tested predictors formula-only', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'sex',
          columnId: 'sex',
          dataType: ColumnDataType.Binary,
          uniqueValueCount: 2,
          uniqueValues: ['M', 'F'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
          isBinary: true,
        }),
        makeColumnClassification({
          columnName: 'day_num',
          columnId: 'day_num',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 2,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3, 4], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['day_num'],
          predictorTypes: {
            day_num: 'continuous',
          },
          stratified: true,
          stratifyBy: ['sex', 'treatment'],
          reml: false,
          interactionDepth: 1,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
        },
      })

      expect(result.success).toBe(true)
      expect(result.payload?.data.predictors).toEqual({
        day_num: [0, 1, 0, 1, 0, 1],
        sex: ['M', 'M', 'F', 'F', 'F', 'F'],
        treatment: ['Control', 'Control', 'Drug', 'Drug', 'Control', 'Control'],
      })
      expect(result.payload?.data.predictor_types).toEqual({
        day_num: 'continuous',
        sex: 'categorical',
        treatment: 'categorical',
      })
      expect(result.payload?.parameters.stratify_by).toEqual(['sex', 'treatment'])
    })

    it('builds the Python payload from controller-style row-major arrays', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'sex',
          columnId: 'sex',
          dataType: ColumnDataType.Binary,
          uniqueValueCount: 2,
          uniqueValues: ['M', 'F'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
          isBinary: true,
        }),
        makeColumnClassification({
          columnName: 'day_num',
          columnId: 'day_num',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 2,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const rowMajorRows = makeRows().map((row) => [
        row.value,
        row.sample_id,
        row.treatment,
        row.sex,
        row.day_num,
      ])

      const result = lmmAnovaModule.buildPayload(
        columns,
        [0, 1, 2, 3, 4],
        rowMajorRows,
        {
          alpha: 0.05,
          lmm_config: {
            dependentColumnId: 'value',
            subjectColumnId: 'sample_id',
            predictorColumnIds: ['treatment', 'sex', 'day_num'],
            predictorTypes: {
              treatment: 'categorical',
              sex: 'categorical',
              day_num: 'continuous',
            },
            stratified: true,
            stratifyBy: ['treatment', 'sex'],
            reml: false,
            interactionDepth: 2,
            dfMethod: 'satterthwaite',
            randomEffectsMode: 'random_intercept',
            adjustmentMethod: 'tukey',
            controlLevels: {},
          },
        }
      )

      expect(result.success).toBe(true)
      expect(result.payload?.data.dependent).toEqual([1.1, 1.4, 1.7, 2, 2.1, 2.5])
      expect(result.payload?.data.subject).toEqual(['S1', 'S1', 'S2', 'S2', 'S3', 'S3'])
      expect(result.payload?.data.predictors).toEqual({
        treatment: ['Control', 'Control', 'Drug', 'Drug', 'Control', 'Control'],
        sex: ['M', 'M', 'F', 'F', 'F', 'F'],
        day_num: [0, 1, 0, 1, 0, 1],
      })
      expect(result.payload?.parameters.stratify_by).toEqual(['treatment', 'sex'])
    })

    it('builds the Python payload using subject, predictors, predictor types, and random-effects config', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'sex',
          columnId: 'sex',
          dataType: ColumnDataType.Binary,
          uniqueValueCount: 2,
          uniqueValues: ['M', 'F'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
          isBinary: true,
        }),
        makeColumnClassification({
          columnName: 'day_num',
          columnId: 'day_num',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 2,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(
        columns,
        [0, 1, 2, 3, 4],
        makeRows(),
        {
          alpha: 0.05,
          lmm_config: {
            dependentColumnId: 'value',
            subjectColumnId: 'sample_id',
            predictorColumnIds: ['treatment', 'sex', 'day_num'],
            predictorTypes: {
              treatment: 'categorical',
              sex: 'categorical',
              day_num: 'continuous',
            },
            stratified: true,
            stratifyBy: ['sex'],
            reml: true,
            interactionDepth: 2,
            dfMethod: 'satterthwaite',
            randomEffectsMode: 'random_slope',
            randomSlopeTarget: 'day_num',
            adjustmentMethod: 'tukey',
            controlLevels: {},
          },
          simple_effects: [{ factor: 'treatment', within: 'sex' }],
          posthoc_adjustment: 'holm',
          control_levels: { treatment: 'Control', sex: 'M' },
          posthoc_q: 0.1,
        }
      )

      expect(result.success).toBe(true)
      expect(result.payload?.test).toBe('lmm_anova')
      expect(result.payload?.data.dependent).toEqual([1.1, 1.4, 1.7, 2, 2.1, 2.5])
      expect(result.payload?.data.subject).toEqual(['S1', 'S1', 'S2', 'S2', 'S3', 'S3'])
      expect(result.payload?.data.predictors).toEqual({
        treatment: ['Control', 'Control', 'Drug', 'Drug', 'Control', 'Control'],
        sex: ['M', 'M', 'F', 'F', 'F', 'F'],
        day_num: [0, 1, 0, 1, 0, 1],
      })
      expect(result.payload?.data.predictor_types).toEqual({
        treatment: 'categorical',
        sex: 'categorical',
        day_num: 'continuous',
      })
      expect(result.payload?.parameters.reml).toBe(true)
      expect(result.payload?.parameters.interaction_depth).toBe(2)
      expect(result.payload?.parameters.df_method).toBe('satterthwaite')
      expect(result.payload?.parameters.random_effects_config).toEqual({
        group_var: 'sample_id',
        group_values: ['S1', 'S1', 'S2', 'S2', 'S3', 'S3'],
        random_intercept: true,
        random_slopes: ['day_num'],
      })
      expect(result.payload?.parameters.simple_effects).toEqual([{ factor: 'treatment', within: 'sex' }])
      expect(result.payload?.parameters.posthoc_adjustment).toBe('holm')
      expect(result.payload?.parameters.control_levels).toEqual({ treatment: 'Control', sex: 'M' })
      expect(result.payload?.parameters.posthoc_q).toBeUndefined()
      expect(result.payload?.parameters.stratify_by).toEqual(['sex'])
    })

    it('allows numeric-time follow-up config for random-slope models and uses the centered/scaled backend path', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'uuid-treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Day_num',
          columnId: 'uuid-day',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 5,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['uuid-treatment', 'uuid-day'],
          predictorTypes: {
            'uuid-treatment': 'categorical',
            'uuid-day': 'continuous',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_slope',
          randomSlopeTarget: 'uuid-day',
          adjustmentMethod: 'holm',
          controlLevels: {},
          continuousEffectsConfig: {
            mode: 'at_values',
            groupFactorId: 'uuid-treatment',
            timeFactorId: 'uuid-day',
            timeValues: [0, 2, 4],
          },
        },
      })

      expect(result.success).toBe(true)
      expect(result.payload?.parameters.continuous_effects_config).toEqual({
        mode: 'at_values',
        group_factor: 'Treatment',
        time_factor: 'Day_num',
        time_values: [0, 2, 4],
        time_transform: 'center_scale',
      })
    })

    it('fails when numeric-time follow-up factor ids can no longer be resolved', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'uuid-treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Day_num',
          columnId: 'uuid-day',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 5,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['uuid-treatment', 'uuid-day'],
          predictorTypes: {
            'uuid-treatment': 'categorical',
            'uuid-day': 'continuous',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_slope',
          randomSlopeTarget: 'uuid-day',
          adjustmentMethod: 'holm',
          controlLevels: {},
          continuousEffectsConfig: {
            mode: 'at_values',
            groupFactorId: 'missing-group-id',
            timeFactorId: 'uuid-day',
            timeValues: [0, 2, 4],
          },
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/numeric-time follow-up factors could not be resolved/i)
    })

    it('falls back to dialog-owned adjustment settings when controller parameters omit them', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'treatment',
          columnId: 'treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'day_num',
          columnId: 'day_num',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 2,
          numericValues: 6,
          categoricalValues: 0,
          numericRatio: 1,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['treatment', 'day_num'],
          predictorTypes: {
            treatment: 'categorical',
            day_num: 'continuous',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'fdr_bh',
          controlLevels: {},
          posthocQ: 0.1,
        },
      })

      expect(result.success).toBe(true)
      expect(result.payload?.parameters.posthoc_adjustment).toBe('fdr_bh')
      expect(result.payload?.parameters.posthoc_q).toBe(0.1)
    })

    it('remaps dialog-owned Dunnett control levels from column ids to backend column names', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'uuid-value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'uuid-subject',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'uuid-treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Sex',
          columnId: 'uuid-sex',
          dataType: ColumnDataType.Binary,
          uniqueValueCount: 2,
          uniqueValues: ['M', 'F'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
          isBinary: true,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'uuid-value',
          subjectColumnId: 'uuid-subject',
          predictorColumnIds: ['uuid-treatment', 'uuid-sex'],
          predictorTypes: {
            'uuid-treatment': 'categorical',
            'uuid-sex': 'categorical',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'dunnett',
          controlLevels: {
            'uuid-treatment': 'Control',
            'uuid-sex': 'M',
          },
        },
      })

      expect(result.success).toBe(true)
      expect(result.payload?.parameters.posthoc_adjustment).toBe('dunnett')
      expect(result.payload?.parameters.control_levels).toEqual({
        Treatment: 'Control',
        Sex: 'M',
      })
    })

    it('does not forward posthoc_q when the active adjustment method is not fdr_bh', () => {
      const columns = [
        makeColumnClassification({
          columnName: 'value',
          columnId: 'value',
          dataType: ColumnDataType.Numeric,
          uniqueValueCount: 10,
        }),
        makeColumnClassification({
          columnName: 'sample_id',
          columnId: 'sample_id',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 3,
          uniqueValues: ['S1', 'S2', 'S3'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
        makeColumnClassification({
          columnName: 'Treatment',
          columnId: 'uuid-treatment',
          dataType: ColumnDataType.Categorical,
          uniqueValueCount: 2,
          uniqueValues: ['Control', 'Drug'],
          numericValues: 0,
          categoricalValues: 6,
          numericRatio: 0,
        }),
      ]

      const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2], makeRows(), {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['uuid-treatment'],
          predictorTypes: {
            'uuid-treatment': 'categorical',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 1,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
          posthocQ: 0.2,
        },
      })

      expect(result.success).toBe(true)
      expect(result.payload?.parameters.posthoc_adjustment).toBe('tukey')
      expect(result.payload?.parameters.posthoc_q).toBeUndefined()
    })
  })

  it('forwards kenward_roger df method when selected', () => {
    const columns = [
      makeColumnClassification({
        columnName: 'value',
        columnId: 'value',
        dataType: ColumnDataType.Numeric,
        uniqueValueCount: 10,
      }),
      makeColumnClassification({
        columnName: 'sample_id',
        columnId: 'sample_id',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
        uniqueValues: ['S1', 'S2', 'S3'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
      makeColumnClassification({
        columnName: 'treatment',
        columnId: 'treatment',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 2,
        uniqueValues: ['Control', 'Drug'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
      makeColumnClassification({
        columnName: 'day_num',
        columnId: 'day_num',
        dataType: ColumnDataType.Numeric,
        uniqueValueCount: 2,
        numericValues: 6,
        categoricalValues: 0,
        numericRatio: 1,
      }),
    ]

    const result = lmmAnovaModule.buildPayload(
      columns,
      [0, 1, 2, 3],
      makeRows(),
      {
        alpha: 0.05,
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['treatment', 'day_num'],
          predictorTypes: {
            treatment: 'categorical',
            day_num: 'continuous',
          },
          stratified: false,
          stratifyBy: [],
          reml: true,
          interactionDepth: 2,
          dfMethod: 'kenward_roger',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
        },
      }
    )

    expect(result.success).toBe(true)
    expect(result.payload?.parameters.df_method).toBe('kenward_roger')
  })

  it('moves the trajectory reference level first in factor labels for R-parity contrast orientation', () => {
    const columns = [
      makeColumnClassification({
        columnName: 'Value',
        columnId: 'value',
        dataType: ColumnDataType.Numeric,
        uniqueValueCount: 10,
      }),
      makeColumnClassification({
        columnName: 'ID',
        columnId: 'id',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
        uniqueValues: ['S1', 'S2', 'S3'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
      makeColumnClassification({
        columnName: 'Condition',
        columnId: 'condition',
        dataType: ColumnDataType.Binary,
        uniqueValueCount: 2,
        uniqueValues: ['THC', 'VEH'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
        isBinary: true,
      }),
      makeColumnClassification({
        columnName: 'Day',
        columnId: 'day',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 2,
        uniqueValues: ['0', '1'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
    ]
    const rows = [
      { value: 1.1, id: 'S1', condition: 'VEH', day: '0' },
      { value: 1.4, id: 'S1', condition: 'VEH', day: '1' },
      { value: 1.7, id: 'S2', condition: 'THC', day: '0' },
      { value: 2.0, id: 'S2', condition: 'THC', day: '1' },
      { value: 2.1, id: 'S3', condition: 'VEH', day: '0' },
      { value: 2.5, id: 'S3', condition: 'THC', day: '1' },
    ]

    const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2, 3], rows, {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'id',
        predictorColumnIds: ['condition', 'day'],
        predictorTypes: {
          condition: 'categorical',
          day: 'categorical',
        },
        stratified: false,
        stratifyBy: [],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'condition',
          timeFactorId: 'day',
          treatmentReferenceLevel: 'VEH',
        },
      },
    })

    expect(result.success).toBe(true)
    expect((result.payload?.data.factor_level_labels as Record<string, string[]>)?.Condition).toEqual(['VEH', 'THC'])
  })

  // ---------------------------------------------------------------------------
  // Outcome label metadata — Task 2
  // ---------------------------------------------------------------------------

  it('emits dependent_name in payload data matching the dependent column name', () => {
    const columns = [
      makeColumnClassification({
        columnName: 'Temperature (°C)',
        columnId: 'temp',
        dataType: ColumnDataType.Numeric,
        uniqueValueCount: 10,
      }),
      makeColumnClassification({
        columnName: 'mouse_id',
        columnId: 'mouse_id',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
        uniqueValues: ['M1', 'M2', 'M3'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
      makeColumnClassification({
        columnName: 'treatment',
        columnId: 'treatment',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 2,
        uniqueValues: ['VEH', 'THC'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
    ]

    const rows = [
      { temp: 36.5, mouse_id: 'M1', treatment: 'VEH' },
      { temp: 37.2, mouse_id: 'M2', treatment: 'THC' },
      { temp: 36.8, mouse_id: 'M3', treatment: 'VEH' },
    ]

    const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2], rows, {
      alpha: 0.05,
      lmm_config: {
        dependentColumnId: 'temp',
        subjectColumnId: 'mouse_id',
        predictorColumnIds: ['treatment'],
        predictorTypes: { treatment: 'categorical' },
        stratified: false,
        stratifyBy: [],
        reml: false,
        interactionDepth: 1,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
      },
    })

    expect(result.success).toBe(true)
    expect((result.payload?.data as Record<string, unknown>)?.['dependent_name']).toBe('Temperature (°C)')
  })

  it('emits value_column in payload data matching the dependent column name', () => {
    const columns = [
      makeColumnClassification({
        columnName: 'Body Weight (g)',
        columnId: 'weight',
        dataType: ColumnDataType.Numeric,
        uniqueValueCount: 10,
      }),
      makeColumnClassification({
        columnName: 'mouse_id',
        columnId: 'mouse_id',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
        uniqueValues: ['M1', 'M2', 'M3'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
      makeColumnClassification({
        columnName: 'treatment',
        columnId: 'treatment',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 2,
        uniqueValues: ['VEH', 'THC'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
    ]

    const rows = [
      { weight: 22.1, mouse_id: 'M1', treatment: 'VEH' },
      { weight: 23.5, mouse_id: 'M2', treatment: 'THC' },
      { weight: 21.9, mouse_id: 'M3', treatment: 'VEH' },
    ]

    const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2], rows, {
      alpha: 0.05,
      lmm_config: {
        dependentColumnId: 'weight',
        subjectColumnId: 'mouse_id',
        predictorColumnIds: ['treatment'],
        predictorTypes: { treatment: 'categorical' },
        stratified: false,
        stratifyBy: [],
        reml: false,
        interactionDepth: 1,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
      },
    })

    expect(result.success).toBe(true)
    expect((result.payload?.data as Record<string, unknown>)?.['value_column']).toBe('Body Weight (g)')
  })

  it('dependent_name and value_column match each other (same source: dependent column name)', () => {
    const columns = [
      makeColumnClassification({
        columnName: 'Latency (ms)',
        columnId: 'latency',
        dataType: ColumnDataType.Numeric,
        uniqueValueCount: 10,
      }),
      makeColumnClassification({
        columnName: 'mouse_id',
        columnId: 'mouse_id',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 3,
        uniqueValues: ['M1', 'M2', 'M3'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
      makeColumnClassification({
        columnName: 'treatment',
        columnId: 'treatment',
        dataType: ColumnDataType.Categorical,
        uniqueValueCount: 2,
        uniqueValues: ['VEH', 'THC'],
        numericValues: 0,
        categoricalValues: 6,
        numericRatio: 0,
      }),
    ]

    const rows = [
      { latency: 100, mouse_id: 'M1', treatment: 'VEH' },
      { latency: 150, mouse_id: 'M2', treatment: 'THC' },
      { latency: 120, mouse_id: 'M3', treatment: 'VEH' },
    ]

    const result = lmmAnovaModule.buildPayload(columns, [0, 1, 2], rows, {
      alpha: 0.05,
      lmm_config: {
        dependentColumnId: 'latency',
        subjectColumnId: 'mouse_id',
        predictorColumnIds: ['treatment'],
        predictorTypes: { treatment: 'categorical' },
        stratified: false,
        stratifyBy: [],
        reml: false,
        interactionDepth: 1,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
      },
    })

    const data = result.payload?.data as Record<string, unknown>
    expect(data?.['dependent_name']).toBe(data?.['value_column'])
    expect(data?.['dependent_name']).toBe('Latency (ms)')
  })
})
