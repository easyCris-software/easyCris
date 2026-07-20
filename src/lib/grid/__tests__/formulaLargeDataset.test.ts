import { describe, it, expect, vi } from 'vitest'
import {
  createFormulaService,
  FormulaService,
  type BackendEvaluationContext,
  type AsyncAggregateContext,
} from '../formulas/formulaService'

describe('FormulaService large dataset guards', () => {
  it('returns a clear error when sorted/grouped without rowOrder and rows are missing', () => {
    const rowData = new Map<number, Record<string, unknown>>()
    const columns = [{ id: 'col-a' }]
    const formulaService = createFormulaService(() => rowData, columns)

    const asyncContext: AsyncAggregateContext = {
      isLargeDataset: true,
      isSorted: true,
      isGrouped: false,
      getRowData: () => rowData,
      enqueueAggregate: vi.fn(),
    }

    const backendContext: BackendEvaluationContext = {
      isLargeDataset: true,
      isSorted: true,
      isGrouped: false,
      totalRows: 100,
      loadedRowRange: { start: 0, end: 10 },
      columnLookup: {
        indexToId: (index: number) => (index === 0 ? 'col-a' : `col-${index}`),
        idToIndex: (columnId: string) => (columnId === 'col-a' ? 0 : -1),
      },
      rowOrder: [],
      supportsRowOrderSlice: false,
      datasetId: 'ds-large',
      enqueueBackendEval: vi.fn(),
    }

    formulaService.setAsyncAggregateContext(asyncContext)
    formulaService.setBackendEvalContext(backendContext)

    const result = formulaService.evaluate('=A1', { row: 1, col: 1, sheet: 'Sheet1' })
    expect(result.error?.type).toBe('#VALUE!')
    expect(result.error?.message).toContain('row order')
  })

  it('allows sync evaluation when referenced rows are loaded', () => {
    const rowData = new Map<number, Record<string, unknown>>([[0, { 'col-a': 42 }]])
    const columns = [{ id: 'col-a' }]
    const formulaService = createFormulaService(() => rowData, columns)

    formulaService.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: true,
      isGrouped: false,
      getRowData: () => rowData,
      enqueueAggregate: vi.fn(),
    })

    formulaService.setBackendEvalContext({
      isLargeDataset: true,
      isSorted: true,
      isGrouped: false,
      totalRows: 100,
      loadedRowRange: { start: 0, end: 10 },
      columnLookup: {
        indexToId: (index: number) => (index === 0 ? 'col-a' : `col-${index}`),
        idToIndex: (columnId: string) => (columnId === 'col-a' ? 0 : -1),
      },
      rowOrder: [],
      supportsRowOrderSlice: false,
      datasetId: 'ds-large',
      enqueueBackendEval: vi.fn(),
    })

    const result = formulaService.evaluate('=A1', { row: 1, col: 1, sheet: 'Sheet1' })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
  })

  it('routes to backend when rowOrder is missing but lazy slice support exists', () => {
    const rowData = new Map<number, Record<string, unknown>>()
    const columns = [{ id: 'col-a' }]
    const formulaService = createFormulaService(() => rowData, columns)

    const enqueueBackendEval = vi.fn()

    formulaService.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: true,
      isGrouped: false,
      getRowData: () => rowData,
      enqueueAggregate: vi.fn(),
    })

    formulaService.setBackendEvalContext({
      isLargeDataset: true,
      isSorted: true,
      isGrouped: false,
      totalRows: 100,
      loadedRowRange: { start: 0, end: 10 },
      columnLookup: {
        indexToId: (index: number) => (index === 0 ? 'col-a' : `col-${index}`),
        idToIndex: (columnId: string) => (columnId === 'col-a' ? 0 : -1),
      },
      rowOrder: [],
      supportsRowOrderSlice: true,
      datasetId: 'ds-large',
      enqueueBackendEval,
    })

    const result = formulaService.evaluate('=A20', { row: 1, col: 1, sheet: 'Sheet1' })
    expect(result.value).toBe(FormulaService.CALC_PENDING_SENTINEL)
    expect(enqueueBackendEval).toHaveBeenCalledTimes(1)
  })
})
