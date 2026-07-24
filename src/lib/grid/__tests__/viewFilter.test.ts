/**
 * viewFilter.test.ts
 *
 * TDD tests for applyViewFilter — the pure helper that takes a sorted row-index
 * array and a FilterConfig and returns a filtered subset preserving sort order.
 *
 * Written RED-first against a non-existent `viewFilter.ts` module.
 * All tests should fail with "Cannot find module" until viewFilter.ts is created.
 */

import { describe, it, expect } from 'vitest'
import { applyViewFilter } from '../viewFilter'
import type { FilterConfig } from '@/services/dataTransformService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRows(entries: Array<Record<string, unknown>>): Map<number, Record<string, unknown>> {
  const map = new Map<number, Record<string, unknown>>()
  entries.forEach((record, idx) => map.set(idx, record))
  return map
}

// ---------------------------------------------------------------------------
// PASS-THROUGH — null / empty config
// ---------------------------------------------------------------------------

describe('applyViewFilter — pass-through', () => {
  it('PASS_NULL: returns same order when filterConfig is null', () => {
    const order = [0, 1, 2, 3]
    const rows = makeRows([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }, { name: 'Dave' }])
    expect(applyViewFilter(order, null, rows, 4)).toEqual([0, 1, 2, 3])
  })

  it('PASS_EMPTY_CONDITIONS: returns same order when all groups have zero conditions', () => {
    const order = [0, 1, 2]
    const rows = makeRows([{ x: 1 }, { x: 2 }, { x: 3 }])
    const config: FilterConfig = { groups: [{ op: 'AND', conditions: [] }] }
    expect(applyViewFilter(order, config, rows, 3)).toEqual([0, 1, 2])
  })

  it('PASS_EMPTY_GROUPS: returns same order when groups array is empty', () => {
    const order = [0, 1]
    const rows = makeRows([{ x: 10 }, { x: 20 }])
    const config: FilterConfig = { groups: [] }
    expect(applyViewFilter(order, config, rows, 2)).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// FILTER CORRECTNESS
// ---------------------------------------------------------------------------

describe('applyViewFilter — filter correctness', () => {
  it('FILTER_EQ: returns only indices where the column value matches eq condition', () => {
    const order = [0, 1, 2]
    const rows = makeRows([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'name', operator: 'eq', value: 'Alice' }] }],
    }
    expect(applyViewFilter(order, config, rows, 3)).toEqual([0, 2])
  })

  it('FILTER_GT: returns only indices where numeric value passes gt condition', () => {
    const order = [0, 1, 2, 3]
    const rows = makeRows([{ score: 5 }, { score: 15 }, { score: 25 }, { score: 35 }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'score', operator: 'gt', value: 10 }] }],
    }
    expect(applyViewFilter(order, config, rows, 4)).toEqual([1, 2, 3])
  })

  it('FILTER_ALL_EXCLUDED: returns empty array when no rows pass the filter', () => {
    const order = [0, 1, 2]
    const rows = makeRows([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'name', operator: 'eq', value: 'Zed' }] }],
    }
    expect(applyViewFilter(order, config, rows, 3)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ORDER PRESERVATION — sort order must be retained in filtered output
// ---------------------------------------------------------------------------

describe('applyViewFilter — order preservation', () => {
  it('PRESERVE_ORDER: filtered results appear in the same relative order as input', () => {
    const order = [2, 0, 1]  // descending by score: 30, 10, 20
    const rows = makeRows([{ score: 10 }, { score: 20 }, { score: 30 }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'score', operator: 'gt', value: 15 }] }],
    }
    // Row 0 (score=10) excluded. Remaining in input order: [2, 1]
    expect(applyViewFilter(order, config, rows, 3)).toEqual([2, 1])
  })

  it('PRESERVE_ORDER_IDENTITY: identity filter (all pass) keeps exact input order', () => {
    const order = [3, 1, 0, 2]
    const rows = makeRows([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'v', operator: 'gt', value: 0 }] }],
    }
    expect(applyViewFilter(order, config, rows, 4)).toEqual([3, 1, 0, 2])
  })
})

// ---------------------------------------------------------------------------
// BUFFER ROWS — rows >= dataRowCount must always be preserved, never filtered
// ---------------------------------------------------------------------------

describe('applyViewFilter — buffer rows', () => {
  it('BUFFER_KEPT: buffer rows (>= dataRowCount) are appended unchanged regardless of filter', () => {
    // Rows 0-1 are data rows; 100, 101 are buffer rows (no data in map)
    const order = [0, 1, 100, 101]
    const rows = makeRows([{ value: 5 }, { value: 15 }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'value', operator: 'gt', value: 10 }] }],
    }
    // Row 0 (value=5) excluded. Row 1 passes. Buffer rows always included.
    expect(applyViewFilter(order, config, rows, 2)).toEqual([1, 100, 101])
  })

  it('BUFFER_ORDER: buffer rows appear after filtered data rows in output', () => {
    const order = [100, 0, 1]  // buffer row first in input order
    const rows = makeRows([{ x: 1 }, { x: 2 }])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'x', operator: 'gt', value: 0 }] }],
    }
    // Filtered data rows: [0, 1]; buffer rows: [100]
    // Buffer rows always appended at the end
    expect(applyViewFilter(order, config, rows, 2)).toEqual([0, 1, 100])
  })

  it('BUFFER_NULL: buffer rows are kept even when filterConfig is null', () => {
    const order = [0, 200, 201]
    const rows = makeRows([{ x: 1 }])
    expect(applyViewFilter(order, null, rows, 1)).toEqual([0, 200, 201])
  })
})

// ---------------------------------------------------------------------------
// FAIL-SAFE — missing rows in fullRowsByIndex must never be silently dropped
// ---------------------------------------------------------------------------

describe('applyViewFilter — fail-safe for missing rows', () => {
  it('FAILSAFE_KEEP_MISSING: data row not present in fullRowsByIndex is kept in output', () => {
    const order = [0, 1, 2]
    // Row 1 deliberately absent from map
    const rows = new Map<number, Record<string, unknown>>([
      [0, { name: 'Alice' }],
      [2, { name: 'Bob' }],
    ])
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'name', operator: 'eq', value: 'Alice' }] }],
    }
    // Row 0 passes (Alice). Row 1 missing → kept (fail-safe). Row 2 (Bob) excluded.
    expect(applyViewFilter(order, config, rows, 3)).toEqual([0, 1])
  })

  it('FAILSAFE_ALL_MISSING: when entire map is empty, all data rows are kept', () => {
    const order = [0, 1, 2]
    const rows = new Map<number, Record<string, unknown>>()
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'name', operator: 'eq', value: 'Alice' }] }],
    }
    expect(applyViewFilter(order, config, rows, 3)).toEqual([0, 1, 2])
  })
})
