import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColumnSelectionDialog } from '../ColumnSelectionDialog'
import { useDataStore, type Dataset } from '@/store/data-store'

const cacheHarness = vi.hoisted(() => ({
  ensureLatestCache: vi.fn(),
  getDatasetStorageInfo: vi.fn(),
  getColumnsData: vi.fn(),
}))

vi.mock('@/store/app-store', async (importActual) => {
  const actual = await importActual<typeof import('@/store/app-store')>()
  return {
    ...actual,
    ensureProjectId: vi.fn(async () => 'project-test'),
  }
})

vi.mock('@/services/cacheService', () => ({
  default: {
    ensureLatestCache: cacheHarness.ensureLatestCache,
    getDatasetStorageInfo: cacheHarness.getDatasetStorageInfo,
    getColumnsData: cacheHarness.getColumnsData,
  },
}))

const dataset: Dataset = {
  id: 'dataset-view-scope',
  name: 'Scoped Dataset',
  rowCount: 5,
  dataRowCount: 5,
  columnCount: 1,
  columns: [{ id: 'group', name: 'Group', type: 'categorical' }],
  importedAt: new Date('2026-04-28T00:00:00Z'),
  modifiedAt: new Date('2026-04-28T00:00:00Z'),
}

describe('ColumnSelectionDialog view scope classification', () => {
  afterEach(() => {
    useDataStore.getState().setCurrentDataset(null)
    vi.clearAllMocks()
  })

  it('classifies columns from filtered view-scope rows instead of the full dataset', async () => {
    useDataStore.getState().setCurrentDataset(dataset)
    useDataStore.getState().setColumnClassification('group', {
      classification: {
        columnId: 'group',
        columnName: 'Group',
        dataType: 'categorical',
        totalValues: 613,
        numericValues: 0,
        categoricalValues: 613,
        missingValues: 0,
        uniqueValueCount: 613,
        uniqueValues: Array.from({ length: 20 }, (_value, index) => `Full-${index}`),
        isBinary: false,
        isOrdinal: false,
        isConstant: false,
        hasMissingData: false,
        numericRatio: 0,
        detectedType: 'categorical',
        effectiveType: 'categorical',
        suggestedTests: [],
      },
    })
    cacheHarness.ensureLatestCache.mockResolvedValue(undefined)
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: false, duckdbPath: null })
    cacheHarness.getColumnsData.mockResolvedValue({
      group: ['A', 'B', 'A', 'A', 'C'],
    })

    render(
      <ColumnSelectionDialog
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        viewScope={{
          datasetId: dataset.id,
          source: 'view-filter',
          viewFilterConfig: { groups: [], groupOperator: 'AND' },
          displayRowOrder: [0, 2, 3],
          dataModelRows: [0, 2, 3],
          displayRowCount: 3,
          dataRowCount: 3,
          totalDataRowCount: 5,
        }}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Group')).toBeInTheDocument()
      expect(screen.getByText('1 unique value')).toBeInTheDocument()
    })
  })
})
