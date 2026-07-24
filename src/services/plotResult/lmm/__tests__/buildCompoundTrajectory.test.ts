/**
 * buildCompoundTrajectory — canBuildCompoundTrajectory guard
 *
 * Tests the activation guard that decides whether a compound (multi-panel)
 * trajectory plot can be built from LMM results.
 */

import { describe, it, expect } from 'vitest'
import { LMM_COLORS } from '@/services/plotResult/lmm/lmmPalette'
import {
  canBuildCompoundTrajectory,
  groupRowsForCompound,
  buildCompoundColorMap,
  buildCompoundDashMap,
  buildCompoundTrajectoryTraces,
  buildCompoundXAxisConfig,
  buildCompoundSignificance,
} from '@/services/plotResult/lmm/buildCompoundTrajectory'
import type { CompoundTraceGroup } from '@/services/plotResult/lmm/buildCompoundTrajectory'
import type { LmmTrajectoryRow } from '@/services/plotResult/lmm/normalize'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(strain: string, sex: string): LmmTrajectoryRow {
  return {
    facetValues: { Strain: strain, Sex: sex },
    groupFactor: 'Treatment', groupValue: 'VEH', groupRole: 'baseline',
    timeFactor: 'Week', timeValue: 1, timeValueRaw: '1',
    mean: 25, se: 0.5, ciLower: 24, ciUpper: 26, n: 10,
    pValue: null, interactionSignificant: false, source: 'pgmot',
  }
}

const VALID_RAW = {
  stratify_by: ['Strain', 'Sex'],
  simple_effects: [{ factor: 'Treatment', within: 'Week' }],
}

const VALID_ROWS = [makeRow('B6', 'M'), makeRow('D2', 'M'), makeRow('B6', 'F'), makeRow('D2', 'F')]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory', () => {
  // ---- Positive case -------------------------------------------------------

  it('resolves with correct roles when all conditions met', () => {
    const result = canBuildCompoundTrajectory(VALID_ROWS, VALID_RAW)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('Treatment')
    expect(result.withinFactor).toBe('Week')
    expect(result.colorFactor).toBe('Strain')
    expect(result.panelFactors).toEqual(['Sex'])
  })

  // ---- stratify_by validation ----------------------------------------------

  it('fails when stratify_by has only 1 dimension', () => {
    const raw = { ...VALID_RAW, stratify_by: ['Strain'] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('at least 2 stratify dims, got 1')
  })

  it('resolves when stratify_by has 3 dimensions and all dims present in rows', () => {
    // Real-world case: Strain × Sex × Trait — compound now supports N >= 2 dims
    const raw = { ...VALID_RAW, stratify_by: ['Strain', 'Sex', 'Diet'] }
    const rows3dim = VALID_ROWS.map(r => ({
      ...r,
      facetValues: { ...r.facetValues, Diet: 'HF' },
    }))
    const result = canBuildCompoundTrajectory(rows3dim, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.colorFactor).toBe('Strain')
    expect(result.panelFactors).toEqual(['Sex', 'Diet'])
  })

  it('fails when stratify_by has 3 dimensions but rows are missing the third dim', () => {
    const raw = { ...VALID_RAW, stratify_by: ['Strain', 'Sex', 'Diet'] }
    // VALID_ROWS only have Strain + Sex — Diet missing → Guard 6 fires
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("panelFactor 'Diet' not found")
  })

  it('fails when stratify_by is missing', () => {
    const raw: Record<string, unknown> = { simple_effects: VALID_RAW.simple_effects }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('stratify_by missing or empty')
  })

  it('fails when stratify_by is an empty array', () => {
    const raw = { ...VALID_RAW, stratify_by: [] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('stratify_by missing or empty')
  })

  it('returns unresolved when stratify_by is null', () => {
    const result = canBuildCompoundTrajectory(VALID_ROWS, { ...VALID_RAW, stratify_by: null })
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('stratify_by missing or empty')
  })

  it('returns unresolved when stratify_by is a string (non-array)', () => {
    const result = canBuildCompoundTrajectory(VALID_ROWS, { ...VALID_RAW, stratify_by: 'Strain' })
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('stratify_by missing or empty')
  })

  // ---- simple_effects validation -------------------------------------------

  it('fails when simple_effects is missing', () => {
    const raw: Record<string, unknown> = { stratify_by: VALID_RAW.stratify_by }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('simple_effects missing or empty')
  })

  it('fails when simple_effects is empty', () => {
    const raw = { ...VALID_RAW, simple_effects: [] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('simple_effects missing or empty')
  })

  it('fails when simple_effects entry is missing the within field', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment' }] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('missing factor or within')
  })

  it('fails when simple_effects entry is missing the factor field', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ within: 'Week' }] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('missing factor or within')
  })

  // ---- trajectory rows validation ------------------------------------------

  it('fails when there are no trajectory rows', () => {
    const result = canBuildCompoundTrajectory([], VALID_RAW)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('no trajectory rows')
  })

  // ---- facetValues key validation ------------------------------------------

  it("fails when rows don't have the colorFactor key in facetValues", () => {
    // rows have only 'Sex', not 'Strain' (colorFactor = stratify_by[0])
    const rows: LmmTrajectoryRow[] = [
      { ...makeRow('B6', 'M'), facetValues: { Sex: 'M' } },
    ]
    const result = canBuildCompoundTrajectory(rows, VALID_RAW)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("colorFactor 'Strain' not found")
  })

  it("fails when rows don't have the panelFactor key in facetValues", () => {
    // rows have only 'Strain', not 'Sex' (panelFactor = stratify_by[1])
    const rows: LmmTrajectoryRow[] = [
      { ...makeRow('B6', 'M'), facetValues: { Strain: 'B6' } },
    ]
    const result = canBuildCompoundTrajectory(rows, VALID_RAW)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("panelFactor 'Sex' not found")
  })

  // ---- colorFactor collision with styleFactor ------------------------------

  it('fails when colorFactor (stratify_by[0]) is the same as styleFactor (simple_effects factor)', () => {
    // stratify_by[0] === 'Treatment' === simple_effects[0].factor
    const raw = {
      stratify_by: ['Treatment', 'Sex'],
      simple_effects: [{ factor: 'Treatment', within: 'Week' }],
    }
    const rows = [makeRow('B6', 'M'), makeRow('D2', 'M')].map(r => ({
      ...r,
      facetValues: { Treatment: 'VEH', Sex: 'M' },
      groupFactor: 'Treatment',
    }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('collides with styleFactor')
  })

  // ---- stratified payload shape (simple_effects inside strata_results) -----

  it('resolves when simple_effects is inside strata_results[0] (stratified payload)', () => {
    const raw = {
      stratify_by: ['Strain', 'Sex'],
      strata_results: [
        { simple_effects: [{ factor: 'Treatment', within: 'Week' }] },
      ],
    }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('Treatment')
  })

  // ---- Bug fixes: empty top-level [] and later strata fallback ---------------

  it('resolves when top-level simple_effects is [] but strata_results[0] has valid config', () => {
    const raw = {
      stratify_by: ['Strain', 'Sex'],
      simple_effects: [],  // empty top-level — must NOT block strata fallback
      strata_results: [
        { simple_effects: [{ factor: 'Treatment', within: 'Week' }] },
      ],
    }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('Treatment')
  })

  it('resolves when first stratum lacks simple_effects but second has it', () => {
    const raw = {
      stratify_by: ['Strain', 'Sex'],
      strata_results: [
        { /* no simple_effects */ },
        { simple_effects: [{ factor: 'Treatment', within: 'Week' }] },
      ],
    }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.withinFactor).toBe('Week')
  })

  // ---- styleFactor / withinFactor axis validation --------------------------

  it('fails when styleFactor does not match row groupFactor', () => {
    const raw = {
      stratify_by: ['Strain', 'Sex'],
      simple_effects: [{ factor: 'WrongFactor', within: 'Week' }],
    }
    const rows = VALID_ROWS  // rows have groupFactor: 'Treatment'
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("styleFactor 'WrongFactor'")
  })

  it('fails when withinFactor does not match row timeFactor', () => {
    const raw = {
      stratify_by: ['Strain', 'Sex'],
      simple_effects: [{ factor: 'Treatment', within: 'WrongTime' }],
    }
    const rows = VALID_ROWS  // rows have timeFactor: 'Week'
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("withinFactor 'WrongTime'")
  })

  // ---- heterogeneous-row tests for every() semantics -----------------------

  it('fails when rows have mixed groupFactor values (some match styleFactor, some do not)', () => {
    // Mix of rows with correct and incorrect groupFactor
    const mixedRows = [
      ...VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' })),
      // one rogue row with wrong groupFactor
      { ...makeRow('B6', 'M'), groupFactor: 'WrongFactor', timeFactor: 'Week', facetValues: { Strain: 'B6', Sex: 'M' } },
    ]
    const result = canBuildCompoundTrajectory(mixedRows, VALID_RAW)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("styleFactor 'Treatment'")
  })

  it('fails when rows have mixed timeFactor values (some match withinFactor, some do not)', () => {
    const mixedRows = [
      ...VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' })),
      // one rogue row with a timeFactor outside the alias group (not day/time/week/visit)
      { ...makeRow('D2', 'F'), groupFactor: 'Treatment', timeFactor: 'Session', facetValues: { Strain: 'D2', Sex: 'F' } },
    ]
    const result = canBuildCompoundTrajectory(mixedRows, VALID_RAW)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("withinFactor 'Week'")
  })

  it('fails when stratify_by contains an empty string', () => {
    const raw = { ...VALID_RAW, stratify_by: ['Strain', ''] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('non-empty strings')
  })

  it('fails when simple_effects entry has empty string factor', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: '', within: 'Week' }] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('missing factor or within')
  })

  it('fails when simple_effects entry has empty string within', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment', within: '' }] }
    const result = canBuildCompoundTrajectory(VALID_ROWS, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain('missing factor or within')
  })

  // ---- Guard 7/8 alias normalization ----------------------------------------

  it('resolves when simple_effects uses "condition" but rows have groupFactor "Treatment" (alias match)', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'condition', within: 'Week' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('condition')
  })

  it('resolves when simple_effects uses "group" but rows have groupFactor "treatment" (alias match, case-insensitive)', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'group', within: 'Week' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('group')
  })

  it('resolves when simple_effects uses "day" but rows have timeFactor "Week" (alias match)', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment', within: 'day' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.withinFactor).toBe('day')
  })

  it('resolves when simple_effects uses "time" but rows have timeFactor "Visit" (alias match)', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment', within: 'time' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Visit' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.withinFactor).toBe('time')
  })

  it('still fails when factor names are genuinely different and not in alias group', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'diet', within: 'Week' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("styleFactor 'diet'")
  })

  // ---- Exact-match aliases only (no token chopping) -------------------------
  // Approved aliases are exact normalized strings. Compound names like 'Day_num'
  // or 'Treatment_Group' are NOT approved — they produce compoundGuardReason.

  it('resolves when simple_effects uses "Timepoint" (approved alias) and rows have timeFactor "Day"', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment', within: 'Timepoint' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Day' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.withinFactor).toBe('Timepoint')
  })

  it('fails when simple_effects uses "Day_num" (not in approved alias list)', () => {
    // 'Day_num' is not an approved alias — exact match only, no token chopping
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment', within: 'Day_num' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("withinFactor 'Day_num'")
  })

  it('fails when simple_effects uses "Treatment_Group" (not in approved alias list)', () => {
    // 'Treatment_Group' is not an approved alias — avoids false positive (group_size → group)
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'Treatment_Group', within: 'Week' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'condition', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("styleFactor 'Treatment_Group'")
  })

  it('fails when simple_effects uses "group_size" — does NOT alias to "group" (over-match guard)', () => {
    // Critical regression: token chopping would match 'group_size' → 'group'.
    // Exact-match only prevents this false positive.
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'group_size', within: 'Week' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("styleFactor 'group_size'")
  })

  it('still fails when factor names are genuinely different and not in alias group', () => {
    const raw = { ...VALID_RAW, simple_effects: [{ factor: 'diet', within: 'Week' }] }
    const rows = VALID_ROWS.map(r => ({ ...r, groupFactor: 'Treatment', timeFactor: 'Week' }))
    const result = canBuildCompoundTrajectory(rows, raw)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toContain("styleFactor 'diet'")
  })
})

// ---------------------------------------------------------------------------
// Task 2: groupRowsForCompound
// ---------------------------------------------------------------------------

describe('groupRowsForCompound', () => {
  // Shared fixture: 2 strains × 2 conditions × 2 sex panels × 2 time points = 16 rows
  function makeTrajectoryRow(
    strain: string,
    sex: string,
    groupValue: 'VEH' | 'THC',
    timeValue: number,
  ): LmmTrajectoryRow {
    return {
      facetValues: { Strain: strain, Sex: sex },
      groupFactor: 'Treatment',
      groupValue,
      groupRole: groupValue === 'VEH' ? 'baseline' : 'contrast',
      timeFactor: 'Week',
      timeValue,
      timeValueRaw: String(timeValue),
      mean: 25,
      se: 0.5,
      ciLower: 24,
      ciUpper: 26,
      n: 10,
      pValue: null,
      interactionSignificant: false,
      source: 'pgmot' as const,
    }
  }

  const COMPOUND_ROWS: LmmTrajectoryRow[] = [
    makeTrajectoryRow('B6', 'M', 'VEH', 1),
    makeTrajectoryRow('B6', 'M', 'VEH', 2),
    makeTrajectoryRow('B6', 'M', 'THC', 1),
    makeTrajectoryRow('B6', 'M', 'THC', 2),
    makeTrajectoryRow('D2', 'M', 'VEH', 1),
    makeTrajectoryRow('D2', 'M', 'VEH', 2),
    makeTrajectoryRow('D2', 'M', 'THC', 1),
    makeTrajectoryRow('D2', 'M', 'THC', 2),
    makeTrajectoryRow('B6', 'F', 'VEH', 1),
    makeTrajectoryRow('B6', 'F', 'VEH', 2),
    makeTrajectoryRow('B6', 'F', 'THC', 1),
    makeTrajectoryRow('B6', 'F', 'THC', 2),
    makeTrajectoryRow('D2', 'F', 'VEH', 1),
    makeTrajectoryRow('D2', 'F', 'VEH', 2),
    makeTrajectoryRow('D2', 'F', 'THC', 1),
    makeTrajectoryRow('D2', 'F', 'THC', 2),
  ]

  const RESOLVED_ROLES = {
    resolved: true as const,
    styleFactor: 'Treatment',
    withinFactor: 'Week',
    colorFactor: 'Strain',
    panelFactors: ['Sex'],
    titleFactors: [] as string[],
  }

  it('returns a Map with one entry per unique panelFactor value', () => {
    const result = groupRowsForCompound(COMPOUND_ROWS, RESOLVED_ROLES)
    expect(result.size).toBe(2)
    expect([...result.keys()].sort()).toEqual(['F', 'M'])
  })

  it('each panel has exactly 4 trace groups (2 strains × 2 treatments)', () => {
    const result = groupRowsForCompound(COMPOUND_ROWS, RESOLVED_ROLES)
    expect(result.get('M')).toHaveLength(4)
    expect(result.get('F')).toHaveLength(4)
  })

  it('trace group keys cover all (colorValue, groupValue) combinations', () => {
    const result = groupRowsForCompound(COMPOUND_ROWS, RESOLVED_ROLES)
    const mGroups = result.get('M')!
    const keys = mGroups.map(g => `${g.key.colorValue}+${g.key.groupValue}`).sort()
    expect(keys).toEqual(['B6+THC', 'B6+VEH', 'D2+THC', 'D2+VEH'])
  })

  it('rows within each trace group are sorted ascending by timeValue', () => {
    const result = groupRowsForCompound(COMPOUND_ROWS, RESOLVED_ROLES)
    for (const [, groups] of result) {
      for (const group of groups) {
        const tvs = group.rows.map(r => r.timeValue)
        expect(tvs).toEqual([...tvs].sort((a, b) => a - b))
      }
    }
  })

  it('each trace group contains only rows matching its colorValue and groupValue', () => {
    const result = groupRowsForCompound(COMPOUND_ROWS, RESOLVED_ROLES)
    for (const [panelValue, groups] of result) {
      for (const group of groups) {
        for (const row of group.rows) {
          expect(row.facetValues[RESOLVED_ROLES.colorFactor]).toBe(group.key.colorValue)
          expect(row.groupValue).toBe(group.key.groupValue)
          // panelValue is the composite key (panelFactors values joined with '|')
          // For single panelFactor=['Sex'], composite = row.facetValues['Sex']
          const expectedComposite = RESOLVED_ROLES.panelFactors.map(f => row.facetValues[f]).join('|')
          expect(expectedComposite).toBe(panelValue)
        }
      }
    }
  })

  it('rows missing colorFactor in facetValues are silently excluded', () => {
    const orphan: LmmTrajectoryRow = {
      ...makeTrajectoryRow('B6', 'M', 'VEH', 1),
      facetValues: { Sex: 'M' },  // no Strain key
    }
    const result = groupRowsForCompound([...COMPOUND_ROWS, orphan], RESOLVED_ROLES)
    const mGroups = result.get('M')!
    // Orphan must not cause a 5th group
    expect(mGroups).toHaveLength(4)
    // Orphan row must not appear in any group
    const allRows = mGroups.flatMap(g => g.rows)
    expect(allRows.some(r => !('Strain' in r.facetValues))).toBe(false)
  })

  it('rows missing panelFactor in facetValues are silently excluded', () => {
    const orphan: LmmTrajectoryRow = {
      ...makeTrajectoryRow('B6', 'M', 'VEH', 1),
      facetValues: { Strain: 'B6' },  // no Sex key
    }
    const result = groupRowsForCompound([...COMPOUND_ROWS, orphan], RESOLVED_ROLES)
    // Orphan should not create a new panel entry
    expect(result.size).toBe(2)
  })

  it('returns empty Map for empty rows input', () => {
    const result = groupRowsForCompound([], RESOLVED_ROLES)
    expect(result.size).toBe(0)
  })

  it('panelValue in key matches the Map key it lives under', () => {
    const result = groupRowsForCompound(COMPOUND_ROWS, RESOLVED_ROLES)
    for (const [panelValue, groups] of result) {
      for (const group of groups) {
        expect(group.key.panelValue).toBe(panelValue)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Task 3: buildCompoundColorMap, buildCompoundDashMap, buildCompoundTrajectoryTraces, buildCompoundXAxisConfig
// ---------------------------------------------------------------------------

describe('buildCompoundColorMap', () => {
  it('assigns a unique hex color to each colorValue', () => {
    const colorMap = buildCompoundColorMap(['B6', 'D2'])
    expect(Object.keys(colorMap).sort()).toEqual(['B6', 'D2'])
    expect(colorMap['B6']).toMatch(/^#/)
    expect(colorMap['D2']).toMatch(/^#/)
    expect(colorMap['B6']).not.toBe(colorMap['D2'])
  })

  it('cycles when more than 10 values provided', () => {
    const strains = Array.from({ length: 12 }, (_, i) => `S${i}`)
    const colorMap = buildCompoundColorMap(strains)
    expect(Object.keys(colorMap)).toHaveLength(12)
    // First and 11th (index 0 and 10) should cycle back to same color
    expect(colorMap['S0']).toBe(colorMap['S10'])
  })

  it('returns empty object for empty input', () => {
    expect(buildCompoundColorMap([])).toEqual({})
  })
})

describe('buildCompoundDashMap', () => {
  // Use the COMPOUND_ROWS fixture from Task 2 tests — rebuild the groups
  function makeTrajectoryRow(strain: string, sex: string, groupValue: 'VEH' | 'THC', timeValue: number): LmmTrajectoryRow {
    return {
      facetValues: { Strain: strain, Sex: sex },
      groupFactor: 'Treatment', groupValue,
      groupRole: groupValue === 'VEH' ? 'baseline' : 'contrast',
      timeFactor: 'Week', timeValue, timeValueRaw: String(timeValue),
      mean: 25, se: 0.5, ciLower: 24, ciUpper: 26, n: 10,
      pValue: null, interactionSignificant: false, source: 'pgmot' as const,
    }
  }

  const RESOLVED_ROLES = {
    resolved: true as const,
    styleFactor: 'Treatment', withinFactor: 'Week',
    colorFactor: 'Strain', panelFactors: ['Sex'],
    titleFactors: [] as string[],
  }

  const COMPOUND_ROWS_T3 = [
    makeTrajectoryRow('B6', 'M', 'VEH', 1), makeTrajectoryRow('B6', 'M', 'VEH', 2),
    makeTrajectoryRow('B6', 'M', 'THC', 1), makeTrajectoryRow('B6', 'M', 'THC', 2),
    makeTrajectoryRow('D2', 'M', 'VEH', 1), makeTrajectoryRow('D2', 'M', 'THC', 1),
  ]

  it('baseline groupRole → dot, contrast groupRole → solid', () => {
    const groups = groupRowsForCompound(COMPOUND_ROWS_T3, RESOLVED_ROLES).get('M')!
    const dashMap = buildCompoundDashMap(groups)
    expect(dashMap['VEH']).toBe('dot')
    expect(dashMap['THC']).toBe('solid')
  })

  it('falls back to alphabetical when groupRole is null', () => {
    const noRoleGroups: CompoundTraceGroup[] = [
      { key: { panelValue: 'M', colorValue: 'B6', groupValue: 'THC' },
        rows: [{ ...makeTrajectoryRow('B6','M','THC',1), groupRole: null }] },
      { key: { panelValue: 'M', colorValue: 'B6', groupValue: 'VEH' },
        rows: [{ ...makeTrajectoryRow('B6','M','VEH',1), groupRole: null }] },
    ]
    const dashMap = buildCompoundDashMap(noRoleGroups)
    // Alphabetical: THC < VEH → THC=solid, VEH=dot
    expect(dashMap['THC']).toBe('solid')
    expect(dashMap['VEH']).toBe('dot')
  })

  it('returns empty object for empty groups', () => {
    expect(buildCompoundDashMap([])).toEqual({})
  })
})

describe('buildCompoundTrajectoryTraces', () => {
  function makeTrajectoryRow(strain: string, sex: string, groupValue: 'VEH' | 'THC', timeValue: number): LmmTrajectoryRow {
    return {
      facetValues: { Strain: strain, Sex: sex },
      groupFactor: 'Treatment', groupValue,
      groupRole: groupValue === 'VEH' ? 'baseline' : 'contrast',
      timeFactor: 'Week', timeValue, timeValueRaw: String(timeValue),
      mean: 25 + timeValue, se: 0.5, ciLower: 24, ciUpper: 26, n: 10,
      pValue: null, interactionSignificant: false, source: 'pgmot' as const,
    }
  }

  const RESOLVED_ROLES = {
    resolved: true as const,
    styleFactor: 'Treatment', withinFactor: 'Week',
    colorFactor: 'Strain', panelFactors: ['Sex'],
    titleFactors: [] as string[],
  }

  const ROWS = [
    makeTrajectoryRow('B6', 'M', 'VEH', 1), makeTrajectoryRow('B6', 'M', 'VEH', 2),
    makeTrajectoryRow('B6', 'M', 'THC', 1), makeTrajectoryRow('B6', 'M', 'THC', 2),
    makeTrajectoryRow('D2', 'M', 'VEH', 1), makeTrajectoryRow('D2', 'M', 'VEH', 2),
    makeTrajectoryRow('D2', 'M', 'THC', 1), makeTrajectoryRow('D2', 'M', 'THC', 2),
  ]

  function makeTraces() {
    const groups = groupRowsForCompound(ROWS, RESOLVED_ROLES).get('M')!
    const colorValues = [...new Set(groups.map(g => g.key.colorValue))].sort()
    const colorMap = buildCompoundColorMap(colorValues)
    const dashMap = buildCompoundDashMap(groups)
    return { traces: buildCompoundTrajectoryTraces(groups, colorMap, dashMap), groups, colorMap, dashMap }
  }

  it('emits exactly 4 traces for 2 strains × 2 treatments', () => {
    expect(makeTraces().traces).toHaveLength(4)
  })

  it('x values are numeric timeValues (not strings)', () => {
    const { traces } = makeTraces()
    for (const t of traces as Array<{ x?: unknown[] }>) {
      expect(t.x?.every(v => typeof v === 'number')).toBe(true)
    }
  })

  it('VEH traces have dash=dot', () => {
    const { traces } = makeTraces()
    const veh = (traces as Array<{ name?: string; line?: { dash?: string } }>).filter(t => t.name?.includes('VEH'))
    expect(veh.length).toBeGreaterThan(0)
    expect(veh.every(t => t.line?.dash === 'dot')).toBe(true)
  })

  it('THC traces have dash=solid', () => {
    const { traces } = makeTraces()
    const thc = (traces as Array<{ name?: string; line?: { dash?: string } }>).filter(t => t.name?.includes('THC'))
    expect(thc.every(t => t.line?.dash === 'solid')).toBe(true)
  })

  it('B6 traces share the same color', () => {
    const { traces } = makeTraces()
    const b6 = (traces as Array<{ name?: string; line?: { color?: string } }>).filter(t => t.name?.includes('B6'))
    const colors = new Set(b6.map(t => t.line?.color))
    expect(colors.size).toBe(1)
  })

  it('B6 and D2 get different colors', () => {
    const { traces } = makeTraces()
    const t = traces as Array<{ name?: string; line?: { color?: string } }>
    const b6Color = t.find(x => x.name?.includes('B6'))?.line?.color
    const d2Color = t.find(x => x.name?.includes('D2'))?.line?.color
    expect(b6Color).not.toBe(d2Color)
  })

  it('trace name includes both colorValue and groupValue', () => {
    const { traces } = makeTraces()
    const names = (traces as Array<{ name?: string }>).map(t => t.name ?? '')
    expect(names.some(n => n.includes('B6') && n.includes('VEH'))).toBe(true)
    expect(names.some(n => n.includes('D2') && n.includes('THC'))).toBe(true)
  })

  it('error bars are present and use se values', () => {
    const { traces } = makeTraces()
    for (const t of traces as Array<{ error_y?: { visible?: boolean; array?: number[] } }>) {
      expect(t.error_y?.visible).toBe(true)
      expect(Array.isArray(t.error_y?.array)).toBe(true)
    }
  })
})

describe('buildCompoundXAxisConfig', () => {
  function makeRow(timeValue: number, timeValueRaw: string): LmmTrajectoryRow {
    return {
      facetValues: { Strain: 'B6', Sex: 'M' },
      groupFactor: 'Treatment', groupValue: 'VEH', groupRole: 'baseline',
      timeFactor: 'Week', timeValue, timeValueRaw,
      mean: 25, se: 0.5, ciLower: 24, ciUpper: 26, n: 10,
      pValue: null, interactionSignificant: false, source: 'pgmot' as const,
    }
  }

  it('returns sorted unique tickvals and matching ticktext', () => {
    const groups: CompoundTraceGroup[] = [
      { key: { panelValue: 'M', colorValue: 'B6', groupValue: 'VEH' },
        rows: [makeRow(1, 'Week 1'), makeRow(2, 'Week 2')] },
      { key: { panelValue: 'M', colorValue: 'D2', groupValue: 'VEH' },
        rows: [makeRow(2, 'Week 2'), makeRow(1, 'Week 1')] },  // different order
    ]
    const config = buildCompoundXAxisConfig(groups)
    expect(config.tickvals).toEqual([1, 2])
    expect(config.ticktext).toEqual(['Week 1', 'Week 2'])
  })

  it('deduplicates timeValues from multiple groups', () => {
    const groups: CompoundTraceGroup[] = [
      { key: { panelValue: 'M', colorValue: 'B6', groupValue: 'VEH' }, rows: [makeRow(1, '1')] },
      { key: { panelValue: 'M', colorValue: 'B6', groupValue: 'THC' }, rows: [makeRow(1, '1')] },
    ]
    const config = buildCompoundXAxisConfig(groups)
    expect(config.tickvals).toEqual([1])
    expect(config.ticktext).toEqual(['1'])
  })

  it('returns empty arrays for empty input', () => {
    const config = buildCompoundXAxisConfig([])
    expect(config.tickvals).toEqual([])
    expect(config.ticktext).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Task 4: buildCompoundSignificance
// ---------------------------------------------------------------------------

// Shared helper for Task 4 tests
function makeTraceGroup(
  panelValue: string,
  colorValue: string,
  groupValue: string,
  rows: Array<{
    timeValue: number
    timeValueRaw: string
    mean: number
    se: number
    pValue: number | null
    timeFactor?: string
    groupFactor?: string
    interactionSignificant?: boolean
  }>,
): CompoundTraceGroup {
  return {
    key: { panelValue, colorValue, groupValue },
    rows: rows.map(r => ({
      facetValues: { sex: panelValue, Strain: colorValue },
      timeFactor: r.timeFactor ?? 'Week',
      timeValue: r.timeValue,
      timeValueRaw: r.timeValueRaw,
      groupFactor: r.groupFactor ?? 'treatment',
      groupValue,
      mean: r.mean,
      se: r.se,
      ciLower: r.mean - r.se,
      ciUpper: r.mean + r.se,
      n: 5,
      pValue: r.pValue,
      interactionSignificant: r.interactionSignificant ?? false,
      source: 'pgmot' as const,
      groupRole: null,
    })),
  }
}

const RESOLVED_ROLES_T4 = {
  resolved: true as const,
  styleFactor: 'treatment',
  withinFactor: 'Week',
  colorFactor: 'Strain',
  panelFactors: ['sex'],
  titleFactors: [] as string[],
}

// Fixture: 1 colorValue (B6), 2 groups (VEH/THC), 2 timepoints with p-values
function makeBasicGroups() {
  return [
    makeTraceGroup('M', 'B6', 'VEH', [
      { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01 },
      { timeValue: 2, timeValueRaw: '2', mean: 12, se: 1, pValue: 0.04 },
    ]),
    makeTraceGroup('M', 'B6', 'THC', [
      { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.01 },
      { timeValue: 2, timeValueRaw: '2', mean: 16, se: 1, pValue: 0.04 },
    ]),
  ]
}

describe('buildCompoundSignificance', () => {
  it('returns null when no rows have pValues', () => {
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: null },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 12, se: 1, pValue: null },
      ]),
    ]
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)
    expect(result).toBeNull()
  })

  it('returns null when colorValues array is empty', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', [], {}, RESOLVED_ROLES_T4, true)
    expect(result).toBeNull()
  })

  it('returns null when no colorValue has exactly 2 groupValues', () => {
    // Only one groupValue per colorValue → cannot form a comparison
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01 },
      ]),
    ]
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)
    expect(result).toBeNull()
  })

  it('builds 2 shapes for 1 colorValue with 2 timepoints', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)
    expect(result).not.toBeNull()
    expect(result!.shapes).toHaveLength(2)
  })

  it('shape names follow sig_bracket_{N} pattern', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    const names = result.shapes.map(s => (s as Record<string, unknown>).name)
    expect(names).toContain('sig_bracket_0')
    expect(names).toContain('sig_bracket_1')
  })

  it('label color matches colorMap[colorValue]', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    for (const shape of result.shapes) {
      const s = shape as Record<string, unknown>
      const label = s.label as Record<string, unknown>
      const font = label.font as Record<string, unknown>
      expect(font.color).toBe(LMM_COLORS[0])
    }
  })

  it('anchor line is transparent', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    for (const shape of result.shapes) {
      const s = shape as Record<string, unknown>
      const line = s.line as Record<string, unknown>
      expect(line.color).toBe('rgba(0,0,0,0)')
    }
  })

  it('bracketCatalog.brackets has one entry per shape', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    expect(result.bracketCatalog.brackets).toHaveLength(result.shapes.length)
  })

  it('bracketEffectMap has masterEffectId with group=comparison', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    const masterKey = 'lmm_cmp|sex=M|B6|THC_vs_VEH'
    expect(result.bracketEffectMap[masterKey]).toBeDefined()
    expect(result.bracketEffectMap[masterKey]!.group).toBe('comparison')
  })

  it('child effectIds have parentId pointing to masterEffectId', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    const masterKey = 'lmm_cmp|sex=M|B6|THC_vs_VEH'
    const childEntries = Object.values(result.bracketEffectMap).filter(e => e.group === 'simple')
    expect(childEntries.length).toBeGreaterThan(0)
    for (const child of childEntries) {
      expect(child.parentId).toBe(masterKey)
    }
  })

  it('bracketVisibility is true for all effectIds', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    for (const [, visible] of Object.entries(result.bracketVisibility)) {
      expect(visible).toBe(true)
    }
  })

  it('two colorValues produce x-offset shapes at same timeValue', () => {
    // B6 and CD1 both at timeValue=1, should produce different x positions
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01 },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.01 },
      ]),
      makeTraceGroup('M', 'CD1', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.02 },
      ]),
      makeTraceGroup('M', 'CD1', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.02 },
      ]),
    ]
    const colorMap = { B6: LMM_COLORS[0]!, CD1: LMM_COLORS[1]! }
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6', 'CD1'], colorMap, RESOLVED_ROLES_T4, true)!
    expect(result.shapes).toHaveLength(2)
    // Extract x from paths: M xL,tipY ...  → xL + HALF_WIDTH = x
    const xPositions = result.shapes.map(s => {
      const path = (s as Record<string, unknown>).path as string
      const match = path.match(/M (-?[\d.]+),/)
      return match ? parseFloat(match[1]!) : NaN
    })
    // The two shapes should have different x positions (different color offsets)
    expect(xPositions[0]).not.toBe(xPositions[1])
  })

  it('bracketSettings.showNs is true', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    expect(result.bracketSettings.showNs).toBe(true)
  })

  it('yMax exceeds globalYTop', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    // globalYTop = max(mean + se) = 16 + 1 = 17
    expect(result.yMax).toBeGreaterThan(17)
  })

  it('bracketShapeParams fields present', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    const params = result.bracketShapeParams
    expect(params.halfWidth).toBeDefined()
    expect(params.tickHeightRatio).toBeDefined()
    expect(params.lineWidth).toBeDefined()
    expect(params.ySpan).toBeDefined()
  })

  it('needsFootnote is true when any row has interactionSignificant=false', () => {
    // One group has interactionSignificant=true, another has false
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01, interactionSignificant: true },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.01, interactionSignificant: false },
      ]),
    ]
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    expect(result.needsFootnote).toBe(true)
  })

  it('bracketEffectShapes[masterEffectId] contains exactly the child shape names', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    const masterKey = 'lmm_cmp|sex=M|B6|THC_vs_VEH'
    const childShapes = result.bracketEffectShapes[masterKey]!
    // Should contain exactly the shape names emitted (sig_bracket_0, sig_bracket_1)
    expect(childShapes).toHaveLength(2)
    expect(childShapes).toContain('sig_bracket_0')
    expect(childShapes).toContain('sig_bracket_1')
  })

  it('partial emit: skips colorValue with only 1 group, emits the other', () => {
    // CD1 has only VEH → skipped. B6 has VEH + THC → emitted.
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01 },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.01 },
      ]),
      makeTraceGroup('M', 'CD1', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 12, se: 1, pValue: 0.03 },
      ]),
      // No THC for CD1 → CD1 has only 1 groupValue → skipped
    ]
    const colorMap = { B6: LMM_COLORS[0]!, CD1: LMM_COLORS[1]! }
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6', 'CD1'], colorMap, RESOLVED_ROLES_T4, true)!
    // Only B6 shapes emitted
    expect(result.shapes).toHaveLength(1)
    expect(result.bracketEffectMap['lmm_cmp|sex=M|B6|THC_vs_VEH']).toBeDefined()
    expect(result.bracketEffectMap['lmm_cmp|sex=M|CD1|']).toBeUndefined()
  })

  it('child effectId has correct format: lmm_se|panelKey|colorValue|g1_vs_g2|timeFactor=timeValueRaw', () => {
    const groups = makeBasicGroups()  // B6, VEH+THC, timepoints 1 and 2, timeFactor='Week'
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    const childKeys = Object.keys(result.bracketEffectMap).filter(k => k.startsWith('lmm_se|'))
    expect(childKeys).toContain('lmm_se|sex=M|B6|THC_vs_VEH|Week=1')
    expect(childKeys).toContain('lmm_se|sex=M|B6|THC_vs_VEH|Week=2')
  })

  it('uses min p-value when multiple non-null p-values exist in same timepoint bucket', () => {
    // Both VEH and THC have different pValues at timeValue=1
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.04 },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.0005 },
      ]),
    ]
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)!
    // Min of [0.04, 0.0005] = 0.0005 → label = '***' (p < 0.001)
    const shape = result.shapes[0] as Record<string, unknown>
    const label = shape.label as Record<string, unknown>
    expect(label.text).toBe('***')
    // And the catalog bracket should also have pValue = 0.0005
    expect(result.bracketCatalog.brackets[0]!.pValue).toBe(0.0005)
  })

  it('suppresses shape when only one group contributes rows at a timepoint after conformance filtering', () => {
    // VEH has timeFactor 'Week' (conforms to withinFactor='Week').
    // THC has timeFactor 'Session' — genuinely outside all alias groups → filtered out.
    // Note: 'Day' is an alias for 'Week' and would pass; 'Session' is not.
    // At timeValue=1: only VEH rows survive conformance → bucket has 1 group → no shape emitted.
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01, timeFactor: 'Week' },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.01, timeFactor: 'Session' },
      ]),
    ]
    // RESOLVED_ROLES_T4 has withinFactor='Week' — THC rows filtered out, bucket only has VEH
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, true)
    expect(result).toBeNull()
  })

  it('returns null when simpleEffectsRequested is false', () => {
    const groups = makeBasicGroups()
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, RESOLVED_ROLES_T4, false)
    expect(result).toBeNull()
  })

  it('emits shapes when withinFactor="Timepoint" and row timeFactor="Week" (alias match in significance filter)', () => {
    // Regression: strict r.timeFactor === roles.withinFactor dropped all rows when names alias-match.
    // factorNamesMatch must be used so Timepoint↔Week passes the conformance filter.
    const aliasRoles = { ...RESOLVED_ROLES_T4, withinFactor: 'Timepoint' }
    const groups = [
      makeTraceGroup('M', 'B6', 'VEH', [
        { timeValue: 1, timeValueRaw: '1', mean: 10, se: 1, pValue: 0.01, timeFactor: 'Week' },
      ]),
      makeTraceGroup('M', 'B6', 'THC', [
        { timeValue: 1, timeValueRaw: '1', mean: 14, se: 1, pValue: 0.01, timeFactor: 'Week' },
      ]),
    ]
    const result = buildCompoundSignificance(groups, 'sex=M', ['B6'], { B6: LMM_COLORS[0]! }, aliasRoles, true)
    // Without the fix this returns null (all rows filtered out by strict === check)
    expect(result).not.toBeNull()
    expect(result!.shapes.length).toBeGreaterThan(0)
  })
})
