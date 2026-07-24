/**
 * Formula Service Tests
 *
 * Tests for Excel-like formula evaluation and dependency tracking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  FormulaService,
  createFormulaService,
  getFunctionSuggestionsWithHints,
  getFunctionSignature,
} from '../formulaService'
import type { CellPosition } from '../formulaTypes'

describe('FormulaService', () => {
  let formulaService: FormulaService
  let mockRowData: Map<number, Record<string, unknown>>
  let columns: Array<{ id: string }>

  beforeEach(() => {
    // Setup mock data: A1=1, A2=2, A3=3, A4=4, A5=5
    mockRowData = new Map([
      [0, { 'col-a': 1, 'col-b': 10 }],
      [1, { 'col-a': 2, 'col-b': 20 }],
      [2, { 'col-a': 3, 'col-b': 30 }],
      [3, { 'col-a': 4, 'col-b': 40 }],
      [4, { 'col-a': 5, 'col-b': 50 }],
    ])

    columns = [{ id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' }]

    formulaService = createFormulaService(() => mockRowData, columns)
  })

  describe('isFormula', () => {
    it('returns true for strings starting with =', () => {
      expect(formulaService.isFormula('=1+1')).toBe(true)
      expect(formulaService.isFormula('=SUM(A1:A5)')).toBe(true)
      expect(formulaService.isFormula('=A1')).toBe(true)
    })

    it('returns false for non-formula values', () => {
      expect(formulaService.isFormula('hello')).toBe(false)
      expect(formulaService.isFormula(123)).toBe(false)
      expect(formulaService.isFormula(null)).toBe(false)
      expect(formulaService.isFormula(undefined)).toBe(false)
      expect(formulaService.isFormula('')).toBe(false)
    })
  })

  describe('Basic formula evaluation', () => {
    it('evaluates =1+1 to 2', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }
      const result = formulaService.evaluate('=1+1', position)

      expect(result.value).toBe(2)
      expect(result.error).toBeUndefined()
    })

    it('evaluates arithmetic expressions', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

      expect(formulaService.evaluate('=2*3', position).value).toBe(6)
      expect(formulaService.evaluate('=10/2', position).value).toBe(5)
      expect(formulaService.evaluate('=5-3', position).value).toBe(2)
      expect(formulaService.evaluate('=2^3', position).value).toBe(8)
    })

    it('evaluates formulas without = prefix', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }
      const result = formulaService.evaluate('1+1', position)

      expect(result.value).toBe(2)
    })
  })

  describe('Cell reference evaluation', () => {
    it('evaluates =A1 correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' } // B1

      const result = formulaService.evaluate('=A1', position)

      expect(result.value).toBe(1) // A1 contains 1
    })

    it('evaluates =A1+A2 correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=A1+A2', position)

      expect(result.value).toBe(3) // 1 + 2 = 3
    })

    it('evaluates cell reference with multiplication', () => {
      const position: CellPosition = { row: 1, col: 3, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=A1*B1', position)

      expect(result.value).toBe(10) // 1 * 10 = 10
    })
  })

  describe('Function evaluation', () => {
    it('evaluates =SUM(A1:A5) correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=SUM(A1:A5)', position)

      expect(result.value).toBe(15) // 1+2+3+4+5 = 15
    })

    it('evaluates SUM with whitespace inside A1 references', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }
      const result = formulaService.evaluate('=SUM(A 1:A 5)', position)

      expect(result.value).toBe(15)
      expect(result.error).toBeUndefined()
    })

    it('evaluates =AVERAGE(A1:A5) correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=AVERAGE(A1:A5)', position)

      expect(result.value).toBe(3) // (1+2+3+4+5)/5 = 3
    })

    it('evaluates =MIN(A1:A5) correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=MIN(A1:A5)', position)

      expect(result.value).toBe(1)
    })

    it('evaluates =MAX(A1:A5) correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=MAX(A1:A5)', position)

      expect(result.value).toBe(5)
    })

    it('evaluates =COUNT(A1:A5) correctly', () => {
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=COUNT(A1:A5)', position)

      expect(result.value).toBe(5)
    })

    it('evaluates parser-supported logical functions', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }
      const cases: Array<{ formula: string; expected: boolean | number }> = [
        { formula: '=AND(TRUE(), TRUE())', expected: true },
        { formula: '=OR(FALSE(), TRUE())', expected: true },
        { formula: '=NOT(FALSE())', expected: true },
        { formula: '=IF(TRUE(), 1, 0)', expected: 1 },
        { formula: '=IFERROR(1, 0)', expected: 1 },
        { formula: '=IFNA(1, 0)', expected: 1 },
        { formula: '=IFS(FALSE(), 1, TRUE(), 2)', expected: 2 },
        { formula: '=XOR(TRUE(), FALSE())', expected: true },
        { formula: '=TRUE()', expected: true },
        { formula: '=FALSE()', expected: false },
      ]

      for (const { formula, expected } of cases) {
        const result = formulaService.evaluate(formula, position)
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(expected)
      }
    })
  })

  describe('Volatile formula recalculation', () => {
    it('recalculates volatile formulas and their dependents only when explicitly requested', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-07T10:00:00Z'))

      const a1Key = '0:col-a'
      const b1Key = '0:col-b'

      formulaService.registerFormula(a1Key, '=NOW()', { row: 1, col: 1, sheet: 'Sheet1' })
      formulaService.registerFormula(b1Key, '=A1+1', { row: 1, col: 2, sheet: 'Sheet1' })

      const initialValue = formulaService.evaluate('=NOW()', { row: 1, col: 1, sheet: 'Sheet1' }).value

      vi.setSystemTime(new Date('2026-03-07T10:05:00Z'))

      const edits = formulaService.recalculateVolatileCells()
      const volatileEdit = edits.find((edit) => edit.row === 0 && edit.columnId === 'col-a')
      const dependentEdit = edits.find((edit) => edit.row === 0 && edit.columnId === 'col-b')

      expect(volatileEdit).toBeDefined()
      expect(dependentEdit).toBeDefined()
      expect(volatileEdit?.computedValue).not.toBe(initialValue)
      expect(Number(dependentEdit?.computedValue)).toBe(Number(volatileEdit?.computedValue) + 1)

      vi.useRealTimers()
    })
  })

  describe('Autocomplete signatures', () => {
    it('provides explicit signatures for exposed volatile and financial functions', () => {
      expect(getFunctionSignature('RAND')).toBe('RAND()')
      expect(getFunctionSignature('RANDBETWEEN')).toBe('RANDBETWEEN(bottom, top)')
      expect(getFunctionSignature('RATE')).toBe('RATE(nper, pmt, pv, [fv], [type], [guess])')
    })

    it('returns informative hints for RAND and RATE suggestions', () => {
      expect(getFunctionSuggestionsWithHints('RAN', 5)).toEqual(
        expect.arrayContaining([
          { name: 'RAND', signature: 'RAND()' },
          { name: 'RANDBETWEEN', signature: 'RANDBETWEEN(bottom, top)' },
        ])
      )

      formulaService.setBackendEvalContext({
        isLargeDataset: false,
        isSorted: false,
        isGrouped: false,
        totalRows: 0,
        loadedRowRange: { start: 0, end: 0 },
        columnLookup: {
          indexToId: () => 'col-a',
          idToIndex: () => 0,
        },
        rowOrder: null,
        datasetId: 'test-dataset',
        enqueueBackendEval: () => {},
      })

      expect(getFunctionSuggestionsWithHints('RAT', 5)).toEqual(
        expect.arrayContaining([
          { name: 'RATE', signature: 'RATE(nper, pmt, pv, [fv], [type], [guess])' },
        ])
      )
    })
  })

  describe('Formula storage', () => {
    it('stores and retrieves formula string', () => {
      const cellKey = '0:col-b'
      const formula = '=A1+1'
      const position: CellPosition = { row: 1, col: 1, sheet: 'Sheet1' }

      formulaService.registerFormula(cellKey, formula, position)

      expect(formulaService.getFormula(cellKey)).toBe(formula)
      expect(formulaService.hasFormula(cellKey)).toBe(true)
    })

    it('returns undefined for non-formula cells', () => {
      expect(formulaService.getFormula('0:col-a')).toBeUndefined()
      expect(formulaService.hasFormula('0:col-a')).toBe(false)
    })

    it('unregisters formula correctly', () => {
      const cellKey = '0:col-b'
      const formula = '=A1+1'
      const position: CellPosition = { row: 1, col: 1, sheet: 'Sheet1' }

      formulaService.registerFormula(cellKey, formula, position)
      expect(formulaService.hasFormula(cellKey)).toBe(true)

      formulaService.unregisterFormula(cellKey)
      expect(formulaService.hasFormula(cellKey)).toBe(false)
    })
  })

  describe('Formula display formatting', () => {
    it('annotates A1 references with column display names', () => {
      const formatted = formulaService.formatFormulaWithColumnNames(
        '=A1+1',
        (columnId) => (columnId === 'col-a' ? 'Blood_Pressure' : undefined)
      )

      expect(formatted).toBe('=A1 (Blood_Pressure)+1')
    })

    it('annotates both ends of a range', () => {
      const formatted = formulaService.formatFormulaWithColumnNames(
        '=SUM(A1:A5)',
        (columnId) => (columnId === 'col-a' ? 'Blood_Pressure' : undefined)
      )

      expect(formatted).toBe('=SUM(A1 (Blood_Pressure):A5 (Blood_Pressure))')
    })
  })

  describe('Dependency tracking', () => {
    it('tracks simple dependency: B1=A1+1', () => {
      const b1Key = '0:col-b'
      const a1Key = '0:col-a'
      const formula = '=A1+1'
      const position: CellPosition = { row: 1, col: 1, sheet: 'Sheet1' }

      formulaService.registerFormula(b1Key, formula, position)

      // A1 should have B1 as a dependent
      const dependents = formulaService.getDependents(a1Key)
      expect(dependents.has(b1Key)).toBe(true)
    })

    it('tracks multiple dependencies: C1=A1+B1', () => {
      const c1Key = '0:col-c'
      const a1Key = '0:col-a'
      const b1Key = '0:col-b'
      const formula = '=A1+B1'
      const position: CellPosition = { row: 1, col: 2, sheet: 'Sheet1' }

      formulaService.registerFormula(c1Key, formula, position)

      expect(formulaService.getDependents(a1Key).has(c1Key)).toBe(true)
      expect(formulaService.getDependents(b1Key).has(c1Key)).toBe(true)
    })

    it('removes dependencies when formula is unregistered', () => {
      const b1Key = '0:col-b'
      const a1Key = '0:col-a'
      const formula = '=A1+1'
      const position: CellPosition = { row: 1, col: 1, sheet: 'Sheet1' }

      formulaService.registerFormula(b1Key, formula, position)
      expect(formulaService.getDependents(a1Key).has(b1Key)).toBe(true)

      formulaService.unregisterFormula(b1Key)
      expect(formulaService.getDependents(a1Key).has(b1Key)).toBe(false)
    })
  })

  describe('Dependent recalculation', () => {
    it('recalculates dependent formulas when source changes', () => {
      const b1Key = '0:col-b'
      const a1Key = '0:col-a'
      const formula = '=A1+1'
      const position: CellPosition = { row: 1, col: 1, sheet: 'Sheet1' }

      formulaService.registerFormula(b1Key, formula, position)

      // Simulate A1 changing - get dependent edits
      const edits = formulaService.recalculateDependents(a1Key)

      expect(edits).toHaveLength(1)
      expect(edits[0]!.row).toBe(0)
      expect(edits[0]!.columnId).toBe('col-b')
      // Should be A1 (1) + 1 = 2
      expect(edits[0]!.computedValue).toBe(2)
    })

    it('recalculates chain: A1 → B1 → C1', () => {
      const a1Key = '0:col-a'
      const b1Key = '0:col-b'
      const c1Key = '0:col-c'

      // B1 = A1 * 2
      formulaService.registerFormula(b1Key, '=A1*2', { row: 1, col: 1, sheet: 'Sheet1' })
      // C1 = B1 + 10
      formulaService.registerFormula(c1Key, '=B1+10', { row: 1, col: 2, sheet: 'Sheet1' })

      // Change A1 - should cascade to B1 then C1
      const edits = formulaService.recalculateDependents(a1Key)

      // Should have both B1 and C1 edits
      const columnIds = edits.map((e) => e.columnId)
      expect(columnIds).toContain('col-b')
      expect(columnIds).toContain('col-c')

      // B1 should come before C1 (dependency order)
      const b1Index = edits.findIndex((e) => e.columnId === 'col-b')
      const c1Index = edits.findIndex((e) => e.columnId === 'col-c')
      expect(b1Index).toBeLessThan(c1Index)
    })
  })

  describe('Circular reference detection', () => {
    it('blocks backend-routed formulas whose range includes the formula cell', () => {
      const hColumns = Array.from({ length: 8 }, (_, index) => ({ id: `col-${index}` }))
      const service = createFormulaService(
        () => new Map([
          [0, { 'col-7': 153.09 }],
          [1, { 'col-7': 37.69 }],
          [2, { 'col-7': 199.17 }],
          [3, { 'col-7': null }],
        ]),
        hColumns
      )
      const enqueuedFormulas: string[] = []
      service.setBackendEvalContext({
        isLargeDataset: true,
        isSorted: false,
        isGrouped: false,
        totalRows: 4,
        loadedRowRange: { start: 0, end: 4 },
        columnLookup: {
          indexToId: (index: number) => hColumns[index]?.id ?? '',
          idToIndex: (columnId: string) => hColumns.findIndex((col) => col.id === columnId),
        },
        rowOrder: null,
        datasetId: 'test-dataset',
        enqueueBackendEval: (request) => {
          enqueuedFormulas.push(request.formula)
        },
      })

      const result = service.evaluate('=MEDIAN(H1:H4)', { row: 4, col: 8, sheet: 'Sheet1' })

      expect(result.value).toBeNull()
      expect(result.error?.type).toBe('#CIRCULAR!')
      expect(result.error?.message).toContain('Formula range includes the formula cell')
      expect(enqueuedFormulas).toHaveLength(0)
    })

    it('blocks sync formulas whose range includes the formula cell', () => {
      const hColumns = Array.from({ length: 8 }, (_, index) => ({ id: `col-${index}` }))
      const service = createFormulaService(
        () => new Map([
          [0, { 'col-7': 10 }],
          [1, { 'col-7': 20 }],
          [2, { 'col-7': 30 }],
          [8, { 'col-7': null }],
        ]),
        hColumns
      )

      const result = service.evaluate('=SUM(H1:H9)', { row: 9, col: 8, sheet: 'Sheet1' })

      expect(result.value).toBeNull()
      expect(result.error?.type).toBe('#CIRCULAR!')
      expect(result.error?.message).toContain('Formula range includes the formula cell')
    })

    it('blocks backend-required self-references even without backend context', () => {
      const hColumns = Array.from({ length: 8 }, (_, index) => ({ id: `col-${index}` }))
      const service = createFormulaService(
        () => new Map([
          [0, { 'col-7': 153.09 }],
          [1, { 'col-7': 37.69 }],
          [2, { 'col-7': 199.17 }],
          [3, { 'col-7': null }],
        ]),
        hColumns
      )

      const result = service.evaluate('=MEDIAN(H1:H4)', { row: 4, col: 8, sheet: 'Sheet1' })

      expect(result.value).toBeNull()
      expect(result.error?.type).toBe('#CIRCULAR!')
      expect(result.error?.message).toContain('Formula range includes the formula cell')
    })

    it('blocks large async aggregate self-references before aggregate enqueue', () => {
      const hColumns = Array.from({ length: 8 }, (_, index) => ({ id: `col-${index}` }))
      const service = createFormulaService(
        () => new Map([
          [0, { 'col-7': 153.09 }],
          [1, { 'col-7': 37.69 }],
          [2, { 'col-7': 199.17 }],
          [3, { 'col-7': null }],
        ]),
        hColumns
      )
      const enqueuedAggregates: unknown[] = []
      service.setAsyncAggregateContext({
        isLargeDataset: true,
        isSorted: false,
        isGrouped: false,
        getRowData: () => new Map(),
        enqueueAggregate: (request) => {
          enqueuedAggregates.push(request)
        },
      })

      const result = service.evaluate('=SUM(H1:H10001)', { row: 4, col: 8, sheet: 'Sheet1' })

      expect(result.value).toBeNull()
      expect(result.error?.type).toBe('#CIRCULAR!')
      expect(result.error?.message).toContain('Formula range includes the formula cell')
      expect(enqueuedAggregates).toHaveLength(0)
    })

    it('blocks full-column async aggregate self-references before aggregate enqueue', () => {
      const hColumns = Array.from({ length: 8 }, (_, index) => ({ id: `col-${index}` }))
      const service = createFormulaService(() => new Map(), hColumns)
      const enqueuedAggregates: unknown[] = []
      service.setAsyncAggregateContext({
        isLargeDataset: true,
        isSorted: false,
        isGrouped: false,
        getRowData: () => new Map(),
        enqueueAggregate: (request) => {
          enqueuedAggregates.push(request)
        },
      })

      const result = service.evaluate('=SUM(H:H)', { row: 4, col: 8, sheet: 'Sheet1' })

      expect(result.value).toBeNull()
      expect(result.error?.type).toBe('#CIRCULAR!')
      expect(result.error?.message).toContain('Formula range includes the formula cell')
      expect(enqueuedAggregates).toHaveLength(0)
    })

    it('detects simple circular reference: A1=B1, B1=A1', () => {
      const a1Key = '0:col-a'
      const b1Key = '0:col-b'

      formulaService.registerFormula(a1Key, '=B1', { row: 1, col: 0, sheet: 'Sheet1' })
      formulaService.registerFormula(b1Key, '=A1', { row: 1, col: 1, sheet: 'Sheet1' })

      expect(formulaService.detectCycle(a1Key)).toBe(true)
      expect(formulaService.detectCycle(b1Key)).toBe(true)
    })

    it('does not store direct self-dependencies in the dependency graph', () => {
      const a1Key = '0:col-a'

      formulaService.registerFormula(a1Key, '=A1', { row: 1, col: 0, sheet: 'Sheet1' })

      expect(formulaService.getDependents(a1Key).has(a1Key)).toBe(false)
    })

    it('detects 3-cell circular: A1=C1, B1=A1, C1=B1', () => {
      const a1Key = '0:col-a'
      const b1Key = '0:col-b'
      const c1Key = '0:col-c'

      formulaService.registerFormula(a1Key, '=C1', { row: 1, col: 0, sheet: 'Sheet1' })
      formulaService.registerFormula(b1Key, '=A1', { row: 1, col: 1, sheet: 'Sheet1' })
      formulaService.registerFormula(c1Key, '=B1', { row: 1, col: 2, sheet: 'Sheet1' })

      expect(formulaService.detectCycle(a1Key)).toBe(true)
      expect(formulaService.detectCycle(b1Key)).toBe(true)
      expect(formulaService.detectCycle(c1Key)).toBe(true)
    })

    it('returns false for non-circular formulas', () => {
      const b1Key = '0:col-b'

      formulaService.registerFormula(b1Key, '=A1+1', { row: 1, col: 1, sheet: 'Sheet1' })

      expect(formulaService.detectCycle(b1Key)).toBe(false)
    })
  })

  describe('Error handling', () => {
    it('returns error for unknown function', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=UNKNOWNFUNC()', position)

      expect(result.error).toBeDefined()
      // fast-formula-parser returns #ERROR! for unimplemented functions
      expect(['#NAME?', '#ERROR!']).toContain(result.error?.type)
    })

    it('returns error for division by zero', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=1/0', position)

      // fast-formula-parser may return Infinity rather than error
      // Check either case
      if (result.error) {
        expect(result.error.type).toBe('#DIV/0!')
      } else {
        expect(result.value).toBe(Infinity)
      }
    })

    it('handles invalid formula syntax gracefully', () => {
      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

      const result = formulaService.evaluate('=SUM(A1:', position)

      expect(result.error).toBeDefined()
    })

    it('routes backend-only non-spill functions (PMT) to backend when context is available', () => {
      const requests: Array<{ formula: string }> = []

      formulaService.setBackendEvalContext({
        isLargeDataset: false,
        isSorted: false,
        isGrouped: false,
        totalRows: 5,
        loadedRowRange: { start: 0, end: 4 },
        columnLookup: {
          indexToId: (index: number) => columns[index]?.id ?? `col-${index}`,
          idToIndex: (columnId: string) => columns.findIndex((c) => c.id === columnId),
        },
        rowOrder: null,
        datasetId: 'test-dataset',
        enqueueBackendEval: (request) => {
          requests.push({ formula: request.formula })
        },
      })

      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }
      const result = formulaService.evaluate('=PMT(0.01, 12, 1000)', position)

      expect(result.value).toBe(FormulaService.CALC_PENDING_SENTINEL)
      expect(result.error).toBeUndefined()
      expect(requests).toHaveLength(1)
      expect(requests[0]?.formula.toUpperCase()).toContain('PMT(')
    })

    it('returns explicit backend-unavailable error for backend-only formulas on large datasets', () => {
      formulaService.setAsyncAggregateContext({
        isLargeDataset: true,
        isSorted: false,
        isGrouped: false,
        getRowData: () => mockRowData,
        enqueueAggregate: () => {},
      })

      const position: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }
      const result = formulaService.evaluate('=PMT(0.01, 12, 1000)', position)

      expect(result.error).toBeDefined()
      expect(result.error?.type).toBe('#VALUE!')
      expect(result.error?.message).toContain('backend evaluation')
      expect(result.error?.message).toContain('not available')
    })
  })

  describe('clear()', () => {
    it('clears all formulas and dependencies', () => {
      const b1Key = '0:col-b'
      const a1Key = '0:col-a'

      formulaService.registerFormula(b1Key, '=A1+1', { row: 1, col: 1, sheet: 'Sheet1' })
      expect(formulaService.hasFormula(b1Key)).toBe(true)
      expect(formulaService.getDependents(a1Key).size).toBeGreaterThan(0)

      formulaService.clear()

      expect(formulaService.hasFormula(b1Key)).toBe(false)
      expect(formulaService.getDependents(a1Key).size).toBe(0)
    })
  })

  describe('getAllFormulaCells()', () => {
    it('returns all registered formulas', () => {
      formulaService.registerFormula('0:col-b', '=A1+1', { row: 1, col: 1, sheet: 'Sheet1' })
      formulaService.registerFormula('1:col-b', '=A2*2', { row: 2, col: 1, sheet: 'Sheet1' })

      const allFormulas = formulaService.getAllFormulaCells()

      expect(allFormulas.size).toBe(2)
      expect(allFormulas.get('0:col-b')).toBe('=A1+1')
      expect(allFormulas.get('1:col-b')).toBe('=A2*2')
    })
  })

  describe('getFilledFormula - Fill-down with relative references', () => {
    it('shifts relative references when filling down', () => {
      // =A1*2 in B1 filled to B2 should become =A2*2
      const result = formulaService.getFilledFormula(
        '=A1*2',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 2 }  // B2
      )
      expect(result).toBe('=A2*2')
    })

    it('shifts relative references when filling down multiple rows', () => {
      // =A1+A2 in B1 filled to B3 should become =A3+A4
      const result = formulaService.getFilledFormula(
        '=A1+A2',
        { row: 1, col: 2 }, // B1
        { row: 3, col: 2 }  // B3
      )
      expect(result).toBe('=A3+A4')
    })

    it('shifts relative references when filling right', () => {
      // =A1*2 in B1 filled to C1 should become =B1*2
      const result = formulaService.getFilledFormula(
        '=A1*2',
        { row: 1, col: 2 }, // B1
        { row: 1, col: 3 }  // C1
      )
      expect(result).toBe('=B1*2')
    })

    it('shifts range references when filling down', () => {
      // =SUM(A1:A3) in B1 filled to B2 should become =SUM(A2:A4)
      const result = formulaService.getFilledFormula(
        '=SUM(A1:A3)',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 2 }  // B2
      )
      expect(result).toBe('=SUM(A2:A4)')
    })

    it('shifts range references when filling right', () => {
      // =SUM(A1:A3) in B1 filled to C1 should become =SUM(B1:B3)
      const result = formulaService.getFilledFormula(
        '=SUM(A1:A3)',
        { row: 1, col: 2 }, // B1
        { row: 1, col: 3 }  // C1
      )
      expect(result).toBe('=SUM(B1:B3)')
    })

    it('shifts both rows and columns when filling diagonally', () => {
      // =A1 in B1 filled to C2 should become =B2
      const result = formulaService.getFilledFormula(
        '=A1',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 3 }  // C2
      )
      expect(result).toBe('=B2')
    })
  })

  describe('getFilledFormula - Absolute references ($)', () => {
    it('does not shift column with $A (absolute column)', () => {
      // =$A1 in B1 filled to C1 should stay =$A1 (column locked)
      const result = formulaService.getFilledFormula(
        '=$A1',
        { row: 1, col: 2 }, // B1
        { row: 1, col: 3 }  // C1
      )
      expect(result).toBe('=$A1')
    })

    it('does not shift row with A$1 (absolute row)', () => {
      // =A$1 in B1 filled to B2 should stay =A$1 (row locked)
      const result = formulaService.getFilledFormula(
        '=A$1',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 2 }  // B2
      )
      expect(result).toBe('=A$1')
    })

    it('does not shift fully absolute reference $A$1', () => {
      // =$A$1 in B1 filled to C2 should stay =$A$1
      const result = formulaService.getFilledFormula(
        '=$A$1',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 3 }  // C2
      )
      expect(result).toBe('=$A$1')
    })

    it('shifts column but not row with A$1', () => {
      // =A$1 in B1 filled to C2 should become =B$1 (row locked, column shifts)
      const result = formulaService.getFilledFormula(
        '=A$1',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 3 }  // C2
      )
      expect(result).toBe('=B$1')
    })

    it('shifts row but not column with $A1', () => {
      // =$A1 in B1 filled to C2 should become =$A2 (column locked, row shifts)
      const result = formulaService.getFilledFormula(
        '=$A1',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 3 }  // C2
      )
      expect(result).toBe('=$A2')
    })

    it('handles mixed absolute/relative in ranges', () => {
      // =SUM($A$1:B3) in B1 filled to C2 should become =SUM($A$1:C4)
      const result = formulaService.getFilledFormula(
        '=SUM($A$1:B3)',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 3 }  // C2
      )
      expect(result).toBe('=SUM($A$1:C4)')
    })

    it('handles absolute row in range start, relative in end', () => {
      // =SUM(A$1:B3) in B1 filled down to B2 should become =SUM(A$1:B4)
      const result = formulaService.getFilledFormula(
        '=SUM(A$1:B3)',
        { row: 1, col: 2 }, // B1
        { row: 2, col: 2 }  // B2
      )
      expect(result).toBe('=SUM(A$1:B4)')
    })
  })

  describe('getFilledFormula - Excel-like examples', () => {
    it('example: =A1*2 filled from B1 to B5', () => {
      const baseFormula = '=A1*2'
      const fromPos = { row: 1, col: 2 } // B1

      // B1 → B2: =A1*2 → =A2*2
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 2, col: 2 })).toBe('=A2*2')
      // B1 → B3: =A1*2 → =A3*2
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 3, col: 2 })).toBe('=A3*2')
      // B1 → B4: =A1*2 → =A4*2
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 4, col: 2 })).toBe('=A4*2')
      // B1 → B5: =A1*2 → =A5*2
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 5, col: 2 })).toBe('=A5*2')
    })

    it('example: =$A$1*B1 filled from C1 to E1 (absolute + relative)', () => {
      const baseFormula = '=$A$1*B1'
      const fromPos = { row: 1, col: 3 } // C1

      // C1 → D1: =$A$1*B1 → =$A$1*C1
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 1, col: 4 })).toBe('=$A$1*C1')
      // C1 → E1: =$A$1*B1 → =$A$1*D1
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 1, col: 5 })).toBe('=$A$1*D1')
    })

    it('example: =SUM($A$1:A1) running total down a column', () => {
      const baseFormula = '=SUM($A$1:A1)'
      const fromPos = { row: 1, col: 2 } // B1

      // B1 → B2: =SUM($A$1:A1) → =SUM($A$1:A2)
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 2, col: 2 })).toBe('=SUM($A$1:A2)')
      // B1 → B3: =SUM($A$1:A1) → =SUM($A$1:A3)
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 3, col: 2 })).toBe('=SUM($A$1:A3)')
      // B1 → B10: =SUM($A$1:A1) → =SUM($A$1:A10)
      expect(formulaService.getFilledFormula(baseFormula, fromPos, { row: 10, col: 2 })).toBe('=SUM($A$1:A10)')
    })

    it('example: complex formula with multiple references', () => {
      // =IF(A1>0, B1*$C$1, D1)
      const result = formulaService.getFilledFormula(
        '=IF(A1>0, B1*$C$1, D1)',
        { row: 1, col: 5 }, // F1
        { row: 3, col: 5 }  // F3
      )
      // A1→A3, B1→B3, $C$1 stays, D1→D3
      expect(result).toBe('=IF(A3>0, B3*$C$1, D3)')
    })
  })

  describe('getFilledFormula - Edge cases', () => {
    it('returns original formula when fromPos === toPos', () => {
      const result = formulaService.getFilledFormula(
        '=A1+1',
        { row: 1, col: 1 },
        { row: 1, col: 1 }
      )
      expect(result).toBe('=A1+1')
    })

    it('handles formulas without = prefix', () => {
      // Note: getFilledFormula adds = prefix in output
      const result = formulaService.getFilledFormula(
        'A1+1',
        { row: 1, col: 2 },
        { row: 2, col: 2 }
      )
      expect(result).toBe('=A2+1')
    })

    it('handles formula with no cell references', () => {
      const result = formulaService.getFilledFormula(
        '=1+1',
        { row: 1, col: 1 },
        { row: 5, col: 3 }
      )
      expect(result).toBe('=1+1')
    })

    it('returns #REF! when reference would go out of bounds (row < 1)', () => {
      // Cannot have row 0 or negative in Excel notation
      const result = formulaService.getFilledFormula(
        '=A2',
        { row: 2, col: 1 }, // B2
        { row: 1, col: 1 }  // B1 (would need A1)
      )
      // Filling up from row 2 to row 1: A2 → A1 (valid)
      expect(result).toBe('=A1')

      // But filling up 2 rows would be invalid
      const result2 = formulaService.getFilledFormula(
        '=A1',
        { row: 1, col: 1 },
        { row: 0, col: 1 } // Would need A0 which doesn't exist
      )
      expect(result2).toContain('#REF!')
    })
  })

  describe('Structural insert shifting', () => {
    it('shifts full-column references during column insert', () => {
      const cellKey = '0:col-c'
      formulaService.registerFormula(cellKey, '=SUM(A:A)', { row: 1, col: 2, sheet: 'Sheet1' })

      formulaService.shiftReferencesForColumnInsert(0)

      expect(formulaService.getFormula(cellKey)).toBe('=SUM(B:B)')
    })

    it('does not rewrite quoted A1-like text during column insert', () => {
      const cellKey = '0:col-c'
      formulaService.registerFormula(cellKey, '=IF(A1="A:A",SUM(A:A),A1)', {
        row: 1,
        col: 2,
        sheet: 'Sheet1',
      })

      formulaService.shiftReferencesForColumnInsert(0)

      expect(formulaService.getFormula(cellKey)).toBe('=IF(B1="A:A",SUM(B:B),B1)')
    })

    it('does not rewrite quoted A1-like text during row insert', () => {
      const originalKey = '1:col-c'
      const shiftedKey = '2:col-c'
      formulaService.registerFormula(originalKey, '=IF(A1="A1",A1,A2)', {
        row: 2,
        col: 2,
        sheet: 'Sheet1',
      })

      formulaService.shiftReferencesForRowInsert(0)

      expect(formulaService.getFormula(originalKey)).toBeUndefined()
      expect(formulaService.getFormula(shiftedKey)).toBe('=IF(A2="A1",A2,A3)')
    })
  })

  describe('Structural delete shifting', () => {
    it('shifts full-column references during column delete', () => {
      const cellKey = '0:col-c'
      formulaService.registerFormula(cellKey, '=SUM(B:B)', { row: 1, col: 2, sheet: 'Sheet1' })

      formulaService.shiftReferencesForColumnDelete(0)

      expect(formulaService.getFormula(cellKey)).toBe('=SUM(A:A)')
    })

    it('converts direct deleted-column references to #REF!', () => {
      const cellKey = '0:col-c'
      formulaService.registerFormula(cellKey, '=A1+B1', { row: 1, col: 2, sheet: 'Sheet1' })

      formulaService.shiftReferencesForColumnDelete(0)

      expect(formulaService.getFormula(cellKey)).toBe('=#REF!+A1')
    })

    it('shifts row references during row delete and drops deleted-row formulas', () => {
      const keepKey = '3:col-c'
      const dropKey = '1:col-c'
      formulaService.registerFormula(keepKey, '=A4+A5', { row: 4, col: 2, sheet: 'Sheet1' })
      formulaService.registerFormula(dropKey, '=A2', { row: 2, col: 2, sheet: 'Sheet1' })

      formulaService.shiftReferencesForRowDelete(1)

      expect(formulaService.getFormula(dropKey)).toBeUndefined()
      expect(formulaService.getFormula('2:col-c')).toBe('=A3+A4')
    })

    it('converts direct deleted-row references to #REF!', () => {
      const cellKey = '3:col-c'
      formulaService.registerFormula(cellKey, '=A2+A3', { row: 4, col: 2, sheet: 'Sheet1' })

      formulaService.shiftReferencesForRowDelete(1)

      expect(formulaService.getFormula('2:col-c')).toBe('=#REF!+A2')
    })
  })
})

describe('createFormulaService factory', () => {
  it('creates service with correct column mapping', () => {
    const rowData = new Map([[0, { 'my-col': 42 }]])
    const columns = [{ id: 'my-col' }]

    const service = createFormulaService(() => rowData, columns)

    // A1 should map to first column
    const result = service.evaluate('=A1', { row: 1, col: 0, sheet: 'Sheet1' })
    expect(result.value).toBe(42)
  })

  it('handles empty data gracefully', () => {
    const rowData = new Map<number, Record<string, unknown>>()
    const columns = [{ id: 'col-a' }]

    const service = createFormulaService(() => rowData, columns)

    const result = service.evaluate('=A1', { row: 1, col: 0, sheet: 'Sheet1' })
    // Should return null/undefined for missing data, not crash
    expect(result.error).toBeUndefined()
  })

  it('converts string numbers to numeric values', () => {
    const rowData = new Map([[0, { 'col-a': '123' }]])
    const columns = [{ id: 'col-a' }]

    const service = createFormulaService(() => rowData, columns)

    const result = service.evaluate('=A1+1', { row: 1, col: 0, sheet: 'Sheet1' })
    expect(result.value).toBe(124) // 123 + 1
  })
})
