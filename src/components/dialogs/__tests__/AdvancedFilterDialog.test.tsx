import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdvancedFilterDialog } from '../AdvancedFilterDialog'
import type { ColumnMetadata } from '@/store/data-store'

const columns: ColumnMetadata[] = [
  { id: 'trait', name: 'Trait', type: 'categorical' },
]

const traitFilter = {
  groups: [
    {
      op: 'AND' as const,
      conditions: [
        { columnId: 'trait', operator: 'eq' as const, value: 'Temp_30', caseSensitive: false },
      ],
    },
  ],
  groupOperator: 'AND' as const,
}

describe('AdvancedFilterDialog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads Quick values from the full-column provider instead of the row sample', async () => {
    const getColumnUniqueValues = vi.fn(async () => ['Temp_30', 'Temp_60', 'Tail.Flick.Latency(ms)'])

    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Temp_30' }, { trait: 'Temp_30' }]}
        totalRowCount={500}
        initialConfig={traitFilter}
        onApply={vi.fn()}
        getColumnUniqueValues={getColumnUniqueValues}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Temp_60' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Tail.Flick.Latency(ms)' })).toBeInTheDocument()
    })
    expect(getColumnUniqueValues).toHaveBeenCalledWith('trait')
  })

  it('shows exact match count from the dataset-backed provider', async () => {
    const getFilterMatchCount = vi.fn(async () => ({ count: 37, totalRows: 500 }))

    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Other' }, { trait: 'Other' }]}
        initialConfig={traitFilter}
        onApply={vi.fn()}
        getFilterMatchCount={getFilterMatchCount}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('37 rows match this filter.')).toBeInTheDocument()
    })
    expect(getFilterMatchCount).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Sample preview/)).not.toBeInTheDocument()
  })

  it('finishes loading Quick values after editing a condition while the request is in flight', async () => {
    let resolveValues: (values: unknown[]) => void = () => {}
    const getColumnUniqueValues = vi.fn(
      () => new Promise<unknown[]>((resolve) => { resolveValues = resolve })
    )

    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Temp_30' }, { trait: 'Temp_30' }]}
        totalRowCount={500}
        initialConfig={traitFilter}
        onApply={vi.fn()}
        getColumnUniqueValues={getColumnUniqueValues}
      />
    )

    expect(screen.getByText(/Loading full-column values/)).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('Temp_30'), { target: { value: 'Temp' } })
    resolveValues(['Temp_30', 'Temp_60'])

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Temp_60' })).toBeInTheDocument()
    })
  })

  it('shows no match feedback from the dataset-backed provider', async () => {
    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Temp_30' }, { trait: 'Temp_30' }]}
        initialConfig={traitFilter}
        onApply={vi.fn()}
        getFilterMatchCount={vi.fn(async () => ({ count: 0, totalRows: 500 }))}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('No rows match this filter.')).toBeInTheDocument()
    })
  })

  it('shows counting feedback while the exact match count is in flight', async () => {
    vi.useFakeTimers()
    const getFilterMatchCount = vi.fn(
      () => new Promise<{ count: number; totalRows: number }>(() => {})
    )

    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Temp_30' }]}
        initialConfig={traitFilter}
        onApply={vi.fn()}
        getFilterMatchCount={getFilterMatchCount}
      />
    )

    expect(screen.queryByText('Counting matching rows...')).not.toBeInTheDocument()
    expect(getFilterMatchCount).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByText('Counting matching rows...')).toBeInTheDocument()
    expect(getFilterMatchCount).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does not count rows when the condition is incomplete', async () => {
    vi.useFakeTimers()
    const getFilterMatchCount = vi.fn(async () => ({ count: 37, totalRows: 500 }))

    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Temp_30' }]}
        initialConfig={{
          groups: [
            {
              op: 'AND',
              conditions: [
                { columnId: 'trait', operator: 'eq', value: '', caseSensitive: false },
              ],
            },
          ],
          groupOperator: 'AND',
        }}
        onApply={vi.fn()}
        getFilterMatchCount={getFilterMatchCount}
      />
    )

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(getFilterMatchCount).not.toHaveBeenCalled()
    expect(screen.queryByText('Counting matching rows...')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('does not fall back to sampled Quick chips when full-column values fail to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getColumnUniqueValues = vi.fn(async () => {
      throw new Error('distinct unavailable')
    })

    render(
      <AdvancedFilterDialog
        open
        onOpenChange={vi.fn()}
        columnMetadata={columns}
        data={[{ trait: 'Temp_30' }, { trait: 'Temp_30' }]}
        totalRowCount={500}
        initialConfig={traitFilter}
        onApply={vi.fn()}
        getColumnUniqueValues={getColumnUniqueValues}
      />
    )

    await waitFor(() => {
      expect(screen.getByText(/Full-column quick values are unavailable/)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Temp_30' })).not.toBeInTheDocument()
  })
})
