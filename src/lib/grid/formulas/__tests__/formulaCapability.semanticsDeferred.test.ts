/**
 * formulaCapability.semanticsDeferred.test.ts
 *
 * Behavior regression guard for functions in SEMANTICS_DEFERRED_SET.
 * These are functions that exist in the backend (Formualizer 0.4.3) but have
 * known semantic gaps in the current implementation. They are blocked with a
 * distinct "not yet available" message — NOT a spill error, NOT a deny error.
 *
 * Currently deferred:
 *   ISFORMULA — Formualizer currently always returns FALSE (provenance not tracked).
 *               Re-enable once the gap is closed.
 *
 * Per-function assertions:
 *   - result.value is null
 *   - result.error is defined
 *   - result.error.type is '#NAME?'
 *   - result.error.message contains SEMANTICS_MSG_SUBSTRING ("not yet available")
 *   - result.error.message does NOT contain SPILL_MSG_SUBSTRING ("Array function not supported")
 *   - result.error.message does NOT contain "EasyCris" deny substring
 *
 * Parity:
 *   PARITY_FWD: SEMANTICS_DEFERRED_SET entries are covered by SEMANTICS_CASES
 *   PARITY_REV: SEMANTICS_CASES entries are still in SEMANTICS_DEFERRED_SET
 *               (stale test detection after a gap is closed and function promoted)
 *
 * Autocomplete:
 *   SEMANTICS functions must be absent from getFunctionSuggestions() results.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createFormulaService, getFunctionSuggestions, FormulaService } from '../formulaService'
import { SEMANTICS_DEFERRED_SET } from '../formulaCatalog'
import type { CellPosition } from '../formulaTypes'

const SEMANTICS_MSG_SUBSTRING = 'not yet available'
const SPILL_MSG_SUBSTRING     = 'Array function not supported'
// Deny messages contain "Use INDEX/MATCH instead." — use that unique fragment to distinguish
const DENY_UNIQUE_SUBSTRING   = 'Use INDEX/MATCH'

interface SemanticsCase {
  fn: string
  formula: string
  note?: string
}

const SEMANTICS_CASES: SemanticsCase[] = [
  {
    fn: 'ISFORMULA',
    formula: '=ISFORMULA(A1)',
    note: 'Formualizer currently always returns FALSE — semantics gap, not spill risk',
  },
]

describe('formulaCapability — semantics-deferred guard', () => {
  let svc: FormulaService
  const pos: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

  beforeEach(() => {
    const rowData = new Map([
      [0, { 'col-a': 1, 'col-b': 10 }],
      [1, { 'col-a': 2, 'col-b': 20 }],
      [2, { 'col-a': 3, 'col-b': 30 }],
    ])
    svc = createFormulaService(() => rowData, [
      { id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' },
    ])
  })

  // -------------------------------------------------------------------------
  // PARITY forward: catalog → test (new entry without test fails fast)
  // -------------------------------------------------------------------------
  it('PARITY_FWD: SEMANTICS_CASES covers every entry in SEMANTICS_DEFERRED_SET', () => {
    const testedNames = new Set(SEMANTICS_CASES.map((c) => c.fn))
    const missing = [...SEMANTICS_DEFERRED_SET].filter((name) => !testedNames.has(name))
    expect(
      missing,
      `Missing test cases for semantics-deferred functions: ${missing.join(', ')}. ` +
      `Add a SEMANTICS_CASE entry.`
    ).toEqual([])
  })

  // -------------------------------------------------------------------------
  // PARITY reverse: test → catalog (stale test after function is promoted)
  // -------------------------------------------------------------------------
  it('PARITY_REV: every SEMANTICS_CASES entry is still in SEMANTICS_DEFERRED_SET', () => {
    const stale = SEMANTICS_CASES.filter((c) => !SEMANTICS_DEFERRED_SET.has(c.fn))
    expect(
      stale.map((c) => c.fn),
      `Stale SEMANTICS_CASES entries — function gap closed and promoted: ` +
      `${stale.map((c) => c.fn).join(', ')}. Remove from SEMANTICS_CASES.`
    ).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Behavior tests (table-driven)
  // -------------------------------------------------------------------------
  for (const { fn, formula, note } of SEMANTICS_CASES) {
    it(`${fn} is blocked with semantics-deferred error${note ? ` (${note})` : ''}`, () => {
      const result = svc.evaluate(formula, pos)

      expect(result.value, `${fn}: value must be null`).toBeNull()
      expect(result.error, `${fn}: error must be defined`).toBeDefined()
      expect(result.error!.type, `${fn}: error type must be #NAME?`).toBe('#NAME?')
      expect(
        result.error!.message,
        `${fn}: message must contain "${SEMANTICS_MSG_SUBSTRING}", got: "${result.error!.message}"`
      ).toContain(SEMANTICS_MSG_SUBSTRING)
      // Must be distinguishable from spill errors
      expect(result.error!.message).not.toContain(SPILL_MSG_SUBSTRING)
      // Must be distinguishable from deny errors ("not supported ... Use INDEX/MATCH instead.")
      expect(result.error!.message).not.toContain(DENY_UNIQUE_SUBSTRING)
    })
  }

  // -------------------------------------------------------------------------
  // Autocomplete: semantics-deferred functions must not appear in suggestions
  // -------------------------------------------------------------------------
  it('ISFORMULA is absent from getFunctionSuggestions results', () => {
    const byFull   = getFunctionSuggestions('ISFORMULA', 50)
    const byPrefix = getFunctionSuggestions('IS', 100)

    expect(byFull).not.toContain('ISFORMULA')
    expect(byPrefix).not.toContain('ISFORMULA')
  })
})
