import { describe, expect, it } from 'vitest'
import type { GridSelection } from '@glideapps/glide-data-grid'
import {
  decideFormulaRangePickApply,
  resolveFormulaRangePickSelection,
  transitionFormulaRangeGesturePhase,
} from '../formulaRangeService'

function selectionOf(
  x: number,
  y: number,
  width: number,
  height: number
): GridSelection {
  return {
    current: {
      cell: [x, y],
      range: { x, y, width, height },
      rangeStack: [],
    },
    columns: { items: [], hasIndex: () => false, hasAll: () => false, first: () => undefined, last: () => undefined, offset: () => undefined, toArray: () => [] } as any,
    rows: { items: [], hasIndex: () => false, hasAll: () => false, first: () => undefined, last: () => undefined, offset: () => undefined, toArray: () => [] } as any,
  }
}

describe('formulaRangeService', () => {
  it('adjusts range selection to exclude formula target cell', () => {
    const result = resolveFormulaRangePickSelection(
      {
        active: true,
        isRangePickMode: true,
        targetCell: { colIndex: 0, rowIndex: 0 },
      },
      selectionOf(0, 0, 1, 10),
      4
    )

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.reference).toBe('A2:A10')
      expect(result.previewRange).toEqual({ x: 0, y: 1, width: 1, height: 9 })
    }
  })

  it('defers apply during gesture update and finalizes after finish', () => {
    const ready = resolveFormulaRangePickSelection(
      {
        active: true,
        isRangePickMode: true,
        targetCell: null,
      },
      selectionOf(0, 0, 1, 5),
      4
    )
    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') return

    let phase = transitionFormulaRangeGesturePhase('idle', 'pointer_down')
    phase = transitionFormulaRangeGesturePhase(phase, 'selection_update')

    const previewDecision = decideFormulaRangePickApply(
      ready,
      'formula_range_pick',
      phase,
      true
    )
    expect(previewDecision.action).toBe('preview_only')

    phase = transitionFormulaRangeGesturePhase(phase, 'finish')
    const applyDecision = decideFormulaRangePickApply(
      ready,
      'formula_range_pick',
      phase,
      false
    )
    expect(applyDecision.action).toBe('apply_now')
  })
})

