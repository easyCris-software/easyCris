/**
 * LMM_COLORS — single source of truth for all LMM trajectory color assignments.
 *
 * Consumed by:
 *   - buildCompoundTrajectory.ts  (compound color map)
 *   - buildLmmPlots.ts            (legacy stratum cycling)
 *   - resolveTraceRoles.ts        (pooled/stratified trace role resolution)
 *
 * Index 0 = first stratify level (e.g. B6)  → pure blue
 * Index 1 = second stratify level (e.g. D2) → pure red
 * Remaining = fallback cycling palette
 */
export const LMM_COLORS: readonly string[] = [
  '#0000ff', '#ff0000', '#00CC96', '#AB63FA', '#FFA15A',
  '#19D3F3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52',
]
