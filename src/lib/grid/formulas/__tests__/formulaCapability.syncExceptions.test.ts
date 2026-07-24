/**
 * formulaCapability.syncExceptions.test.ts
 *
 * Behavior guard for scalar catalog entries that are backendRequired: false
 * but belong to a promotion wave (i.e. they were assessed during wave promotion
 * but intentionally left on the sync path due to backend gaps).
 *
 * Current exceptions:
 *   GAMMALN — Wave 2 catalog entry, backendRequired: false.
 *             Reason: formualizer-eval 0.4.3 has no GAMMALN registration
 *             (only a doc comment in combinatorics.rs). FFP handles it.
 *
 * Per-function assertions:
 *   - evaluate() returns a numeric value (no error)
 *   - NO backend enqueue fires (no CALC_PENDING_SENTINEL)
 *   - value is approx-correct (catches silent regression if FFP drops support)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFormulaService, FormulaService } from '../formulaService'
import type { CellPosition } from '../formulaTypes'

const COLUMNS = [{ id: 'col-a' }, { id: 'col-b' }, { id: 'col-c' }]

const ROW_DATA = new Map([
  [0, { 'col-a': 10, 'col-b': 1, 'col-c': 'foo' }],
  [1, { 'col-a': 20, 'col-b': 2, 'col-c': 'bar' }],
  [2, { 'col-a': 30, 'col-b': 3, 'col-c': 'baz' }],
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
    datasetId: 'sync-exceptions-test',
    enqueueBackendEval: (req: EnqueuedReq) => { spy.push(req) },
  }
}

describe('formulaCapability — sync-path exceptions (Wave catalog, backendRequired: false)', () => {
  let svc: FormulaService

  beforeEach(() => {
    svc = createFormulaService(() => ROW_DATA, COLUMNS)
  })

  afterEach(() => {
    svc.setBackendEvalContext(undefined)
    svc.setBackendEvalCallback(undefined)
    svc.setAsyncAggregateContext(undefined)
  })

  // ── GAMMALN ────────────────────────────────────────────────────────────────
  // Handled by fast-formula-parser (FFP). backendRequired: false in catalog.
  // GAMMALN(5) = ln(Γ(5)) = ln(24) ≈ 3.1780538303
  describe('GAMMALN — sync path, no backend enqueue', () => {
    it('returns numeric value approx ln(24) for GAMMALN(5)', () => {
      const requests: EnqueuedReq[] = []
      svc.setBackendEvalContext(makeBackendCtx(requests))
      svc.setBackendEvalCallback(() => {})

      const result = svc.evaluate('=GAMMALN(5)', POS)

      expect(result.error, 'GAMMALN: must not return any error').toBeUndefined()
      expect(result.value, 'GAMMALN: must not return CALC_PENDING_SENTINEL').not.toBe(
        FormulaService.CALC_PENDING_SENTINEL
      )
      expect(typeof result.value, 'GAMMALN: value must be a number').toBe('number')
      const v = result.value as number
      // ln(4!) = ln(24) ≈ 3.1780538303
      expect(Math.abs(v - 3.178053830347946)).toBeLessThan(1e-6)
    })

    it('does NOT enqueue a backend request', () => {
      const requests: EnqueuedReq[] = []
      svc.setBackendEvalContext(makeBackendCtx(requests))
      svc.setBackendEvalCallback(() => {})

      svc.evaluate('=GAMMALN(5)', POS)

      expect(requests, 'GAMMALN: sync function must not enqueue backend request').toHaveLength(0)
    })
  })
})
