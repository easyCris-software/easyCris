export type GridRect = {
  x: number
  y: number
  width: number
  height: number
}

export type GridPoint = {
  x: number
  y: number
}

export const FILL_HANDLE_CLICK_SIZE = 6
export const FILL_HANDLE_CENTER_OFFSET = 2

export function isPointInFillHandleZone(
  cellBounds: GridRect,
  localPoint: GridPoint,
  clickSize: number = FILL_HANDLE_CLICK_SIZE,
  centerOffset: number = FILL_HANDLE_CENTER_OFFSET
): boolean {
  if (cellBounds.width <= 0 || cellBounds.height <= 0) return false

  const centerX = cellBounds.x + cellBounds.width - centerOffset
  const centerY = cellBounds.y + cellBounds.height - centerOffset

  return (
    Math.abs(centerX - localPoint.x) < clickSize &&
    Math.abs(centerY - localPoint.y) < clickSize
  )
}

export function buildAutoFillDownDestination(
  patternSource: GridRect,
  lastViewRow: number
): GridRect | null {
  const sourceBottomRow = patternSource.y + patternSource.height - 1
  if (lastViewRow <= sourceBottomRow) return null

  return {
    x: patternSource.x,
    y: patternSource.y,
    width: patternSource.width,
    height: lastViewRow - patternSource.y + 1,
  }
}
