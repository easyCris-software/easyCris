import { describe, expect, it } from 'vitest'
import { resolveFormulaOwnerUpdate } from '../formulaOwnerManager'

describe('formulaOwnerManager', () => {
  it('rejects stale cell callbacks by editor session id', () => {
    const result = resolveFormulaOwnerUpdate({
      previous: {
        active: true,
        mode: 'cell_edit',
        source: 'cell',
        version: 3,
        editorSessionId: 4,
      },
      source: 'cell',
      rangePick: false,
      editorSessionId: 3,
      latestCellEditorSessionId: 4,
    })

    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reason).toBe('stale_cell_callback')
    }
  })

  it('recovers deterministically from rejected cross-owner transition', () => {
    const result = resolveFormulaOwnerUpdate({
      previous: {
        active: true,
        mode: 'cell_range_pick',
        source: 'cell',
        version: 1,
        editorSessionId: 8,
      },
      source: 'bar',
      rangePick: true,
      editorSessionId: null,
      latestCellEditorSessionId: 8,
    })

    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(result.source).toBe('bar')
      expect(result.mode).toBe('bar_range_pick')
      expect(result.recovered).toBe(true)
      expect(result.version).toBe(2)
    }
  })

  it('accepts first bar->cell handoff when no prior cell session id exists', () => {
    const result = resolveFormulaOwnerUpdate({
      previous: {
        active: true,
        mode: 'bar_edit',
        source: 'bar',
        version: 6,
        editorSessionId: null,
      },
      source: 'cell',
      rangePick: false,
      editorSessionId: null,
      latestCellEditorSessionId: null,
    })

    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(result.source).toBe('cell')
      expect(result.mode).toBe('cell_edit')
    }
  })

  it('rejects bar->cell callback without id when a prior cell session id exists', () => {
    const result = resolveFormulaOwnerUpdate({
      previous: {
        active: true,
        mode: 'bar_edit',
        source: 'bar',
        version: 6,
        editorSessionId: null,
      },
      source: 'cell',
      rangePick: false,
      editorSessionId: null,
      latestCellEditorSessionId: 4,
    })

    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reason).toBe('stale_cross_owner_callback')
    }
  })
})
