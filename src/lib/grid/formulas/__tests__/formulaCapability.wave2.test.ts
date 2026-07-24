/**
 * formulaCapability.wave2.test.ts — Wave 2 TDD gate
 *
 * Routing + wiring tests for all 27 Wave 2 backend-required scalar functions.
 * (GAMMALN is Wave 2 catalog but sync-only — tested separately in
 *  formulaCapability.syncExceptions.test.ts.)
 *
 * Test structure mirrors formulaCapability.wave1.test.ts.
 *
 * ── ROUTING tests ─────────────────────────────────────────────────────────
 *   evaluate() must return CALC_PENDING_SENTINEL and enqueue exactly one request.
 *
 * ── WIRING tests ──────────────────────────────────────────────────────────
 *   - Matching requestId fires callback, returns true.
 *   - Stale requestId rejected, returns false.
 *   - Duplicate evaluate reuses pending entry (no re-enqueue).
 *
 * ── Parity gates ──────────────────────────────────────────────────────────
 *   PARITY_CATALOG:              every WAVE2_MANIFEST entry is scalar + backendRequired in catalog.
 *   PARITY_NOT_SPILL:            no Wave 2 entry appears in SPILL_DEFERRED_SET.
 *   PARITY_BACKEND_PROMOTED_COUNT: WAVE2_BACKEND_PROMOTED has exactly 27 entries.
 *                                  Fails fast if an entry is accidentally added or removed.
 *
 * Test dataset:
 *   row 0: col-a=10, col-b=1,  col-c='foo'
 *   row 1: col-a=20, col-b=2,  col-c='bar'
 *   row 2: col-a=30, col-b=3,  col-c='baz'
 *   A=col-a, B=col-b, C=col-c
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFormulaService, FormulaService } from '../formulaService'
import { FORMULA_CATALOG, SPILL_DEFERRED_SET, WAVE2_CATALOG_SET } from '../formulaCatalog'
import { WAVE2_MANIFEST, WAVE2_BACKEND_PROMOTED, WAVE2_FN_SET } from '../wave2Registry'
import type { CellPosition } from '../formulaTypes'

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
    datasetId: 'wave2-test',
    enqueueBackendEval: (req: EnqueuedReq) => { spy.push(req) },
  }
}

describe('formulaCapability — Wave 2 routing + wiring (TDD gate)', () => {
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

  it('PARITY_CATALOG: every WAVE2_MANIFEST entry is scalar + backendRequired in the catalog', () => {
    const violations: string[] = []
    for (const { fn } of WAVE2_MANIFEST) {
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

  it('PARITY_NOT_SPILL: no Wave 2 entry is in SPILL_DEFERRED_SET', () => {
    const inSpill = WAVE2_MANIFEST.filter((e) => SPILL_DEFERRED_SET.has(e.fn)).map((e) => e.fn)
    expect(
      inSpill,
      `These Wave 2 entries are still in SPILL_DEFERRED_SET: ${inSpill.join(', ')}`
    ).toEqual([])
  })

  it('PARITY_BACKEND_PROMOTED_COUNT: WAVE2_BACKEND_PROMOTED has exactly 27 entries', () => {
    expect(
      WAVE2_BACKEND_PROMOTED.length,
      `Expected 27 backend-promoted Wave 2 entries, got ${WAVE2_BACKEND_PROMOTED.length}. ` +
      `Functions: ${[...WAVE2_FN_SET].join(', ')}`
    ).toBe(27)
  })

  it('PARITY_REV_CATALOG: catalog wave2 entries ⊆ WAVE2_FN_SET + {GAMMALN} (sync exception)', () => {
    // Every catalog entry tagged promotionWave='wave2' must be in the manifest
    // OR be a known sync exception (GAMMALN). Catches catalog entries added without
    // a registry entry.
    const SYNC_EXCEPTIONS = new Set(['GAMMALN'])
    const notInManifest = [...WAVE2_CATALOG_SET].filter(
      (fn) => !WAVE2_FN_SET.has(fn) && !SYNC_EXCEPTIONS.has(fn)
    )
    expect(
      notInManifest,
      `Catalog has these wave2-tagged entries not in WAVE2_MANIFEST or sync exceptions: ` +
      `${notInManifest.join(', ')}. Add to wave2Registry.ts or mark as sync exception.`
    ).toEqual([])
  })

  it('PARITY_REV_MANIFEST: WAVE2_FN_SET entries all have promotionWave=wave2 in catalog', () => {
    // Every manifest entry must be tagged in catalog. Catches manifest drift after
    // catalog edits.
    const notTagged = [...WAVE2_FN_SET].filter((fn) => {
      const entry = FORMULA_CATALOG.find((e) => e.name === fn)
      return !entry || entry.promotionWave !== 'wave2'
    })
    expect(
      notTagged,
      `These WAVE2_MANIFEST entries are missing promotionWave='wave2' in catalog: ` +
      `${notTagged.join(', ')}`
    ).toEqual([])
  })

  // -------------------------------------------------------------------------
  // ROUTING — all Wave 2 entries are backend-required
  // -------------------------------------------------------------------------

  describe('Routing — backend-required entries return CALC_PENDING_SENTINEL', () => {
    for (const { fn, routingFormula } of WAVE2_BACKEND_PROMOTED) {
      it(`${fn}: returns CALC_PENDING_SENTINEL and enqueues exactly one request`, () => {
        const requests: EnqueuedReq[] = []
        svc.setBackendEvalContext(makeBackendCtx(requests))
        svc.setBackendEvalCallback(() => {})

        const result = svc.evaluate(routingFormula, POS)

        expect(result.error, `${fn}: must not return any error`).toBeUndefined()
        expect(result.value, `${fn}: must return CALC_PENDING_SENTINEL`).toBe(
          FormulaService.CALC_PENDING_SENTINEL
        )
        expect(requests, `${fn}: must enqueue exactly one request`).toHaveLength(1)
        expect(
          requests[0]!.formula.toUpperCase(),
          `${fn}: enqueued formula must contain function name`
        ).toContain(fn.toUpperCase())
      })
    }
  })

  // -------------------------------------------------------------------------
  // WIRING — requestId guard
  // -------------------------------------------------------------------------

  describe('Wiring — injectBackendEvalResult requestId guard', () => {
    for (const { fn, routingFormula } of WAVE2_BACKEND_PROMOTED) {
      describe(fn, () => {
        it('matching requestId fires callback and returns true', () => {
          const requests: EnqueuedReq[] = []
          const callbackArgs: Array<[string, unknown, string]> = []

          svc.setBackendEvalContext(makeBackendCtx(requests))
          svc.setBackendEvalCallback((cellKey, value, requestId) => {
            callbackArgs.push([cellKey, value, requestId])
          })

          svc.evaluate(routingFormula, POS)
          expect(requests).toHaveLength(1)

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
})
