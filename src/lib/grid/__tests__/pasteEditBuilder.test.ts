import { describe, expect, it, vi } from 'vitest'
import { buildPasteEditsInChunks } from '../pasteEditBuilder'

describe('buildPasteEditsInChunks', () => {
  it('builds paste edits in row chunks and yields between chunks', async () => {
    const yieldToMain = vi.fn(async () => {})

    const result = await buildPasteEditsInChunks({
      startCol: 0,
      startViewRow: 10,
      parsedData: [
        ['a1', 'b1'],
        ['a2', 'b2'],
        ['a3', 'b3'],
      ],
      columns: [{ id: 'col-a' }, { id: 'col-b' }],
      viewToModel: (viewRow) => viewRow + 100,
      getOldValue: (row, columnId) => `${row}:${columnId}:old`,
      coerceValue: (value, columnId, row) => `${row}:${columnId}:${value}`,
      chunkRows: 2,
      yieldToMain,
    })

    expect(result.aborted).toBe(false)
    expect(yieldToMain).toHaveBeenCalledTimes(1)
    expect(result.edits).toEqual([
      { row: 110, columnId: 'col-a', oldValue: '110:col-a:old', newValue: '110:col-a:a1' },
      { row: 110, columnId: 'col-b', oldValue: '110:col-b:old', newValue: '110:col-b:b1' },
      { row: 111, columnId: 'col-a', oldValue: '111:col-a:old', newValue: '111:col-a:a2' },
      { row: 111, columnId: 'col-b', oldValue: '111:col-b:old', newValue: '111:col-b:b2' },
      { row: 112, columnId: 'col-a', oldValue: '112:col-a:old', newValue: '112:col-a:a3' },
      { row: 112, columnId: 'col-b', oldValue: '112:col-b:old', newValue: '112:col-b:b3' },
    ])
  })

  it('checks cancellation before each chunk and returns partial edits as aborted', async () => {
    let checks = 0

    const result = await buildPasteEditsInChunks({
      startCol: 0,
      startViewRow: 0,
      parsedData: [['a1'], ['a2'], ['a3']],
      columns: [{ id: 'col-a' }],
      viewToModel: (viewRow) => viewRow,
      getOldValue: () => '',
      chunkRows: 1,
      yieldToMain: async () => {},
      shouldContinue: () => {
        checks += 1
        return checks < 3
      },
    })

    expect(result.aborted).toBe(true)
    expect(result.edits).toEqual([
      { row: 0, columnId: 'col-a', oldValue: '', newValue: 'a1' },
      { row: 1, columnId: 'col-a', oldValue: '', newValue: 'a2' },
    ])
  })

  it('skips rows outside the cap and non-writable columns', async () => {
    const result = await buildPasteEditsInChunks({
      startCol: 0,
      startViewRow: 0,
      parsedData: [
        ['a1', 'b1'],
        ['a2', 'b2'],
      ],
      columns: [{ id: 'col-a' }, { id: 'add-column' }],
      viewToModel: (viewRow) => viewRow,
      getOldValue: () => '',
      isWritableColumn: (columnId) => columnId !== 'add-column',
      effectiveRowCap: 1,
      chunkRows: 10,
    })

    expect(result.aborted).toBe(false)
    expect(result.edits).toEqual([
      { row: 0, columnId: 'col-a', oldValue: '', newValue: 'a1' },
    ])
  })
})
