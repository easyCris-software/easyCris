/**
 * trajectoryRoles — explicit trajectory role contract
 *
 * Tests for the trajectory_roles priority path in canBuildCompoundTrajectory
 * and reference-level override in buildCompoundDashMap.
 *
 * RED: all tests fail until implementation is in place.
 */

import { describe, it, expect } from 'vitest'
import {
  canBuildCompoundTrajectory,
  buildCompoundDashMap,
} from '@/services/plotResult/lmm/buildCompoundTrajectory'
import type { CompoundTraceGroup } from '@/services/plotResult/lmm/buildCompoundTrajectory'
import type { LmmTrajectoryRow } from '@/services/plotResult/lmm/normalize'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrajectoryRow(
  groupFactor: string,
  groupValue: string,
  timeFactor: string,
  timeValue: number,
  facetValues: Record<string, string>,
  groupRole: 'baseline' | 'contrast' | null = null,
): LmmTrajectoryRow {
  return {
    facetValues,
    groupFactor,
    groupValue,
    groupRole,
    timeFactor,
    timeValue,
    timeValueRaw: String(timeValue),
    mean: 10,
    se: 1,
    ciLower: 9,
    ciUpper: 11,
    n: 5,
    pValue: null,
    interactionSignificant: false,
    source: 'pgmot',
  }
}

/** Rows where arm is group dimension and visit_week is time dimension */
function makeArmWeekRows(): LmmTrajectoryRow[] {
  const facets = [
    { sex: 'M', strain: 'B6' },
    { sex: 'F', strain: 'B6' },
    { sex: 'M', strain: 'D2' },
    { sex: 'F', strain: 'D2' },
  ]
  const result: LmmTrajectoryRow[] = []
  for (const f of facets) {
    for (const arm of ['VEH', 'THC']) {
      for (const week of [0, 1, 2]) {
        result.push(
          makeTrajectoryRow(
            'arm',
            arm,
            'visit_week',
            week,
            { sex: f.sex, strain: f.strain },
          ),
        )
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// canBuildCompoundTrajectory — trajectory_roles priority
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — trajectory_roles priority', () => {
  const rows = makeArmWeekRows()

  it('resolves using trajectory_roles when simple_effects is absent', () => {
    // simple_effects not present → previously would fail with "simple_effects missing"
    // With trajectory_roles: should resolve correctly
    const rawResult = {
      stratify_by: ['sex', 'strain'],
      trajectory_roles: {
        treatment_factor: 'arm',
        time_factor: 'visit_week',
      },
    }

    const result = canBuildCompoundTrajectory(rows, rawResult)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('arm')
    expect(result.withinFactor).toBe('visit_week')
  })

  it('resolves using trajectory_roles even when simple_effects has roles reversed', () => {
    // simple_effects says visit_week is the group factor and arm is the time axis — WRONG
    // trajectory_roles should override and use arm=treatment, visit_week=time
    const rawResult = {
      stratify_by: ['sex', 'strain'],
      simple_effects: [{ factor: 'visit_week', within: 'arm' }],
      trajectory_roles: {
        treatment_factor: 'arm',
        time_factor: 'visit_week',
      },
    }

    const result = canBuildCompoundTrajectory(rows, rawResult)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.styleFactor).toBe('arm')
    expect(result.withinFactor).toBe('visit_week')
  })

  it('produces identical roles regardless of simple_effects ordering when trajectory_roles present', () => {
    const base = {
      stratify_by: ['sex', 'strain'],
      trajectory_roles: { treatment_factor: 'arm', time_factor: 'visit_week' },
    }
    const withNormalOrder = { ...base, simple_effects: [{ factor: 'arm', within: 'visit_week' }] }
    const withReversedOrder = { ...base, simple_effects: [{ factor: 'visit_week', within: 'arm' }] }
    const withNoSimpleEffects = { ...base }

    const r1 = canBuildCompoundTrajectory(rows, withNormalOrder)
    const r2 = canBuildCompoundTrajectory(rows, withReversedOrder)
    const r3 = canBuildCompoundTrajectory(rows, withNoSimpleEffects)

    expect(r1.resolved).toBe(true)
    expect(r2.resolved).toBe(true)
    expect(r3.resolved).toBe(true)

    if (!r1.resolved || !r2.resolved || !r3.resolved) throw new Error('All must resolve')
    expect(r1.styleFactor).toBe(r2.styleFactor)
    expect(r1.withinFactor).toBe(r2.withinFactor)
    expect(r1.styleFactor).toBe(r3.styleFactor)
    expect(r1.withinFactor).toBe(r3.withinFactor)
  })

  it('exposes referenceLevel in resolved output when trajectory_roles includes reference_level', () => {
    const rawResult = {
      stratify_by: ['sex', 'strain'],
      trajectory_roles: {
        treatment_factor: 'arm',
        time_factor: 'visit_week',
        reference_level: 'VEH',
      },
    }

    const result = canBuildCompoundTrajectory(rows, rawResult)
    expect(result.resolved).toBe(true)
    if (!result.resolved) throw new Error('Expected resolved')
    expect(result.referenceLevel).toBe('VEH')
  })
})

// ---------------------------------------------------------------------------
// canBuildCompoundTrajectory — hard guards for trajectory_roles
// ---------------------------------------------------------------------------

describe('canBuildCompoundTrajectory — trajectory_roles hard guards', () => {
  const rows = makeArmWeekRows()

  it('fails when treatment_factor and time_factor are the same', () => {
    const rawResult = {
      stratify_by: ['sex', 'strain'],
      trajectory_roles: {
        treatment_factor: 'arm',
        time_factor: 'arm',  // same as treatment — invalid
      },
    }

    const result = canBuildCompoundTrajectory(rows, rawResult)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toMatch(/treatment.*time|time.*treatment|same|collide/i)
  })

  it('fails when treatment_factor overlaps with a stratification factor', () => {
    // sex is in stratifyBy AND being used as treatment_factor — invalid
    const rowsWithSexGroupFactor = rows.map(r => ({ ...r, groupFactor: 'sex', groupValue: r.facetValues.sex ?? 'M' }))
    const rawResult = {
      stratify_by: ['sex', 'strain'],
      trajectory_roles: {
        treatment_factor: 'sex',  // sex is in stratifyBy — forbidden
        time_factor: 'visit_week',
      },
    }

    const result = canBuildCompoundTrajectory(rowsWithSexGroupFactor, rawResult)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toMatch(/stratif|overlap/i)
  })

  it('fails when time_factor overlaps with a stratification factor', () => {
    const rowsWithSexTimeFactor = rows.map(r => ({
      ...r,
      timeFactor: 'sex',
      timeValue: 0,
      timeValueRaw: r.facetValues.sex ?? 'M',
    }))
    const rawResult = {
      stratify_by: ['sex', 'strain'],
      trajectory_roles: {
        treatment_factor: 'arm',
        time_factor: 'sex',  // sex is in stratifyBy — forbidden
      },
    }

    const result = canBuildCompoundTrajectory(rowsWithSexTimeFactor, rawResult)
    expect(result.resolved).toBe(false)
    if (result.resolved) throw new Error('Expected unresolved')
    expect(result.reason).toMatch(/stratif|overlap/i)
  })
})

// ---------------------------------------------------------------------------
// buildCompoundDashMap — explicit referenceLevel from trajectory_roles
// ---------------------------------------------------------------------------

describe('buildCompoundDashMap — explicit referenceLevel priority', () => {
  function makeGroup(groupValue: string, groupRole: 'baseline' | 'contrast' | null): CompoundTraceGroup {
    return {
      key: { panelValue: 'B6', colorValue: 'M', groupValue },
      rows: [
        makeTrajectoryRow('arm', groupValue, 'visit_week', 0, { strain: 'B6', sex: 'M' }, groupRole),
      ],
    }
  }

  it('explicit referenceLevel=VEH produces VEH=dot even when groupRole says contrast', () => {
    // rows say VEH is contrast (would normally be solid), but referenceLevel override says VEH is baseline (dot)
    const groups = [
      makeGroup('VEH', 'contrast'),  // groupRole says contrast → normally solid
      makeGroup('THC', 'baseline'),  // groupRole says baseline → normally dot
    ]

    // Pass referenceLevel='VEH' to buildCompoundDashMap
    const dashMap = buildCompoundDashMap(groups, { referenceLevel: 'VEH' })

    expect(dashMap['VEH']).toBe('dot')   // explicit reference → dot
    expect(dashMap['THC']).toBe('solid') // contrast → solid
  })

  it('explicit referenceLevel=THC inverts default groupRole assignment', () => {
    // rows say VEH=baseline (dot), THC=contrast (solid)
    // but explicit referenceLevel=THC says THC is the baseline (dot)
    const groups = [
      makeGroup('VEH', 'baseline'),  // groupRole baseline → normally dot
      makeGroup('THC', 'contrast'),  // groupRole contrast → normally solid
    ]

    const dashMap = buildCompoundDashMap(groups, { referenceLevel: 'THC' })

    expect(dashMap['THC']).toBe('dot')   // explicit reference → dot
    expect(dashMap['VEH']).toBe('solid') // the other one → solid
  })

  it('falls through to groupRole when referenceLevel is absent', () => {
    // No referenceLevel override — existing groupRole path must still work
    const groups = [
      makeGroup('VEH', 'baseline'),
      makeGroup('THC', 'contrast'),
    ]

    const dashMap = buildCompoundDashMap(groups)

    expect(dashMap['VEH']).toBe('dot')
    expect(dashMap['THC']).toBe('solid')
  })

  it('sparse panel: referenceLevel set but absent from panel — other groups all become solid', () => {
    // Panel only has DrugA rows — the reference level VEH is absent (sparse data)
    // Result: DrugA → solid (not dot), and dashMap['VEH'] is absent/undefined
    const groups = [
      makeGroup('DrugA', null),
    ]

    const dashMap = buildCompoundDashMap(groups, { referenceLevel: 'VEH' })

    // The reference level is not present — only DrugA is in this panel
    expect(dashMap['DrugA']).toBe('solid')
    expect(dashMap['VEH']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildCompoundSignificance — trajectory_roles as sole role source (no simple_effects)
// ---------------------------------------------------------------------------

import { buildCompoundSignificance } from '@/services/plotResult/lmm/buildCompoundTrajectory'

describe('buildCompoundSignificance — trajectory_roles as sole source', () => {
  function makePValueRow(
    groupValue: string,
    timeValue: number,
    pValue: number,
  ): LmmTrajectoryRow {
    return {
      ...makeTrajectoryRow('arm', groupValue, 'visit_week', timeValue, { strain: 'B6', sex: 'M' }),
      pValue,
      interactionSignificant: true,
    }
  }

  it('emits significance brackets when trajectory_roles is the only role source (no simple_effects)', () => {
    // Exactly 2 group values + pValues populated → brackets must be emitted
    // The roles come exclusively from trajectory_roles (no simple_effects in rawResult)
    const rows = [
      makePValueRow('VEH', 0, 0.001),
      makePValueRow('THC', 0, 0.001),
      makePValueRow('VEH', 1, 0.03),
      makePValueRow('THC', 1, 0.03),
    ]

    const traceGroups: CompoundTraceGroup[] = [
      { key: { panelValue: 'B6', colorValue: 'M', groupValue: 'VEH' }, rows: rows.filter(r => r.groupValue === 'VEH') },
      { key: { panelValue: 'B6', colorValue: 'M', groupValue: 'THC' }, rows: rows.filter(r => r.groupValue === 'THC') },
    ]

    // Roles resolved via trajectory_roles (Priority 0 path — no simple_effects)
    const roles: Extract<typeof import('@/services/plotResult/lmm/buildCompoundTrajectory').canBuildCompoundTrajectory extends (...args: never[]) => infer R ? R : never, { resolved: true }> = {
      resolved: true,
      styleFactor: 'arm',
      withinFactor: 'visit_week',
      colorFactor: 'strain',
      panelFactors: ['sex'],
      titleFactors: [] as string[],
    }

    const colorMap = { M: '#0072B2' }

    const result = buildCompoundSignificance(
      traceGroups,
      'strain=B6',
      ['M'],
      colorMap,
      roles,
      true, // simpleEffectsRequested = true (enabled by trajectory_roles Priority 0 path)
    )

    expect(result).not.toBeNull()
    expect(result!.shapes.length).toBeGreaterThan(0)
  })
})
