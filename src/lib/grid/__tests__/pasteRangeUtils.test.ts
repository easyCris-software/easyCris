import { describe, expect, it } from 'vitest'
import { expandClipboardForSelection } from '../pasteRangeUtils'

describe('expandClipboardForSelection', () => {
  it('spreads a single copied value across a larger selected range', () => {
    const result = expandClipboardForSelection([['x']], { width: 3, height: 10 })

    expect(result).toEqual(Array.from({ length: 10 }, () => ['x', 'x', 'x']))
  })

  it('repeats clipboard rows when selection height is an even multiple', () => {
    const result = expandClipboardForSelection([['a'], ['b']], { width: 1, height: 6 })

    expect(result).toEqual([['a'], ['b'], ['a'], ['b'], ['a'], ['b']])
  })

  it('tiles clipboard rows and columns when both selection dimensions are even multiples', () => {
    const result = expandClipboardForSelection(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      { width: 6, height: 4 }
    )

    expect(result).toEqual([
      ['a', 'b', 'a', 'b', 'a', 'b'],
      ['c', 'd', 'c', 'd', 'c', 'd'],
      ['a', 'b', 'a', 'b', 'a', 'b'],
      ['c', 'd', 'c', 'd', 'c', 'd'],
    ])
  })

  it('keeps clipboard data unchanged when selection dimensions do not divide evenly', () => {
    const parsedData = [
      ['a', 'b'],
      ['c', 'd'],
    ]

    expect(expandClipboardForSelection(parsedData, { width: 3, height: 3 })).toBe(parsedData)
  })

  it('keeps anchor-only paste behavior when no selection range is available', () => {
    const parsedData = [['a']]

    expect(expandClipboardForSelection(parsedData, null)).toBe(parsedData)
  })
})
