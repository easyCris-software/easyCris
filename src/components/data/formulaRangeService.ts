import type { GridSelection, Item } from '@glideapps/glide-data-grid'
import {
  buildA1ReferenceFromRect,
  excludeCellFromRect,
} from '@/lib/grid/formulas/formulaEditUtils'
import { shouldDeferFormulaSelectionApply, type GridInteractionMode } from './formulaInteractionArbitration'

export type FormulaRangeGesturePhase = 'idle' | 'started' | 'updating' | 'finished' | 'cancelled'

export type FormulaRangePickSessionLike = {
  active: boolean
  isRangePickMode: boolean
  targetCell: { colIndex: number; rowIndex: number } | null
}

export type FormulaRangePickSelectionResolution =
  | {
      status: 'inactive'
      selectionForGrid: GridSelection
      previewRange: null
      shouldWarnSelfOnly: false
    }
  | {
      status: 'self_only'
      selectionForGrid: GridSelection
      previewRange: null
      shouldWarnSelfOnly: true
    }
  | {
      status: 'ready'
      selectionForGrid: GridSelection
      previewRange: { x: number; y: number; width: number; height: number }
      reference: string
      shouldWarnSelfOnly: false
    }
  | {
      status: 'no_reference'
      selectionForGrid: GridSelection
      previewRange: null
      shouldWarnSelfOnly: false
    }

export type FormulaRangePickApplyDecision =
  | { action: 'none' }
  | { action: 'preview_only' }
  | { action: 'apply_now'; reference: string }

export function transitionFormulaRangeGesturePhase(
  current: FormulaRangeGesturePhase,
  event: 'pointer_down' | 'selection_update' | 'finish' | 'cancel' | 'reset'
): FormulaRangeGesturePhase {
  switch (event) {
    case 'pointer_down':
      return 'started'
    case 'selection_update':
      if (current === 'started' || current === 'updating') return 'updating'
      return current
    case 'finish':
      return 'finished'
    case 'cancel':
      return 'cancelled'
    case 'reset':
      return 'idle'
    default:
      return current
  }
}

export function resolveFormulaRangePickSelection(
  session: FormulaRangePickSessionLike | null,
  selection: GridSelection,
  columnCount: number
): FormulaRangePickSelectionResolution {
  if (!session?.active || !session.isRangePickMode || !selection.current) {
    return {
      status: 'inactive',
      selectionForGrid: selection,
      previewRange: null,
      shouldWarnSelfOnly: false,
    }
  }

  let adjustedRect = selection.current.range
  let selectionForGrid = selection

  if (session.targetCell) {
    const exclusion = excludeCellFromRect(
      selection.current.range,
      { x: session.targetCell.colIndex, y: session.targetCell.rowIndex },
      { x: selection.current.cell[0], y: selection.current.cell[1] }
    )
    if (!exclusion.rect) {
      return {
        status: 'self_only',
        selectionForGrid: selection,
        previewRange: null,
        shouldWarnSelfOnly: true,
      }
    }

    adjustedRect = exclusion.rect
    const current = selection.current
    const adjustedRight = adjustedRect.x + adjustedRect.width - 1
    const adjustedBottom = adjustedRect.y + adjustedRect.height - 1
    const clampedCellX = Math.min(Math.max(current.cell[0], adjustedRect.x), adjustedRight)
    const clampedCellY = Math.min(Math.max(current.cell[1], adjustedRect.y), adjustedBottom)
    const nextCell: Item = [clampedCellX, clampedCellY]

    if (
      current.range.x !== adjustedRect.x ||
      current.range.y !== adjustedRect.y ||
      current.range.width !== adjustedRect.width ||
      current.range.height !== adjustedRect.height ||
      current.cell[0] !== nextCell[0] ||
      current.cell[1] !== nextCell[1]
    ) {
      selectionForGrid = {
        ...selection,
        current: {
          ...current,
          cell: nextCell,
          range: adjustedRect,
        },
      }
    }
  }

  const reference = buildA1ReferenceFromRect(adjustedRect, columnCount)
  if (!reference) {
    return {
      status: 'no_reference',
      selectionForGrid,
      previewRange: null,
      shouldWarnSelfOnly: false,
    }
  }

  return {
    status: 'ready',
    selectionForGrid,
    previewRange: adjustedRect,
    reference,
    shouldWarnSelfOnly: false,
  }
}

export function decideFormulaRangePickApply(
  resolution: FormulaRangePickSelectionResolution,
  interactionMode: GridInteractionMode,
  gesturePhase: FormulaRangeGesturePhase,
  isPointerDown: boolean
): FormulaRangePickApplyDecision {
  if (resolution.status !== 'ready') {
    return { action: 'none' }
  }

  if (shouldDeferFormulaSelectionApply(interactionMode, isPointerDown)) {
    return { action: 'preview_only' }
  }

  if (gesturePhase === 'updating' || gesturePhase === 'started') {
    return { action: 'preview_only' }
  }

  return {
    action: 'apply_now',
    reference: resolution.reference,
  }
}

