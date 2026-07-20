/**
 * ColumnFilterPopover.test.tsx
 *
 * TDD tests for the per-column filter popover (Phase 2).
 * Written RED-first — all tests fail until ColumnFilterPopover is implemented.
 *
 * Tests:
 *   POPOVER_OPENS            - clicking trigger opens the popover
 *   POPOVER_VALUE_LIST       - unique values rendered as checkboxes after open
 *   POPOVER_CHECK_FILTER     - unchecking a value + Apply emits ne condition
 *   POPOVER_SORT_ASC         - "Sort A→Z" calls onSort('asc')
 *   POPOVER_SORT_DESC        - "Sort Z→A" calls onSort('desc')
 *   POPOVER_ADVANCED         - "Open Advanced Filter…" calls onOpenAdvancedFilter
 *   POPOVER_CLEAR_COL        - "Clear filter" calls onApply(null) when conditions active
 *   POPOVER_ACTIVE_INDICATOR - trigger shows active badge when activeConditions is set
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { FilterCondition } from '@/services/dataTransformService'
import { VIEW_FILTER_BLANK_TOKEN } from '@/lib/grid/filterConfigHelpers'

import { ColumnFilterPopover } from '../ColumnFilterPopover'

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------

const makeGetUniqueValues = (values: string[] = ['Alice', 'Bob', 'Carol']) =>
  vi.fn().mockResolvedValue(values) as unknown as () => Promise<string[]>

const defaultProps = {
  columnId: 'col-name',
  columnName: 'Name',
  activeConditions: null as FilterCondition[] | null,
  getUniqueValues: makeGetUniqueValues(),
  onApply: vi.fn() as (conditions: FilterCondition[] | null) => void,
  onSort: vi.fn() as (dir: 'asc' | 'desc') => void,
  onOpenAdvancedFilter: vi.fn(),
}

function setup(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides }
  const result = render(<ColumnFilterPopover {...props} />)
  return { ...result, props }
}

async function openPopover() {
  const trigger = screen.getByRole('button', { name: /filter options for/i })
  await userEvent.click(trigger)
  // Wait for async unique-values load
  await waitFor(() => screen.getByRole('list', { name: /filter values/i }))
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  defaultProps.getUniqueValues = makeGetUniqueValues()
})

// ---------------------------------------------------------------------------

describe('ColumnFilterPopover', () => {
  it('POPOVER_OPENS: clicking the trigger button opens the popover', async () => {
    setup()
    expect(screen.queryByRole('list', { name: /filter values/i })).not.toBeInTheDocument()
    await openPopover()
    expect(screen.getByRole('list', { name: /filter values/i })).toBeInTheDocument()
  })

  it('POPOVER_VALUE_LIST: unique values appear as labelled checkboxes after open', async () => {
    setup()
    await openPopover()
    expect(screen.getByRole('checkbox', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Bob' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Carol' })).toBeInTheDocument()
    // All start checked (no active exclusions)
    expect(screen.getByRole('checkbox', { name: 'Alice' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Bob' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Carol' })).toBeChecked()
  })

  it('POPOVER_CHECK_FILTER: unchecking Bob and clicking Apply emits ne condition for Bob', async () => {
    const onApply = vi.fn()
    setup({ onApply })
    await openPopover()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Bob' }))
    await userEvent.click(screen.getByRole('button', { name: /^apply$/i }))

    expect(onApply).toHaveBeenCalledOnce()
    const conditions: FilterCondition[] = onApply.mock.calls[0]![0] as FilterCondition[]
    expect(conditions).toHaveLength(1)
    expect(conditions[0]!).toMatchObject({
      columnId: 'col-name',
      operator: 'ne',
      value: 'Bob',
    })
  })

  it('POPOVER_CHECK_ALL: checking all values back calls onApply(null) — clears filter', async () => {
    const onApply = vi.fn()
    // Start with Bob excluded
    const activeConditions: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: 'Bob' },
    ]
    setup({ onApply, activeConditions })
    await openPopover()

    // Bob should be unchecked (excluded); re-check it
    expect(screen.getByRole('checkbox', { name: 'Bob' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bob' }))
    await userEvent.click(screen.getByRole('button', { name: /^apply$/i }))

    // All checked → clear this column's filter
    expect(onApply).toHaveBeenCalledWith(null)
  })

  it('POPOVER_SORT_ASC: clicking "Sort A→Z" calls onSort with asc', async () => {
    const onSort = vi.fn()
    setup({ onSort })
    await openPopover()
    await userEvent.click(screen.getByRole('button', { name: /sort a.*z/i }))
    expect(onSort).toHaveBeenCalledWith('asc')
  })

  it('POPOVER_SORT_DESC: clicking "Sort Z→A" calls onSort with desc', async () => {
    const onSort = vi.fn()
    setup({ onSort })
    await openPopover()
    await userEvent.click(screen.getByRole('button', { name: /sort z.*a/i }))
    expect(onSort).toHaveBeenCalledWith('desc')
  })

  it('POPOVER_ADVANCED: "Open Advanced Filter…" calls onOpenAdvancedFilter', async () => {
    const onOpenAdvancedFilter = vi.fn()
    setup({ onOpenAdvancedFilter })
    await openPopover()
    await userEvent.click(screen.getByRole('button', { name: /open advanced filter/i }))
    expect(onOpenAdvancedFilter).toHaveBeenCalledOnce()
  })

  it('POPOVER_CLEAR_COL: "Clear filter" button calls onApply(null) when conditions are active', async () => {
    const onApply = vi.fn()
    const activeConditions: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: 'Bob' },
    ]
    setup({ onApply, activeConditions })
    await openPopover()

    const clearBtn = screen.getByRole('button', { name: /clear filter/i })
    await userEvent.click(clearBtn)

    expect(onApply).toHaveBeenCalledWith(null)
  })

  it('POPOVER_CLEAR_COL_HIDDEN: "Clear filter" button absent when no active conditions', async () => {
    setup({ activeConditions: null })
    await openPopover()
    expect(screen.queryByRole('button', { name: /clear filter/i })).not.toBeInTheDocument()
  })

  it('POPOVER_ACTIVE_INDICATOR: trigger has active indicator when activeConditions is set', () => {
    const activeConditions: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: 'Bob' },
    ]
    setup({ activeConditions })
    const trigger = screen.getByRole('button', { name: /filter options for/i })
    expect(trigger).toHaveAttribute('data-active', 'true')
  })

  it('POPOVER_ACTIVE_INDICATOR_OFF: trigger has no active indicator when no conditions', () => {
    setup({ activeConditions: null })
    const trigger = screen.getByRole('button', { name: /filter options for/i })
    expect(trigger).not.toHaveAttribute('data-active', 'true')
  })

  // ---------------------------------------------------------------------------
  // Blank sentinel (VIEW_FILTER_BLANK_TOKEN)
  // ---------------------------------------------------------------------------

  it('POPOVER_BLANK_LABEL: blank token renders as "(Blank)" label in checklist', async () => {
    setup({ getUniqueValues: makeGetUniqueValues(['Alice', VIEW_FILTER_BLANK_TOKEN]) })
    await openPopover()
    expect(screen.getByRole('checkbox', { name: '(Blank)' })).toBeInTheDocument()
    // Raw token should NOT appear as a label
    expect(screen.queryByRole('checkbox', { name: VIEW_FILTER_BLANK_TOKEN })).not.toBeInTheDocument()
  })

  it('POPOVER_BLANK_EXCLUDES: unchecking "(Blank)" emits ne condition with value ""', async () => {
    const onApply = vi.fn()
    setup({ onApply, getUniqueValues: makeGetUniqueValues(['Alice', VIEW_FILTER_BLANK_TOKEN]) })
    await openPopover()

    await userEvent.click(screen.getByRole('checkbox', { name: '(Blank)' }))
    await userEvent.click(screen.getByRole('button', { name: /^apply$/i }))

    expect(onApply).toHaveBeenCalledOnce()
    const conditions: FilterCondition[] = onApply.mock.calls[0]![0] as FilterCondition[]
    expect(conditions).toHaveLength(1)
    expect(conditions[0]!).toMatchObject({
      columnId: 'col-name',
      operator: 'ne',
      value: '',  // blank token maps to empty string in condition
    })
  })

  // ---------------------------------------------------------------------------
  // Async fetch cancellation (standalone ColumnFilterPopover)
  // ---------------------------------------------------------------------------

  it('POPOVER_CANCELS_FETCH_ON_CLOSE: stale fetch result discarded when popover is closed and reopened', async () => {
    let resolveFirst!: (vals: string[]) => void
    const deferredFirst = new Promise<string[]>((resolve) => { resolveFirst = resolve })

    const slowThenFast = vi.fn()
      .mockReturnValueOnce(deferredFirst)
      .mockResolvedValueOnce(['CurrentValue']) as unknown as () => Promise<string[]>

    setup({ getUniqueValues: slowThenFast })
    const trigger = screen.getByRole('button', { name: /filter options for/i })

    // First open — fetch starts but does not resolve
    await userEvent.click(trigger)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()

    // Close via Escape
    await userEvent.keyboard('{Escape}')

    // Second open — new fetch resolves immediately
    await userEvent.click(trigger)
    await waitFor(() => screen.getByRole('list', { name: /filter values/i }))
    expect(screen.getByRole('checkbox', { name: 'CurrentValue' })).toBeInTheDocument()

    // Resolve the stale first fetch
    resolveFirst(['STALE_VALUE'])
    await new Promise((r) => setTimeout(r, 0))  // flush microtasks

    // Stale result must NOT overwrite current values
    expect(screen.queryByRole('checkbox', { name: 'STALE_VALUE' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'CurrentValue' })).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // Pending checkbox state preserved across re-render with same activeConditions content
  // ---------------------------------------------------------------------------

  it('POPOVER_PRESERVES_BLANK_CHECK_ON_RERENDER: re-checking "(Blank)" not reset when parent re-renders with same blank exclusion content', async () => {
    const onApply = vi.fn()
    // Start with blank cells excluded (condition value is '')
    const activeConditions: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: '' },
    ]
    // Use a stable function reference — changing getUniqueValues would correctly
    // trigger a re-fetch (it's a dep), which is not what we want to test here.
    const stableGetUniqueValues = makeGetUniqueValues(['Alice', VIEW_FILTER_BLANK_TOKEN])
    const { rerender, props } = setup({
      onApply,
      activeConditions,
      getUniqueValues: stableGetUniqueValues,
    })
    await openPopover()

    // (Blank) excluded initially → unchecked
    expect(screen.getByRole('checkbox', { name: '(Blank)' })).not.toBeChecked()

    // User re-checks (Blank) — pending change, not applied yet
    await userEvent.click(screen.getByRole('checkbox', { name: '(Blank)' }))
    expect(screen.getByRole('checkbox', { name: '(Blank)' })).toBeChecked()

    // Parent re-renders with NEW array reference but SAME content (blank still excluded)
    const sameContentNewRef: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: '' },
    ]
    rerender(
      <ColumnFilterPopover
        {...props}
        activeConditions={sameContentNewRef}
        getUniqueValues={stableGetUniqueValues}
      />
    )

    // (Blank) should still be checked — pending edit preserved
    expect(screen.getByRole('checkbox', { name: '(Blank)' })).toBeChecked()
  })

  it('POPOVER_PRESERVES_CHECKS_ON_RERENDER: pending edits not reset by new activeConditions ref with same content', async () => {
    const onApply = vi.fn()
    const activeConditions: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: 'Carol' },
    ]
    const { rerender, props } = setup({ onApply, activeConditions })
    await openPopover()

    // Carol excluded initially → unchecked
    expect(screen.getByRole('checkbox', { name: 'Carol' })).not.toBeChecked()

    // User checks Carol back (pending change not yet applied)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Carol' }))
    expect(screen.getByRole('checkbox', { name: 'Carol' })).toBeChecked()

    // Parent re-renders with a NEW array reference but SAME content
    const sameContentNewRef: FilterCondition[] = [
      { columnId: 'col-name', operator: 'ne', value: 'Carol' },
    ]
    rerender(
      <ColumnFilterPopover
        {...props}
        activeConditions={sameContentNewRef}
      />
    )

    // Carol should still be checked — pending edit must be preserved
    expect(screen.getByRole('checkbox', { name: 'Carol' })).toBeChecked()
  })
})
