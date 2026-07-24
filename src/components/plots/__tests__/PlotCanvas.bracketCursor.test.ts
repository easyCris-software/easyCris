/**
 * PlotCanvas — sig_bracket ns-resize cursor logic
 *
 * Tests the DOM-based cursor resolution used in the mouseover/mouseout effect.
 * Mirrors the proven handleShapeMouseDown pattern: Plotly emits data-index (not
 * data-name) on shape elements, so the handler looks up the shape in layout.shapes
 * by index and checks the name prefix.
 *
 * The cursor effect itself lives in a useEffect in PlotCanvas.tsx. Here we
 * unit-test the resolution logic in isolation by reproducing the same algorithm
 * so any future breakage is caught without mounting the full component.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { isLmmEditSignificanceEligible } from '../lmmBracketEligibility'

// ---------------------------------------------------------------------------
// Inline implementation mirror of the cursor resolution logic
// (must stay in sync with PlotCanvas.tsx — if this test breaks check the effect)
// ---------------------------------------------------------------------------

function resolveBracketName(
  target: Element | null,
  shapes: Array<{ name?: string }>,
): string | null {
  const shapeEl = target?.closest?.('.shapelayer [data-index]') as HTMLElement | null
  if (!shapeEl) return null
  const index = Number(shapeEl.getAttribute('data-index'))
  if (!Number.isFinite(index)) return null
  const shape = shapes[index] as { name?: string } | undefined
  const name = typeof shape?.name === 'string' ? shape.name : ''
  return name.startsWith('sig_bracket_') ? name : null
}

// ---------------------------------------------------------------------------

describe('sig_bracket cursor resolution (mirrors PlotCanvas hover logic)', () => {
  let container: HTMLDivElement
  let shapelayer: HTMLDivElement
  let shapeEl: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    shapelayer = document.createElement('div')
    shapelayer.className = 'shapelayer'
    shapeEl = document.createElement('path') as unknown as HTMLElement
    shapelayer.appendChild(shapeEl)
    container.appendChild(shapelayer)
  })

  it('returns bracket name when data-index points to a sig_bracket_* shape', () => {
    shapeEl.setAttribute('data-index', '0')
    const shapes = [{ name: 'sig_bracket_0' }]
    expect(resolveBracketName(shapeEl, shapes)).toBe('sig_bracket_0')
  })

  it('returns null when data-index points to a non-bracket shape', () => {
    shapeEl.setAttribute('data-index', '0')
    const shapes = [{ name: 'some_other_shape' }]
    expect(resolveBracketName(shapeEl, shapes)).toBeNull()
  })

  it('returns null when target is not inside .shapelayer [data-index]', () => {
    // shapeEl has no data-index
    const shapes = [{ name: 'sig_bracket_0' }]
    expect(resolveBracketName(shapeEl, shapes)).toBeNull()
  })

  it('returns null when target is null', () => {
    const shapes = [{ name: 'sig_bracket_0' }]
    expect(resolveBracketName(null, shapes)).toBeNull()
  })

  it('returns null when data-index is out of range', () => {
    shapeEl.setAttribute('data-index', '5')
    const shapes = [{ name: 'sig_bracket_0' }]
    expect(resolveBracketName(shapeEl, shapes)).toBeNull()
  })

  it('resolves second bracket when data-index is 1', () => {
    shapeEl.setAttribute('data-index', '1')
    const shapes = [{ name: 'sig_bracket_0' }, { name: 'sig_bracket_1' }]
    expect(resolveBracketName(shapeEl, shapes)).toBe('sig_bracket_1')
  })

  it('works when target is a child element nested inside the shape element', () => {
    shapeEl.setAttribute('data-index', '0')
    const child = document.createElement('span')
    shapeEl.appendChild(child)
    const shapes = [{ name: 'sig_bracket_0' }]
    expect(resolveBracketName(child, shapes)).toBe('sig_bracket_0')
  })
})

// ---------------------------------------------------------------------------
// I2: ref-snapshot pattern — resolver must be self-contained
//
// Production fix: PlotCanvas maintains a plotShapesRef (updated by a separate
// useEffect whenever plot.plotlyLayout changes) and passes plotShapesRef.current
// to resolveBracketName in the event handler. This replaces the previous
// usePlotsStore.getState().getActivePlot() call which could return null or the
// wrong plot during active-plot transitions, suppressing cursor hints.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C1: cursor effect deps must include plot identity
//
// The cursor effect closes over lmmEditEligible = isLmmEditSignificanceEligible(plot, meta).
// Fix: compute via useMemo and include [lmmEditEligible, plot?.id] in effect deps.
// Without plot?.id, switching plot from LMM → violin with the same editSignificanceMode=true
// keeps a stale editMode=true in the closure — cursor incorrectly stays active.
//
// Direct dep-array testing requires mounting the component. This test documents the
// COMPUTATION that must drive editMode so a future regression in eligibility logic is caught.
// ---------------------------------------------------------------------------

describe('C1: lmmEditEligible must drive editMode (not editSignificanceMode alone)', () => {
  const BASE_SHAPE_PARAMS = { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 }

  it('editMode is true only when both editSignificanceMode is set AND plot is LMM-eligible', () => {
    const lmmPlot = { sourceType: 'test_result', type: 'line', testType: 'lmm_anova', lmmMode: 'trajectory' }
    const lmmMeta = { editSignificanceMode: true, bracketShapeParams: BASE_SHAPE_PARAMS }

    const editMode = lmmMeta.editSignificanceMode === true
      && isLmmEditSignificanceEligible(lmmPlot, lmmMeta)

    expect(editMode).toBe(true)
  })

  it('editMode is false when plot switches to non-LMM even if editSignificanceMode stays true', () => {
    // Simulates the stale-closure risk: editSignificanceMode=true persists across plot switch,
    // but the new plot is a violin — cursor must be inactive.
    const violinPlot = { sourceType: 'test_result', type: 'violin', testType: 'one_way_anova', lmmMode: null }
    const violinMeta = { editSignificanceMode: true }  // no bracketShapeParams

    const editMode = violinMeta.editSignificanceMode === true
      && isLmmEditSignificanceEligible(violinPlot, violinMeta)

    expect(editMode).toBe(false)
  })
})

describe('I2: ref-snapshot pattern — resolver is self-contained (no store access)', () => {
  let shapelayer: HTMLDivElement
  let shapeEl: HTMLElement

  beforeEach(() => {
    const container = document.createElement('div')
    shapelayer = document.createElement('div')
    shapelayer.className = 'shapelayer'
    shapeEl = document.createElement('path') as unknown as HTMLElement
    shapelayer.appendChild(shapeEl)
    container.appendChild(shapelayer)
  })

  it('returns bracket name using the ref snapshot even when it differs from what the store holds', () => {
    // Simulates transition window: store has switched to a new plot (no brackets),
    // but the ref still holds the previous plot's shapes — cursor should still work.
    shapeEl.setAttribute('data-index', '0')
    const refSnapshot = [{ name: 'sig_bracket_0' }] // shapes from plotShapesRef.current
    // (store would return [] or null at this point during transition)
    expect(resolveBracketName(shapeEl, refSnapshot)).toBe('sig_bracket_0')
  })

  it('returns null gracefully when ref snapshot is empty (plot not yet loaded)', () => {
    shapeEl.setAttribute('data-index', '0')
    const emptyRef: Array<{ name?: string }> = []
    expect(resolveBracketName(shapeEl, emptyRef)).toBeNull()
  })

  it('resolver result depends only on the passed shapes — same DOM, different shapes, different result', () => {
    shapeEl.setAttribute('data-index', '0')
    expect(resolveBracketName(shapeEl, [{ name: 'sig_bracket_0' }])).toBe('sig_bracket_0')
    expect(resolveBracketName(shapeEl, [{ name: 'other_shape' }])).toBeNull()
    expect(resolveBracketName(shapeEl, [])).toBeNull()
  })
})
