/**
 * plots-store — lmmStyleOverrides slice
 *
 * Tests for the per-plot LMM style override map:
 *   - Initial state is empty
 *   - setLmmStyleOverride adds / updates an entry
 *   - clearLmmStyleOverride removes an entry
 *   - getLmmStyleOverride returns the stored override or undefined
 *   - Overrides are isolated per key (different keys don't interfere)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { usePlotsStore } from '@/store/plots-store'
import type { LmmTraceRoleOverride } from '@/services/plotResult/lmm/resolveTraceRoles'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(resultId: string, facetKey: string | null, lmmMode: string): string {
  return `${resultId}|${facetKey ?? 'pooled'}|${lmmMode}`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plots-store — lmmStyleOverrides', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    usePlotsStore.setState({ lmmStyleOverrides: {} })
  })

  it('initial lmmStyleOverrides is an empty object', () => {
    expect(usePlotsStore.getState().lmmStyleOverrides).toEqual({})
  })

  it('setLmmStyleOverride stores an override keyed by resultId|facetKey|lmmMode', () => {
    const override: LmmTraceRoleOverride = { swapStyles: true }
    const k = key('result-1', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, override)
    expect(usePlotsStore.getState().lmmStyleOverrides[k]).toEqual(override)
  })

  it('setLmmStyleOverride updates an existing override at the same key', () => {
    const k = key('result-1', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, { swapStyles: true })
    usePlotsStore.getState().setLmmStyleOverride(k, { baselineLevel: 'VEH', contrastLevel: 'THC' })
    expect(usePlotsStore.getState().lmmStyleOverrides[k]).toEqual({ baselineLevel: 'VEH', contrastLevel: 'THC' })
  })

  it('clearLmmStyleOverride removes the entry for the given key', () => {
    const k = key('result-1', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, { swapStyles: true })
    usePlotsStore.getState().clearLmmStyleOverride(k)
    expect(usePlotsStore.getState().lmmStyleOverrides[k]).toBeUndefined()
  })

  it('clearLmmStyleOverride is a no-op for a key that does not exist', () => {
    const k = key('nonexistent', null, 'trajectory')
    // Must not throw
    expect(() => usePlotsStore.getState().clearLmmStyleOverride(k)).not.toThrow()
    expect(usePlotsStore.getState().lmmStyleOverrides[k]).toBeUndefined()
  })

  it('getLmmStyleOverride returns the stored override', () => {
    const override: LmmTraceRoleOverride = { baselineLevel: 'Control' }
    const k = key('result-2', 'sex=M', 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, override)
    expect(usePlotsStore.getState().getLmmStyleOverride(k)).toEqual(override)
  })

  it('getLmmStyleOverride returns undefined for unknown key', () => {
    expect(usePlotsStore.getState().getLmmStyleOverride('nobody|pooled|trajectory')).toBeUndefined()
  })

  it('different keys do not interfere with each other', () => {
    const k1 = key('result-1', null, 'trajectory')
    const k2 = key('result-2', 'sex=F', 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k1, { swapStyles: true })
    usePlotsStore.getState().setLmmStyleOverride(k2, { baselineLevel: 'VEH' })
    expect(usePlotsStore.getState().lmmStyleOverrides[k1]).toEqual({ swapStyles: true })
    expect(usePlotsStore.getState().lmmStyleOverrides[k2]).toEqual({ baselineLevel: 'VEH' })
  })

  it('clearing one key leaves the other intact', () => {
    const k1 = key('result-1', null, 'trajectory')
    const k2 = key('result-2', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k1, { swapStyles: true })
    usePlotsStore.getState().setLmmStyleOverride(k2, { baselineLevel: 'VEH', contrastLevel: 'THC' })
    usePlotsStore.getState().clearLmmStyleOverride(k1)
    expect(usePlotsStore.getState().lmmStyleOverrides[k1]).toBeUndefined()
    expect(usePlotsStore.getState().lmmStyleOverrides[k2]).toEqual({ baselineLevel: 'VEH', contrastLevel: 'THC' })
  })
})

// ---------------------------------------------------------------------------
// Finding 4 (implemented): normalize override persistence
//
// setLmmStyleOverride prunes swapStyles:false (absent is canonical) and clears
// the entry entirely when nothing meaningful remains. UI handlers now call
// setLmmStyleOverride unconditionally — the store canonicalizes the result.
// ---------------------------------------------------------------------------

describe('plots-store — lmmStyleOverrides pruning (finding 4)', () => {
  beforeEach(() => {
    usePlotsStore.setState({ lmmStyleOverrides: {} })
  })

  it('clearLmmStyleOverride removes the entry (direct clear path)', () => {
    const k = key('r1', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, { swapStyles: true })
    usePlotsStore.getState().clearLmmStyleOverride(k)
    expect(usePlotsStore.getState().lmmStyleOverrides[k]).toBeUndefined()
  })

  it('setLmmStyleOverride with only swapStyles=false clears the entry (swapStyles:false is pruned, nothing remains)', () => {
    // The store prunes swapStyles:false as "absent is canonical" for the no-swap state.
    // Calling setLmmStyleOverride({ swapStyles: false }) must behave identically to
    // clearLmmStyleOverride — no stale entry should be left.
    const k = key('r1', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, { swapStyles: false })
    expect(usePlotsStore.getState().lmmStyleOverrides[k]).toBeUndefined()
  })

  it('setLmmStyleOverride with baselineLevel + swapStyles=false keeps baselineLevel but has no swapStyles', () => {
    // When other meaningful fields exist, pruning only removes the false swapStyles field
    const k = key('r1', null, 'trajectory')
    usePlotsStore.getState().setLmmStyleOverride(k, {
      baselineLevel: 'VEH',
      contrastLevel: 'THC',
      swapStyles: false,
    })
    // After fix the handler should strip swapStyles=false before storing
    const entry = usePlotsStore.getState().lmmStyleOverrides[k]
    expect(entry?.swapStyles).toBeUndefined()
    expect(entry?.baselineLevel).toBe('VEH')
  })
})
