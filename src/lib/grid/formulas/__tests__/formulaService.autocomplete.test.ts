/**
 * formulaService.autocomplete.test.ts
 *
 * Parity guards ensuring that:
 *   1. Every autocompleteVisible catalog entry appears in getFunctionSuggestions
 *      when backend context is active.
 *   2. Every autocompleteVisible catalog entry has an informative signature
 *      (not just the bare function name) in getFunctionSuggestionsWithHints.
 *   3. Specific Wave 1 and Wave 3 functions are individually visible.
 *   4. BACKEND_AUTOCOMPLETE_ENABLED gating: backend-only functions hidden when
 *      no backend context is set, visible when context is active.
 *   5. Spill-deferred functions never appear in any suggestions.
 *   6. Signature fallback chain: catalog → legacy FUNCTION_SIGNATURES map → generic.
 *   7. Legacy text/reference/information functions preserved in suggestions.
 *
 * These tests were written RED against the legacy ALLOWED_FUNCTIONS / hardcoded
 * FUNCTION_SIGNATURES implementation. They go GREEN once the catalog-derived
 * fix is applied to formulaService.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createFormulaService } from '../formulaService'
import { getFunctionSuggestions, getFunctionSuggestionsWithHints } from '../formulaService'
import { FORMULA_CATALOG } from '../formulaCatalog'

// ---------------------------------------------------------------------------
// Shared backend context — enables BACKEND_AUTOCOMPLETE_ENABLED = true
// ---------------------------------------------------------------------------

const COLUMNS = [{ id: 'col-a' }, { id: 'col-b' }]
const ROW_DATA = new Map([[0, { 'col-a': 1, 'col-b': 2 }]])

function makeBackendCtx() {
  return {
    isLargeDataset: true,
    isSorted: false,
    isGrouped: false,
    totalRows: 1,
    loadedRowRange: { start: 0, end: 0 },
    columnLookup: {
      indexToId: (i: number) => COLUMNS[i]?.id ?? `col-${i}`,
      idToIndex: (id: string) => COLUMNS.findIndex((c) => c.id === id),
    },
    rowOrder: null,
    datasetId: 'autocomplete-test',
    enqueueBackendEval: () => {},
  }
}

// We need a FormulaService instance to call setBackendEvalContext, which
// sets the module-level BACKEND_AUTOCOMPLETE_ENABLED flag.
const svc = createFormulaService(() => ROW_DATA, COLUMNS)

beforeAll(() => {
  svc.setBackendEvalContext(makeBackendCtx())
})

afterAll(() => {
  svc.setBackendEvalContext(undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All catalog entries that should be visible in autocomplete */
const VISIBLE_CATALOG = FORMULA_CATALOG.filter((f) => f.autocompleteVisible)

/** Get all suggestions for a given prefix with a high limit */
function suggestAll(prefix: string): string[] {
  return getFunctionSuggestions(prefix, 200)
}

// ---------------------------------------------------------------------------
// PARITY_SUGGESTIONS — every autocompleteVisible entry appears in suggestions
// ---------------------------------------------------------------------------

describe('formulaService autocomplete — parity guards', () => {
  it('PARITY_SUGGESTIONS: every autocompleteVisible catalog entry is returned by getFunctionSuggestions', () => {
    const missing: string[] = []

    for (const entry of VISIBLE_CATALOG) {
      // Use the full function name as prefix to get an exact match
      const prefix = entry.name.toUpperCase()
      const suggestions = suggestAll(prefix)
      const found = suggestions.some((s) => s.toUpperCase() === prefix)
      if (!found) missing.push(entry.name)
    }

    expect(
      missing,
      `These autocompleteVisible functions are missing from suggestions:\n${missing.join('\n')}`
    ).toEqual([])
  })

  it('PARITY_SIGNATURES: every autocompleteVisible catalog entry has an informative signature in getFunctionSuggestionsWithHints', () => {
    const violations: string[] = []

    for (const entry of VISIBLE_CATALOG) {
      const prefix = entry.name.toUpperCase()
      const hints = getFunctionSuggestionsWithHints(prefix, 200)
      const match = hints.find((h) => h.name.toUpperCase() === prefix)

      if (!match) {
        violations.push(`${entry.name}: not returned by getFunctionSuggestionsWithHints`)
        continue
      }

      // Signature must not be just the bare function name (no-args fallback)
      // A proper signature contains '(' — e.g. "SUM(number1, [number2], ...)"
      if (!match.signature.includes('(')) {
        violations.push(`${entry.name}: signature is '${match.signature}' — missing argument list`)
        continue
      }

      // Signature must not be the generic "FNAME(...)" fallback
      if (match.signature === `${prefix}(...)`) {
        violations.push(`${entry.name}: signature is generic fallback '${match.signature}'`)
      }
    }

    expect(
      violations,
      `Signature issues:\n${violations.join('\n')}`
    ).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // WAVE1 — individual spot checks
  // ---------------------------------------------------------------------------

  it('WAVE1_TEXTBEFORE: appears in suggestions with backend enabled', () => {
    expect(suggestAll('TEXTBEFORE')).toContain('TEXTBEFORE')
  })

  it('WAVE1_TEXTAFTER: appears in suggestions with backend enabled', () => {
    expect(suggestAll('TEXTAFTER')).toContain('TEXTAFTER')
  })

  it('WAVE1_MAXIFS: appears in suggestions with backend enabled', () => {
    expect(suggestAll('MAXIFS')).toContain('MAXIFS')
  })

  it('WAVE1_MINIFS: appears in suggestions with backend enabled', () => {
    expect(suggestAll('MINIFS')).toContain('MINIFS')
  })

  it('WAVE1_XMATCH: appears in suggestions with backend enabled', () => {
    expect(suggestAll('XMATCH')).toContain('XMATCH')
  })

  it('WAVE1_ARRAYTOTEXT: appears in suggestions with backend enabled', () => {
    expect(suggestAll('ARRAYTOTEXT')).toContain('ARRAYTOTEXT')
  })

  it('WAVE1_VALUETOTEXT: appears in suggestions with backend enabled', () => {
    expect(suggestAll('VALUETOTEXT')).toContain('VALUETOTEXT')
  })

  it('WAVE1_FORECAST.LINEAR: appears in suggestions with backend enabled', () => {
    expect(suggestAll('FORECAST.LINEAR')).toContain('FORECAST.LINEAR')
  })

  it('WAVE1_T.TEST: appears in suggestions with backend enabled', () => {
    expect(suggestAll('T.TEST')).toContain('T.TEST')
  })

  // ---------------------------------------------------------------------------
  // WAVE3 — individual spot checks
  // ---------------------------------------------------------------------------

  it('WAVE3_LET: appears in suggestions with backend enabled', () => {
    expect(suggestAll('LET')).toContain('LET')
  })

  it('WAVE3_LAMBDA: appears in suggestions with backend enabled', () => {
    expect(suggestAll('LAMBDA')).toContain('LAMBDA')
  })

  // ---------------------------------------------------------------------------
  // SIGNATURE spot checks — Wave 1 catalog signatures must come through
  // ---------------------------------------------------------------------------

  it('SIG_TEXTBEFORE: hint signature matches catalog entry', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'TEXTBEFORE')!
    const hints = getFunctionSuggestionsWithHints('TEXTBEFORE', 10)
    const match = hints.find((h) => h.name.toUpperCase() === 'TEXTBEFORE')
    expect(match?.signature).toBe(entry.signature)
  })

  it('SIG_MAXIFS: hint signature matches catalog entry', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'MAXIFS')!
    const hints = getFunctionSuggestionsWithHints('MAXIFS', 10)
    const match = hints.find((h) => h.name.toUpperCase() === 'MAXIFS')
    expect(match?.signature).toBe(entry.signature)
  })

  it('SIG_LET: hint signature matches catalog entry', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'LET')!
    const hints = getFunctionSuggestionsWithHints('LET', 10)
    const match = hints.find((h) => h.name.toUpperCase() === 'LET')
    expect(match?.signature).toBe(entry.signature)
  })

  // ---------------------------------------------------------------------------
  // DENIED functions must NOT appear in suggestions
  // ---------------------------------------------------------------------------

  it('DENIED_VLOOKUP: does not appear in any suggestions', () => {
    expect(suggestAll('VLOOKUP')).not.toContain('VLOOKUP')
  })

  it('DENIED_XLOOKUP: does not appear in any suggestions', () => {
    expect(suggestAll('XLOOKUP')).not.toContain('XLOOKUP')
  })
})

// ---------------------------------------------------------------------------
// BACKEND CONTEXT GATING — backend-only functions absent when context is off
// ---------------------------------------------------------------------------

describe('formulaService autocomplete — backend context gating', () => {
  // svc2 used only to toggle the module-level BACKEND_AUTOCOMPLETE_ENABLED flag.
  const svc2 = createFormulaService(() => ROW_DATA, COLUMNS)

  // NOTE: `beforeAll` in the outer suite sets backend ON for the module flag.
  // These tests reset to OFF, run their assertion, then restore.

  it('BACKEND_OFF_MAXIFS: MAXIFS absent from suggestions when backend context is not set', () => {
    svc2.setBackendEvalContext(undefined)
    expect(getFunctionSuggestions('MAXIFS', 200)).not.toContain('MAXIFS')
    // restore for other suites
    svc2.setBackendEvalContext(makeBackendCtx())
  })

  it('BACKEND_OFF_LET: LET absent from suggestions when backend context is not set', () => {
    svc2.setBackendEvalContext(undefined)
    expect(getFunctionSuggestions('LET', 200)).not.toContain('LET')
    svc2.setBackendEvalContext(makeBackendCtx())
  })

  it('BACKEND_OFF_LAMBDA: LAMBDA absent from suggestions when backend context is not set', () => {
    svc2.setBackendEvalContext(undefined)
    expect(getFunctionSuggestions('LAMBDA', 200)).not.toContain('LAMBDA')
    svc2.setBackendEvalContext(makeBackendCtx())
  })

  it('BACKEND_ON_MAXIFS: MAXIFS appears in suggestions when backend context is active', () => {
    svc2.setBackendEvalContext(makeBackendCtx())
    expect(getFunctionSuggestions('MAXIFS', 200)).toContain('MAXIFS')
  })

  it('BACKEND_ON_LET: LET appears in suggestions when backend context is active', () => {
    svc2.setBackendEvalContext(makeBackendCtx())
    expect(getFunctionSuggestions('LET', 200)).toContain('LET')
  })

  it('BACKEND_ON_LAMBDA: LAMBDA appears in suggestions when backend context is active', () => {
    svc2.setBackendEvalContext(makeBackendCtx())
    expect(getFunctionSuggestions('LAMBDA', 200)).toContain('LAMBDA')
  })
})

// ---------------------------------------------------------------------------
// SPILL-DEFERRED EXCLUSIONS — spill functions never appear in any suggestion
// ---------------------------------------------------------------------------

describe('formulaService autocomplete — spill-deferred exclusions', () => {
  it('SPILL_FILTER: FILTER never appears in suggestions', () => {
    expect(getFunctionSuggestions('FILTER', 200)).not.toContain('FILTER')
  })

  it('SPILL_UNIQUE: UNIQUE never appears in suggestions', () => {
    expect(getFunctionSuggestions('UNIQUE', 200)).not.toContain('UNIQUE')
  })

  it('SPILL_SORT: SORT never appears in suggestions', () => {
    expect(getFunctionSuggestions('SORT', 200)).not.toContain('SORT')
  })

  it('SPILL_SEQUENCE: SEQUENCE never appears in suggestions', () => {
    expect(getFunctionSuggestions('SEQUENCE', 200)).not.toContain('SEQUENCE')
  })
})

// ---------------------------------------------------------------------------
// SIGNATURE FALLBACK CHAIN — catalog → legacy FUNCTION_SIGNATURES → generic
// ---------------------------------------------------------------------------

import { getFunctionSignature } from '../formulaService'

describe('formulaService autocomplete — signature fallback chain', () => {
  it('FALLBACK_CATALOG: catalog-defined function returns catalog signature', () => {
    // TEXTBEFORE is catalog-only (no entry in legacy FUNCTION_SIGNATURES map)
    const entry = FORMULA_CATALOG.find((e) => e.name === 'TEXTBEFORE')!
    expect(getFunctionSignature('TEXTBEFORE')).toBe(entry.signature)
  })

  it('FALLBACK_LEGACY: legacy-only function (SUM) returns FUNCTION_SIGNATURES entry', () => {
    // SUM is not in the catalog — must fall through to legacy map
    const sig = getFunctionSignature('SUM')
    expect(sig).not.toBeNull()
    expect(sig).toContain('(')
    expect(sig).not.toBe('SUM(...)')
  })

  it('FALLBACK_GENERIC: unknown function returns generic signature', () => {
    const sig = getFunctionSignature('NONEXISTENTFUNCTION_XYZ')
    expect(sig).toBe('NONEXISTENTFUNCTION_XYZ(...)')
  })
})

// ---------------------------------------------------------------------------
// LEGACY CATEGORY PRESERVATION — text/reference/information functions visible
// ---------------------------------------------------------------------------

describe('formulaService autocomplete — legacy category preservation', () => {
  // These live in EXCEL_FUNCTIONS.text / .reference / .information which were
  // historically absent from LEGACY_FUNCTIONS. They should appear in suggestions
  // because LEGACY_FUNCTIONS must include ALL 9 EXCEL_FUNCTIONS categories.

  it('LEGACY_LEN: LEN appears in suggestions', () => {
    // LEN is also in catalog; acts as a dual-path sanity check
    expect(getFunctionSuggestions('LEN', 200)).toContain('LEN')
  })

  it('LEGACY_MATCH: MATCH appears in suggestions', () => {
    // MATCH is in catalog; acts as a dual-path sanity check
    expect(getFunctionSuggestions('MATCH', 200)).toContain('MATCH')
  })

  it('LEGACY_ISNUMBER: ISNUMBER appears in suggestions', () => {
    // ISNUMBER is in EXCEL_FUNCTIONS.information but NOT in the catalog.
    // Requires LEGACY_FUNCTIONS to include the information category.
    expect(getFunctionSuggestions('ISNUMBER', 200)).toContain('ISNUMBER')
  })

  it('LEGACY_LEFT: LEFT (text category) appears in suggestions', () => {
    // LEFT is in EXCEL_FUNCTIONS.text; not expected in catalog.
    expect(getFunctionSuggestions('LEFT', 200)).toContain('LEFT')
  })

  it('LEGACY_COLUMN: COLUMN (reference category) appears in suggestions', () => {
    // COLUMN is in EXCEL_FUNCTIONS.reference; not in catalog — depends on LEGACY_FUNCTIONS.
    expect(getFunctionSuggestions('COLUMN', 200)).toContain('COLUMN')
  })

  it('LEGACY_ISBLANK: ISBLANK (information category) appears in suggestions', () => {
    // ISBLANK is in EXCEL_FUNCTIONS.information; not expected in catalog.
    expect(getFunctionSuggestions('ISBLANK', 200)).toContain('ISBLANK')
  })
})
