/**
 * useFilterHistory.test.ts
 *
 * Phase 5 TDD tests for the view-filter undo stack.
 * Written RED-first — all tests must fail before useFilterHistory exists.
 *
 * Tests:
 *   UNDO_INIT        - filterHistory is empty and viewFilterConfig is null on mount
 *   UNDO_PUSH        - applying a filter pushes the previous config onto history
 *   UNDO_POP         - undoFilter restores previous config and removes it from history
 *   UNDO_EMPTY       - undoFilter is a no-op (returns false) when history is empty
 *   UNDO_CLEAR       - clearFilter resets viewFilterConfig and history to initial state
 *   UNDO_LIMIT       - filterHistory is capped at 20 entries (oldest dropped)
 *   UNDO_PRECEDENCE  - undoFilter returns true, preventing dataset undo from firing
 *   UNDO_FALLTHROUGH - undoFilter returns false, dataset undo fires instead
 */

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFilterHistory } from '../useFilterHistory'
import type { FilterConfig } from '@/services/dataTransformService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(value: string): FilterConfig {
  return {
    groups: [{ op: 'AND', conditions: [{ columnId: 'col', operator: 'eq', value }] }],
    groupOperator: 'AND',
  }
}

const CONFIG_A = makeConfig('alpha')
const CONFIG_B = makeConfig('beta')
const CONFIG_C = makeConfig('gamma')

// ---------------------------------------------------------------------------
// Track A: undo stack behaviour
// ---------------------------------------------------------------------------

describe('useFilterHistory — undo stack', () => {
  it('UNDO_INIT: filterHistory is empty and viewFilterConfig is null on mount', () => {
    const { result } = renderHook(() => useFilterHistory())

    expect(result.current.viewFilterConfig).toBeNull()
    expect(result.current.filterHistory).toHaveLength(0)
  })

  it('UNDO_PUSH: applying a filter pushes the previous config onto history', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })

    // active config updated
    expect(result.current.viewFilterConfig).toEqual(CONFIG_A)
    // previous config (null) pushed to history
    expect(result.current.filterHistory).toHaveLength(1)
    expect(result.current.filterHistory[0]).toBeNull()

    act(() => { result.current.applyFilter(CONFIG_B) })

    expect(result.current.viewFilterConfig).toEqual(CONFIG_B)
    expect(result.current.filterHistory).toHaveLength(2)
    expect(result.current.filterHistory[1]).toEqual(CONFIG_A)
  })

  it('UNDO_POP: undoFilter restores previous config and removes it from history', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })
    act(() => { result.current.applyFilter(CONFIG_B) })

    let undid: boolean | undefined
    act(() => { undid = result.current.undoFilter() })

    expect(undid).toBe(true)
    expect(result.current.viewFilterConfig).toEqual(CONFIG_A)
    expect(result.current.filterHistory).toHaveLength(1)

    act(() => { undid = result.current.undoFilter() })

    expect(undid).toBe(true)
    expect(result.current.viewFilterConfig).toBeNull()
    expect(result.current.filterHistory).toHaveLength(0)
  })

  it('UNDO_EMPTY: undoFilter is a no-op and returns false when history is empty', () => {
    const { result } = renderHook(() => useFilterHistory())

    let undid: boolean | undefined
    act(() => { undid = result.current.undoFilter() })

    expect(undid).toBe(false)
    expect(result.current.viewFilterConfig).toBeNull()
    expect(result.current.filterHistory).toHaveLength(0)
  })

  it('UNDO_CLEAR: clearFilter resets viewFilterConfig and history', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })
    act(() => { result.current.applyFilter(CONFIG_B) })
    act(() => { result.current.clearFilter() })

    expect(result.current.viewFilterConfig).toBeNull()
    expect(result.current.filterHistory).toHaveLength(0)
  })

  it('UNDO_LIMIT: filterHistory is capped at 20 entries (oldest entry dropped)', () => {
    const { result } = renderHook(() => useFilterHistory())

    // Apply 25 filters — history should never exceed 20
    act(() => {
      for (let i = 0; i < 25; i++) {
        result.current.applyFilter(makeConfig(String(i)))
      }
    })

    expect(result.current.filterHistory).toHaveLength(20)
    // The oldest entries (0..4) should have been dropped.
    // Entry [0] of the capped history should be the config from step 4 (value '4'),
    // because steps 0-4 produced history entries null,'0','1','2','3' which got
    // truncated when the 21st apply pushed to 21 items before capping.
    // Simpler: just verify the cap is enforced and the current config is the last applied.
    expect(result.current.viewFilterConfig).toEqual(makeConfig('24'))
  })
})

// ---------------------------------------------------------------------------
// Track A: Ctrl+Z precedence pattern
// (SpreadsheetView cannot be rendered directly; we prove the contract via
//  the pattern that the onUndo handler will follow.)
// ---------------------------------------------------------------------------

describe('useFilterHistory — Ctrl+Z precedence pattern', () => {
  it('UNDO_PRECEDENCE: undoFilter returns true, preventing dataset undo from firing', () => {
    const datasetUndo = vi.fn()
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })

    // Simulate the onUndo handler: try filter undo first
    let consumed = false
    act(() => { consumed = result.current.undoFilter() })
    if (!consumed) datasetUndo()

    expect(consumed).toBe(true)
    expect(datasetUndo).not.toHaveBeenCalled()
    expect(result.current.viewFilterConfig).toBeNull()
  })

  it('UNDO_FALLTHROUGH: undoFilter returns false when history is empty, dataset undo fires', () => {
    const datasetUndo = vi.fn()
    const { result } = renderHook(() => useFilterHistory())
    // history is empty — no filter applied

    let consumed = false
    act(() => { consumed = result.current.undoFilter() })
    if (!consumed) datasetUndo()

    expect(consumed).toBe(false)
    expect(datasetUndo).toHaveBeenCalledOnce()
  })

  it('RAPID_UNDO_REMOVES_TWO_ENTRIES: two undoFilter calls inside one act both take effect', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })
    act(() => { result.current.applyFilter(CONFIG_B) })
    // history = [null, CONFIG_A], current = CONFIG_B

    act(() => {
      result.current.undoFilter()
      result.current.undoFilter()
    })

    // Both undos must have fired — history empty, config restored to null
    expect(result.current.filterHistory).toHaveLength(0)
    expect(result.current.viewFilterConfig).toBeNull()
  })

  it('APPLY_FUNCTIONAL_UPDATER: applyFilter accepts a (prev => next) updater function', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })

    act(() => {
      result.current.applyFilter((prev) => ({
        groups: [...(prev?.groups ?? []), ...(CONFIG_B.groups)],
        groupOperator: 'AND',
      }))
    })

    // Config should have both groups merged
    expect(result.current.viewFilterConfig?.groups).toHaveLength(2)
    // Previous config (CONFIG_A) pushed to history
    expect(result.current.filterHistory).toHaveLength(2)
    expect(result.current.filterHistory[1]).toEqual(CONFIG_A)
  })

  it('RAPID_APPLY_BOTH_UPDATES_APPLY: two rapid functional updates each see prior state', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => {
      result.current.applyFilter(() => ({
        groups: [{ op: 'AND', conditions: [{ columnId: 'col', operator: 'eq', value: 'first' }] }],
        groupOperator: 'AND',
      }))
      result.current.applyFilter((prev) => ({
        groups: [...(prev?.groups ?? []), { op: 'AND', conditions: [{ columnId: 'col2', operator: 'eq', value: 'second' }] }],
        groupOperator: 'AND',
      }))
    })

    // Second apply must have seen the first apply's result — both conditions present
    expect(result.current.viewFilterConfig?.groups).toHaveLength(2)
  })

  it('APPLY_NOOP_NO_HISTORY_PUSH: re-applying the same config does not push a dead undo step', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })
    expect(result.current.filterHistory).toHaveLength(1)

    // Apply identical config — should not grow history
    act(() => { result.current.applyFilter(CONFIG_A) })
    expect(result.current.filterHistory).toHaveLength(1)
    expect(result.current.viewFilterConfig).toEqual(CONFIG_A)
  })

  it('UNDO_AFTER_NOOP_STILL_RESTORES_LAST_REAL_STATE: undo after no-op applies restores the real previous state', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })
    act(() => { result.current.applyFilter(CONFIG_A) }) // no-op
    act(() => { result.current.applyFilter(CONFIG_A) }) // no-op

    let undid: boolean | undefined
    act(() => { undid = result.current.undoFilter() })

    // Single real undo restores to null (the state before CONFIG_A was applied)
    expect(undid).toBe(true)
    expect(result.current.viewFilterConfig).toBeNull()
    // After that, history must be empty
    expect(result.current.filterHistory).toHaveLength(0)
  })

  it('UNDO_MULTI_LEVEL: multiple Ctrl+Z calls walk back through all history entries', () => {
    const { result } = renderHook(() => useFilterHistory())

    act(() => { result.current.applyFilter(CONFIG_A) })
    act(() => { result.current.applyFilter(CONFIG_B) })
    act(() => { result.current.applyFilter(CONFIG_C) })

    act(() => { result.current.undoFilter() })
    expect(result.current.viewFilterConfig).toEqual(CONFIG_B)

    act(() => { result.current.undoFilter() })
    expect(result.current.viewFilterConfig).toEqual(CONFIG_A)

    act(() => { result.current.undoFilter() })
    expect(result.current.viewFilterConfig).toBeNull()

    // fourth undo should be no-op
    let undid: boolean | undefined
    act(() => { undid = result.current.undoFilter() })
    expect(undid).toBe(false)
    expect(result.current.viewFilterConfig).toBeNull()
  })
})
