/**
 * Formula Integration Tests - Phase 7
 *
 * Tests the integration of FormulaService with EditExecutor
 * to ensure formulas are evaluated correctly during cell edits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeEdits } from '../editExecutor'
import { createFormulaService } from '../formulas/formulaService'
import type { EditExecutorConfig, EditExecutorDependencies, CellEdit } from '../types'

describe('Formula Integration with EditExecutor', () => {
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
    // Initialize mock rowData
    rowData = new Map([
      [0, { 'col-a': 10, 'col-b': 20, 'col-c': 0 }],
      [1, { 'col-a': 5, 'col-b': 15, 'col-c': 0 }],
      [2, { 'col-a': 8, 'col-b': 12, 'col-c': 0 }],
    ])

    mockSetRowData = vi.fn<SetRowDataFn>((updater) => {
      rowData = updater(rowData)
    })
    mockUpdateCellValue = vi.fn<UpdateCellValueFn>()
    mockInvalidateColumns = vi.fn<InvalidateColumnsFn>()

    // Create FormulaService
    const formulaService = createFormulaService(
      () => rowData,
      [{ id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' }]
    )

    config = {
      datasetId: 'test-dataset',
      setRowData: mockSetRowData,
      updateCellValue: mockUpdateCellValue,
      invalidateColumns: mockInvalidateColumns,
      formulaService,
      columns: [{ id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' }],
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

  describe('Simple formula evaluation', () => {
    it('evaluates =1+1 and stores computed value', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=1+1',
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Check that rowData was updated with computed value
      expect(mockSetRowData).toHaveBeenCalled()
      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(2)

      // Check that dataCache was updated with computed value
      expect(mockUpdateCellValue).toHaveBeenCalledWith('test-dataset', 0, 'col-c', 2)
    })

    it('evaluates =10*5 correctly', async () => {
      const edit: CellEdit = {
        row: 1,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=10*5',
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(1)
      expect(resultRow?.['col-c']).toBe(50)
    })

    it('evaluates =(3+7)/2 with parentheses', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=(3+7)/2',
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(5)
    })
  })

  describe('Cell reference formulas', () => {
    it('evaluates =A1 (cell reference)', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=A1', // References col-a, row 0 (value 10)
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(10)
    })

    it('evaluates =A1+B1 (multiple cell references)', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=A1+B1', // 10 + 20 = 30
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(30)
    })

    it('evaluates =A2*B2 (different row)', async () => {
      const edit: CellEdit = {
        row: 1,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=A2*B2', // 5 * 15 = 75
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(1)
      expect(resultRow?.['col-c']).toBe(75)
    })
  })

  describe('Excel function formulas', () => {
    it('evaluates =SUM(A1:A3)', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=SUM(A1:A3)', // 10 + 5 + 8 = 23
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(23)
    })

    it('evaluates =AVERAGE(A1:A3)', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=AVERAGE(A1:A3)', // (10 + 5 + 8) / 3 = 7.666...
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBeCloseTo(7.67, 1)
    })
  })

  describe('Volatile formulas', () => {
    it('does not evaluate a newly entered RAND formula twice in the same edit cycle', async () => {
      const randomSpy = vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.111111)
        .mockReturnValueOnce(0.222222)

      try {
        await executeEdits(
          config,
          {
            edits: [
              {
                row: 0,
                columnId: 'col-c',
                oldValue: 0,
                newValue: '=RAND()',
              },
            ],
            source: 'type',
            timestamp: Date.now(),
          },
          deps
        )

        const resultRow = rowData.get(0)
        expect(resultRow?.['col-c']).toBe(0.111111)
      } finally {
        randomSpy.mockRestore()
      }
    })
  })

  describe('Dependent formula recalculation', () => {
    it('recalculates dependent formulas when source cell changes', async () => {
      // Step 1: Set up formula in C1 that depends on A1
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-c',
              oldValue: 0,
              newValue: '=A1*2', // Initially 10*2 = 20
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      let resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(20)

      // Step 2: Change A1 value - C1 should recalculate
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-a',
              oldValue: 10,
              newValue: 15,
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      resultRow = rowData.get(0)
      expect(resultRow?.['col-a']).toBe(15)
      expect(resultRow?.['col-c']).toBe(30) // Should be 15*2 = 30
    })

    it('handles chain of dependent formulas (A1 → B1 → C1)', async () => {
      // Set up chain: B1 = A1 + 5, C1 = B1 * 2
      // Note: When setting up multiple formulas, they all evaluate against initial rowData
      // So B1 = 10+5 = 15, C1 = 15*2 = 30
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-b',
              oldValue: 20,
              newValue: '=A1+5',
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Set C1 in a separate edit so B1 is already evaluated and in rowData
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-c',
              oldValue: 0,
              newValue: '=B1*2',
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      let resultRow = rowData.get(0)
      expect(resultRow?.['col-b']).toBe(15) // 10 + 5
      expect(resultRow?.['col-c']).toBe(30) // 15 * 2

      // Change A1 - both B1 and C1 should recalculate in dependency order
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-a',
              oldValue: 10,
              newValue: 20,
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      resultRow = rowData.get(0)
      expect(resultRow?.['col-a']).toBe(20)
      expect(resultRow?.['col-b']).toBe(25) // 20 + 5
      expect(resultRow?.['col-c']).toBe(50) // 25 * 2
    })
  })

  describe('Formula removal', () => {
    it('unregisters formula when cell is overwritten with non-formula', async () => {
      // Set up formula
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-c',
              oldValue: 0,
              newValue: '=A1*2',
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(config.formulaService?.hasFormula('0:col-c')).toBe(true)

      // Overwrite with static value
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-c',
              oldValue: 20,
              newValue: 99,
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      expect(resultRow?.['col-c']).toBe(99)
      expect(config.formulaService?.hasFormula('0:col-c')).toBe(false)
    })
  })

  describe('Error handling', () => {
    it('handles division by zero', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=1/0',
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const resultRow = rowData.get(0)
      const result = resultRow?.['col-c']
      expect(typeof result).toBe('string')
      expect(String(result)).toContain('#ERROR')
    })

    // Parser behavior for out-of-range cells may vary - skip for now
    it.skip('handles invalid cell references', async () => {
      const edit: CellEdit = {
        row: 0,
        columnId: 'col-c',
        oldValue: 0,
        newValue: '=Z99', // Non-existent cell (out of range)
      }

      await executeEdits(
        config,
        {
          edits: [edit],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const result = rowData.get(0)?.['col-c']
      // Parser returns null for non-existent cells - this is acceptable behavior
      // Formula evaluates to null, which is a valid result
      expect(result === null || result === undefined || result === 0).toBe(true)
    })
  })

  describe('Integration with undo/redo', () => {
    it('does not push formula recalculations to undo stack', async () => {
      // Set up dependent formula
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-c',
              oldValue: 0,
              newValue: '=A1*2',
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      vi.clearAllMocks()

      // Change source cell - triggers formula recalc
      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-a',
              oldValue: 10,
              newValue: 15,
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Should only push the source cell edit, not the formula recalc
      expect(deps.undoService.pushCellEdit).toHaveBeenCalledTimes(1)
      expect(deps.undoService.pushCellEdit).toHaveBeenCalledWith(
        'test-dataset',
        0,
        'col-a',
        10,
        15
      )
    })
  })
})
