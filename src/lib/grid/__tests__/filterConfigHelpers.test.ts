/**
 * filterConfigHelpers.test.ts
 *
 * TDD tests for per-column filter config helpers (Phase 2).
 * Written RED-first.
 *
 * Tests:
 *   MERGE_NULL_PREV        - mergeColumnConditions(null, ...) returns config with new conditions
 *   MERGE_ADD_COLUMN       - adds new group for column when config had none
 *   MERGE_REPLACE_COLUMN   - replaces existing conditions for that column only
 *   MERGE_CLEAR_COLUMN     - conditions=null removes that column's group; preserves others
 *   MERGE_CLEARS_TO_NULL   - removing last column returns null (no empty config)
 *   EXTRACT_PRESENT        - extractColumnConditions returns conditions for known column
 *   EXTRACT_ABSENT         - returns null when column has no conditions
 *   EXTRACT_NULL_CONFIG    - returns null when config is null
 */

import { describe, it, expect } from 'vitest'
import type { FilterConfig, FilterCondition } from '@/services/dataTransformService'
import { mergeColumnConditions, extractColumnConditions, deriveUniqueFilterValues, buildScopedFilterConfig, VIEW_FILTER_BLANK_TOKEN } from '../filterConfigHelpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cond(columnId: string, value: string): FilterCondition {
  return { columnId, operator: 'ne', value }
}

// ---------------------------------------------------------------------------
// mergeColumnConditions
// ---------------------------------------------------------------------------

describe('mergeColumnConditions', () => {
  it('MERGE_NULL_PREV: null config + new conditions → returns config with one group', () => {
    const result = mergeColumnConditions(null, 'col-a', [cond('col-a', 'Bob')])
    expect(result).not.toBeNull()
    expect(result!.groups).toHaveLength(1)
    expect(result!.groups[0]!.conditions).toEqual([cond('col-a', 'Bob')])
  })

  it('MERGE_ADD_COLUMN: existing config with other column → adds new group for new column', () => {
    const prev: FilterConfig = {
      groups: [{ op: 'AND', conditions: [cond('col-b', 'X')] }],
    }
    const result = mergeColumnConditions(prev, 'col-a', [cond('col-a', 'Bob')])
    expect(result!.groups).toHaveLength(2)
    expect(result!.groups.some(g => g.conditions.some(c => c.columnId === 'col-b'))).toBe(true)
    expect(result!.groups.some(g => g.conditions.some(c => c.columnId === 'col-a'))).toBe(true)
  })

  it('MERGE_REPLACE_COLUMN: replaces existing conditions for same column, preserves others', () => {
    const prev: FilterConfig = {
      groups: [
        { op: 'AND', conditions: [cond('col-a', 'OldValue')] },
        { op: 'AND', conditions: [cond('col-b', 'X')] },
      ],
    }
    const result = mergeColumnConditions(prev, 'col-a', [cond('col-a', 'NewValue')])
    expect(result!.groups).toHaveLength(2)
    const colAConditions = result!.groups
      .flatMap(g => g.conditions)
      .filter(c => c.columnId === 'col-a')
    expect(colAConditions).toHaveLength(1)
    expect(colAConditions[0]!.value).toBe('NewValue')
    // col-b preserved
    expect(result!.groups.flatMap(g => g.conditions).some(c => c.columnId === 'col-b')).toBe(true)
  })

  it('MERGE_CLEAR_COLUMN: conditions=null removes that column, preserves others', () => {
    const prev: FilterConfig = {
      groups: [
        { op: 'AND', conditions: [cond('col-a', 'Bob')] },
        { op: 'AND', conditions: [cond('col-b', 'X')] },
      ],
    }
    const result = mergeColumnConditions(prev, 'col-a', null)
    expect(result).not.toBeNull()
    expect(result!.groups.flatMap(g => g.conditions).some(c => c.columnId === 'col-a')).toBe(false)
    expect(result!.groups.flatMap(g => g.conditions).some(c => c.columnId === 'col-b')).toBe(true)
  })

  it('MERGE_CLEARS_TO_NULL: clearing the only column returns null', () => {
    const prev: FilterConfig = {
      groups: [{ op: 'AND', conditions: [cond('col-a', 'Bob')] }],
    }
    const result = mergeColumnConditions(prev, 'col-a', null)
    expect(result).toBeNull()
  })

  it('MERGE_PRESERVES_GROUP_OPERATOR: groupOperator is preserved through merge', () => {
    const prev: FilterConfig = {
      groups: [{ op: 'AND', conditions: [cond('col-b', 'X')] }],
      groupOperator: 'OR',
    }
    const result = mergeColumnConditions(prev, 'col-a', [cond('col-a', 'Bob')])
    expect(result!.groupOperator).toBe('OR')
  })

  it('GROUP_OPERATOR_EXPLICIT: null prev returns explicit groupOperator AND (not undefined)', () => {
    const result = mergeColumnConditions(null, 'col-a', [cond('col-a', 'Bob')])
    expect(result!.groupOperator).toBe('AND')
  })
})

// ---------------------------------------------------------------------------
// deriveUniqueFilterValues
// ---------------------------------------------------------------------------

describe('deriveUniqueFilterValues', () => {
  it('DERIVE_UNIQUE_NORMAL: non-blank values pass through sorted and deduped', () => {
    const result = deriveUniqueFilterValues(['Bob', 'Alice', 'Alice', 'Charlie'])
    expect(result).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('DERIVE_UNIQUE_BLANK: null values are replaced by VIEW_FILTER_BLANK_TOKEN', () => {
    const result = deriveUniqueFilterValues(['Alice', null, 'Bob'])
    expect(result).toContain(VIEW_FILTER_BLANK_TOKEN)
    expect(result).not.toContain(null)
    expect(result).not.toContain('')
  })

  it('DERIVE_UNIQUE_EMPTY: empty-string values are replaced by VIEW_FILTER_BLANK_TOKEN', () => {
    const result = deriveUniqueFilterValues(['Alice', '', 'Bob'])
    expect(result).toContain(VIEW_FILTER_BLANK_TOKEN)
    expect(result.filter(v => v === '')).toHaveLength(0)
  })

  it('DERIVE_UNIQUE_BLANK_ONCE: multiple nulls/empty-strings yield single token entry', () => {
    const result = deriveUniqueFilterValues([null, '', null, 'Alice'])
    expect(result.filter(v => v === VIEW_FILTER_BLANK_TOKEN)).toHaveLength(1)
  })

  it('DERIVE_UNIQUE_BLANK_SORT: blank token sorts to end after normal values', () => {
    const result = deriveUniqueFilterValues(['Zara', null, 'Alice'])
    expect(result[result.length - 1]).toBe(VIEW_FILTER_BLANK_TOKEN)
  })
})

// ---------------------------------------------------------------------------
// extractColumnConditions
// ---------------------------------------------------------------------------

describe('extractColumnConditions', () => {
  it('EXTRACT_PRESENT: returns all conditions for given column', () => {
    const config: FilterConfig = {
      groups: [
        { op: 'AND', conditions: [cond('col-a', 'Bob'), cond('col-b', 'X')] },
        { op: 'AND', conditions: [cond('col-a', 'Carol')] },
      ],
    }
    const result = extractColumnConditions(config, 'col-a')
    expect(result).toHaveLength(2)
    expect(result!.every(c => c.columnId === 'col-a')).toBe(true)
  })

  it('EXTRACT_ABSENT: returns null when column has no conditions', () => {
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [cond('col-b', 'X')] }],
    }
    expect(extractColumnConditions(config, 'col-a')).toBeNull()
  })

  it('EXTRACT_NULL_CONFIG: returns null when config is null', () => {
    expect(extractColumnConditions(null, 'col-a')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildScopedFilterConfig
// ---------------------------------------------------------------------------

describe('buildScopedFilterConfig', () => {
  it('SCOPE_NULL_CONFIG: returns null when config is null', () => {
    expect(buildScopedFilterConfig(null, 'col-a')).toBeNull()
  })

  it('SCOPE_NO_MATCH: returns null when column has no conditions in config', () => {
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [cond('col-b', 'X')] }],
    }
    expect(buildScopedFilterConfig(config, 'col-a')).toBeNull()
  })

  it('SCOPE_SINGLE_COL: returns config containing only conditions for the given column', () => {
    const config: FilterConfig = {
      groups: [
        { op: 'AND', conditions: [cond('col-a', 'Bob'), cond('col-b', 'X')] },
        { op: 'AND', conditions: [cond('col-a', 'Carol')] },
      ],
      groupOperator: 'AND',
    }
    const result = buildScopedFilterConfig(config, 'col-a')
    expect(result).not.toBeNull()
    const allConditions = result!.groups.flatMap((g) => g.conditions)
    expect(allConditions.length).toBeGreaterThan(0)
    expect(allConditions.every((c) => c.columnId === 'col-a')).toBe(true)
    // No col-b conditions
    expect(allConditions.some((c) => c.columnId === 'col-b')).toBe(false)
  })

  it('SCOPE_PRESERVES_GROUP_OPERATOR: scoped config preserves groupOperator from original', () => {
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [cond('col-a', 'X')] }],
      groupOperator: 'OR',
    }
    const result = buildScopedFilterConfig(config, 'col-a')
    expect(result!.groupOperator).toBe('OR')
  })

  it('SCOPE_IMMUTABLE: buildScopedFilterConfig does not mutate its input config', () => {
    const config: FilterConfig = {
      groups: [
        { op: 'AND', conditions: [cond('col-a', 'Bob'), cond('col-b', 'X')] },
      ],
      groupOperator: 'AND',
    }
    const originalGroupsLength = config.groups.length
    const originalConditionsLength = config.groups[0]!.conditions.length
    buildScopedFilterConfig(config, 'col-a')
    // Input must be unchanged
    expect(config.groups).toHaveLength(originalGroupsLength)
    expect(config.groups[0]!.conditions).toHaveLength(originalConditionsLength)
    expect(config.groups[0]!.conditions.some((c) => c.columnId === 'col-b')).toBe(true)
  })
})
