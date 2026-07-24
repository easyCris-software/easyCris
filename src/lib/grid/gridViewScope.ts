import type { FilterConfig } from '@/services/dataTransformService'

export type GridViewScopeSource = 'full-dataset' | 'view-filter'

export interface GridViewScope {
  datasetId: string
  source: GridViewScopeSource
  viewFilterConfig: FilterConfig | null
  displayRowOrder: number[] | null
  dataModelRows: number[] | null
  displayRowCount: number
  dataRowCount: number
  totalDataRowCount: number
}

export function createFullDatasetScope(datasetId: string, totalDataRowCount: number): GridViewScope {
  return {
    datasetId,
    source: 'full-dataset',
    viewFilterConfig: null,
    displayRowOrder: null,
    dataModelRows: null,
    displayRowCount: totalDataRowCount,
    dataRowCount: totalDataRowCount,
    totalDataRowCount,
  }
}
