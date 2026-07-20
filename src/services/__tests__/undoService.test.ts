import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import { undoService } from '../undoService'
import type { GridTransactionRecord } from '@/lib/grid/types'

describe('undoService pending batch registration guard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('waits for pending batch registration before invoking undo', async () => {
    let resolveRegistration!: () => void
    const pendingRegistration = new Promise<void>((resolve) => {
      resolveRegistration = resolve
    })
    undoService.trackPendingBatchRegistration('dataset-1', pendingRegistration)

    invokeMock.mockResolvedValueOnce(null)

    const undoPromise = undoService.undo('dataset-1')
    await Promise.resolve()
    expect(invokeMock).not.toHaveBeenCalled()

    resolveRegistration()
    await undoPromise
    expect(invokeMock).toHaveBeenCalledWith('perform_undo', { datasetId: 'dataset-1' })
  })

  it('waits for all overlapping tracked registrations before invoking undo', async () => {
    let resolveA!: () => void
    let resolveB!: () => void
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve
    })
    const pendingB = new Promise<void>((resolve) => {
      resolveB = resolve
    })
    undoService.trackPendingBatchRegistration('dataset-overlap', pendingA)
    undoService.trackPendingBatchRegistration('dataset-overlap', pendingB)

    invokeMock.mockResolvedValueOnce(null)
    const undoPromise = undoService.undo('dataset-overlap')
    await Promise.resolve()
    expect(invokeMock).not.toHaveBeenCalled()

    resolveB()
    await Promise.resolve()
    expect(invokeMock).not.toHaveBeenCalled()

    resolveA()
    await undoPromise
    expect(invokeMock).toHaveBeenCalledWith('perform_undo', { datasetId: 'dataset-overlap' })
  })

  it('returns null and skips perform_undo when pending registration rejects', async () => {
    let rejectRegistration!: (reason?: unknown) => void
    const pendingRegistration = new Promise<void>((_resolve, reject) => {
      rejectRegistration = reject
    })
    undoService.trackPendingBatchRegistration('dataset-reject', pendingRegistration)

    const resultPromise = undoService.undo('dataset-reject')
    rejectRegistration(new Error('push failed'))
    const result = await resultPromise

    expect(result).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('serializes large batch registrations by enqueue order', async () => {
    let resolveFirst!: (value: unknown) => void
    let firstResolved = false
    let secondInvokedBeforeFirstResolved = false
    const firstBatch = new Promise<unknown>((resolve) => {
      resolveFirst = (value: unknown) => {
        firstResolved = true
        resolve(value)
      }
    })
    invokeMock
      .mockImplementationOnce((command: string) => {
        expect(command).toBe('push_batch_cell_edit')
        return firstBatch
      })
      .mockImplementationOnce((command: string) => {
        expect(command).toBe('push_batch_cell_edit')
        if (!firstResolved) {
          secondInvokedBeforeFirstResolved = true
        }
        return Promise.resolve({
          can_undo: true,
          can_redo: false,
          undo_count: 2,
          redo_count: 0,
        })
      })

    const enqueueA = undoService.enqueueBatchCellEdit('dataset-queue', [
      { row: 0, column: 'col-a', oldValue: '1', newValue: '2' },
    ])
    const enqueueB = undoService.enqueueBatchCellEdit('dataset-queue', [
      { row: 1, column: 'col-a', oldValue: '3', newValue: '4' },
    ])

    resolveFirst({
      can_undo: true,
      can_redo: false,
      undo_count: 1,
      redo_count: 0,
    })

    await Promise.all([enqueueA, enqueueB])
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(secondInvokedBeforeFirstResolved).toBe(false)
  })

  it('clearHistory clears frontend grid transaction stacks for the dataset', async () => {
    const transaction: GridTransactionRecord = {
      id: 'paste-1',
      datasetId: 'dataset-clear',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'x' }],
    }

    await undoService.recordGridTransaction('dataset-clear', transaction)
    invokeMock.mockResolvedValueOnce(undefined)

    await undoService.clearHistory('dataset-clear')

    await expect(undoService.undoGridTransaction('dataset-clear')).resolves.toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('clear_undo_history', { datasetId: 'dataset-clear' })
  })

  it('clearAllHistory clears frontend grid transaction stacks across datasets', async () => {
    const transactionA: GridTransactionRecord = {
      id: 'paste-a',
      datasetId: 'dataset-a',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'a' }],
    }
    const transactionB: GridTransactionRecord = {
      id: 'paste-b',
      datasetId: 'dataset-b',
      kind: 'paste',
      edits: [{ row: 1, columnId: 'col-b', oldValue: '', newValue: 'b' }],
    }

    await undoService.recordGridTransaction('dataset-a', transactionA)
    await undoService.recordGridTransaction('dataset-b', transactionB)
    invokeMock.mockResolvedValueOnce(undefined)

    await undoService.clearAllHistory()

    await expect(undoService.undoGridTransaction('dataset-a')).resolves.toBeNull()
    await expect(undoService.undoGridTransaction('dataset-b')).resolves.toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('clear_all_undo_history')
  })

  it('getState merges frontend grid transaction availability with backend history', async () => {
    const transaction: GridTransactionRecord = {
      id: 'paste-state-1',
      datasetId: 'dataset-state',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'x' }],
    }

    await undoService.recordGridTransaction('dataset-state', transaction)
    invokeMock.mockResolvedValueOnce({
      can_undo: false,
      can_redo: false,
      undo_count: 0,
      redo_count: 0,
    })

    await expect(undoService.getState('dataset-state')).resolves.toEqual({
      can_undo: true,
      can_redo: false,
      undo_count: 1,
      redo_count: 0,
    })
    expect(invokeMock).toHaveBeenCalledWith('get_undo_redo_state', { datasetId: 'dataset-state' })
  })

  it('getState sums frontend and backend undo/redo counts', async () => {
    const transaction: GridTransactionRecord = {
      id: 'paste-state-2',
      datasetId: 'dataset-state-sum',
      kind: 'paste',
      edits: [{ row: 1, columnId: 'col-a', oldValue: '', newValue: 'y' }],
    }

    await undoService.recordGridTransaction('dataset-state-sum', transaction)
    await undoService.undoGridTransaction('dataset-state-sum')
    invokeMock.mockResolvedValueOnce({
      can_undo: true,
      can_redo: false,
      undo_count: 2,
      redo_count: 0,
    })

    await expect(undoService.getState('dataset-state-sum')).resolves.toEqual({
      can_undo: true,
      can_redo: true,
      undo_count: 2,
      redo_count: 1,
    })
  })

  it('preserves compact backend paste metadata when recording grid transactions', async () => {
    const transaction: GridTransactionRecord = {
      id: 'paste-backend-compact',
      datasetId: 'dataset-backend-compact',
      kind: 'paste',
      largePasteUndoPolicy: {
        kind: 'backend-clear-range',
        editCount: 2,
      },
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [10, 11],
        columnIds: ['col-a'],
        values: [['x'], ['y']],
      },
    }

    await undoService.recordGridTransaction('dataset-backend-compact', transaction)

    const undoTransaction = await undoService.prepareUndoGridTransaction?.('dataset-backend-compact')
    expect(undoTransaction?.edits).toBeUndefined()
    expect(undoTransaction?.backendPasteBlock).toEqual({
      kind: 'backend-paste-block',
      rows: [10, 11],
      columnIds: ['col-a'],
      values: [[''], ['']],
    })
  })

  it('prepareUndoGridTransaction reserves the target and commit moves that exact record even after a newer mutation is recorded', async () => {
    const transaction: GridTransactionRecord = {
      id: 'paste-prepare-1',
      datasetId: 'dataset-prepare',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'x' }],
    }

    await undoService.recordGridTransaction('dataset-prepare', transaction)

    await expect(undoService.prepareUndoGridTransaction?.('dataset-prepare')).resolves.toMatchObject({
      kind: 'undo',
      datasetId: 'dataset-prepare',
    })

    await undoService.recordGridTransaction('dataset-prepare', {
      id: 'paste-newer-1',
      datasetId: 'dataset-prepare',
      kind: 'paste',
      edits: [{ row: 1, columnId: 'col-a', oldValue: '', newValue: 'y' }],
    })

    await undoService.commitUndoGridTransaction?.('dataset-prepare')
    invokeMock.mockResolvedValueOnce({
      can_undo: false,
      can_redo: false,
      undo_count: 0,
      redo_count: 0,
    })

    await expect(undoService.getState('dataset-prepare')).resolves.toMatchObject({
      can_undo: true,
      can_redo: true,
      undo_count: 1,
      redo_count: 1,
    })
  })

  it('rollbackUndoGridTransaction restores the reserved record below newer mutations', async () => {
    const original: GridTransactionRecord = {
      id: 'paste-rollback-1',
      datasetId: 'dataset-rollback',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'x' }],
    }

    await undoService.recordGridTransaction('dataset-rollback', original)
    await expect(undoService.prepareUndoGridTransaction?.('dataset-rollback')).resolves.toMatchObject({
      kind: 'undo',
      datasetId: 'dataset-rollback',
    })

    await undoService.recordGridTransaction('dataset-rollback', {
      id: 'paste-newer-rollback-1',
      datasetId: 'dataset-rollback',
      kind: 'paste',
      edits: [{ row: 1, columnId: 'col-a', oldValue: '', newValue: 'y' }],
    })

    await undoService.rollbackUndoGridTransaction?.('dataset-rollback')

    const firstUndo = await undoService.undoGridTransaction('dataset-rollback')
    expect(firstUndo).toMatchObject({
      edits: [expect.objectContaining({ row: 1, columnId: 'col-a', oldValue: 'y', newValue: '' })],
    })

    const secondUndo = await undoService.undoGridTransaction('dataset-rollback')
    expect(secondUndo).toMatchObject({
      edits: [expect.objectContaining({ row: 0, columnId: 'col-a', oldValue: 'x', newValue: '' })],
    })
  })

  it('rollbackRedoGridTransaction drops a reserved redo when a newer mutation invalidates redo during the prepare window', async () => {
    const original: GridTransactionRecord = {
      id: 'paste-redo-rollback-1',
      datasetId: 'dataset-redo-rollback',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'x' }],
    }

    await undoService.recordGridTransaction('dataset-redo-rollback', original)
    await undoService.undoGridTransaction('dataset-redo-rollback')
    await expect(undoService.prepareRedoGridTransaction?.('dataset-redo-rollback')).resolves.toMatchObject({
      kind: 'redo',
      datasetId: 'dataset-redo-rollback',
    })

    await undoService.recordGridTransaction('dataset-redo-rollback', {
      id: 'paste-after-redo-rollback',
      datasetId: 'dataset-redo-rollback',
      kind: 'paste',
      edits: [{ row: 1, columnId: 'col-a', oldValue: '', newValue: 'y' }],
    })

    await undoService.undoGridTransaction('dataset-redo-rollback')
    await undoService.rollbackRedoGridTransaction?.('dataset-redo-rollback')

    const firstRedo = await undoService.redoGridTransaction('dataset-redo-rollback')
    expect(firstRedo).toMatchObject({
      edits: [expect.objectContaining({ row: 1, columnId: 'col-a', oldValue: '', newValue: 'y' })],
    })
  })
})
