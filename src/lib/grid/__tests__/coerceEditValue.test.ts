import { describe, it, expect } from 'vitest'
import { coerceEditValue } from '../coerceEditValue'

const noFormula = () => false
// Match production formulaUtils.isFormula — strict startsWith, no trimming.
const isFormula = (s: string) => s.startsWith('=')

// ---------------------------------------------------------------------------
// Numeric columns
// ---------------------------------------------------------------------------

describe('coerceEditValue — numeric column', () => {
  it('string "42" → number 42', () => {
    expect(coerceEditValue('42', 'numeric', noFormula)).toBe(42)
  })
  it('string "3.14" → number 3.14', () => {
    expect(coerceEditValue('3.14', 'numeric', noFormula)).toBe(3.14)
  })
  it('string "-7" → number -7', () => {
    expect(coerceEditValue('-7', 'numeric', noFormula)).toBe(-7)
  })
  it('empty string "" → null (behavior change from raw "")', () => {
    expect(coerceEditValue('', 'numeric', noFormula)).toBe(null)
  })
  it('whitespace-only string → null', () => {
    expect(coerceEditValue('   ', 'numeric', noFormula)).toBe(null)
  })
  it('non-numeric string "abc" → preserved as raw string', () => {
    expect(coerceEditValue('abc', 'numeric', noFormula)).toBe('abc')
  })
  it('formula string "=SUM(A1)" → not coerced (passed through)', () => {
    expect(coerceEditValue('=SUM(A1)', 'numeric', isFormula)).toBe('=SUM(A1)')
  })
  it('already-number 5 → passthrough (no double-parse)', () => {
    expect(coerceEditValue(5, 'numeric', noFormula)).toBe(5)
  })
  it('null → passthrough', () => {
    expect(coerceEditValue(null, 'numeric', noFormula)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Categorical columns — Phase 1B
// ---------------------------------------------------------------------------

describe('coerceEditValue — categorical column', () => {
  it('"Control" string passes through unchanged', () => {
    expect(coerceEditValue('Control', 'categorical', noFormula)).toBe('Control')
  })
  it('empty string "" → null (behavior change: was "")', () => {
    expect(coerceEditValue('', 'categorical', noFormula)).toBe(null)
  })
  it('whitespace-only string → null', () => {
    expect(coerceEditValue('   ', 'categorical', noFormula)).toBe(null)
  })
  it('leading/trailing whitespace is trimmed', () => {
    expect(coerceEditValue('  Control  ', 'categorical', noFormula)).toBe('Control')
  })
  it('"na" stored as-is (isMissing handles display, not parse)', () => {
    expect(coerceEditValue('na', 'categorical', noFormula)).toBe('na')
  })
  it('formula string passes through unchanged', () => {
    expect(coerceEditValue('=SUM(A1)', 'categorical', isFormula)).toBe('=SUM(A1)')
  })
  it('already-null passes through', () => {
    expect(coerceEditValue(null, 'categorical', noFormula)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Text columns — Phase 1B
// ---------------------------------------------------------------------------

describe('coerceEditValue — text column', () => {
  it('"hello world" passes through unchanged', () => {
    expect(coerceEditValue('hello world', 'text', noFormula)).toBe('hello world')
  })
  it('empty string "" → null (behavior change: was "")', () => {
    expect(coerceEditValue('', 'text', noFormula)).toBe(null)
  })
  it('whitespace-only string → null', () => {
    expect(coerceEditValue('   ', 'text', noFormula)).toBe(null)
  })
  it('leading/trailing whitespace is trimmed', () => {
    expect(coerceEditValue('  hello  ', 'text', noFormula)).toBe('hello')
  })
  it('"na" stored as-is (isMissing handles display, not parse)', () => {
    expect(coerceEditValue('na', 'text', noFormula)).toBe('na')
  })
  it('"-" is NOT stripped in text (valid free-form value)', () => {
    expect(coerceEditValue('-', 'text', noFormula)).toBe('-')
  })
  it('"." is NOT stripped in text (valid free-form value)', () => {
    expect(coerceEditValue('.', 'text', noFormula)).toBe('.')
  })
  it('formula string passes through unchanged', () => {
    expect(coerceEditValue('=IF(A1,1,0)', 'text', isFormula)).toBe('=IF(A1,1,0)')
  })
})

// ---------------------------------------------------------------------------
// Datetime columns — Phase 1B
// ---------------------------------------------------------------------------

describe('coerceEditValue — datetime column', () => {
  it('date-only YYYY-MM-DD → UTC timestamp (behavior change: was raw string)', () => {
    expect(coerceEditValue('2024-01-15', 'datetime', noFormula)).toBe(Date.UTC(2024, 0, 15))
  })
  it('ISO with Z suffix → timestamp', () => {
    const expected = new Date('2024-01-15T12:30:00Z').getTime()
    expect(coerceEditValue('2024-01-15T12:30:00Z', 'datetime', noFormula)).toBe(expected)
  })
  it('ISO with +hh:mm offset → timestamp', () => {
    const expected = new Date('2024-01-15T12:30:00+05:30').getTime()
    expect(coerceEditValue('2024-01-15T12:30:00+05:30', 'datetime', noFormula)).toBe(expected)
  })
  it('ISO without timezone → raw string preserved (ambiguous, no local-time shift)', () => {
    expect(coerceEditValue('2024-01-15T12:30:00', 'datetime', noFormula)).toBe('2024-01-15T12:30:00')
  })
  it('space-separated datetime → raw string preserved (ambiguous)', () => {
    expect(coerceEditValue('2024-01-15 12:30:00', 'datetime', noFormula)).toBe('2024-01-15 12:30:00')
  })
  it('invalid date string → raw string preserved', () => {
    expect(coerceEditValue('not-a-date', 'datetime', noFormula)).toBe('not-a-date')
  })
  it('empty string "" → null', () => {
    expect(coerceEditValue('', 'datetime', noFormula)).toBe(null)
  })
  it('"na" stored as-is (isMissing handles display, not parse)', () => {
    expect(coerceEditValue('na', 'datetime', noFormula)).toBe('na')
  })
  it('formula string passes through unchanged', () => {
    expect(coerceEditValue('=TODAY()', 'datetime', isFormula)).toBe('=TODAY()')
  })
  it('already-number timestamp passes through (no double-parse)', () => {
    const ts = Date.UTC(2024, 0, 15)
    expect(coerceEditValue(ts, 'datetime', noFormula)).toBe(ts)
  })
})

// ---------------------------------------------------------------------------
// undefined/null column type — Phase 1B behavior change
// Phase 1: true passthrough (no coercion).
// Phase 1B: textSemantics fallback (empty → null, whitespace trimmed).
// "42" result is the same either way; empty/whitespace now become null.
// ---------------------------------------------------------------------------

describe('coerceEditValue — undefined/null column type (textSemantics fallback)', () => {
  it('undefined type: "42" stays string (text semantics, not numeric coercion)', () => {
    expect(coerceEditValue('42', undefined, noFormula)).toBe('42')
  })
  it('null type: "42" stays string (text semantics fallback)', () => {
    expect(coerceEditValue('42', null, noFormula)).toBe('42')
  })
  it('undefined type: empty string "" → null (behavior change from Phase 1 passthrough)', () => {
    expect(coerceEditValue('', undefined, noFormula)).toBe(null)
  })
  it('null type: empty string "" → null (behavior change from Phase 1 passthrough)', () => {
    expect(coerceEditValue('', null, noFormula)).toBe(null)
  })
  it('undefined type: whitespace-only → null', () => {
    expect(coerceEditValue('   ', undefined, noFormula)).toBe(null)
  })
  it('undefined type: whitespace trimmed from string', () => {
    expect(coerceEditValue('  hello  ', undefined, noFormula)).toBe('hello')
  })
  it('undefined type: non-string null passes through', () => {
    expect(coerceEditValue(null, undefined, noFormula)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// pasteValuesOnly scenario: formula strip happens before coercion
// ---------------------------------------------------------------------------

describe('coerceEditValue — pasteValuesOnly interaction (formula strip then coerce)', () => {
  it('"=42" stripped to "42" then coerced to 42', () => {
    const stripped = '=42'.trimStart().slice(1)  // formula strip in paste path
    expect(coerceEditValue(stripped, 'numeric', noFormula)).toBe(42)
  })
  it('"=abc" stripped to "abc" → preserved as raw string', () => {
    const stripped = '=abc'.trimStart().slice(1)
    expect(coerceEditValue(stripped, 'numeric', noFormula)).toBe('abc')
  })
})

// ---------------------------------------------------------------------------
// Leading-space formula literals — regression guard
// Production isFormula is strict startsWith('='), no trimming.
// Phase 1B parse() trims whitespace, which would turn "  =SUM(A1)" into
// "=SUM(A1)" — a string editExecutor would evaluate as a formula.
// coerceEditValue must catch this by checking isFormula on the trimmed value
// BEFORE dispatching to parse(), and returning the original untrimmed value.
// ---------------------------------------------------------------------------

describe('coerceEditValue — leading-space formula literals (trim+formula guard)', () => {
  it('"  =SUM(A1)" in text col → returned as-is (leading space prevents formula eval)', () => {
    expect(coerceEditValue('  =SUM(A1)', 'text', isFormula)).toBe('  =SUM(A1)')
  })
  it('"  =SUM(A1)" in categorical col → returned as-is', () => {
    expect(coerceEditValue('  =SUM(A1)', 'categorical', isFormula)).toBe('  =SUM(A1)')
  })
  it('"  =SUM(A1)" in numeric col → returned as-is', () => {
    expect(coerceEditValue('  =SUM(A1)', 'numeric', isFormula)).toBe('  =SUM(A1)')
  })
  it('"  =SUM(A1)" in datetime col → returned as-is', () => {
    expect(coerceEditValue('  =SUM(A1)', 'datetime', isFormula)).toBe('  =SUM(A1)')
  })
  it('"=SUM(A1)" (no leading space) → formula pass-through unchanged', () => {
    expect(coerceEditValue('=SUM(A1)', 'text', isFormula)).toBe('=SUM(A1)')
  })
  it('"  hello  " in text col → trimmed normally (not a formula)', () => {
    expect(coerceEditValue('  hello  ', 'text', isFormula)).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Phase 1B regression gate — consistent behavior across all column types
// ---------------------------------------------------------------------------

describe('Phase 1B regression gate — empty/whitespace/formula consistency', () => {
  const types = ['numeric', 'categorical', 'text', 'datetime'] as const

  for (const type of types) {
    it(`${type}: empty string → null`, () => {
      expect(coerceEditValue('', type, noFormula)).toBe(null)
    })
    it(`${type}: whitespace-only → null`, () => {
      expect(coerceEditValue('   ', type, noFormula)).toBe(null)
    })
    it(`${type}: formula string passes through unchanged`, () => {
      expect(coerceEditValue('=SUM(A1)', type, isFormula)).toBe('=SUM(A1)')
    })
    it(`${type}: non-string null passes through`, () => {
      expect(coerceEditValue(null, type, noFormula)).toBe(null)
    })
  }

  it('undefined type: empty string → null (textSemantics fallback)', () => {
    expect(coerceEditValue('', undefined, noFormula)).toBe(null)
  })
  it('undefined type: "42" stays string (text semantics, not numeric coercion)', () => {
    expect(coerceEditValue('42', undefined, noFormula)).toBe('42')
  })
  it('null type: "hello" stays string (textSemantics fallback)', () => {
    expect(coerceEditValue('hello', null, noFormula)).toBe('hello')
  })
})
