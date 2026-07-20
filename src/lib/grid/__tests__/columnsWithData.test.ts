import { describe, it, expect, vi, beforeEach } from 'vitest'
import { filterColumnsWithData } from '../columnsWithData'
import type { ColumnMetadata } from '@/store/data-store'

// ---------------------------------------------------------------------------
// Mock cacheService
// ---------------------------------------------------------------------------

const mockGetAllColumnStats = vi.fn()

vi.mock('@/services/cacheService', () => ({
  default: {
    getAllColumnStats: (...args: any[]) => mockGetAllColumnStats(...args),
  },
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const col = (id: string, name = id): ColumnMetadata => ({
  id,
  name,
  type: 'categorical',
})

const stat = (columnId: string, nonNullCount: number) => ({
  columnId,
  nonNullCount,
  totalRows: 10,
  distinctCount: nonNullCount,
  numericCount: 0,
})

const DATASET_ID = 'ds-1'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('filterColumnsWithData', () => {
  beforeEach(() => {
    mockGetAllColumnStats.mockReset()
  })

  it('returns only columns with nonNullCount > 0', async () => {
    const columns = [col('a'), col('b'), col('c')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 5),
      stat('b', 0),  // empty
      stat('c', 3),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('falls back to full list when all columns are empty', async () => {
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 0),
      stat('b', 0),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result).toEqual(columns)
  })

  it('falls back to full list when stats call throws', async () => {
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockRejectedValue(new Error('network error'))
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result).toEqual(columns)
  })

  it('always includes force-include IDs even when nonNullCount = 0', async () => {
    const columns = [col('sort-col'), col('b'), col('c')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('sort-col', 0),  // empty but forced
      stat('b', 0),
      stat('c', 4),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns, ['sort-col'])
    expect(result.map((c) => c.id)).toContain('sort-col')
    expect(result.map((c) => c.id)).toContain('c')
    expect(result.map((c) => c.id)).not.toContain('b')
  })

  it('ignores empty-string force-include IDs (no active sort/group)', async () => {
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 2),
      stat('b', 0),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns, [''])
    expect(result.map((c) => c.id)).toEqual(['a'])
  })

  it('preserves column order from the original list', async () => {
    const columns = [col('z'), col('a'), col('m')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('z', 1),
      stat('a', 1),
      stat('m', 1),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result.map((c) => c.id)).toEqual(['z', 'a', 'm'])
  })

  it('returns full list when stats return no entries for any column', async () => {
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockResolvedValue([])  // backend returned nothing
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result).toEqual(columns)
  })

  it('falls back to full list when stats coverage is partial (column missing from response)', async () => {
    // 'a' has data, 'b' is entirely absent from stats — cannot trust the result
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 5),
      // 'b' not in stats — partial coverage
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result).toEqual(columns)
  })

  it('filters normally when stats coverage is complete (all columns present in response)', async () => {
    const columns = [col('a'), col('b'), col('c')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 5),
      stat('b', 0),
      stat('c', 2),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result.map((c) => c.id)).toEqual(['a', 'c'])
  })

  // ---------------------------------------------------------------------------
  // missing_as_empty policy
  // ---------------------------------------------------------------------------

  it('missing_as_empty: treats columns absent from stats as empty (filters them out)', async () => {
    // Padded schema columns (col-8 … col-12) are never returned by backend stats.
    // With missing_as_empty they should disappear, not trigger a full-list fallback.
    const columns = [col('a'), col('b'), col('pad-8'), col('pad-9')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 5),
      stat('b', 0),
      // pad-8, pad-9 absent — treated as empty, not as partial coverage
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns, [], 'dialog', 'missing_as_empty')
    expect(result.map((c) => c.id)).toEqual(['a'])
  })

  it('missing_as_empty: still falls back when every known column is empty', async () => {
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockResolvedValue([
      stat('a', 0),
      stat('b', 0),
    ])
    const result = await filterColumnsWithData(DATASET_ID, columns, [], 'dialog', 'missing_as_empty')
    expect(result).toEqual(columns)
  })

  it('missing_as_empty: force-includes active column even when absent from stats', async () => {
    const columns = [col('sort-col'), col('pad-8')]
    mockGetAllColumnStats.mockResolvedValue([])  // backend returned nothing for these
    const result = await filterColumnsWithData(DATASET_ID, columns, ['sort-col'], 'dialog', 'missing_as_empty')
    // sort-col is force-included; pad-8 is absent → treated as empty
    expect(result.map((c) => c.id)).toContain('sort-col')
    expect(result.map((c) => c.id)).not.toContain('pad-8')
  })

  it('strict_fallback (default): still falls back on partial coverage', async () => {
    const columns = [col('a'), col('b')]
    mockGetAllColumnStats.mockResolvedValue([stat('a', 5)])
    // default policy — 'b' missing from stats triggers full-list fallback
    const result = await filterColumnsWithData(DATASET_ID, columns)
    expect(result).toEqual(columns)
  })
})
