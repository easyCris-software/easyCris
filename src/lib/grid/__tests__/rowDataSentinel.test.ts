import { describe, expect, it } from 'vitest'
import {
  cloneRowDataPreservingSentinel,
  createRowDataSentinel,
  isRowDataSentinel,
} from '../rowDataSentinel'

describe('row data sentinels', () => {
  it('marks placeholder rows without marking real loaded rows', () => {
    const sentinel = createRowDataSentinel()
    const realRow = {}

    expect(isRowDataSentinel(sentinel)).toBe(true)
    expect(isRowDataSentinel(realRow)).toBe(false)
    expect(isRowDataSentinel({ col_1: null })).toBe(false)
    expect(isRowDataSentinel(null)).toBe(false)
    expect(isRowDataSentinel(undefined)).toBe(false)
    expect(isRowDataSentinel('row')).toBe(false)
  })

  it('drops the marker when a plain spread intentionally materializes row data', () => {
    const sentinel = createRowDataSentinel()
    const editedRow = { ...sentinel, col_1: 'typed value' }

    expect(isRowDataSentinel(editedRow)).toBe(false)
  })

  it('keeps the marker out of normal serialization and assignment clones', () => {
    const sentinel = createRowDataSentinel()

    expect(JSON.stringify(sentinel)).toBe('{}')
    expect(isRowDataSentinel(Object.assign({}, sentinel))).toBe(false)
  })

  it('can clone passive row updates without promoting a placeholder into real data', () => {
    const sentinel = createRowDataSentinel()
    sentinel.col_1 = 'computed'

    const clone = cloneRowDataPreservingSentinel(sentinel)
    clone.col_2 = ''

    expect(clone).toEqual({ col_1: 'computed', col_2: '' })
    expect(isRowDataSentinel(clone)).toBe(true)
  })
})
