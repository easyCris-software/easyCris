import { describe, expect, it } from 'vitest'
import { FORMULA_PENDING_SENTINEL } from '@/utils/formulaSentinel'
import { buildBackendPasteBlock } from '../backendPasteBlock'

describe('buildBackendPasteBlock', () => {
  it('builds a backend paste block with explicit model rows', () => {
    const result = buildBackendPasteBlock({
      values: [['A'], ['B']],
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 2,
      viewRowToModelRow: (row) => [5, 2][row],
    })

    expect(result).toEqual({
      usesBackendPaste: true,
      payload: {
        rows: [5, 2],
        columnIds: ['col-1'],
        values: [['A'], ['B']],
      },
    })
  })

  it('preserves scattered model rows', () => {
    const result = buildBackendPasteBlock({
      values: [['A'], ['B'], ['C']],
      startViewRow: 4,
      columnIds: ['col-1'],
      largePasteThreshold: 3,
      viewRowToModelRow: (row) => ({ 4: 20, 5: 3, 6: 11 })[row],
    })

    expect(result.usesBackendPaste).toBe(true)
    expect(result.payload?.rows).toEqual([20, 3, 11])
  })

  it('returns false when any value starts with formula syntax', () => {
    const result = buildBackendPasteBlock({
      values: [['A'], ['=SUM(A1:A2)']],
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 2,
      viewRowToModelRow: (row) => row,
    })

    expect(result.usesBackendPaste).toBe(false)
  })

  it('returns false when any value is a pending formula sentinel', () => {
    const result = buildBackendPasteBlock({
      values: [['A'], [FORMULA_PENDING_SENTINEL]],
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 2,
      viewRowToModelRow: (row) => row,
    })

    expect(result.usesBackendPaste).toBe(false)
  })

  it('returns false below threshold', () => {
    const result = buildBackendPasteBlock({
      values: [['A'], ['B']],
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 3,
      viewRowToModelRow: (row) => row,
    })

    expect(result.usesBackendPaste).toBe(false)
  })

  it.each([
    ['negative', -1],
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const)('rejects %s mapped rows instead of routing to backend', (_label, mappedRow) => {
    const result = buildBackendPasteBlock({
      values: [['A']],
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 1,
      viewRowToModelRow: () => mappedRow,
    })

    expect(result.usesBackendPaste).toBe(false)
  })

  it('rejects missing target columns', () => {
    const result = buildBackendPasteBlock({
      values: [['A', 'B']],
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 1,
      viewRowToModelRow: (row) => row,
    })

    expect(result.usesBackendPaste).toBe(false)
  })

  it('rejects payloads over the backend cap', () => {
    const result = buildBackendPasteBlock({
      values: Array.from({ length: 100_001 }, () => ['A']),
      startViewRow: 0,
      columnIds: ['col-1'],
      largePasteThreshold: 1,
      maxBackendPasteCells: 100_000,
      viewRowToModelRow: (row) => row,
    })

    expect(result.usesBackendPaste).toBe(false)
  })
})
