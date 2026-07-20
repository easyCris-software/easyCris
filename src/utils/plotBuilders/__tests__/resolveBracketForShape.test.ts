/**
 * Unit tests for resolveBracketForShape.
 *
 * Covers the C1 regression: when multiple sig_bracket_* shapes share one effectId
 * (LMM trajectory case), the label-mode update must use per-shape index lookup
 * rather than returning the first bracket stored per effectId.
 */

import { describe, it, expect } from 'vitest'
import { resolveBracketForShape } from '../resolveBracketForShape'
import type { SignificanceBracket } from '../types'

function makeBracket(label: string, pValue: number, effectId: string): SignificanceBracket {
  return { group1: 0, group2: 0, pValue, label, height: 0, effectId, effectGroup: 'simple' }
}

describe('resolveBracketForShape', () => {
  // LMM trajectory: 2 timepoints share one effectId
  const brackets = [
    makeBracket('ns', 0.20, 'lmm_se|pooled|THC_vs_VEH'),  // sig_bracket_0
    makeBracket('*',  0.04, 'lmm_se|pooled|THC_vs_VEH'),  // sig_bracket_1
  ]

  // Both shapes → same effectId (the shared comparison toggle)
  const shapeToEffectId = new Map([
    ['sig_bracket_0', 'lmm_se|pooled|THC_vs_VEH'],
    ['sig_bracket_1', 'lmm_se|pooled|THC_vs_VEH'],
  ])

  // bracketByEffectId stores ONLY the first bracket per effectId (PlotSidebar's current behavior)
  const bracketByEffectId = new Map<string, SignificanceBracket>([
    ['lmm_se|pooled|THC_vs_VEH', brackets[0]!],
  ])

  const noSubplotBrackets = () => [] as SignificanceBracket[]

  it('sig_bracket_0 returns brackets[0] (ns, p=0.20)', () => {
    const result = resolveBracketForShape(
      'sig_bracket_0', brackets, shapeToEffectId, bracketByEffectId, noSubplotBrackets,
    )
    expect(result?.label).toBe('ns')
    expect(result?.pValue).toBe(0.20)
  })

  it('sig_bracket_1 returns brackets[1] (*, p=0.04) — not the first-effectId bracket (C1 regression)', () => {
    // Without fix: effectId path runs first → returns brackets[0] (ns) — WRONG
    // With fix: index path runs first → returns brackets[1] (*) — CORRECT
    const result = resolveBracketForShape(
      'sig_bracket_1', brackets, shapeToEffectId, bracketByEffectId, noSubplotBrackets,
    )
    expect(result?.label).toBe('*')
    expect(result?.pValue).toBe(0.04)
  })

  it('returns undefined for sig_bracket_99 (out of bounds)', () => {
    const result = resolveBracketForShape(
      'sig_bracket_99', brackets, shapeToEffectId, bracketByEffectId, noSubplotBrackets,
    )
    expect(result).toBeUndefined()
  })

  it('uses effectId fallback for non-standard shape names', () => {
    const result = resolveBracketForShape(
      'custom_shape', brackets, shapeToEffectId, bracketByEffectId, noSubplotBrackets,
    )
    // Not a sig_bracket_N name → falls through to effectId path → undefined (not in map)
    expect(result).toBeUndefined()
  })

  it('handles subplot format sig_bracket_<id>_N via subplot getter', () => {
    const subplotBracket = makeBracket('**', 0.008, 'eff-subplot')
    const getSubplotBrackets = (id: string) => id === 'myplot' ? [subplotBracket] : []
    const result = resolveBracketForShape(
      'sig_bracket_myplot_0', brackets, shapeToEffectId, bracketByEffectId, getSubplotBrackets,
    )
    expect(result?.label).toBe('**')
  })
})
