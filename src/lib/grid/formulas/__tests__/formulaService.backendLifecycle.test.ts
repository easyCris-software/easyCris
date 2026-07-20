/**
 * formulaService.backendLifecycle.test.ts
 *
 * Regression tests for the backend eval lifecycle bugs:
 *
 *   B4 (corrected): completion is accepted only if cellKey + requestId are both current
 *                   AND the dataset staleness guard passes. hasFormula gate is NOT used.
 *   B5: pending entry must NOT be consumed before the callback fires (prevents
 *       re-evaluation during callback from creating a second IPC request).
 *   B2: a backend eval that times out (or errors) must settle to #VALUE! — never
 *       leave the cell as CALC_PENDING_SENTINEL indefinitely.
 *   B8 (E2E invariant): every backend-routed formula resolves to value or error
 *                       within the lifetime of a pending entry. Orphaned sentinels
 *                       are illegal.
 *
 * Tests written RED against the current implementation. They turn GREEN after:
 *   - B5: injectBackendEvalResult deletes pending AFTER callback (not before)
 *   - B2: BACKEND_EVAL_TIMEOUT_MS constant exported from formulaService
 *   - B8: clearPendingBackendEval followed by evaluate() re-enqueues (no orphan)
 *   - B4: stale requestId is rejected without touching current pending
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFormulaService, FormulaService } from '../formulaService'
import type { CellPosition } from '../formulaTypes'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const COLUMNS = [
  { id: 'col-a' },
  { id: 'col-b' },
  { id: 'col-c' },
]

const ROW_DATA = new Map([
  [0, { 'col-a': 10, 'col-b': 1, 'col-c': 'foo' }],
  [1, { 'col-a': 20, 'col-b': 2, 'col-c': 'bar' }],
  [2, { 'col-a': 30, 'col-b': 3, 'col-c': 'baz' }],
])

// CellPosition is 1-based for both row and col (Excel-style, per formulaTypes.ts).
// Put the formula in column C so lifecycle tests do not trip the self-reference guard
// for backend formulas that read A/B ranges.
const POS: CellPosition = { row: 1, col: 3, sheet: 'Sheet1' }

type EnqueuedReq = {
  formula: string
  cellKey: string
  requestId: string
  rowOrderSlice?: { start: number; data: number[] }
}

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
    datasetId: 'lifecycle-test',
    enqueueBackendEval: (req: EnqueuedReq) => { spy.push(req) },
  }
}

// A formula that is definitely backend-routed (backendRequired: true in catalog)
// Uses row-range refs (not full-column) to ensure backend eval routing fires
const BACKEND_FORMULA = '=MAXIFS(A1:A3,B1:B3,">1")'

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('formulaService — backend eval lifecycle (B2/B4/B5/B8)', () => {
  let svc: FormulaService

  beforeEach(() => {
    svc = createFormulaService(() => ROW_DATA, COLUMNS)
  })

  afterEach(() => {
    vi.useRealTimers()
    svc.setBackendEvalContext(undefined)
    svc.setBackendEvalCallback(undefined)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // B5 — pending entry survives until AFTER the callback fires
  // ─────────────────────────────────────────────────────────────────────────

  it('B5_PENDING_ALIVE_DURING_CALLBACK: re-evaluate during callback does not create second IPC request', () => {
    /**
     * Current (broken) behaviour:
     *   injectBackendEvalResult deletes the pending entry BEFORE calling the
     *   callback.  If a re-render triggers evaluate() during the callback, the
     *   dedup check finds no pending entry → enqueues a second IPC request.
     *
     * Expected (fixed) behaviour:
     *   Pending entry is deleted AFTER the callback.  During the callback,
     *   evaluate() finds the still-alive pending entry → returns SENTINEL via
     *   dedup → no second enqueue.
     */
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))

    let evaluateDuringCallback: unknown = 'NOT_CALLED'
    svc.setBackendEvalCallback(() => {
      // Simulates a React re-render re-evaluating the same cell
      const result = svc.evaluate(BACKEND_FORMULA, POS)
      evaluateDuringCallback = result.value
    })

    svc.evaluate(BACKEND_FORMULA, POS)
    expect(requests).toHaveLength(1)

    const { cellKey, requestId } = requests[0]!
    svc.injectBackendEvalResult(cellKey, 42, requestId)

    // The re-evaluate during callback must return SENTINEL (dedup), not enqueue
    expect(
      evaluateDuringCallback,
      'evaluate() during callback must return SENTINEL (pending still alive)'
    ).toBe(FormulaService.CALC_PENDING_SENTINEL)

    // Only ONE IPC request — no second enqueue from within the callback
    expect(requests, 'second IPC enqueue must not occur during callback').toHaveLength(1)
  })

  it('B5_CALLBACK_RECEIVES_VALUE: callback receives the injected value', () => {
    const requests: EnqueuedReq[] = []
    const received: unknown[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((_cellKey, value) => { received.push(value) })

    svc.evaluate(BACKEND_FORMULA, POS)
    const { cellKey, requestId } = requests[0]!
    svc.injectBackendEvalResult(cellKey, 99.5, requestId)

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(99.5)
  })

  it('B5_ERROR_VALUE_DELIVERED: inject with #VALUE! string delivers to callback (never sentinel)', () => {
    /**
     * B8 sub-case: backend returns an error value (e.g. wrong arg count).
     * injectBackendEvalResult must deliver it to the callback so the cell
     * settles — not remain as CALC_PENDING_SENTINEL.
     */
    const requests: EnqueuedReq[] = []
    const received: unknown[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((_cellKey, value) => { received.push(value) })

    svc.evaluate(BACKEND_FORMULA, POS)
    const { cellKey, requestId } = requests[0]!
    const accepted = svc.injectBackendEvalResult(cellKey, '#VALUE!', requestId)

    expect(accepted).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toBe('#VALUE!')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // B4 — stale requestId rejected; current pending for same cell preserved
  // ─────────────────────────────────────────────────────────────────────────

  it('B4_STALE_REQUESTID_REJECTED: old requestId does not overwrite new pending for same cell', () => {
    /**
     * Scenario: formula entered → backend enqueued (req1).
     * Formula replaced in same cell → old pending cleared → new enqueue (req2).
     * Old result arrives with req1 → must be rejected.
     * req2 must still be injectable.
     */
    const requests: EnqueuedReq[] = []
    const received: Array<[string, unknown, string]> = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((cellKey, value, requestId) => {
      received.push([cellKey, value, requestId])
    })

    // First enqueue
    svc.evaluate(BACKEND_FORMULA, POS)
    expect(requests).toHaveLength(1)
    const req1 = requests[0]!

    // Simulate formula replacement: clear old, re-enqueue
    svc.clearPendingBackendEval(req1.cellKey, req1.requestId)
    svc.evaluate(BACKEND_FORMULA, POS)
    expect(requests).toHaveLength(2)
    const req2 = requests[1]!

    // Stale result from req1
    const rejected = svc.injectBackendEvalResult(req1.cellKey, 'stale-value', req1.requestId)
    expect(rejected, 'stale requestId must be rejected').toBe(false)
    expect(received, 'callback must not fire for stale result').toHaveLength(0)

    // Current result from req2 — must still work
    const accepted = svc.injectBackendEvalResult(req2.cellKey, 'current-value', req2.requestId)
    expect(accepted, 'current requestId must be accepted').toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]![1]).toBe('current-value')
  })

  it('B4_SAME_CELL_DIFFERENT_FORMULA: inject stale after formula content changed is rejected', () => {
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    // Enqueue formula A
    svc.evaluate(BACKEND_FORMULA, POS)
    const req1 = requests[0]!

    // Clear (simulate timeout or error clear) and enqueue a different formula
    svc.clearPendingBackendEval(req1.cellKey, req1.requestId)
    svc.evaluate('=MINIFS(A1:A3,B1:B3,">1")', POS)
    const req2 = requests[1]!

    // Old requestId arrives — must be rejected
    const rejected = svc.injectBackendEvalResult(req1.cellKey, 'old', req1.requestId)
    expect(rejected).toBe(false)

    // New requestId is still valid
    const accepted = svc.injectBackendEvalResult(req2.cellKey, 'new', req2.requestId)
    expect(accepted).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // B8 — no orphaned sentinel: cleared pending can be re-enqueued
  // ─────────────────────────────────────────────────────────────────────────

  it('B8_NO_ORPHAN_AFTER_CLEAR: evaluate() after clearPendingBackendEval re-enqueues', () => {
    /**
     * Invariant: a formula that had its pending cleared (by timeout or error)
     * must re-enqueue on next evaluate() call — the cell must NOT be stuck
     * permanently as CALC_PENDING_SENTINEL with nothing in flight.
     */
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    // First eval → enqueue
    svc.evaluate(BACKEND_FORMULA, POS)
    expect(requests).toHaveLength(1)
    const { cellKey, requestId } = requests[0]!

    // Simulate timeout/error: clear pending
    svc.clearPendingBackendEval(cellKey, requestId)

    // Next evaluate() must re-enqueue (cell is not orphaned)
    svc.evaluate(BACKEND_FORMULA, POS)
    expect(
      requests,
      'after clearPendingBackendEval, next evaluate must issue a new IPC request'
    ).toHaveLength(2)
  })

  it('B8_INJECT_AFTER_CLEAR_REJECTED: old requestId rejected after clear (no double-write)', () => {
    /**
     * After timeout clears the pending entry, if the backend eventually
     * responds with the old requestId, it must be rejected.
     */
    const requests: EnqueuedReq[] = []
    const received: unknown[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback((_k, v) => { received.push(v) })

    svc.evaluate(BACKEND_FORMULA, POS)
    const { cellKey, requestId } = requests[0]!

    // Timeout clears the entry
    svc.clearPendingBackendEval(cellKey, requestId)

    // Late-arriving result must not fire the callback
    const accepted = svc.injectBackendEvalResult(cellKey, 'late', requestId)
    expect(accepted).toBe(false)
    expect(received).toHaveLength(0)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // B2 — timeout constant is exported and has correct value
  // ─────────────────────────────────────────────────────────────────────────

  it('B2_TIMEOUT_CONSTANT: BACKEND_EVAL_TIMEOUT_MS is exported and equals 15000', () => {
    /**
     * The timeout duration must be a named constant so tests and the
     * SpreadsheetView timeout wrapper can reference the same value.
     * This test fails until FormulaService.BACKEND_EVAL_TIMEOUT_MS is added.
     */
    expect(
      (FormulaService as unknown as Record<string, unknown>).BACKEND_EVAL_TIMEOUT_MS,
      'FormulaService.BACKEND_EVAL_TIMEOUT_MS must be 15000'
    ).toBe(15_000)
  })

  it('B2_TIMEOUT_SETTLEMENT: never-resolving backend promise settles cell to #VALUE! after timeout', async () => {
    /**
     * Mirrors the timeout race that SpreadsheetView.enqueueBackendEval uses:
     *
     *   const result = await new Promise((resolve, reject) => {
     *     const id = setTimeout(() => reject(new Error('timed out')), TIMEOUT)
     *     backendPromise.then(resolve).catch(reject).finally(() => clearTimeout(id))
     *   })
     *   // catch path:
     *   injectBackendEvalResult(cellKey, '#VALUE!', requestId)
     *
     * When backendPromise never resolves, the timeout fires → catch → '#VALUE!'.
     * This proves the constant is wired correctly and the settlement path works.
     */
    vi.useFakeTimers()

    const received: Array<[string, unknown]> = []
    svc.setBackendEvalCallback((cellKey, value) => { received.push([cellKey, value]) })

    // enqueueBackendEval that mirrors SpreadsheetView's timeout race pattern exactly
    svc.setBackendEvalContext({
      ...makeBackendCtx([]),
      enqueueBackendEval: async (req: EnqueuedReq) => {
        const backendPromise: Promise<unknown> = new Promise(() => {}) // never resolves

        try {
          const result = await new Promise<unknown>((resolve, reject) => {
            const timeoutId = setTimeout(
              () => reject(new Error(`Backend eval timed out after ${FormulaService.BACKEND_EVAL_TIMEOUT_MS / 1000}s`)),
              FormulaService.BACKEND_EVAL_TIMEOUT_MS
            )
            backendPromise.then(resolve).catch(reject).finally(() => clearTimeout(timeoutId))
          })
          svc.injectBackendEvalResult(req.cellKey, result, req.requestId)
        } catch {
          svc.injectBackendEvalResult(req.cellKey, '#VALUE!', req.requestId)
        }
      },
    })

    // First evaluate — returns SENTINEL while backend request is in-flight
    const result = svc.evaluate(BACKEND_FORMULA, POS)
    expect(result.value, 'cell must be pending while backend request is in-flight').toBe(
      FormulaService.CALC_PENDING_SENTINEL
    )

    // Advance fake timers past the timeout
    await vi.runAllTimersAsync()

    // Cell must have settled to #VALUE! — never left as CALC_PENDING_SENTINEL
    expect(received, 'callback must have fired exactly once').toHaveLength(1)
    expect(received[0]![1], 'settled value must be #VALUE! (not sentinel)').toBe('#VALUE!')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // B8 — E2E sentinel invariant: dedup does not create permanent orphan
  // ─────────────────────────────────────────────────────────────────────────

  it('B8_DEDUP_RETURNS_SENTINEL: second evaluate before result arrives returns SENTINEL (not error)', () => {
    /**
     * While a backend request is in-flight, a second evaluate() for the same
     * formula at the same position must return CALC_PENDING_SENTINEL via
     * dedup — not enqueue a second IPC and not return an error.
     */
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    const result1 = svc.evaluate(BACKEND_FORMULA, POS)
    expect(result1.value).toBe(FormulaService.CALC_PENDING_SENTINEL)

    const result2 = svc.evaluate(BACKEND_FORMULA, POS)
    expect(result2.value, 'second evaluate must return SENTINEL (dedup)').toBe(FormulaService.CALC_PENDING_SENTINEL)
    expect(result2.error, 'second evaluate must not produce an error').toBeUndefined()

    // Dedup must not create a second IPC request
    expect(requests, 'dedup must suppress second IPC enqueue').toHaveLength(1)
  })

  it('B8_DIFFERENT_POS_INDEPENDENT: same formula at different positions gets independent pending entries', () => {
    /**
     * Guard: two different cells with the same formula must each get their
     * own pending entry and their own IPC request. Dedup is per cellKey, not
     * per formula string.
     */
    const requests: EnqueuedReq[] = []
    svc.setBackendEvalContext(makeBackendCtx(requests))
    svc.setBackendEvalCallback(() => {})

    const POS_A: CellPosition = { row: 1, col: 3, sheet: 'Sheet1' }
    const POS_B: CellPosition = { row: 2, col: 3, sheet: 'Sheet1' }

    svc.evaluate(BACKEND_FORMULA, POS_A)
    svc.evaluate(BACKEND_FORMULA, POS_B)

    expect(requests, 'each cell gets its own IPC request').toHaveLength(2)
    expect(requests[0]!.cellKey).not.toBe(requests[1]!.cellKey)
  })

  it('passes rowOrderSlice for backend formulas when only view filter is active', () => {
    const rows = new Map([
      [0, { 'col-a': 100, 'col-b': 1, 'col-c': 'foo' }],
      [1, { 'col-a': 1, 'col-b': 2, 'col-c': 'bar' }],
      [2, { 'col-a': 300, 'col-b': 3, 'col-c': 'baz' }],
    ])
    const requests: EnqueuedReq[] = []
    const filteredOrder = [2, 0]
    const filteredSvc = createFormulaService(() => rows, COLUMNS, () => filteredOrder)

    filteredSvc.setBackendEvalContext({
      ...makeBackendCtx(requests),
      isSorted: false,
      isGrouped: false,
      isViewFiltered: true,
      rowOrder: filteredOrder,
      totalRows: 3,
      loadedRowRange: { start: 0, end: 1 },
    })

    const result = filteredSvc.evaluate('=MEDIAN(A1:A2)', { row: 4, col: 3, sheet: 'Sheet1' })

    expect(result.value).toBe(FormulaService.CALC_PENDING_SENTINEL)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.rowOrderSlice).toEqual({ start: 0, data: [2, 0] })
  })

  it('passes scoped evaluation domain for full-column backend aggregate when view filter is active', () => {
    const aggregateRequests: Array<{ func: string; columnId: string; scopedRowOrder?: number[] }> = []
    const filteredOrder = [2, 0]
    const filteredSvc = createFormulaService(() => ROW_DATA, COLUMNS, () => filteredOrder)

    filteredSvc.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      isViewFiltered: true,
      scopedRowOrder: filteredOrder,
      getRowData: () => ROW_DATA,
      enqueueAggregate: (request) => {
        aggregateRequests.push({
          func: request.func,
          columnId: request.columnId,
          scopedRowOrder: request.scopedRowOrder,
        })
      },
    })

    const result = filteredSvc.evaluate('=SUM(A:A)', { row: 4, col: 3, sheet: 'Sheet1' })

    expect(result.value).toBe(FormulaService.CALC_PENDING_SENTINEL)
    expect(aggregateRequests).toEqual([
      expect.objectContaining({
        func: 'SUM',
        columnId: 'col-a',
        scopedRowOrder: [2, 0],
      }),
    ])
  })

  it('maps large row-range aggregates through view filter row order', () => {
    const aggregateRequests: Array<{
      startRow?: number
      endRow?: number
      rowIndices?: number[]
    }> = []
    const filteredOrder = Array.from({ length: 15_000 }, (_, index) => 14_999 - index)
    const filteredSvc = createFormulaService(() => ROW_DATA, COLUMNS, () => filteredOrder)

    filteredSvc.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      isViewFiltered: true,
      getRowData: () => ROW_DATA,
      enqueueAggregate: (request) => {
        aggregateRequests.push({
          startRow: request.startRow,
          endRow: request.endRow,
          rowIndices: request.rowIndices,
        })
      },
    })

    const result = filteredSvc.evaluate('=SUM(A1:A15000)', { row: 20_000, col: 3, sheet: 'Sheet1' })

    expect(result.value).toBe(FormulaService.CALC_PENDING_SENTINEL)
    expect(aggregateRequests).toHaveLength(1)
    expect(aggregateRequests[0]!.startRow).toBeUndefined()
    expect(aggregateRequests[0]!.endRow).toBeUndefined()
    expect(aggregateRequests[0]!.rowIndices?.slice(0, 3)).toEqual([14_999, 14_998, 14_997])
    expect(aggregateRequests[0]!.rowIndices?.slice(-3)).toEqual([2, 1, 0])
  })

  it('returns #VALUE! for full-column aggregate when view filter matches zero rows', () => {
    const enqueueAggregate = vi.fn()
    const filteredSvc = createFormulaService(() => ROW_DATA, COLUMNS, () => [])

    filteredSvc.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      isViewFiltered: true,
      scopedRowOrder: [],
      getRowData: () => ROW_DATA,
      enqueueAggregate,
    })

    const result = filteredSvc.evaluate('=SUM(A:A)', { row: 4, col: 3, sheet: 'Sheet1' })

    expect(result.value).toBeNull()
    expect(result.error?.type).toBe('#VALUE!')
    expect(result.error?.message).toMatch(/Advanced Filter dropdown option under Data/i)
    expect(enqueueAggregate).not.toHaveBeenCalled()
    expect((filteredSvc as any).pendingAggregates.get('3:col-c')).toBeUndefined()
  })

  it('returns #VALUE! for full-column aggregate when view filter scope is too large for IPC', () => {
    const enqueueAggregate = vi.fn()
    const filteredOrder = Array.from({ length: 50_001 }, (_, index) => index)
    const filteredSvc = createFormulaService(() => ROW_DATA, COLUMNS, () => filteredOrder)

    filteredSvc.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      isViewFiltered: true,
      scopedRowOrder: filteredOrder,
      getRowData: () => ROW_DATA,
      enqueueAggregate,
    })

    const result = filteredSvc.evaluate('=SUM(A:A)', { row: 60_000, col: 3, sheet: 'Sheet1' })

    expect(result.value).toBeNull()
    expect(result.error?.type).toBe('#VALUE!')
    expect(result.error?.message).toMatch(/Advanced Filter dropdown option under Data/i)
    expect(enqueueAggregate).not.toHaveBeenCalled()
    expect((filteredSvc as any).pendingAggregates.get('59999:col-c')).toBeUndefined()
  })

  it('returns #VALUE! for filtered large row-range aggregate when row scope is too large for IPC', () => {
    const enqueueAggregate = vi.fn()
    const filteredOrder = Array.from({ length: 100_000 }, (_, index) => index)
    const filteredSvc = createFormulaService(() => ROW_DATA, COLUMNS, () => filteredOrder)

    filteredSvc.setAsyncAggregateContext({
      isLargeDataset: true,
      isSorted: false,
      isGrouped: false,
      isViewFiltered: true,
      getRowData: () => ROW_DATA,
      enqueueAggregate,
    })

    const result = filteredSvc.evaluate('=SUM(A1:A100000)', { row: 120_000, col: 3, sheet: 'Sheet1' })

    expect(result.value).toBeNull()
    expect(result.error?.type).toBe('#VALUE!')
    expect(result.error?.message).toMatch(/Advanced Filter dropdown option under Data/i)
    expect(enqueueAggregate).not.toHaveBeenCalled()
    expect((filteredSvc as any).pendingAggregates.get('119999:col-c')).toBeUndefined()
  })
})
