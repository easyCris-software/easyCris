import { describe, expect, it } from 'vitest'
import {
  getTransformPreflight,
  SPINNER_ROWS,
  CONFIRM_ROWS,
  HARD_BLOCK_ROWS,
  PIVOT_LONGER_OUTPUT_CAP,
  SORT_HARD_BLOCK_ROWS,
} from '@/utils/transformPreflight'

describe('getTransformPreflight', () => {
  // -----------------------------------------------------------------------
  // Filter
  // -----------------------------------------------------------------------
  describe('filter', () => {
    it('allows small datasets without spinner or confirm', () => {
      const result = getTransformPreflight({ type: 'filter', dataRowCount: 1_000 })
      expect(result.allow).toBe(true)
      expect(result.confirm).toBe(false)
      expect(result.showSpinner).toBe(false)
    })

    it('shows spinner above SPINNER_ROWS threshold', () => {
      const result = getTransformPreflight({ type: 'filter', dataRowCount: SPINNER_ROWS })
      expect(result.allow).toBe(true)
      expect(result.showSpinner).toBe(true)
      expect(result.confirm).toBe(false)
    })

    it('requires confirmation above CONFIRM_ROWS threshold', () => {
      const result = getTransformPreflight({ type: 'filter', dataRowCount: CONFIRM_ROWS })
      expect(result.allow).toBe(true)
      expect(result.confirm).toBe(true)
      expect(result.showSpinner).toBe(true)
    })

    it('hard blocks above HARD_BLOCK_ROWS', () => {
      const result = getTransformPreflight({ type: 'filter', dataRowCount: HARD_BLOCK_ROWS })
      expect(result.allow).toBe(false)
      expect(result.blockReason).toBeTruthy()
    })
  })

  // -----------------------------------------------------------------------
  // Group Aggregate
  // -----------------------------------------------------------------------
  describe('group_aggregate', () => {
    it('allows small datasets', () => {
      const result = getTransformPreflight({ type: 'group_aggregate', dataRowCount: 5_000 })
      expect(result.allow).toBe(true)
      expect(result.showSpinner).toBe(false)
    })

    it('hard blocks above HARD_BLOCK_ROWS', () => {
      const result = getTransformPreflight({ type: 'group_aggregate', dataRowCount: HARD_BLOCK_ROWS })
      expect(result.allow).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Pivot Longer
  // -----------------------------------------------------------------------
  describe('pivot_longer', () => {
    it('allows small datasets', () => {
      const result = getTransformPreflight({ type: 'pivot_longer', dataRowCount: 1_000, pivotColumnCount: 3 })
      expect(result.allow).toBe(true)
    })

    it('blocks when projected output exceeds PIVOT_LONGER_OUTPUT_CAP', () => {
      // 80K rows * 7 columns = 560K projected > 500K cap
      const result = getTransformPreflight({ type: 'pivot_longer', dataRowCount: 80_000, pivotColumnCount: 7 })
      expect(result.allow).toBe(false)
      expect(result.blockReason).toContain('560,000')
      expect(result.blockReason).toContain(PIVOT_LONGER_OUTPUT_CAP.toLocaleString())
    })

    it('allows when projected output is within cap', () => {
      // 50K rows * 5 columns = 250K projected < 300K cap
      const result = getTransformPreflight({ type: 'pivot_longer', dataRowCount: 50_000, pivotColumnCount: 5 })
      expect(result.allow).toBe(true)
      expect(result.confirm).toBe(true)
      expect(result.showSpinner).toBe(true)
    })

    it('hard blocks base row count above HARD_BLOCK_ROWS even if projected is within cap', () => {
      // 75K rows * 1 column = 75K projected (within cap), but base exceeds HARD_BLOCK_ROWS
      const result = getTransformPreflight({ type: 'pivot_longer', dataRowCount: HARD_BLOCK_ROWS, pivotColumnCount: 1 })
      expect(result.allow).toBe(false)
    })

    it('defaults pivotColumnCount to 1 if not provided', () => {
      const result = getTransformPreflight({ type: 'pivot_longer', dataRowCount: 1_000 })
      expect(result.allow).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Pivot Wider
  // -----------------------------------------------------------------------
  describe('pivot_wider', () => {
    it('always allows (streaming path handles large datasets)', () => {
      const result = getTransformPreflight({ type: 'pivot_wider', dataRowCount: 200_000 })
      expect(result.allow).toBe(true)
      // Pivot wider uses its own streaming spinner; preflight doesn't add one
      expect(result.showSpinner).toBe(false)
    })

    it('allows small datasets', () => {
      const result = getTransformPreflight({ type: 'pivot_wider', dataRowCount: 500 })
      expect(result.allow).toBe(true)
      expect(result.confirm).toBe(false)
      expect(result.showSpinner).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Sort
  // -----------------------------------------------------------------------
  describe('sort', () => {
    it('allows small datasets without spinner', () => {
      const result = getTransformPreflight({ type: 'sort', dataRowCount: 5_000 })
      expect(result.allow).toBe(true)
      expect(result.showSpinner).toBe(false)
    })

    it('shows spinner above SPINNER_ROWS', () => {
      const result = getTransformPreflight({ type: 'sort', dataRowCount: SPINNER_ROWS })
      expect(result.allow).toBe(true)
      expect(result.showSpinner).toBe(true)
    })

    it('requires confirmation above CONFIRM_ROWS', () => {
      const result = getTransformPreflight({ type: 'sort', dataRowCount: CONFIRM_ROWS })
      expect(result.allow).toBe(true)
      expect(result.confirm).toBe(true)
    })

    it('hard blocks above SORT_HARD_BLOCK_ROWS', () => {
      const result = getTransformPreflight({ type: 'sort', dataRowCount: SORT_HARD_BLOCK_ROWS })
      expect(result.allow).toBe(false)
      expect(result.blockReason).toBeTruthy()
    })
  })

  // -----------------------------------------------------------------------
  // Spinner messages
  // -----------------------------------------------------------------------
  describe('spinner messages', () => {
    it('returns correct message per operation type', () => {
      expect(getTransformPreflight({ type: 'filter', dataRowCount: SPINNER_ROWS }).spinnerMessage).toBe('Filtering data...')
      expect(getTransformPreflight({ type: 'group_aggregate', dataRowCount: SPINNER_ROWS }).spinnerMessage).toBe('Aggregating data...')
      expect(getTransformPreflight({ type: 'pivot_longer', dataRowCount: SPINNER_ROWS }).spinnerMessage).toBe('Reshaping data...')
      expect(getTransformPreflight({ type: 'pivot_wider', dataRowCount: 100 }).spinnerMessage).toBe('Pivoting data...')
      expect(getTransformPreflight({ type: 'sort', dataRowCount: SPINNER_ROWS }).spinnerMessage).toBe('Sorting data...')
    })
  })
})
