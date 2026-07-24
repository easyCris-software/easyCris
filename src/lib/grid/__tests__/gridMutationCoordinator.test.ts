import { describe, expect, it, vi } from 'vitest'
import {
  createGridMutationCoordinator,
  resolveGridBlockLoadState,
  shouldQueueGridBlockLoad,
} from '../gridMutationCoordinator'
import type { GridBlockState, GridMutationCoordinatorDeps, GridMutationKind } from '../types'

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('gridMutationCoordinator', () => {
  it('queues block loads only for missing or dirty blocks', () => {
    expect(shouldQueueGridBlockLoad(undefined)).toBe(true)
    expect(shouldQueueGridBlockLoad('dirty')).toBe(true)
    expect(shouldQueueGridBlockLoad('loaded')).toBe(false)
    expect(shouldQueueGridBlockLoad('reloading')).toBe(false)
  })

  it('resolves block load states without leaving stale reloading entries behind', () => {
    expect(resolveGridBlockLoadState('reloading', 'loaded')).toBe<GridBlockState>('loaded')
    expect(resolveGridBlockLoadState('reloading', 'retry')).toBe<GridBlockState>('dirty')
    expect(resolveGridBlockLoadState('reloading', 'evict')).toBeUndefined()
    expect(resolveGridBlockLoadState('dirty', 'loaded')).toBe<GridBlockState>('dirty')
  })

  it('serializes mutations per dataset', async () => {
    const steps: string[] = []
    const firstApply = createDeferred<void>()

    const coordinator = createGridMutationCoordinator({
      onLifecycle: ({ stage, transaction }) => {
        steps.push(`${transaction.datasetId}:${transaction.id}:${stage}`)
      },
      plan: async (input) => ({ id: input.id, datasetId: input.datasetId, kind: input.kind }),
      applyLocal: async (transaction) => {
        steps.push(`apply:${transaction.id}`)
        if (transaction.id === 'first') {
          await firstApply.promise
        }
      },
      enqueuePersist: async (transaction) => {
        steps.push(`persist:${transaction.id}`)
      },
      finalizeUI: async (transaction) => {
        steps.push(`finalize:${transaction.id}`)
      },
    })

    const first = coordinator.applyGridMutation({
      id: 'first',
      datasetId: 'dataset-1',
      kind: 'paste',
    })
    const second = coordinator.applyGridMutation({
      id: 'second',
      datasetId: 'dataset-1',
      kind: 'delete',
    })

    await Promise.resolve()
    expect(steps).toContain('apply:first')
    expect(steps).not.toContain('apply:second')

    firstApply.resolve()
    await first
    await second

    expect(steps.indexOf('apply:first')).toBeLessThan(steps.indexOf('apply:second'))
    expect(steps.indexOf('persist:first')).toBeLessThan(steps.indexOf('persist:second'))
  })

  it('allows independent datasets to mutate without sharing locks', async () => {
    const started = vi.fn()
    const firstApply = createDeferred<void>()
    const secondApply = createDeferred<void>()

    const coordinator = createGridMutationCoordinator({
      plan: async (input) => ({ id: input.id, datasetId: input.datasetId, kind: input.kind }),
      applyLocal: async (transaction) => {
        started(transaction.datasetId)
        if (transaction.datasetId === 'dataset-1') {
          await firstApply.promise
        }
        if (transaction.datasetId === 'dataset-2') {
          await secondApply.promise
        }
      },
      enqueuePersist: async () => {},
      finalizeUI: async () => {},
    })

    const first = coordinator.applyGridMutation({
      id: 'first',
      datasetId: 'dataset-1',
      kind: 'paste',
    })
    const second = coordinator.applyGridMutation({
      id: 'second',
      datasetId: 'dataset-2',
      kind: 'paste',
    })

    await Promise.resolve()
    expect(started).toHaveBeenCalledWith('dataset-1')
    expect(started).toHaveBeenCalledWith('dataset-2')

    firstApply.resolve()
    secondApply.resolve()
    await Promise.all([first, second])
  })

  it('emits lifecycle events in the expected order', async () => {
    const events: string[] = []
    const coordinator = createGridMutationCoordinator({
      onLifecycle: ({ stage }) => {
        events.push(stage)
      },
      plan: async (input) => ({ id: input.id, datasetId: input.datasetId, kind: input.kind }),
      applyLocal: async () => {},
      enqueuePersist: async () => {},
      finalizeUI: async () => {},
    })

    await coordinator.applyGridMutation({
      id: 'txn-1',
      datasetId: 'dataset-1',
      kind: 'paste',
    })

    expect(events).toEqual([
      'start',
      'plan',
      'applyLocal',
      'enqueuePersist',
      'finalizeUI',
      'persisted',
    ])
  })

  it('is created per SpreadsheetView instance instead of as a global singleton', async () => {
    const firstEvents: string[] = []
    const secondEvents: string[] = []

    const createDeps = (sink: string[]): GridMutationCoordinatorDeps => ({
      onLifecycle: ({ stage }) => sink.push(stage),
      plan: async (input: { id: string; datasetId: string; kind: GridMutationKind }) => ({
        id: input.id,
        datasetId: input.datasetId,
        kind: input.kind,
      }),
      applyLocal: async () => {},
      enqueuePersist: async () => {},
      finalizeUI: async () => {},
    })

    const firstCoordinator = createGridMutationCoordinator(createDeps(firstEvents))
    void createGridMutationCoordinator(createDeps(secondEvents))

    await firstCoordinator.applyGridMutation({
      id: 'first-view',
      datasetId: 'dataset-1',
      kind: 'paste',
    })

    expect(firstEvents.length).toBeGreaterThan(0)
    expect(secondEvents).toEqual([])
  })
})
