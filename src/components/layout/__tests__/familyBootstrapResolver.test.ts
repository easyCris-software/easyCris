import { describe, expect, it, vi } from 'vitest'
import {
  applyAdoptExistingBootstrap,
  decideFamilyBootstrap,
} from '@/components/layout/familyBootstrapResolver'

describe('decideFamilyBootstrap', () => {
  it('creates a new dataset when family has no dataset and no adoptable candidate exists', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: null,
      fallbackDataset: null,
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'create-new' })
  })

  it('adopts an unowned current dataset when family has no dataset', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: { id: 'blank-1', familyId: undefined, dataRowCount: 12, rowCount: 100 },
      fallbackDataset: null,
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'adopt-existing', datasetId: 'blank-1', hasData: true })
  })

  it('adopts an unowned fallback dataset even when currentDataset is null (startup stale-fallback case)', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: null,
      fallbackDataset: { id: 'blank-2', familyId: null, dataRowCount: 0, rowCount: 100 },
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'adopt-existing', datasetId: 'blank-2', hasData: false })
  })

  it('prefers currentDataset when both current and fallback are adoptable', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: { id: 'blank-current', familyId: null, dataRowCount: 5, rowCount: 100 },
      fallbackDataset: { id: 'blank-fallback', familyId: null, dataRowCount: 10, rowCount: 100 },
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'adopt-existing', datasetId: 'blank-current', hasData: true })
  })

  it('treats currentDataset familyId:null as adoptable', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: { id: 'blank-null-family', familyId: null, dataRowCount: 1, rowCount: 100 },
      fallbackDataset: null,
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({
      action: 'adopt-existing',
      datasetId: 'blank-null-family',
      hasData: true,
    })
  })

  it('does not adopt currentDataset when it is owned by a different family', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: { id: 'owned-by-other', familyId: 'statistics-2', dataRowCount: 4, rowCount: 100 },
      fallbackDataset: null,
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'create-new' })
  })

  it('does not adopt fallbackDataset when it is owned by a different family', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: null,
      fallbackDataset: { id: 'owned-fallback', familyId: 'statistics-2', dataRowCount: 4, rowCount: 100 },
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'create-new' })
  })

  it('does not adopt RNA-seq datasets', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: { id: 'rna-1', familyId: undefined },
      fallbackDataset: null,
      rnaseqDatasetIds: new Set<string>(['rna-1']),
    })
    expect(decision).toEqual({ action: 'create-new' })
  })

  it('returns none in e2e mode', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: true,
      currentDataset: null,
      fallbackDataset: null,
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'none' })
  })

  it('returns none when called with an already-bound family datasetId', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: 'existing-ds',
      e2eEnabled: false,
      currentDataset: { id: 'blank-current', familyId: null, dataRowCount: 5, rowCount: 100 },
      fallbackDataset: { id: 'blank-fallback', familyId: null, dataRowCount: 10, rowCount: 100 },
      rnaseqDatasetIds: new Set<string>(),
    })
    expect(decision).toEqual({ action: 'none' })
  })

  it('applyAdoptExistingBootstrap wires adopt branch through setActiveFamilyDataset', () => {
    const setActiveFamilyDataset = vi.fn()
    const setCurrentDataset = vi.fn()
    const datasetsById = new Map([
      ['blank-1', { id: 'blank-1', familyId: null, dataRowCount: 0, rowCount: 100 }],
    ])

    applyAdoptExistingBootstrap({
      familyId: 'statistics-1',
      decision: { action: 'adopt-existing', datasetId: 'blank-1', hasData: false },
      datasetsById,
      currentDatasetId: null,
      setActiveFamilyDataset,
      setCurrentDataset,
    })

    expect(setActiveFamilyDataset).toHaveBeenCalledWith('statistics-1', 'blank-1', false)
    expect(setCurrentDataset).toHaveBeenCalledWith({ id: 'blank-1', familyId: null, dataRowCount: 0, rowCount: 100 })
  })

  it('applyAdoptExistingBootstrap no-ops when target dataset is missing from datasetsById', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setActiveFamilyDataset = vi.fn()
    const setCurrentDataset = vi.fn()

    applyAdoptExistingBootstrap({
      familyId: 'statistics-1',
      decision: { action: 'adopt-existing', datasetId: 'ghost-ds', hasData: false },
      datasetsById: new Map(),
      currentDatasetId: null,
      setActiveFamilyDataset,
      setCurrentDataset,
    })

    expect(warnSpy).toHaveBeenCalledOnce()
    expect(setActiveFamilyDataset).not.toHaveBeenCalled()
    expect(setCurrentDataset).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
