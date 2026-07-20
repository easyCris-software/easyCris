import { describe, expect, it } from 'vitest'
import {
  extractCellReferences,
  extractFormulaReferenceRegions,
  extractFormulaReferenceTokenSpans,
} from '../formulaUtils'

describe('formulaUtils reference region extraction', () => {
  it('extracts single cell and range references as contiguous regions', () => {
    const regions = extractFormulaReferenceRegions('=C2-C1+SUM(A1:A10)')
    expect(regions).toEqual([
      {
        token: 'C2',
        tokenIndex: 0,
        range: { x: 2, y: 1, width: 1, height: 1 },
      },
      {
        token: 'C1',
        tokenIndex: 1,
        range: { x: 2, y: 0, width: 1, height: 1 },
      },
      {
        token: 'A1:A10',
        tokenIndex: 2,
        range: { x: 0, y: 0, width: 1, height: 10 },
      },
    ])
  })

  it('ignores A1-like text inside string literals', () => {
    const regions = extractFormulaReferenceRegions('=IF(A1="B2",SUM(C1:C3),D1)')
    expect(regions.map(r => r.token)).toEqual(['A1', 'C1:C3', 'D1'])
  })

  it('supports absolute references and normalizes region bounds', () => {
    const regions = extractFormulaReferenceRegions('=$B$10:$A$8')
    expect(regions).toEqual([
      {
        token: '$B$10:$A$8',
        tokenIndex: 0,
        range: { x: 0, y: 7, width: 2, height: 3 },
      },
    ])
  })

  it('avoids function-name and alphanumeric-token false positives', () => {
    const functionCall = extractFormulaReferenceRegions('=LOG10(A1)+A2')
    expect(functionCall.map((r) => r.token)).toEqual(['A1', 'A2'])

    const mixedToken = extractFormulaReferenceRegions('=R2D2+A1')
    expect(mixedToken.map((r) => r.token)).toEqual(['A1'])
  })

  it('returns token spans for inline formula bar coloring', () => {
    const spans = extractFormulaReferenceTokenSpans('=SUM(A1:B2)+C3')
    expect(spans.map((s) => s.token)).toEqual(['A1:B2', 'C3'])
    expect(spans[0]?.start).toBe(5)
    expect(spans[0]?.end).toBe(10)
  })

  it('extractCellReferences avoids alphanumeric false positives', () => {
    const refsFromFunctionToken = extractCellReferences('=LOG10(A1)+A2')
    expect(refsFromFunctionToken).toEqual([
      { col: 0, row: 0 },
      { col: 0, row: 1 },
    ])

    const refsFromMixedToken = extractCellReferences('=R2D2+A1')
    expect(refsFromMixedToken).toEqual([{ col: 0, row: 0 }])
  })

  it('ignores quoted sheet-name tokens while still extracting post-bang refs', () => {
    const spans = extractFormulaReferenceTokenSpans("='Sheet 1'!A1+'S2'!B2")
    expect(spans.map((s) => s.token)).toEqual(['A1', 'B2'])

    const refs = extractCellReferences("='Sheet 1'!A1+'S2'!B2")
    expect(refs).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 1 },
    ])
  })
})
