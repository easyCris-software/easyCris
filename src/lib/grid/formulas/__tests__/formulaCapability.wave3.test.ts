/**
 * formulaCapability.wave3.test.ts — Wave 3 TDD gate
 *
 * Phase 4 of the non-spill enablement plan.
 * Gated behind Wave 1 + Wave 2 green (both now complete).
 *
 * LET and LAMBDA require backend routing (Formualizer) because
 * fast-formula-parser 1.0.19 has no LET/LAMBDA implementation.
 *
 * ── Parser constraint ────────────────────────────────────────────────────────
 *   formualizer-eval does NOT support the immediate self-invocation syntax
 *   =LAMBDA(x,x*2)(5) — the parser rejects the trailing '(' as unexpected.
 *   All LAMBDA tests use the LET-binding form instead:
 *     =LET(f, LAMBDA(x, x*2), f(5))
 *   This is the standard Excel form and the shape formualizer-eval handles.
 *
 * ── Plan-specified tests ──────────────────────────────────────────────────
 *   T_LET1:    =LET(x,5,x*2)                → 10  (literal-only, no cell refs)
 *   T_LET2:    =LET(x,A1,x+1) A1=10         → 11  (cell ref binding, recalc on change)
 *   T_LAMBDA1: =LET(f,LAMBDA(x,x*2),f(5))   → 10  (LAMBDA via LET binding)
 *   T_LAMBDA2: =MAP(A1:A3,LAMBDA(x,x*2))    → keep deferred (spill result)
 *
 * ── Routing ──────────────────────────────────────────────────────────────
 *   LET/LAMBDA: backendRequired: true → CALC_PENDING_SENTINEL + enqueue
 *
 * ── Parity guards ────────────────────────────────────────────────────────
 *   PARITY_CATALOG:              both functions are scalar + backendRequired in catalog
 *   PARITY_NOT_SPILL:            neither appears in SPILL_DEFERRED_SET after promotion
 *   PARITY_BACKEND_PROMOTED_COUNT: WAVE3_BACKEND_PROMOTED has exactly 2 entries
 *   PARITY_REV_CATALOG:          catalog wave3 entries ⊆ WAVE3_FN_SET
 *   PARITY_REV_MANIFEST:         WAVE3_FN_SET entries all tagged promotionWave=wave3
 *
 * Test dataset:
 *   row 0: col-a=10, col-b=1
 *   row 1: col-a=20, col-b=2   ← POS row (row: 1 in 0-based)
 *   row 2: col-a=30, col-b=3
 *   A=col-a, B=col-b (A1=10 in formula coords)
 *
 * NOTE: T_LET2 uses A1=10 (row 0 of col-a).
 *       =LET(x,A1,x+1) → 10+1 = 11
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFormulaService, FormulaService } from '../formulaService'
import { FORMULA_CATALOG, SPILL_DEFERRED_SET, WAVE3_CATALOG_SET } from '../formulaCatalog'
import { WAVE3_MANIFEST, WAVE3_BACKEND_PROMOTED, WAVE3_FN_SET } from '../wave3Registry'
import type { CellPosition } from '../formulaTypes'

const COLUMNS = [
  { id: 'col-a' },
  { id: 'col-b' },
]

const ROW_DATA = new Map([
  [0, { 'col-a': 10, 'col-b': 1 }],
  [1, { 'col-a': 20, 'col-b': 2 }],
  [2, { 'col-a': 30, 'col-b': 3 }],
])

const POS: CellPosition = { row: 1, col: 0, sheet: 'Sheet1' }

type EnqueuedReq = { formula: string; cellKey: string; requestId: string }

function makeBackendCtx(spy: EnqueuedReq[]) {
  return {
    isLargeDataset: true,
    isSorted: false,
    isGrouped: false,
    totalRows: 3,
    loadedRowRange: { start: 0, end: 2 },
    columnLookup: {
      indexToId: (i: number) => COLUMNS[i]?.id ?? `col-${i}`,
      idToIndex: (id: string) => COLUMNS.findIndex((c) => c.id === id),
    },
    rowOrder: null,
    datasetId: 'wave3-test',
    enqueueBackendEval: (req: EnqueuedReq) => { spy.push(req) },
  }
}

describe('formulaCapability — Wave 3 LET + LAMBDA (TDD gate)', () => {
  let svc: FormulaService

  beforeEach(() => {
    svc = createFormulaService(() => ROW_DATA, COLUMNS)
  })

  afterEach(() => {
    svc.setBackendEvalContext(undefined)
    svc.setBackendEvalCallback(undefined)
    svc.setAsyncAggregateContext(undefined)
  })

  // -------------------------------------------------------------------------
  // PARITY — catalog consistency
  // -------------------------------------------------------------------------

  it('PARITY_CATALOG: LET and LAMBDA are scalar + backendRequired in the catalog', () => {
    const violations: string[] = []
    for (const { fn } of WAVE3_BACKEND_PROMOTED) {
      const entry = FORMULA_CATALOG.find((e) => e.name === fn)
      if (!entry) {
        violations.push(`${fn}: missing from catalog`)
      } else if (entry.classification !== 'scalar') {
        violations.push(`${fn}: classification is '${entry.classification}', expected 'scalar'`)
      } else if (!entry.backendRequired) {
        violations.push(`${fn}: backendRequired is false, expected true`)
      }
    }
    expect(violations, `Catalog inconsistencies:\n${violations.join('\n')}`).toEqual([])
  })

  it('PARITY_NOT_SPILL: LET and LAMBDA are not in SPILL_DEFERRED_SET after promotion', () => {
    const inSpill = WAVE3_BACKEND_PROMOTED.filter(({ fn }) => SPILL_DEFERRED_SET.has(fn)).map(({ fn }) => fn)
    expect(
      inSpill,
      `These Wave 3 entries are still in SPILL_DEFERRED_SET: ${inSpill.join(', ')}`
    ).toEqual([])
  })

  it('PARITY_BACKEND_PROMOTED_COUNT: WAVE3_BACKEND_PROMOTED has exactly 2 entries', () => {
    expect(
      WAVE3_BACKEND_PROMOTED.length,
      `Expected 2 backend-promoted Wave 3 entries, got ${WAVE3_BACKEND_PROMOTED.length}. ` +
      `Functions: ${[...WAVE3_FN_SET].join(', ')}`
    ).toBe(2)
  })

  it('PARITY_REV_CATALOG: catalog wave3 entries ⊆ WAVE3_FN_SET', () => {
    const notInManifest = [...WAVE3_CATALOG_SET].filter((fn) => !WAVE3_FN_SET.has(fn))
    expect(
      notInManifest,
      `Catalog has these wave3-tagged entries not in WAVE3_MANIFEST: ` +
      `${notInManifest.join(', ')}. Add to wave3Registry.ts.`
    ).toEqual([])
  })

  it('PARITY_REV_MANIFEST: WAVE3_FN_SET entries all have promotionWave=wave3 in catalog', () => {
    const notTagged = [...WAVE3_FN_SET].filter((fn) => {
      const entry = FORMULA_CATALOG.find((e) => e.name === fn)
      return !entry || entry.promotionWave !== 'wave3'
    })
    expect(
      notTagged,
      `These WAVE3_MANIFEST entries are missing promotionWave='wave3' in catalog: ` +
      `${notTagged.join(', ')}`
    ).toEqual([])
  })

  // -------------------------------------------------------------------------
  // T_LET1 — literal-only binding: =LET(x,5,x*2) → 10
  // -------------------------------------------------------------------------

  it('T_LET1: LET(x,5,x*2) routes to backend and enqueues one request', () => {
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    const registryFormula = WAVE3_MANIFEST.find((e) => e.fn === 'LET')!.routingFormula
    const result = svc.evaluate(registryFormula, POS)

    expect(result.error, 'T_LET1: must not return any error').toBeUndefined()
    expect(result.value, 'T_LET1: must return CALC_PENDING_SENTINEL').toBe(
      FormulaService.CALC_PENDING_SENTINEL
    )
    expect(requests, 'T_LET1: must enqueue exactly one request').toHaveLength(1)
    expect(requests[0]!.formula.toUpperCase()).toContain('LET')
    expect(requests[0]!.formula, 'T_LET1: enqueued formula must match registry').toBe(registryFormula.replace(/^=/, ''))
  })

  it('T_LET1: injecting result 10 fires callback and resolves cell', () => {
    const requests: EnqueuedReq[] = []
    const callbackArgs: Array<[string, unknown, string]> = []

    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((cellKey, value, requestId) => {
      callbackArgs.push([cellKey, value, requestId])
    })

    svc.evaluate('=LET(x,5,x*2)', POS)
    const { cellKey, requestId } = requests[0]!
    const accepted = svc.injectBackendEvalResult(cellKey, 10, requestId)

    expect(accepted).toBe(true)
    expect(callbackArgs).toHaveLength(1)
    expect(callbackArgs[0]![1]).toBe(10)
  })

  // -------------------------------------------------------------------------
  // T_LET2 — cell reference binding: =LET(x,A1,x+1) with A1=10 → 11
  // -------------------------------------------------------------------------

  it('T_LET2: LET(x,A1,x+1) routes to backend (cell-ref binding)', () => {
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    const result = svc.evaluate('=LET(x,A1,x+1)', POS)

    expect(result.error, 'T_LET2: must not return any error').toBeUndefined()
    expect(result.value, 'T_LET2: must return CALC_PENDING_SENTINEL').toBe(
      FormulaService.CALC_PENDING_SENTINEL
    )
    expect(requests, 'T_LET2: must enqueue exactly one request').toHaveLength(1)
  })

  it('T_LET2: duplicate evaluate reuses pending entry (no re-enqueue)', () => {
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    svc.evaluate('=LET(x,A1,x+1)', POS)
    svc.evaluate('=LET(x,A1,x+1)', POS)

    expect(requests, 'T_LET2: second evaluate must reuse pending').toHaveLength(1)
  })

  it('T_LET2: stale requestId rejected', () => {
    const requests: EnqueuedReq[] = []
    const callbackArgs: unknown[] = []

    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((k, v, r) => callbackArgs.push([k, v, r]))

    svc.evaluate('=LET(x,A1,x+1)', POS)
    const { cellKey } = requests[0]!
    const accepted = svc.injectBackendEvalResult(
      cellKey, 99, 'aaaaaaaa-0000-0000-0000-000000000000'
    )

    expect(accepted).toBe(false)
    expect(callbackArgs).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // T_LAMBDA1 — LAMBDA via LET binding: =LET(f,LAMBDA(x,x*2),f(5)) → 10
  //
  // NOTE: =LAMBDA(x,x*2)(5) immediate self-invocation is NOT used here.
  //       The formualizer-eval parser rejects the trailing '(' as an
  //       unexpected token. The LET-binding form is the backend-proven shape.
  //       See formula_backend.rs test_wave3_lambda_self_invoke_unsupported.
  // -------------------------------------------------------------------------

  it('T_LAMBDA1: LET(f,LAMBDA(x,x*2),f(5)) routes to backend and enqueues one request', () => {
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    const registryFormula = WAVE3_MANIFEST.find((e) => e.fn === 'LAMBDA')!.routingFormula
    const result = svc.evaluate(registryFormula, POS)

    expect(result.error, 'T_LAMBDA1: must not return any error').toBeUndefined()
    expect(result.value, 'T_LAMBDA1: must return CALC_PENDING_SENTINEL').toBe(
      FormulaService.CALC_PENDING_SENTINEL
    )
    expect(requests, 'T_LAMBDA1: must enqueue exactly one request').toHaveLength(1)
    expect(requests[0]!.formula.toUpperCase()).toContain('LAMBDA')
    expect(requests[0]!.formula, 'T_LAMBDA1: enqueued formula must match registry').toBe(registryFormula.replace(/^=/, ''))
  })

  it('T_LAMBDA1: injecting result 10 fires callback', () => {
    const requests: EnqueuedReq[] = []
    const callbackArgs: Array<[string, unknown, string]> = []

    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((cellKey, value, requestId) => {
      callbackArgs.push([cellKey, value, requestId])
    })

    svc.evaluate('=LET(f,LAMBDA(x,x*2),f(5))', POS)
    const { cellKey, requestId } = requests[0]!
    const accepted = svc.injectBackendEvalResult(cellKey, 10, requestId)

    expect(accepted).toBe(true)
    expect(callbackArgs[0]![1]).toBe(10)
  })

  // -------------------------------------------------------------------------
  // T_LAMBDA2 — MAP with LAMBDA stays spill-deferred
  // MAP is a spill function; the guard must fire before backend routing.
  // -------------------------------------------------------------------------

  it('T_LAMBDA2: MAP(A1:A3,LAMBDA(x,x*2)) is still blocked by spill policy', () => {
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    const result = svc.evaluate('=MAP(A1:A3,LAMBDA(x,x*2))', POS)

    expect(result.error, 'T_LAMBDA2: must return a spill error').toBeDefined()
    expect(result.error!.message).toContain('Array function not supported')
    expect(requests, 'T_LAMBDA2: spill guard must fire before backend enqueue').toHaveLength(0)
  })
})
