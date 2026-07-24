import { describe, expect, it, vi } from 'vitest'
import { executeEdits } from '../editExecutor'
import { createMockDependencies, createTestConfig } from './testUtils'

describe('executeEdits persist queue boundary', () => {
  it('enqueues batch mutations through the fast acceptance path and not direct batch writes', async () => {
    const config = createTestConfig()
    const deps = createMockDependencies() as any
    deps.cacheService.enqueueGridMutationBatch = vi.fn().mockResolvedValue({
      accepted: true,
      queueId: 'queue-1',
    })
    deps.cacheService.scheduleOverlayFlush = vi.fn()

    await executeEdits(
      config,
      {
        edits: [
          { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
          { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
        ],
        source: 'paste',
        timestamp: Date.now(),
      },
      deps
    )

    expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledWith('test-dataset', [
      { row: 0, column: 'col-a', value: 'b1' },
      { row: 1, column: 'col-b', value: 'b2' },
    ])
    expect(deps.cacheService.updateCellsBatch).not.toHaveBeenCalled()
  })

  it('schedules overlay flush in the background after batch enqueue acceptance', async () => {
    const config = createTestConfig()
    const deps = createMockDependencies() as any
    deps.cacheService.enqueueGridMutationBatch = vi.fn().mockResolvedValue({
      accepted: true,
      queueId: 'queue-2',
    })
    deps.cacheService.scheduleOverlayFlush = vi.fn()

    await executeEdits(
      config,
      {
        edits: [
          { row: 10, columnId: 'col-a', oldValue: 'old-1', newValue: 'new-1' },
          { row: 11, columnId: 'col-a', oldValue: 'old-2', newValue: 'new-2' },
        ],
        source: 'paste',
        timestamp: Date.now(),
      },
      deps
    )

    expect(deps.cacheService.scheduleOverlayFlush).toHaveBeenCalledWith('test-dataset')
  })
})
