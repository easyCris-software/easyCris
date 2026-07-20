/**
 * Column-Level Dependency Invalidation Tests - Phase 7
 *
 * Tests that batch operations (paste, fill, cut) trigger efficient
 * column-level formula recalculation instead of cell-by-cell.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeEdits } from '../editExecutor'
import { createFormulaService } from '../formulas/formulaService'
import type { EditExecutorConfig, EditExecutorDependencies } from '../types'

describe('Column-Level Dependency Invalidation', () => {
  type RowData = Map<number, Record<string, unknown>>
  type SetRowDataFn = (updater: (prev: RowData) => RowData) => void
  type UpdateCellValueFn = (datasetId: string, row: number, col: string, value: unknown) => void
  type InvalidateColumnsFn = (columnIds: string[]) => void

  let mockSetRowData: ReturnType<typeof vi.fn<SetRowDataFn>>
  let mockUpdateCellValue: ReturnType<typeof vi.fn<UpdateCellValueFn>>
  let mockInvalidateColumns: ReturnType<typeof vi.fn<InvalidateColumnsFn>>
  let rowData: Map<number, Record<string, unknown>>
  let config: EditExecutorConfig
  let deps: EditExecutorDependencies

  beforeEach(() => {
    // Initialize mock rowData with values in columns A, B
    rowData = new Map([
      [0, { 'col-a': 10, 'col-b': 20, 'col-c': 0, 'col-d': 0 }],
      [1, { 'col-a': 5, 'col-b': 15, 'col-c': 0, 'col-d': 0 }],
      [2, { 'col-a': 8, 'col-b': 12, 'col-c': 0, 'col-d': 0 }],
    ])

    mockSetRowData = vi.fn<SetRowDataFn>((updater) => {
      rowData = updater(rowData)
    })
    mockUpdateCellValue = vi.fn<UpdateCellValueFn>()
    mockInvalidateColumns = vi.fn<InvalidateColumnsFn>()

    // Create FormulaService
    const formulaService = createFormulaService(
      () => rowData,
      [{ id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' }, { id: 'col-d' }]
    )

    config = {
      datasetId: 'test-dataset',
      setRowData: mockSetRowData,
      updateCellValue: mockUpdateCellValue,
      invalidateColumns: mockInvalidateColumns,
      formulaService,
      columns: [{ id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' }, { id: 'col-d' }],
    }

    deps = {
      cacheService: {
        queueCellUpdate: vi.fn(),
        updateCellsBatch: vi.fn().mockResolvedValue(0),
      },
      undoService: {
        pushCellEdit: vi.fn().mockResolvedValue(undefined),
        pushBatchCellEdit: vi.fn().mockResolvedValue(undefined),
      },
    }

    vi.clearAllMocks()
  })

  describe('getDependentsForColumns', () => {
    it('should find formulas that depend on a single column', async () => {
      // Set up formulas: C1=A1*2, C2=A2*2, C3=A3*2
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1*2' },
            { row: 1, columnId: 'col-c', oldValue: 0, newValue: '=A2*2' },
            { row: 2, columnId: 'col-c', oldValue: 0, newValue: '=A3*2' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Use getDependentsForColumns to find all formulas that depend on col-a
      const dependents = config.formulaService!.getDependentsForColumns(['col-a'])

      // Should find all three C column formulas
      expect(dependents).toHaveLength(3)
      expect(dependents).toContain('0:col-c')
      expect(dependents).toContain('1:col-c')
      expect(dependents).toContain('2:col-c')
    })

    it('should find formulas that depend on multiple columns', async () => {
      // Set up formulas: C1=A1+B1, D1=A1*2
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1+B1' },
            { row: 0, columnId: 'col-d', oldValue: 0, newValue: '=A1*2' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Find formulas that depend on col-a
      const dependentsA = config.formulaService!.getDependentsForColumns(['col-a'])
      expect(dependentsA).toHaveLength(2) // Both C1 and D1
      expect(dependentsA).toContain('0:col-c')
      expect(dependentsA).toContain('0:col-d')

      // Find formulas that depend on col-b
      const dependentsB = config.formulaService!.getDependentsForColumns(['col-b'])
      expect(dependentsB).toHaveLength(1) // Only C1
      expect(dependentsB).toContain('0:col-c')

      // Find formulas that depend on either col-a or col-b
      const dependentsBoth = config.formulaService!.getDependentsForColumns(['col-a', 'col-b'])
      expect(dependentsBoth).toHaveLength(2) // Both C1 and D1 (deduped)
    })

    it('should return empty array for columns with no dependents', () => {
      const dependents = config.formulaService!.getDependentsForColumns(['col-c', 'col-d'])
      expect(dependents).toEqual([])
    })
  })

  describe('Column-level batch recalculation', () => {
    it('should recalculate all formulas when column values change (paste operation)', async () => {
      // Set up formulas in column C that depend on column A
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1*2' },
            { row: 1, columnId: 'col-c', oldValue: 0, newValue: '=A2*2' },
            { row: 2, columnId: 'col-c', oldValue: 0, newValue: '=A3*2' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Initial values: C1=20, C2=10, C3=16
      expect(rowData.get(0)?.['col-c']).toBe(20)
      expect(rowData.get(1)?.['col-c']).toBe(10)
      expect(rowData.get(2)?.['col-c']).toBe(16)

      // Paste new values into column A (batch operation)
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-a', oldValue: 10, newValue: 20 },
            { row: 1, columnId: 'col-a', oldValue: 5, newValue: 10 },
            { row: 2, columnId: 'col-a', oldValue: 8, newValue: 15 },
          ],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      // All formulas in column C should recalculate
      expect(rowData.get(0)?.['col-c']).toBe(40) // 20*2
      expect(rowData.get(1)?.['col-c']).toBe(20) // 10*2
      expect(rowData.get(2)?.['col-c']).toBe(30) // 15*2
    })

    it('should handle range formulas efficiently', async () => {
      // Set up formula that uses a range: D1=SUM(A1:A3)
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-d', oldValue: 0, newValue: '=SUM(A1:A3)' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Initial value: D1=23 (10+5+8)
      expect(rowData.get(0)?.['col-d']).toBe(23)

      // Change one value in the range
      await executeEdits(
        config,
        {
          edits: [{ row: 1, columnId: 'col-a', oldValue: 5, newValue: 15 }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Formula should recalculate: D1=33 (10+15+8)
      expect(rowData.get(0)?.['col-d']).toBe(33)
    })

    it('should recalculate formula chains efficiently', async () => {
      // Set up chain: C1=A1*2, D1=C1+10
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1*2' },
            { row: 0, columnId: 'col-d', oldValue: 0, newValue: '=C1+10' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Initial values: C1=20, D1=30
      expect(rowData.get(0)?.['col-c']).toBe(20)
      expect(rowData.get(0)?.['col-d']).toBe(30)

      // Change A1
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 10, newValue: 15 }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Both C1 and D1 should recalculate: C1=30, D1=40
      expect(rowData.get(0)?.['col-c']).toBe(30)
      expect(rowData.get(0)?.['col-d']).toBe(40)
    })

    it('should only recalculate formulas affected by changed columns', async () => {
      // Set up formulas: C1=A1*2, D1=B1+10
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1*2' },
            { row: 0, columnId: 'col-d', oldValue: 0, newValue: '=B1+10' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Initial values: C1=20, D1=30
      expect(rowData.get(0)?.['col-c']).toBe(20)
      expect(rowData.get(0)?.['col-d']).toBe(30)

      // Change only column A
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 10, newValue: 15 }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Only C1 should recalculate, D1 stays the same
      expect(rowData.get(0)?.['col-c']).toBe(30) // Changed
      expect(rowData.get(0)?.['col-d']).toBe(30) // Unchanged
    })
  })

  describe('recalculateFormulaCells batch method', () => {
    it('should recalculate multiple formula cells in one call', async () => {
      // Set up formulas
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1*2' },
            { row: 1, columnId: 'col-c', oldValue: 0, newValue: '=A2*2' },
            { row: 2, columnId: 'col-c', oldValue: 0, newValue: '=A3*2' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Change values in rowData
      rowData.set(0, { 'col-a': 20, 'col-b': 20, 'col-c': 20, 'col-d': 0 })
      rowData.set(1, { 'col-a': 10, 'col-b': 15, 'col-c': 10, 'col-d': 0 })
      rowData.set(2, { 'col-a': 15, 'col-b': 12, 'col-c': 16, 'col-d': 0 })

      // Batch recalculate all three formulas
      const cellKeys = ['0:col-c', '1:col-c', '2:col-c']
      const edits = config.formulaService!.recalculateFormulaCells(cellKeys)

      expect(edits).toHaveLength(3)

      // Find the edits (order may vary based on topological sort)
      const c1Edit = edits.find((e) => e.row === 0)
      const c2Edit = edits.find((e) => e.row === 1)
      const c3Edit = edits.find((e) => e.row === 2)

      expect(c1Edit?.computedValue).toBe(40) // 20*2
      expect(c2Edit?.computedValue).toBe(20) // 10*2
      expect(c3Edit?.computedValue).toBe(30) // 15*2
    })

    it('should handle dependency order in batch recalculation', async () => {
      // Set up chain: C1=A1*2, D1=C1+10
      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-c', oldValue: 0, newValue: '=A1*2' },
            { row: 0, columnId: 'col-d', oldValue: 0, newValue: '=C1+10' },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Change A1 value
      rowData.set(0, { 'col-a': 15, 'col-b': 20, 'col-c': 20, 'col-d': 30 })

      // Batch recalculate both formulas
      const cellKeys = ['0:col-c', '0:col-d']
      const edits = config.formulaService!.recalculateFormulaCells(cellKeys)

      // Should recalculate in dependency order: C1 first, then D1
      expect(edits).toHaveLength(2)

      // Find the edits (order may vary based on topological sort)
      const c1Edit = edits.find((e) => e.columnId === 'col-c')
      const d1Edit = edits.find((e) => e.columnId === 'col-d')

      expect(c1Edit?.computedValue).toBe(30) // 15*2
      expect(d1Edit?.computedValue).toBe(40) // 30+10
    })
  })
})
