import { describe, it, expect } from 'vitest'
import { nextSortModel } from '../sortCycle'
import type { SortKey } from '../sortCycle'

describe('nextSortModel — sort cycle', () => {
  it('unsorted → asc on first click', () => {
    expect(nextSortModel([], 'col-a')).toEqual([{ colId: 'col-a', dir: 'asc' }])
  })

  it('asc → desc on second click', () => {
    expect(nextSortModel([{ colId: 'col-a', dir: 'asc' }], 'col-a'))
      .toEqual([{ colId: 'col-a', dir: 'desc' }])
  })

  it('desc → [] (clear) on third click', () => {
    expect(nextSortModel([{ colId: 'col-a', dir: 'desc' }], 'col-a')).toEqual([])
  })

  it('clicking a different column replaces sort with new asc key', () => {
    expect(nextSortModel([{ colId: 'col-a', dir: 'asc' }], 'col-b'))
      .toEqual([{ colId: 'col-b', dir: 'asc' }])
  })

  it('clicking col-a when model has [col-a asc, col-b desc] cycles col-a (replaces all)', () => {
    const input: SortKey[] = [{ colId: 'col-a', dir: 'asc' }, { colId: 'col-b', dir: 'desc' }]
    expect(nextSortModel(input, 'col-a')).toEqual([{ colId: 'col-a', dir: 'desc' }])
  })
})
