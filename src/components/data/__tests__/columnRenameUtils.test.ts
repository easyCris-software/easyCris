import { describe, expect, it, vi } from 'vitest'
import { resolveColumnRenameTarget } from '../columnRenameUtils'

const makeColumns = (names: string[]) =>
  names.map((name, index) => ({
    id: `col-${index}`,
    name,
    type: 'text' as const,
    width: 88,
  }))

describe('resolveColumnRenameTarget', () => {
  it('returns trimmed user input for non-blank rename', () => {
    const result = resolveColumnRenameTarget({
      colIndex: 1,
      requestedName: '  Mean  ',
      columns: makeColumns(['Column 1', 'Column 2']),
    })

    expect(result).toEqual({
      nextName: 'Mean',
      reservedAutoName: null,
    })
  })

  it('uses deterministic placeholder when blank rename is available', () => {
    const result = resolveColumnRenameTarget({
      colIndex: 2,
      requestedName: '   ',
      columns: makeColumns(['Column 1', 'Column 2', 'Mean']),
    })

    expect(result).toEqual({
      nextName: 'Column 3',
      reservedAutoName: null,
    })
  })

  it('uses allocator fallback when deterministic placeholder is taken', () => {
    const allocate = vi.fn(() => 'Column 101')

    const result = resolveColumnRenameTarget({
      colIndex: 0,
      requestedName: '',
      columns: makeColumns(['Mean', 'Column 1']),
      allocateAutoName: allocate,
    })

    expect(allocate).toHaveBeenCalledOnce()
    expect(result).toEqual({
      nextName: 'Column 101',
      reservedAutoName: 'Column 101',
    })
  })

  it('falls back to the next free placeholder when allocator fails or collides', () => {
    const allocate = vi.fn(() => 'Column 2')

    const result = resolveColumnRenameTarget({
      colIndex: 0,
      requestedName: '',
      columns: makeColumns(['Mean', 'Column 1', 'Column 2']),
      allocateAutoName: allocate,
    })

    expect(result).toEqual({
      nextName: 'Column 3',
      reservedAutoName: 'Column 2',
    })
  })
})
