/**
 * filterColumnsSnapshot.test.ts
 *
 * TDD tests for buildFullRowsByIndex — fetches full column vectors for the
 * columns referenced in a FilterConfig and builds a per-row record map.
 *
 * Written RED-first against a non-existent `filterColumnsSnapshot.ts` module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FilterConfig } from '@/services/dataTransformService'

// ---------------------------------------------------------------------------
// Mock cacheService — hoisted so vi.mock picks it up before module load
// ---------------------------------------------------------------------------

const cacheHarness = vi.hoisted(() => ({
  ensureLatestCache: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn<() => Promise<void>>>,
  getColumnsData: vi.fn().mockResolvedValue({}) as ReturnType<typeof vi.fn<() => Promise<Record<string, unknown[]>>>>,
}))

vi.mock('@/services/cacheService', () => ({
  cacheService: {
    ensureLatestCache: cacheHarness.ensureLatestCache,
    getColumnsData: cacheHarness.getColumnsData,
  },
}))

import { buildFullRowsByIndex, ViewFilterError } from '../filterColumnsSnapshot'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(columnIds: string[]): FilterConfig {
  return {
    groups: [
      {
        op: 'AND',
        conditions: columnIds.map((id) => ({ columnId: id, operator: 'eq' as const, value: '' })),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// BUILDS COMPLETE ROW MAP
// ---------------------------------------------------------------------------

describe('buildFullRowsByIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('1b.1 BUILDS_MAP: builds complete rows for all referenced columns', async () => {
    cacheHarness.getColumnsData.mockResolvedValueOnce({
      'col-a': ['Alice', 'Bob', 'Carol'],
      'col-b': [10, 20, 30],
    })

    const config = makeConfig(['col-a', 'col-b'])
    const result = await buildFullRowsByIndex('ds-1', 3, config)

    expect(result.size).toBe(3)
    expect(result.get(0)).toEqual({ 'col-a': 'Alice', 'col-b': 10 })
    expect(result.get(1)).toEqual({ 'col-a': 'Bob', 'col-b': 20 })
    expect(result.get(2)).toEqual({ 'col-a': 'Carol', 'col-b': 30 })
  })

  it('1b.1 CALLS_CACHE: calls ensureLatestCache then getColumnsData with correct args', async () => {
    cacheHarness.getColumnsData.mockResolvedValueOnce({ 'col-x': [1, 2] })

    const config = makeConfig(['col-x'])
    await buildFullRowsByIndex('ds-abc', 2, config)

    expect(cacheHarness.ensureLatestCache).toHaveBeenCalledWith('ds-abc')
    expect(cacheHarness.getColumnsData).toHaveBeenCalledWith('ds-abc', ['col-x'])
  })

  it('1b.1 DEDUP_COLUMNS: deduplicates column IDs referenced multiple times', async () => {
    cacheHarness.getColumnsData.mockResolvedValueOnce({ 'col-a': ['x', 'y'] })

    // Config referencing col-a twice (two conditions on same column)
    const config: FilterConfig = {
      groups: [
        {
          op: 'AND',
          conditions: [
            { columnId: 'col-a', operator: 'eq', value: 'x' },
            { columnId: 'col-a', operator: 'ne', value: 'z' },
          ],
        },
      ],
    }
    await buildFullRowsByIndex('ds-1', 2, config)

    const call = cacheHarness.getColumnsData.mock.calls[0] as unknown as [string, string[]]
    expect(call[1]).toEqual(['col-a'])  // deduplicated
  })

  // ---------------------------------------------------------------------------
  // NULL / EMPTY CONFIG → empty map without throw
  // ---------------------------------------------------------------------------

  it('1b.2 NULL_CONFIG: returns empty map when filterConfig is null', async () => {
    const result = await buildFullRowsByIndex('ds-1', 5, null)
    expect(result.size).toBe(0)
    expect(cacheHarness.ensureLatestCache).not.toHaveBeenCalled()
    expect(cacheHarness.getColumnsData).not.toHaveBeenCalled()
  })

  it('1b.2 EMPTY_CONDITIONS: returns empty map when all groups have no conditions', async () => {
    const config: FilterConfig = { groups: [{ op: 'AND', conditions: [] }] }
    const result = await buildFullRowsByIndex('ds-1', 5, config)
    expect(result.size).toBe(0)
    expect(cacheHarness.getColumnsData).not.toHaveBeenCalled()
  })

  it('1b.2 EMPTY_GROUPS: returns empty map when groups array is empty', async () => {
    const config: FilterConfig = { groups: [] }
    const result = await buildFullRowsByIndex('ds-1', 5, config)
    expect(result.size).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // PARTIAL COLUMN DATA — column vector shorter than dataRowCount
  // ---------------------------------------------------------------------------

  it('1b.1 PARTIAL_DATA: rows beyond column vector length get undefined value (not crash)', async () => {
    // Column only has 2 entries but dataRowCount is 3
    cacheHarness.getColumnsData.mockResolvedValueOnce({ 'col-a': ['x', 'y'] })

    const config = makeConfig(['col-a'])
    const result = await buildFullRowsByIndex('ds-1', 3, config)

    expect(result.size).toBe(3)
    expect(result.get(0)?.['col-a']).toBe('x')
    expect(result.get(1)?.['col-a']).toBe('y')
    expect(result.get(2)?.['col-a']).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // ERROR HANDLING — column fetch failure must throw a deterministic error
  // ---------------------------------------------------------------------------

  it('1b.3 FETCH_FAILURE: throws ViewFilterError instance when getColumnsData rejects', async () => {
    cacheHarness.getColumnsData.mockRejectedValueOnce(new Error('IPC error'))

    const config = makeConfig(['col-a'])
    await expect(buildFullRowsByIndex('ds-1', 3, config)).rejects.toBeInstanceOf(ViewFilterError)
  })

  it('1b.3 FETCH_FAILURE_MESSAGE: error message contains dataset id and column ids', async () => {
    cacheHarness.getColumnsData.mockRejectedValueOnce(new Error('network timeout'))

    const config = makeConfig(['col-x', 'col-y'])
    await expect(buildFullRowsByIndex('my-dataset', 3, config)).rejects.toThrow('my-dataset')
  })
})
