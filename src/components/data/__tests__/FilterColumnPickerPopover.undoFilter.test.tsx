/**
 * FilterColumnPickerPopover.undoFilter.test.tsx
 *
 * TDD tests for the Undo/Clear filter action block added to the picker popover.
 * Written RED-first — all tests must fail before the block is implemented.
 *
 * Tests:
 *   UNDO_FILTER_VISIBLE                - Undo Filter button present when canUndoFilter true
 *   UNDO_FILTER_DISABLED_WHEN_EMPTY    - Undo Filter disabled when canUndoFilter false
 *   CLEAR_FILTER_DISABLED_WHEN_INACTIVE - Clear Filter disabled when no active filter
 *   UNDO_FILTER_CALLS_FILTER_UNDO_ONLY - click calls onUndoFilter only
 *   CLEAR_FILTER_CALLS_CLEAR_ONLY      - click calls onClearFilter only
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilterColumnPickerPopover } from '../FilterColumnPickerPopover'
import type { FilterConfig } from '@/services/dataTransformService'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COLUMNS = [
  { id: 'col-a', name: 'Column A', type: 'text' as const },
]

const ACTIVE_CONFIG: FilterConfig = {
  groups: [{ op: 'AND', conditions: [{ columnId: 'col-a', operator: 'eq', value: 'x' }] }],
  groupOperator: 'AND',
}

// Render the popover in controlled open mode with undo/clear props always present.
function renderPicker(overrides: {
  viewFilterConfig?: FilterConfig | null
  canUndoFilter?: boolean
  onUndoFilter?: () => boolean
  onClearFilter?: () => void
  onSelectColumn?: () => void
  onOpenChange?: (open: boolean) => void
} = {}) {
  return render(
    <FilterColumnPickerPopover
      open={true}
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
      columns={COLUMNS}
      viewFilterConfig={overrides.viewFilterConfig ?? null}
      canUndoFilter={overrides.canUndoFilter ?? false}
      onUndoFilter={overrides.onUndoFilter ?? vi.fn()}
      onClearFilter={overrides.onClearFilter ?? vi.fn()}
      onSelectColumn={overrides.onSelectColumn ?? vi.fn()}
    />
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FilterColumnPickerPopover — Undo/Clear filter actions', () => {
  it('UNDO_FILTER_VISIBLE: Undo Filter button is present when canUndoFilter is true', () => {
    renderPicker({ viewFilterConfig: ACTIVE_CONFIG, canUndoFilter: true })
    expect(screen.getByRole('button', { name: /undo filter/i })).toBeInTheDocument()
  })

  it('UNDO_FILTER_DISABLED_WHEN_EMPTY: Undo Filter button is disabled when canUndoFilter is false', () => {
    renderPicker({ viewFilterConfig: null, canUndoFilter: false })
    expect(screen.getByRole('button', { name: /undo filter/i })).toBeDisabled()
  })

  it('CLEAR_FILTER_DISABLED_WHEN_INACTIVE: Clear Filter button is disabled when no active filter', () => {
    renderPicker({ viewFilterConfig: null, canUndoFilter: false })
    expect(screen.getByRole('button', { name: /clear filter/i })).toBeDisabled()
  })

  it('UNDO_FILTER_CALLS_FILTER_UNDO_ONLY: clicking Undo Filter calls onUndoFilter and nothing else', async () => {
    const onUndoFilter = vi.fn()
    const onClearFilter = vi.fn()
    const onSelectColumn = vi.fn()
    renderPicker({
      viewFilterConfig: ACTIVE_CONFIG,
      canUndoFilter: true,
      onUndoFilter,
      onClearFilter,
      onSelectColumn,
    })
    await userEvent.click(screen.getByRole('button', { name: /undo filter/i }))
    expect(onUndoFilter).toHaveBeenCalledOnce()
    expect(onClearFilter).not.toHaveBeenCalled()
    expect(onSelectColumn).not.toHaveBeenCalled()
  })

  it('UNDO_FILTER_CLOSES_PICKER: successful undo closes the picker (prevents double-undo window)', async () => {
    const onOpenChange = vi.fn()
    renderPicker({
      viewFilterConfig: ACTIVE_CONFIG,
      canUndoFilter: true,
      onUndoFilter: () => true,   // simulate successful undo
      onOpenChange,
    })
    await userEvent.click(screen.getByRole('button', { name: /undo filter/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('CLEAR_FILTER_CALLS_CLEAR_ONLY: clicking Clear Filter calls onClearFilter and nothing else', async () => {
    const onUndoFilter = vi.fn()
    const onClearFilter = vi.fn()
    const onSelectColumn = vi.fn()
    renderPicker({
      viewFilterConfig: ACTIVE_CONFIG,
      canUndoFilter: true,
      onUndoFilter,
      onClearFilter,
      onSelectColumn,
    })
    await userEvent.click(screen.getByRole('button', { name: /clear filter/i }))
    expect(onClearFilter).toHaveBeenCalledOnce()
    expect(onUndoFilter).not.toHaveBeenCalled()
    expect(onSelectColumn).not.toHaveBeenCalled()
  })
})
