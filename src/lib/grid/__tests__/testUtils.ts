/**
 * Test Utilities for Grid Module
 *
 * Provides shared mocks and helper functions for testing
 * the unified edit pipeline and related functionality.
 *
 * @see GRID_ENHANCEMENT_PLAN.md - Architecture Decisions (v3.4)
 */

import { vi } from 'vitest'
import type { EditExecutorConfig, EditExecutorDependencies } from '../types'

type DependencyOverrides = {
  cacheService?: Partial<EditExecutorDependencies['cacheService']>
  undoService?: Partial<EditExecutorDependencies['undoService']>
}

/**
 * Create a test config with optional overrides
 * All callbacks are mocked by default
 */
export function createTestConfig(
  overrides: Partial<EditExecutorConfig> = {}
): EditExecutorConfig {
  return {
    datasetId: 'test-dataset',
    setRowData: vi.fn(),
    updateCellValue: vi.fn(),
    updateCellsBatch: vi.fn(),
    invalidateColumns: vi.fn(),
    updateActiveFamilyData: vi.fn(),
    ...overrides,
  }
}

/**
 * Create mock dependencies for EditExecutor
 * All service methods are mocked by default
 */
export function createMockDependencies(
  overrides: DependencyOverrides = {}
): EditExecutorDependencies {
  return {
    cacheService: {
      queueCellUpdate: vi.fn(),
      updateCellsBatch: vi.fn().mockResolvedValue(0),
      enqueueGridMutationBatch: vi.fn().mockResolvedValue({
        accepted: true,
        queueId: 'test-queue-id',
      }),
      flushGridMutationQueue: vi.fn().mockResolvedValue(undefined),
      scheduleOverlayFlush: vi.fn(),
      ...overrides.cacheService,
    },
    undoService: {
      pushCellEdit: vi.fn().mockResolvedValue({
        can_undo: true,
        can_redo: false,
        undo_count: 1,
        redo_count: 0,
      }),
      pushBatchCellEdit: vi.fn().mockResolvedValue({
        can_undo: true,
        can_redo: false,
        undo_count: 1,
        redo_count: 0,
      }),
      enqueueBatchCellEdit: vi.fn().mockResolvedValue({
        can_undo: true,
        can_redo: false,
        undo_count: 1,
        redo_count: 0,
      }),
      trackPendingBatchRegistration: vi.fn(),
      ...overrides.undoService,
    },
  }
}

/**
 * Create mock cacheService for testing
 */
export function createMockCacheService() {
  return {
    queueCellUpdate: vi.fn(),
    updateCellsBatch: vi.fn().mockResolvedValue(0),
    setDataset: vi.fn().mockResolvedValue(undefined),
    updateCellImmediate: vi.fn().mockResolvedValue(undefined),
    getColumnData: vi.fn().mockResolvedValue([]),
    getColumnsData: vi.fn().mockResolvedValue({}),
  }
}

/**
 * Create mock undoService for testing
 */
export function createMockUndoService() {
  const defaultState = {
    can_undo: true,
    can_redo: false,
    undo_count: 1,
    redo_count: 0,
  }

  return {
    pushCellEdit: vi.fn().mockResolvedValue(defaultState),
    pushBatchCellEdit: vi.fn().mockResolvedValue(defaultState),
    enqueueBatchCellEdit: vi.fn().mockResolvedValue(defaultState),
    trackPendingBatchRegistration: vi.fn(),
    pushColumnRename: vi.fn().mockResolvedValue(defaultState),
    undo: vi.fn().mockResolvedValue(null),
    redo: vi.fn().mockResolvedValue(null),
    canUndo: vi.fn().mockResolvedValue(false),
    canRedo: vi.fn().mockResolvedValue(false),
    getState: vi.fn().mockResolvedValue({
      can_undo: false,
      can_redo: false,
      undo_count: 0,
      redo_count: 0,
    }),
    clearHistory: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Create mock Tauri clipboard for testing
 */
export function createMockTauriClipboard() {
  return {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  }
}

/**
 * Create a mock rowData Map for testing
 */
export function createMockRowData(
  data: Record<number, Record<string, unknown>> = {}
): Map<number, Record<string, unknown>> {
  return new Map(Object.entries(data).map(([k, v]) => [parseInt(k), v]))
}

/**
 * Helper to extract the updater function from setRowData mock calls
 */
export function getRowDataUpdater(
  setRowDataMock: ReturnType<typeof vi.fn>
): ((prev: Map<number, Record<string, unknown>>) => Map<number, Record<string, unknown>>) | undefined {
  const firstCall = setRowDataMock.mock.calls[0]
  if (!firstCall) {
    return undefined
  }
  return firstCall[0] as (
    prev: Map<number, Record<string, unknown>>
  ) => Map<number, Record<string, unknown>>
}

/**
 * Apply the setRowData updater and return the result
 */
export function applyRowDataUpdate(
  setRowDataMock: ReturnType<typeof vi.fn>,
  initialData: Map<number, Record<string, unknown>>
): Map<number, Record<string, unknown>> | undefined {
  const updater = getRowDataUpdater(setRowDataMock)
  if (!updater) {
    return undefined
  }
  return updater(initialData)
}

/**
 * Create sample cell edits for testing
 */
export function createSampleEdits(count: number = 3) {
  return Array.from({ length: count }, (_, i) => ({
    row: i,
    columnId: `col-${String.fromCharCode(97 + (i % 3))}`, // col-a, col-b, col-c
    oldValue: `old-${i}`,
    newValue: `new-${i}`,
  }))
}

/**
 * Wait for all pending promises to resolve
 */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
