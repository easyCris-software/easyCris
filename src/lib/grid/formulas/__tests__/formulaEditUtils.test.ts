import { describe, it, expect } from 'vitest'
import {
  buildA1ReferenceFromRect,
  doesRectContainCell,
  excludeCellFromRect,
  insertReferenceIntoFormulaDraft,
  hasSheetQualifiedReferences,
  isFormulaCaptureInput,
  isFormulaRangePickMode,
  normalizeFormulaBeforeCommit,
  normalizeFormulaDraftForCommit,
  normalizeFormulaCaptureDraft,
  stripSheetQualifiedReferences,
  toggleAbsoluteReferenceAtCaret,
} from '../formulaEditUtils'

describe('formulaEditUtils', () => {
  it('detects formula capture mode for equals and known function forms', () => {
    expect(isFormulaCaptureInput('=MAX(')).toBe(true)
    expect(isFormulaCaptureInput('MAX(')).toBe(true)
    expect(isFormulaCaptureInput('hello(')).toBe(false)
    expect(isFormulaCaptureInput('plain text')).toBe(false)
  })

  it('normalizes function-style input by prepending equals', () => {
    const result = normalizeFormulaCaptureDraft('MAX(', 4, 4)
    expect(result.text).toBe('=MAX(')
    expect(result.caretStart).toBe(5)
    expect(result.caretEnd).toBe(5)
  })

  it('normalizes function-style draft on commit', () => {
    expect(normalizeFormulaDraftForCommit('MAX(')).toBe('=MAX()')
    expect(normalizeFormulaDraftForCommit('plain')).toBe('plain')
  })

  it('auto-closes missing right parentheses on commit normalization', () => {
    const normalized = normalizeFormulaBeforeCommit('=SUM(A1:A10')
    expect(normalized.error).toBeNull()
    expect(normalized.autoClosedCount).toBe(1)
    expect(normalized.text).toBe('=SUM(A1:A10)')
  })

  it('ignores parentheses inside string literals when balancing', () => {
    const normalized = normalizeFormulaBeforeCommit('=IF(A1="(",SUM(A1:A2)')
    expect(normalized.error).toBeNull()
    expect(normalized.autoClosedCount).toBe(1)
    expect(normalized.text).toBe('=IF(A1="(",SUM(A1:A2))')
  })

  it('returns explicit error for extra closing parentheses', () => {
    const normalized = normalizeFormulaBeforeCommit('=SUM(A1:A10))')
    expect(normalized.error).toBe('Unmatched closing parenthesis in formula.')
    expect(normalized.autoClosedCount).toBe(0)
    expect(normalized.text).toBe('=SUM(A1:A10))')
  })

  it('builds single-cell and range A1 references from selection rectangles', () => {
    expect(buildA1ReferenceFromRect({ x: 0, y: 0, width: 1, height: 1 }, 10)).toBe('A1')
    expect(buildA1ReferenceFromRect({ x: 0, y: 0, width: 1, height: 10 }, 10)).toBe('A1:A10')
    expect(buildA1ReferenceFromRect({ x: 0, y: 0, width: 3, height: 2 }, 10)).toBe('A1:C2')
  })

  it('detects whether a selected rect contains a specific cell', () => {
    expect(
      doesRectContainCell({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 })
    ).toBe(true)
    expect(
      doesRectContainCell({ x: 0, y: 0, width: 1, height: 10 }, { x: 0, y: 5 })
    ).toBe(true)
    expect(
      doesRectContainCell({ x: 2, y: 2, width: 3, height: 2 }, { x: 1, y: 2 })
    ).toBe(false)
  })

  it('excludes formula cell from 1D ranges by shrinking/splitting', () => {
    const leftEdge = excludeCellFromRect(
      { x: 0, y: 0, width: 10, height: 1 },
      { x: 0, y: 0 },
      { x: 9, y: 0 }
    )
    expect(leftEdge.rect).toEqual({ x: 1, y: 0, width: 9, height: 1 })

    const interior = excludeCellFromRect(
      { x: 0, y: 0, width: 10, height: 1 },
      { x: 4, y: 0 },
      { x: 9, y: 0 }
    )
    expect(interior.rect).toEqual({ x: 5, y: 0, width: 5, height: 1 })
  })

  it('excludes formula cell from 2D blocks by choosing best contiguous sub-rect', () => {
    const adjusted = excludeCellFromRect(
      { x: 0, y: 0, width: 3, height: 5 },
      { x: 1, y: 2 },
      { x: 2, y: 4 }
    )
    expect(adjusted.rect).toEqual({ x: 0, y: 3, width: 3, height: 2 })
  })

  it('returns null when exclusion leaves no cells', () => {
    const adjusted = excludeCellFromRect(
      { x: 2, y: 2, width: 1, height: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 2 }
    )
    expect(adjusted.rect).toBeNull()
    expect(adjusted.excluded).toBe(true)
  })

  it('inserts references and replaces prior inserted range spans', () => {
    const first = insertReferenceIntoFormulaDraft('=MAX(', 'A1', 5, 5, null)
    expect(first.text).toBe('=MAX(A1')

    const second = insertReferenceIntoFormulaDraft(
      first.text,
      'A1:A10',
      first.caretStart,
      first.caretEnd,
      first.insertedSpan
    )
    expect(second.text).toBe('=MAX(A1:A10')
  })

  it('auto-opens known function token when first range reference is inserted', () => {
    const inserted = insertReferenceIntoFormulaDraft('=SUM', 'A1:A10', 4, 4, null)
    expect(inserted.text).toBe('=SUM(A1:A10')
  })

  it('reuses existing opening parenthesis when caret is before it', () => {
    const inserted = insertReferenceIntoFormulaDraft('=SUM(', 'A1', 4, 4, null)
    expect(inserted.text).toBe('=SUM(A1')
  })

  it('enables range pick only at incomplete/reference insertion points', () => {
    expect(isFormulaRangePickMode('=MAX(', 5, 5)).toBe(true)
    expect(isFormulaRangePickMode('=SUM', 4, 4)).toBe(true)
    expect(isFormulaRangePickMode('MAX(', 4, 4)).toBe(true)
    expect(isFormulaRangePickMode('=A1+1', 5, 5)).toBe(false)
    expect(isFormulaRangePickMode('=A1+', 4, 4)).toBe(true)
  })

  it('cycles absolute references with F4-style toggle for single references', () => {
    const first = toggleAbsoluteReferenceAtCaret('=A1+1', 2, 2)
    expect(first?.text).toBe('=$A$1+1')
    expect(first?.caretStart).toBe(5)

    const second = first ? toggleAbsoluteReferenceAtCaret(first.text, first.caretStart, first.caretEnd) : null
    expect(second?.text).toBe('=A$1+1')

    const third = second ? toggleAbsoluteReferenceAtCaret(second.text, second.caretStart, second.caretEnd) : null
    expect(third?.text).toBe('=$A1+1')

    const fourth = third ? toggleAbsoluteReferenceAtCaret(third.text, third.caretStart, third.caretEnd) : null
    expect(fourth?.text).toBe('=A1+1')
  })

  it('toggles the correct side of range references based on caret location', () => {
    const startSide = toggleAbsoluteReferenceAtCaret('=A1:B2', 2, 2)
    expect(startSide?.text).toBe('=$A$1:B2')

    const endSide = toggleAbsoluteReferenceAtCaret('=A1:B2', 5, 5)
    expect(endSide?.text).toBe('=A1:$B$2')
  })

  it('detects and rejects sheet-qualified refs for strict single-grid semantics', () => {
    expect(hasSheetQualifiedReferences("='Sheet 1'!A1 + B2")).toBe(true)
    expect(hasSheetQualifiedReferences('=Sheet1!A1+B2')).toBe(true)
    expect(hasSheetQualifiedReferences('=A1+B2')).toBe(false)

    const normalized = normalizeFormulaBeforeCommit("='Sheet 1'!A1 + B2")
    expect(normalized.error).toBe(
      'Sheet-qualified references are not supported. Use A1 references in the active grid.'
    )
  })

  it('strips sheet qualifiers for pasted Excel compatibility formulas', () => {
    const converted = stripSheetQualifiedReferences("='Sheet 1'!A1+'S2'!B2")
    expect(converted.converted).toBe(true)
    expect(converted.text).toBe('=A1+B2')

    const unchanged = stripSheetQualifiedReferences('=SUM(A1:B2)')
    expect(unchanged.converted).toBe(false)
    expect(unchanged.text).toBe('=SUM(A1:B2)')
  })

  it('keeps full row/column ranges intact when stripping sheet qualifiers', () => {
    const fullColumn = stripSheetQualifiedReferences("='Sheet 1'!A:AA")
    expect(fullColumn.converted).toBe(true)
    expect(fullColumn.text).toBe('=A:AA')

    const fullRow = stripSheetQualifiedReferences("='Sheet 1'!1:10")
    expect(fullRow.converted).toBe(true)
    expect(fullRow.text).toBe('=1:10')

    const absoluteFullRow = stripSheetQualifiedReferences("='Sheet 1'!$1048576:$1048576")
    expect(absoluteFullRow.converted).toBe(true)
    expect(absoluteFullRow.text).toBe('=$1048576:$1048576')
  })
})
