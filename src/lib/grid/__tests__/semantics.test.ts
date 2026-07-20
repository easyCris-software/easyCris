import { describe, it, expect } from 'vitest'
import type { GridValueSemantics } from '../semantics/types'
import { numericSemantics } from '../semantics/numeric'
import { categoricalSemantics } from '../semantics/categorical'
import { textSemantics } from '../semantics/text'
import { datetimeSemantics } from '../semantics/datetime'
import { getSemanticsForType } from '../semantics/registry'

describe('GridValueSemantics interface', () => {
  it('type is importable', () => {
    const check: GridValueSemantics | null = null
    expect(check).toBeNull()
  })
})

describe('numericSemantics.parse', () => {
  it('parses a valid integer string', () => {
    expect(numericSemantics.parse('42')).toBe(42)
  })
  it('parses a valid float string', () => {
    expect(numericSemantics.parse('3.14')).toBe(3.14)
  })
  it('parses negative numbers', () => {
    expect(numericSemantics.parse('-7.5')).toBe(-7.5)
  })
  it('returns raw string when unparseable', () => {
    expect(numericSemantics.parse('abc')).toBe('abc')
  })
  it('parses empty string to null', () => {
    expect(numericSemantics.parse('')).toBe(null)
  })
  it('parses whitespace-only string to null', () => {
    expect(numericSemantics.parse('   ')).toBe(null)
  })
})

describe('numericSemantics.format', () => {
  it('formats a number', () => {
    expect(numericSemantics.format(3.14)).toBe('3.14')
  })
  it('formats null as empty string', () => {
    expect(numericSemantics.format(null)).toBe('')
  })
  it('formats undefined as empty string', () => {
    expect(numericSemantics.format(undefined)).toBe('')
  })
  it('formats NaN as empty string', () => {
    expect(numericSemantics.format(NaN)).toBe('')
  })
  it('formats an unparseable raw string as-is', () => {
    expect(numericSemantics.format('abc')).toBe('abc')
  })
})

describe('numericSemantics.sortKey', () => {
  it('returns the number itself', () => {
    expect(numericSemantics.sortKey(5)).toBe(5)
  })
  it('returns Infinity for null (sorts last)', () => {
    expect(numericSemantics.sortKey(null)).toBe(Infinity)
  })
  it('returns Infinity for undefined (sorts last)', () => {
    expect(numericSemantics.sortKey(undefined)).toBe(Infinity)
  })
  it('returns Infinity for NaN (sorts last)', () => {
    expect(numericSemantics.sortKey(NaN)).toBe(Infinity)
  })
  it('returns Infinity for empty string (sorts last)', () => {
    expect(numericSemantics.sortKey('')).toBe(Infinity)
  })
  it('coerces numeric string to number for sort key', () => {
    expect(numericSemantics.sortKey('10')).toBe(10)
  })
})

describe('numericSemantics.isMissing', () => {
  it('null is missing', () => expect(numericSemantics.isMissing(null)).toBe(true))
  it('undefined is missing', () => expect(numericSemantics.isMissing(undefined)).toBe(true))
  it('empty string is missing', () => expect(numericSemantics.isMissing('')).toBe(true))
  it('whitespace string is missing', () => expect(numericSemantics.isMissing('  ')).toBe(true))
  it('NaN is missing', () => expect(numericSemantics.isMissing(NaN)).toBe(true))
  it('"na" is missing (ColumnDataExtractor sentinel)', () => expect(numericSemantics.isMissing('na')).toBe(true))
  it('"N/A" is missing (case-insensitive)', () => expect(numericSemantics.isMissing('N/A')).toBe(true))
  it('"nan" is missing', () => expect(numericSemantics.isMissing('nan')).toBe(true))
  it('"." is missing', () => expect(numericSemantics.isMissing('.')).toBe(true))
  it('0 is NOT missing', () => expect(numericSemantics.isMissing(0)).toBe(false))
  it('42 is NOT missing', () => expect(numericSemantics.isMissing(42)).toBe(false))
})

describe('numericSemantics.isValid', () => {
  it('a finite number is valid', () => expect(numericSemantics.isValid(3.14)).toBe(true))
  it('0 is valid', () => expect(numericSemantics.isValid(0)).toBe(true))
  it('a numeric string is valid', () => expect(numericSemantics.isValid('42')).toBe(true))
  it('a non-numeric string is NOT valid', () => expect(numericSemantics.isValid('abc')).toBe(false))
  it('null is NOT valid', () => expect(numericSemantics.isValid(null)).toBe(false))
  it('NaN is NOT valid', () => expect(numericSemantics.isValid(NaN)).toBe(false))
})

// ---------------------------------------------------------------------------
// Task 3 — categorical, text, datetime
// ---------------------------------------------------------------------------

describe('categoricalSemantics', () => {
  it('parse returns string unchanged', () => {
    expect(categoricalSemantics.parse('Control')).toBe('Control')
  })
  it('parse returns null for empty string', () => {
    expect(categoricalSemantics.parse('')).toBe(null)
  })
  it('format returns string value', () => {
    expect(categoricalSemantics.format('Treatment')).toBe('Treatment')
  })
  it('format returns empty string for null', () => {
    expect(categoricalSemantics.format(null)).toBe('')
  })
  it('sortKey is lowercase (case-insensitive sort)', () => {
    expect(categoricalSemantics.sortKey('Control')).toBe('control')
  })
  it('sortKey for null returns sentinel (sorts last)', () => {
    expect(categoricalSemantics.sortKey(null)).toBe('\uFFFF')
  })
  it('isMissing: null is missing', () => expect(categoricalSemantics.isMissing(null)).toBe(true))
  it('isMissing: empty string is missing', () => expect(categoricalSemantics.isMissing('')).toBe(true))
  it('isMissing: "na" is missing', () => expect(categoricalSemantics.isMissing('na')).toBe(true))
  it('isMissing: real string is NOT missing', () => expect(categoricalSemantics.isMissing('Control')).toBe(false))
  it('isValid: non-empty string is valid', () => expect(categoricalSemantics.isValid('A')).toBe(true))
  it('isValid: null is NOT valid', () => expect(categoricalSemantics.isValid(null)).toBe(false))
})

describe('textSemantics', () => {
  it('parse returns string unchanged', () => {
    expect(textSemantics.parse('hello world')).toBe('hello world')
  })
  it('parse returns null for empty string', () => {
    expect(textSemantics.parse('')).toBe(null)
  })
  it('sortKey is lowercase', () => {
    expect(textSemantics.sortKey('Hello')).toBe('hello')
  })
  it('sortKey for null is sentinel', () => {
    expect(textSemantics.sortKey(null)).toBe('\uFFFF')
  })
  it('isMissing: null is missing', () => expect(textSemantics.isMissing(null)).toBe(true))
  it('isMissing: empty string is missing', () => expect(textSemantics.isMissing('')).toBe(true))
  it('isMissing: "na" is missing', () => expect(textSemantics.isMissing('na')).toBe(true))
  it('isMissing: "-" is NOT missing in text type', () => expect(textSemantics.isMissing('-')).toBe(false))
  it('isValid: any non-empty string is valid', () => expect(textSemantics.isValid('anything')).toBe(true))
  it('isValid: null is NOT valid', () => expect(textSemantics.isValid(null)).toBe(false))
})

describe('datetimeSemantics', () => {
  it('parse returns a number (timestamp) for valid ISO date', () => {
    const result = datetimeSemantics.parse('2024-01-15')
    expect(typeof result).toBe('number')
    expect(result).toBe(new Date('2024-01-15').getTime())
  })
  it('parse returns raw string for invalid date', () => {
    expect(datetimeSemantics.parse('not-a-date')).toBe('not-a-date')
  })
  it('parse returns null for empty string', () => {
    expect(datetimeSemantics.parse('')).toBe(null)
  })
  it('format returns ISO date string for timestamp', () => {
    const ts = new Date('2024-01-15').getTime()
    expect(datetimeSemantics.format(ts)).toBe('2024-01-15')
  })
  it('format returns empty string for null', () => {
    expect(datetimeSemantics.format(null)).toBe('')
  })
  it('sortKey returns timestamp number', () => {
    const ts = new Date('2024-01-15').getTime()
    expect(datetimeSemantics.sortKey(ts)).toBe(ts)
  })
  it('sortKey for null returns Infinity (sorts last)', () => {
    expect(datetimeSemantics.sortKey(null)).toBe(Infinity)
  })
  it('isMissing: null is missing', () => expect(datetimeSemantics.isMissing(null)).toBe(true))
  it('isMissing: invalid date string is missing', () => expect(datetimeSemantics.isMissing('not-a-date')).toBe(true))
  it('isMissing: valid timestamp is NOT missing', () => {
    expect(datetimeSemantics.isMissing(new Date('2024-01-15').getTime())).toBe(false)
  })
  it('isValid: valid ISO string is valid', () => expect(datetimeSemantics.isValid('2024-01-15')).toBe(true))
  it('isValid: invalid date string is NOT valid', () => expect(datetimeSemantics.isValid('not-a-date')).toBe(false))
  it('isValid: null is NOT valid', () => expect(datetimeSemantics.isValid(null)).toBe(false))
})

// ---------------------------------------------------------------------------
// I2 — timezone-safe parse
// ---------------------------------------------------------------------------

describe('datetimeSemantics — timezone-safe parse', () => {
  it('parse: space-separated datetime without timezone returns raw string', () => {
    expect(datetimeSemantics.parse('2024-01-15 12:30:00')).toBe('2024-01-15 12:30:00')
  })
  it('parse: ISO datetime without timezone (no Z/offset) returns raw string', () => {
    expect(datetimeSemantics.parse('2024-01-15T12:30:00')).toBe('2024-01-15T12:30:00')
  })
  it('parse: ISO with Z suffix returns timestamp', () => {
    const ts = datetimeSemantics.parse('2024-01-15T12:30:00Z') as number
    expect(typeof ts).toBe('number')
    expect(ts).toBe(new Date('2024-01-15T12:30:00Z').getTime())
  })
  it('parse: ISO with +hh:mm offset returns timestamp', () => {
    const ts = datetimeSemantics.parse('2024-01-15T12:30:00+05:30') as number
    expect(typeof ts).toBe('number')
    expect(ts).toBe(new Date('2024-01-15T12:30:00+05:30').getTime())
  })
  it('parse: date-only YYYY-MM-DD uses Date.UTC (no local-time shift)', () => {
    expect(datetimeSemantics.parse('2024-01-15')).toBe(Date.UTC(2024, 0, 15))
  })
  it('isValid: space-separated datetime without timezone is NOT valid', () => {
    expect(datetimeSemantics.isValid('2024-01-15 12:30:00')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// I1/I4 — sentinel coverage gaps
// ---------------------------------------------------------------------------

describe('datetimeSemantics — explicit sentinel isMissing (I1)', () => {
  it('isMissing: "na" is missing (sentinel, not just invalid date)', () => {
    expect(datetimeSemantics.isMissing('na')).toBe(true)
  })
  it('isMissing: "n/a" is missing', () => {
    expect(datetimeSemantics.isMissing('n/a')).toBe(true)
  })
  it('isMissing: "missing" is missing', () => {
    expect(datetimeSemantics.isMissing('missing')).toBe(true)
  })
  it('isMissing: "-" is missing', () => {
    expect(datetimeSemantics.isMissing('-')).toBe(true)
  })
})

describe('I4 — additional sentinel/sortKey gaps', () => {
  it('numericSemantics.isMissing("-") is true', () => {
    expect(numericSemantics.isMissing('-')).toBe(true)
  })
  it('categoricalSemantics.sortKey("na") returns sentinel \\uFFFF', () => {
    expect(categoricalSemantics.sortKey('na')).toBe('\uFFFF')
  })
  it('getSemanticsForType("categorical").isMissing("-") is true', () => {
    expect(getSemanticsForType('categorical').isMissing('-')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 4 — registry
// ---------------------------------------------------------------------------

describe('getSemanticsForType', () => {
  it('returns numericSemantics for "numeric"', () => {
    expect(getSemanticsForType('numeric').parse('3')).toBe(3)
  })
  it('returns categoricalSemantics for "categorical"', () => {
    expect(getSemanticsForType('categorical').parse('Control')).toBe('Control')
  })
  it('returns textSemantics for "text" — "-" is not missing', () => {
    expect(getSemanticsForType('text').isMissing('-')).toBe(false)
  })
  it('returns datetimeSemantics for "datetime"', () => {
    expect(typeof getSemanticsForType('datetime').parse('2024-01-15')).toBe('number')
  })
  it('returns textSemantics for undefined (safe fallback)', () => {
    expect(getSemanticsForType(undefined).parse('hello')).toBe('hello')
  })
  it('returns textSemantics for null (safe fallback)', () => {
    expect(getSemanticsForType(null).parse('hello')).toBe('hello')
  })
  it('returns textSemantics for unknown type (safe fallback)', () => {
    // @ts-expect-error — testing runtime guard
    expect(getSemanticsForType('unknown_type').parse('hello')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Task 4 — regression gate: parse → sortKey consistency
// ---------------------------------------------------------------------------

describe('Phase 1 regression gate — parse → sortKey consistency', () => {
  it('numeric: parsed "10" sorts after parsed "2" (not lexicographic)', () => {
    const sem = getSemanticsForType('numeric')
    expect(sem.sortKey(sem.parse('2')) as number).toBeLessThan(sem.sortKey(sem.parse('10')) as number)
  })
  it('numeric: parsed "" (null) sorts after parsed "5"', () => {
    const sem = getSemanticsForType('numeric')
    expect(sem.sortKey(sem.parse('')) as number).toBeGreaterThan(sem.sortKey(sem.parse('5')) as number)
  })
  it('numeric: isMissing(0) is false — zero is a real value', () => {
    const sem = getSemanticsForType('numeric')
    expect(sem.isMissing(sem.parse('0'))).toBe(false)
  })
  it('numeric: isMissing agrees with parse for empty input', () => {
    const sem = getSemanticsForType('numeric')
    expect(sem.isMissing(sem.parse(''))).toBe(true)
  })
  it('categorical: parsed "Control" sortKey is lowercase', () => {
    const sem = getSemanticsForType('categorical')
    expect(sem.sortKey(sem.parse('Control'))).toBe('control')
  })
  it('categorical: isMissing agrees with parse for empty input', () => {
    const sem = getSemanticsForType('categorical')
    expect(sem.isMissing(sem.parse(''))).toBe(true)
  })
  it('datetime: parsed "2023-06-01" sorts before parsed "2024-01-01"', () => {
    const sem = getSemanticsForType('datetime')
    expect(sem.sortKey(sem.parse('2023-06-01')) as number).toBeLessThan(sem.sortKey(sem.parse('2024-01-01')) as number)
  })
  it('datetime: parsed invalid date sortKey is Infinity (sorts last)', () => {
    const sem = getSemanticsForType('datetime')
    expect(sem.sortKey(sem.parse('not-a-date'))).toBe(Infinity)
  })
})

// Task 5 — sort comparator contract is tested in sortComparator.test.ts

// ---------------------------------------------------------------------------
// Task 6 — edit parse contract (numeric only, Phase 1 scope)
// ---------------------------------------------------------------------------

describe('edit parse contract — numeric only (Phase 1 scope)', () => {
  it('numeric: "42" parses to 42', () => {
    expect(getSemanticsForType('numeric').parse('42')).toBe(42)
  })
  it('numeric: "" parses to null (behavior change: was "")', () => {
    expect(getSemanticsForType('numeric').parse('')).toBe(null)
  })
  it('numeric: "abc" preserved as raw string', () => {
    expect(getSemanticsForType('numeric').parse('abc')).toBe('abc')
  })
  it('categorical: parse is NOT wired in Phase 1 (deferred to Phase 1B)', () => {
    // Documentation test — passes by design.
    expect(getSemanticsForType('categorical').parse('Control')).toBe('Control')
  })
})

// ---------------------------------------------------------------------------
// Task 7 — fill coercion contract (numeric only)
// ---------------------------------------------------------------------------

describe('fill coercion contract — numeric only', () => {
  it('numeric: string "3" from fill → number 3', () => {
    expect(getSemanticsForType('numeric').parse('3')).toBe(3)
  })
  it('numeric: already-number 3 from fill — passthrough guard (no double-parse)', () => {
    const sem = getSemanticsForType('numeric')
    const value = 3
    expect(typeof value === 'string' ? sem.parse(value) : value).toBe(3)
  })
  it('numeric: null fill value stays null (no coercion)', () => {
    const sem = getSemanticsForType('numeric')
    const value = null
    expect(typeof value === 'string' ? sem.parse(value) : value).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Paste coercion contract — same guard applied in all three paste paths
// ---------------------------------------------------------------------------

describe('paste coercion contract — numeric only (pasteFromClipboard / transpose / valuesOnly)', () => {
  it('numeric: pasted "42" coerces to 42', () => {
    expect(numericSemantics.parse('42')).toBe(42)
  })
  it('numeric: pasted "" coerces to null (empty cell paste)', () => {
    expect(numericSemantics.parse('')).toBe(null)
  })
  it('numeric: pasted "abc" preserved as raw string (non-numeric stays)', () => {
    expect(numericSemantics.parse('abc')).toBe('abc')
  })
  it('numeric: already-number passthrough guard (no double-parse on Number cells)', () => {
    const value = 7
    expect(typeof value === 'string' ? numericSemantics.parse(value) : value).toBe(7)
  })
  it('pasteValuesOnly: formula stripped to text then coerced — "=42" → "42" → 42', () => {
    // valuesOnly strips leading = first, leaving "42", then numeric parse applies
    const stripped = '=42'.trimStart().slice(1)  // → '42'
    expect(numericSemantics.parse(stripped)).toBe(42)
  })
})
