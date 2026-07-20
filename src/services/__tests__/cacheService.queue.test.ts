import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import cacheService from '@/services/cacheService'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('cacheService async mutation queue', () => {
  const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
  const datasetIds = [
    'queue-ds-1',
    'queue-ds-2',
    'queue-ds-3',
    'queue-ds-4',
    'queue-ds-5',
    'queue-ds-6',
    'queue-ds-7',
    'queue-ds-8',
    'queue-ds-9',
  ]

  beforeEach(() => {
    mockInvoke.mockReset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    for (const datasetId of datasetIds) {
      await cacheService.retryGridMutationQueue(datasetId).catch(() => undefined)
    }
    await cacheService.clearAll().catch(() => undefined)
  })

  it('returns enqueue acceptance before backend batch drain resolves', async () => {
    const deferred = createDeferred<number>()
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'update_cells_batch') {
        return deferred.promise
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const accepted = await cacheService.enqueueGridMutationBatch('queue-ds-1', [
      { row: 0, column: 'col-a', value: 'v1' },
    ])

    expect(accepted.accepted).toBe(true)
    expect(accepted.queueId).toMatch(/queue-ds-1/)
    expect(cacheService.getGridMutationQueueState('queue-ds-1')).toEqual({
      status: 'draining',
      failedQueueId: null,
      error: null,
    })

    deferred.resolve(1)
    await cacheService.flushGridMutationQueue('queue-ds-1')
  })

  it('preserves per-dataset drain order', async () => {
    const first = createDeferred<number>()
    const second = createDeferred<number>()
    mockInvoke.mockImplementation((_command: string, payload: { datasetId: string }) => {
      if (payload.datasetId !== 'queue-ds-2') {
        throw new Error(`unexpected dataset: ${payload.datasetId}`)
      }
      return mockInvoke.mock.calls.filter(([, callPayload]) => callPayload?.datasetId === 'queue-ds-2').length === 1
        ? first.promise
        : second.promise
    })

    await cacheService.enqueueGridMutationBatch('queue-ds-2', [
      { row: 0, column: 'col-a', value: 'first' },
    ])
    await cacheService.enqueueGridMutationBatch('queue-ds-2', [
      { row: 1, column: 'col-a', value: 'second' },
    ])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'update_cells_batch', {
      datasetId: 'queue-ds-2',
      updates: [[0, 'col-a', 'first']],
    })

    first.resolve(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'update_cells_batch', {
      datasetId: 'queue-ds-2',
      updates: [[1, 'col-a', 'second']],
    })

    second.resolve(1)
    await cacheService.flushGridMutationQueue('queue-ds-2')
  })

  it('flushGridMutationQueue waits for the active drain to finish', async () => {
    const deferred = createDeferred<number>()
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'update_cells_batch') {
        return deferred.promise
      }
      throw new Error(`unexpected command: ${command}`)
    })

    await cacheService.enqueueGridMutationBatch('queue-ds-3', [
      { row: 3, column: 'col-z', value: 'pending' },
    ])

    let settled = false
    const flushPromise = cacheService.flushGridMutationQueue('queue-ds-3').then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    deferred.resolve(1)
    await flushPromise
    expect(settled).toBe(true)
    expect(cacheService.getGridMutationQueueState('queue-ds-3')).toEqual({
      status: 'idle',
      failedQueueId: null,
      error: null,
    })
  })

  it('marks the dataset queue failed when a drained batch errors after acceptance', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('drain failed'))

    const accepted = await cacheService.enqueueGridMutationBatch('queue-ds-4', [
      { row: 4, column: 'col-f', value: 'fail' },
    ])

    expect(accepted.accepted).toBe(true)

    await expect(cacheService.flushGridMutationQueue('queue-ds-4')).rejects.toThrow('drain failed')
    expect(cacheService.getGridMutationQueueState('queue-ds-4')).toEqual({
      status: 'failed',
      failedQueueId: accepted.queueId,
      error: 'drain failed',
    })
  })

  it('defers overlay flush until the accepted queue drain reaches backend overlay', async () => {
    const drained = createDeferred<number>()
    const commands: string[] = []

    mockInvoke.mockImplementation((command: string) => {
      commands.push(command)
      if (command === 'update_cells_batch') {
        return drained.promise
      }
      if (command === 'flush_overlay') {
        return Promise.resolve(undefined)
      }
      throw new Error(`unexpected command: ${command}`)
    })

    await cacheService.enqueueGridMutationBatch('queue-ds-5', [
      { row: 5, column: 'col-p', value: 'paste' },
    ])
    cacheService.scheduleOverlayFlush('queue-ds-5')

    await Promise.resolve()
    expect(commands).toEqual(['update_cells_batch'])

    drained.resolve(1)
    await cacheService.flushGridMutationQueue('queue-ds-5')
    await Promise.resolve()

    expect(commands).toEqual(['update_cells_batch', 'flush_overlay'])
  })

  it('ensureLatestCache waits for the async mutation queue before flushing overlay-backed reads', async () => {
    const order: string[] = []
    vi.spyOn(cacheService, 'flushPendingUpdates').mockImplementation(async () => {
      order.push('flushPendingUpdates')
    })
    vi.spyOn(cacheService, 'flushGridMutationQueue').mockImplementation(async (datasetId: string) => {
      order.push(`flushGridMutationQueue:${datasetId}`)
    })
    vi.spyOn(cacheService, 'getDatasetStorageInfo').mockImplementation(async (datasetId: string) => {
      order.push(`getDatasetStorageInfo:${datasetId}`)
      return { duckdbPath: 'duck.db' }
    })
    vi.spyOn(cacheService, 'flushOverlay').mockImplementation(async (datasetId: string) => {
      order.push(`flushOverlay:${datasetId}`)
    })

    await cacheService.ensureLatestCache('queue-ds-6')

    expect(order).toEqual([
      'flushPendingUpdates',
      'flushGridMutationQueue:queue-ds-6',
      'getDatasetStorageInfo:queue-ds-6',
      'flushOverlay:queue-ds-6',
    ])
  })

  it('clears queue state after successful dataset removal so reused dataset ids start clean', async () => {
    mockInvoke.mockResolvedValue(1)

    await cacheService.enqueueGridMutationBatch('queue-ds-5', [
      { row: 9, column: 'col-a', value: 'stale' },
    ])
    await cacheService.flushGridMutationQueue('queue-ds-5')

    mockInvoke.mockResolvedValueOnce(true).mockResolvedValue(1)
    await expect(cacheService.removeDataset('queue-ds-5')).resolves.toBe(true)

    expect(cacheService.getGridMutationQueueState('queue-ds-5')).toEqual({
      status: 'idle',
      failedQueueId: null,
      error: null,
    })

    const reused = await cacheService.enqueueGridMutationBatch('queue-ds-5', [
      { row: 10, column: 'col-a', value: 'fresh' },
    ])

    expect(reused.accepted).toBe(true)
  })

  it('removeDataset waits for an active drain to finish before backend removal', async () => {
    const drained = createDeferred<number>()
    const commands: string[] = []

    mockInvoke.mockImplementation((command: string) => {
      commands.push(command)
      if (command === 'update_cells_batch') {
        return drained.promise
      }
      if (command === 'remove_dataset_cache') {
        return Promise.resolve(true)
      }
      throw new Error(`unexpected command: ${command}`)
    })

    await cacheService.enqueueGridMutationBatch('queue-ds-7', [
      { row: 0, column: 'col-a', value: 'pending-remove' },
    ])

    const removePromise = cacheService.removeDataset('queue-ds-7')

    await Promise.resolve()
    expect(commands).toEqual(['update_cells_batch'])

    drained.resolve(1)
    await expect(removePromise).resolves.toBe(true)
    expect(commands).toEqual(['update_cells_batch', 'remove_dataset_cache'])
  })

  it('removeDataset rejects while the queue is failed instead of silently retrying the failed head', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('failed-before-remove'))

    await cacheService.enqueueGridMutationBatch('queue-ds-8', [
      { row: 1, column: 'col-a', value: 'bad' },
    ])

    await expect(cacheService.flushGridMutationQueue('queue-ds-8')).rejects.toThrow('failed-before-remove')
    await expect(cacheService.removeDataset('queue-ds-8')).rejects.toThrow('failed-before-remove')

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('update_cells_batch', {
      datasetId: 'queue-ds-8',
      updates: [[1, 'col-a', 'bad']],
    })
  })

  it('ensureLatestCache surfaces failed queue state instead of implicitly retrying it', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('ensure-failed'))
    vi.spyOn(cacheService, 'flushPendingUpdates').mockResolvedValue(undefined)
    vi.spyOn(cacheService, 'getDatasetStorageInfo').mockResolvedValue({ duckdbPath: 'duck.db' })
    const flushOverlaySpy = vi.spyOn(cacheService, 'flushOverlay').mockResolvedValue(undefined)

    await cacheService.enqueueGridMutationBatch('queue-ds-9', [
      { row: 2, column: 'col-a', value: 'stale-read' },
    ])

    await expect(cacheService.flushGridMutationQueue('queue-ds-9')).rejects.toThrow('ensure-failed')
    await expect(cacheService.ensureLatestCache('queue-ds-9')).rejects.toThrow('ensure-failed')

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(flushOverlaySpy).not.toHaveBeenCalled()
  })

  it('retryGridMutationQueue does not rethrow the old failed drain when the retried write succeeds', async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error('retry-old-failure'))
      .mockResolvedValueOnce(1)

    await cacheService.enqueueGridMutationBatch('queue-ds-3', [
      { row: 7, column: 'col-a', value: 'retry-me' },
    ])

    await expect(cacheService.flushGridMutationQueue('queue-ds-3')).rejects.toThrow('retry-old-failure')
    await expect(cacheService.retryGridMutationQueue('queue-ds-3')).resolves.toBeUndefined()
    expect(cacheService.getGridMutationQueueState('queue-ds-3')).toEqual({
      status: 'idle',
      failedQueueId: null,
      error: null,
    })
  })

  it('clearAll rejects new enqueues while cache clearing is in progress', async () => {
    const clearDeferred = createDeferred<void>()
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'clear_all_cache') {
        return clearDeferred.promise
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const clearPromise = cacheService.clearAll()
    await Promise.resolve()

    await expect(
      cacheService.enqueueGridMutationBatch('queue-ds-10', [
        { row: 0, column: 'col-a', value: 'blocked' },
      ])
    ).rejects.toThrow('closing')

    clearDeferred.resolve()
    await clearPromise
  })

  it('clearAll fails fast on a failed dataset queue before starting the global closing barrier', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('clearall-failed-queue'))

    await cacheService.enqueueGridMutationBatch('queue-ds-11', [
      { row: 0, column: 'col-a', value: 'bad' },
    ])
    await expect(cacheService.flushGridMutationQueue('queue-ds-11')).rejects.toThrow('clearall-failed-queue')

    await expect(cacheService.clearAll()).rejects.toThrow('clearall-failed-queue')
    await expect(
      cacheService.enqueueGridMutationBatch('queue-ds-12', [
        { row: 0, column: 'col-a', value: 'still-open' },
      ])
    ).resolves.toMatchObject({ accepted: true })
    expect(mockInvoke).not.toHaveBeenCalledWith('clear_all_cache')
  })
})
