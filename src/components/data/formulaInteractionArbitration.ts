export type GridInteractionMode = 'normal' | 'formula_range_pick' | 'fill_drag'

export type FormulaSessionStateLike = {
  active: boolean
  isRangePickMode: boolean
} | null

export function deriveInteractionModeFromSession(
  session: FormulaSessionStateLike,
  currentMode: GridInteractionMode
): GridInteractionMode {
  if (currentMode === 'fill_drag') {
    return currentMode
  }
  if (session?.active && session.isRangePickMode) {
    return 'formula_range_pick'
  }
  return 'normal'
}

export function resolveModeAfterFill(session: FormulaSessionStateLike): GridInteractionMode {
  if (session?.active && session.isRangePickMode) {
    return 'formula_range_pick'
  }
  return 'normal'
}

export function shouldEnableFillHandle(hasActiveFormulaSession: boolean): boolean {
  return !hasActiveFormulaSession
}

export function shouldProcessFormulaSelection(mode: GridInteractionMode): boolean {
  return mode !== 'fill_drag'
}

export function shouldDeferFormulaSelectionApply(
  mode: GridInteractionMode,
  isPointerDown: boolean
): boolean {
  return mode === 'formula_range_pick' && isPointerDown
}

export function shouldBlockFillPattern(
  hasActiveFormulaSession: boolean,
  mode: GridInteractionMode
): boolean {
  return hasActiveFormulaSession || mode === 'formula_range_pick'
}
