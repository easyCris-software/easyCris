import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import cacheService from '@/services/cacheService'
import { FORMULA_PENDING_SENTINEL } from '@/utils/formulaSentinel'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('cacheService formula sentinel filtering', () => {
  const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockInvoke.mockClear()
  })

  afterEach(async () => {
    await cacheService.flushPendingUpdates()
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
})
