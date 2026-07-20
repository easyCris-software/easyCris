/**
 * RNAseqNavigatorSection render-isolation regression tests
 *
 * Perf regression guards — not functional behavior tests.
 * These tests verify that subscription narrowing actually prevents unnecessary rerenders.
 *
 * B2: useShallow selector reference preserved when unrelated dataset is added
 *     Mechanism: if useShallow returns the same reference, Zustand's equality check
 *     passes → subscriber not notified → component does not rerender.
 *
 * Tests use the REAL useDataStore (no mock) so real Zustand state transitions are observed.
 */

import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDataStore } from '@/store/data-store'
import { useShallow } from 'zustand/react/shallow'
import type { Dataset } from '@/store/data-store'

// ---------------------------------------------------------------------------
// Minimal dataset factory — only required fields
// ---------------------------------------------------------------------------
const makeDataset = (id: string, dataRowCount: number): Dataset => ({
  id,
  name: id,
  rowCount: dataRowCount + 50,
  dataRowCount,
  columnCount: 2,
  columns: [],
  importedAt: new Date(),
  modifiedAt: new Date(),
})

// ---------------------------------------------------------------------------
// Module mocks — only what is needed to avoid side effects; data-store is real
// ---------------------------------------------------------------------------
vi.mock('@/store/rnaseq-store', () => ({
  useRNAseqStore: Object.assign(
    (sel?: (s: unknown) => unknown) => {
      const state = { activeProjectId: null as string | null }
      return sel ? sel(state) : state
    },
    {
      getState: vi.fn().mockReturnValue({
        setActiveProject: vi.fn(),
        setActiveTab: vi.fn(),
        createProjectWithBootstrap: vi.fn(),
        deleteProject: vi.fn(),
      }),
    }
  ),
  useRNAseqProjects: vi.fn().mockReturnValue([]),
}))

vi.mock('@/store/app-store', () => ({
  useAppStore: (sel?: (s: unknown) => unknown) => {
    const state = { families: [] }
    return sel ? sel(state) : state
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/services/cacheService', () => ({
  default: { removeDataset: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RNAseqNavigatorSection dataStore subscription isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset real data-store between tests
    useDataStore.setState({ datasets: [] })
  })

  // -------------------------------------------------------------------------
  // B2: useShallow selector returns the same object reference (stable identity)
  //     when an unrelated dataset is added to the store.
  //     Same reference → Zustand shallow-equality check passes →
  //     component subscriber NOT notified → no rerender.
  // -------------------------------------------------------------------------
  it('B2: selector reference stable when unrelated dataset added (no rerender triggered)', () => {
    const linkedIds = ['counts-ds', 'meta-ds']
    const linkedIdsSet = new Set(linkedIds)

    // Seed store with the project's linked datasets
    act(() => {
      useDataStore.setState({
        datasets: [
          makeDataset('counts-ds', 50),
          makeDataset('meta-ds', 30),
        ],
      })
    })

    // Mirror the exact selector used in RNAseqNavigatorSection
    const { result } = renderHook(() =>
      useDataStore(
        useShallow((s) => {
          const record: Record<string, 'scaffold' | 'data'> = {}
          for (const ds of s.datasets) {
            if (!linkedIdsSet.has(ds.id)) continue
            const usable = ds.dataRowCount ?? ds.rowCount ?? 0
            record[ds.id] = usable > 0 ? 'data' : 'scaffold'
          }
          return record
        })
      )
    )

    const before = result.current

    // Add a dataset that is NOT in linkedIds — status record should not change
    act(() => {
      useDataStore.getState().addDataset(makeDataset('unrelated-ds', 99))
    })

    // Same reference = useShallow returned the cached result = subscriber not notified
    expect(result.current).toBe(before)
  })

  // -------------------------------------------------------------------------
  // B2b: selector returns a NEW reference when a linked dataset's status changes.
  //      Ensures the selector is not over-memoising — real changes DO trigger renders.
  // -------------------------------------------------------------------------
  it('B2b: selector returns new reference when linked dataset status changes (rerender allowed)', () => {
    const linkedIds = ['counts-ds', 'meta-ds']
    const linkedIdsSet = new Set(linkedIds)

    act(() => {
      useDataStore.setState({
        datasets: [
          makeDataset('counts-ds', 0),  // scaffold initially
          makeDataset('meta-ds', 0),
        ],
      })
    })

    const { result } = renderHook(() =>
      useDataStore(
        useShallow((s) => {
          const record: Record<string, 'scaffold' | 'data'> = {}
          for (const ds of s.datasets) {
            if (!linkedIdsSet.has(ds.id)) continue
            const usable = ds.dataRowCount ?? ds.rowCount ?? 0
            record[ds.id] = usable > 0 ? 'data' : 'scaffold'
          }
          return record
        })
      )
    )

    const before = result.current
    expect(before['counts-ds']).toBe('scaffold')

    // Promote counts-ds from scaffold → data
    act(() => {
      useDataStore.setState((s) => ({
        datasets: s.datasets.map((d) =>
          d.id === 'counts-ds' ? { ...d, dataRowCount: 50 } : d
        ),
      }))
    })

    // Different reference — status changed → rerender is correct
    expect(result.current).not.toBe(before)
    expect(result.current['counts-ds']).toBe('data')
  })
})
