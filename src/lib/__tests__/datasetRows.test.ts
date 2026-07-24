import { describe, expect, it } from 'vitest'
import {
  computeLoweredDataRowCount,
  getUsableRowCount,
  hasUsableRows,
} from '../datasetRows'

describe('datasetRows', () => {
  it('treats null and undefined datasets as empty', () => {
    expect(getUsableRowCount(null)).toBe(0)
    expect(hasUsableRows(null)).toBe(false)
    expect(getUsableRowCount(undefined)).toBe(0)
    expect(hasUsableRows(undefined)).toBe(false)
  })

  it('treats explicit dataRowCount=0 as an empty scaffold even when rowCount has buffer rows', () => {
    const dataset = { dataRowCount: 0, rowCount: 100 }

    expect(getUsableRowCount(dataset)).toBe(0)
    expect(hasUsableRows(dataset)).toBe(false)
  })

  it('falls back to rowCount for legacy datasets without dataRowCount', () => {
    const dataset = { rowCount: 50 }

    expect(getUsableRowCount(dataset)).toBe(50)
    expect(hasUsableRows(dataset)).toBe(true)
  })

  it('uses positive dataRowCount as usable rows', () => {
    const dataset = { dataRowCount: 1, rowCount: 100 }

    expect(getUsableRowCount(dataset)).toBe(1)
    expect(hasUsableRows(dataset)).toBe(true)
  })

  it('lowers dataRowCount to zero when cleared rows have no remaining values', () => {
    const rows = new Map<number, Record<string, unknown>>([
      [0, { a: '', b: null }],
      [1, { a: undefined, b: '' }],
    ])

    expect(computeLoweredDataRowCount(2, rows, ['a', 'b'])).toBe(0)
  })

  it('lowers dataRowCount to the last remaining non-empty row', () => {
    const rows = new Map<number, Record<string, unknown>>([
      [0, { a: 'alpha', b: '' }],
      [1, { a: '', b: '' }],
      [2, { a: '', b: '' }],
    ])

    expect(computeLoweredDataRowCount(3, rows, ['a', 'b'])).toBe(1)
  })

  it('never raises dataRowCount from a clear-content recompute', () => {
    const rows = new Map<number, Record<string, unknown>>([
      [4, { a: 'outside current count' }],
    ])

    expect(computeLoweredDataRowCount(2, rows, ['a'])).toBe(0)
  })
})
