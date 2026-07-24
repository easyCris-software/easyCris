/**
 * Regression tests: mojibake bracket group key matching
 *
 * Root cause: Python may return pairwise_comparisons group1/group2 with
 * UTF-8 bytes misread as Latin-1 (e.g. "Temp_30(Â°C)" instead of "Temp_30(°C)").
 * The category names on the x-axis are decoded correctly by the frontend.
 * This mismatch prevents brackets from rendering.
 *
 * Fix: canonicalizeBracketGroupKey normalises both sides (trim, NFC, mojibake
 * repair, whitespace collapse, lowercase) so they map to the same key.
 */

import { describe, it, expect } from 'vitest'
import { canonicalizeBracketGroupKey, repairMojibakeForDisplay } from '../bracketGroupKey'
import { stackBrackets } from '../common'
import type { SignificanceBracket } from '../types'
import { createDefaultBracketSettings } from '../types'
import { buildPlotSpecsFromResult } from '@/services/plotResultService'
import type { TestResult } from '@/store/results-store'

// ---------------------------------------------------------------------------
// canonicalizeBracketGroupKey — unit tests
// ---------------------------------------------------------------------------

describe('canonicalizeBracketGroupKey', () => {
  it('trims leading/trailing whitespace', () => {
    expect(canonicalizeBracketGroupKey('  Control  ')).toBe('control')
  })

  it('collapses internal whitespace', () => {
    expect(canonicalizeBracketGroupKey('Group  A')).toBe('group a')
  })

  it('lowercases the result', () => {
    expect(canonicalizeBracketGroupKey('MyGroup')).toBe('mygroup')
  })

  it('repairs Â° mojibake to degree sign (°)', () => {
    expect(canonicalizeBracketGroupKey('Temp_30(Â°C)')).toBe('temp_30(°c)')
  })

  it('correctly normalizes the unbroken UTF-8 degree sign (°)', () => {
    expect(canonicalizeBracketGroupKey('Temp_30(°C)')).toBe('temp_30(°c)')
  })

  it('Â°C and °C produce the SAME canonical key (mojibake == correct)', () => {
    const mojibake = canonicalizeBracketGroupKey('Temp_30(Â°C)')
    const correct  = canonicalizeBracketGroupKey('Temp_30(°C)')
    expect(mojibake).toBe(correct)
  })

  it('is idempotent — applying twice gives same result', () => {
    const once  = canonicalizeBracketGroupKey('Temp_30(Â°C)')
    const twice = canonicalizeBracketGroupKey(once)
    expect(twice).toBe(once)
  })

  it('handles empty string without throwing', () => {
    expect(canonicalizeBracketGroupKey('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Remap logic: alias map built from groupNames resolves mojibake bracket keys
// ---------------------------------------------------------------------------

/**
 * Minimal inline replica of remapBracketsToGroups from plotResultService.ts,
 * using canonicalizeBracketGroupKey on both sides.  The real function is private;
 * this test verifies the algorithm is correct with the canonical key.
 */
function remapWithCanonical(
  brackets: SignificanceBracket[],
  groupNames: string[],
): SignificanceBracket[] {
  const aliasMap = new Map<string, string>()
  groupNames.forEach((name, i) => {
    aliasMap.set(canonicalizeBracketGroupKey(name), name)
    aliasMap.set(canonicalizeBracketGroupKey(`Group ${i + 1}`), name)
    aliasMap.set(canonicalizeBracketGroupKey(`Group${i + 1}`), name)
  })
  return brackets.map((b) => ({
    ...b,
    group1: aliasMap.get(canonicalizeBracketGroupKey(String(b.group1))) ?? String(b.group1),
    group2: aliasMap.get(canonicalizeBracketGroupKey(String(b.group2))) ?? String(b.group2),
  }))
}

describe('remapWithCanonical — mojibake bracket names resolve to display names', () => {
  const groupNames = ['Control', 'Temp_30(°C)', 'Temp_37(°C)']

  it('remaps Â°C bracket group2 to correct °C display name', () => {
    const brackets: SignificanceBracket[] = [
      { group1: 'Control', group2: 'Temp_30(Â°C)', pValue: 0.001, label: '***', height: 0 },
    ]
    const remapped = remapWithCanonical(brackets, groupNames)
    expect(remapped[0]!.group2).toBe('Temp_30(°C)')
  })

  it('leaves correctly-encoded bracket unchanged', () => {
    const brackets: SignificanceBracket[] = [
      { group1: 'Control', group2: 'Temp_30(°C)', pValue: 0.001, label: '***', height: 0 },
    ]
    const remapped = remapWithCanonical(brackets, groupNames)
    expect(remapped[0]!.group2).toBe('Temp_30(°C)')
  })

  it('does not remap group names not present in groupNames (preserves original)', () => {
    const brackets: SignificanceBracket[] = [
      { group1: 'Control', group2: 'Temp_99(Â°C)', pValue: 0.5, label: 'ns', height: 0 },
    ]
    const remapped = remapWithCanonical(brackets, groupNames)
    // No match → preserved as-is
    expect(remapped[0]!.group2).toBe('Temp_99(Â°C)')
  })
})

// ---------------------------------------------------------------------------
// Integration: after remap, stackBrackets produces non-empty output
// ---------------------------------------------------------------------------

describe('stackBrackets non-empty after mojibake remap', () => {
  it('brackets with Â°C group name map to category and produce stacked output', () => {
    const groupNames = ['Control', 'Temp_30(°C)', 'Temp_37(°C)']
    const rawBrackets: SignificanceBracket[] = [
      { group1: 'Control', group2: 'Temp_30(Â°C)', pValue: 0.001, label: '***', height: 0 },
      { group1: 'Control', group2: 'Temp_37(Â°C)', pValue: 0.01,  label: '**',  height: 0 },
    ]

    // Remap using canonical matcher
    const remapped = remapWithCanonical(rawBrackets, groupNames)

    // Build category order (same as buildCategoryOrderWithAliases)
    const categoryOrder = new Map(groupNames.map((name, i) => [name, i]))

    const settings = createDefaultBracketSettings()
    const stacked = stackBrackets(remapped, settings, categoryOrder)

    // Both brackets should survive stacking — non-empty result proves remap worked
    expect(stacked.length).toBe(2)
    // Each bracket must have a finite group1/group2 position after stacking
    for (const b of stacked) {
      expect(typeof b.group1).toBe('string')
      expect(categoryOrder.has(String(b.group1))).toBe(true)
      expect(categoryOrder.has(String(b.group2))).toBe(true)
    }
  })

  it('without remap (original Â°C), brackets are lost (NaN positions) — confirms the bug exists', () => {
    const groupNames = ['Control', 'Temp_30(°C)', 'Temp_37(°C)']
    const rawBrackets: SignificanceBracket[] = [
      { group1: 'Control', group2: 'Temp_30(Â°C)', pValue: 0.001, label: '***', height: 0 },
    ]

    // Do NOT remap — simulate pre-fix behavior
    const categoryOrder = new Map(groupNames.map((name, i) => [name, i]))
    const settings = createDefaultBracketSettings()
    const stacked = stackBrackets(rawBrackets, settings, categoryOrder)

    // Without fix: group2='Temp_30(Â°C)' is not in categoryOrder → NaN span → sorted to end / filtered
    // stackBrackets still returns the bracket, but its position resolves to NaN
    // The bracket will not render (createBracketShapes skips NaN-positioned brackets)
    // We assert either: stacked is empty OR the bracket has a NaN-resolvable position
    const hasNaNPosition = stacked.some((b) => {
      const pos2 = categoryOrder.get(String(b.group2))
      return pos2 === undefined
    })
    expect(hasNaNPosition).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// console.warn emitted for unmatched bracket groups (debug regression guard)
// ---------------------------------------------------------------------------
// NOTE: the warn test is in plotResultService integration tests (not here),
// since the warn lives in the private remapBracketsToGroups function.
// The canonical key tests above are sufficient to guard the algorithm.

// ---------------------------------------------------------------------------
// Gap 1: NBSP variant of à (Ã\u00A0 is NOT Ã+space)
// ---------------------------------------------------------------------------

describe('repairMojibakeForDisplay — NBSP mojibake repair (Ã\\u00A0)', () => {
  // à (U+00E0) UTF-8 = 0xC3 0xA0; misread as Latin-1 → Ã (U+00C3) + NBSP (U+00A0)
  // The old targeted-repair had /Ã /g (regular space U+0020) — WRONG: 0xA0 ≠ 0x20
  // Only the generic guarded recovery (or an explicit /Ã\u00A0/g) handles this.
  it('repairs Ã+NBSP (à mojibake with non-breaking space) correctly', () => {
    expect(repairMojibakeForDisplay('Ã\u00A0good')).toBe('àgood')
  })

  it('Ã+NBSP and à produce the same repaired text', () => {
    expect(repairMojibakeForDisplay('Ã\u00A0')).toBe(repairMojibakeForDisplay('à'))
  })

  it('canonicalizeBracketGroupKey: Ã+NBSP and à canonicalize to the same key (via repair)', () => {
    // Both repair to à — no diacritic fold, so the key is 'à' not 'a'
    expect(canonicalizeBracketGroupKey('Ã\u00A0')).toBe('à')
    expect(canonicalizeBracketGroupKey('Ã\u00A0')).toBe(canonicalizeBracketGroupKey('à'))
  })
})

// ---------------------------------------------------------------------------
// Gap 1b: Generic guarded recovery — characters not in the targeted-repair list
// Use repairMojibakeForDisplay to test repair in isolation (no case change).
// canonicalizeBracketGroupKey applies repair + lowercase only — NO diacritic fold.
// ñ stays ñ and ú stays ú (fold was removed to prevent alias-map key collisions).
// ---------------------------------------------------------------------------

describe('repairMojibakeForDisplay — generic guarded recovery', () => {
  // ñ (U+00F1) UTF-8 = 0xC3 0xB1; misread as Latin-1 → Ã (U+00C3) + ± (U+00B1)
  // No explicit targeted-repair rule for ñ — only generic recovery handles it.
  it('repairs Ã± (ñ mojibake) via generic recovery', () => {
    expect(repairMojibakeForDisplay('Ã±')).toBe('ñ')
  })

  // ú (U+00FA) UTF-8 = 0xC3 0xBA; misread → Ã (U+00C3) + º (U+00BA)
  it('repairs Ãº (ú mojibake) via generic recovery', () => {
    expect(repairMojibakeForDisplay('Ãº')).toBe('ú')
  })

  // canonicalizeBracketGroupKey must NOT fold these to ASCII — that would cause
  // key collisions (ñ and n would both map to 'n', overwriting the alias entry).
  it('canonicalizeBracketGroupKey preserves ñ (does NOT fold to n — collision guard)', () => {
    expect(canonicalizeBracketGroupKey('Ã±')).toBe('ñ')
    expect(canonicalizeBracketGroupKey('ñ')).toBe('ñ')
    // ñ and n must NOT share the same key
    expect(canonicalizeBracketGroupKey('ñ')).not.toBe(canonicalizeBracketGroupKey('n'))
  })

  it('canonicalizeBracketGroupKey preserves ú (does NOT fold to u — collision guard)', () => {
    expect(canonicalizeBracketGroupKey('Ãº')).toBe('ú')
    expect(canonicalizeBracketGroupKey('ú')).not.toBe(canonicalizeBracketGroupKey('u'))
  })
})

// ---------------------------------------------------------------------------
// Gap 2: repairMojibakeForDisplay — display-safe (preserves case, no diacritic fold)
// ---------------------------------------------------------------------------

describe('repairMojibakeForDisplay', () => {
  it('is exported', () => {
    expect(typeof repairMojibakeForDisplay).toBe('function')
  })

  it('repairs Â°C and preserves original case', () => {
    expect(repairMojibakeForDisplay('Temp_30(Â°C) vs Control')).toBe('Temp_30(°C) vs Control')
  })

  it('does NOT lowercase the result (display-safe)', () => {
    const result = repairMojibakeForDisplay('GroupA vs GroupB')
    expect(result).toBe('GroupA vs GroupB')
  })

  it('repairs generic mojibake (ñ) and preserves case in context', () => {
    expect(repairMojibakeForDisplay('MuÃ±oz')).toBe('Muñoz')
  })

  it('is idempotent on clean UTF-8 text', () => {
    const clean = 'Temp_30(°C) vs Control'
    expect(repairMojibakeForDisplay(clean)).toBe(clean)
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Integration through buildPlotSpecsFromResult (real wiring)
// Tests that the full pipeline — extractPostHocBrackets → remapBracketsToGroups →
// stackBrackets → createBracketShapes — produces bracket shapes in the output.
// ---------------------------------------------------------------------------

describe('buildPlotSpecsFromResult — bracket shapes present after mojibake remap', () => {
  function makeOneWayAnovaResult(
    groupNames: string[],
    pairwiseComparisons: Array<{ group1: string; group2: string; p_adjusted: number }>,
  ): TestResult {
    const groups = groupNames.map((_, i) => Array.from({ length: 8 }, (_, j) => (i + 1) * 10 + j))
    return {
      id: 'test-mojibake-integration',
      testId: 'one_way_anova',
      testName: 'One-Way ANOVA',
      family: 'parametric',
      executedAt: new Date(),
      statistics: { pValue: 0.001, fValue: 12.3 },
      plotPayload: {
        test: 'one_way_anova',
        data: {
          groups,
          group_names: groupNames,
          group_column: 'Trait',
        },
      },
      rawOutput: {
        pairwise_comparisons: pairwiseComparisons.map((c) => ({
          group1: c.group1,
          group2: c.group2,
          p_adjusted: c.p_adjusted,
          comparison: `${c.group1} vs ${c.group2}`,
        })),
      },
    } satisfies TestResult
  }

  it('bar plot has sig_bracket shapes when bracket group names use correct UTF-8', () => {
    const result = makeOneWayAnovaResult(
      ['Control', 'Temp_30(°C)', 'Temp_37(°C)'],
      [
        { group1: 'Control', group2: 'Temp_30(°C)', p_adjusted: 0.001 },
        { group1: 'Control', group2: 'Temp_37(°C)', p_adjusted: 0.01 },
      ],
    )
    const specs = buildPlotSpecsFromResult(result)
    const bar = specs.find((s) => s.plot.type === 'bar')
    expect(bar).toBeDefined()
    const shapes = ((bar!.plot.plotlyLayout as { shapes?: { name?: string }[] }).shapes) ?? []
    const bracketShapes = shapes.filter((s) => s.name?.startsWith('sig_bracket_'))
    expect(bracketShapes.length).toBeGreaterThan(0)
  })

  it('bar plot has sig_bracket shapes when bracket group names have Â°C mojibake (remap fix)', () => {
    // This is the actual regression: group_names have °C (correct) but
    // pairwise_comparisons have Â°C (mojibake from Python backend).
    const result = makeOneWayAnovaResult(
      ['Control', 'Temp_30(°C)', 'Temp_37(°C)'],
      [
        { group1: 'Control', group2: 'Temp_30(Â°C)', p_adjusted: 0.001 },
        { group1: 'Control', group2: 'Temp_37(Â°C)', p_adjusted: 0.01 },
      ],
    )
    const specs = buildPlotSpecsFromResult(result)
    const bar = specs.find((s) => s.plot.type === 'bar')
    expect(bar).toBeDefined()
    const shapes = ((bar!.plot.plotlyLayout as { shapes?: { name?: string }[] }).shapes) ?? []
    const bracketShapes = shapes.filter((s) => s.name?.startsWith('sig_bracket_'))
    // Without fix: bracketShapes.length === 0 (group2 can't be found in categoryOrder)
    // With fix: bracketShapes.length > 0
    expect(bracketShapes.length).toBeGreaterThan(0)
  })

  it('effectLabel in bracket meta has no Â° mojibake after remap', () => {
    const result = makeOneWayAnovaResult(
      ['Control', 'Temp_30(°C)'],
      [{ group1: 'Control', group2: 'Temp_30(Â°C)', p_adjusted: 0.001 }],
    )
    const specs = buildPlotSpecsFromResult(result)
    const bar = specs.find((s) => s.plot.type === 'bar')
    expect(bar).toBeDefined()
    const meta = (bar!.plot.plotlyLayout as { meta?: { bracketCatalog?: { brackets?: Array<{ effectLabel?: string }> } } }).meta
    const brackets = meta?.bracketCatalog?.brackets ?? []
    for (const b of brackets) {
      expect(b.effectLabel ?? '').not.toContain('Â°')
    }
  })
})
