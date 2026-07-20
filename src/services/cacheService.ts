/**
 * Cache Service - Phase 4 Milestone 3 + Phase 5 (Hybrid Cache)
 *
 * Frontend service for dataset cache synchronization with Rust backend.
 * Provides debounced cell updates and batch operations.
 *
 * Phase 5: Adds DuckDB-backed storage for large datasets (>= 1M rows).
 * Large datasets use lazy Python DataProvider for analysis.
 */

import { invoke } from '@tauri-apps/api/core'
import { debounce } from 'lodash'
import type { ColumnClassificationStats } from '@/services/columnDataService'
import type { CellUpdate, GridMutationQueueState } from '@/lib/grid/types'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'
import { isPendingCalculation } from '@/utils/formulaSentinel'

/**
 * Storage info for dataset routing decisions
 * All-DuckDB: isLarge is now optional (all datasets use DuckDB)
 */
export interface DatasetStorageInfo {
  isLarge?: boolean // All-DuckDB: Optional, always true in practice
  duckdbPath?: string
}

export interface PasteBlockPayload {
  rows: number[]
  columnIds: string[]
  values: unknown[][]
}

export interface PasteBlockResult {
  /** Empty no-op range is 0..0. Hydration callers must check editedCells > 0. */
  rowStart: number
  rowEndExclusive: number
  editedCells: number
  oldValues: unknown[][]
}

export interface TestAggregatesResult {
  testName: string
  aggregates: Record<string, unknown>
}

export interface CreateEmptyDuckDBColumn {
  id: string
  name: string
  dtype?: string
}

export interface ColumnDuplicateSummary {
  duplicateIdCount: number
  duplicateRowCount: number
  duplicateExamples: string[]
  nonEmptyCount: number
}

/**
 * Column info for registering existing DuckDB
 * Phase 1: Project Persistence Fix
 */
export interface RegisterDuckdbColumn {
  id: string
  name: string
  dtype?: string
}

/**
 * Result from registering existing DuckDB
 * Phase 1: Project Persistence Fix
 */
export interface RegisterDuckdbResult {
  id: string
  rowCount: number
  columns: RegisterDuckdbColumn[]
}

export interface CacheCleanupSummary {
  removedFiles: number
  removedBytes: number
  skippedActiveFiles: number
}

export interface CacheHealthSummary {
  appCacheBytes?: number
  projectDataBytes?: number
  cacheBytes: number
  availableDiskBytes: number | null
}

export type DatasetInfrastructureWarmupStatus = 'idle' | 'warming' | 'ready' | 'failed'

/**
 * Cell update queued for batch sync
 */
interface PendingUpdate {
  datasetId: string
  row: number
  column: string
  value: unknown
}

/**
 * Pending updates queue for batch processing
 */
const pendingUpdates: PendingUpdate[] = []
const overlayFlushInFlight = new Map<string, Promise<void>>()
const gridMutationQueues = new Map<string, Array<{ queueId: string; updates: CellUpdate[] }>>()
const gridMutationQueueDrains = new Map<string, Promise<void>>()
const gridMutationQueueStates = new Map<string, GridMutationQueueState>()
const gridMutationQueueVersions = new Map<string, number>()
const gridMutationQueueClosing = new Set<string>()
let gridMutationQueuesClosingAll = false
const gridMutationQueueListeners = new Map<
  string,
  Set<(state: GridMutationQueueState) => void>
>()
const pendingOverlayFlushDatasets = new Set<string>()
const datasetInfrastructureWarmups = new Map<string, Promise<void>>()
const datasetInfrastructureWarmupStatuses = new Map<string, DatasetInfrastructureWarmupStatus>()
let gridMutationQueueCounter = 0

const defaultGridMutationQueueState = (): GridMutationQueueState => ({
  status: 'idle',
  failedQueueId: null,
  error: null,
})

function getGridMutationQueueStateSnapshot(datasetId: string): GridMutationQueueState {
  const state = gridMutationQueueStates.get(datasetId) ?? defaultGridMutationQueueState()
  return { ...state }
}

function setGridMutationQueueState(datasetId: string, state: GridMutationQueueState): void {
  gridMutationQueueStates.set(datasetId, state)
  const listeners = gridMutationQueueListeners.get(datasetId)
  if (!listeners) {
    return
  }
  const snapshot = { ...state }
  listeners.forEach((listener) => listener(snapshot))
}

function getGridMutationQueueVersion(datasetId: string): number {
  return gridMutationQueueVersions.get(datasetId) ?? 0
}

function bumpGridMutationQueueVersion(datasetId: string): number {
  const nextVersion = getGridMutationQueueVersion(datasetId) + 1
  gridMutationQueueVersions.set(datasetId, nextVersion)
  return nextVersion
}

function clearGridMutationQueueRuntimeState(datasetId: string): void {
  bumpGridMutationQueueVersion(datasetId)
  gridMutationQueues.delete(datasetId)
  gridMutationQueueDrains.delete(datasetId)
  gridMutationQueueStates.delete(datasetId)
  gridMutationQueueClosing.delete(datasetId)
  gridMutationQueueListeners.delete(datasetId)
  pendingOverlayFlushDatasets.delete(datasetId)
  datasetInfrastructureWarmups.delete(datasetId)
  datasetInfrastructureWarmupStatuses.delete(datasetId)
}

function clearAllGridMutationQueueRuntimeState(): void {
  const datasetIds = new Set<string>([
    ...gridMutationQueues.keys(),
    ...gridMutationQueueDrains.keys(),
    ...gridMutationQueueStates.keys(),
    ...gridMutationQueueClosing.values(),
    ...gridMutationQueueListeners.keys(),
    ...pendingOverlayFlushDatasets.values(),
    ...datasetInfrastructureWarmups.keys(),
    ...datasetInfrastructureWarmupStatuses.keys(),
  ])

  datasetIds.forEach((datasetId) => {
    clearGridMutationQueueRuntimeState(datasetId)
  })
  gridMutationQueuesClosingAll = false
}

function buildGridMutationQueueId(datasetId: string): string {
  gridMutationQueueCounter += 1
  return `${datasetId}:queue:${Date.now()}:${gridMutationQueueCounter}`
}

async function invokeUpdateCellsBatch(
  datasetId: string,
  updates: CellUpdate[]
): Promise<number> {
  const formattedUpdates = updates.map((u) => [u.row, u.column, u.value] as [number, string, unknown])
  return await invoke<number>('update_cells_batch', {
    datasetId,
    updates: formattedUpdates,
  })
}

function normalizeQueueError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  return 'Unknown grid mutation queue failure'
}

function getGridMutationQueueFailure(datasetId: string): Error | null {
  const state = getGridMutationQueueStateSnapshot(datasetId)
  if (state.status !== 'failed') {
    return null
  }
  return new Error(state.error ?? `Grid mutation queue for dataset ${datasetId} is failed`)
}

async function runStructuralAfterWarmup<T>(
  datasetId: string,
  run: () => Promise<T>
): Promise<T> {
  const warmup = datasetInfrastructureWarmups.get(datasetId)
  if (warmup) {
    await warmup
  }
  return await run()
}

function drainGridMutationQueue(datasetId: string): Promise<void> {
  const existing = gridMutationQueueDrains.get(datasetId)
  if (existing) {
    return existing
  }

  const version = getGridMutationQueueVersion(datasetId)

  const drainPromise = (async () => {
    while (true) {
      if (getGridMutationQueueVersion(datasetId) !== version) {
        return
      }

      const queue = gridMutationQueues.get(datasetId)
      const nextEntry = queue?.[0]

      if (!nextEntry) {
        if (getGridMutationQueueVersion(datasetId) === version) {
          setGridMutationQueueState(datasetId, defaultGridMutationQueueState())
        }
        return
      }

      if (getGridMutationQueueVersion(datasetId) === version) {
        setGridMutationQueueState(datasetId, {
          status: 'draining',
          failedQueueId: null,
          error: null,
        })
      }

      try {
        await invokeUpdateCellsBatch(datasetId, nextEntry.updates)
        if (getGridMutationQueueVersion(datasetId) !== version) {
          return
        }
        queue!.shift()
        if (queue!.length === 0) {
          gridMutationQueues.delete(datasetId)
          if (pendingOverlayFlushDatasets.has(datasetId)) {
            pendingOverlayFlushDatasets.delete(datasetId)
            try {
              await cacheService.flushOverlay(datasetId)
            } catch (error) {
              console.error('[CacheService] Background overlay flush failed:', error)
            }
          }
        }
      } catch (error) {
        if (getGridMutationQueueVersion(datasetId) === version) {
          setGridMutationQueueState(datasetId, {
            status: 'failed',
            failedQueueId: nextEntry.queueId,
            error: normalizeQueueError(error),
          })
        }
        throw error
      }
    }
  })()

  gridMutationQueueDrains.set(datasetId, drainPromise)
  drainPromise.then(
    () => {
      if (
        gridMutationQueueDrains.get(datasetId) === drainPromise &&
        getGridMutationQueueVersion(datasetId) === version
      ) {
        gridMutationQueueDrains.delete(datasetId)
      }
    },
    () => {
      if (
        gridMutationQueueDrains.get(datasetId) === drainPromise &&
        getGridMutationQueueVersion(datasetId) === version
      ) {
        gridMutationQueueDrains.delete(datasetId)
      }
    }
  )

  return drainPromise
}

/**
 * Dataset cache service for backend synchronization
 */
export const cacheService = {
  /**
   * Initialize cache with dataset on import
   */
  async setDataset(
    datasetId: string,
    rows: Record<string, unknown>[]
  ): Promise<void> {
    await invoke('set_dataset_cache', { datasetId, rows })
  },

  /**
   * Create an empty DuckDB table for manual data entry (All-DuckDB migration).
   */
  async createEmptyDuckDB(
    datasetId: string,
    columns: CreateEmptyDuckDBColumn[]
  ): Promise<void> {
    await invoke('create_empty_duckdb', { datasetId, columns })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
  },

  /**
   * Warm connection and dataset infrastructure off the interactive edit path.
   * Trigger is non-blocking; structural edits can join the same in-flight work.
   */
  triggerDatasetInfrastructureWarmup(datasetId: string): void {
    if (!datasetId) {
      return
    }
    if (datasetInfrastructureWarmupStatuses.get(datasetId) === 'ready') {
      return
    }
    if (datasetInfrastructureWarmups.has(datasetId)) {
      return
    }

    datasetInfrastructureWarmupStatuses.set(datasetId, 'warming')
    const warmup = invoke<void>('prewarm_dataset_infrastructure', { datasetId })
      .then(() => {
        datasetInfrastructureWarmupStatuses.set(datasetId, 'ready')
      })
      .catch((error) => {
        datasetInfrastructureWarmupStatuses.set(datasetId, 'failed')
        if (import.meta.env.DEV) {
          console.debug(`Dataset infrastructure warmup failed for ${datasetId}:`, error)
        }
      })
      .finally(() => {
        if (datasetInfrastructureWarmups.get(datasetId) === warmup) {
          datasetInfrastructureWarmups.delete(datasetId)
        }
      })

    datasetInfrastructureWarmups.set(datasetId, warmup)
  },

  async joinDatasetInfrastructureWarmup(datasetId: string): Promise<void> {
    await datasetInfrastructureWarmups.get(datasetId)
  },

  getDatasetInfrastructureWarmupStatus(datasetId: string): DatasetInfrastructureWarmupStatus {
    return datasetInfrastructureWarmupStatuses.get(datasetId) ?? 'idle'
  },

  /**
   * Update single cell immediately (for critical updates)
   */
  async updateCellImmediate(
    datasetId: string,
    row: number,
    column: string,
    value: unknown
  ): Promise<void> {
    if (isPendingCalculation(value)) {
      return
    }
    await invoke('update_cell', { datasetId, row, column, value })
  },

  /**
   * Queue cell update for debounced batch sync
   */
  queueCellUpdate(
    datasetId: string,
    row: number,
    column: string,
    value: unknown
  ): void {
    if (isPendingCalculation(value)) {
      return
    }
    pendingUpdates.push({ datasetId, row, column, value })
    flushPendingUpdatesDebounced()
  },

  /**
   * Update multiple cells in batch
   */
  async updateCellsBatch(
    datasetId: string,
    updates: Array<{ row: number; column: string; value: unknown }>
  ): Promise<number> {
    return await invokeUpdateCellsBatch(datasetId, updates)
  },

  async applyPasteBlock(
    datasetId: string,
    payload: PasteBlockPayload
  ): Promise<PasteBlockResult> {
    return await invoke<PasteBlockResult>('apply_paste_block', { datasetId, payload })
  },

  async enqueueGridMutationBatch(
    datasetId: string,
    updates: Array<{ row: number; column: string; value: unknown }>
  ): Promise<{ accepted: true; queueId: string }> {
    if (gridMutationQueuesClosingAll || gridMutationQueueClosing.has(datasetId)) {
      throw new Error(`Grid mutation queue for dataset ${datasetId} is closing`)
    }

    const currentState = getGridMutationQueueStateSnapshot(datasetId)
    if (currentState.status === 'failed') {
      throw new Error(
        currentState.error ?? `Grid mutation queue for dataset ${datasetId} is failed`
      )
    }

    const queueId = buildGridMutationQueueId(datasetId)
    if (updates.length === 0) {
      return { accepted: true, queueId }
    }

    const queue = gridMutationQueues.get(datasetId) ?? []
    queue.push({
      queueId,
      updates: updates.map((update) => ({ ...update })),
    })
    gridMutationQueues.set(datasetId, queue)

    void drainGridMutationQueue(datasetId).catch(() => undefined)

    return { accepted: true, queueId }
  },

  async flushGridMutationQueue(datasetId: string): Promise<void> {
    const failure = getGridMutationQueueFailure(datasetId)
    if (failure) {
      throw failure
    }

    if (!gridMutationQueues.has(datasetId) && !gridMutationQueueDrains.has(datasetId)) {
      return
    }

    await drainGridMutationQueue(datasetId)
  },

  async retryGridMutationQueue(datasetId: string): Promise<void> {
    const failure = getGridMutationQueueFailure(datasetId)
    if (!failure) {
      await this.flushGridMutationQueue(datasetId)
      return
    }

    setGridMutationQueueState(datasetId, {
      status: 'idle',
      failedQueueId: null,
      error: null,
    })

    await Promise.resolve()
    await drainGridMutationQueue(datasetId)
  },

  getGridMutationQueueState(datasetId: string): GridMutationQueueState {
    return getGridMutationQueueStateSnapshot(datasetId)
  },

  subscribeGridMutationQueue(
    datasetId: string,
    listener: (state: GridMutationQueueState) => void
  ): () => void {
    const listeners = gridMutationQueueListeners.get(datasetId) ?? new Set()
    listeners.add(listener)
    gridMutationQueueListeners.set(datasetId, listeners)
    listener(getGridMutationQueueStateSnapshot(datasetId))

    return () => {
      const current = gridMutationQueueListeners.get(datasetId)
      if (!current) {
        return
      }
      current.delete(listener)
      if (current.size === 0) {
        gridMutationQueueListeners.delete(datasetId)
      }
    }
  },

  scheduleOverlayFlush(datasetId: string): void {
    pendingOverlayFlushDatasets.add(datasetId)
    if (
      gridMutationQueues.has(datasetId) ||
      gridMutationQueueDrains.has(datasetId) ||
      getGridMutationQueueStateSnapshot(datasetId).status === 'failed'
    ) {
      return
    }

    pendingOverlayFlushDatasets.delete(datasetId)
    void this.flushOverlay(datasetId).catch((error) => {
      console.error('[CacheService] Background overlay flush failed:', error)
    })
  },

  /**
   * Get column data for analysis
   */
  async getColumnData(datasetId: string, columnId: string): Promise<unknown[]> {
    return await invoke<unknown[]>('get_column_data', { datasetId, columnId })
  },

  /**
   * Get multiple columns data
   */
  async getColumnsData(
    datasetId: string,
    columnIds: string[]
  ): Promise<Record<string, unknown[]>> {
    return await invoke<Record<string, unknown[]>>('get_columns_data', {
      datasetId,
      columnIds,
    })
  },

  /**
   * Get authoritative persisted column IDs for a dataset.
   */
  async getPersistedColumnIds(datasetId: string): Promise<string[]> {
    return await invoke<string[]>('get_persisted_column_ids', { datasetId })
  },

  /**
   * Get sampled column data (for plots on large datasets)
   */
  async getColumnsSampledData(
    datasetId: string,
    columnIds: string[],
    sampleSize: number,
    seed?: number
  ): Promise<Record<string, unknown[]>> {
    return await invoke<Record<string, unknown[]>>('get_columns_sampled_data', {
      datasetId,
      columnIds,
      sampleSize,
      seed: seed ?? null,
    })
  },

  /**
   * Get aggregated column data (group-by summaries)
   */
  async getColumnsAggregatedData(
    datasetId: string,
    groupBy: string[],
    aggregations: Array<{ columnId?: string | null; func: string; alias: string }>
  ): Promise<Record<string, unknown[]>> {
    return await invoke<Record<string, unknown[]>>('get_columns_aggregated_data', {
      datasetId,
      groupBy,
      aggregations,
    })
  },

  /**
   * Search column values using DuckDB (large dataset path)
   */
  async searchColumnsValues(
    datasetId: string,
    columnIds: string[],
    searchText: string,
    caseSensitive: boolean,
    wholeWord: boolean
  ): Promise<Array<{ modelRow: number; columnId: string; value: string }>> {
    return await invoke<Array<{ modelRow: number; columnId: string; value: string }>>(
      'search_columns_values',
      {
        datasetId,
        columnIds,
        searchText,
        caseSensitive,
        wholeWord,
      }
    )
  },

  /**
   * Get column classification stats for all columns
   * Uses DuckDB for large datasets and in-memory stats for small datasets.
   */
  async getAllColumnStats(datasetId: string): Promise<ColumnClassificationStats[]> {
    return await invoke<ColumnClassificationStats[]>('get_all_column_stats', {
      datasetId,
    })
  },

  /**
   * Get duplicate summary for a single column (trimmed, empty values ignored).
   */
  async getColumnDuplicateSummary(
    datasetId: string,
    columnId: string,
    maxExamples: number = 5
  ): Promise<ColumnDuplicateSummary> {
    return await invoke<ColumnDuplicateSummary>('get_column_duplicate_summary', {
      datasetId,
      columnId,
      maxExamples,
    })
  },

  /**
   * Flush dataset to Arrow file before test execution
   */
  async flushToArrow(datasetId: string): Promise<string> {
    return await invoke<string>('flush_dataset_to_arrow', { datasetId })
  },

  /**
   * Check if dataset is in cache
   */
  async hasDataset(datasetId: string): Promise<boolean> {
    return await invoke<boolean>('has_cached_dataset', { datasetId })
  },

  /**
   * Get cached row count
   */
  async getRowCount(datasetId: string): Promise<number> {
    return await invoke<number>('get_cached_row_count', { datasetId })
  },

  /**
   * Add a new column to all rows in a dataset
   * Returns the number of rows updated
   */
  async addColumn(
    datasetId: string,
    columnId: string,
    defaultValue: unknown = ''
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('add_column', { datasetId, columnId, defaultValue })
    )
  },

  /**
   * Insert an empty row at the given model-row index.
   * Existing rows at/after index are shifted down by one.
   */
  async insertRowAt(
    datasetId: string,
    rowIndex: number
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('insert_row_at', { datasetId, rowIndex })
    )
  },

  /**
   * Insert `count` empty rows at the given model-row index.
   * Existing rows at/after index are shifted down by `count`.
   */
  async insertRowsAt(
    datasetId: string,
    rowIndex: number,
    count: number
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('insert_rows_at', { datasetId, rowIndex, count })
    )
  },

  /**
   * Append `count` empty rows without shifting existing row indexes.
   */
  async appendRows(
    datasetId: string,
    count: number
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('append_rows', { datasetId, count })
    )
  },

  /**
   * Remove `count` rows from the physical end of the dataset without shifting.
   */
  async removeRowsFromEnd(
    datasetId: string,
    count: number
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('remove_rows_from_end', { datasetId, count })
    )
  },

  /**
   * Remove a row at the given model-row index.
   */
  async removeRowAt(
    datasetId: string,
    rowIndex: number
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('remove_row_at', { datasetId, rowIndex })
    )
  },

  /**
   * Remove a column from all rows in a dataset.
   */
  async removeColumn(
    datasetId: string,
    columnId: string
  ): Promise<number> {
    return await runStructuralAfterWarmup(
      datasetId,
      () => invoke<number>('remove_column', { datasetId, columnId })
    )
  },

  /**
   * Remove dataset from cache
   */
  async removeDataset(datasetId: string): Promise<boolean> {
    gridMutationQueueClosing.add(datasetId)
    try {
      await this.flushGridMutationQueue(datasetId)
      const removed = await invoke<boolean>('remove_dataset_cache', { datasetId })
      clearGridMutationQueueRuntimeState(datasetId)
      return removed
    } catch (error) {
      gridMutationQueueClosing.delete(datasetId)
      throw error
    }
  },

  /**
   * Remove dataset from cache with explicit project ID (project isolation cleanup).
   */
  async removeDatasetWithProject(projectId: string, datasetId: string): Promise<boolean> {
    gridMutationQueueClosing.add(datasetId)
    try {
      await this.flushGridMutationQueue(datasetId)
      const removed = await invoke<boolean>('remove_dataset_cache_with_project', {
        projectId,
        datasetId,
      })
      clearGridMutationQueueRuntimeState(datasetId)
      return removed
    } catch (error) {
      gridMutationQueueClosing.delete(datasetId)
      throw error
    }
  },

  /**
   * Clear all cached datasets
   */
  async clearAll(): Promise<void> {
    gridMutationQueuesClosingAll = true

    const datasetIds = new Set<string>([
      ...gridMutationQueues.keys(),
      ...gridMutationQueueDrains.keys(),
      ...gridMutationQueueStates.keys(),
      ...gridMutationQueueClosing.values(),
      ...gridMutationQueueListeners.keys(),
      ...pendingOverlayFlushDatasets.values(),
      ...datasetInfrastructureWarmups.keys(),
      ...datasetInfrastructureWarmupStatuses.keys(),
    ])

    for (const datasetId of datasetIds) {
      const failure = getGridMutationQueueFailure(datasetId)
      if (failure) {
        gridMutationQueuesClosingAll = false
        throw failure
      }
    }

    datasetIds.forEach((datasetId) => {
      gridMutationQueueClosing.add(datasetId)
    })

    try {
      for (const datasetId of datasetIds) {
        await this.flushGridMutationQueue(datasetId)
      }
      await invoke('clear_all_cache')
      clearAllGridMutationQueueRuntimeState()
    } catch (error) {
      gridMutationQueuesClosingAll = false
      datasetIds.forEach((datasetId) => {
        gridMutationQueueClosing.delete(datasetId)
      })
      throw error
    }
  },

  /**
   * Clear AppData cache entries for a specific project.
   */
  async clearCurrentProjectCache(projectId: string): Promise<CacheCleanupSummary> {
    return await invoke<CacheCleanupSummary>('clear_current_project_cache', { projectId })
  },

  /**
   * Clear all eligible unsaved/AppData cache files immediately.
   * Active in-use files are preserved.
   */
  async clearUnsavedAppCache(): Promise<CacheCleanupSummary> {
    return await invoke<CacheCleanupSummary>('clear_unsaved_app_cache')
  },

  /**
   * Compatibility alias for full unsaved/AppData clear.
   * Uses the same behavior as clearUnsavedAppCache.
   */
  async clearAllAppCache(): Promise<CacheCleanupSummary> {
    return await invoke<CacheCleanupSummary>('clear_all_app_cache')
  },

  /**
   * Return local cache/disk health summary for storage-pressure prompts.
   */
  async getCacheHealthSummary(): Promise<CacheHealthSummary> {
    return await invoke<CacheHealthSummary>('get_cache_health_summary')
  },

  /**
   * Flush all pending updates immediately (use before test execution)
   */
  async flushPendingUpdates(): Promise<void> {
    if (pendingUpdates.length === 0) return

    // Group updates by dataset
    const byDataset = new Map<string, Array<[number, string, unknown]>>()
    for (const update of pendingUpdates) {
      if (isPendingCalculation(update.value)) {
        continue
      }
      const existing = byDataset.get(update.datasetId) || []
      existing.push([update.row, update.column, update.value])
      byDataset.set(update.datasetId, existing)
    }

    // Clear queue
    pendingUpdates.length = 0

    // Send batch updates
    for (const [datasetId, updates] of byDataset) {
      try {
        await invoke('update_cells_batch', { datasetId, updates })
      } catch (error) {
        console.error(`Failed to sync cells for dataset ${datasetId}:`, error)
      }
    }
  },

  // =========================================================================
  // PHASE 5: HYBRID CACHE METHODS (DuckDB for large datasets)
  // =========================================================================

  /**
   * Check if dataset is stored in DuckDB (large dataset path)
   */
  async isLargeDataset(datasetId: string): Promise<boolean> {
    return await invoke<boolean>('is_large_dataset', { datasetId })
  },

  /**
   * Get storage info needed for analysis routing
   * Large datasets return duckdbPath for Python DataProvider
   */
  async getDatasetStorageInfo(datasetId: string): Promise<DatasetStorageInfo> {
    return await invoke<DatasetStorageInfo>('get_dataset_storage_info', { datasetId })
  },

  /**
   * Ensure backend cache reflects latest edits before read-heavy operations.
   * - Flushes pending UI edits
   * - Flushes overlay to DuckDB when dataset is DuckDB-backed
   */
  async ensureLatestCache(datasetId: string): Promise<void> {
    await cacheService.flushPendingUpdates()
    await cacheService.flushGridMutationQueue(datasetId)
    const storageInfo = await cacheService.getDatasetStorageInfo(datasetId)
    if (storageInfo?.duckdbPath || storageInfo?.isLarge) {
      await cacheService.flushOverlay(datasetId)
    }
  },

  async ensureDuckDbDataset(
    datasetId: string,
    columns: CreateEmptyDuckDBColumn[]
  ): Promise<DatasetStorageInfo> {
    const result = await invoke<DatasetStorageInfo>('ensure_duckdb_dataset', { datasetId, columns })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
    return result
  },

  /**
   * Flush overlay edits to DuckDB (required before sort/export/analysis)
   * Call this before any operation that needs consistent data
   */
  async flushOverlay(datasetId: string): Promise<void> {
    const existing = overlayFlushInFlight.get(datasetId)
    if (existing) {
      logRuntimeDebug('paste', 'cache_flush_overlay_deduped', { datasetId })
      return await existing
    }

    const startedAt = Date.now()
    logRuntimeDebug('paste', 'cache_flush_overlay_start', { datasetId })
    const pending = invoke('flush_overlay', { datasetId }).then(() => undefined)
    overlayFlushInFlight.set(datasetId, pending)

    try {
      await pending
      logRuntimeDebug('paste', 'cache_flush_overlay_done', {
        datasetId,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      logRuntimeDebug('paste', 'cache_flush_overlay_failed', {
        datasetId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      if (overlayFlushInFlight.get(datasetId) === pending) {
        overlayFlushInFlight.delete(datasetId)
      }
    }
  },

  /**
   * Get sorted row indices from server (for large datasets)
   * Returns row indices in sorted order - grid displays rows in this order
   * MANDATORY for large datasets - frontend cannot sort 50M values
   */
  async getSortedRowIndices(
    datasetId: string,
    sortColumn: string,
    descending: boolean
  ): Promise<number[]> {
    return await invoke<number[]>('get_sorted_row_indices', {
      datasetId,
      sortColumn,
      descending,
    })
  },

  async getGroupedRowOrder(
    datasetId: string,
    groupColumn: string,
    sortColumn: string | null,
    descending: boolean,
    collapsedGroups: string[]
  ): Promise<{ rowOrder: number[]; groupMeta: Array<{ startViewRow: number; key: string; size: number; collapsed: boolean }> }> {
    return await invoke('get_grouped_row_order', {
      datasetId,
      groupColumn,
      sortColumn: sortColumn ?? null,
      descending,
      collapsedGroups,
    })
  },

  /**
   * Get lazy group metadata using DuckDB GROUP BY aggregation.
   * O(groups) complexity - does NOT fetch all rows.
   * For 18M rows with 100 groups: returns 100 entries, not 18M.
   */
  async getLazyGroupMetadata(
    datasetId: string,
    groupColumn: string,
    sortColumn: string | null,
    descending: boolean
  ): Promise<{
    groups: Array<{ key: string; size: number; firstRowIndex: number }>
    totalRows: number
  }> {
    return await invoke('get_lazy_group_metadata', {
      datasetId,
      groupColumn,
      sortColumn: sortColumn ?? null,
      descending,
    })
  },

  /**
   * Get rows for a specific group with pagination.
   * Used to fetch visible rows within a group on scroll.
   */
  async getGroupRows(
    datasetId: string,
    groupColumn: string,
    groupKey: string,
    sortColumn: string | null,
    descending: boolean,
    offset: number,
    limit: number
  ): Promise<number[]> {
    return await invoke('get_group_rows', {
      datasetId,
      groupColumn,
      groupKey,
      sortColumn: sortColumn ?? null,
      descending,
      offset,
      limit,
    })
  },

  // =========================================================================
  // ASYNC AGGREGATE FORMULA SUPPORT (Phase 5.2)
  // =========================================================================

  /**
   * Compute aggregate over full column via DuckDB SQL
   *
   * IMPORTANT: Only use for unsorted/ungrouped large datasets.
   * This flushes overlay before computing.
   *
   * @param datasetId - Dataset identifier
   * @param columnId - Column ID (e.g., "col-0")
   * @param func - Aggregate function
   */
  async getColumnAggregate(
    datasetId: string,
    columnId: string,
    func: 'SUM' | 'AVG' | 'COUNT' | 'COUNTA' | 'STDEV' | 'STDEV_P' | 'VAR' | 'VAR_P' | 'MIN' | 'MAX'
  ): Promise<number> {
    return await invoke<number>('get_column_aggregate', {
      datasetId,
      columnId,
      func,
    })
  },

  /**
   * Compute aggregate over a row range (0-based, inclusive) using DuckDB SQL.
   */
  async getColumnAggregateRange(
    datasetId: string,
    columnId: string,
    func: 'SUM' | 'AVG' | 'COUNT' | 'COUNTA' | 'STDEV' | 'STDEV_P' | 'VAR' | 'VAR_P' | 'MIN' | 'MAX',
    startRow: number,
    endRow: number
  ): Promise<number> {
    return await invoke<number>('get_column_aggregate_range', {
      datasetId,
      columnId,
      func,
      startRow,
      endRow,
    })
  },

  /**
   * Compute aggregate over an explicit list of model row indices.
   */
  async getColumnAggregateRows(
    datasetId: string,
    columnId: string,
    func: 'SUM' | 'AVG' | 'COUNT' | 'COUNTA' | 'STDEV' | 'STDEV_P' | 'VAR' | 'VAR_P' | 'MIN' | 'MAX',
    rowIndices: number[]
  ): Promise<number> {
    return await invoke<number>('get_column_aggregate_rows', {
      datasetId,
      columnId,
      func,
      rowIndices,
    })
  },

  /**
   * Evaluate formula using Formualizer backend (for large datasets with unloaded ranges)
   *
   * @param datasetId - Dataset identifier
   * @param formula - Formula string (with or without leading "=")
   * @param position - Cell position in VIEW coordinates (0-based)
   * @param columnLetterToIdMap - Map of column letters (A, B, C) to column IDs (col-0, col-1, etc.)
   * @param rowOrderSlice - Optional view->model row mapping slice for sorted/grouped data
   * @returns Computed value as JSON
   */
  async evaluateFormulaBackend(
    datasetId: string,
    formula: string,
    position: { row: number; col: number },
    columnLetterToIdMap: Record<string, string>,
    rowOrderSlice?: { start: number; data: number[] },
    totalRows?: number
  ): Promise<unknown> {
    return await invoke('evaluate_formula_backend', {
      datasetId,
      formula,
      position,  // FIXED: was viewPosition, must match Rust struct field name
      columnLetterToIdMap,
      rowOrderSlice: rowOrderSlice || null,
      totalRows,
    })
  },

  /**
   * Check if dataset has pending overlay edits (dataset-scoped)
   */
  async getOverlaySize(datasetId: string): Promise<number> {
    return await invoke<number>('get_overlay_size', { datasetId })
  },

  /**
   * Import large CSV directly into DuckDB (streaming, never fully in memory)
   * Called from data_import for files >= 500MB
   */
  async importLargeCsv(datasetId: string, filePath: string): Promise<number> {
    const rowCount = await invoke<number>('import_large_csv', { datasetId, filePath })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
    return rowCount
  },

  /**
   * Import large Parquet directly into DuckDB (streaming, never fully in memory)
   * Parquet is the optimal format for large datasets (50M+ rows):
   * - Columnar storage (near-zero read overhead)
   * - 10-50x compression vs CSV
   * - Embedded schema (no type inference)
   */
  async importLargeParquet(datasetId: string, filePath: string): Promise<number> {
    const rowCount = await invoke<number>('import_large_parquet', { datasetId, filePath })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
    return rowCount
  },

  // ============================================================================
  // PHASE 4: PROJECT-AWARE IMPORT METHODS
  // ============================================================================

  /**
   * Import large CSV with project-scoped path (Phase 4: Collision Prevention)
   *
   * Creates DuckDB file in project-specific cache directory to prevent
   * collisions when multiple projects have datasets with the same ID.
   */
  async importLargeCsvWithProject(
    projectId: string,
    datasetId: string,
    filePath: string
  ): Promise<number> {
    const rowCount = await invoke<number>('import_large_csv_with_project', {
      projectId,
      datasetId,
      filePath,
    })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
    return rowCount
  },

  /**
   * Import large Parquet with project-scoped path (Phase 4: Collision Prevention)
   *
   * Creates DuckDB file in project-specific cache directory to prevent
   * collisions when multiple projects have datasets with the same ID.
   */
  async importLargeParquetWithProject(
    projectId: string,
    datasetId: string,
    filePath: string
  ): Promise<number> {
    const rowCount = await invoke<number>('import_large_parquet_with_project', {
      projectId,
      datasetId,
      filePath,
    })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
    return rowCount
  },

  /**
   * Set project data directory for project-adjacent storage
   * Phase 5: Eliminates AppData permission issues by storing database files
   * next to the .ecp project file in {project}_data/ folder
   */
  async setProjectDataDir(projectId: string, dataDir: string): Promise<void> {
    await invoke('set_project_data_dir', { projectId, dataDir })
  },

  // ============================================================================
  // PHASE B: PROJECT NAMESPACING (Dataset Isolation)
  // ============================================================================

  /**
   * Set active project ID for dataset namespacing
   *
   * Call this in COMMIT phase (after preflight succeeds) when opening a project,
   * or immediately after generating projectId for new projects.
   *
   * All subsequent dataset operations will use this project ID for namespacing.
   * Returns the previous active project ID for rollback on failure.
   */
  async setActiveProjectId(projectId: string): Promise<string | null> {
    return await invoke<string | null>('set_active_project_id', { projectId })
  },

  /**
   * Get current active project ID
   */
  async getActiveProjectId(): Promise<string | null> {
    return await invoke<string | null>('get_active_project_id')
  },

  /**
   * Clear active project ID (returns previous for rollback)
   */
  async clearActiveProjectId(): Promise<string | null> {
    return await invoke<string | null>('clear_active_project_id')
  },

  /**
   * PHASE 1: Copy a dataset data file to project directory (non-destructive).
   * Call finalizeBundledDatasetFile after .ecp save succeeds.
   */
  async bundleDatasetDataFile(projectId: string, datasetId: string): Promise<string> {
    return await invoke<string>('bundle_dataset_data_file', { projectId, datasetId })
  },

  /**
   * PHASE 2: Finalize bundled dataset (destructive, call after .ecp save succeeds).
   * Updates internal path and deletes old file.
   */
  async finalizeBundledDatasetFile(projectId: string, datasetId: string): Promise<void> {
    return await invoke<void>('finalize_bundled_dataset_file', { projectId, datasetId })
  },

  /**
   * Backend file path exists check (avoids frontend fs scope restrictions).
   */
  async pathExists(path: string): Promise<boolean> {
    return await invoke<boolean>('path_exists_file', { path })
  },

  /**
   * Backend directory path exists check (avoids frontend fs scope restrictions).
   */
  async pathExistsDir(path: string): Promise<boolean> {
    return await invoke<boolean>('path_exists_dir', { path })
  },

  /**
   * Register an existing DuckDB file without re-import
   * Used when loading projects with saved duckdbPath
   * Phase 1: Project Persistence Fix
   */
  async registerExistingDuckDB(
    datasetId: string,
    duckdbPath: string,
    columns?: RegisterDuckdbColumn[]
  ): Promise<RegisterDuckdbResult> {
    const result = await invoke<RegisterDuckdbResult>('register_existing_duckdb', {
      datasetId,
      duckdbPath,
      columns,
    })
    cacheService.triggerDatasetInfrastructureWarmup(datasetId)
    return result
  },

  /**
   * Get rows from hybrid cache (works for both in-memory and DuckDB)
   */
  async getRowsHybrid(
    datasetId: string,
    startRow: number,
    endRow: number
  ): Promise<Record<string, unknown>[]> {
    const startedAt = Date.now()
    logRuntimeDebug('paste', 'cache_get_rows_hybrid_start', {
      datasetId,
      startRow,
      endRow,
      requestedRows: Math.max(0, endRow - startRow),
    })
    try {
      const rows = await invoke<Record<string, unknown>[]>('get_rows_hybrid', {
        datasetId,
        startRow,
        endRow,
      })
      logRuntimeDebug('paste', 'cache_get_rows_hybrid_done', {
        datasetId,
        startRow,
        endRow,
        requestedRows: Math.max(0, endRow - startRow),
        returnedRows: rows.length,
        durationMs: Date.now() - startedAt,
      })
      return rows
    } catch (error) {
      logRuntimeDebug('paste', 'cache_get_rows_hybrid_failed', {
        datasetId,
        startRow,
        endRow,
        requestedRows: Math.max(0, endRow - startRow),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },

  async getRowsHybridColumns(
    datasetId: string,
    startRow: number,
    endRow: number,
    columnIds: string[]
  ): Promise<Record<string, unknown>[]> {
    const startedAt = Date.now()
    logRuntimeDebug('paste', 'cache_get_rows_hybrid_columns_start', {
      datasetId,
      startRow,
      endRow,
      columnIds,
      requestedRows: Math.max(0, endRow - startRow),
    })
    try {
      const rows = await invoke<Record<string, unknown>[]>('get_rows_hybrid_columns', {
        datasetId,
        startRow,
        endRow,
        columnIds,
      })
      logRuntimeDebug('paste', 'cache_get_rows_hybrid_columns_done', {
        datasetId,
        startRow,
        endRow,
        columnIds,
        requestedRows: Math.max(0, endRow - startRow),
        returnedRows: rows.length,
        durationMs: Date.now() - startedAt,
      })
      return rows
    } catch (error) {
      logRuntimeDebug('paste', 'cache_get_rows_hybrid_columns_failed', {
        datasetId,
        startRow,
        endRow,
        columnIds,
        requestedRows: Math.max(0, endRow - startRow),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },

  /**
   * Flush dataset to Arrow from hybrid cache
   */
  async flushToArrowHybrid(datasetId: string): Promise<string> {
    return await invoke<string>('flush_to_arrow_hybrid', { datasetId })
  },

  /**
   * Compute aggregates for supported tests using DuckDB (Rust-owned, no Python file access).
   */
  async getAggregatesForTest(
    datasetId: string,
    testName: string,
    numericColumn?: string | null,
    groupColumn?: string | null
  ): Promise<TestAggregatesResult> {
    return await invoke<TestAggregatesResult>('get_aggregates_for_test', {
      datasetId,
      testName,
      numericColumn: numericColumn ?? null,
      groupColumn: groupColumn ?? null,
    })
  },

  /**
   * Export selected columns to Arrow from hybrid cache
   */
  async exportColumnsToArrow(datasetId: string, columns: string[]): Promise<string> {
    return await invoke<string>('export_columns_to_arrow_hybrid', { datasetId, columns })
  },
}

/**
 * Debounced flush of pending updates (500ms delay)
 */
const flushPendingUpdatesDebounced = debounce(async () => {
  await cacheService.flushPendingUpdates()
}, 500)

export default cacheService
