/**
 * Unit tests for cascadeBracketToggle and getMasterToggleState.
 *
 * Tests the pure functions that handle master comparison toggle logic:
 * - Cascade OFF hides all children
 * - Cascade ON shows all children
 * - getMasterToggleState returns true/false/indeterminate based on children
 * - Cascade doesn't affect sibling comparisons
 */

import { describe, it, expect } from 'vitest'
import { cascadeMasterToggle, getMasterToggleState } from '../cascadeBracketToggle'
import type { BracketEffectMeta } from '../types'

function makeEffectMap(entries: Array<[string, Partial<BracketEffectMeta>]>): Record<string, BracketEffectMeta> {
  return Object.fromEntries(
    entries.map(([id, partial]) => [
      id,
      { label: id, group: 'simple', ...partial } as BracketEffectMeta,
    ])
  )
}

const MASTER_A = 'lmm_cmp|pooled|THC_vs_VEH'
const CHILD_A1 = 'lmm_se|pooled|THC_vs_VEH|Week=1'
const CHILD_A2 = 'lmm_se|pooled|THC_vs_VEH|Week=2'
const MASTER_B = 'lmm_cmp|pooled|THC_vs_PLB'
const CHILD_B1 = 'lmm_se|pooled|THC_vs_PLB|Week=1'

const effectMap = makeEffectMap([
  [MASTER_A, { group: 'comparison' }],
  [CHILD_A1, { group: 'simple', parentId: MASTER_A }],
  [CHILD_A2, { group: 'simple', parentId: MASTER_A }],
  [MASTER_B, { group: 'comparison' }],
  [CHILD_B1, { group: 'simple', parentId: MASTER_B }],
])

describe('cascadeMasterToggle', () => {
  it('cascade OFF sets master + all children to false', () => {
    const result = cascadeMasterToggle(MASTER_A, false, effectMap, {})
    expect(result[MASTER_A]).toBe(false)
    expect(result[CHILD_A1]).toBe(false)
    expect(result[CHILD_A2]).toBe(false)
  })

  it('cascade ON sets master + all children to true', () => {
    const result = cascadeMasterToggle(MASTER_A, true, effectMap, {
      [MASTER_A]: false,
      [CHILD_A1]: false,
      [CHILD_A2]: false,
    })
    expect(result[MASTER_A]).toBe(true)
    expect(result[CHILD_A1]).toBe(true)
    expect(result[CHILD_A2]).toBe(true)
  })

  it('cascade does not affect sibling comparison children', () => {
    const result = cascadeMasterToggle(MASTER_A, false, effectMap, {
      [CHILD_B1]: true,
    })
    // MASTER_B's child must be untouched
    expect(result[CHILD_B1]).toBe(true)
    expect(result[MASTER_B]).toBeUndefined()
  })

  it('cascade preserves existing visibility of unrelated effects', () => {
    const before = { [CHILD_B1]: true, [MASTER_B]: true }
    const result = cascadeMasterToggle(MASTER_A, false, effectMap, before)
    expect(result[CHILD_B1]).toBe(true)
    expect(result[MASTER_B]).toBe(true)
  })
})

describe('getMasterToggleState', () => {
  it('returns true when all children are visible', () => {
    const vis = { [CHILD_A1]: true, [CHILD_A2]: true }
    expect(getMasterToggleState(MASTER_A, effectMap, vis)).toBe(true)
  })

  it('returns false when all children are hidden', () => {
    const vis = { [CHILD_A1]: false, [CHILD_A2]: false }
    expect(getMasterToggleState(MASTER_A, effectMap, vis)).toBe(false)
  })

  it('returns indeterminate when children are mixed', () => {
    const vis = { [CHILD_A1]: true, [CHILD_A2]: false }
    expect(getMasterToggleState(MASTER_A, effectMap, vis)).toBe('indeterminate')
  })

  it('treats missing visibility as true (default visible)', () => {
    // CHILD_A1 not in map → visible; CHILD_A2 hidden
    const vis = { [CHILD_A2]: false }
    expect(getMasterToggleState(MASTER_A, effectMap, vis)).toBe('indeterminate')
  })

  it('returns true when no children exist (edge case: empty comparison)', () => {
    const emptyChildMap = makeEffectMap([[MASTER_A, { group: 'comparison' }]])
    expect(getMasterToggleState(MASTER_A, emptyChildMap, {})).toBe(true)
  })
})
