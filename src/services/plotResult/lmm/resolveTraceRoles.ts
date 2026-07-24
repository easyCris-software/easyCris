/**
 * resolveTraceRoles
 *
 * Derives visual role assignments from the data semantics of an LMM trajectory
 * result, without hardcoding any factor or level names.
 *
 * Roles resolved:
 *   lineStyleFactor — factor that drives solid/dot dash (= groupFactor in rows)
 *   colorFactor     — factor that drives shared trace color (= first facet dim)
 *   dashMap         — alphabetically stable level → dash assignment
 *   sharedColor     — single color for all traces in this plot panel
 *
 * Returns resolved=false with empty maps when the mapping is ambiguous
 * (0 rows, 1 group level, or >2 group levels).
 *
 * Phase 2: accepts an optional per-plot override.  Resolution order (highest priority first):
 *   1. Valid explicit override  (baselineLevel / contrastLevel both in data)
 *   2. Semantic groupRole       (baseline → dot, contrast → solid)
 *   3. Alphabetical fallback    (sorted[0] = solid, sorted[1] = dot)
 *
 * After dashMap is determined, swapStyles inverts solid↔dot.
 * An invalid override (level not found in data) records a reason and falls through.
 */

import type { LmmTrajectoryRow } from './normalize'
import { LMM_COLORS } from './lmmPalette'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceRoleMapping {
  /** Diagnostic metadata: factor name that drives dash style (= groupFactor in rows). Not consumed by renderers. */
  lineStyleFactor: string | null
  /** Diagnostic metadata: factor name that drives shared color (= first facet dim). Not consumed by renderers. */
  colorFactor: string | null
  dashMap: Record<string, 'solid' | 'dot'>
  sharedColor: string
  resolved: boolean
  reason: string
}

/**
 * Per-plot style override payload stored in plots-store.
 * All fields are optional — only provided fields override resolved values.
 */
export interface LmmTraceRoleOverride {
  /** Override which group level is the baseline (→ dot) */
  baselineLevel?: string
  /** Override which group level is the contrast (→ solid) */
  contrastLevel?: string
  /** Invert the resolved dashMap (solid↔dot) after all other resolution */
  swapStyles?: boolean
}

// ---------------------------------------------------------------------------
// Color palette — imported from shared lmmPalette (single source of truth)
// ---------------------------------------------------------------------------

const COLORS = LMM_COLORS

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve visual role assignments for one plot panel's trajectory rows.
 *
 * @param rows       Trajectory rows for this panel (all share the same facet values)
 * @param facetDims  Ordered list of facet dimension names for this result
 * @param colorIdx   Palette index for this panel (0-based, cycles through COLORS)
 * @param override   Optional per-plot style override (Phase 2)
 */
export function resolveTraceRoles(
  rows: LmmTrajectoryRow[],
  facetDims: string[],
  colorIdx = 0,
  override?: LmmTraceRoleOverride,
): TraceRoleMapping {
  const fallback = (reason: string): TraceRoleMapping => ({
    lineStyleFactor: null,
    colorFactor: null,
    dashMap: {},
    sharedColor: '',
    resolved: false,
    reason,
  })

  if (rows.length === 0) {
    return fallback('no rows')
  }

  const groupValues = [...new Set(rows.map((r) => r.groupValue))]

  if (groupValues.length !== 2) {
    return fallback(`expected exactly 2 group values, got ${groupValues.length}`)
  }

  const lineStyleFactor: string | null = rows[0]!.groupFactor
  const colorFactor: string | null = facetDims.length > 0 ? (facetDims[0] ?? null) : null

  // -------------------------------------------------------------------------
  // Step 1: attempt explicit override (baselineLevel / contrastLevel)
  // -------------------------------------------------------------------------
  let overrideReason = ''
  let dashMap: Record<string, 'solid' | 'dot'> | null = null

  if (override?.baselineLevel !== undefined || override?.contrastLevel !== undefined) {
    const bl = override.baselineLevel
    const cl = override.contrastLevel

    const blValid = bl === undefined || groupValues.includes(bl)
    const clValid = cl === undefined || groupValues.includes(cl)

    if (!blValid) {
      overrideReason = `override baselineLevel '${bl}' not found in data`
    } else if (!clValid) {
      overrideReason = `override contrastLevel '${cl}' not found in data`
    } else {
      // Derive the other side when only one level is specified
      const resolvedBaseline = bl ?? groupValues.find(v => v !== cl)!
      const resolvedContrast = cl ?? groupValues.find(v => v !== bl)!
      dashMap = {
        [resolvedBaseline]: 'dot',
        [resolvedContrast]: 'solid',
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: semantic groupRole metadata
  // -------------------------------------------------------------------------
  if (dashMap === null) {
    const baselineValue = groupValues.find(v => rows.find(r => r.groupValue === v)?.groupRole === 'baseline')
    const contrastValue = groupValues.find(v => rows.find(r => r.groupValue === v)?.groupRole === 'contrast')
    const hasFullRoles = baselineValue !== undefined && contrastValue !== undefined

    if (hasFullRoles) {
      dashMap = {
        [baselineValue]: 'dot',
        [contrastValue]: 'solid',
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: alphabetical fallback
  // -------------------------------------------------------------------------
  if (dashMap === null) {
    const sorted = [...groupValues].sort()
    dashMap = {
      [sorted[0]!]: 'solid',
      [sorted[1]!]: 'dot',
    }
  }

  // -------------------------------------------------------------------------
  // Post-resolution: apply swapStyles
  // -------------------------------------------------------------------------
  if (override?.swapStyles === true) {
    const swapped: Record<string, 'solid' | 'dot'> = {}
    for (const [k, v] of Object.entries(dashMap)) {
      swapped[k] = v === 'solid' ? 'dot' : 'solid'
    }
    dashMap = swapped
  }

  const sharedColor = COLORS[colorIdx % COLORS.length]!

  return {
    lineStyleFactor,
    colorFactor,
    dashMap,
    sharedColor,
    resolved: true,
    reason: overrideReason,
  }
}
