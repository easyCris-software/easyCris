import { describe, expect, it } from 'vitest'
import {
  canFinalizeGridMutation,
  planCutTransaction,
  planPasteTransaction,
  shouldApplyMutationReadback,
  shouldDedupeGridMutation,
} from '../gridMutationCoordinator'

describe('grid mutation planning', () => {
  it('plans overflow paste as one transaction record with structural inserts and edits', () => {
    const transaction = planPasteTransaction({
      id: 'paste-1',
      datasetId: 'dataset-1',
      kind: 'paste',
      startCol: 0,
      startViewRow: 1,
      parsedData: [['a'], ['b'], ['c']],
      availableDataRows: 2,
      columns: [{ id: 'col-1' }],
      viewToModel: (viewRow) => viewRow,
      getOldValue: (row, columnId) => `old:${row}:${columnId}`,
    })

    expect(transaction.structural).toEqual({
      insertedRows: [{ start: 2, count: 2 }],
    })
    expect(transaction.edits).toEqual([
      { row: 1, columnId: 'col-1', oldValue: 'old:1:col-1', newValue: 'a' },
      { row: 2, columnId: 'col-1', oldValue: 'old:2:col-1', newValue: 'b' },
      { row: 3, columnId: 'col-1', oldValue: 'old:3:col-1', newValue: 'c' },
    ])
  })

  it('plans cut as one transaction record that clears source cells only', () => {
    const transaction = planCutTransaction({
      id: 'cut-1',
      datasetId: 'dataset-1',
      selectedColumnIds: ['col-1', 'col-2'],
      selectedViewRows: [1, 2],
      rowCount: 10,
      viewToModel: (viewRow) => viewRow,
      getOldValue: (row, columnId) => `old:${row}:${columnId}`,
    })

    expect(transaction.kind).toBe('cut')
    expect(transaction.structural).toBeUndefined()
    expect(transaction.edits).toEqual([
      { row: 1, columnId: 'col-1', oldValue: 'old:1:col-1', newValue: '' },
      { row: 1, columnId: 'col-2', oldValue: 'old:1:col-2', newValue: '' },
      { row: 2, columnId: 'col-1', oldValue: 'old:2:col-1', newValue: '' },
      { row: 2, columnId: 'col-2', oldValue: 'old:2:col-2', newValue: '' },
    ])
  })

  it('plans paste-from-cut-context as its own transaction record with destination writes only', () => {
    const transaction = planPasteTransaction({
      id: 'paste-after-cut',
      datasetId: 'dataset-1',
      kind: 'paste',
      startCol: 1,
      startViewRow: 4,
      parsedData: [['moved']],
      availableDataRows: 10,
      columns: [{ id: 'col-1' }, { id: 'col-2' }],
      viewToModel: (viewRow) => viewRow,
      getOldValue: (row, columnId) => `old:${row}:${columnId}`,
      copyContext: {
        source: 'cut',
        sourceDatasetId: 'dataset-1',
      },
    })

    expect(transaction.edits).toEqual([
      { row: 4, columnId: 'col-2', oldValue: 'old:4:col-2', newValue: 'moved' },
    ])
    expect(transaction.structural).toBeUndefined()
    expect(transaction.clipboardContext).toEqual({
      source: 'cut',
      sourceDatasetId: 'dataset-1',
    })
  })

  it('dedupes duplicate paste triggers within the guard window', () => {
    expect(
      shouldDedupeGridMutation({
        datasetId: 'dataset-1',
        kind: 'paste',
        triggerAtMs: 1_000,
        previous: {
          datasetId: 'dataset-1',
          kind: 'paste',
          triggerAtMs: 900,
        },
      })
    ).toBe(true)

    expect(
      shouldDedupeGridMutation({
        datasetId: 'dataset-1',
        kind: 'paste',
        triggerAtMs: 1_200,
        previous: {
          datasetId: 'dataset-1',
          kind: 'paste',
          triggerAtMs: 900,
        },
      })
    ).toBe(false)
  })

  it('aborts stale finalize when the active dataset switches before the queued mutation completes', () => {
    expect(
      canFinalizeGridMutation({
        transactionDatasetId: 'dataset-1',
        activeDatasetId: 'dataset-2',
      })
    ).toBe(false)

    expect(
      canFinalizeGridMutation({
        transactionDatasetId: 'dataset-1',
        activeDatasetId: 'dataset-1',
      })
    ).toBe(true)
  })

  it('discards reload/readback results that were started under an older mutation revision', () => {
    expect(
      shouldApplyMutationReadback({
        datasetId: 'dataset-1',
        activeDatasetId: 'dataset-1',
        startedRevision: 3,
        currentRevision: 4,
      })
    ).toBe(false)

    expect(
      shouldApplyMutationReadback({
        datasetId: 'dataset-1',
        activeDatasetId: 'dataset-1',
        startedRevision: 4,
        currentRevision: 4,
      })
    ).toBe(true)
  })
})
