/**
 * formulaCapability.wave1.test.ts — Wave 1 TDD gate
 *
 * Tests are driven by wave1Registry.ts `status` field so one function can
 * turn GREEN independently of the others.
 *
 * ── For entries with status === 'spill-deferred' ──────────────────────────
 *   SPILL_BLOCK tests (always GREEN while not yet promoted):
 *     evaluate() must return a spill error, confirming the guard still works.
 *
 * ── For entries with status === 'promoted' ────────────────────────────────
 *   ROUTING tests (GREEN after catalog reclassification):
 *     backendRequired: true  → CALC_PENDING_SENTINEL + one enqueued request
 *     backendRequired: false → syncExpected value, no error
 *
 *   WIRING tests (backendRequired: true only):
 *     - matching requestId fires callback, returns true
 *     - stale requestId rejected, returns false
 *     - duplicate evaluate reuses pending entry (no re-enqueue)
 *
 * ── Parity gates (always run) ─────────────────────────────────────────────
 *   PARITY_PENDING_IN_SPILL:
 *     Every 'spill-deferred' entry must be in SPILL_DEFERRED_SET.
 *     Fails if catalog was updated but registry status wasn't.
 *
 *   PARITY_PROMOTED_NOT_IN_SPILL:
 *     Every 'promoted' entry must NOT be in SPILL_DEFERRED_SET.
 *     Fails if registry was updated but catalog classification wasn't.
 *
 * ── Promotion workflow ────────────────────────────────────────────────────
 *   1. formulaCatalog.ts: spill(...) → scalar(..., backendRequired: true/false)
 *   2. wave1Registry.ts:  status → 'promoted', set syncExpected if !backendRequired
 *   3. vitest wave1 → routing + wiring tests turn GREEN
 *   4. cargo test test_wave1_<fn> → Rust value test passes (backendRequired only)
 *   5. spillDeferred PARITY_REV fails until SPILL_CASES entry removed — remove it
 *
 * Test dataset (matches wave1Registry comment and Rust test helper):
 *   row 0: col-a=10, col-b=1,  col-c='foo'
 *   row 1: col-a=20, col-b=2,  col-c='bar'
 *   row 2: col-a=30, col-b=3,  col-c='baz'
 *   A=col-a, B=col-b, C=col-c
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFormulaService, FormulaService } from '../formulaService'
import { SPILL_DEFERRED_SET } from '../formulaCatalog'
import {
  WAVE1_MANIFEST,
  WAVE1_PENDING,
  WAVE1_BACKEND_PROMOTED,
  WAVE1_SYNC_PROMOTED,
} from '../wave1Registry'
import type { CellPosition } from '../formulaTypes'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SPILL_MSG = 'Array function not supported'

const COLUMNS = [
  { id: 'col-a' },
  { id: 'col-b' },
  { id: 'col-c' },
]

const ROW_DATA = new Map([
  [0, { 'col-a': 10, 'col-b': 1,  'col-c': 'foo' }],
  [1, { 'col-a': 20, 'col-b': 2,  'col-c': 'bar' }],
  [2, { 'col-a': 30, 'col-b': 3,  'col-c': 'baz' }],
])

// Formula cell position (row 1, col 0 — both 1-based internally)
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
    datasetId: 'wave1-test',
    enqueueBackendEval: (req: EnqueuedReq) => { spy.push(req) },
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('formulaCapability — Wave 1 routing + wiring (TDD gate)', () => {
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
  // PARITY — bidirectional catalog ↔ registry consistency
  // -------------------------------------------------------------------------

  it('PARITY_PENDING_IN_SPILL: every spill-deferred manifest entry is in SPILL_DEFERRED_SET', () => {
    const leaked = WAVE1_MANIFEST.filter(
      (e) => e.status === 'spill-deferred' && !SPILL_DEFERRED_SET.has(e.fn)
    )
    expect(
      leaked.map((e) => e.fn),
      `Catalog reclassified these but registry status is still 'spill-deferred'. ` +
      `Update wave1Registry.ts status → 'promoted': ${leaked.map((e) => e.fn).join(', ')}`
    ).toEqual([])
  })

  it('PARITY_PROMOTED_NOT_IN_SPILL: every promoted manifest entry is NOT in SPILL_DEFERRED_SET', () => {
    const stillBlocked = WAVE1_MANIFEST.filter(
      (e) => e.status === 'promoted' && SPILL_DEFERRED_SET.has(e.fn)
    )
    expect(
      stillBlocked.map((e) => e.fn),
      `Registry status is 'promoted' but catalog still has these as spill-deferred. ` +
      `Update formulaCatalog.ts classification → 'scalar': ${stillBlocked.map((e) => e.fn).join(', ')}`
    ).toEqual([])
  })

  // -------------------------------------------------------------------------
  // SPILL_BLOCK — pending entries must still return spill error
  //   These tests are GREEN while a function is unpromoteed,
  //   and disappear from the loop once status → 'promoted'.
  // -------------------------------------------------------------------------

  if (WAVE1_PENDING.length > 0) {
    describe('Spill-block — pending entries still return spill error', () => {
      for (const { fn, routingFormula } of WAVE1_PENDING) {
        it(`${fn}: still blocked with spill policy error`, () => {
          // Provide backend context so routing isn't rejected for a different reason
          const requests: EnqueuedReq[] = []
          svc.setBackendEvalContext(makeBackendCtx(requests))
          svc.setBackendEvalCallback(() => {})

          const result = svc.evaluate(routingFormula, POS)

          expect(
            result.error?.message,
            `${fn}: expected a defined error`
          ).toBeDefined()
          expect(
            result.error!.message,
            `${fn}: expected spill error, got: "${result.error!.message}"`
          ).toContain(SPILL_MSG)
          // Must not look like a deny error
          expect(result.error!.message).not.toContain('EasyCris')
          // Must not have enqueued anything — guard fires before routing
          expect(requests, `${fn}: spill guard must fire before backend enqueue`).toHaveLength(0)
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // ROUTING — backend-required promoted entries → CALC_PENDING_SENTINEL
  // -------------------------------------------------------------------------

  if (WAVE1_BACKEND_PROMOTED.length > 0) {
    describe('Routing — backend-required promoted entries return CALC_PENDING_SENTINEL', () => {
      for (const { fn, routingFormula } of WAVE1_BACKEND_PROMOTED) {
        it(`${fn}: returns CALC_PENDING_SENTINEL and enqueues exactly one backend request`, () => {
          const requests: EnqueuedReq[] = []
          svc.setBackendEvalContext(makeBackendCtx(requests))
          svc.setBackendEvalCallback(() => {})

          const result = svc.evaluate(routingFormula, POS)

          expect(result.error, `${fn}: must not return any error`).toBeUndefined()
          expect(result.value, `${fn}: must return CALC_PENDING_SENTINEL`).toBe(
            FormulaService.CALC_PENDING_SENTINEL
          )
          expect(requests, `${fn}: must enqueue exactly one request`).toHaveLength(1)
          // Enqueued formula must contain the function name (use plain toContain — no regex transforms)
          expect(
            requests[0]!.formula.toUpperCase(),
            `${fn}: enqueued formula must contain function name`
          ).toContain(fn.toUpperCase())
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // ROUTING — sync-promoted entries → direct syncExpected value
  // -------------------------------------------------------------------------

  if (WAVE1_SYNC_PROMOTED.length > 0) {
    describe('Routing — sync-promoted entries evaluate synchronously', () => {
      for (const { fn, routingFormula, syncExpected } of WAVE1_SYNC_PROMOTED) {
        it(`${fn}: evaluates synchronously to expected value`, () => {
          // No backend context needed for sync evaluation
          const result = svc.evaluate(routingFormula, POS)

          expect(result.error, `${fn}: must not return any error`).toBeUndefined()
          expect(result.value, `${fn}: expected syncExpected value`).toBe(syncExpected)
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // WIRING — backend-required promoted entries
  //   Table-driven over WAVE1_BACKEND_PROMOTED so any promoted function
  //   gets wiring coverage without hard-coupling to a specific function.
  // -------------------------------------------------------------------------

  if (WAVE1_BACKEND_PROMOTED.length > 0) {
    describe('Wiring — injectBackendEvalResult requestId guard', () => {
      for (const { fn, routingFormula } of WAVE1_BACKEND_PROMOTED) {
        describe(fn, () => {
          it('matching requestId fires callback and returns true', () => {
            const requests: EnqueuedReq[] = []
            const callbackArgs: Array<[string, unknown, string]> = []

            svc.setBackendEvalContext(makeBackendCtx(requests))
            svc.setBackendEvalCallback((cellKey, value, requestId) => {
              callbackArgs.push([cellKey, value, requestId])
            })

            svc.evaluate(routingFormula, POS)
            expect(requests, `${fn}: must have enqueued a request first`).toHaveLength(1)

            const { cellKey, requestId } = requests[0]!
            const accepted = svc.injectBackendEvalResult(cellKey, 42, requestId)

            expect(accepted).toBe(true)
            expect(callbackArgs).toHaveLength(1)
            expect(callbackArgs[0]![1]).toBe(42)
            expect(callbackArgs[0]![2]).toBe(requestId)
          })

          it('stale requestId is rejected — callback not fired, returns false', () => {
            const requests: EnqueuedReq[] = []
            const callbackArgs: Array<[string, unknown, string]> = []

            svc.setBackendEvalContext(makeBackendCtx(requests))
            svc.setBackendEvalCallback((cellKey, value, requestId) => {
              callbackArgs.push([cellKey, value, requestId])
            })

            svc.evaluate(routingFormula, POS)
            expect(requests).toHaveLength(1)

            const { cellKey } = requests[0]!
            const accepted = svc.injectBackendEvalResult(
              cellKey, 99, 'aaaaaaaa-0000-0000-0000-000000000000'
            )

            expect(accepted).toBe(false)
            expect(callbackArgs).toHaveLength(0)
          })

          it('duplicate evaluate reuses pending entry without re-enqueueing', () => {
            const requests: EnqueuedReq[] = []
            svc.setBackendEvalContext(makeBackendCtx(requests))
            svc.setBackendEvalCallback(() => {})

            svc.evaluate(routingFormula, POS)
            svc.evaluate(routingFormula, POS)

            expect(requests, `${fn}: second evaluate must reuse pending entry`).toHaveLength(1)
          })
        })
      }
    })
  }
})
