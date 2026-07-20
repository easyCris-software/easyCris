import { describe, expect, it } from 'vitest'
import type { GridSelection } from '@glideapps/glide-data-grid'
import { shouldBlockFillPattern } from '../formulaInteractionArbitration'
import {
  resolveFormulaRangePickSelection,
  decideFormulaRangePickApply,
  transitionFormulaRangeGesturePhase,
  type FormulaRangeGesturePhase,
} from '../formulaRangeService'
import { resolveFormulaOwnerUpdate } from '../formulaOwnerManager'

function makeSelection(range: { x: number; y: number; width: number; height: number }): GridSelection {
  return {
    current: {
      cell: [range.x, range.y],
      range,
      rangeStack: [],
    },
    columns: { items: [], hasIndex: () => false, hasAll: () => false, first: () => undefined, last: () => undefined, offset: () => undefined, toArray: () => [] } as any,
    rows: { items: [], hasIndex: () => false, hasAll: () => false, first: () => undefined, last: () => undefined, offset: () => undefined, toArray: () => [] } as any,
  }
}

describe('SpreadsheetView formula flow integration', () => {
  it('keeps fill blocked while formula range-pick session is active', () => {
    const blocked = shouldBlockFillPattern(true, 'formula_range_pick')
    expect(blocked).toBe(true)
  })

  it('defers reference apply through drag updates and applies on finish/cancel', () => {
    const resolved = resolveFormulaRangePickSelection(
      {
        active: true,
        isRangePickMode: true,
        targetCell: null,
      },
      makeSelection({ x: 0, y: 0, width: 1, height: 3 }),
      4
    )
    expect(resolved.status).toBe('ready')
    if (resolved.status !== 'ready') return

    let phase: FormulaRangeGesturePhase = 'idle'
    phase = transitionFormulaRangeGesturePhase(phase, 'pointer_down')
    phase = transitionFormulaRangeGesturePhase(phase, 'selection_update')
    const duringDrag = decideFormulaRangePickApply(
      resolved,
      'formula_range_pick',
      phase,
      true
    )
    expect(duringDrag.action).toBe('preview_only')

    const onFinish = decideFormulaRangePickApply(
      resolved,
      'formula_range_pick',
      transitionFormulaRangeGesturePhase(phase, 'finish'),
      false
    )
    expect(onFinish.action).toBe('apply_now')

    const onCancel = decideFormulaRangePickApply(
      resolved,
      'formula_range_pick',
      transitionFormulaRangeGesturePhase(phase, 'cancel'),
      false
    )
    expect(onCancel.action).toBe('apply_now')
  })

  it('finalizes pending drag on pointer-cancel/blur equivalent cancel phase', () => {
    const resolved = resolveFormulaRangePickSelection(
      {
        active: true,
        isRangePickMode: true,
        targetCell: null,
      },
      makeSelection({ x: 1, y: 1, width: 1, height: 2 }),
      6
    )
    expect(resolved.status).toBe('ready')
    if (resolved.status !== 'ready') return

    let phase: FormulaRangeGesturePhase = 'idle'
    phase = transitionFormulaRangeGesturePhase(phase, 'pointer_down')
    phase = transitionFormulaRangeGesturePhase(phase, 'selection_update')
    phase = transitionFormulaRangeGesturePhase(phase, 'cancel')

    const decision = decideFormulaRangePickApply(
      resolved,
      'formula_range_pick',
      phase,
      false
    )
    expect(decision.action).toBe('apply_now')
  })

  it('prevents stale cell callbacks after ownership moved to formula bar', () => {
    const movedToBar = resolveFormulaOwnerUpdate({
      previous: {
        active: true,
        mode: 'cell_range_pick',
        source: 'cell',
        version: 1,
        editorSessionId: 5,
      },
      source: 'bar',
      rangePick: true,
      editorSessionId: null,
      latestCellEditorSessionId: 5,
    })
    expect(movedToBar.accepted).toBe(true)
    if (!movedToBar.accepted) return

    const staleCellEvent = resolveFormulaOwnerUpdate({
      previous: {
        active: true,
        mode: movedToBar.mode,
        source: movedToBar.source,
        version: movedToBar.version,
        editorSessionId: movedToBar.editorSessionId,
      },
      source: 'cell',
      rangePick: true,
      editorSessionId: 4,
      latestCellEditorSessionId: movedToBar.latestCellEditorSessionId,
    })
    expect(staleCellEvent.accepted).toBe(false)
  })
})
