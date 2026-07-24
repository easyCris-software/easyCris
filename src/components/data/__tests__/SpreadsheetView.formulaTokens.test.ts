import { describe, expect, it } from 'vitest'
import {
  buildFormulaBarTokenSegments,
  getFormulaBarTokenTextColors,
} from '../SpreadsheetView'

describe('SpreadsheetView formula bar token colors', () => {
  it('uses a dark-specific token palette in dark mode', () => {
    const tokenColors = getFormulaBarTokenTextColors('dark')
    const segments = buildFormulaBarTokenSegments('=A1+B2', '#F8FAFC', tokenColors)

    expect(tokenColors[0]).toBe('#60A5FA')
    expect(segments.some(segment => segment.color === '#0000CC')).toBe(false)
    expect(segments[1]?.color).toBe('#60A5FA')
  })
})
