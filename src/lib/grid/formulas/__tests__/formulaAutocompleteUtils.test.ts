import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyFunctionSuggestion,
  getFormulaTokenContext,
  getSuggestionsForFormulaToken,
} from '../formulaAutocompleteUtils'
import { createFormulaService } from '../formulaService'

describe('formulaAutocompleteUtils', () => {
  beforeEach(() => {
    // Reset backend-gated autocomplete state before each test.
    const service = createFormulaService(() => new Map(), [{ id: 'col-a' }])
    service.setBackendEvalContext(undefined)
  })

  it('detects trailing function token at caret', () => {
    const context = getFormulaTokenContext('=SU', 3)
    expect(context).not.toBeNull()
    expect(context?.prefix).toBe('SU')
  })

  it('does not match inside string literals', () => {
    const context = getFormulaTokenContext('=IF(A1="SU",1,0)', 10)
    expect(context).toBeNull()
  })

  it('returns suggestions for valid token context', () => {
    const { suggestions } = getSuggestionsForFormulaToken('=MA', 3)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.some(s => s.name === 'MAX')).toBe(true)
  })

  it('hides backend-only functions in autocomplete when backend context is unavailable', () => {
    const { suggestions } = getSuggestionsForFormulaToken('=PM', 3)
    expect(suggestions.some(s => s.name === 'PMT')).toBe(false)
  })

  it('includes backend-only functions in autocomplete when backend context is available', () => {
    const service = createFormulaService(() => new Map(), [{ id: 'col-a' }])
    service.setBackendEvalContext({
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

    const { suggestions } = getSuggestionsForFormulaToken('=PM', 3)
    expect(suggestions.some(s => s.name === 'PMT')).toBe(true)
  })

  it('keeps spill-prone functions out of autocomplete', () => {
    const { suggestions } = getSuggestionsForFormulaToken('=MODE.', 6)
    expect(suggestions.some(s => s.name === 'MODE.MULT')).toBe(false)
  })

  it('includes parser-supported logical functions and excludes SWITCH', () => {
    const logicalFunctions = [
      'AND',
      'OR',
      'NOT',
      'IF',
      'IFERROR',
      'IFNA',
      'IFS',
      'XOR',
      'TRUE',
      'FALSE',
    ]

    for (const fn of logicalFunctions) {
      const input = `=${fn}`
      const { suggestions } = getSuggestionsForFormulaToken(input, input.length)
      expect(suggestions.some((s) => s.name === fn)).toBe(true)
    }

    const { suggestions: switchSuggestions } = getSuggestionsForFormulaToken('=SWI', 4)
    expect(switchSuggestions.some((s) => s.name === 'SWITCH')).toBe(false)
  })

  it('applies suggestion at caret and inserts opening paren', () => {
    const result = applyFunctionSuggestion('=SU', 3, 'SUM')
    expect(result).not.toBeNull()
    expect(result?.text).toBe('=SUM(')
  })
})
