/**
 * Factor Role Assignment for Multifactorial ANOVA Plots
 *
 * Maps N factors to plot dimensions:
 * - 2 factors: x, series (no facets)
 * - 3+ factors: x, series, facets (mandatory)
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: Two-Way ANOVA, Multifactorial ANOVA. Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

export interface FactorRole {
  x: string
  series: string
  facets: string[]
}

export interface CellMean {
  factors: Record<string, string>
  mean: number | string
  std: number | string
  se?: number | string
  n: number
  ci_lower?: number | string
  ci_upper?: number | string
  q1?: number | string
  q3?: number | string
  iqr?: number | string
}

type ExplicitFactorMapping =
  | { x: string; series: string; facets?: string[] }
  | { primary: string; secondary: string; facets?: string[] }
  | { factorA: string; factorB: string; facets?: string[] }

// Normalize various mapping formats to ExplicitFactorMapping
export function normalizeFactorMapping(
  mapping: unknown,
  factorNames: string[]
): ExplicitFactorMapping | undefined {
  if (!mapping || typeof mapping !== 'object') return undefined
  const entry = mapping as Record<string, unknown>

  // Extract x/primary/factorA
  let x: string | undefined
  let series: string | undefined

  if (typeof entry.x === 'string') x = entry.x
  else if (typeof entry.primary === 'string') x = entry.primary
  else if (typeof entry.factorA === 'string') x = entry.factorA

  // Extract series/secondary/factorB
  if (typeof entry.series === 'string') series = entry.series
  else if (typeof entry.secondary === 'string') series = entry.secondary
  else if (typeof entry.factorB === 'string') series = entry.factorB

  if (typeof x !== 'string' || typeof series !== 'string') {
    return undefined
  }

  // Validate that x and series are actual factor names
  const factorSet = new Set(factorNames)
  if (!factorSet.has(x) || !factorSet.has(series)) {
    return undefined
  }

  // Filter facets to only include valid factor names
  const facetsRaw = Array.isArray(entry.facets) ? entry.facets : []
  const facets = facetsRaw
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => factorSet.has(value))

  return { x, series, facets }
}

// Assign factors to x/series/facets
export function assignFactorRoles(
  factorNames: string[],
  explicitMapping?: ExplicitFactorMapping
): FactorRole {
  if (factorNames.length < 2) {
    throw new Error('assignFactorRoles requires at least 2 factors')
  }

  // PRIORITY 1: Use explicit user mapping if provided
  if (explicitMapping) {
    if ('x' in explicitMapping && 'series' in explicitMapping) {
      return {
        x: explicitMapping.x,
        series: explicitMapping.series,
        facets: explicitMapping.facets ?? [],
      }
    }
    if ('primary' in explicitMapping && 'secondary' in explicitMapping) {
      return {
        x: explicitMapping.primary,
        series: explicitMapping.secondary,
        facets: explicitMapping.facets ?? [],
      }
    }
    if ('factorA' in explicitMapping && 'factorB' in explicitMapping) {
      return {
        x: explicitMapping.factorA,
        series: explicitMapping.factorB,
        facets: explicitMapping.facets ?? [],
      }
    }
  }

  // PRIORITY 2: Preserve provided order (stable, non-data-dependent)
  if (factorNames.length === 2) {
    return {
      x: factorNames[0] ?? 'factor1',
      series: factorNames[1] ?? 'factor2',
      facets: [],
    }
  }

  return {
    x: factorNames[0] ?? 'factor1',
    series: factorNames[1] ?? 'factor2',
    facets: factorNames.slice(2).filter(Boolean),
  }
}

// Deterministic factor level order (alpha)
export function getFactorLevelOrder(cellMeans: CellMean[], factorName: string): string[] {
  const levels = new Set<string>()
  for (const cell of cellMeans) {
    const value = cell.factors?.[factorName]
    if (value !== undefined) levels.add(String(value))
  }
  return Array.from(levels).sort()
}

// Count factor levels
export function getFactorLevelCounts(
  cellMeans: CellMean[],
  factorNames: string[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  factorNames.forEach((name) => {
    counts[name] = getFactorLevelOrder(cellMeans, name).length
  })
  return counts
}

// Extract factor names from result data (best-effort)
export function getFactorNamesFromResult(resultData: Record<string, unknown>): string[] {
  const factorNamesRaw = resultData.factor_names
  if (Array.isArray(factorNamesRaw)) {
    return factorNamesRaw.filter((name): name is string => typeof name === 'string')
  }
  if (typeof factorNamesRaw === 'string') {
    return factorNamesRaw.split(';').map((s) => s.trim()).filter(Boolean)
  }

  const cellMeans = resultData.cell_means as CellMean[] | undefined
  if (cellMeans && cellMeans.length > 0 && cellMeans[0]?.factors) {
    return Object.keys(cellMeans[0].factors)
  }

  const labels: string[] = []
  let idx = 1
  while (true) {
    const label = resultData[`factor${idx}_label`]
    if (typeof label === 'string' && label.trim()) {
      labels.push(label.trim())
      idx += 1
    } else {
      break
    }
  }
  return labels
}

// Validate assignment (no duplicates, all factors assigned)
export function validateFactorRoles(roles: FactorRole, factorNames: string[]): void {
  const allAssigned = [roles.x, roles.series, ...roles.facets]
  if (allAssigned.length !== factorNames.length) {
    throw new Error(
      `Factor role assignment mismatch: ${allAssigned.length} assigned, ${factorNames.length} expected`
    )
  }
  const unique = new Set(allAssigned)
  if (unique.size !== allAssigned.length) {
    throw new Error('Factor role assignment contains duplicates')
  }
}
