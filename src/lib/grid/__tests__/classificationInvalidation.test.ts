/**
 * Classification Invalidation Tests - Phase 4
 *
 * Tests for the classification cache and invalidation system.
 * Verifies the logic for determining when columns need re-classification.
 *
 * Option A (Excel-like): only edited columns are invalidated.
 *
 * @see GRID_ENHANCEMENT_PLAN.md - Phase 4
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useDataStore } from '@/store/data-store'

describe('Classification Invalidation System (Option A)', () => {
  beforeEach(() => {
    useDataStore.getState().clearAllInvalidation()
  })

  describe('invalidatedColumnIds management', () => {
    it('starts with empty set', () => {
      expect(useDataStore.getState().invalidatedColumnIds.size).toBe(0)
    })

    it('invalidateColumns adds columns to set', () => {
      useDataStore.getState().invalidateColumns(['col-a', 'col-b'])
      const state = useDataStore.getState()
      expect(state.invalidatedColumnIds.has('col-a')).toBe(true)
      expect(state.invalidatedColumnIds.has('col-b')).toBe(true)
    })

    it('invalidateColumns accumulates (does not replace)', () => {
      useDataStore.getState().invalidateColumns(['col-a'])
      useDataStore.getState().invalidateColumns(['col-b'])
      const state = useDataStore.getState()
      expect(state.invalidatedColumnIds.has('col-a')).toBe(true)
      expect(state.invalidatedColumnIds.has('col-b')).toBe(true)
    })

    it('clearInvalidation removes a column from set', () => {
      useDataStore.getState().invalidateColumns(['col-a', 'col-b'])
      useDataStore.getState().clearInvalidation('col-a')
      const state = useDataStore.getState()
      expect(state.invalidatedColumnIds.has('col-a')).toBe(false)
      expect(state.invalidatedColumnIds.has('col-b')).toBe(true)
    })

    it('clearInvalidation is a no-op when not invalidated', () => {
      useDataStore.getState().clearInvalidation('col-a')
      expect(useDataStore.getState().invalidatedColumnIds.size).toBe(0)
    })

    it('isColumnInvalidated returns correct status', () => {
      useDataStore.getState().invalidateColumns(['col-a'])
      expect(useDataStore.getState().isColumnInvalidated('col-a')).toBe(true)
      expect(useDataStore.getState().isColumnInvalidated('col-b')).toBe(false)
    })
  })

  describe('columnClassificationCache management', () => {
    it('starts with empty cache', () => {
      expect(useDataStore.getState().columnClassificationCache.size).toBe(0)
    })

    it('setColumnClassification adds to cache', () => {
      useDataStore.getState().setColumnClassification('col-a', {
        classification: { type: 'numeric' },
      })
      const cached = useDataStore.getState().getColumnClassification('col-a')
      expect(cached).toBeDefined()
      expect(cached?.classification).toEqual({ type: 'numeric' })
    })

    it('setColumnClassification overwrites existing entry', () => {
      useDataStore.getState().setColumnClassification('col-a', {
        classification: { type: 'numeric' },
      })
      useDataStore.getState().setColumnClassification('col-a', {
        classification: { type: 'categorical' },
      })
      const cached = useDataStore.getState().getColumnClassification('col-a')
      expect(cached?.classification).toEqual({ type: 'categorical' })
    })

    it('getColumnClassification returns undefined for uncached column', () => {
      expect(useDataStore.getState().getColumnClassification('nonexistent')).toBeUndefined()
    })
  })

  describe('shouldReclassifyColumn logic', () => {
    it('returns true when no cached classification exists', () => {
      expect(useDataStore.getState().shouldReclassifyColumn('col-a')).toBe(true)
    })

    it('returns false when cached classification exists and column not invalidated', () => {
      useDataStore.getState().setColumnClassification('col-a', { classification: { type: 'numeric' } })
      expect(useDataStore.getState().shouldReclassifyColumn('col-a')).toBe(false)
    })

    it('returns true when column is invalidated (even if cached)', () => {
      useDataStore.getState().setColumnClassification('col-a', { classification: { type: 'numeric' } })
      useDataStore.getState().invalidateColumns(['col-a'])
      expect(useDataStore.getState().shouldReclassifyColumn('col-a')).toBe(true)
    })
  })

  describe('clearAllInvalidation', () => {
    it('clears invalidatedColumnIds and classification cache', () => {
      useDataStore.getState().invalidateColumns(['col-a', 'col-b'])
      useDataStore.getState().setColumnClassification('col-a', { classification: { type: 'numeric' } })
      useDataStore.getState().clearAllInvalidation()
      expect(useDataStore.getState().invalidatedColumnIds.size).toBe(0)
      expect(useDataStore.getState().columnClassificationCache.size).toBe(0)
    })
  })

  describe('Reclassification workflow', () => {
    it('invalidate → reclassify → clearInvalidation restores cache hit', () => {
      // Initial cached classification
      useDataStore.getState().setColumnClassification('col-a', { classification: { type: 'numeric' } })
      expect(useDataStore.getState().shouldReclassifyColumn('col-a')).toBe(false)

      // Edit happens (invalidate)
      useDataStore.getState().invalidateColumns(['col-a'])
      expect(useDataStore.getState().shouldReclassifyColumn('col-a')).toBe(true)

      // Reclassification stores new classification and clears invalidation
      useDataStore.getState().setColumnClassification('col-a', { classification: { type: 'numeric', updated: true } })
      useDataStore.getState().clearInvalidation('col-a')

      expect(useDataStore.getState().shouldReclassifyColumn('col-a')).toBe(false)
    })
  })
})

