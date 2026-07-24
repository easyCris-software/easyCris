import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import cacheService from '@/services/cacheService'
import { FORMULA_PENDING_SENTINEL } from '@/utils/formulaSentinel'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const debugHarness = vi.hoisted(() => ({
  logRuntimeDebug: vi.fn(),
}))

vi.mock('@/lib/debug/runtimeDebug', () => ({
  logRuntimeDebug: debugHarness.logRuntimeDebug,
}))

describe('cacheService formula sentinel filtering', () => {
  const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
  const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolvePromise!: () => void
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve
    })
    return { promise, resolve: resolvePromise }
  }

  beforeEach(() => {
    mockInvoke.mockClear()
    debugHarness.logRuntimeDebug.mockClear()
  })

  afterEach(async () => {
    await cacheService.flushPendingUpdates()
    mockInvoke.mockResolvedValue(undefined)
    await cacheService.clearAll().catch(() => undefined)
    mockInvoke.mockReset()
  })

  it('skips updateCellImmediate for pending sentinel', async () => {
    await cacheService.updateCellImmediate('ds-1', 0, 'col-1', FORMULA_PENDING_SENTINEL)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('skips queued updates for pending sentinel', async () => {
    cacheService.queueCellUpdate('ds-1', 0, 'col-1', FORMULA_PENDING_SENTINEL)
    await cacheService.flushPendingUpdates()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('flushes non-sentinel updates', async () => {
    cacheService.queueCellUpdate('ds-1', 1, 'col-1', 123)
    await cacheService.flushPendingUpdates()

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('update_cells_batch', {
      datasetId: 'ds-1',
      updates: [[1, 'col-1', 123]],
    })
  })

  it('insertRowsAt invokes backend batch row insert command', async () => {
    mockInvoke.mockResolvedValue(42)

    const result = await cacheService.insertRowsAt('ds-1', 10, 5)

    expect(result).toBe(42)
    expect(mockInvoke).toHaveBeenCalledWith('insert_rows_at', {
      datasetId: 'ds-1',
      rowIndex: 10,
      count: 5,
    })
  })

  it('appendRows invokes backend append-only row command', async () => {
    mockInvoke.mockResolvedValue(43)

    const result = await cacheService.appendRows('ds-1', 5)

    expect(result).toBe(43)
    expect(mockInvoke).toHaveBeenCalledWith('append_rows', {
      datasetId: 'ds-1',
      count: 5,
    })
  })

  it('invokes apply_paste_block with explicit rows and matrix values', async () => {
    mockInvoke.mockResolvedValue({
      rowStart: 2,
      rowEndExclusive: 6,
      editedCells: 2,
      oldValues: [['old-A'], ['old-B']],
    })

    const result = await cacheService.applyPasteBlock('dataset-1', {
      rows: [5, 2],
      columnIds: ['col-1'],
      values: [['A'], ['B']],
    })

    expect(result).toEqual({
      rowStart: 2,
      rowEndExclusive: 6,
      editedCells: 2,
      oldValues: [['old-A'], ['old-B']],
    })
    expect(mockInvoke).toHaveBeenCalledWith('apply_paste_block', {
      datasetId: 'dataset-1',
      payload: {
        rows: [5, 2],
        columnIds: ['col-1'],
        values: [['A'], ['B']],
      },
    })
  })

  it('invokes get_rows_hybrid_columns with explicit column subset', async () => {
    mockInvoke.mockResolvedValue([{ 'col-1': 'B0' }, { 'col-1': 'B1' }])

    const result = await cacheService.getRowsHybridColumns('dataset-1', 0, 2, ['col-1'])

    expect(result).toEqual([{ 'col-1': 'B0' }, { 'col-1': 'B1' }])
    expect(mockInvoke).toHaveBeenCalledWith('get_rows_hybrid_columns', {
      datasetId: 'dataset-1',
      startRow: 0,
      endRow: 2,
      columnIds: ['col-1'],
    })
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith('paste', 'cache_get_rows_hybrid_columns_start', {
      datasetId: 'dataset-1',
      startRow: 0,
      endRow: 2,
      columnIds: ['col-1'],
      requestedRows: 2,
    })
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'cache_get_rows_hybrid_columns_done',
      expect.objectContaining({
        datasetId: 'dataset-1',
        startRow: 0,
        endRow: 2,
        columnIds: ['col-1'],
        requestedRows: 2,
        returnedRows: 2,
        durationMs: expect.any(Number),
      })
    )
  })

  it('logs get_rows_hybrid_columns failures with range and column details', async () => {
    mockInvoke.mockRejectedValue(new Error('column read failed'))

    await expect(cacheService.getRowsHybridColumns('dataset-1', 0, 2, ['col-1'])).rejects.toThrow(
      'column read failed'
    )

    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'cache_get_rows_hybrid_columns_failed',
      expect.objectContaining({
        datasetId: 'dataset-1',
        startRow: 0,
        endRow: 2,
        columnIds: ['col-1'],
        requestedRows: 2,
        durationMs: expect.any(Number),
        error: 'column read failed',
      })
    )
  })

  it('removeRowsFromEnd invokes backend tail row removal command', async () => {
    mockInvoke.mockResolvedValue(41)

    const result = await cacheService.removeRowsFromEnd('ds-1', 2)

    expect(result).toBe(41)
    expect(mockInvoke).toHaveBeenCalledWith('remove_rows_from_end', {
      datasetId: 'ds-1',
      count: 2,
    })
  })

  it('dedupes dataset infrastructure warmup and lets callers join the in-flight work', async () => {
    const warmup = createDeferred()
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'prewarm_dataset_infrastructure') {
        return warmup.promise
      }
      return Promise.resolve(undefined)
    })

    cacheService.triggerDatasetInfrastructureWarmup('warm-ds-1')
    cacheService.triggerDatasetInfrastructureWarmup('warm-ds-1')

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('prewarm_dataset_infrastructure', {
      datasetId: 'warm-ds-1',
    })
    expect(cacheService.getDatasetInfrastructureWarmupStatus('warm-ds-1')).toBe('warming')

    let joined = false
    const joinedPromise = cacheService.joinDatasetInfrastructureWarmup('warm-ds-1').then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)

    warmup.resolve()
    await joinedPromise

    expect(joined).toBe(true)
    expect(cacheService.getDatasetInfrastructureWarmupStatus('warm-ds-1')).toBe('ready')
  })

  it('records warmup failure without rejecting joiners', async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'prewarm_dataset_infrastructure') {
        return Promise.reject(new Error('warmup failed'))
      }
      return Promise.resolve(undefined)
    })

    cacheService.triggerDatasetInfrastructureWarmup('warm-ds-2')
    await expect(cacheService.joinDatasetInfrastructureWarmup('warm-ds-2')).resolves.toBeUndefined()

    expect(cacheService.getDatasetInfrastructureWarmupStatus('warm-ds-2')).toBe('failed')
  })

  it.each([
    {
      label: 'insertRowAt',
      run: () => cacheService.insertRowAt('warm-ds-3', 4),
      expectedCommand: 'insert_row_at',
      expectedArgs: { datasetId: 'warm-ds-3', rowIndex: 4 },
    },
    {
      label: 'insertRowsAt',
      run: () => cacheService.insertRowsAt('warm-ds-3', 4, 2),
      expectedCommand: 'insert_rows_at',
      expectedArgs: { datasetId: 'warm-ds-3', rowIndex: 4, count: 2 },
    },
    {
      label: 'appendRows',
      run: () => cacheService.appendRows('warm-ds-3', 2),
      expectedCommand: 'append_rows',
      expectedArgs: { datasetId: 'warm-ds-3', count: 2 },
    },
    {
      label: 'removeRowsFromEnd',
      run: () => cacheService.removeRowsFromEnd('warm-ds-3', 2),
      expectedCommand: 'remove_rows_from_end',
      expectedArgs: { datasetId: 'warm-ds-3', count: 2 },
    },
    {
      label: 'removeRowAt',
      run: () => cacheService.removeRowAt('warm-ds-3', 4),
      expectedCommand: 'remove_row_at',
      expectedArgs: { datasetId: 'warm-ds-3', rowIndex: 4 },
    },
    {
      label: 'addColumn',
      run: () => cacheService.addColumn('warm-ds-3', 'col-new', ''),
      expectedCommand: 'add_column',
      expectedArgs: { datasetId: 'warm-ds-3', columnId: 'col-new', defaultValue: '' },
    },
    {
      label: 'removeColumn',
      run: () => cacheService.removeColumn('warm-ds-3', 'col-old'),
      expectedCommand: 'remove_column',
      expectedArgs: { datasetId: 'warm-ds-3', columnId: 'col-old' },
    },
  ])('$label joins an in-flight infrastructure warmup before invoking the edit', async ({ run, expectedCommand, expectedArgs }) => {
    const warmup = createDeferred()
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'prewarm_dataset_infrastructure') {
        return warmup.promise
      }
      if (command === expectedCommand) {
        return Promise.resolve(12)
      }
      return Promise.resolve(undefined)
    })

    cacheService.triggerDatasetInfrastructureWarmup('warm-ds-3')
    const editPromise = run()

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('prewarm_dataset_infrastructure', {
      datasetId: 'warm-ds-3',
    })

    warmup.resolve()
    await expect(editPromise).resolves.toBe(12)
    expect(mockInvoke).toHaveBeenLastCalledWith(expectedCommand, expectedArgs)
  })

  it('clearAll clears completed infrastructure warmup statuses', async () => {
    mockInvoke.mockResolvedValue(undefined)

    cacheService.triggerDatasetInfrastructureWarmup('warm-ds-4')
    await cacheService.joinDatasetInfrastructureWarmup('warm-ds-4')
    expect(cacheService.getDatasetInfrastructureWarmupStatus('warm-ds-4')).toBe('ready')

    await cacheService.clearAll()
    expect(cacheService.getDatasetInfrastructureWarmupStatus('warm-ds-4')).toBe('idle')

    mockInvoke.mockClear()
    cacheService.triggerDatasetInfrastructureWarmup('warm-ds-4')
    expect(mockInvoke).toHaveBeenCalledWith('prewarm_dataset_infrastructure', {
      datasetId: 'warm-ds-4',
    })
  })
})
