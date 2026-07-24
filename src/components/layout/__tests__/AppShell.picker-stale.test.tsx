/**
 * AppShell.picker-stale.test.tsx
 *
 * TDD tests for AppShell logic patterns that cannot be tested by rendering
 * AppShell directly (too many heavy dependencies).
 *
 * Tests:
 *   PICKER_STALE_BROKEN_PATTERN   - broken stale guard allows stale open
 *   PICKER_STALE_FIXED_PATTERN    - fixed stale guard discards stale load
 *   PICKER_LOAD_ERROR_LOGGED      - fetch failure is warned to console
 *   TRANSFORM_ALWAYS_WARNS_PATTERN - handleApplyAdvancedFilter contract:
 *                                    config → setPendingTransform + showWarning,
 *                                    never calls applyTransform directly
 */

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState, useEffect, useRef, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Hook that mirrors the BROKEN handleOpenFilterPicker stale guard
// (ref.current is set to dataset.id, then compared against that same id)
// ---------------------------------------------------------------------------

function useBrokenPickerGuard(
  datasetId: string | null,
  loadFn: (id: string) => Promise<string[]>
) {
  const [open, setOpen] = useState(false)
  const [columns, setColumns] = useState<string[]>([])
  const requestDatasetIdRef = useRef<string | null>(null)

  const openPicker = useCallback(async () => {
    if (!datasetId) return
    const capturedId = datasetId
    // BUG: sets ref to captured id, then compares ref against captured id —
    //      comparison is always false (capturedId === capturedId)
    requestDatasetIdRef.current = capturedId
    try {
      const cols = await loadFn(capturedId)
      if (requestDatasetIdRef.current !== capturedId) return   // NEVER fires
      setColumns(cols)
      setOpen(true)
    } catch { /* ignore */ }
  }, [datasetId, loadFn])

  return { open, columns, openPicker }
}

// ---------------------------------------------------------------------------
// Hook that mirrors the FIXED handleOpenFilterPicker stale guard
// (a live ref is kept in sync with current datasetId via an effect)
// ---------------------------------------------------------------------------

function useFixedPickerGuard(
  datasetId: string | null,
  loadFn: (id: string) => Promise<string[]>
) {
  const [open, setOpen] = useState(false)
  const [columns, setColumns] = useState<string[]>([])
  // Always reflects the CURRENT datasetId — updated by effect, not by the load
  const activeDatasetIdRef = useRef<string | null>(datasetId)
  useEffect(() => {
    activeDatasetIdRef.current = datasetId
  }, [datasetId])

  const openPicker = useCallback(async () => {
    if (!datasetId) return
    const capturedId = datasetId
    try {
      const cols = await loadFn(capturedId)
      // Guard: compare live ref (current dataset) against what we started with
      if (activeDatasetIdRef.current !== capturedId) return
      setColumns(cols)
      setOpen(true)
    } catch (err) {
      console.warn('[picker] Failed to load filter columns:', err)
    }
  }, [datasetId, loadFn])

  return { open, columns, openPicker }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppShell picker stale-dataset guard — pattern proof', () => {
  it('PICKER_STALE_BROKEN_PATTERN: broken guard does NOT protect against stale open when dataset changes mid-flight', async () => {
    let resolveLoad!: (cols: string[]) => void
    const loadFn = vi.fn(
      (_id: string) => new Promise<string[]>((res) => { resolveLoad = res })
    )

    const { result, rerender } = renderHook(
      ({ datasetId }: { datasetId: string | null }) =>
        useBrokenPickerGuard(datasetId, loadFn),
      { initialProps: { datasetId: 'ds-A' } }
    )

    // Start load for dataset A
    act(() => { void result.current.openPicker() })

    // Switch to dataset B before load completes
    rerender({ datasetId: 'ds-B' })

    // Resolve the stale load for A
    await act(async () => { resolveLoad(['col1', 'col2']) })

    // BUG: broken guard lets the stale result through → picker opens with ds-A data
    expect(result.current.open).toBe(true)   // still opens — this is the BUG
  })

  it('PICKER_STALE_FIXED_PATTERN: fixed guard discards stale load when dataset changes mid-flight', async () => {
    let resolveLoad!: (cols: string[]) => void
    const loadFn = vi.fn(
      (_id: string) => new Promise<string[]>((res) => { resolveLoad = res })
    )

    const { result, rerender } = renderHook(
      ({ datasetId }: { datasetId: string | null }) =>
        useFixedPickerGuard(datasetId, loadFn),
      { initialProps: { datasetId: 'ds-A' } }
    )

    // Start load for dataset A
    act(() => { void result.current.openPicker() })

    // Switch to dataset B before load completes
    rerender({ datasetId: 'ds-B' })

    // Resolve the stale load for A
    await act(async () => { resolveLoad(['col1', 'col2']) })

    // Fixed guard detects staleness → picker stays closed
    expect(result.current.open).toBe(false)
    expect(result.current.columns).toHaveLength(0)
  })

  it('PICKER_LOAD_ERROR_LOGGED: fetch failure is warned to console, picker stays closed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loadFn = vi.fn().mockRejectedValue(new Error('network error'))

    const { result } = renderHook(() =>
      useFixedPickerGuard('ds-A', loadFn)
    )

    await act(async () => { await result.current.openPicker() })

    expect(result.current.open).toBe(false)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toMatch(/picker/i)
  })
})

// ---------------------------------------------------------------------------
// TRANSFORM_ALWAYS_WARNS — pattern proof
//
// AppShell's handleApplyAdvancedFilter must ALWAYS gate through the warning
// dialog (setPendingTransform + setShowTransformWarning) before any mutation.
// The pattern below mirrors that function's control flow exactly.
// ---------------------------------------------------------------------------

function makeTransformApplyHandler(
  isLocked: () => boolean,
  isBlocked: () => boolean,
  setPendingTransform: (t: object) => void,
  setShowWarning: (v: boolean) => void,
  _applyTransform: () => void   // injected to prove it is never called directly
) {
  return async function handleApplyTransform(config: object | null) {
    if (!config) return
    if (isLocked()) return
    if (isBlocked()) return
    // Always: set pending + show warning. Never call _applyTransform here.
    setPendingTransform({ type: 'filter', config })
    setShowWarning(true)
    // _applyTransform is called ONLY via the warning dialog's onConfirm.
  }
}

describe('AppShell transform-always-warns pattern', () => {
  it('TRANSFORM_ALWAYS_WARNS_PATTERN: applying config always gates through warning, never calls applyTransform directly', async () => {
    const setPendingTransform = vi.fn()
    const setShowWarning = vi.fn()
    const applyTransform = vi.fn()

    const handler = makeTransformApplyHandler(
      () => false,  // not locked
      () => false,  // not blocked
      setPendingTransform,
      setShowWarning,
      applyTransform
    )

    await handler({ groups: [] })

    expect(setPendingTransform).toHaveBeenCalledOnce()
    expect(setShowWarning).toHaveBeenCalledWith(true)
    // The critical invariant: applyTransform is NEVER called without user
    // confirmation via the warning dialog.
    expect(applyTransform).not.toHaveBeenCalled()
  })

  it('TRANSFORM_ALWAYS_WARNS_NULL_CONFIG: null config returns early without setting pending transform', async () => {
    const setPendingTransform = vi.fn()
    const setShowWarning = vi.fn()
    const applyTransform = vi.fn()

    const handler = makeTransformApplyHandler(
      () => false, () => false,
      setPendingTransform, setShowWarning, applyTransform
    )

    await handler(null)

    expect(setPendingTransform).not.toHaveBeenCalled()
    expect(setShowWarning).not.toHaveBeenCalled()
    expect(applyTransform).not.toHaveBeenCalled()
  })

  it('TRANSFORM_GUARD_LOCKED: when app is locked, handler returns early without warning', async () => {
    const setPendingTransform = vi.fn()
    const setShowWarning = vi.fn()

    const handler = makeTransformApplyHandler(
      () => true,   // isLocked — returns true
      () => false,
      setPendingTransform, setShowWarning, vi.fn()
    )

    await handler({ groups: [] })

    expect(setPendingTransform).not.toHaveBeenCalled()
    expect(setShowWarning).not.toHaveBeenCalled()
  })

  it('TRANSFORM_GUARD_BLOCKED: when transform is blocked, handler returns early without warning', async () => {
    const setPendingTransform = vi.fn()
    const setShowWarning = vi.fn()

    const handler = makeTransformApplyHandler(
      () => false,
      () => true,   // isBlocked — returns true
      setPendingTransform, setShowWarning, vi.fn()
    )

    await handler({ groups: [] })

    expect(setPendingTransform).not.toHaveBeenCalled()
    expect(setShowWarning).not.toHaveBeenCalled()
  })
})
