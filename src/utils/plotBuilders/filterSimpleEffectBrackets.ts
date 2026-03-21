/**
 * Filter Simple Effect Brackets for Faceted Plots
 *
 * For multifactorial ANOVA with faceting, each subplot should only show
 * significance brackets that match the subplot's facet levels.
 *
 * Example: 3-way ANOVA (Drug × Dose × Temp)
 * - Facet by Temp (Low, High)
 * - Temp=Low subplot: Only show brackets where factors.Temp === 'Low'
 * - Temp=High subplot: Only show brackets where factors.Temp === 'High'
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: Multifactorial ANOVA (113 metrics). Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

/**
 * Significance bracket from Python backend (simple effects)
 */
export interface SimpleEffectBracket {
  /** Group 1 label (e.g., "Drug A at Low Dose") */
  group1: string
  /** Group 2 label (e.g., "Drug B at Low Dose") */
  group2: string
  /** P-value */
  p_value: number
  /** Significance indicator (e.g., "***", "**", "*", "ns") */
  sig: string
  /** Factor levels for this comparison (e.g., {Drug: "A", Dose: "Low", Temp: "High"}) */
  factors?: Record<string, string>
  /** Mean difference (optional) */
  mean_diff?: number
  /** Optional p-value text (formatted) */
  p_value_text?: string
  /** Optional compared factor name (e.g., "factor1") */
  compared_factor?: string
}

/**
 * Facet level specification
 */
export interface FacetLevel {
  /** Facet factor name (e.g., "Temp") */
  factorName: string
  /** Facet level value (e.g., "High") */
  level: string
}

/**
 * Filter brackets to match facet levels
 *
 * @param brackets - All simple effect brackets from Python backend
 * @param facetLevels - Current subplot's facet levels (e.g., [{factorName: "Temp", level: "High"}])
 * @returns Filtered brackets matching all facet levels
 *
 * @example
 * // 3-way ANOVA: Drug × Dose × Temp, faceted by Temp
 * const brackets = [
 *   { group1: "A", group2: "B", p_value: 0.001, sig: "***", factors: {Drug: "A", Dose: "Low", Temp: "High"} },
 *   { group1: "A", group2: "B", p_value: 0.05, sig: "*", factors: {Drug: "A", Dose: "Low", Temp: "Low"} },
 * ]
 * const filtered = filterSimpleEffectBrackets(brackets, [{factorName: "Temp", level: "High"}])
 * // Returns: [{ group1: "A", group2: "B", p_value: 0.001, sig: "***", factors: {...} }]
 */
export function filterSimpleEffectBrackets(
  brackets: SimpleEffectBracket[],
  facetLevels: FacetLevel[]
): SimpleEffectBracket[] {
  // No faceting → return all brackets
  if (facetLevels.length === 0) {
    return brackets
  }

  return brackets.filter((bracket) => {
    // If bracket has no factors metadata, can't filter (keep it)
    if (!bracket.factors) {
      return true
    }

    // Check if ALL facet factors match the bracket's factors
    return facetLevels.every(({ factorName, level }) => {
      if (!factorName) return false
      const bracketLevel = bracket.factors![factorName]
      if (bracketLevel === undefined || bracketLevel === null) {
        return true
      }
      return bracketLevel === level
    })
  })
}

/**
 * Extract facet levels from subplot identifier
 *
 * @param subplotId - Subplot identifier (e.g., "Temp_High_Age_Young")
 * @param facetFactors - Ordered list of facet factor names (e.g., ["Temp", "Age"])
 * @returns Facet level specifications
 *
 * @example
 * extractFacetLevels("Temp_High_Age_Young", ["Temp", "Age"])
 * // Returns: [{factorName: "Temp", level: "High"}, {factorName: "Age", level: "Young"}]
 */
export function extractFacetLevels(
  subplotId: string,
  facetFactors: string[]
): FacetLevel[] {
  const parts = subplotId.split('_')
  const facetLevels: FacetLevel[] = []

  // Match pattern: FactorName_Level (e.g., "Temp_High")
  for (let i = 0; i < facetFactors.length; i++) {
    const factorName = facetFactors[i]
    if (!factorName) continue
    const expectedPrefix = factorName

    // Find the factor name in parts
    const idx = parts.indexOf(expectedPrefix)
    if (idx !== -1 && idx + 1 < parts.length) {
      facetLevels.push({
        factorName,
        level: parts[idx + 1] ?? '',
      })
    }
  }

  return facetLevels
}

/**
 * Create subplot ID from facet levels
 *
 * @param facetLevels - Facet level specifications
 * @returns Subplot identifier (e.g., "Temp_High_Age_Young")
 *
 * @example
 * createSubplotId([{factorName: "Temp", level: "High"}, {factorName: "Age", level: "Young"}])
 * // Returns: "Temp_High_Age_Young"
 */
export function createSubplotId(facetLevels: FacetLevel[]): string {
  return facetLevels
    .filter((f) => f.factorName && f.level)
    .map(({ factorName, level }) => `${factorName}_${level}`)
    .join('_')
}

/**
 * Group brackets by subplot (for faceted plots)
 *
 * @param brackets - All simple effect brackets from Python backend
 * @param facetFactors - Ordered list of facet factor names
 * @returns Map of subplot ID → filtered brackets
 *
 * @example
 * // 3-way ANOVA: Drug × Dose × Temp, faceted by Temp
 * const brackets = [
 *   { group1: "A", group2: "B", p_value: 0.001, sig: "***", factors: {Drug: "A", Dose: "Low", Temp: "High"} },
 *   { group1: "A", group2: "B", p_value: 0.05, sig: "*", factors: {Drug: "A", Dose: "Low", Temp: "Low"} },
 * ]
 * const grouped = groupBracketsBySubplot(brackets, ["Temp"])
 * // Returns: Map {
 * //   "Temp_High": [{ group1: "A", group2: "B", p_value: 0.001, ... }],
 * //   "Temp_Low": [{ group1: "A", group2: "B", p_value: 0.05, ... }],
 * // }
 */
export function groupBracketsBySubplot(
  brackets: SimpleEffectBracket[],
  facetFactors: string[]
): Map<string, SimpleEffectBracket[]> {
  const grouped = new Map<string, SimpleEffectBracket[]>()

  // No faceting → return all brackets under empty key
  if (facetFactors.length === 0) {
    grouped.set('', brackets)
    return grouped
  }

  for (const bracket of brackets) {
    // Skip brackets without factors metadata
    if (!bracket.factors) {
      continue
    }

    // Extract facet levels from bracket's factors
    const facetLevels: FacetLevel[] = facetFactors.map((factorName) => ({
      factorName,
      level: String(bracket.factors![factorName]),
    }))

    // Create subplot ID
    const subplotId = createSubplotId(facetLevels)

    // Add bracket to this subplot's group
    if (!grouped.has(subplotId)) {
      grouped.set(subplotId, [])
    }
    grouped.get(subplotId)!.push(bracket)
  }

  return grouped
}
