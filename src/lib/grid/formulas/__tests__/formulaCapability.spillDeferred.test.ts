/**
 * formulaCapability.spillDeferred.test.ts
 *
 * Behavior regression guard: ALL spill-deferred functions must be blocked
 * at evaluation time and return the spill policy error message, NOT a value
 * and NOT a denylist error.
 *
 * This file runs at every wave and must stay green forever.
 *
 * Assertions per function:
 *   - result.value is null
 *   - result.error is defined
 *   - result.error.message contains the spill-deferred substring
 *     ("Array function not supported") — distinguishable from denylist errors
 *     which contain "not supported in EasyCris"
 *
 * The assertion uses a substring match (not a literal error code) so it
 * remains stable if the exact message text is refined.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createFormulaService, FormulaService } from '../formulaService'
import { SPILL_DEFERRED_SET } from '../formulaCatalog'
import type { CellPosition } from '../formulaTypes'

const SPILL_MESSAGE_SUBSTRING = 'Array function not supported'

interface SpillCase {
  fn: string
  formula: string
  note?: string
}

// Table-driven: one entry per spill-deferred function.
// Formulas are the simplest syntactically-valid invocation.
// We do not need them to produce meaningful values — only to reach the spill guard.
const SPILL_CASES: SpillCase[] = [
  // ── Previously in BACKEND_ARRAY_FUNCTIONS (regression guard) ────────────
  { fn: 'CHOOSE',    formula: '=CHOOSE(1,"A","B")',             note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'CHOOSECOLS',formula: '=CHOOSECOLS(A1:B2,1)',           note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'CHOOSEROWS',formula: '=CHOOSEROWS(A1:B2,1)',           note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'DROP',      formula: '=DROP(A1:B2,1)',                 note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'FILTER',    formula: '=FILTER(A1:A3,A1:A3>0)',        note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'HSTACK',    formula: '=HSTACK(A1:A2,B1:B2)',          note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  // ISFORMULA removed from spill cases: reclassified to 'semantics-deferred' (not a spill risk).
  // It is now guarded separately with a "not yet available" message. See formulaCapability.semanticsDeferred.test.ts.
  { fn: 'LINEST',    formula: '=LINEST(A1:A3,B1:B3)',          note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'LOGEST',    formula: '=LOGEST(A1:A3,B1:B3)',          note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'MODE.MULT', formula: '=MODE.MULT(A1:A5)',             note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'SEQUENCE',  formula: '=SEQUENCE(3)',                   note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'TAKE',      formula: '=TAKE(A1:A3,2)',                note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'TREND',     formula: '=TREND(A1:A3,B1:B3)',           note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'UNIQUE',    formula: '=UNIQUE(A1:A3)',                 note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },
  { fn: 'VSTACK',    formula: '=VSTACK(A1:A2,B1:B2)',          note: 'was in legacy BACKEND_ARRAY_FUNCTIONS' },

  // ── Guard-gap closures (Phase 0 added; were previously unguarded) ───────
  { fn: 'FREQUENCY', formula: '=FREQUENCY(A1:A5,B1:B3)',       note: 'Phase 0 gap closure' },
  { fn: 'GROWTH',    formula: '=GROWTH(A1:A3)',                note: 'Phase 0 gap closure' },
  { fn: 'RANDARRAY', formula: '=RANDARRAY(3,2)',               note: 'Phase 0 gap closure' },
  { fn: 'SORT',      formula: '=SORT(A1:A3)',                  note: 'Phase 0 gap closure' },
  { fn: 'SORTBY',    formula: '=SORTBY(A1:A3,B1:B3)',         note: 'Phase 0 gap closure' },
  { fn: 'TEXTSPLIT', formula: '=TEXTSPLIT("a,b",",")',          note: 'Phase 0 gap closure' },
  { fn: 'TRANSPOSE', formula: '=TRANSPOSE(A1:B2)',             note: 'Phase 0 gap closure' },

  // Wave 1 candidates removed — all 9 promoted to scalar in Wave 1 (Phase 2).
  // See formulaCapability.wave1.test.ts for routing/wiring tests.

  // Wave 3 candidates removed — LET and LAMBDA promoted to scalar in Wave 3 (Phase 4).
  // See formulaCapability.wave3.test.ts for routing/wiring tests.

  // ── Higher-order combinators (spill-returning; added when LET/LAMBDA promoted) ──
  { fn: 'MAP',      formula: '=MAP(A1:A3,LAMBDA(x,x*2))',          note: 'spill-returning higher-order combinator' },
  { fn: 'BYROW',    formula: '=BYROW(A1:B3,LAMBDA(row,SUM(row)))', note: 'spill-returning higher-order combinator' },
  { fn: 'BYCOL',    formula: '=BYCOL(A1:B3,LAMBDA(c,SUM(c)))',    note: 'spill-returning higher-order combinator' },
  { fn: 'MAKEARRAY',formula: '=MAKEARRAY(3,2,LAMBDA(r,c,r*c))',   note: 'spill-returning higher-order combinator' },
  { fn: 'SCAN',     formula: '=SCAN(0,A1:A3,LAMBDA(a,x,a+x))',    note: 'spill-returning higher-order combinator' },
  { fn: 'REDUCE',   formula: '=REDUCE(0,A1:A3,LAMBDA(a,x,a+x))',  note: 'spill-returning higher-order combinator' },
]

// ---------------------------------------------------------------------------

describe('formulaCapability — spill-deferred regression guard', () => {
  // Parity forward: catalog → test (new entry without test fails fast)
  it('PARITY_FWD: SPILL_CASES covers every entry in SPILL_DEFERRED_SET', () => {
    const testedNames = new Set(SPILL_CASES.map((c) => c.fn))
    const missing = [...SPILL_DEFERRED_SET].filter((name) => !testedNames.has(name))
    expect(missing, `Missing test cases for spill-deferred functions: ${missing.join(', ')}. Add a SPILL_CASE entry.`).toEqual([])
  })

  // Parity reverse: test → catalog (stale test after promotion fails fast)
  it('PARITY_REV: every SPILL_CASES entry is still in SPILL_DEFERRED_SET', () => {
    const stale = SPILL_CASES.filter((c) => !SPILL_DEFERRED_SET.has(c.fn))
    expect(
      stale.map((c) => c.fn),
      `Stale SPILL_CASES entries — function promoted out of spill-deferred: ${stale.map((c) => c.fn).join(', ')}. Remove from SPILL_CASES and add to the Wave routing/wiring registry.`
    ).toEqual([])
  })

  let svc: FormulaService
  const pos: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

  beforeEach(() => {
    const rowData = new Map([
      [0, { 'col-a': 1, 'col-b': 10 }],
      [1, { 'col-a': 2, 'col-b': 20 }],
      [2, { 'col-a': 3, 'col-b': 30 }],
      [3, { 'col-a': 4, 'col-b': 40 }],
      [4, { 'col-a': 5, 'col-b': 50 }],
    ])
    svc = createFormulaService(() => rowData, [
      { id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' },
    ])
  })

  for (const { fn, formula, note } of SPILL_CASES) {
    it(`${fn} is blocked with spill policy error${note ? ` (${note})` : ''}`, () => {
      const result = svc.evaluate(formula, pos)
      expect(result.value, `${fn}: expected null value`).toBeNull()
      expect(result.error, `${fn}: expected error to be defined`).toBeDefined()
      expect(
        result.error!.message,
        `${fn}: error message must contain spill-deferred substring, got: "${result.error!.message}"`
      ).toContain(SPILL_MESSAGE_SUBSTRING)
      // Sanity: must NOT look like a denylist error (those contain "EasyCris")
      expect(result.error!.message).not.toContain('EasyCris')
    })
  }
})
