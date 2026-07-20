/**
 * plotFacetRoles — Facet by / Color by role assignment for compound trajectory plots
 *
 * Tests that canBuildCompoundTrajectory respects plot_facet_roles when provided,
 * and falls back gracefully to index-based assignment when roles are absent or stale.
 *
 * RED: all tests fail until plot_facet_roles support is implemented.
 */

import { describe, it, expect } from 'vitest'
import { canBuildCompoundTrajectory } from '@/services/plotResult/lmm/buildCompoundTrajectory'
import type { LmmTrajectoryRow } from '@/services/plotResult/lmm/normalize'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(strain: string, sex: string): LmmTrajectoryRow {
  return {
    facetValues: { Strain: strain, Sex: sex },
    groupFactor: 'Treatment',
    groupValue: 'VEH',
    groupRole: 'baseline',
    timeFactor: 'Week',
    timeValue: 1,
    timeValueRaw: '1',
    mean: 25,
    se: 0.5,
    ciLower: 24,
    ciUpper: 26,
    n: 10,
    pValue: null,
    interactionSignificant: false,
    source: 'pgmot',
  }
}

/** Standard 2-dim strata rows: Strain × Sex */
const ROWS = [
  makeRow('B6', 'M'),
  makeRow('D2', 'M'),
  makeRow('B6', 'F'),
  makeRow('D2', 'F'),
]

const BASE_RAW = {
  stratify_by: ['Strain', 'Sex'],
  simple_effects: [{ factor: 'Treatment', within: 'Week' }],
}

// ---------------------------------------------------------------------------
// Default (no plot_facet_roles) — must preserve existing behaviour
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — default index-based roles (no plot_facet_roles)', () => {
  it('assigns colorFactor=stratify_by[0] and panelFactors=stratify_by[1..] when no roles provided', () => {
    const result = canBuildCompoundTrajectory(ROWS, BASE_RAW)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.colorFactor).toBe('Strain')
    expect(result.panelFactors).toEqual(['Sex'])
  })
})

// ---------------------------------------------------------------------------
// plot_facet_roles — explicit color_by override
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — plot_facet_roles overrides index-based roles', () => {
  it('uses color_by as colorFactor when it is a valid stratify dim', () => {
    // Default would assign colorFactor='Strain' (index 0), but we want Sex as color
    const rawWithRoles = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', facet_by: 'Strain' },
    }

    const result = canBuildCompoundTrajectory(ROWS, rawWithRoles)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.colorFactor).toBe('Sex')
    expect(result.panelFactors).toContain('Strain')
  })

  it('puts facet_by first in panelFactors when both color_by and facet_by provided', () => {
    const rawWithRoles = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', facet_by: 'Strain' },
    }

    const result = canBuildCompoundTrajectory(ROWS, rawWithRoles)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.panelFactors[0]).toBe('Strain')
  })

  it('falls back to index-based when color_by not in stratify_by (stale config)', () => {
    // 'OldFactor' was removed from strata — stale config
    const rawWithStaleRoles = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'OldFactor', facet_by: 'Strain' },
    }

    const result = canBuildCompoundTrajectory(ROWS, rawWithStaleRoles)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    // Falls back to stratify_by[0]
    expect(result.colorFactor).toBe('Strain')
    expect(result.panelFactors).toEqual(['Sex'])
  })

  it('falls back to index-based when plot_facet_roles is malformed (non-object)', () => {
    // Defensive: if stored config is corrupted (e.g. a string or number instead of object)
    const rawMalformed = { ...BASE_RAW, plot_facet_roles: 'corrupted' }
    const result = canBuildCompoundTrajectory(ROWS, rawMalformed)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.colorFactor).toBe('Strain')
    expect(result.panelFactors).toEqual(['Sex'])
  })

  it('falls back to index-based when color_by and facet_by are the same factor', () => {
    // Degenerate config: same factor assigned to both roles
    const rawWithBadRoles = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', facet_by: 'Sex' },
    }

    const result = canBuildCompoundTrajectory(ROWS, rawWithBadRoles)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    // Falls back to index-based
    expect(result.colorFactor).toBe('Strain')
    expect(result.panelFactors).toEqual(['Sex'])
  })

  it('uses color_by even when facet_by is absent or not in stratify_by', () => {
    // Only color_by provided, no facet_by — still should use color_by for color
    const rawWithPartialRoles = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex' },
    }

    const result = canBuildCompoundTrajectory(ROWS, rawWithPartialRoles)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.colorFactor).toBe('Sex')
    // Strain becomes the panel factor
    expect(result.panelFactors).toContain('Strain')
  })
})

// ---------------------------------------------------------------------------
// titleFactors — resolved from plot_facet_roles.title_only_factors
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — titleFactors from plot_facet_roles', () => {
  it('returns titleFactors:[] when no title_only_factors set', () => {
    const result = canBuildCompoundTrajectory(ROWS, BASE_RAW)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.titleFactors).toEqual([])
  })

  it('populates titleFactors and removes title-only factor from panelFactors', () => {
    // Strain is title-only → should not appear in panelFactors; Sex is colorFactor
    const rawWithTitleOnly = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', title_only_factors: ['Strain'] },
    }
    const result = canBuildCompoundTrajectory(ROWS, rawWithTitleOnly)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.titleFactors).toEqual(['Strain'])
    expect(result.panelFactors).not.toContain('Strain')
    expect(result.colorFactor).toBe('Sex')
  })

  it('panelFactors is empty when all non-color strata are title-only', () => {
    // 2-dim strata: Sex=color, Strain=title-only → panelFactors=[]
    const rawAllTitleOnly = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', title_only_factors: ['Strain'] },
    }
    const result = canBuildCompoundTrajectory(ROWS, rawAllTitleOnly)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.panelFactors).toEqual([])
    expect(result.titleFactors).toEqual(['Strain'])
  })

  it('ignores title_only_factors entries that are not in stratify_by', () => {
    // 'OldFactor' not in strata — silently excluded
    const rawBadTitleOnly = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', title_only_factors: ['Strain', 'OldFactor'] },
    }
    const result = canBuildCompoundTrajectory(ROWS, rawBadTitleOnly)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.titleFactors).toEqual(['Strain'])
    expect(result.titleFactors).not.toContain('OldFactor')
  })

  it('ignores title_only_factors entries that equal colorFactor', () => {
    // Cannot mark the color factor as title-only — silently excluded
    const rawColorAsTitleOnly = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', title_only_factors: ['Sex'] },
    }
    const result = canBuildCompoundTrajectory(ROWS, rawColorAsTitleOnly)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.titleFactors).toEqual([])
    expect(result.panelFactors).toContain('Strain')
  })
})

// ---------------------------------------------------------------------------
// splitByTitleFactors — rows split by title-factor value combos
// ---------------------------------------------------------------------------

import { splitByTitleFactors } from '@/services/plotResult/lmm/buildCompoundTrajectory'

describe('splitByTitleFactors', () => {
  it('returns Map with single empty-key entry when titleFactors is empty', () => {
    const result = splitByTitleFactors(ROWS, [])
    expect(result.size).toBe(1)
    expect(result.has('')).toBe(true)
    expect(result.get('')).toHaveLength(ROWS.length)
  })

  it('splits rows into per-value groups for a single title factor', () => {
    // 4 rows: 2 Strain=B6, 2 Strain=D2
    const result = splitByTitleFactors(ROWS, ['Strain'])
    expect(result.size).toBe(2)
    expect(result.has('Strain=B6')).toBe(true)
    expect(result.has('Strain=D2')).toBe(true)
    expect(result.get('Strain=B6')).toHaveLength(2)
    expect(result.get('Strain=D2')).toHaveLength(2)
  })

  it('creates composite keys for multiple title factors', () => {
    const result = splitByTitleFactors(ROWS, ['Strain', 'Sex'])
    // 4 rows: B6+M, D2+M, B6+F, D2+F → 4 groups
    expect(result.size).toBe(4)
    expect(result.has('Strain=B6, Sex=M')).toBe(true)
    expect(result.has('Strain=D2, Sex=F')).toBe(true)
  })

  it('excludes rows missing a title-factor value', () => {
    // Row without 'Strain' in facetValues should be excluded
    const rowWithoutStrain: LmmTrajectoryRow = {
      ...ROWS[0]!,
      facetValues: { Sex: 'M' }, // no Strain
    }
    const mixedRows = [...ROWS, rowWithoutStrain]
    const result = splitByTitleFactors(mixedRows, ['Strain'])
    // Only the 4 valid rows should be split, rowWithoutStrain excluded
    const totalRows = [...result.values()].reduce((sum, arr) => sum + arr.length, 0)
    expect(totalRows).toBe(ROWS.length)
  })
})

// ---------------------------------------------------------------------------
// 3-dim strata with plot_facet_roles
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — plot_facet_roles with 3-dim strata', () => {
  function makeRow3(strain: string, sex: string, diet: string): LmmTrajectoryRow {
    return {
      ...makeRow(strain, sex),
      facetValues: { Strain: strain, Sex: sex, Diet: diet },
    }
  }

  const ROWS3 = [
    makeRow3('B6', 'M', 'HF'),
    makeRow3('D2', 'M', 'HF'),
    makeRow3('B6', 'F', 'HF'),
    makeRow3('D2', 'F', 'HF'),
    makeRow3('B6', 'M', 'LF'),
    makeRow3('D2', 'M', 'LF'),
    makeRow3('B6', 'F', 'LF'),
    makeRow3('D2', 'F', 'LF'),
  ]

  const RAW3 = {
    stratify_by: ['Strain', 'Sex', 'Diet'],
    simple_effects: [{ factor: 'Treatment', within: 'Week' }],
  }

  it('assigns specified color_by and remaining dims become panelFactors', () => {
    const rawWithRoles = {
      ...RAW3,
      plot_facet_roles: { color_by: 'Diet', facet_by: 'Sex' },
    }

    const result = canBuildCompoundTrajectory(ROWS3, rawWithRoles)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.colorFactor).toBe('Diet')
    // Sex should be first panel (from facet_by), Strain also in panels
    expect(result.panelFactors).toContain('Sex')
    expect(result.panelFactors).toContain('Strain')
    expect(result.panelFactors).not.toContain('Diet')
  })
})

// ---------------------------------------------------------------------------
// Guard/split alignment — undefined facet value must fail Guard 6 (not pass guard then
// be silently dropped by splitByTitleFactors)
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — Guard 6 aligned with splitter (undefined value)', () => {
  it('returns resolved:false when a title factor key exists but its value is undefined', () => {
    // Simulate a row where the key is present but the value is explicitly undefined.
    // Guard 6 using "f in row.facetValues" would PASS (key exists).
    // Guard 6 using "row.facetValues[f] !== undefined" would FAIL (correct).
    // splitByTitleFactors would silently drop the row — creating a discrepancy.
    // After the fix both guards use the same defined-value semantics.
    const rowWithUndefinedStrainValue: LmmTrajectoryRow = {
      ...ROWS[0]!,
      // Force the key to exist but with undefined value — bypasses "in" check
      facetValues: Object.assign({ Sex: 'M' }, { Strain: undefined }) as unknown as Record<string, string>,
    }
    const rowsWithBadValue = [rowWithUndefinedStrainValue, ...ROWS.slice(1)]

    const rawWithTitleOnly = {
      ...BASE_RAW,
      plot_facet_roles: { color_by: 'Sex', title_only_factors: ['Strain'] },
    }

    const result = canBuildCompoundTrajectory(rowsWithBadValue, rawWithTitleOnly)
    // Guard 6 must reject: titleFactor 'Strain' has undefined value in at least one row.
    expect(result.resolved).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/titleFactor/)
  })
})
