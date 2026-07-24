import { beforeEach, describe, expect, it, vi } from 'vitest'
import { undoService } from '@/services/undoService'
import type { GridTransactionRecord } from '../types'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

describe('grid mutation transaction undo/redo', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    undoService.clearGridTransactionHistory('dataset-grid-1')
    undoService.clearGridTransactionHistory('dataset-grid-2')
  })

  it('returns a reverse transaction for overflow paste undo, including inserted row removal', async () => {
    const pasteTransaction: GridTransactionRecord = {
      id: 'paste-1',
      datasetId: 'dataset-grid-1',
      kind: 'paste',
      edits: [
        { row: 3, columnId: 'col-a', oldValue: 'before', newValue: 'after' },
        { row: 4, columnId: 'col-a', oldValue: '', newValue: 'A' },
        { row: 5, columnId: 'col-a', oldValue: '', newValue: 'B' },
      ],
      structural: {
        insertedRows: [{ start: 4, count: 2 }],
      },
    }

    await undoService.recordGridTransaction('dataset-grid-1', pasteTransaction)

    const undoTransaction = await undoService.undoGridTransaction('dataset-grid-1')

    expect(undoTransaction).toMatchObject({
      kind: 'undo',
      datasetId: 'dataset-grid-1',
      structural: {
        removedRows: [{ start: 4, count: 2 }],
      },
      edits: [
        { row: 3, columnId: 'col-a', oldValue: 'after', newValue: 'before' },
      ],
    })
  })

  it('keeps cut and subsequent paste as separate undoable transactions', async () => {
    const cutTransaction: GridTransactionRecord = {
      id: 'cut-1',
      datasetId: 'dataset-grid-2',
      kind: 'cut',
      edits: [{ row: 1, columnId: 'col-a', oldValue: 'source', newValue: '' }],
    }
    const pasteTransaction: GridTransactionRecord = {
      id: 'paste-2',
      datasetId: 'dataset-grid-2',
      kind: 'paste',
      edits: [{ row: 1, columnId: 'col-c', oldValue: 'dest', newValue: 'source' }],
      clipboardContext: { source: 'cut', sourceDatasetId: 'dataset-grid-2' },
    }

    await undoService.recordGridTransaction('dataset-grid-2', cutTransaction)
    await undoService.recordGridTransaction('dataset-grid-2', pasteTransaction)

    const firstUndo = await undoService.undoGridTransaction('dataset-grid-2')
    const secondUndo = await undoService.undoGridTransaction('dataset-grid-2')

    expect(firstUndo).toMatchObject({
      kind: 'undo',
      datasetId: 'dataset-grid-2',
      edits: [{ row: 1, columnId: 'col-c', oldValue: 'source', newValue: 'dest' }],
    })
    expect(secondUndo).toMatchObject({
      kind: 'undo',
      datasetId: 'dataset-grid-2',
      edits: [{ row: 1, columnId: 'col-a', oldValue: '', newValue: 'source' }],
    })
  })

  it('replays the original forward transaction on redo after undo', async () => {
    const deleteTransaction: GridTransactionRecord = {
      id: 'delete-1',
      datasetId: 'dataset-grid-1',
      kind: 'delete',
      edits: [{ row: 2, columnId: 'col-b', oldValue: 'keep', newValue: '' }],
    }

    await undoService.recordGridTransaction('dataset-grid-1', deleteTransaction)
    await undoService.undoGridTransaction('dataset-grid-1')

    const redoTransaction = await undoService.redoGridTransaction('dataset-grid-1')

    expect(redoTransaction).toMatchObject({
      kind: 'redo',
      datasetId: 'dataset-grid-1',
      edits: [{ row: 2, columnId: 'col-b', oldValue: 'keep', newValue: '' }],
    })
  })

  it('replays original forward column renames on redo after undo', async () => {
    const headerPasteTransaction: GridTransactionRecord = {
      id: 'paste-header-1',
      datasetId: 'dataset-grid-1',
      kind: 'paste',
      edits: [{ row: 0, columnId: 'col-b', oldValue: 'old', newValue: 'new' }],
      columnRenames: [
        { columnId: 'col-b', oldName: 'Target', newName: 'Source (2)' },
      ],
    }

    await undoService.recordGridTransaction('dataset-grid-1', headerPasteTransaction)

    const undoTransaction = await undoService.undoGridTransaction('dataset-grid-1')
    const redoTransaction = await undoService.redoGridTransaction('dataset-grid-1')

    expect(undoTransaction).toMatchObject({
      kind: 'undo',
      edits: [{ row: 0, columnId: 'col-b', oldValue: 'new', newValue: 'old' }],
      columnRenames: [
        { columnId: 'col-b', oldName: 'Source (2)', newName: 'Target' },
      ],
    })
    expect(redoTransaction).toMatchObject({
      kind: 'redo',
      edits: [{ row: 0, columnId: 'col-b', oldValue: 'old', newValue: 'new' }],
      columnRenames: [
        { columnId: 'col-b', oldName: 'Target', newName: 'Source (2)' },
      ],
    })
  })

  it('uses exact backend paste undo values for backend-routed undo and redo', async () => {
    const backendPasteTransaction: GridTransactionRecord = {
      id: 'paste-backend-1',
      datasetId: 'dataset-grid-1',
      kind: 'paste',
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [1024, 1025],
        columnIds: ['col-5'],
        values: [['31'], ['0']],
        undoValues: [['old-1024'], ['old-1025']],
      },
    }

    await undoService.recordGridTransaction('dataset-grid-1', backendPasteTransaction)

    const undoTransaction = await undoService.undoGridTransaction('dataset-grid-1')
    const redoTransaction = await undoService.redoGridTransaction('dataset-grid-1')
    const secondUndoTransaction = await undoService.undoGridTransaction('dataset-grid-1')

    expect(undoTransaction?.edits).toBeUndefined()
    expect(undoTransaction?.largePasteUndoPolicy).toBeUndefined()
    expect(undoTransaction?.backendPasteBlock).toEqual({
      kind: 'backend-paste-block',
      rows: [1024, 1025],
      columnIds: ['col-5'],
      values: [['old-1024'], ['old-1025']],
      undoValues: [['old-1024'], ['old-1025']],
    })
    expect(redoTransaction?.edits).toBeUndefined()
    expect(redoTransaction?.backendPasteBlock).toEqual({
      kind: 'backend-paste-block',
      rows: [1024, 1025],
      columnIds: ['col-5'],
      values: [['31'], ['0']],
      undoValues: [['old-1024'], ['old-1025']],
    })
    expect(secondUndoTransaction?.edits).toBeUndefined()
    expect(secondUndoTransaction?.largePasteUndoPolicy).toBeUndefined()
    expect(secondUndoTransaction?.backendPasteBlock).toEqual({
      kind: 'backend-paste-block',
      rows: [1024, 1025],
      columnIds: ['col-5'],
      values: [['old-1024'], ['old-1025']],
      undoValues: [['old-1024'], ['old-1025']],
    })
  })
})
