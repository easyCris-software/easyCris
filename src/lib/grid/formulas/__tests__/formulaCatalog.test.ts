/**
 * formulaCatalog.test.ts — Phase 0 structural invariant tests
 *
 * These tests lock the catalog's structural constraints.
 * They must pass before any runtime behavior change is made.
 *
 * Invariants (must ALL hold at all times):
 *   INV1: No function name appears more than once in the catalog
 *   INV2: Every `scalar` entry has autocompleteVisible === true
 *         EXCEPTION: SWITCH (explicitly hidden from autocomplete)
 *   INV3: Every `spill-deferred` entry has autocompleteVisible === false
 *   INV4: Every `denied` entry has autocompleteVisible === false
 *   INV5: SWITCH is classified `scalar` with autocompleteVisible === false
 *   INV6: VLOOKUP is classified `denied`
 *   INV7: XLOOKUP is classified `denied`
 *   INV8: TEXTSPLIT is classified `spill-deferred`
 *   INV9: BACKEND_SCALAR_ROUTING_SET does not contain VLOOKUP or XLOOKUP
 *   INV10: DENIED_SET contains VLOOKUP and XLOOKUP
 *   INV11: SPILL_DEFERRED_SET contains TEXTSPLIT
 *   INV12: Every denied entry has backendRequired === false
 *   INV13: Every `semantics-deferred` entry has autocompleteVisible === false
 *   INV14: ISFORMULA is classified `semantics-deferred`
 *   INV15: SEMANTICS_DEFERRED_SET contains ISFORMULA
 *   INV16: SEMANTICS_DEFERRED_SET does not contain VLOOKUP, XLOOKUP, or TEXTSPLIT
 *          (those are denied / spill-deferred respectively — must not leak between sets)
 */

import { describe, it, expect } from 'vitest'
import {
  FORMULA_CATALOG,
  SPILL_DEFERRED_SET,
  DENIED_SET,
  SEMANTICS_DEFERRED_SET,
  BACKEND_SCALAR_ROUTING_SET,
} from '../formulaCatalog'

// Explicit allowlist for scalar entries that are intentionally hidden from autocomplete.
// Any new hidden scalar must be added here with a documented reason.
const SCALAR_HIDDEN_ALLOWLIST = new Set<string>([
  'SWITCH', // supported by parser but hidden from autocomplete to avoid confusion with IF/IFS
])

describe('FORMULA_CATALOG structural invariants', () => {
  it('INV1: no function name appears more than once', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const entry of FORMULA_CATALOG) {
      if (seen.has(entry.name)) duplicates.push(entry.name)
      seen.add(entry.name)
    }
    expect(duplicates).toEqual([])
  })

  it('INV2: every scalar entry has autocompleteVisible === true unless in the hidden allowlist', () => {
    const violations = FORMULA_CATALOG.filter(
      (e) => e.classification === 'scalar' && !e.autocompleteVisible && !SCALAR_HIDDEN_ALLOWLIST.has(e.name)
    )
    expect(violations.map((e) => e.name)).toEqual([])
  })

  it('INV3: every spill-deferred entry has autocompleteVisible === false', () => {
    const violations = FORMULA_CATALOG.filter(
      (e) => e.classification === 'spill-deferred' && e.autocompleteVisible
    )
    expect(violations.map((e) => e.name)).toEqual([])
  })

  it('INV4: every denied entry has autocompleteVisible === false', () => {
    const violations = FORMULA_CATALOG.filter(
      (e) => e.classification === 'denied' && e.autocompleteVisible
    )
    expect(violations.map((e) => e.name)).toEqual([])
  })

  it('INV5: SWITCH is scalar with autocompleteVisible === false', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'SWITCH')
    expect(entry).toBeDefined()
    expect(entry!.classification).toBe('scalar')
    expect(entry!.autocompleteVisible).toBe(false)
  })

  it('INV6: VLOOKUP is classified denied', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'VLOOKUP')
    expect(entry).toBeDefined()
    expect(entry!.classification).toBe('denied')
  })

  it('INV7: XLOOKUP is classified denied', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'XLOOKUP')
    expect(entry).toBeDefined()
    expect(entry!.classification).toBe('denied')
  })

  it('INV8: TEXTSPLIT is classified spill-deferred', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'TEXTSPLIT')
    expect(entry).toBeDefined()
    expect(entry!.classification).toBe('spill-deferred')
  })

  it('INV9: BACKEND_SCALAR_ROUTING_SET does not contain VLOOKUP or XLOOKUP', () => {
    expect(BACKEND_SCALAR_ROUTING_SET.has('VLOOKUP')).toBe(false)
    expect(BACKEND_SCALAR_ROUTING_SET.has('XLOOKUP')).toBe(false)
  })

  it('INV10: DENIED_SET contains VLOOKUP and XLOOKUP', () => {
    expect(DENIED_SET.has('VLOOKUP')).toBe(true)
    expect(DENIED_SET.has('XLOOKUP')).toBe(true)
  })

  it('INV11: SPILL_DEFERRED_SET contains TEXTSPLIT', () => {
    expect(SPILL_DEFERRED_SET.has('TEXTSPLIT')).toBe(true)
  })

  it('INV12: every denied entry has backendRequired === false', () => {
    const violations = FORMULA_CATALOG.filter(
      (e) => e.classification === 'denied' && e.backendRequired
    )
    expect(violations.map((e) => e.name)).toEqual([])
  })

  it('INV13: every semantics-deferred entry has autocompleteVisible === false', () => {
    const violations = FORMULA_CATALOG.filter(
      (e) => e.classification === 'semantics-deferred' && e.autocompleteVisible
    )
    expect(violations.map((e) => e.name)).toEqual([])
  })

  it('INV14: ISFORMULA is classified semantics-deferred', () => {
    const entry = FORMULA_CATALOG.find((e) => e.name === 'ISFORMULA')
    expect(entry).toBeDefined()
    expect(entry!.classification).toBe('semantics-deferred')
    expect(entry!.autocompleteVisible).toBe(false)
  })

  it('INV15: SEMANTICS_DEFERRED_SET contains ISFORMULA', () => {
    expect(SEMANTICS_DEFERRED_SET.has('ISFORMULA')).toBe(true)
  })

  it('INV16: SEMANTICS_DEFERRED_SET does not overlap with DENIED_SET or SPILL_DEFERRED_SET', () => {
    const deniedOverlap = [...SEMANTICS_DEFERRED_SET].filter((fn) => DENIED_SET.has(fn))
    const spillOverlap  = [...SEMANTICS_DEFERRED_SET].filter((fn) => SPILL_DEFERRED_SET.has(fn))
    expect(deniedOverlap).toEqual([])
    expect(spillOverlap).toEqual([])
  })
})
