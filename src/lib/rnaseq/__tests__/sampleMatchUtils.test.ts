/**
 * Unit tests for src/lib/rnaseq/sampleMatchUtils.ts
 *
 * Covers pure helpers and getCountSampleIdsWithData:
 *   U1:  isPlaceholderColumnName — recognises "Column N" pattern
 *   U2:  isPlaceholderColumnName — passes real sample names through
 *   U3:  hasMatchableSamples — null/undefined → false
 *   U4:  hasMatchableSamples — scaffold (dataRowCount=0) → false
 *   U5:  hasMatchableSamples — legacy dataset (dataRowCount absent, rowCount>0) → true
 *   U6:  hasMatchableSamples — modern dataset (dataRowCount>0) → true
 *   U7:  confirmSampleMismatch — calls window.confirm with message + label
 *   U8:  getCountSampleIdsWithData — placeholder columns filtered before cacheService call
 *   U9:  getCountSampleIdsWithData — only columns with sampled data are returned
 *   U10: getCountSampleIdsWithData — falls back to column headers when cacheService throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isPlaceholderColumnName,
  normalizeSampleId,
  hasMatchableSamples,
  confirmSampleMismatch,
  getCountSampleIdsWithData,
} from '@/lib/rnaseq/sampleMatchUtils'

// ---------------------------------------------------------------------------
// Mock cacheService for the async tests (U8–U10)
// ---------------------------------------------------------------------------
vi.mock('@/services/cacheService', () => ({
  default: {
    getColumnsSampledData: vi.fn(),
    getAllColumnStats: vi.fn(),
  },
}))

import cacheService from '@/services/cacheService'

const mockGetColumnsSampledData = vi.mocked(cacheService.getColumnsSampledData)
const mockGetAllColumnStats = vi.mocked(cacheService.getAllColumnStats)

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
type ColType = 'numeric' | 'categorical' | 'text' | 'datetime'

const makeDataset = (
  columns: Array<{ id: string; name: string; type?: ColType }>,
  rowCount = 100,
  dataRowCount?: number
) => ({
  id: 'ds-1',
  columns: columns.map((c) => ({ type: 'numeric' as ColType, width: 88, ...c })),
  rowCount,
  dataRowCount,
})

const geneCol = { id: 'gene', name: 'Gene' }
const s1Col = { id: 's1', name: 'S1' }
const s2Col = { id: 's2', name: 'S2' }
const col4 = { id: 'col-4', name: 'Column 4' }
const col5 = { id: 'col-5', name: 'Column 5' }

// ---------------------------------------------------------------------------

describe('sampleMatchUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // U1 / U2 — isPlaceholderColumnName
  // -------------------------------------------------------------------------
  describe('isPlaceholderColumnName', () => {
    it('U1: returns true for "Column N" patterns', () => {
      expect(isPlaceholderColumnName('Column 1')).toBe(true)
      expect(isPlaceholderColumnName('Column 12')).toBe(true)
      expect(isPlaceholderColumnName('Column 100')).toBe(true)
      expect(isPlaceholderColumnName('  Column 5  ')).toBe(true)
    })

    it('U2: returns false for real sample column names', () => {
      expect(isPlaceholderColumnName('S1')).toBe(false)
      expect(isPlaceholderColumnName('gene')).toBe(false)
      expect(isPlaceholderColumnName('sample_1')).toBe(false)
      expect(isPlaceholderColumnName('ColumnA')).toBe(false)
      expect(isPlaceholderColumnName('')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // U_norm — normalizeSampleId
  // -------------------------------------------------------------------------
  describe('normalizeSampleId', () => {
    it('U_norm1: returns empty string for null', () => {
      expect(normalizeSampleId(null)).toBe('')
    })

    it('U_norm2: returns empty string for undefined', () => {
      expect(normalizeSampleId(undefined)).toBe('')
    })

    it('U_norm3: trims whitespace from strings', () => {
      expect(normalizeSampleId('  S1  ')).toBe('S1')
      expect(normalizeSampleId('\tSample\n')).toBe('Sample')
    })

    it('U_norm4: coerces numbers to strings', () => {
      expect(normalizeSampleId(42)).toBe('42')
      expect(normalizeSampleId(3.14)).toBe('3.14')
    })

    it('U_norm5: coerces non-string non-null to string via String()', () => {
      expect(normalizeSampleId(true)).toBe('true')
      expect(normalizeSampleId(false)).toBe('false')
    })
  })

  // -------------------------------------------------------------------------
  // U3–U6 — hasMatchableSamples
  // -------------------------------------------------------------------------
  describe('hasMatchableSamples', () => {
    it('U3: returns false for null/undefined', () => {
      expect(hasMatchableSamples(null)).toBe(false)
      expect(hasMatchableSamples(undefined)).toBe(false)
    })

    it('U4: returns false for scaffold (dataRowCount=0)', () => {
      expect(hasMatchableSamples({ id: 'x', columns: [], rowCount: 100, dataRowCount: 0 })).toBe(false)
    })

    it('U5: returns true for legacy dataset (dataRowCount absent, rowCount>0)', () => {
      // Legacy datasets only have rowCount; ?? fallback must handle this
      expect(hasMatchableSamples({ id: 'x', columns: [], rowCount: 50, dataRowCount: undefined })).toBe(true)
    })

    it('U6: returns true for modern dataset with real imported data', () => {
      expect(hasMatchableSamples({ id: 'x', columns: [], rowCount: 150, dataRowCount: 100 })).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // U7 — confirmSampleMismatch
  // -------------------------------------------------------------------------
  describe('confirmSampleMismatch', () => {
    it('U7: calls window.confirm with mismatch message and action label', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const sampleMatch = {
        status: 'error' as const,
        message: 'Samples in counts but not in metadata: S3',
        matchedSamples: ['S1', 'S2'],
        onlyInCounts: ['S3'],
        onlyInMetadata: [],
        matchCount: 2,
        totalCountSamples: 3,
        totalMetaSamples: 2,
      }

      const result = confirmSampleMismatch(sampleMatch, 'import')

      expect(confirmSpy).toHaveBeenCalledTimes(1)
      const prompt = confirmSpy.mock.calls[0]?.[0]
      expect(prompt).toContain(sampleMatch.message)
      expect(prompt).toContain('import')
      expect(result).toBe(true)
    })

    it('U7b: returns false when user cancels', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      const sampleMatch = {
        status: 'error' as const,
        message: 'mismatch',
        matchedSamples: [],
        onlyInCounts: ['S1'],
        onlyInMetadata: [],
        matchCount: 0,
        totalCountSamples: 1,
        totalMetaSamples: 0,
      }
      expect(confirmSampleMismatch(sampleMatch, 'configure')).toBe(false)
    })

    it('U7c: default action is "import" when second arg is omitted', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const sampleMatch = {
        status: 'error' as const,
        message: 'Mismatch message',
        matchedSamples: [],
        onlyInCounts: ['X'],
        onlyInMetadata: [],
        matchCount: 0,
        totalCountSamples: 1,
        totalMetaSamples: 0,
      }
      confirmSampleMismatch(sampleMatch)
      const prompt = confirmSpy.mock.calls[0]?.[0]
      expect(prompt).toContain('import')
    })
  })

  // -------------------------------------------------------------------------
  // U8–U10 — getCountSampleIdsWithData
  // -------------------------------------------------------------------------
  describe('getCountSampleIdsWithData', () => {
    it('U8: placeholder columns are never passed to cacheService', async () => {
      const dataset = makeDataset([geneCol, s1Col, s2Col, col4, col5], 100, 50)
      mockGetColumnsSampledData.mockResolvedValue({
        s1: [10, 20, 30],
        s2: [5, 15, 25],
      })

      await getCountSampleIdsWithData(dataset)

      // cacheService must only be called with real (non-placeholder) column IDs
      expect(mockGetColumnsSampledData).toHaveBeenCalledTimes(1)
      const requestedIds = mockGetColumnsSampledData.mock.calls[0]?.[1]
      expect(requestedIds).toContain('s1')
      expect(requestedIds).toContain('s2')
      expect(requestedIds).not.toContain('col-4')
      expect(requestedIds).not.toContain('col-5')
    })

    it('U9: returns only column names where sampled data is non-empty', async () => {
      const dataset = makeDataset([geneCol, s1Col, s2Col], 100, 50)
      // S1 has data, S2 is empty
      mockGetColumnsSampledData.mockResolvedValue({
        s1: [10, 20],
        s2: [],
      })

      const ids = await getCountSampleIdsWithData(dataset)

      expect(ids).toContain('S1')
      expect(ids).not.toContain('S2')
    })

    it('U10: falls back to column names (no cacheService call filtered) when cacheService throws', async () => {
      const dataset = makeDataset([geneCol, s1Col, s2Col, col4], 100, 50)
      mockGetColumnsSampledData.mockRejectedValue(new Error('cache miss'))
      mockGetAllColumnStats.mockRejectedValue(new Error('stats fail'))

      const ids = await getCountSampleIdsWithData(dataset)

      // Fallback: returns non-placeholder column names
      expect(ids).toContain('S1')
      expect(ids).toContain('S2')
      expect(ids).not.toContain('Column 4')
    })
  })
})
