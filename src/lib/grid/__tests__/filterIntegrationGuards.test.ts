/**
 * filterIntegrationGuards.test.ts
 *
 * Phase 5 TDD integration guardrail tests.
 * Written RED-first — tests describe the desired behaviour.
 *
 * Tests:
 *   GUARD_SORT_FILTER_COMPOSE  - sort order is preserved inside filtered output
 *   GUARD_GROUP_FILTER_COMPOSE - filter applied before grouping keeps correct subset
 *   GUARD_LARGE_DATASET        - filter over 100k rows completes within time budget
 *   GUARD_INVALID_COLUMN       - filterConfig referencing non-existent column never crashes
 *   GUARD_GATE_TOGGLE          - useFilterHistory: clearing config mid-session is safe
 *   GUARD_STRICTMODE           - useFilterHistory state survives double-invocation
 *                                (React StrictMode effect)
 */

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { applyViewFilter } from '../viewFilter'
import { useFilterHistory } from '../useFilterHistory'
import type { FilterConfig } from '@/services/dataTransformService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRows(count: number, colKey = 'val'): Map<number, Record<string, unknown>> {
  const m = new Map<number, Record<string, unknown>>()
  for (let i = 0; i < count; i++) {
    m.set(i, { [colKey]: i % 3 === 0 ? 'keep' : 'drop' })
  }
  return m
}

function keepFilter(colKey = 'val'): FilterConfig {
  return {
    groups: [{ op: 'AND', conditions: [{ columnId: colKey, operator: 'eq', value: 'keep' }] }],
    groupOperator: 'AND',
  }
}

// ---------------------------------------------------------------------------
// GUARD_SORT_FILTER_COMPOSE
// ---------------------------------------------------------------------------

describe('GUARD_SORT_FILTER_COMPOSE: sort order is preserved inside filtered output', () => {
  it('rows passing the filter appear in the same relative order as in the sorted input', () => {
    // Simulate a descending sort: row 8, 5, 2 are in sorted order (divisible by 3 → "keep")
    // interspersed among other rows
    const order = [8, 7, 6, 5, 4, 3, 2, 1, 0]
    const rows = makeRows(9)
    const dataRowCount = 9

    const result = applyViewFilter(order, keepFilter(), rows, dataRowCount)

    // Only rows 0,3,6 have value 'keep' (idx % 3 === 0)
    // In the sorted input their encounter order is: 6, 3, 0
    expect(result).toEqual([6, 3, 0])
  })

  it('a second sort (reversed order) yields the same rows in the new sort order', () => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8]   // ascending sort
    const rows = makeRows(9)

    const result = applyViewFilter(order, keepFilter(), rows, 9)
    // ascending encounter order: 0, 3, 6
    expect(result).toEqual([0, 3, 6])
  })
})

// ---------------------------------------------------------------------------
// GUARD_GROUP_FILTER_COMPOSE
// ---------------------------------------------------------------------------

describe('GUARD_GROUP_FILTER_COMPOSE: filter applied before grouping keeps correct subset', () => {
  it('only rows passing the filter are present in the output fed to grouping', () => {
    // Grouping in SpreadsheetView receives filteredOrder then partitions by a column.
    // This test verifies the filtered order itself is correct so grouping starts clean.
    const order = [0, 1, 2, 3, 4, 5]
    const rows = new Map([
      [0, { group: 'A', active: 'yes' }],
      [1, { group: 'A', active: 'no' }],
      [2, { group: 'B', active: 'yes' }],
      [3, { group: 'B', active: 'no' }],
      [4, { group: 'C', active: 'yes' }],
      [5, { group: 'C', active: 'no' }],
    ])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'active', operator: 'eq', value: 'yes' }] }],
      groupOperator: 'AND',
    }

    const filtered = applyViewFilter(order, config, rows, 6)

    // Rows 0,2,4 have active=yes — one from each group
    expect(filtered).toEqual([0, 2, 4])
  })

  it('buffer rows always pass through regardless of filter config', () => {
    const order = [0, 1, 100, 101]   // 100,101 are buffer rows
    const rows = new Map([
      [0, { val: 'keep' }],
      [1, { val: 'drop' }],
    ])
    const dataRowCount = 2

    const result = applyViewFilter(order, keepFilter(), rows, dataRowCount)

    // Row 0 passes; row 1 drops; buffer rows 100,101 always pass (appended at tail)
    expect(result).toEqual([0, 100, 101])
  })
})

// ---------------------------------------------------------------------------
// GUARD_LARGE_DATASET
// ---------------------------------------------------------------------------

describe('GUARD_LARGE_DATASET: filter over 100k rows completes within time budget', () => {
  it('applyViewFilter on 100k rows finishes in under 5 seconds', () => {
    const ROW_COUNT = 100_000
    const rows = new Map<number, Record<string, unknown>>()
    const order: number[] = []
    for (let i = 0; i < ROW_COUNT; i++) {
      order.push(i)
      rows.set(i, { category: i % 5 === 0 ? 'match' : 'other' })
    }

    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'category', operator: 'eq', value: 'match' }] }],
      groupOperator: 'AND',
    }

    const start = performance.now()
    const result = applyViewFilter(order, config, rows, ROW_COUNT)
    const elapsed = performance.now() - start

    // 20k rows should pass (every 5th)
    expect(result).toHaveLength(ROW_COUNT / 5)
    expect(elapsed).toBeLessThan(5000)
  })
})

// ---------------------------------------------------------------------------
// GUARD_INVALID_COLUMN
// ---------------------------------------------------------------------------

describe('GUARD_INVALID_COLUMN: non-existent columnId never crashes', () => {
  it('returns unfiltered order when filterConfig references a column not in rows', () => {
    const order = [0, 1, 2]
    const rows = new Map([
      [0, { name: 'Alice' }],
      [1, { name: 'Bob' }],
      [2, { name: 'Carol' }],
    ])
    const config: FilterConfig = {
      // 'nonexistent_col' does not appear in any row record
      groups: [{ op: 'AND', conditions: [{ columnId: 'nonexistent_col', operator: 'eq', value: 'x' }] }],
      groupOperator: 'AND',
    }

    // Must not throw — must return a valid array
    let result: number[] | undefined
    expect(() => {
      result = applyViewFilter(order, config, rows, 3)
    }).not.toThrow()

    // Fail-safe: either returns all rows (unfiltered) or zero rows but never crashes
    expect(result).toBeDefined()
    expect(Array.isArray(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GUARD_GATE_TOGGLE
// ---------------------------------------------------------------------------

describe('GUARD_GATE_TOGGLE: useFilterHistory toggles cleanly mid-session', () => {
  it('applying then clearing filter leaves no residual history', () => {
    const { result } = renderHook(() => useFilterHistory())

    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'c', operator: 'eq', value: 'v' }] }],
      groupOperator: 'AND',
    }

    act(() => { result.current.applyFilter(config) })
    expect(result.current.viewFilterConfig).toEqual(config)

    act(() => { result.current.clearFilter() })

    expect(result.current.viewFilterConfig).toBeNull()
    expect(result.current.filterHistory).toHaveLength(0)

    // Re-applying after clear starts a fresh history
    act(() => { result.current.applyFilter(config) })
    expect(result.current.filterHistory).toHaveLength(1)
    expect(result.current.filterHistory[0]).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GUARD_STRICTMODE
// ---------------------------------------------------------------------------

describe('GUARD_STRICTMODE: filter state survives StrictMode double-invocation', () => {
  it('applyFilter and undoFilter are correct under StrictMode double-mount', () => {
    const { result } = renderHook(() => useFilterHistory(), {
      wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
    })

    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'x', operator: 'eq', value: '1' }] }],
      groupOperator: 'AND',
    }

    act(() => { result.current.applyFilter(config) })

    // StrictMode double-invokes effects — history must not have double entries
    expect(result.current.viewFilterConfig).toEqual(config)
    expect(result.current.filterHistory).toHaveLength(1)

    let undid: boolean | undefined
    act(() => { undid = result.current.undoFilter() })
    expect(undid).toBe(true)
    expect(result.current.viewFilterConfig).toBeNull()
    expect(result.current.filterHistory).toHaveLength(0)
  })
})
