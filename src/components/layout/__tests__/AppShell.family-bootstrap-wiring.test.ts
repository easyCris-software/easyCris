import { describe, expect, it, vi } from 'vitest'
import {
  applyAdoptExistingBootstrap,
  decideFamilyBootstrap,
} from '@/components/layout/familyBootstrapResolver'

describe('AppShell family bootstrap wiring', () => {
  it('adopt-existing decision wires setActiveFamilyDataset + setCurrentDataset', () => {
    const decision = decideFamilyBootstrap({
      familyDatasetId: null,
      e2eEnabled: false,
      currentDataset: { id: 'ds-current', familyId: null, dataRowCount: 0, rowCount: 100 },
      fallbackDataset: { id: 'ds-fallback', familyId: null, dataRowCount: 12, rowCount: 100 },
      rnaseqDatasetIds: new Set<string>(),
    })

    expect(decision).toEqual({ action: 'adopt-existing', datasetId: 'ds-current', hasData: false })

    const setActiveFamilyDataset = vi.fn()
    const setCurrentDataset = vi.fn()
    const datasetsById = new Map([
      ['ds-current', { id: 'ds-current', familyId: null, dataRowCount: 0, rowCount: 100 }],
    ])

    if (decision.action === 'adopt-existing') {
      applyAdoptExistingBootstrap({
        familyId: 'statistics-1',
        decision,
        datasetsById,
        currentDatasetId: null,
        setActiveFamilyDataset,
        setCurrentDataset,
      })
    }

    expect(setActiveFamilyDataset).toHaveBeenCalledWith('statistics-1', 'ds-current', false)
    expect(setCurrentDataset).toHaveBeenCalledWith({
      id: 'ds-current',
      familyId: null,
      dataRowCount: 0,
      rowCount: 100,
    })
  })
})
