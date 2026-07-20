/**
 * resolveTraceRoles — unit tests
 *
 * Verifies that the role-mapping layer correctly derives:
 *   - lineStyleFactor (drives dash/solid) from groupFactor in rows
 *   - colorFactor (drives shared color) from first facetDim
 *   - dashMap with alphabetically-stable baseline=solid / treatment=dot assignment
 *   - sharedColor used for all traces in the plot when resolved
 *   - safe fallback (resolved=false) when roles are ambiguous
 *   - per-plot style overrides (Phase 2) win over semantic/heuristic resolution
 *
 * No hardcoded factor names — works for any group factor / facet structure.
 */
import { describe, it, expect } from 'vitest'
import { resolveTraceRoles } from '../resolveTraceRoles'
import type { LmmTraceRoleOverride } from '../resolveTraceRoles'
import type { LmmTrajectoryRow } from '../normalize'

// ---------------------------------------------------------------------------
// Minimal row fixture
// ---------------------------------------------------------------------------

function makeRow(
  groupValue: string,
  groupFactor = 'Treatment',
  facetValues: Record<string, string> = {},
  groupRole: 'baseline' | 'contrast' | null = null,
): LmmTrajectoryRow {
  return {
    facetValues,
    timeFactor: 'Week',
    timeValue: 1,
    timeValueRaw: '1',
    groupFactor,
    groupValue,
    mean: 10,
    se: 0.5,
    ciLower: 9.5,
    ciUpper: 10.5,
    n: 10,
    pValue: 0.01,
    interactionSignificant: true,
    source: 'pgmot',
    groupRole,
  }
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

describe('resolveTraceRoles — core resolution', () => {
  it('resolves lineStyleFactor from groupFactor when exactly 2 group values', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const result = resolveTraceRoles(rows, ['sex'])
    expect(result.resolved).toBe(true)
    expect(result.lineStyleFactor).toBe('Treatment')
  })

  it('resolves colorFactor from first facetDim', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const result = resolveTraceRoles(rows, ['Strain', 'Sex'])
    expect(result.colorFactor).toBe('Strain')
  })

  it('colorFactor is null when facetDims is empty (pooled result)', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const result = resolveTraceRoles(rows, [])
    expect(result.resolved).toBe(true)
    expect(result.colorFactor).toBeNull()
  })

  it('works for any factor name — not hardcoded to Treatment/Condition', () => {
    const rows = [makeRow('Control', 'Drug'), makeRow('Active', 'Drug')]
    const result = resolveTraceRoles(rows, ['Site'])
    expect(result.resolved).toBe(true)
    expect(result.lineStyleFactor).toBe('Drug')
    expect(result.colorFactor).toBe('Site')
  })
})

// ---------------------------------------------------------------------------
// dashMap — alphabetically stable assignment
// ---------------------------------------------------------------------------

describe('resolveTraceRoles — dashMap', () => {
  it('alphabetically first group level gets solid, second gets dot', () => {
    // 'THC' < 'VEH' alphabetically → THC=solid, VEH=dot
    const rows = [makeRow('VEH'), makeRow('THC')]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['THC']).toBe('solid')
    expect(result.dashMap['VEH']).toBe('dot')
  })

  it('alphabetically first gets solid regardless of row order', () => {
    // Same result regardless of which row comes first
    const rows = [makeRow('THC'), makeRow('VEH')]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['THC']).toBe('solid')
    expect(result.dashMap['VEH']).toBe('dot')
  })

  it('works for other level names — Saline vs Drug', () => {
    // 'Drug' < 'Saline' alphabetically → Drug=solid, Saline=dot
    const rows = [makeRow('Saline', 'Compound'), makeRow('Drug', 'Compound')]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['Drug']).toBe('solid')
    expect(result.dashMap['Saline']).toBe('dot')
  })

  it('dashMap contains exactly the 2 group level keys', () => {
    const rows = [makeRow('A', 'Factor'), makeRow('B', 'Factor')]
    const result = resolveTraceRoles(rows, [])
    expect(Object.keys(result.dashMap).sort()).toEqual(['A', 'B'])
  })
})

// ---------------------------------------------------------------------------
// sharedColor — all traces in plot share one color when resolved
// ---------------------------------------------------------------------------

describe('resolveTraceRoles — sharedColor', () => {
  it('returns a non-empty sharedColor string when resolved', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const result = resolveTraceRoles(rows, ['Strain'])
    expect(result.resolved).toBe(true)
    expect(typeof result.sharedColor).toBe('string')
    expect(result.sharedColor.length).toBeGreaterThan(0)
  })

  it('sharedColor is consistent across calls with the same facet context', () => {
    const rows = [makeRow('VEH', 'Treatment', { Strain: 'D2' }), makeRow('THC', 'Treatment', { Strain: 'D2' })]
    const r1 = resolveTraceRoles(rows, ['Strain'])
    const r2 = resolveTraceRoles(rows, ['Strain'])
    expect(r1.sharedColor).toBe(r2.sharedColor)
  })
})

// ---------------------------------------------------------------------------
// Fallback — resolved=false when roles are ambiguous
// ---------------------------------------------------------------------------

describe('resolveTraceRoles — fallback', () => {
  it('returns resolved=false when rows is empty', () => {
    const result = resolveTraceRoles([], ['Strain'])
    expect(result.resolved).toBe(false)
  })

  it('returns resolved=false when only 1 group value (no comparison possible)', () => {
    const rows = [makeRow('THC'), makeRow('THC')]
    const result = resolveTraceRoles(rows, ['Strain'])
    expect(result.resolved).toBe(false)
  })

  it('returns resolved=false when more than 2 group values (ambiguous comparison)', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C')]
    const result = resolveTraceRoles(rows, [])
    expect(result.resolved).toBe(false)
  })

  it('fallback has empty dashMap and empty sharedColor', () => {
    const result = resolveTraceRoles([], [])
    expect(Object.keys(result.dashMap)).toHaveLength(0)
    expect(result.sharedColor).toBe('')
  })

  it('includes a reason string in fallback', () => {
    const result = resolveTraceRoles([], [])
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Semantic dash — role-based assignment (groupRole metadata present)
//
// When rows carry groupRole='baseline' and groupRole='contrast',
// dash assignment follows semantic convention:
//   baseline → 'dot'   (vehicle/reference)
//   contrast → 'solid' (treatment/active)
//
// When groupRole is null for all rows, fallback to current alphabetical order.
// ---------------------------------------------------------------------------

describe('resolveTraceRoles — semantic dash from groupRole metadata', () => {
  // These tests use group names where alphabetical order INVERTS semantic order.
  // 'Apple' < 'Banana' → alphabetical gives Apple=solid (WRONG for baseline).
  // Semantic must override: Apple=baseline→dot, Banana=contrast→solid.

  it('baseline group gets dot even when alphabetically first (overrides alphabetical solid)', () => {
    // Apple < Banana alphabetically → alphabetical would give Apple=solid.
    // Semantic: Apple=baseline → must be dot.
    const rows = [
      makeRow('Apple', 'Drug', {}, 'baseline'),
      makeRow('Banana', 'Drug', {}, 'contrast'),
    ]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['Apple']).toBe('dot')
  })

  it('contrast group gets solid even when alphabetically second (overrides alphabetical dot)', () => {
    // Apple < Banana → alphabetical gives Banana=dot. Semantic: Banana=contrast → solid.
    const rows = [
      makeRow('Apple', 'Drug', {}, 'baseline'),
      makeRow('Banana', 'Drug', {}, 'contrast'),
    ]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['Banana']).toBe('solid')
  })

  it('semantic assignment is stable regardless of row order in input', () => {
    // Rows in reverse order — role still drives dash, not insertion position
    const rows = [
      makeRow('Banana', 'Drug', {}, 'contrast'),
      makeRow('Apple', 'Drug', {}, 'baseline'),
    ]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['Apple']).toBe('dot')
    expect(result.dashMap['Banana']).toBe('solid')
  })

  it('falls back to alphabetical when groupRole is null for all rows', () => {
    // No metadata → alphabetical: THC < VEH → THC=solid, VEH=dot
    const rows = [makeRow('VEH'), makeRow('THC')]
    const result = resolveTraceRoles(rows, [])
    expect(result.dashMap['THC']).toBe('solid')
    expect(result.dashMap['VEH']).toBe('dot')
  })

  it('falls back to alphabetical when groupRole metadata is incomplete (one row null)', () => {
    // Apple=baseline, Banana=null → incomplete → alphabetical: Apple=solid, Banana=dot
    const rows = [
      makeRow('Apple', 'Drug', {}, 'baseline'),
      makeRow('Banana', 'Drug', {}, null),
    ]
    const result = resolveTraceRoles(rows, [])
    // Alphabetical: Apple < Banana → Apple=solid, Banana=dot
    expect(result.dashMap['Apple']).toBe('solid')
    expect(result.dashMap['Banana']).toBe('dot')
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — per-plot style overrides
//
// Resolution order (highest to lowest priority):
//   1. Valid explicit override  → use override values
//   2. Semantic (groupRole)     → baseline=dot, contrast=solid
//   3. Alphabetical fallback    → sorted[0]=solid, sorted[1]=dot
//
// Override fields:
//   baselineLevel  — which group level is the baseline (→ dot)
//   contrastLevel  — which group level is the contrast  (→ solid)
//   swapStyles     — invert the resolved dashMap (solid↔dot)
//
// Invalid override (level not found in data) → falls back + records reason
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Finding 5: baseline change must preserve existing swapStyles flag
//
// The handler composes { ...currentLmmOverride, baselineLevel, contrastLevel }
// without touching swapStyles. Verify the resolver honours both simultaneously.
// ---------------------------------------------------------------------------

describe('resolveTraceRoles — baseline override preserves existing swapStyles (finding 5)', () => {
  it('baselineLevel override + swapStyles=true both apply: baseline gets dot then inverted to solid', () => {
    // With baselineLevel='Banana': Banana=dot, Apple=solid
    // Then swapStyles inverts: Banana=solid, Apple=dot
    const rows = [makeRow('Apple', 'Drug'), makeRow('Banana', 'Drug')]
    const override: LmmTraceRoleOverride = { baselineLevel: 'Banana', contrastLevel: 'Apple', swapStyles: true }
    const result = resolveTraceRoles(rows, [], 0, override)
    // Override: Banana=baseline→dot, then swapStyles inverts → Banana=solid
    expect(result.dashMap['Banana']).toBe('solid')
    expect(result.dashMap['Apple']).toBe('dot')
  })

  it('changing baselineLevel without touching swapStyles leaves swapStyles as-is in composed override', () => {
    // Simulate user changing baseline while swapStyles is already true.
    // The handler must spread currentOverride to preserve swapStyles.
    const rows = [makeRow('Apple', 'Drug'), makeRow('Banana', 'Drug')]
    const currentOverride: LmmTraceRoleOverride = { swapStyles: true }
    // Handler composes: { ...currentOverride, baselineLevel: 'Banana', contrastLevel: 'Apple' }
    const composedOverride: LmmTraceRoleOverride = {
      ...currentOverride,
      baselineLevel: 'Banana',
      contrastLevel: 'Apple',
    }
    const result = resolveTraceRoles(rows, [], 0, composedOverride)
    // swapStyles=true survives: Banana(baseline=dot) → inverted → solid
    expect(result.dashMap['Banana']).toBe('solid')
    expect(result.dashMap['Apple']).toBe('dot')
  })

  it('composing without swapStyles does NOT inherit a stale swapStyles=true', () => {
    // If current override has NO swapStyles, compose must not invent one
    const rows = [makeRow('Apple', 'Drug'), makeRow('Banana', 'Drug')]
    const currentOverride: LmmTraceRoleOverride = { baselineLevel: 'Apple', contrastLevel: 'Banana' }
    // Changing to Banana as baseline, no swap
    const composedOverride: LmmTraceRoleOverride = {
      ...currentOverride,
      baselineLevel: 'Banana',
      contrastLevel: 'Apple',
    }
    const result = resolveTraceRoles(rows, [], 0, composedOverride)
    // No swap: Banana=baseline→dot (stays dot)
    expect(result.dashMap['Banana']).toBe('dot')
    expect(result.dashMap['Apple']).toBe('solid')
  })
})

describe('resolveTraceRoles — Phase 2 override parameter', () => {
  // -- baselineLevel / contrastLevel override --

  it('override baselineLevel wins over semantic groupRole', () => {
    // Semantic: Apple=baseline(dot), Banana=contrast(solid)
    // Override: baselineLevel='Banana' → Banana=dot, Apple=solid
    const rows = [
      makeRow('Apple', 'Drug', {}, 'baseline'),
      makeRow('Banana', 'Drug', {}, 'contrast'),
    ]
    const override: LmmTraceRoleOverride = { baselineLevel: 'Banana', contrastLevel: 'Apple' }
    const result = resolveTraceRoles(rows, [], 0, override)
    expect(result.dashMap['Banana']).toBe('dot')
    expect(result.dashMap['Apple']).toBe('solid')
  })

  it('override baselineLevel wins over alphabetical fallback', () => {
    // Alphabetical: THC(solid), VEH(dot)
    // Override: baselineLevel='THC' → THC=dot, VEH=solid
    const rows = [makeRow('VEH'), makeRow('THC')]
    const override: LmmTraceRoleOverride = { baselineLevel: 'THC', contrastLevel: 'VEH' }
    const result = resolveTraceRoles(rows, [], 0, override)
    expect(result.dashMap['THC']).toBe('dot')
    expect(result.dashMap['VEH']).toBe('solid')
  })

  it('override with only baselineLevel resolves contrast as the other group', () => {
    // Only baselineLevel provided → other level becomes contrast
    const rows = [makeRow('VEH'), makeRow('THC')]
    const override: LmmTraceRoleOverride = { baselineLevel: 'VEH' }
    const result = resolveTraceRoles(rows, [], 0, override)
    expect(result.dashMap['VEH']).toBe('dot')
    expect(result.dashMap['THC']).toBe('solid')
  })

  // -- swapStyles override --

  it('swapStyles inverts the semantically-resolved dashMap', () => {
    // Semantic: Apple=baseline→dot, Banana=contrast→solid
    // swapStyles → Apple=solid, Banana=dot
    const rows = [
      makeRow('Apple', 'Drug', {}, 'baseline'),
      makeRow('Banana', 'Drug', {}, 'contrast'),
    ]
    const override: LmmTraceRoleOverride = { swapStyles: true }
    const result = resolveTraceRoles(rows, [], 0, override)
    expect(result.dashMap['Apple']).toBe('solid')
    expect(result.dashMap['Banana']).toBe('dot')
  })

  it('swapStyles inverts the alphabetically-resolved dashMap', () => {
    // Alphabetical: THC=solid, VEH=dot
    // swapStyles → THC=dot, VEH=solid
    const rows = [makeRow('VEH'), makeRow('THC')]
    const override: LmmTraceRoleOverride = { swapStyles: true }
    const result = resolveTraceRoles(rows, [], 0, override)
    expect(result.dashMap['THC']).toBe('dot')
    expect(result.dashMap['VEH']).toBe('solid')
  })

  it('swapStyles=false has no effect (same as no override)', () => {
    // THC=solid, VEH=dot — swapStyles=false should not change anything
    const rows = [makeRow('VEH'), makeRow('THC')]
    const withSwap = resolveTraceRoles(rows, [], 0, { swapStyles: false })
    const withoutOverride = resolveTraceRoles(rows, [], 0)
    expect(withSwap.dashMap).toEqual(withoutOverride.dashMap)
  })

  // -- invalid override fallback --

  it('invalid baselineLevel (not in data) falls back and sets reason', () => {
    // 'Ghost' is not a group value in the rows
    const rows = [makeRow('VEH'), makeRow('THC')]
    const override: LmmTraceRoleOverride = { baselineLevel: 'Ghost', contrastLevel: 'VEH' }
    const result = resolveTraceRoles(rows, [], 0, override)
    // Falls back to alphabetical: THC=solid, VEH=dot
    expect(result.dashMap['THC']).toBe('solid')
    expect(result.dashMap['VEH']).toBe('dot')
    // Reason must mention the invalid level
    expect(result.reason).toContain('Ghost')
  })

  it('invalid contrastLevel (not in data) falls back and sets reason', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const override: LmmTraceRoleOverride = { baselineLevel: 'VEH', contrastLevel: 'Ghost' }
    const result = resolveTraceRoles(rows, [], 0, override)
    // Falls back: reason mentions invalid level, still resolved=true via semantic/alphabetical
    expect(result.reason).toContain('Ghost')
    // Should still be resolved via fallback path
    expect(Object.keys(result.dashMap)).toHaveLength(2)
  })

  it('resolved remains true with a valid override', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const override: LmmTraceRoleOverride = { baselineLevel: 'VEH', contrastLevel: 'THC' }
    const result = resolveTraceRoles(rows, [], 0, override)
    expect(result.resolved).toBe(true)
  })

  it('empty override object behaves identically to no override', () => {
    const rows = [makeRow('VEH'), makeRow('THC')]
    const withEmpty = resolveTraceRoles(rows, [], 0, {})
    const withoutOverride = resolveTraceRoles(rows, [], 0)
    expect(withEmpty.dashMap).toEqual(withoutOverride.dashMap)
    expect(withEmpty.colorFactor).toEqual(withoutOverride.colorFactor)
    expect(withEmpty.lineStyleFactor).toEqual(withoutOverride.lineStyleFactor)
    expect(withEmpty.resolved).toEqual(withoutOverride.resolved)
  })
})
