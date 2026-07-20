import { describe, it, expect } from 'vitest'
import { makeComparator, makeExcelComparator } from '../sortComparator'

// ---------------------------------------------------------------------------
// makeComparator — typed sort contract
// ---------------------------------------------------------------------------

describe('makeComparator — numeric', () => {
  const cmp = makeComparator('numeric')

  it('1 < 10 (avoids lexicographic trap)', () => {
    expect(cmp(1, 10)).toBeLessThan(0)
  })
  it('10 > 2', () => {
    expect(cmp(10, 2)).toBeGreaterThan(0)
  })
  it('equal values return 0', () => {
    expect(cmp(5, 5)).toBe(0)
  })
  it('null sorts after real number (missing last)', () => {
    expect(cmp(null, 5)).toBeGreaterThan(0)
  })
  it('two nulls are equal', () => {
    expect(cmp(null, null)).toBe(0)
  })
  it('empty string sorts after real number (blank = missing)', () => {
    expect(cmp('', 5)).toBeGreaterThan(0)
  })
  it('"na" sorts after real number', () => {
    expect(cmp('na', 3)).toBeGreaterThan(0)
  })
})

describe('makeComparator — categorical', () => {
  const cmp = makeComparator('categorical')

  it('case-insensitive: "b" > "a"', () => {
    expect(cmp('B', 'a')).toBeGreaterThan(0)
  })
  it('null sorts after "z"', () => {
    expect(cmp(null, 'z')).toBeGreaterThan(0)
  })
  it('"10" > "2" (natural sort via Intl.Collator, Excel-compat)', () => {
    expect(cmp('10', '2')).toBeGreaterThan(0)
  })
})

describe('makeComparator — text', () => {
  const cmp = makeComparator('text')

  it('"apple" < "banana"', () => {
    expect(cmp('apple', 'banana')).toBeLessThan(0)
  })
  it('"-" is NOT missing in text (valid free-form) — treated as non-missing, sorts before null', () => {
    expect(cmp('-', null)).toBeLessThan(0)
  })
  it('"10" > "2" (natural sort via Intl.Collator, Excel-compat)', () => {
    expect(cmp('10', '2')).toBeGreaterThan(0)
  })
})

describe('makeComparator — datetime', () => {
  const cmp = makeComparator('datetime')

  it('earlier date < later date', () => {
    expect(cmp('2023-01-01', '2024-01-01')).toBeLessThan(0)
  })
  it('null sorts after valid date', () => {
    expect(cmp(null, '2024-01-01')).toBeGreaterThan(0)
  })
  it('ambiguous datetime (no timezone) sorts last (treated as missing)', () => {
    expect(cmp('2024-01-15 12:30:00', '2024-01-01')).toBeGreaterThan(0)
  })
})

describe('makeComparator — undefined / null type (text fallback)', () => {
  it('"apple" < "banana"', () => {
    expect(makeComparator(undefined)('apple', 'banana')).toBeLessThan(0)
  })
  it('null type: "apple" < "banana"', () => {
    expect(makeComparator(null)('apple', 'banana')).toBeLessThan(0)
  })
})

describe('makeComparator — sem hoisted (single instance per sort)', () => {
  it('returns same comparator type on repeated calls with same type', () => {
    const c1 = makeComparator('numeric')
    const c2 = makeComparator('numeric')
    // Both should agree on ordering — semantics is stable
    expect(c1(1, 2)).toBe(c2(1, 2))
  })
})

// ---------------------------------------------------------------------------
// makeExcelComparator — natural sort via Intl.Collator
// ---------------------------------------------------------------------------

describe('makeExcelComparator — text: natural sort (numeric=true)', () => {
  it('"10" > "2" (natural sort, not lexicographic)', () => {
    expect(makeExcelComparator('text')('10', '2')).toBeGreaterThan(0)
  })
  it('"2" < "10"', () => {
    expect(makeExcelComparator('text')('2', '10')).toBeLessThan(0)
  })
  it('"apple" < "banana" (alphabetic order preserved)', () => {
    expect(makeExcelComparator('text')('apple', 'banana')).toBeLessThan(0)
  })
  it('"B" vs "a": case-insensitive, "b" > "a" order preserved', () => {
    expect(makeExcelComparator('text')('B', 'a')).toBeGreaterThan(0)
  })
  it('null sorts last (missing contract preserved)', () => {
    expect(makeExcelComparator('text')(null, 'a')).toBeGreaterThan(0)
  })
})

describe('makeExcelComparator — categorical: natural sort (numeric=true)', () => {
  it('"10" > "2"', () => {
    expect(makeExcelComparator('categorical')('10', '2')).toBeGreaterThan(0)
  })
  it('null sorts after "z"', () => {
    expect(makeExcelComparator('categorical')(null, 'z')).toBeGreaterThan(0)
  })
})

describe('makeExcelComparator — numeric: unchanged (still numeric compare)', () => {
  it('1 < 10', () => {
    expect(makeExcelComparator('numeric')(1, 10)).toBeLessThan(0)
  })
  it('null sorts last', () => {
    expect(makeExcelComparator('numeric')(null, 5)).toBeGreaterThan(0)
  })
})

describe('makeComparator alias — same results as makeExcelComparator', () => {
  it('numeric: alias agrees', () => {
    expect(Math.sign(makeComparator('numeric')(1, 10))).toBe(Math.sign(makeExcelComparator('numeric')(1, 10)))
  })
  it('text: "10" > "2" via alias', () => {
    expect(makeComparator('text')('10', '2')).toBeGreaterThan(0)
  })
})
