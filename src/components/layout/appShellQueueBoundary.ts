import type { GridMutationQueueState } from '@/lib/grid/types'

export interface DatasetQueueActionBlock {
  blocked: boolean
  description?: string
}

export function getDatasetQueueActionBlock(
  queueState: GridMutationQueueState | null | undefined
): DatasetQueueActionBlock {
  if (!queueState || queueState.status === 'idle') {
    return { blocked: false }
  }

  if (queueState.status === 'draining') {
    return {
      blocked: true,
      description: 'Wait for queued edits to finish syncing before continuing.',
    }
  }

  return {
    blocked: true,
    description: queueState.error ?? 'Retry or reload the dataset before continuing.',
  }
}
