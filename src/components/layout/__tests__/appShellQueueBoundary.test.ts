import { describe, expect, it } from 'vitest'
import { getDatasetQueueActionBlock } from '../appShellQueueBoundary'

describe('AppShell queue boundary helper', () => {
  it('does not block when queue is idle', () => {
    expect(
      getDatasetQueueActionBlock({
        status: 'idle',
        failedQueueId: null,
        error: null,
      })
    ).toEqual({ blocked: false })
  })

  it('blocks destructive actions while queue is draining', () => {
    expect(
      getDatasetQueueActionBlock({
        status: 'draining',
        failedQueueId: null,
        error: null,
      })
    ).toEqual({
      blocked: true,
      description: 'Wait for queued edits to finish syncing before continuing.',
    })
  })

  it('blocks destructive actions while queue is failed', () => {
    expect(
      getDatasetQueueActionBlock({
        status: 'failed',
        failedQueueId: 'dataset-1:queue:1',
        error: 'Persist drain failed',
      })
    ).toEqual({
      blocked: true,
      description: 'Persist drain failed',
    })
  })
})
