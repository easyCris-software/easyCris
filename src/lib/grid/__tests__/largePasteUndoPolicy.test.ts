import { describe, expect, it, vi } from 'vitest'
import { executeEdits } from '../editExecutor'
import { createUndoGridTransaction } from '../gridMutationCoordinator'
import {
  LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD,
  applyLargePasteUndoPolicy,
} from '../largePasteUndoPolicy'
import type { GridTransactionRecord } from '../types'
import { createMockDependencies, createTestConfig } from './testUtils'

function makePasteTransaction(editCount: number): GridTransactionRecord {
  return {
    id: 'paste-1',
    datasetId: 'ds-1',
    kind: 'paste',
    edits: Array.from({ length: editCount }, (_, row) => ({
      row,
      columnId: 'col-1',
      oldValue: `old-${row}`,
      newValue: `new-${row}`,
    })),
  }
}

describe('large paste undo policy', () => {
  it('keeps exact undo for paste batches at the threshold', () => {
    const transaction = makePasteTransaction(LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD)

    const prepared = applyLargePasteUndoPolicy(transaction)
    const undo = createUndoGridTransaction(prepared)

    expect(prepared).toBe(transaction)
    expect(undo.edits?.[0]?.newValue).toBe('old-0')
  })

  it('turns huge paste undo into a range clear instead of exact old-value restore', () => {
    const transaction = makePasteTransaction(LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD + 1)

    const prepared = applyLargePasteUndoPolicy(transaction)
    const undo = createUndoGridTransaction(prepared)

    expect(prepared).not.toBe(transaction)
    expect(prepared.largePasteUndoPolicy).toEqual({
      kind: 'clear-range',
      editCount: LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD + 1,
    })
    expect(undo.edits).toHaveLength(LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD + 1)
    expect(undo.edits?.[0]).toMatchObject({
      row: 0,
      columnId: 'col-1',
      oldValue: 'new-0',
      newValue: '',
    })
    expect(undo.edits?.at(-1)).toMatchObject({
      row: LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD,
      columnId: 'col-1',
      oldValue: `new-${LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD}`,
      newValue: '',
    })
  })

  it('does not change non-paste transactions', () => {
    const transaction: GridTransactionRecord = {
      ...makePasteTransaction(LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD + 1),
      kind: 'delete',
    }

    expect(applyLargePasteUndoPolicy(transaction)).toBe(transaction)
  })

  it('sends blank values to backend when undoing a huge paste clear-range transaction', async () => {
    const transaction = makePasteTransaction(LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD + 1)
    const undo = createUndoGridTransaction(applyLargePasteUndoPolicy(transaction))
    const enqueueGridMutationBatch = vi.fn().mockResolvedValue({
      accepted: true as const,
      queueId: 'undo-clear-range',
    })
    const deps = createMockDependencies({
      cacheService: {
        enqueueGridMutationBatch,
      },
    })

    await executeEdits(
      createTestConfig(),
      {
        edits: undo.edits ?? [],
        source: 'undo',
        timestamp: Date.now(),
      },
      deps
    )

    expect(enqueueGridMutationBatch).toHaveBeenCalledTimes(1)
    const [, updates] = enqueueGridMutationBatch.mock.calls[0] ?? []
    expect(updates?.[0]).toEqual({ row: 0, column: 'col-1', value: '' })
    expect(updates?.at(-1)).toEqual({
      row: LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD,
      column: 'col-1',
      value: '',
    })
  })
})
