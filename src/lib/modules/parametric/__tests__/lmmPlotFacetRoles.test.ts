/**
 * lmmAnovaModule — plot_facet_roles payload emission
 *
 * Tests that buildPayload emits plot_facet_roles in parameters when config has
 * plotFacetRoles, and omits it when absent.
 *
 * RED: all tests fail until plotFacetRoles is added to LmmConfig and emitted.
 */

import { describe, it, expect } from 'vitest'
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
    makeColumnClassification({
      columnName: 'strain',
      columnId: 'strain',
      dataType: ColumnDataType.Categorical,
      uniqueValueCount: 2,
      uniqueValues: ['B6', 'D2'],
      numericValues: 0,
      categoricalValues: 6,
      numericRatio: 0,
    }),
  ]
}

function makeRows() {
  return [
    { value: 10, sample_id: 'S1', arm: 'VEH', visit_week: 0, sex: 'M', strain: 'B6' },
    { value: 11, sample_id: 'S1', arm: 'VEH', visit_week: 1, sex: 'M', strain: 'B6' },
    { value: 12, sample_id: 'S2', arm: 'THC', visit_week: 0, sex: 'F', strain: 'D2' },
    { value: 13, sample_id: 'S2', arm: 'THC', visit_week: 1, sex: 'F', strain: 'D2' },
    { value: 14, sample_id: 'S3', arm: 'VEH', visit_week: 0, sex: 'F', strain: 'B6' },
    { value: 15, sample_id: 'S3', arm: 'VEH', visit_week: 1, sex: 'F', strain: 'B6' },
  ]
}

describe('lmmAnovaModule.buildPayload — plotFacetRoles emission', () => {
  it('emits plot_facet_roles in parameters when config includes plotFacetRoles', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          facetBy: 'strain',
          colorBy: 'sex',
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeDefined()
    expect(plotFacetRoles.color_by).toBe('sex')
    expect(plotFacetRoles.facet_by).toBe('strain')
  })

  it('resolves column names from IDs when emitting plot_facet_roles', () => {
    // Column IDs used in config, but payload should use columnName
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          facetBy: 'strain',  // column ID
          colorBy: 'sex',    // column ID (same as name here, but test confirms resolution)
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles.color_by).toBe('sex')    // columnName
    expect(plotFacetRoles.facet_by).toBe('strain') // columnName
  })

  it('omits plot_facet_roles from payload when config has no plotFacetRoles', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        // no plotFacetRoles
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeUndefined()
  })

  it('emits color_by with empty facet_by when facetBy is stale but colorBy is valid', () => {
    // Scenario: user had facetBy='strain', colorBy='sex' — strain was removed from the dataset.
    // colorBy is still valid; we should preserve it rather than drop the whole config.
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          facetBy: 'nonexistent_column',  // stale facetBy
          colorBy: 'sex',                 // still valid
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    // colorBy preserved; stale facetBy emitted as empty string (not undefined)
    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeDefined()
    expect(plotFacetRoles.color_by).toBe('sex')
    expect(plotFacetRoles.facet_by).toBe('')
  })

  it('omits plot_facet_roles when colorBy resolves to a valid column but is not a strata factor', () => {
    // 'arm' is a valid predictor column in the dataset but is NOT in stratifyBy.
    // A stale config could set colorBy='arm' — resolver must reject it.
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          facetBy: 'strain',
          colorBy: 'arm',  // valid column, but 'arm' is a predictor not a strata factor
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    // colorBy is not in stratifyBy → drop entire config
    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeUndefined()
  })

  it('omits plot_facet_roles when colorBy column ID cannot be resolved', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          facetBy: 'strain',
          colorBy: 'nonexistent_column',  // stale ID
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    // Stale colorBy → entire plotFacetRoles dropped
    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeUndefined()
  })

  it('preserves color_by and clears facet_by when both resolve to the same column', () => {
    // Same-column conflict: facetBy and colorBy both point to 'sex'.
    // colorBy is valid; we should keep it with facet_by='' rather than dropping everything.
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          facetBy: 'sex',  // same as colorBy → conflict
          colorBy: 'sex',
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    // colorBy preserved; same-column conflict clears facet_by
    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeDefined()
    expect(plotFacetRoles.color_by).toBe('sex')
    expect(plotFacetRoles.facet_by).toBe('')
  })
})

// ---------------------------------------------------------------------------
// titleBy — single "Title by" dimension (replaces multi-select titleOnlyFactors)
// ---------------------------------------------------------------------------

describe('lmmAnovaModule.buildPayload — titleBy emission', () => {
  it('emits title_only_factors:[resolvedName] when titleBy is set to a valid strata column', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          colorBy: 'sex',
          titleBy: 'strain',
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeDefined()
    expect(plotFacetRoles.title_only_factors).toEqual(['strain'])
    expect(plotFacetRoles.color_by).toBe('sex')
  })

  it('omits title_only_factors when titleBy column cannot be resolved', () => {
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          colorBy: 'sex',
          titleBy: 'nonexistent_column',  // stale
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    // colorBy is still valid, so plot_facet_roles is emitted, but without title_only_factors
    expect(plotFacetRoles).toBeDefined()
    expect(plotFacetRoles.title_only_factors).toBeUndefined()
  })

  it('omits title_only_factors when titleBy resolves to the same column as colorBy', () => {
    // title and color cannot be the same factor
    const columns = makeColumns()
    const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
      lmm_config: {
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['arm', 'visit_week'],
        predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
        stratified: true,
        stratifyBy: ['sex', 'strain'],
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        plotFacetRoles: {
          colorBy: 'sex',
          titleBy: 'sex',  // conflict: same as colorBy
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
    expect(plotFacetRoles).toBeDefined()
    // titleBy == colorBy → drop title_only_factors silently
    expect(plotFacetRoles.title_only_factors).toBeUndefined()
  })

  it('drops title_only_factors and emits a warning when titleBy resolves to the same column as facetBy', () => {
    // titleBy === facetBy is a contract violation: same column in two roles.
    // Resolver must drop title_only_factors (not emit both facet_by=X and title_only_factors=[X]).
    const columns = makeColumns()
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(String(args[0])); origWarn(...args) }
    try {
      const result = lmmAnovaModule.buildPayload(columns, [], makeRows(), {
        lmm_config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample_id',
          predictorColumnIds: ['arm', 'visit_week'],
          predictorTypes: { arm: 'categorical', visit_week: 'categorical' },
          stratified: true,
          stratifyBy: ['sex', 'strain'],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          adjustmentMethod: 'tukey',
          controlLevels: {},
          plotFacetRoles: {
            facetBy: 'strain',   // facet_by resolves to 'strain'
            colorBy: 'sex',
            titleBy: 'strain',   // titleBy also resolves to 'strain' — conflict
          },
        },
      })

      expect(result.success).toBe(true)
      if (!result.success) throw new Error(result.error)

      const plotFacetRoles = (result.payload as any).parameters.plot_facet_roles
      expect(plotFacetRoles).toBeDefined()
      // facet_by is still valid; title_only_factors must be dropped
      expect(plotFacetRoles.facet_by).toBe('strain')
      expect(plotFacetRoles.title_only_factors).toBeUndefined()
      // A warning must be emitted to surface the conflict
      expect(warns.some(w => w.includes('titleBy'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})
