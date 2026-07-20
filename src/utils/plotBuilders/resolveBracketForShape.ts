import type { SignificanceBracket } from './types'

/**
 * Resolve the correct SignificanceBracket for a sig_bracket_* shape name.
 *
 * Priority order (most reliable first):
 *   1. Standard index:  sig_bracket_N         → catalog.brackets[N]
 *   2. Subplot index:   sig_bracket_<id>_N    → getSubplotBrackets(id)[N]
 *   3. EffectId fallback (unreliable when multiple shapes share one effectId — C1)
 *
 * Exporting as a pure function makes this logic directly testable without mounting
 * the full PlotSidebar component.
 */
export function resolveBracketForShape(
  shapeName: string,
  catalogBrackets: readonly SignificanceBracket[],
  shapeToEffectId: ReadonlyMap<string, string>,
  bracketByEffectId: ReadonlyMap<string, SignificanceBracket>,
  getSubplotBrackets: (subplotId: string) => SignificanceBracket[],
): SignificanceBracket | undefined {
  // 1. Standard sig_bracket_N → per-shape index (correct even when many shapes share one effectId)
  const standardMatch = /^sig_bracket_(\d+)$/.exec(shapeName)
  if (standardMatch) {
    return catalogBrackets[Number(standardMatch[1])]
  }

  // 2. Subplot format sig_bracket_<id>_N
  const subplotMatch = /^sig_bracket_(.+?)_(\d+)$/.exec(shapeName)
  if (subplotMatch) {
    const subplotId = subplotMatch[1] ?? ''
    const bracketIndex = Number(subplotMatch[2])
    if (subplotId) {
      return getSubplotBrackets(subplotId)[bracketIndex]
    }
  }

  // 3. EffectId fallback (only reached for non-standard shape names)
  if (shapeToEffectId.has(shapeName)) {
    return bracketByEffectId.get(shapeToEffectId.get(shapeName) ?? '')
  }

  return undefined
}
