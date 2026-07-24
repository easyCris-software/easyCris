/**
 * useFilterHistory.ts
 *
 * Custom hook that owns the view-filter config and its undo stack.
 *
 * API:
 *   viewFilterConfig  - current active filter (null = no filter)
 *   filterHistory     - stack of past configs (oldest first); max 20 entries
 *   applyFilter(cfg|updater) - push current config to history, activate new config.
 *                              Accepts a (prev => next) updater function for safe
 *                              sequential merges.  No-op if resolved config is deeply
 *                              equal to the current one (prevents dead undo steps).
 *   undoFilter()      - pop history and restore; returns true if undo happened
 *   clearFilter()     - reset config to null and clear all history
 *
 * Designed to slot into SpreadsheetView in place of the bare
 *   useState<FilterConfig | null>(null)
 * so that onUndo can call undoFilter() before falling through to dataset undo.
 *
 * Rapid-call safety:
 *   Both applyFilter and undoFilter update their respective refs *synchronously*
 *   (before the setState calls) so that back-to-back calls within the same React
 *   batch always operate on up-to-date values rather than stale closure snapshots.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { FilterConfig } from '@/services/dataTransformService'

const HISTORY_LIMIT = 20

type ConfigUpdater = (prev: FilterConfig | null) => FilterConfig | null

export function useFilterHistory() {
  const [viewFilterConfig, setViewFilterConfig] = useState<FilterConfig | null>(null)
  const [filterHistory, setFilterHistory] = useState<(FilterConfig | null)[]>([])

  // Refs kept in sync with state so rapid successive calls always see the latest
  // value without needing React to flush between calls.
  const currentRef = useRef<FilterConfig | null>(null)
  const historyRef = useRef<(FilterConfig | null)[]>([])

  useEffect(() => { currentRef.current = viewFilterConfig }, [viewFilterConfig])
  useEffect(() => { historyRef.current = filterHistory }, [filterHistory])

  const applyFilter = useCallback((newConfigOrUpdater: FilterConfig | null | ConfigUpdater) => {
    // Capture previous config before any mutation.
    const prev = currentRef.current
    const resolved =
      typeof newConfigOrUpdater === 'function'
        ? newConfigOrUpdater(prev)
        : newConfigOrUpdater

    // No-op guard: identical config must not push a dead undo step.
    if (JSON.stringify(resolved) === JSON.stringify(prev)) return

    // Synchronously update the ref so the next rapid call reads the right value.
    currentRef.current = resolved

    setFilterHistory(history => {
      const capped = history.length >= HISTORY_LIMIT ? history.slice(1) : history
      return [...capped, prev]        // push the captured *previous* config
    })
    setViewFilterConfig(resolved)
  }, [])

  const undoFilter = useCallback((): boolean => {
    const history = historyRef.current
    if (history.length === 0) return false

    const restored = history[history.length - 1] ?? null
    const newHistory = history.slice(0, -1)

    // Synchronously update both refs so rapid successive undos each see the
    // already-reduced history and already-restored config.
    historyRef.current = newHistory
    currentRef.current = restored

    setFilterHistory(newHistory)
    setViewFilterConfig(restored)
    return true
  }, [])

  const clearFilter = useCallback(() => {
    currentRef.current = null
    historyRef.current = []
    setFilterHistory([])
    setViewFilterConfig(null)
  }, [])

  return { viewFilterConfig, filterHistory, applyFilter, undoFilter, clearFilter }
}
