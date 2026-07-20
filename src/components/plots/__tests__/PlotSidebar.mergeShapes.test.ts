/**
 * mergeRebuiltLayout — sig_bracket shape-merge regression (C1)
 *
 * Mirrors the sig_bracket branch of the `nextShapes.forEach` loop inside
 * mergeRebuiltLayout (PlotSidebar.tsx). Keep in sync when that function changes.
 *
 * Bug (C1): when a rebuilt layout contains a sig_bracket_* shape that is NOT
 * present in the current layout (e.g. a freshly generated bracket from a new
 * post-hoc comparison), the shape was silently dropped because the early
 * `return` inside `if (currentShape)` meant the shape was never pushed when
 * `currentShape` was undefined.
 *
 * Fix: `mergedShapes.push(currentShape ?? shape)` — fall back to the rebuilt
 * shape when the current layout has no entry for that name.
 */
import { describe, it, expect } from 'vitest'
import { BRACKET_THIN_PARAMS, type ShapeRebuildParams } from '@/utils/plotBuilders/rebuildBracketShapes'

// ---------------------------------------------------------------------------
// Inline mirror of the sig_bracket branch in mergeRebuiltLayout
// (must stay in sync with PlotSidebar.tsx — if this test breaks, check the loop)
// ---------------------------------------------------------------------------

interface ShapeLike {
  name?: string
  path?: string
  [key: string]: unknown
}

/**
 * Reproduce the exact logic that was (before fix) / is (after fix) in PlotSidebar.tsx
 * for sig_bracket shapes so we can unit-test it without mounting the component.
 */
function mergeSigBracketBranch(
  nextShapes: ShapeLike[],
  currentShapeByName: Map<string, ShapeLike>,
): ShapeLike[] {
  const mergedShapes: ShapeLike[] = []

  nextShapes.forEach((shape) => {
    const name = shape.name
    if (typeof name !== 'string') {
      mergedShapes.push(shape)
      return
    }
    if (name.startsWith('sig_bracket_')) {
      const currentShape = currentShapeByName.get(name)
      // C1 fix: fall back to the rebuilt `shape` when current layout has no entry
      mergedShapes.push(currentShape ?? shape)
      return
    }
    // Non-bracket named shape — prefer current (mirrors rest of loop)
    mergedShapes.push(currentShapeByName.get(name) ?? shape)
  })

  return mergedShapes
}

// ---------------------------------------------------------------------------
// I1: thinParams resolution mirror
// Must stay in sync with the Edit Significance toggle in PlotSidebar.tsx
// ---------------------------------------------------------------------------

type StoredParams = { halfWidth: number; tickHeightRatio: number; lineWidth: number; ySpan: number }

/**
 * Mirrors the thinParams resolution logic from the Edit Significance toggle.
 * BUG (pre-I1): manual field copy drops lineColor and any future ShapeRebuildParams fields.
 * FIX (I1): spread merge so BRACKET_THIN_PARAMS fields are always preserved as base.
 */
function resolveThinParams(storedParams: StoredParams | undefined): ShapeRebuildParams {
  // I1 fix: spread merge — BRACKET_THIN_PARAMS is the base so all fields (incl. lineColor)
  // are preserved; storedParams overrides geometry (halfWidth, tickHeightRatio, lineWidth)
  return storedParams != null ? { ...BRACKET_THIN_PARAMS, ...storedParams } : BRACKET_THIN_PARAMS
}

describe('I1: thinParams resolution (mirrors Edit Significance toggle in PlotSidebar)', () => {
  it('preserves lineColor when storedParams has a custom halfWidth', () => {
    const storedParams: StoredParams = { halfWidth: 0.2, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 50 }
    const result = resolveThinParams(storedParams)
    // lineColor must not be dropped — transparent anchors are the UX contract
    expect((result as any).lineColor).toBe('rgba(0,0,0,0)')
  })

  it('uses stored halfWidth (custom bracket width is preserved)', () => {
    const storedParams: StoredParams = { halfWidth: 0.2, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 50 }
    const result = resolveThinParams(storedParams)
    expect(result.halfWidth).toBe(0.2)
  })

  it('falls back to BRACKET_THIN_PARAMS when no stored params', () => {
    const result = resolveThinParams(undefined)
    expect(result).toBe(BRACKET_THIN_PARAMS)
  })
})

// ---------------------------------------------------------------------------

describe('mergeRebuiltLayout – sig_bracket shape-merge (C1 regression)', () => {
  it('C1: retains a new sig_bracket from the rebuilt layout when current layout has no such shape', () => {
    const newBracket: ShapeLike = {
      name: 'sig_bracket_0',
      path: 'M -0.15,1.5 L -0.15,1 L 0.15,1 L 0.15,1.5',
      type: 'path',
    }

    const nextShapes = [newBracket]
    const currentShapeByName = new Map<string, ShapeLike>() // empty — no pre-existing brackets

    const merged = mergeSigBracketBranch(nextShapes, currentShapeByName)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(newBracket) // the rebuilt shape is retained
  })

  it('prefers the current (user-positioned) shape when it already exists in current layout', () => {
    const currentBracket: ShapeLike = {
      name: 'sig_bracket_0',
      path: 'M -0.15,2.0 L -0.15,1.5 L 0.15,1.5 L 0.15,2.0', // user-dragged position
    }
    const rebuiltBracket: ShapeLike = {
      name: 'sig_bracket_0',
      path: 'M -0.15,1.5 L -0.15,1 L 0.15,1 L 0.15,1.5', // original position
    }

    const nextShapes = [rebuiltBracket]
    const currentShapeByName = new Map<string, ShapeLike>([['sig_bracket_0', currentBracket]])

    const merged = mergeSigBracketBranch(nextShapes, currentShapeByName)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(currentBracket) // user-dragged position preserved
  })

  it('handles mix: existing bracket preserved, new bracket retained', () => {
    const existingBracket: ShapeLike = { name: 'sig_bracket_0', path: 'M 0,2 L 0,1 L 0,1 L 0,2' }
    const newBracket: ShapeLike = { name: 'sig_bracket_1', path: 'M 0.85,2 L 0.85,1 L 1.15,1 L 1.15,2' }

    const nextShapes = [
      { name: 'sig_bracket_0', path: 'M 0,1.5 L 0,1 L 0,1 L 0,1.5' }, // rebuilt version of bracket_0
      newBracket,
    ]
    const currentShapeByName = new Map<string, ShapeLike>([['sig_bracket_0', existingBracket]])

    const merged = mergeSigBracketBranch(nextShapes, currentShapeByName)

    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(existingBracket) // existing preserved
    expect(merged[1]).toBe(newBracket)       // new bracket retained (C1 fix)
  })

  it('non-bracket shapes are unaffected by the fix', () => {
    const customShape: ShapeLike = { name: 'custom_markup_abc', path: 'M 0,0 L 1,1' }
    const nextShapes = [{ name: 'custom_markup_abc', path: 'M 0,0 L 1,0' }]
    const currentShapeByName = new Map<string, ShapeLike>([['custom_markup_abc', customShape]])

    const merged = mergeSigBracketBranch(nextShapes, currentShapeByName)

    expect(merged[0]).toBe(customShape)
  })
})
