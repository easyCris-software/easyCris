/**
 * Coercion contract tests for SpreadsheetView write paths.
 *
 * These tests call coerceEditValue with the exact argument shapes
 * used by each write path in SpreadsheetView: paste, pasteTranspose,
 * pasteValuesOnly, onCellEdited, and the fill loop.
 *
 * Scope: tests the coercion contract (what types produce what values),
 * NOT the wiring (whether SpreadsheetView calls coerceEditValue).
 * A handler that stops calling coerceEditValue would not be caught here.
 */
import { describe, it, expect } from 'vitest'
import { coerceEditValue } from '@/lib/grid/coerceEditValue'

const noFormula = () => false
// Match production formulaUtils.isFormula — strict startsWith, no trimming.
const isFormula = (s: string) => s.startsWith('=')

// ---------------------------------------------------------------------------
// Paste path (pasteFromClipboard)
// Clipboard delivers strings; numeric col must receive numbers.
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste path — numeric coercion', () => {
  it('numeric string "42" pasted into numeric col → stored as number 42', () => {
    expect(coerceEditValue('42', 'numeric', noFormula)).toBe(42)
  })
  it('numeric string "3.14" pasted into numeric col → stored as number 3.14', () => {
    expect(coerceEditValue('3.14', 'numeric', noFormula)).toBe(3.14)
  })
  it('empty string pasted into numeric col → stored as null (not "")', () => {
    expect(coerceEditValue('', 'numeric', noFormula)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// pasteValuesOnly path
// Formula strip happens BEFORE coercion in the paste path (SpreadsheetView
// strips the leading '=' from formula cells before calling coerceEditValue).
// ---------------------------------------------------------------------------

describe('SpreadsheetView pasteValuesOnly path — formula strip then coerce', () => {
  it('"=42" stripped to "42" then coerced to number 42', () => {
    // SpreadsheetView: stripped = raw.trimStart().slice(1)
    const stripped = '=42'.trimStart().slice(1)
    expect(coerceEditValue(stripped, 'numeric', noFormula)).toBe(42)
  })
  it('"=abc" stripped to "abc" → preserved as raw string (not numeric)', () => {
    const stripped = '=abc'.trimStart().slice(1)
    expect(coerceEditValue(stripped, 'numeric', noFormula)).toBe('abc')
  })
  it('formula string kept as-is when isFormula guard is active', () => {
    // Non-values-only paste: formula passed through unchanged
    expect(coerceEditValue('=SUM(A1)', 'numeric', isFormula)).toBe('=SUM(A1)')
  })
})

// ---------------------------------------------------------------------------
// Paste path — categorical / text / datetime (Phase 1B wiring)
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste path — categorical coercion (Phase 1B)', () => {
  it('empty string pasted into categorical col → stored as null', () => {
    expect(coerceEditValue('', 'categorical', noFormula)).toBe(null)
  })
  it('"  Control  " pasted into categorical col → trimmed to "Control"', () => {
    expect(coerceEditValue('  Control  ', 'categorical', noFormula)).toBe('Control')
  })
  it('"na" pasted into categorical col → stored as-is', () => {
    expect(coerceEditValue('na', 'categorical', noFormula)).toBe('na')
  })
})

describe('SpreadsheetView paste path — text coercion (Phase 1B)', () => {
  it('empty string pasted into text col → stored as null', () => {
    expect(coerceEditValue('', 'text', noFormula)).toBe(null)
  })
  it('"  hello  " pasted into text col → trimmed to "hello"', () => {
    expect(coerceEditValue('  hello  ', 'text', noFormula)).toBe('hello')
  })
})

describe('SpreadsheetView paste path — datetime coercion (Phase 1B)', () => {
  it('"2024-01-15" pasted into datetime col → stored as UTC timestamp', () => {
    expect(coerceEditValue('2024-01-15', 'datetime', noFormula)).toBe(Date.UTC(2024, 0, 15))
  })
  it('empty string pasted into datetime col → stored as null', () => {
    expect(coerceEditValue('', 'datetime', noFormula)).toBe(null)
  })
  it('ambiguous ISO (no TZ) preserved as raw string', () => {
    expect(coerceEditValue('2024-01-15T12:30:00', 'datetime', noFormula)).toBe('2024-01-15T12:30:00')
  })
})

// ---------------------------------------------------------------------------
// onCellEdited / formula-bar path
// Same coerceEditValue signature — verifies all column types go through it.
// ---------------------------------------------------------------------------

describe('SpreadsheetView onCellEdited path — numeric (Phase 1)', () => {
  it('user types "100" in numeric cell → stored as number 100', () => {
    expect(coerceEditValue('100', 'numeric', noFormula)).toBe(100)
  })
  it('user types "  " in numeric cell → stored as null', () => {
    expect(coerceEditValue('  ', 'numeric', noFormula)).toBe(null)
  })
})

describe('SpreadsheetView onCellEdited path — categorical (Phase 1B)', () => {
  it('user clears categorical cell ("") → stored as null', () => {
    expect(coerceEditValue('', 'categorical', noFormula)).toBe(null)
  })
  it('user types "Treatment" in categorical cell → stored as "Treatment"', () => {
    expect(coerceEditValue('Treatment', 'categorical', noFormula)).toBe('Treatment')
  })
})
