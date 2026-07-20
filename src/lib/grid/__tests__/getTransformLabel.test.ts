/**
 * getTransformLabel.test.ts
 *
 * Phase 4 TDD tests for the canonical transform label helper.
 * Written RED-first.
 *
 * Tests:
 *   LABEL_FILTER_PERMANENT   - filter type returns a label containing "Permanent"
 *                              (distinguishes destructive from view filter)
 *   LABEL_PIVOT_WIDER        - pivot_wider returns expected label
 *   LABEL_GROUP_AGG          - group_aggregate returns expected label
 *   LABEL_UNKNOWN_FALLBACK   - unknown type falls back to the raw type string
 *   LABEL_CONSISTENT_FILTER  - getTransformLabel('filter') equals TRANSFORM_LABELS.filter
 *                              used by TransformWarningDialog (no drift possible)
 */

import { describe, it, expect } from 'vitest'
import { getTransformLabel } from '../getTransformLabel'

describe('getTransformLabel', () => {
  it('LABEL_FILTER_PERMANENT: filter type label contains "Permanent"', () => {
    expect(getTransformLabel('filter')).toMatch(/permanent/i)
  })

  it('LABEL_PIVOT_WIDER: pivot_wider returns "Pivot Wider"', () => {
    expect(getTransformLabel('pivot_wider')).toBe('Pivot Wider')
  })

  it('LABEL_PIVOT_LONGER: pivot_longer returns "Pivot Longer"', () => {
    expect(getTransformLabel('pivot_longer')).toBe('Pivot Longer')
  })

  it('LABEL_GROUP_AGG: group_aggregate returns "Group & Aggregate"', () => {
    expect(getTransformLabel('group_aggregate')).toBe('Group & Aggregate')
  })

  it('LABEL_UNKNOWN_FALLBACK: unknown type falls back to the raw type string', () => {
    expect(getTransformLabel('some_unknown_type')).toBe('some_unknown_type')
  })

  it('LABEL_CONSISTENT_FILTER: filter label is exactly "Filter (Permanent)"', () => {
    // Locks the canonical string so TransformWarningDialog and AppShell
    // actionLabel ternary cannot independently drift.
    expect(getTransformLabel('filter')).toBe('Filter (Permanent)')
  })
})
