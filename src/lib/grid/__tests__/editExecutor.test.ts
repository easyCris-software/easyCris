/**
 * Edit Executor Unit Tests
 *
 * Tests the unified edit pipeline to ensure all side effects
 * are executed correctly for different edit sources.
 *
 * @see GRID_ENHANCEMENT_PLAN.md - Phase 1 Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyEditsToDataStore, createEditExecutor, executeEdits } from '../editExecutor'
import type { EditSource } from '../types'
import {
  createTestConfig,
  createMockDependencies,
  createMockRowData,
  applyRowDataUpdate,
} from './testUtils'
import { createRowDataSentinel, isRowDataSentinel } from '../rowDataSentinel'

describe('executeEdits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Single edit applies all side effects', () => {
    it('updates local row cache', async () => {
      const setRowData = vi.fn()
      const config = createTestConfig({ setRowData })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(setRowData).toHaveBeenCalledTimes(1)

      // Verify the updater function applies the edit correctly
      const initialData = createMockRowData({ 0: { 'col-a': 'old' } })
      const result = applyRowDataUpdate(setRowData, initialData)

      expect(result).toBeDefined()
      expect(result?.get(0)?.['col-a']).toBe('new')
    })

    it('updates data-store (dataCache) with computed value', async () => {
      const updateCellValue = vi.fn()
      const config = createTestConfig({ updateCellValue })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(updateCellValue).toHaveBeenCalledWith('test-dataset', 0, 'col-a', 'new')
    })

    it('uses computedValue when provided (for formulas)', async () => {
      const updateCellValue = vi.fn()
      const config = createTestConfig({ updateCellValue })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [
            {
              row: 0,
              columnId: 'col-a',
              oldValue: 'old',
              newValue: '=1+1', // Raw formula
              computedValue: 2, // Computed result
            },
          ],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Should store computed value, not raw formula
      expect(updateCellValue).toHaveBeenCalledWith('test-dataset', 0, 'col-a', 2)
    })

    it('calls cacheService.queueCellUpdate for single edit', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(deps.cacheService.queueCellUpdate).toHaveBeenCalledWith(
        'test-dataset',
        0,
        'col-a',
        'new'
      )
    })

    it('calls undoService.pushCellEdit for normal edit', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(deps.undoService.pushCellEdit).toHaveBeenCalledWith(
        'test-dataset',
        0,
        'col-a',
        'old',
        'new'
      )
    })

    it('adds columnId to invalidatedColumnIds', async () => {
      const invalidateColumns = vi.fn()
      const config = createTestConfig({ invalidateColumns })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(invalidateColumns).toHaveBeenCalledWith(['col-a'])
    })

    it('updates active family for non-paste source using captured family id', async () => {
      const updateActiveFamilyData = vi.fn()
      const getActiveFamilyId = vi.fn(() => 'fam-1')
      const config = createTestConfig({ updateActiveFamilyData, getActiveFamilyId })
      const deps = createMockDependencies()

      // Non-empty value should trigger family binding with captured family.
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'value' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )
      expect(getActiveFamilyId).toHaveBeenCalledTimes(1)
      expect(updateActiveFamilyData).toHaveBeenCalledWith('test-dataset', 'fam-1')

      updateActiveFamilyData.mockClear()

      // Empty value should not trigger binding.
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: '' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )
      expect(updateActiveFamilyData).not.toHaveBeenCalled()
    })

    it('does not call updateActiveFamilyData for null/undefined values', async () => {
      const updateActiveFamilyData = vi.fn()
      const config = createTestConfig({ updateActiveFamilyData, getActiveFamilyId: () => 'fam-1' })
      const deps = createMockDependencies()

      // null value should NOT update
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: null }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )
      expect(updateActiveFamilyData).not.toHaveBeenCalled()

      updateActiveFamilyData.mockClear()

      // undefined value should NOT update
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: undefined }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )
      expect(updateActiveFamilyData).not.toHaveBeenCalled()
    })

    it.each([
      ['paste' as const],
      ['paste-transpose' as const],
    ])('skips updateActiveFamilyData for paste source "%s"', async (pasteSource) => {
      const updateActiveFamilyData = vi.fn()
      const config = createTestConfig({ updateActiveFamilyData, getActiveFamilyId: () => 'fam-1' })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'pasted' }],
          source: pasteSource,
          timestamp: Date.now(),
        },
        deps
      )

      // Executor must never call updateActiveFamilyData.
      expect(updateActiveFamilyData).not.toHaveBeenCalled()
    })
  })

  describe('Batch edit uses batch paths', () => {
    it('applies N edits', async () => {
      const setRowData = vi.fn()
      const config = createTestConfig({ setRowData })
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-a', oldValue: 'a2', newValue: 'b2' },
        { row: 2, columnId: 'col-b', oldValue: 'a3', newValue: 'b3' },
      ]

      await executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps)

      const initialData = createMockRowData({
        0: { 'col-a': 'a1' },
        1: { 'col-a': 'a2' },
        2: { 'col-b': 'a3' },
      })
      const result = applyRowDataUpdate(setRowData, initialData)

      expect(result?.get(0)?.['col-a']).toBe('b1')
      expect(result?.get(1)?.['col-a']).toBe('b2')
      expect(result?.get(2)?.['col-b']).toBe('b3')
    })

    it('calls undoService.pushBatchCellEdit', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-a', oldValue: 'a2', newValue: 'b2' },
      ]

      await executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps)

      expect(deps.undoService.pushBatchCellEdit).toHaveBeenCalledWith('test-dataset', [
        { row: 0, column: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, column: 'col-a', oldValue: 'a2', newValue: 'b2' },
      ])
    })

    it('awaits batch undo push for small payloads', async () => {
      let releaseUndo = () => {}
      const pendingUndo = new Promise<void>((resolve) => {
        releaseUndo = () => resolve()
      })

      const config = createTestConfig()
      const deps = createMockDependencies({
        undoService: {
          pushCellEdit: vi.fn().mockResolvedValue({
            can_undo: true,
            can_redo: false,
            undo_count: 1,
            redo_count: 0,
          }),
          pushBatchCellEdit: vi.fn().mockImplementation(() => pendingUndo),
        },
      })

      const executePromise = executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
            { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
          ],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      ).then(() => 'done')

      const earlyResult = await Promise.race([
        executePromise,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30)),
      ])
      expect(earlyResult).toBe('timeout')

      releaseUndo()
      await expect(executePromise).resolves.toBe('done')
    })

    it('does not await batch undo push for large payloads', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies({
        undoService: {
          pushCellEdit: vi.fn().mockResolvedValue({
            can_undo: true,
            can_redo: false,
            undo_count: 1,
            redo_count: 0,
          }),
          enqueueBatchCellEdit: vi.fn().mockImplementation(() => new Promise(() => {})),
        },
      })

      const edits = Array.from({ length: 1001 }, (_, row) => ({
        row,
        columnId: 'col-a',
        oldValue: `old-${row}`,
        newValue: `new-${row}`,
      }))

      const result = await Promise.race([
        executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps).then(() => 'done'),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ])

      expect(result).toBe('done')
      expect(deps.undoService.enqueueBatchCellEdit).toHaveBeenCalledTimes(1)
      expect(deps.undoService.trackPendingBatchRegistration).toHaveBeenCalledTimes(1)
    })

    it('handles wide paste row promotion without argument-spread stack overflow', async () => {
      const bumpDataRowCount = vi.fn()
      const config = createTestConfig({ bumpDataRowCount })
      const deps = createMockDependencies()
      const edits = Array.from({ length: 1852 * 87 }, (_, index) => {
        const row = Math.floor(index / 87)
        return {
          row,
          columnId: `col-${index % 87}`,
          oldValue: '',
          newValue: `value-${row}`,
        }
      })

      await executeEdits(
        config,
        {
          edits,
          source: 'paste',
          timestamp: Date.now(),
          skipBackendSync: true,
          skipUndoRegistration: true,
          skipProjectDirty: true,
        },
        deps
      )

      expect(bumpDataRowCount).toHaveBeenCalledWith(1851)
    })

    it('awaits batch undo push at 999 edits (below async threshold)', async () => {
      let releaseUndo = () => {}
      const pendingUndo = new Promise<void>((resolve) => {
        releaseUndo = () => resolve()
      })

      const config = createTestConfig()
      const deps = createMockDependencies({
        undoService: {
          pushBatchCellEdit: vi.fn().mockImplementation(() => pendingUndo),
        },
      })

      const edits = Array.from({ length: 999 }, (_, row) => ({
        row,
        columnId: 'col-a',
        oldValue: `old-${row}`,
        newValue: `new-${row}`,
      }))

      const executePromise = executeEdits(
        config,
        { edits, source: 'paste', timestamp: Date.now() },
        deps
      ).then(() => 'done')

      const earlyResult = await Promise.race([
        executePromise,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30)),
      ])
      expect(earlyResult).toBe('timeout')
      expect(deps.undoService.trackPendingBatchRegistration).not.toHaveBeenCalled()

      releaseUndo()
      await expect(executePromise).resolves.toBe('done')
    })

    it('awaits batch undo push at 1000 edits (strict >1000 async threshold)', async () => {
      let releaseUndo = () => {}
      const pendingUndo = new Promise<void>((resolve) => {
        releaseUndo = () => resolve()
      })

      const config = createTestConfig()
      const deps = createMockDependencies({
        undoService: {
          pushBatchCellEdit: vi.fn().mockImplementation(() => pendingUndo),
        },
      })

      const edits = Array.from({ length: 1000 }, (_, row) => ({
        row,
        columnId: 'col-a',
        oldValue: `old-${row}`,
        newValue: `new-${row}`,
      }))

      const executePromise = executeEdits(
        config,
        { edits, source: 'paste', timestamp: Date.now() },
        deps
      ).then(() => 'done')

      const earlyResult = await Promise.race([
        executePromise,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30)),
      ])
      expect(earlyResult).toBe('timeout')
      expect(deps.undoService.trackPendingBatchRegistration).not.toHaveBeenCalled()

      releaseUndo()
      await expect(executePromise).resolves.toBe('done')
    })

    it('calls cacheService.enqueueGridMutationBatch once for multi-edit mutations', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-a', oldValue: 'a2', newValue: 'b2' },
      ]

      await executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps)

      expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledTimes(1)
      expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledWith('test-dataset', [
        { row: 0, column: 'col-a', value: 'b1' },
        { row: 1, column: 'col-a', value: 'b2' },
      ])
      expect(deps.cacheService.updateCellsBatch).not.toHaveBeenCalled()
    })

    it('uses a single store batch update instead of per-cell store updates', async () => {
      const updateCellValue = vi.fn()
      const updateCellsBatch = vi.fn()
      const config = createTestConfig({ updateCellValue, updateCellsBatch })
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
      ]

      await executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps)

      expect(updateCellsBatch).toHaveBeenCalledTimes(1)
      expect(updateCellsBatch).toHaveBeenCalledWith('test-dataset', [
        { row: 0, columnId: 'col-a', value: 'b1' },
        { row: 1, columnId: 'col-b', value: 'b2' },
      ])
      expect(updateCellValue).not.toHaveBeenCalled()
    })

    it('can skip data-store writes while still applying local rowData and backend sync', async () => {
      const setRowData = vi.fn()
      const updateCellValue = vi.fn()
      const updateCellsBatch = vi.fn()
      const config = createTestConfig({ setRowData, updateCellValue, updateCellsBatch })
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
      ]

      await executeEdits(
        config,
        {
          edits,
          source: 'paste',
          timestamp: Date.now(),
          skipDataStoreUpdate: true,
        },
        deps
      )

      expect(setRowData).toHaveBeenCalledTimes(1)
      expect(updateCellsBatch).not.toHaveBeenCalled()
      expect(updateCellValue).not.toHaveBeenCalled()
      expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledTimes(1)
    })

    it('preserves placeholder row markers when applying paste edits locally', async () => {
      const setRowData = vi.fn()
      const config = createTestConfig({ setRowData })
      const deps = createMockDependencies()
      const placeholderRow = createRowDataSentinel()

      await executeEdits(
        config,
        {
          edits: [{ row: 3, columnId: 'col-a', oldValue: '', newValue: 'typed' }],
          source: 'paste',
          timestamp: Date.now(),
          skipDataStoreUpdate: true,
        },
        deps
      )

      const result = applyRowDataUpdate(setRowData, createMockRowData({ 3: placeholderRow }))

      expect(result?.get(3)?.['col-a']).toBe('typed')
      expect(isRowDataSentinel(result?.get(3))).toBe(true)
    })

    it('skips local sparse row creation for flagged paste rows while still syncing backend edits', async () => {
      const setRowData = vi.fn()
      const config = createTestConfig({ setRowData })
      const deps = createMockDependencies()
      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'old-visible', newValue: 'new-visible' },
        { row: 1024, columnId: 'col-a', oldValue: 'old-unloaded', newValue: 'new-unloaded' },
      ]

      await executeEdits(
        config,
        {
          edits,
          source: 'paste',
          timestamp: Date.now(),
          skipDataStoreUpdate: true,
          shouldSkipLocalRowDataWrite: (row: number) => row === 1024,
        },
        deps
      )

      const result = applyRowDataUpdate(
        setRowData,
        createMockRowData({ 0: { 'col-a': 'old-visible', neighbor: 'kept' } })
      )

      expect(result?.get(0)).toEqual({ 'col-a': 'new-visible', neighbor: 'kept' })
      expect(result?.has(1024)).toBe(false)
      expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledWith('test-dataset', [
        { row: 0, column: 'col-a', value: 'new-visible' },
        { row: 1024, column: 'col-a', value: 'new-unloaded' },
      ])
    })

    it('does not leak skipDataStoreUpdate into formula-dependent recalculation', async () => {
      const updateCellValue = vi.fn()
      const updateCellsBatch = vi.fn()
      const formulaService = {
        isFormula: (v: unknown): v is string => typeof v === 'string' && v.startsWith('='),
        hasFormula: vi.fn().mockReturnValue(false),
        getFormula: vi.fn().mockReturnValue(undefined),
        evaluate: vi.fn().mockReturnValue({ value: 42 }),
        registerFormula: vi.fn(),
        unregisterFormula: vi.fn(),
        recalculateDependents: vi.fn().mockReturnValue([]),
        getDependentsForColumns: vi.fn().mockReturnValue(['0:col-b']),
        recalculateFormulaCells: vi.fn().mockReturnValue([
          { row: 0, columnId: 'col-b', computedValue: 99 },
        ]),
        recalculateVolatileCells: vi.fn().mockReturnValue([]),
        getFilledFormula: vi.fn((f: string) => f),
      }
      const config = createTestConfig({
        updateCellValue,
        updateCellsBatch,
        formulaService,
        columns: [{ id: 'col-a' }, { id: 'col-b' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' }],
          source: 'paste',
          timestamp: Date.now(),
          skipDataStoreUpdate: true,
        },
        deps
      )

      expect(updateCellsBatch).not.toHaveBeenCalled()
      expect(updateCellValue).toHaveBeenCalledTimes(1)
      expect(updateCellValue).toHaveBeenCalledWith('test-dataset', 0, 'col-b', 99)
    })

    it('keeps local rowData skip predicate for formula-dependent recalculation', async () => {
      const setRowData = vi.fn()
      const formulaService = {
        isFormula: (v: unknown): v is string => typeof v === 'string' && v.startsWith('='),
        hasFormula: vi.fn().mockReturnValue(false),
        getFormula: vi.fn().mockReturnValue(undefined),
        evaluate: vi.fn().mockReturnValue({ value: 42 }),
        registerFormula: vi.fn(),
        unregisterFormula: vi.fn(),
        recalculateDependents: vi.fn().mockReturnValue([]),
        getDependentsForColumns: vi.fn().mockReturnValue(['1024:col-b']),
        recalculateFormulaCells: vi.fn().mockReturnValue([
          { row: 1024, columnId: 'col-b', computedValue: 99 },
        ]),
        recalculateVolatileCells: vi.fn().mockReturnValue([]),
        getFilledFormula: vi.fn((f: string) => f),
      }
      const config = createTestConfig({
        setRowData,
        formulaService,
        columns: [{ id: 'col-a' }, { id: 'col-b' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' }],
          source: 'paste',
          timestamp: Date.now(),
          shouldSkipLocalRowDataWrite: (row) => row === 1024,
        },
        deps
      )

      expect(setRowData).toHaveBeenCalledTimes(2)
      const formulaUpdater = setRowData.mock.calls[1]?.[0] as
        | ((prev: Map<number, Record<string, unknown>>) => Map<number, Record<string, unknown>>)
        | undefined
      const result = formulaUpdater?.(createMockRowData())

      expect(result?.has(1024)).toBe(false)
      expect(deps.cacheService.queueCellUpdate).toHaveBeenCalledWith(
        'test-dataset',
        1024,
        'col-b',
        99
      )
    })

    it('serializes paste backend sync chunks and flushes each chunk before the next enqueue', async () => {
      const events: string[] = []
      const config = createTestConfig()
      const deps = createMockDependencies({
        cacheService: {
          enqueueGridMutationBatch: vi.fn(async (_datasetId, updates) => {
            events.push(`enqueue:${updates.length}:${updates[0]?.row}`)
            return { accepted: true as const, queueId: `queue-${events.length}` }
          }),
        },
      })
      ;(deps.cacheService as typeof deps.cacheService & {
        flushGridMutationQueue: (datasetId: string) => Promise<void>
      }).flushGridMutationQueue = vi.fn(async () => {
        events.push('flush')
      })

      await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-a', oldValue: '', newValue: 'a' },
            { row: 1, columnId: 'col-a', oldValue: '', newValue: 'b' },
            { row: 2, columnId: 'col-a', oldValue: '', newValue: 'c' },
            { row: 3, columnId: 'col-a', oldValue: '', newValue: 'd' },
            { row: 4, columnId: 'col-a', oldValue: '', newValue: 'e' },
          ],
          source: 'paste',
          timestamp: Date.now(),
          backendSyncChunkSize: 2,
          flushBackendChunks: true,
        } as Parameters<typeof executeEdits>[1] & {
          backendSyncChunkSize: number
          flushBackendChunks: boolean
        },
        deps
      )

      expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledTimes(3)
      expect((deps.cacheService as any).flushGridMutationQueue).toHaveBeenCalledTimes(3)
      expect(events).toEqual([
        'enqueue:2:0',
        'flush',
        'enqueue:2:2',
        'flush',
        'enqueue:1:4',
        'flush',
      ])
    })

    it('returns backendSyncSucceeded=false when a later backend sync chunk fails', async () => {
      const events: string[] = []
      const config = createTestConfig()
      const deps = createMockDependencies({
        cacheService: {
          enqueueGridMutationBatch: vi.fn(async (_datasetId, updates) => {
            events.push(`enqueue:${updates[0]?.row}`)
            if (updates[0]?.row === 2) {
              throw new Error('chunk failed')
            }
            return { accepted: true as const, queueId: `queue-${events.length}` }
          }),
        },
      })
      ;(deps.cacheService as typeof deps.cacheService & {
        flushGridMutationQueue: (datasetId: string) => Promise<void>
      }).flushGridMutationQueue = vi.fn(async () => {
        events.push('flush')
      })

      const result = await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-a', oldValue: '', newValue: 'a' },
            { row: 1, columnId: 'col-a', oldValue: '', newValue: 'b' },
            { row: 2, columnId: 'col-a', oldValue: '', newValue: 'c' },
            { row: 3, columnId: 'col-a', oldValue: '', newValue: 'd' },
            { row: 4, columnId: 'col-a', oldValue: '', newValue: 'e' },
          ],
          source: 'paste',
          timestamp: Date.now(),
          backendSyncChunkSize: 2,
          flushBackendChunks: true,
        } as Parameters<typeof executeEdits>[1] & {
          backendSyncChunkSize: number
          flushBackendChunks: boolean
        },
        deps
      )

      expect(result.backendSyncSucceeded).toBe(false)
      expect(deps.cacheService.enqueueGridMutationBatch).toHaveBeenCalledTimes(2)
      expect((deps.cacheService as any).flushGridMutationQueue).toHaveBeenCalledTimes(1)
      expect(events).toEqual([
        'enqueue:0',
        'flush',
        'enqueue:2',
      ])
    })

    it('can apply deferred data-store edits in one final batch', () => {
      const updateCellValue = vi.fn()
      const updateCellsBatch = vi.fn()
      const config = createTestConfig({ updateCellValue, updateCellsBatch })

      applyEditsToDataStore(config, [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: '=1+1', computedValue: 2 },
        { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
      ])

      expect(updateCellsBatch).toHaveBeenCalledTimes(1)
      expect(updateCellsBatch).toHaveBeenCalledWith('test-dataset', [
        { row: 0, columnId: 'col-a', value: 2 },
        { row: 1, columnId: 'col-b', value: 'b2' },
      ])
      expect(updateCellValue).not.toHaveBeenCalled()
    })

    it('exposes the deferred data-store finalizer on configured executors', () => {
      const updateCellValue = vi.fn()
      const updateCellsBatch = vi.fn()
      const config = createTestConfig({ updateCellValue, updateCellsBatch })
      const executor = createEditExecutor(config, createMockDependencies())

      executor.applyDataStoreUpdate([
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
      ])

      expect(updateCellsBatch).toHaveBeenCalledTimes(1)
      expect(updateCellsBatch).toHaveBeenCalledWith('test-dataset', [
        { row: 0, columnId: 'col-a', value: 'b1' },
        { row: 1, columnId: 'col-b', value: 'b2' },
      ])
      expect(updateCellValue).not.toHaveBeenCalled()
    })

    it('invalidates all affected columns', async () => {
      const invalidateColumns = vi.fn()
      const config = createTestConfig({ invalidateColumns })
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-b', oldValue: 'a2', newValue: 'b2' },
        { row: 2, columnId: 'col-a', oldValue: 'a3', newValue: 'b3' },
      ]

      await executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps)

      // Should be deduplicated
      expect(invalidateColumns).toHaveBeenCalledWith(['col-a', 'col-b'])
    })
  })

  describe('Source rules', () => {
    it.each(['undo', 'redo', 'formula'] as const)(
      'source=%s does NOT push to undo again',
      async (source) => {
        const config = createTestConfig()
        const deps = createMockDependencies()

        await executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
            source,
            timestamp: Date.now(),
          },
          deps
        )

        expect(deps.undoService.pushCellEdit).not.toHaveBeenCalled()
        expect(deps.undoService.pushBatchCellEdit).not.toHaveBeenCalled()
      }
    )

    it.each(['undo', 'redo', 'formula'] as const)(
      'source=%s still invalidates columns',
      async (source) => {
        const invalidateColumns = vi.fn()
        const config = createTestConfig({ invalidateColumns })
        const deps = createMockDependencies()

        await executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
            source,
            timestamp: Date.now(),
          },
          deps
        )

        expect(invalidateColumns).toHaveBeenCalledWith(['col-a'])
      }
    )

    it.each(['type', 'paste', 'cut', 'delete', 'fill'] as const)(
      'source=%s pushes to undo stack',
      async (source) => {
        const config = createTestConfig()
        const deps = createMockDependencies()

        await executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
            source,
            timestamp: Date.now(),
          },
          deps
        )

        expect(deps.undoService.pushCellEdit).toHaveBeenCalled()
      }
    )

    it.each(['paste', 'cut', 'delete'] as const)(
      'source=%s can skip backend undo registration for coordinator-owned mutations',
      async (source) => {
        const config = createTestConfig()
        const deps = createMockDependencies()

        await executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
            source,
            timestamp: Date.now(),
            skipUndoRegistration: true,
          },
          deps
        )

        expect(deps.undoService.pushCellEdit).not.toHaveBeenCalled()
        expect(deps.undoService.pushBatchCellEdit).not.toHaveBeenCalled()
      }
    )

    it.each(['undo', 'redo', 'formula'] as const)(
      'source=%s still syncs to cache service',
      async (source) => {
        const config = createTestConfig()
        const deps = createMockDependencies()

        await executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
            source,
            timestamp: Date.now(),
          },
          deps
        )

        expect(deps.cacheService.queueCellUpdate).toHaveBeenCalled()
      }
    )
  })

  describe('Edge cases', () => {
    it('handles empty edits array gracefully', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      const result = await executeEdits(
        config,
        {
          edits: [],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Nothing should be called
      expect(config.setRowData).not.toHaveBeenCalled()
      expect(config.updateCellValue).not.toHaveBeenCalled()
      expect(deps.cacheService.queueCellUpdate).not.toHaveBeenCalled()
      expect(deps.undoService.pushCellEdit).not.toHaveBeenCalled()
      expect(result.backendSyncSucceeded).toBe(true)
    })

    it('creates row if not exists in rowData', async () => {
      const setRowData = vi.fn()
      const config = createTestConfig({ setRowData })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 99, columnId: 'col-a', oldValue: undefined, newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // Start with empty map, should create row 99
      const result = applyRowDataUpdate(setRowData, new Map())

      expect(result?.get(99)).toBeDefined()
      expect(result?.get(99)?.['col-a']).toBe('new')
    })

    it('preserves other columns in same row', async () => {
      const setRowData = vi.fn()
      const config = createTestConfig({ setRowData })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old-a', newValue: 'new-a' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      const initialData = createMockRowData({
        0: { 'col-a': 'old-a', 'col-b': 'keep-b', 'col-c': 'keep-c' },
      })
      const result = applyRowDataUpdate(setRowData, initialData)

      expect(result?.get(0)?.['col-a']).toBe('new-a')
      expect(result?.get(0)?.['col-b']).toBe('keep-b')
      expect(result?.get(0)?.['col-c']).toBe('keep-c')
    })

    it('does not call updateActiveFamilyData if not provided', async () => {
      const config = createTestConfig({ updateActiveFamilyData: undefined })
      const deps = createMockDependencies()

      // Should not throw
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'value' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )
    })
  })

  describe('Behavior matrix validation', () => {
    const behaviorMatrix: Array<{
      source: EditSource
      pushUndo: boolean
      invalidate: boolean
      syncCache: boolean
    }> = [
      { source: 'type', pushUndo: true, invalidate: true, syncCache: true },
      { source: 'paste', pushUndo: true, invalidate: true, syncCache: true },
      { source: 'cut', pushUndo: true, invalidate: true, syncCache: true },
      { source: 'delete', pushUndo: true, invalidate: true, syncCache: true },
      { source: 'fill', pushUndo: true, invalidate: true, syncCache: true },
      { source: 'formula', pushUndo: false, invalidate: true, syncCache: true },
      { source: 'undo', pushUndo: false, invalidate: true, syncCache: true },
      { source: 'redo', pushUndo: false, invalidate: true, syncCache: true },
    ]

    it.each(behaviorMatrix)(
      'source=$source: pushUndo=$pushUndo, invalidate=$invalidate, syncCache=$syncCache',
      async ({ source, pushUndo, invalidate, syncCache }) => {
        const invalidateColumns = vi.fn()
        const config = createTestConfig({ invalidateColumns })
        const deps = createMockDependencies()

        await executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
            source,
            timestamp: Date.now(),
          },
          deps
        )

        // Check undo push
        if (pushUndo) {
          expect(deps.undoService.pushCellEdit).toHaveBeenCalled()
        } else {
          expect(deps.undoService.pushCellEdit).not.toHaveBeenCalled()
        }

        // Check invalidation
        if (invalidate) {
          expect(invalidateColumns).toHaveBeenCalled()
        } else {
          expect(invalidateColumns).not.toHaveBeenCalled()
        }

        // Check cache sync
        if (syncCache) {
          expect(deps.cacheService.queueCellUpdate).toHaveBeenCalled()
        } else {
          expect(deps.cacheService.queueCellUpdate).not.toHaveBeenCalled()
        }
      }
    )
  })

  describe('Error resilience', () => {
    // Stub console.error to avoid noisy test output
    const originalConsoleError = console.error
    beforeEach(() => {
      console.error = vi.fn()
    })
    afterEach(() => {
      console.error = originalConsoleError
    })

    it('returns backendSyncSucceeded=true on successful backend sync', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      const result = await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      expect(result.backendSyncSucceeded).toBe(true)
    })

    it('invalidation happens even if backend sync throws', async () => {
      const invalidateColumns = vi.fn()
      const config = createTestConfig({ invalidateColumns })
      const deps = createMockDependencies({
        cacheService: {
          queueCellUpdate: vi.fn().mockImplementation(() => {
            throw new Error('Backend sync failed')
          }),
          updateCellsBatch: vi.fn().mockRejectedValue(new Error('Batch sync failed')),
        },
      })

      // Should NOT throw - errors are caught internally
      const result = await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // CRITICAL: invalidation MUST happen despite backend failure
      expect(invalidateColumns).toHaveBeenCalledWith(['col-a'])
      expect(result.backendSyncSucceeded).toBe(false)
    })

    it('invalidation happens even if undo push throws', async () => {
      const invalidateColumns = vi.fn()
      const config = createTestConfig({ invalidateColumns })
      const deps = createMockDependencies({
        undoService: {
          pushCellEdit: vi.fn().mockRejectedValue(new Error('Undo push failed')),
          pushBatchCellEdit: vi.fn().mockRejectedValue(new Error('Batch undo failed')),
        },
      })

      // Should NOT throw - errors are caught internally
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // CRITICAL: invalidation MUST happen despite undo failure
      expect(invalidateColumns).toHaveBeenCalledWith(['col-a'])
    })

    it('invalidation happens even if batch backend sync throws', async () => {
      const invalidateColumns = vi.fn()
      const config = createTestConfig({ invalidateColumns })
      const deps = createMockDependencies({
        cacheService: {
          queueCellUpdate: vi.fn(),
          enqueueGridMutationBatch: vi.fn().mockRejectedValue(new Error('Batch sync failed')),
        },
      })

      // Multiple edits trigger batch path
      const result = await executeEdits(
        config,
        {
          edits: [
            { row: 0, columnId: 'col-a', oldValue: 'old1', newValue: 'new1' },
            { row: 1, columnId: 'col-b', oldValue: 'old2', newValue: 'new2' },
          ],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      // CRITICAL: invalidation MUST happen despite batch failure
      expect(invalidateColumns).toHaveBeenCalledWith(['col-a', 'col-b'])
      expect(result.backendSyncSucceeded).toBe(false)
    })

    it('UI updates happen even when backend fails', async () => {
      const setRowData = vi.fn()
      const updateCellValue = vi.fn()
      const config = createTestConfig({ setRowData, updateCellValue })
      const deps = createMockDependencies({
        cacheService: {
          queueCellUpdate: vi.fn().mockImplementation(() => {
            throw new Error('Backend sync failed')
          }),
          updateCellsBatch: vi.fn().mockRejectedValue(new Error('Batch failed')),
        },
      })

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: 'old', newValue: 'new' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )

      // UI updates happen BEFORE backend sync, so they should succeed
      expect(setRowData).toHaveBeenCalled()
      expect(updateCellValue).toHaveBeenCalledWith('test-dataset', 0, 'col-a', 'new')
    })
  })

  describe('getColumns dynamic lookup', () => {
    function makeMockFormulaService() {
      return {
        isFormula: (v: unknown): v is string => typeof v === 'string' && v.startsWith('='),
        hasFormula: vi.fn().mockReturnValue(false),
        getFormula: vi.fn().mockReturnValue(undefined),
        evaluate: vi.fn().mockReturnValue({ value: 42 }),
        registerFormula: vi.fn(),
        unregisterFormula: vi.fn(),
        recalculateDependents: vi.fn().mockReturnValue([]),
        getDependentsForColumns: vi.fn().mockReturnValue([]),
        recalculateFormulaCells: vi.fn().mockReturnValue([]),
        recalculateVolatileCells: vi.fn().mockReturnValue([]),
        getFilledFormula: vi.fn((f: string) => f),
      }
    }

    it('evaluates formula in column found only via getColumns, not static columns', async () => {
      const formulaService = makeMockFormulaService()
      const config = createTestConfig({
        formulaService,
        columns: [{ id: 'col-existing' }],
        getColumns: () => [{ id: 'col-existing' }, { id: 'col-overflow' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-overflow', oldValue: null, newValue: '=1+1' }],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      expect(formulaService.evaluate).toHaveBeenCalledTimes(1)
    })

    it('registers formula in column found only via getColumns', async () => {
      const formulaService = makeMockFormulaService()
      const config = createTestConfig({
        formulaService,
        columns: [{ id: 'col-existing' }],
        getColumns: () => [{ id: 'col-existing' }, { id: 'col-overflow' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 2, columnId: 'col-overflow', oldValue: null, newValue: '=A1' }],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      expect(formulaService.registerFormula).toHaveBeenCalledWith(
        '2:col-overflow',
        '=A1',
        { row: 3, col: 2, sheet: 'Sheet1' }
      )
    })

    it('getColumns takes precedence over columns when both present', async () => {
      const formulaService = makeMockFormulaService()
      // Static columns has col-overflow at index 0; getColumns has it at index 1
      const config = createTestConfig({
        formulaService,
        columns: [{ id: 'col-overflow' }],
        getColumns: () => [{ id: 'col-existing' }, { id: 'col-overflow' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-overflow', oldValue: null, newValue: '=B2' }],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      // col=2 from getColumns index 1, not col=1 from columns index 0
      // Assert both Step 0 (evaluate) and Step 7 (register) use getColumns precedence
      expect(formulaService.evaluate).toHaveBeenCalledWith('=B2', { row: 1, col: 2, sheet: 'Sheet1' })
      expect(formulaService.registerFormula).toHaveBeenCalledWith(
        '0:col-overflow',
        '=B2',
        { row: 1, col: 2, sheet: 'Sheet1' }
      )
    })

    it('falls back to columns when getColumns is absent', async () => {
      const formulaService = makeMockFormulaService()
      const config = createTestConfig({
        formulaService,
        columns: [{ id: 'col-a' }, { id: 'col-b' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-b', oldValue: null, newValue: '=SUM(A1)' }],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      expect(formulaService.registerFormula).toHaveBeenCalledWith(
        '0:col-b',
        '=SUM(A1)',
        { row: 1, col: 2, sheet: 'Sheet1' }
      )
    })

    it('skips formula evaluation when column not found in getColumns or columns', async () => {
      const formulaService = makeMockFormulaService()
      const config = createTestConfig({
        formulaService,
        columns: [{ id: 'col-a' }],
        getColumns: () => [{ id: 'col-a' }],
      })
      const deps = createMockDependencies()

      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-missing', oldValue: null, newValue: '=1+1' }],
          source: 'paste',
          timestamp: Date.now(),
        },
        deps
      )

      expect(formulaService.evaluate).not.toHaveBeenCalled()
      expect(formulaService.registerFormula).not.toHaveBeenCalled()
    })

    it('getColumns throwing falls back to static columns without throwing', async () => {
      const formulaService = makeMockFormulaService()
      const config = createTestConfig({
        formulaService,
        columns: [{ id: 'col-a' }],
        getColumns: () => { throw new Error('store torn down') },
      })
      const deps = createMockDependencies()

      // Must not throw — fallback to static columns and still evaluate the formula
      await expect(
        executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: null, newValue: '=1+1' }],
            source: 'paste',
            timestamp: Date.now(),
          },
          deps
        )
      ).resolves.toMatchObject({ backendSyncSucceeded: true })

      // Formula was evaluated using fallback columns (col-a is at index 0 → col=1)
      expect(formulaService.evaluate).toHaveBeenCalledTimes(1)
    })

    it('getColumns returning array with null entry does not throw and skips null entry', async () => {
      const formulaService = makeMockFormulaService()
      const config = createTestConfig({
        formulaService,
        columns: [],
        // null entry before the valid one
        getColumns: () => [null as unknown as { id: string }, { id: 'col-a' }],
      })
      const deps = createMockDependencies()

      // Must not throw — null entry is sanitized out; col-a is still found
      await expect(
        executeEdits(
          config,
          {
            edits: [{ row: 0, columnId: 'col-a', oldValue: null, newValue: '=SUM(1)' }],
            source: 'paste',
            timestamp: Date.now(),
          },
          deps
        )
      ).resolves.toMatchObject({ backendSyncSucceeded: true })

      // col-a is the surviving entry at effective index 0 → col=1
      expect(formulaService.registerFormula).toHaveBeenCalledWith(
        '0:col-a',
        '=SUM(1)',
        { row: 1, col: 1, sheet: 'Sheet1' }
      )
    })
  })
})
