/**
 * formulaCapability.denylist.test.ts — Phase 1 TDD gate
 *
 * Locks the hard product denylist behavior for VLOOKUP and XLOOKUP.
 *
 * T_DENY1: =VLOOKUP(...)   → #NAME? with product deny message
 * T_DENY2: =XLOOKUP(...)   → #NAME? with product deny message
 * T_DENY3: VLOOKUP absent from getFunctionSuggestions() results
 * T_DENY4: XLOOKUP absent from getFunctionSuggestions() results
 * T_DENY5: nested deny — =IF(TRUE,VLOOKUP(...),0) still blocked
 *
 * T_DENY1/T_DENY2/T_DENY5 are the TDD gates for Phase 1.
 * T_DENY3/T_DENY4 are regression guards for the Phase 0 catalog change.
 *
 * The deny message must:
 *   - contain the denied function name
 *   - contain "not supported" (product language)
 *   - NOT contain "Array function" (must be distinguishable from spill errors)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFormulaService, getFunctionSuggestions, FormulaService } from '../formulaService'
import { DENIED_SET } from '../formulaCatalog'
import type { CellPosition } from '../formulaTypes'

const DENY_MESSAGE_SUBSTRING = 'not supported'
const SPILL_MESSAGE_SUBSTRING = 'Array function not supported'

describe('formulaCapability — denylist (Phase 1)', () => {
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

  // Explicit teardown: reset async context so tests that mutate it don't leak.
  // beforeEach already recreates svc, so this is belt-and-suspenders isolation.
  afterEach(() => {
    svc.setAsyncAggregateContext(undefined)
  })

  // -------------------------------------------------------------------------
  // T_DENY1 — VLOOKUP returns product deny error at evaluation time
  // -------------------------------------------------------------------------
  it('T_DENY1: =VLOOKUP returns #NAME? with product deny message', () => {
    const result = svc.evaluate('=VLOOKUP(A1,B1:C3,2,0)', pos)

    expect(result.value).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error!.type).toBe('#NAME?')
    expect(result.error!.message).toContain('VLOOKUP')
    expect(result.error!.message).toContain(DENY_MESSAGE_SUBSTRING)
    // Must be distinguishable from spill errors
    expect(result.error!.message).not.toContain(SPILL_MESSAGE_SUBSTRING)
  })

  // -------------------------------------------------------------------------
  // T_DENY2 — XLOOKUP returns product deny error at evaluation time
  // -------------------------------------------------------------------------
  it('T_DENY2: =XLOOKUP returns #NAME? with product deny message', () => {
    const result = svc.evaluate('=XLOOKUP(A1,B1:B3,C1:C3)', pos)

    expect(result.value).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error!.type).toBe('#NAME?')
    expect(result.error!.message).toContain('XLOOKUP')
    expect(result.error!.message).toContain(DENY_MESSAGE_SUBSTRING)
    expect(result.error!.message).not.toContain(SPILL_MESSAGE_SUBSTRING)
  })

  // -------------------------------------------------------------------------
  // T_DENY3 — VLOOKUP absent from autocomplete (Phase 0 regression guard)
  // -------------------------------------------------------------------------
  it('T_DENY3: VLOOKUP is absent from getFunctionSuggestions results', () => {
    // Search with full prefix to get exact match if it exists
    const byFull = getFunctionSuggestions('VLOOKUP', 50)
    expect(byFull).not.toContain('VLOOKUP')

    // Also verify it does not appear in a broad 'V' prefix search
    const byPrefix = getFunctionSuggestions('V', 100)
    expect(byPrefix).not.toContain('VLOOKUP')
  })

  // -------------------------------------------------------------------------
  // T_DENY4 — XLOOKUP absent from autocomplete (Phase 0 regression guard)
  // -------------------------------------------------------------------------
  it('T_DENY4: XLOOKUP is absent from getFunctionSuggestions results', () => {
    const byFull = getFunctionSuggestions('XLOOKUP', 50)
    expect(byFull).not.toContain('XLOOKUP')

    const byPrefix = getFunctionSuggestions('X', 100)
    expect(byPrefix).not.toContain('XLOOKUP')
  })

  // -------------------------------------------------------------------------
  // T_DENY5 — nested deny: denied function inside IF branch is still blocked
  // -------------------------------------------------------------------------
  it('T_DENY5: =IF(TRUE,VLOOKUP(...),0) is blocked by deny guard', () => {
    const result = svc.evaluate('=IF(TRUE,VLOOKUP(A1,B1:C3,2,0),0)', pos)

    expect(result.value).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error!.type).toBe('#NAME?')
    expect(result.error!.message).toContain('VLOOKUP')
    expect(result.error!.message).toContain(DENY_MESSAGE_SUBSTRING)
    expect(result.error!.message).not.toContain(SPILL_MESSAGE_SUBSTRING)
  })

  // -------------------------------------------------------------------------
  // T_DENY6 — lowercase input is normalized: =vlookup(...) is denied
  // -------------------------------------------------------------------------
  it('T_DENY6: lowercase =vlookup is blocked by deny guard', () => {
    const result = svc.evaluate('=vlookup(A1,B1:C3,2,0)', pos)

    expect(result.value).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error!.type).toBe('#NAME?')
    expect(result.error!.message).toContain(DENY_MESSAGE_SUBSTRING)
  })

  // -------------------------------------------------------------------------
  // T_DENY7 — normal formula is unaffected by the deny guard
  // -------------------------------------------------------------------------
  it('T_DENY7: =SUM(1,2) evaluates normally to 3', () => {
    const result = svc.evaluate('=SUM(1,2)', pos)

    expect(result.value).toBe(3)
    expect(result.error).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // T_DENY8 — deny takes precedence over spill guard
  //   =IF(TRUE, VLOOKUP(...), FILTER(...)) — VLOOKUP is denied, FILTER is spill-deferred.
  //   The deny guard fires first; result must be the deny message, not the spill message.
  // -------------------------------------------------------------------------
  it('T_DENY8: deny guard fires before spill guard (denied + spill-deferred in same formula)', () => {
    const result = svc.evaluate('=IF(TRUE,VLOOKUP(A1,B1:C3,2,0),FILTER(A1:A3,A1:A3>0))', pos)

    expect(result.value).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('VLOOKUP')
    expect(result.error!.message).toContain(DENY_MESSAGE_SUBSTRING)
    expect(result.error!.message).not.toContain(SPILL_MESSAGE_SUBSTRING)
  })

  // -------------------------------------------------------------------------
  // T_DENY9 — deny guard does not trigger on string literals
  //   ="VLOOKUP(" is a plain string concatenation, not a function call.
  //   extractFunctionNames strips string literals before scanning.
  // -------------------------------------------------------------------------
  it('T_DENY9: string literal containing denied function name is not denied', () => {
    const result = svc.evaluate('="VLOOKUP("', pos)

    // Must be a plain string result, not an error of any kind
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('VLOOKUP(')
  })

  // -------------------------------------------------------------------------
  // T_DENY10 — large dataset + missing backend context → explicit '#VALUE!' error
  //   On a large dataset (isLargeDataset: true) without a backendEvalContext,
  //   a backend-required formula must return the explicit unavailable error.
  //   Small datasets fall through to the sync path, so isLargeDataset is required.
  // -------------------------------------------------------------------------
  it('T_DENY10: large dataset + missing backend context → explicit backend-unavailable error', () => {
    // Signal large dataset so the explicit backend-unavailable guard fires.
    // backendEvalContext is intentionally NOT set — that's what we're testing.
    svc.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      getRowData: () => new Map([
        [0, { 'col-a': 1, 'col-b': 10 }],
        [1, { 'col-a': 2, 'col-b': 20 }],
        [2, { 'col-a': 3, 'col-b': 30 }],
      ]),
      enqueueAggregate: () => {},
    })

    const result = svc.evaluate('=MEDIAN(A1:A3)', pos)

    expect(result.value).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error!.type).toBe('#VALUE!')
    expect(result.error!.message).toContain('backend evaluation')
    expect(result.error!.message).toContain('not available')
  })

  // -------------------------------------------------------------------------
  // T_DENY11 — backend-required formula with context present → routes to backend
  //   MEDIAN with a backendEvalContext set must enqueue a backend request and
  //   return CALC_PENDING_SENTINEL (null value, no error), not evaluate sync.
  // -------------------------------------------------------------------------
  it('T_DENY11: backend-required formula with backend context enqueues request and returns pending sentinel', () => {
    const enqueuedFormulas: string[] = []

    svc.setBackendEvalContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      totalRows: 3,
      loadedRowRange: { start: 0, end: 2 },
      columnLookup: {
        indexToId: (i: number) => ['col-a', 'col-b', 'col-c'][i] ?? `col-${i}`,
        idToIndex: (id: string) => ['col-a', 'col-b', 'col-c'].indexOf(id),
      },
      rowOrder: null,
      datasetId: 'test-dataset',
      enqueueBackendEval: (req) => {
        enqueuedFormulas.push(req.formula)
      },
    })
    svc.setBackendEvalCallback(() => {})

    const result = svc.evaluate('=MEDIAN(A1:A3)', pos)

    // Must return pending sentinel — not a sync value, not an error
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(FormulaService.CALC_PENDING_SENTINEL)
    // Must have enqueued exactly one backend request for this formula
    expect(enqueuedFormulas).toHaveLength(1)
    expect(enqueuedFormulas[0]).toContain('MEDIAN')
  })

  // -------------------------------------------------------------------------
  // T_DENY_PARITY — every function in DENIED_SET has a deny evaluation test
  // -------------------------------------------------------------------------
  it('T_DENY_PARITY: every DENIED_SET function is covered by an explicit test case', () => {
    // Denied functions evaluated above
    const TESTED_DENIED: Record<string, string> = {
      VLOOKUP: '=VLOOKUP(A1,B1:C3,2,0)',
      XLOOKUP: '=XLOOKUP(A1,B1:B3,C1:C3)',
    }

    const missing: string[] = []
    for (const fn of DENIED_SET) {
      if (!TESTED_DENIED[fn]) {
        missing.push(fn)
      }
    }
    expect(
      missing,
      `DENIED_SET contains functions with no evaluation test: ${missing.join(', ')}. Add a T_DENY case for each.`
    ).toEqual([])

    // Also verify the recorded formulas actually produce deny errors
    for (const [fn, formula] of Object.entries(TESTED_DENIED)) {
      const result = svc.evaluate(formula, pos)
      expect(result.error?.message, `${fn}: expected deny error`).toContain(DENY_MESSAGE_SUBSTRING)
    }
  })
})
