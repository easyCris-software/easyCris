/**
 * FilterColumnPickerPopover.test.tsx
 *
 * TDD tests for the column picker popover (Phase 3).
 * Written RED-first — all tests fail until FilterColumnPickerPopover is implemented.
 *
 * Tests:
 *   PICKER_OPENS              - clicking Filter button opens the column picker popover
 *   PICKER_SHOWS_COLUMNS      - picker lists columns with data only (not empty columns)
 *   PICKER_SELECTS_COLUMN     - clicking a column calls onSelectColumn with colId
 *   PICKER_CLOSES_ON_COLUMN_SELECT - picker closes when a column is selected
 *   PICKER_ACTIVE_INDICATOR   - columns with active view-filter conditions show a badge
 *   PICKER_NO_DATA            - picker shows empty state when no columns have data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { ColumnMetadata } from '@/store/data-store'
import type { FilterConfig } from '@/services/dataTransformService'

import { FilterColumnPickerPopover } from '../FilterColumnPickerPopover'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const columnsWithData: ColumnMetadata[] = [
  { id: 'col-a', name: 'Age', type: 'numeric' },
  { id: 'col-b', name: 'Name', type: 'text' },
  { id: 'col-c', name: 'Score', type: 'numeric' },
]

const defaultProps = {
  columns: columnsWithData,
  viewFilterConfig: null as FilterConfig | null,
  onSelectColumn: vi.fn() as (colId: string, bounds: { x: number; y: number; width: number; height: number }) => void,
}

function setup(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides }
  const result = render(<FilterColumnPickerPopover {...props} />)
  return { ...result, props }
}

async function openPicker() {
  const trigger = screen.getByRole('button', { name: /filter columns/i })
  await userEvent.click(trigger)
  await waitFor(() => screen.getByRole('list', { name: /column list/i }))
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  defaultProps.onSelectColumn = vi.fn()
})

// ---------------------------------------------------------------------------

describe('FilterColumnPickerPopover', () => {
  it('PICKER_OPENS: clicking the trigger button opens the column picker popover', async () => {
    setup()
    expect(screen.queryByRole('list', { name: /column list/i })).not.toBeInTheDocument()
    await openPicker()
    expect(screen.getByRole('list', { name: /column list/i })).toBeInTheDocument()
  })

  it('PICKER_SHOWS_COLUMNS: picker lists only columns passed as props', async () => {
    setup()
    await openPicker()
    expect(screen.getByRole('button', { name: /age/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /name/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /score/i })).toBeInTheDocument()
  })

  it('PICKER_SELECTS_COLUMN: clicking a column calls onSelectColumn with colId and bounds', async () => {
    const onSelectColumn = vi.fn()
    setup({ onSelectColumn })
    await openPicker()

    await userEvent.click(screen.getByRole('button', { name: /age/i }))
    expect(onSelectColumn).toHaveBeenCalledOnce()
    // First arg must be the colId
    expect(onSelectColumn.mock.calls[0]![0]).toBe('col-a')
    // Second arg must be a bounds object
    const bounds = onSelectColumn.mock.calls[0]![1]
    expect(bounds).toMatchObject({ x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) })
  })

  it('PICKER_CLOSES_ON_COLUMN_SELECT: picker closes when a column is selected', async () => {
    setup()
    await openPicker()

    await userEvent.click(screen.getByRole('button', { name: /age/i }))
    // Popover should close
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: /column list/i })).not.toBeInTheDocument()
    })
  })

  it('PICKER_ACTIVE_INDICATOR: columns with active view-filter conditions show data-active', async () => {
    const viewFilterConfig: FilterConfig = {
      groups: [
        { op: 'AND', conditions: [{ columnId: 'col-b', operator: 'ne', value: 'Bob' }] },
      ],
      groupOperator: 'AND',
    }
    setup({ viewFilterConfig })
    await openPicker()

    // col-b (Name) has active filter → data-active="true"
    const nameBtn = screen.getByRole('button', { name: /name/i })
    expect(nameBtn).toHaveAttribute('data-active', 'true')

    // col-a (Age) has no active filter → no data-active
    const ageBtn = screen.getByRole('button', { name: /age/i })
    expect(ageBtn).not.toHaveAttribute('data-active', 'true')
  })

  it('PICKER_NO_DATA: picker shows empty state when no columns are provided', async () => {
    setup({ columns: [] })
    const trigger = screen.getByRole('button', { name: /filter columns/i })
    await userEvent.click(trigger)
    await waitFor(() => screen.getByText(/no columns/i))
    expect(screen.getByText(/no columns/i)).toBeInTheDocument()
  })
})
