import type { DESeqModel } from '@/types/rnaseq'

export interface AppOperationLockAdapter {
  acquire: (params: {
    owner: string
    operation: string
    stage?: string
    progress?: number
  }) => string | null
  update: (
    token: string,
    updates: {
      stage?: string
      progress?: number
      operation?: string
    }
  ) => void
  release: (token: string) => boolean
}

export interface RunModelWithLockContext {
  lockToken: string
  batchIndex: number
  batchTotal: number
}

export interface BatchRunProgressError extends Error {
  completedRuns?: number
  totalRuns?: number
}

export async function runAnalysisBatchWithLock(params: {
  models: DESeqModel[]
  lockAdapter: AppOperationLockAdapter
  runModel: (model: DESeqModel, context: RunModelWithLockContext) => Promise<void>
}): Promise<void> {
  const { models, lockAdapter, runModel } = params
  if (models.length === 0) return

  const token = lockAdapter.acquire({
    owner: 'rnaseq',
    operation: 'rnaseq_batch',
    stage: models.length > 1 ? `Running model 1 of ${models.length}` : 'Running RNA-seq analysis',
    progress: 0,
  })

  if (!token) {
    throw new Error('Another operation is already running. Please wait for it to complete.')
  }

  let completedRuns = 0
  try {
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index]
      if (!model) continue
      lockAdapter.update(token, {
        progress: Math.round((index / models.length) * 100),
        stage: models.length > 1 ? `Running model ${index + 1} of ${models.length}` : 'Running RNA-seq analysis',
      })
      await runModel(model, {
        lockToken: token,
        batchIndex: index + 1,
        batchTotal: models.length,
      })
      completedRuns += 1
    }

    lockAdapter.update(token, {
      progress: 100,
      stage: models.length > 1 ? `Completed ${models.length} of ${models.length} models` : 'RNA-seq analysis complete',
    })
  } catch (error) {
    const enriched = (error instanceof Error ? error : new Error(String(error))) as BatchRunProgressError
    enriched.completedRuns = completedRuns
    enriched.totalRuns = models.length
    throw enriched
  } finally {
    lockAdapter.release(token)
  }
}
