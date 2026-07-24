import { describe, expect, it, vi } from 'vitest'
import { runSingleChunkPasteJob } from '../pasteJob'

describe('runSingleChunkPasteJob', () => {
  it('acquires, updates, yields, runs, and releases a paste lock', async () => {
    const events: string[] = []
    const lock = {
      acquire: vi.fn(() => {
        events.push('acquire')
        return 'token-1'
      }),
      update: vi.fn((_token: string, updates: { stage?: string; progress?: number; indeterminate?: boolean }) => {
        events.push(`update:${updates.stage}:${updates.progress}:${updates.indeterminate}`)
      }),
      release: vi.fn(() => {
        events.push('release')
        return true
      }),
    }

    const result = await runSingleChunkPasteJob({
      source: 'paste',
      useVisualLock: true,
      lock,
      run: async () => {
        events.push('run')
        return 42
      },
    })

    expect(result).toEqual({ ok: true, value: 42 })
    expect(lock.acquire).toHaveBeenCalledWith({
      owner: 'paste',
      operation: 'Pasting data',
      stage: 'Preparing paste...',
      progress: 0,
    })
    expect(lock.release).toHaveBeenCalledWith('token-1')
    expect(events).toEqual([
      'acquire',
      'update:Preparing paste...:5:undefined',
      'run',
      'release',
    ])
  })

  it('does not run when the paste lock is unavailable', async () => {
    const run = vi.fn()
    const result = await runSingleChunkPasteJob({
      source: 'paste-values',
      useVisualLock: true,
      lock: {
        acquire: vi.fn(() => null),
        update: vi.fn(),
        release: vi.fn(),
      },
      run,
    })

    expect(result).toEqual({ ok: false, reason: 'lock-unavailable' })
    expect(run).not.toHaveBeenCalled()
  })

  it('runs without a visual lock for E2E paste jobs', async () => {
    const result = await runSingleChunkPasteJob({
      source: 'e2e-paste',
      useVisualLock: false,
      run: async () => 'done',
    })

    expect(result).toEqual({ ok: true, value: 'done' })
  })
})
