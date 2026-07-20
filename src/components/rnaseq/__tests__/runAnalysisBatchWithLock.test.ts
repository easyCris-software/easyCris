import { describe, expect, it, vi } from 'vitest'
import type { DESeqModel } from '@/types/rnaseq'
import { runAnalysisBatchWithLock } from '../runAnalysisBatchWithLock'

const makeModel = (id: string): DESeqModel => ({
  id,
  name: `Model ${id}`,
  designFormula: '~ condition',
  mainFactor: 'condition',
  mainFactorReference: 'control',
  mainFactorTest: 'treated',
  additionalFactors: [],
  interactionFactor: undefined,
  interactionFactorReference: undefined,
  interactionFactorTest: undefined,
  interactionFactor2: undefined,
  interactionFactor2Reference: undefined,
  interactionFactor2Test: undefined,
  contrastType: 'main',
  useNullModel: false,
  applyShrinkage: true,
  shrinkageMethod: 'apeglm',
  organism: 'mmusculus',
  geneIdType: 'ensembl',
  geneLabelSource: 'id_lookup',
  alpha: 0.05,
  minCount: 10,
  minSamples: 3,
  pcaTopGenes: 500,
  pcaGeneSelectionMode: 'significant_only',
  usePadjForSignificance: true,
  covariates: [],
})

describe('runAnalysisBatchWithLock', () => {
  it('holds a single lock token across the full model batch', async () => {
    const models = [makeModel('a'), makeModel('b'), makeModel('c')]
    const token = 'lock-token-1'
    const acquire = vi.fn(() => token)
    const release = vi.fn(() => true)
    const update = vi.fn()
    const runModel = vi.fn(async () => Promise.resolve())

    await runAnalysisBatchWithLock({
      models,
      lockAdapter: { acquire, release, update },
      runModel,
    })

    expect(acquire).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(token)
    expect(runModel).toHaveBeenCalledTimes(3)
    expect(runModel).toHaveBeenNthCalledWith(
      1,
      models[0],
      expect.objectContaining({ lockToken: token, batchIndex: 1, batchTotal: 3 })
    )
    expect(runModel).toHaveBeenNthCalledWith(
      2,
      models[1],
      expect.objectContaining({ lockToken: token, batchIndex: 2, batchTotal: 3 })
    )
    expect(runModel).toHaveBeenNthCalledWith(
      3,
      models[2],
      expect.objectContaining({ lockToken: token, batchIndex: 3, batchTotal: 3 })
    )
  })

  it('throws when acquire fails because another lock is active', async () => {
    const models = [makeModel('a')]
    const acquire = vi.fn(() => null)
    const release = vi.fn(() => true)
    const update = vi.fn()
    const runModel = vi.fn(async () => Promise.resolve())

    await expect(
      runAnalysisBatchWithLock({
        models,
        lockAdapter: { acquire, release, update },
        runModel,
      })
    ).rejects.toThrow('Another operation is already running')

    expect(runModel).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('surfaces completedRuns when a later model fails', async () => {
    const models = [makeModel('a'), makeModel('b'), makeModel('c')]
    const token = 'lock-token-2'
    const acquire = vi.fn(() => token)
    const release = vi.fn(() => true)
    const update = vi.fn()
    const runModel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('model b failed'))

    try {
      await runAnalysisBatchWithLock({
        models,
        lockAdapter: { acquire, release, update },
        runModel,
      })
      throw new Error('Expected batch failure')
    } catch (error) {
      const e = error as Error & { completedRuns?: number; totalRuns?: number }
      expect(e.message).toContain('model b failed')
      expect(e.completedRuns).toBe(1)
      expect(e.totalRuns).toBe(3)
    }

    expect(release).toHaveBeenCalledWith(token)
  })
})
