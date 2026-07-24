/**
 * lmmAnovaModule — trajectory_roles payload emission
 *
 * Tests that buildPayload emits trajectory_roles when config has trajectoryRoles,
 * and omits the key when it doesn't.
 *
 * RED: all tests fail until trajectoryRoles is added to LmmConfig and emitted.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { lmmAnovaModule } from '../lmmAnovaModule'
import { ColumnDataType } from '../../core/types'
import { makeColumnClassification } from '@/test-utils/factories'

function makeColumns() {
  return [
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
      columnName: 'arm',
      columnId: 'arm',
      dataType: ColumnDataType.Categorical,
      uniqueValueCount: 2,
      uniqueValues: ['VEH', 'THC'],
      numericValues: 0,
      categoricalValues: 6,
      numericRatio: 0,
    }),
    makeColumnClassification({
      columnName: 'visit_week',
      columnId: 'visit_week',
      dataType: ColumnDataType.Numeric,
      uniqueValueCount: 3,
      uniqueValues: ['0', '1', '2'],
      numericValues: 6,
      categoricalValues: 0,
      numericRatio: 1,
    }),
    makeColumnClassification({
      columnName: 'sex',
      columnId: 'sex',
      dataType: ColumnDataType.Categorical,
      uniqueValueCount: 2,
      uniqueValues: ['M', 'F'],
      numericValues: 0,
      categoricalValues: 6,
      numericRatio: 0,
    }),
  ]
}

function makeRows() {
  return [
    { value: 10, sample_id: 'S1', arm: 'VEH', visit_week: 0, sex: 'M' },
    { value: 11, sample_id: 'S1', arm: 'VEH', visit_week: 1, sex: 'M' },
    { value: 12, sample_id: 'S2', arm: 'THC', visit_week: 0, sex: 'F' },
    { value: 13, sample_id: 'S2', arm: 'THC', visit_week: 1, sex: 'F' },
    { value: 14, sample_id: 'S3', arm: 'VEH', visit_week: 0, sex: 'F' },
    { value: 15, sample_id: 'S3', arm: 'VEH', visit_week: 1, sex: 'F' },
  ]
}

describe('lmmAnovaModule.buildPayload — trajectoryRoles', () => {
  it('emits trajectory_roles in payload when config includes trajectoryRoles', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'arm',
          timeFactorId: 'visit_week',
          treatmentReferenceLevel: 'VEH',
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const trajectoryRoles = (result.payload as any).parameters.trajectory_roles
    expect(trajectoryRoles).toBeDefined()
    expect(trajectoryRoles.treatment_factor).toBe('arm')
    expect(trajectoryRoles.time_factor).toBe('visit_week')
    expect(trajectoryRoles.reference_level).toBe('VEH')
  })

  it('omits trajectory_roles from payload when config has no trajectoryRoles', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        // No trajectoryRoles
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const trajectoryRoles = (result.payload as any).parameters.trajectory_roles
    expect(trajectoryRoles).toBeUndefined()
  })

  it('resolves column names from IDs when emitting trajectory_roles', () => {
    // Column ID is 'arm' → columnName is 'arm'; ID is 'visit_week' → columnName is 'visit_week'
    // trajectory_roles in payload must use column names, not IDs
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'arm',
          timeFactorId: 'visit_week',
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const trajectoryRoles = (result.payload as any).parameters.trajectory_roles
    expect(trajectoryRoles.treatment_factor).toBe('arm')  // columnName 'arm'
    expect(trajectoryRoles.time_factor).toBe('visit_week')  // columnName 'visit_week'
    expect(trajectoryRoles.reference_level).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveTrajectoryRoles — warn+omit branch (Reviewer B Issue 3)
// ---------------------------------------------------------------------------

describe('lmmAnovaModule.buildPayload — resolveTrajectoryRoles warn+omit path', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('omits trajectory_roles and warns once when treatmentFactorId cannot be resolved to a column', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const columns = makeColumns()

    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'nonexistent_column_id',  // ← ID that does not resolve
          timeFactorId: 'visit_week',
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    // trajectory_roles must be omitted (not emitted with undefined column name)
    const trajectoryRoles = (result.payload as any).parameters.trajectory_roles
    expect(trajectoryRoles).toBeUndefined()

    // console.warn must have been called exactly once with recognizable context
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[lmmAnovaModule]'),
      expect.anything(),
    )
  })

  it('omits trajectory_roles and warns when timeFactorId cannot be resolved', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const columns = makeColumns()

    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'arm',
          timeFactorId: 'nonexistent_time_id',  // ← ID that does not resolve
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const trajectoryRoles = (result.payload as any).parameters.trajectory_roles
    expect(trajectoryRoles).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// buildPayload warnings field — user-visible channel for dropped trajectory_roles
// ---------------------------------------------------------------------------

describe('lmmAnovaModule.buildPayload — warnings field for dropped trajectory_roles', () => {
  it('populates result.warnings when same-ID trajectory_roles are dropped', () => {
    const columns = makeColumns()

    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'arm',
          timeFactorId: 'arm',  // same as treatmentFactorId → dropped
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings!.some(w => w.toLowerCase().includes('trajectory'))).toBe(true)
  })

  it('populates result.warnings when trajectory_roles column ID cannot be resolved', () => {
    const columns = makeColumns()

    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'nonexistent_id',
          timeFactorId: 'visit_week',
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings!.some(w => w.toLowerCase().includes('trajectory'))).toBe(true)
  })

  it('result.warnings is undefined (or empty) when trajectory_roles are valid and emitted', () => {
    const columns = makeColumns()

    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'arm',
          timeFactorId: 'visit_week',
        },
      },
    })

    expect(result.success).toBe(true)
    const hasNoWarnings = !result.warnings || result.warnings.length === 0
    expect(hasNoWarnings).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// same-ID guard: treatment_factor === time_factor
// ---------------------------------------------------------------------------

describe('lmmAnovaModule.buildPayload — resolveTrajectoryRoles same-ID guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('omits trajectory_roles and warns when treatmentFactorId and timeFactorId resolve to the same column name', () => {
    // Belt-and-suspenders: if both roles resolve to the same column, the payload is invalid.
    // The dialog normalizer prevents this in normal flow, but the payload builder must guard too.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const columns = makeColumns()

    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        trajectoryRoles: {
          treatmentFactorId: 'arm',
          timeFactorId: 'arm',  // same as treatmentFactorId → invalid
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const trajectoryRoles = (result.payload as any).parameters.trajectory_roles
    expect(trajectoryRoles).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[lmmAnovaModule]'),
      expect.anything(),
    )
  })
})
