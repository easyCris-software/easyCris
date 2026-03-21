/**
 * Edit Executor Unit Tests
 *
 * Tests the unified edit pipeline to ensure all side effects
 * are executed correctly for different edit sources.
 *
 * @see GRID_ENHANCEMENT_PLAN.md - Phase 1 Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeEdits } from '../editExecutor'
import type { EditSource } from '../types'
import {
  createTestConfig,
  createMockDependencies,
  createMockRowData,
  applyRowDataUpdate,
} from './testUtils'

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

    it('updates "green dot" only for non-empty value', async () => {
      const updateActiveFamilyData = vi.fn()
      const config = createTestConfig({ updateActiveFamilyData })
      const deps = createMockDependencies()

      // Non-empty value should update
      await executeEdits(
        config,
        {
          edits: [{ row: 0, columnId: 'col-a', oldValue: '', newValue: 'value' }],
          source: 'type',
          timestamp: Date.now(),
        },
        deps
      )
      expect(updateActiveFamilyData).toHaveBeenCalledWith('test-dataset')

      updateActiveFamilyData.mockClear()

      // Empty value should NOT update
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

    it('handles null and undefined values for green dot check', async () => {
      const updateActiveFamilyData = vi.fn()
      const config = createTestConfig({ updateActiveFamilyData })
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

    it('calls cacheService.updateCellsBatch once', async () => {
      const config = createTestConfig()
      const deps = createMockDependencies()

      const edits = [
        { row: 0, columnId: 'col-a', oldValue: 'a1', newValue: 'b1' },
        { row: 1, columnId: 'col-a', oldValue: 'a2', newValue: 'b2' },
      ]

      await executeEdits(config, { edits, source: 'paste', timestamp: Date.now() }, deps)

      expect(deps.cacheService.updateCellsBatch).toHaveBeenCalledTimes(1)
      expect(deps.cacheService.updateCellsBatch).toHaveBeenCalledWith('test-dataset', [
        { row: 0, column: 'col-a', value: 'b1' },
        { row: 1, column: 'col-a', value: 'b2' },
      ])
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

      await executeEdits(
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
      await executeEdits(
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
          updateCellsBatch: vi.fn().mockRejectedValue(new Error('Batch sync failed')),
        },
      })

      // Multiple edits trigger batch path
      await executeEdits(
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
})
