/**
 * rebuildBracketShapes — pure utility
 *
 * Rebuilds sig_bracket_* shape geometry with given params.
 * Used by PlotSidebar to toggle between thin (normal) and fat (edit-mode) styles.
 *
 * Path format (8-number): M xL,tipY L xL,baseY L xR,baseY L xR,tipY
 *   xCenter = (xL + xR) / 2  — always preserved
 *   baseY                     — always preserved (vertical position)
 *   tickHeight = yRange * tickHeightRatio
 *   halfWidth from params      — applied symmetrically around xCenter
 */

export interface ShapeRebuildParams {
  halfWidth: number
  tickHeightRatio: number
  lineWidth: number
  /** Stroke color for the anchor path. Defaults to fully transparent when omitted.
   *  Never persisted in bracketShapeParams meta — always injected from constants. */
  lineColor?: string
}

/** Transparent anchor color — used in both normal and edit mode */
const TRANSPARENT = 'rgba(0,0,0,0)'

/** Thin bracket params — normal display mode (invisible anchor, label is the only visual) */
export const BRACKET_THIN_PARAMS: ShapeRebuildParams = {
  halfWidth: 0.15,
  tickHeightRatio: 0.001,
  lineWidth: 0.5,
  lineColor: TRANSPARENT,
}

/** Fat bracket params — edit-significance mode (bigger invisible hit target for dragging) */
export const BRACKET_FAT_PARAMS: ShapeRebuildParams = {
  halfWidth: 0.15,
  tickHeightRatio: 0.04,
  lineWidth: 3,
  lineColor: TRANSPARENT,
}

/**
 * Debug-only params — makes anchors visible for troubleshooting drag hit-testing.
 * Not used in production. Toggle in dev if drag feels unreliable on a platform.
 */
export const BRACKET_DEBUG_VISIBLE_PARAMS: ShapeRebuildParams = {
  halfWidth: 0.15,
  tickHeightRatio: 0.04,
  lineWidth: 3,
  lineColor: '#f59e0b',
}

function parseNums(path: string): number[] | null {
  const matches = path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
  if (!matches || matches.length < 8) return null
  const nums = matches.slice(0, 8).map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  return nums
}

export function rebuildBracketShapes(
  shapes: unknown[],
  yRange: number,
  params: ShapeRebuildParams,
): unknown[] {
  return shapes.map((shape) => {
    if (typeof shape !== 'object' || shape === null) return shape
    const s = shape as Record<string, unknown>
    const name = s.name
    if (typeof name !== 'string' || !name.startsWith('sig_bracket_')) return shape
    if (typeof s.path !== 'string') return shape

    const nums = parseNums(s.path)
    if (!nums) return shape

    // 8-number layout: M xL,tipY L xL,baseY L xR,baseY L xR,tipY
    // nums: [xL, tipY, xL, baseY, xR, baseY, xR, tipY]
    const xL   = nums[0]!
    const xR   = nums[4]!
    const baseY = nums[3]!

    const centerX   = (xL + xR) / 2
    const tickHeight = yRange * params.tickHeightRatio
    const newXL      = centerX - params.halfWidth
    const newXR      = centerX + params.halfWidth
    const newTipY    = baseY + tickHeight

    const newPath = `M ${newXL},${newTipY} L ${newXL},${baseY} L ${newXR},${baseY} L ${newXR},${newTipY}`

    const existingLine = (typeof s.line === 'object' && s.line !== null)
      ? (s.line as Record<string, unknown>)
      : {}

    return {
      ...s,
      path: newPath,
      line: { ...existingLine, width: params.lineWidth, color: params.lineColor ?? TRANSPARENT },
    }
  })
}
