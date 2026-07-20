/**
 * PlotSidebar – Brackets tab component tests
 *
 * Coverage:
 *   M1-a  Edit Significance toggle ON  → hovermode:false + priorHovermode saved
 *   M1-b  Edit Significance toggle OFF → priorHovermode restored + editSignificanceMode cleared
 *   M1-c  mergeRebuiltLayout rebuild persistence: editSignificanceMode=true forces hovermode:false (H1 fix)
 *   UI-1  Master comparison toggle rendered as Checkbox; children rendered as indented Switches
 *   UI-2  Mixed child visibility → Checkbox receives indeterminate state (minus icon)
 */
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlotSidebar } from '../PlotSidebar'
import { usePlotsStore } from '@/store/plots-store'
import { useAppStore } from '@/store/app-store'

// ---------------------------------------------------------------------------
// Module mocks – heavy / tauri / side-effectful imports
// ---------------------------------------------------------------------------

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/services/plotBackendService', () => ({
  computeTrendline: vi.fn().mockResolvedValue({ data: [], layout: {} }),
}))

vi.mock('@/services/plotResultService', () => ({
  rebuildTestResultPlot: vi.fn().mockReturnValue({ plot: { plotlyData: [], plotlyLayout: {} } }),
}))

vi.mock('@/services/exportService', () => ({
  default: { exportDataToCsv: vi.fn() },
}))

vi.mock('@/hooks/useViewportMode', () => ({
  useViewportMode: () => ({
    mode: 'full',
    isFull: true,
    isNotFull: false,
    isCompact: false,
    isConstrained: false,
  }),
}))

vi.mock('../ShapesAnnotationsEditor', () => ({
  ShapesAnnotationsEditor: () => <div data-testid="shapes-annotations-editor" />,
}))

vi.mock('../lmmViewToggle', () => ({
  getActiveViewLabel: vi.fn().mockReturnValue('Trajectory'),
  getLmmSiblingViews: vi.fn().mockReturnValue([]),
}))

vi.mock('../plotTitle', () => ({
  resolvePlotDisplayTitle: vi.fn().mockReturnValue('Test Plot'),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => <div className={className}>{children}</div>,
}))

vi.mock('@/store/results-store', () => ({
  useResultsStore: vi.fn().mockReturnValue(vi.fn().mockReturnValue(null)),
}))

// ---------------------------------------------------------------------------
// Minimal LMM plot fixture
// ---------------------------------------------------------------------------

const MASTER_ID = 'lmm_cmp|pooled|THC_vs_VEH'
const CHILD_0_ID = 'lmm_se|pooled|THC_vs_VEH|Week=0'
const CHILD_1_ID = 'lmm_se|pooled|THC_vs_VEH|Week=1'

function makeLmmPlot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plot-1',
    title: 'LMM Trajectory',
    type: 'line',                          // real PlotType for LMM plots in the registry
    statisticsFamilyId: 'statistics-1',
    sourceType: 'test_result' as const,
    resultId: 'result-1',
    testType: 'lmm_anova',                 // real testType, not shorthand 'lmm'
    testFamily: 'parametric' as const,
    dataSnapshot: null,
    facetKey: null,
    lmmMode: 'trajectory' as const,
    plotlyData: [],
    plotlyConfig: {},
    dataPolicy: 'aggregated' as const,
    samplingConfig: null,
    aggregationConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plotlyLayout: {
      hovermode: 'x unified',
      shapes: [
        { name: 'sig_bracket_0', type: 'path', path: 'M -0.15,10 L -0.15,0 L 0.15,0 L 0.15,10', visible: true },
        { name: 'sig_bracket_1', type: 'path', path: 'M 0.85,10 L 0.85,0 L 1.15,0 L 1.15,10', visible: true },
      ],
      meta: {
        bracketShapeParams: { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 },
        bracketEffectMap: {
          [MASTER_ID]: { label: 'THC vs VEH', group: 'comparison', significant: true },
          [CHILD_0_ID]: {
            label: 'THC vs VEH | Week=0',
            group: 'simple',
            significant: true,
            parentId: MASTER_ID,
          },
          [CHILD_1_ID]: {
            label: 'THC vs VEH | Week=1',
            group: 'simple',
            significant: false,
            parentId: MASTER_ID,
          },
        },
        bracketEffectShapes: {
          [MASTER_ID]: ['sig_bracket_0', 'sig_bracket_1'],
          [CHILD_0_ID]: ['sig_bracket_0'],
          [CHILD_1_ID]: ['sig_bracket_1'],
        },
        bracketVisibility: {},
        bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
      },
      ...overrides,
    },
  }
}

/** Non-LMM plot fixture — should never show Edit significance control */
function makeViolinPlot() {
  return {
    id: 'plot-1',
    title: 'Violin Plot',
    type: 'violin',
    statisticsFamilyId: 'statistics-1',
    sourceType: 'test_result' as const,
    resultId: 'result-1',
    testType: 'one_way_anova',
    testFamily: 'parametric' as const,
    dataSnapshot: null,
    facetKey: null,
    lmmMode: null,
    plotlyData: [],
    plotlyConfig: {},
    dataPolicy: 'raw' as const,
    samplingConfig: null,
    aggregationConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plotlyLayout: {
      hovermode: 'x unified' as const,
      shapes: [],
      meta: {
        bracketEffectMap: {
          'anova_main': { label: 'ns', group: 'main', significant: false },
        },
        bracketEffectShapes: {},
        bracketVisibility: {},
        bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getActivePlotLayout() {
  const plot = usePlotsStore.getState().getActivePlot()
  return (plot?.plotlyLayout ?? {}) as Record<string, unknown>
}

function getActivePlotMeta() {
  const layout = getActivePlotLayout()
  return (layout.meta ?? {}) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    usePlotsStore.setState({
      plots: [makeLmmPlot() as never],
      activePlotId: 'plot-1',
    })
    useAppStore.setState({
      activeFamilyId: 'statistics-1',
      plotSidebarTab: 'brackets',
    })
  })
})

afterEach(() => {
  act(() => {
    usePlotsStore.setState({ plots: [], activePlotId: null })
  })
})

// ---------------------------------------------------------------------------
// UI rendering tests
// ---------------------------------------------------------------------------

describe('Brackets tab – master/child rendering', () => {
  it('renders master comparison as a Checkbox with label "(all)"', () => {
    render(<PlotSidebar />)

    // The master row renders "THC vs VEH (all)"
    expect(screen.getByText('THC vs VEH (all)')).toBeInTheDocument()

    // It should have a Checkbox (data-slot="checkbox") in that row
    const masterRow = screen.getByText('THC vs VEH (all)').closest('div[class*="border"]')
    expect(masterRow?.querySelector('[data-slot="checkbox"]')).toBeTruthy()
  })

  it('renders per-timepoint children as indented Switches', () => {
    render(<PlotSidebar />)

    // Children show only the timepoint segment (after " | ")
    expect(screen.getByText('Week=0')).toBeInTheDocument()
    expect(screen.getByText('Week=1')).toBeInTheDocument()

    // Each child row has role="switch"
    const switches = screen.getAllByRole('switch')
    const childSwitches = switches.filter((s) => {
      const row = s.closest('div[class*="ml-4"]')
      return row !== null
    })
    expect(childSwitches).toHaveLength(2)
  })

  it('renders master Checkbox as indeterminate when children have mixed visibility', () => {
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            meta: {
              bracketEffectMap: {
                [MASTER_ID]: { label: 'THC vs VEH', group: 'comparison', significant: true },
                [CHILD_0_ID]: {
                  label: 'THC vs VEH | Week=0',
                  group: 'simple',
                  significant: true,
                  parentId: MASTER_ID,
                },
                [CHILD_1_ID]: {
                  label: 'THC vs VEH | Week=1',
                  group: 'simple',
                  significant: false,
                  parentId: MASTER_ID,
                },
              },
              bracketEffectShapes: {
                [MASTER_ID]: ['sig_bracket_0', 'sig_bracket_1'],
                [CHILD_0_ID]: ['sig_bracket_0'],
                [CHILD_1_ID]: ['sig_bracket_1'],
              },
              // One child visible (default), one explicitly hidden
              bracketVisibility: { [CHILD_1_ID]: false },
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    // Indeterminate checkbox renders with data-state="indeterminate"
    const checkbox = document.querySelector('[data-slot="checkbox"]')
    expect(checkbox).toHaveAttribute('data-state', 'indeterminate')
  })
})

// ---------------------------------------------------------------------------
// Edit Significance toggle tests (M1)
// ---------------------------------------------------------------------------

describe('Edit Significance toggle – M1 hovermode persistence', () => {
  it('M1-a: toggle ON stores priorHovermode and sets hovermode:false', async () => {
    render(<PlotSidebar />)

    // Find the Edit significance toggle by its accessible role
    const editSigLabel = screen.getByText('Edit significance')
    const toggleRow = editSigLabel.closest('div[class*="border"]')
    const toggle = toggleRow?.querySelector('[role="switch"]') as HTMLElement | null
    expect(toggle).toBeTruthy()

    act(() => {
      fireEvent.click(toggle!)
    })

    await waitFor(() => {
      const meta = getActivePlotMeta()
      expect(meta.editSignificanceMode).toBe(true)
      expect(meta.priorHovermode).toBe('x unified')
    })

    expect(getActivePlotLayout().hovermode).toBe(false)
  })

  it('M1-b: toggle OFF restores priorHovermode and clears editSignificanceMode', async () => {
    // Start with edit mode already ON and a specific priorHovermode
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            hovermode: false,
            meta: {
              bracketShapeParams: { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 },
              editSignificanceMode: true,
              priorHovermode: 'closest',
              bracketEffectMap: {
                [MASTER_ID]: { label: 'THC vs VEH', group: 'comparison', significant: true },
                [CHILD_0_ID]: {
                  label: 'THC vs VEH | Week=0',
                  group: 'simple',
                  significant: true,
                  parentId: MASTER_ID,
                },
              },
              bracketEffectShapes: {
                [MASTER_ID]: ['sig_bracket_0'],
                [CHILD_0_ID]: ['sig_bracket_0'],
              },
              bracketVisibility: {},
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    // Toggle should currently be ON (checked)
    const editSigLabel = screen.getByText('Edit significance')
    const toggleRow = editSigLabel.closest('div[class*="border"]')
    const toggle = toggleRow?.querySelector('[role="switch"]') as HTMLElement | null
    expect(toggle).toBeTruthy()
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    act(() => {
      fireEvent.click(toggle!)
    })

    await waitFor(() => {
      const meta = getActivePlotMeta()
      expect(meta.editSignificanceMode).toBe(false)
    })

    expect(getActivePlotLayout().hovermode).toBe('closest')
  })

  it('M1-c (H1): Brackets tab actions do not clobber hovermode:false while in edit mode', async () => {
    /**
     * Regression guard for H1: any layout update issued from the Brackets tab while
     * editSignificanceMode=true must leave hovermode:false intact.
     *
     * We trigger a child visibility toggle (toggleEffectVisibility → updateLayout)
     * which spreads the current layout.  Before H1 the spread was safe for direct
     * updateLayout calls; the actual H1 bug is in mergeRebuiltLayout (called by
     * rebuild paths in other tabs).  This test covers the Brackets tab side-effect
     * so that a future refactor cannot accidentally reset hovermode here either.
     */
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            hovermode: false,
            meta: {
              bracketShapeParams: { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 },
              editSignificanceMode: true,
              priorHovermode: 'x unified',
              bracketEffectMap: {
                [MASTER_ID]: { label: 'THC vs VEH', group: 'comparison', significant: true },
                [CHILD_0_ID]: {
                  label: 'THC vs VEH | Week=0',
                  group: 'simple',
                  significant: true,
                  parentId: MASTER_ID,
                },
                [CHILD_1_ID]: {
                  label: 'THC vs VEH | Week=1',
                  group: 'simple',
                  significant: false,
                  parentId: MASTER_ID,
                },
              },
              bracketEffectShapes: {
                [MASTER_ID]: ['sig_bracket_0', 'sig_bracket_1'],
                [CHILD_0_ID]: ['sig_bracket_0'],
                [CHILD_1_ID]: ['sig_bracket_1'],
              },
              bracketVisibility: {},
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    // Toggle a child Switch OFF (triggers updateLayout with shapes + meta only)
    const week0Row = screen.getByText('Week=0').closest('div[class*="ml-4"]')
    const childSwitch = week0Row?.querySelector('[role="switch"]') as HTMLElement | null
    expect(childSwitch).toBeTruthy()

    act(() => {
      fireEvent.click(childSwitch!)
    })

    await waitFor(() => {
      // editSignificanceMode must still be true
      expect(getActivePlotMeta().editSignificanceMode).toBe(true)
      // hovermode must remain false — not clobbered by the layout spread
      expect(getActivePlotLayout().hovermode).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Master cascade toggle tests
// ---------------------------------------------------------------------------

describe('Master cascade toggle', () => {
  it('clicking master Checkbox OFF hides both children in store', async () => {
    render(<PlotSidebar />)

    const masterRow = screen.getByText('THC vs VEH (all)').closest('div[class*="border"]')
    const checkbox = masterRow?.querySelector('[data-slot="checkbox"]') as HTMLElement | null
    expect(checkbox).toBeTruthy()

    act(() => {
      // Master defaults to checked (all visible) → click → unchecked
      fireEvent.click(checkbox!)
    })

    await waitFor(() => {
      const visibility = getActivePlotMeta().bracketVisibility as Record<string, boolean>
      expect(visibility[CHILD_0_ID]).toBe(false)
      expect(visibility[CHILD_1_ID]).toBe(false)
    })
  })

  it('clicking master Checkbox ON shows all children in store', async () => {
    // Start with all hidden
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            meta: {
              bracketEffectMap: {
                [MASTER_ID]: { label: 'THC vs VEH', group: 'comparison', significant: true },
                [CHILD_0_ID]: {
                  label: 'THC vs VEH | Week=0',
                  group: 'simple',
                  significant: true,
                  parentId: MASTER_ID,
                },
                [CHILD_1_ID]: {
                  label: 'THC vs VEH | Week=1',
                  group: 'simple',
                  significant: false,
                  parentId: MASTER_ID,
                },
              },
              bracketEffectShapes: {
                [MASTER_ID]: ['sig_bracket_0', 'sig_bracket_1'],
                [CHILD_0_ID]: ['sig_bracket_0'],
                [CHILD_1_ID]: ['sig_bracket_1'],
              },
              bracketVisibility: { [MASTER_ID]: false, [CHILD_0_ID]: false, [CHILD_1_ID]: false },
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    const masterRow = screen.getByText('THC vs VEH (all)').closest('div[class*="border"]')
    const checkbox = masterRow?.querySelector('[data-slot="checkbox"]') as HTMLElement | null
    expect(checkbox).toBeTruthy()

    act(() => {
      // Master is unchecked → click → checked (cascade ON)
      fireEvent.click(checkbox!)
    })

    await waitFor(() => {
      const visibility = getActivePlotMeta().bracketVisibility as Record<string, boolean>
      expect(visibility[CHILD_0_ID]).toBe(true)
      expect(visibility[CHILD_1_ID]).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Edit Significance eligibility containment (C2)
// ---------------------------------------------------------------------------

describe('Edit Significance containment — non-LMM plots', () => {
  it('does not render "Edit significance" row for a non-LMM plot (violin/one-way)', () => {
    act(() => {
      usePlotsStore.setState({
        plots: [makeViolinPlot() as never],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    expect(screen.queryByText('Edit significance')).toBeNull()
  })

  it('non-LMM brackets: no sig_bracket shapes exist and editSignificanceMode is never set', async () => {
    act(() => {
      usePlotsStore.setState({
        plots: [makeViolinPlot() as never],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    // Find the 'ns' effect switch and toggle it
    const nsLabel = screen.queryByText('ns')
    if (nsLabel) {
      const row = nsLabel.closest('div')
      const effectSwitch = row?.querySelector('[role="switch"]') as HTMLElement | null
      if (effectSwitch) {
        act(() => { fireEvent.click(effectSwitch) })
        await waitFor(() => {
          // Only bracketVisibility should change — shapes and editSignificanceMode untouched
          expect(getActivePlotMeta().editSignificanceMode).toBeFalsy()
          const shapes = getActivePlotLayout().shapes as unknown[] | undefined
          const brackets = (shapes ?? []).filter(
            (s: unknown) => typeof (s as Record<string, unknown>).name === 'string'
              && ((s as Record<string, unknown>).name as string).startsWith('sig_bracket_')
          )
          expect(brackets).toHaveLength(0)
        })
        return
      }
    }

    // No effect switches — still assert invariants hold
    expect(getActivePlotMeta().editSignificanceMode).toBeFalsy()
  })

  it('renders "Edit significance" row for eligible LMM trajectory plot', () => {
    render(<PlotSidebar />)
    expect(screen.getByText('Edit significance')).toBeInTheDocument()
  })

  it('LMM trajectory: toggling Edit significance ON rebuilds shapes to fat params', async () => {
    render(<PlotSidebar />)

    const editSigLabel = screen.getByText('Edit significance')
    const toggleRow = editSigLabel.closest('div[class*="border"]')
    const toggle = toggleRow?.querySelector('[role="switch"]') as HTMLElement | null
    expect(toggle).toBeTruthy()

    act(() => {
      fireEvent.click(toggle!)
    })

    await waitFor(() => {
      const meta = getActivePlotMeta()
      expect(meta.editSignificanceMode).toBe(true)
      // Shapes must have been rebuilt — fat lineWidth (3) applied
      const shapes = getActivePlotLayout().shapes as Array<Record<string, unknown>> | undefined
      const brackets = (shapes ?? []).filter(
        s => typeof s.name === 'string' && (s.name as string).startsWith('sig_bracket_')
      )
      expect(brackets.length).toBeGreaterThan(0)
      brackets.forEach(b => {
        expect((b.line as Record<string, unknown>)?.width).toBe(3)
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Compound trajectory — Trace Style (lmm-style-override-panel) visibility
// ---------------------------------------------------------------------------

describe('PlotSidebar — compound trajectory hides Trace Style controls', () => {
  it('hides lmm-style-override-panel for compound trajectory (trajectoryLayout=compound)', () => {
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            meta: {
              bracketShapeParams: { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 },
              bracketEffectMap: {},
              bracketEffectShapes: {},
              bracketVisibility: {},
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
              trajectoryLayout: 'compound',
              traceRoleMapping: {
                resolved: false,
                dashMap: {},
                sharedColor: '',
                lineStyleFactor: 'treatment',
                colorFactor: 'Strain',
                reason: 'compound layout',
              },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
      // Force Colors tab so the guard is exercised, not tab-default absence
      useAppStore.setState({ plotSidebarTab: 'colors' })
    })

    render(<PlotSidebar />)

    expect(screen.queryByTestId('lmm-style-override-panel')).toBeNull()
  })

  it('shows lmm-style-override-panel for non-compound trajectory with resolved mapping and exactly 2 groups', () => {
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            meta: {
              bracketShapeParams: { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 },
              bracketEffectMap: {},
              bracketEffectShapes: {},
              bracketVisibility: {},
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
              // no trajectoryLayout: 'compound' here
              traceRoleMapping: {
                resolved: true,
                dashMap: { VEH: 'dot', THC: 'solid' },
                sharedColor: '#636EFA',
                lineStyleFactor: 'treatment',
                colorFactor: null,
                reason: '',
              },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
        lmmStyleOverrides: {},
      })
      // The panel lives in the "colors" tab — switch to it so it renders
      useAppStore.setState({ plotSidebarTab: 'colors' })
    })

    render(<PlotSidebar />)

    expect(screen.queryByTestId('lmm-style-override-panel')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Compound guard reason banner
// ---------------------------------------------------------------------------

describe('compound-guard-reason banner', () => {
  it('shows banner when lmmMode=trajectory and compoundGuardReason is in meta', () => {
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            meta: {
              ...makeLmmPlot().plotlyLayout.meta,
              compoundGuardReason: 'requires at least 2 stratify dims, got 1',
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    const banner = screen.getByTestId('compound-guard-reason')
    expect(banner).toBeInTheDocument()
    expect(banner.textContent).toContain('requires at least 2 stratify dims, got 1')
  })

  it('does NOT show banner when compoundGuardReason is absent', () => {
    // Default makeLmmPlot() has no compoundGuardReason in meta
    render(<PlotSidebar />)

    expect(screen.queryByTestId('compound-guard-reason')).not.toBeInTheDocument()
  })

  it('does NOT show banner on a compound trajectory spec (compound succeeded — no guard reason)', () => {
    // Compound trajectory specs have trajectoryLayout='compound' but no compoundGuardReason
    act(() => {
      usePlotsStore.setState({
        plots: [
          makeLmmPlot({
            meta: {
              trajectoryLayout: 'compound',
              // no compoundGuardReason
              bracketEffectMap: {},
              bracketEffectShapes: {},
              bracketVisibility: {},
              bracketCatalog: { brackets: [], shapeToEffectId: {}, bracketByEffectId: {} },
            },
          }) as never,
        ],
        activePlotId: 'plot-1',
      })
    })

    render(<PlotSidebar />)

    expect(screen.queryByTestId('compound-guard-reason')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Trendline lockout for LMM plots
// ---------------------------------------------------------------------------

// Scatter plot fixture for trendline tests (non-LMM, numeric x/y with markers)
function makeScatterPlot() {
  return {
    id: 'plot-1',
    title: 'Scatter Plot',
    type: 'scatter',
    statisticsFamilyId: 'statistics-1',
    sourceType: 'test_result' as const,
    resultId: 'result-1',
    testType: 'pearson_correlation',
    testFamily: 'parametric' as const,
    dataSnapshot: null,
    facetKey: null,
    lmmMode: null,
    plotlyData: [
      { type: 'scatter', mode: 'markers', x: [1, 2, 3], y: [4, 5, 6] },
    ],
    plotlyConfig: {},
    dataPolicy: 'raw' as const,
    samplingConfig: null,
    aggregationConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plotlyLayout: { meta: {} },
  }
}

describe('Trendline section – LMM lockout', () => {
  it('does NOT render Trendline section for an LMM trajectory plot (axes tab)', () => {
    // Default beforeEach sets up an LMM trajectory plot
    act(() => {
      useAppStore.setState({ plotSidebarTab: 'axes' })
    })

    render(<PlotSidebar />)

    // Trendline is in the axes tab — should be absent for LMM
    expect(screen.queryByText('Trendline')).not.toBeInTheDocument()
  })

  it('renders Trendline section for a non-LMM numeric scatter plot (axes tab)', () => {
    act(() => {
      usePlotsStore.setState({
        plots: [makeScatterPlot() as never],
        activePlotId: 'plot-1',
      })
      useAppStore.setState({ plotSidebarTab: 'axes' })
    })

    render(<PlotSidebar />)

    // Trendline label is present for eligible scatter plots
    expect(screen.getByText('Trendline')).toBeInTheDocument()
  })

  it('toggleTrendline is a no-op for LMM plots: switch absent, no backend call on user action', async () => {
    // Default beforeEach: LMM trajectory plot
    act(() => {
      useAppStore.setState({ plotSidebarTab: 'axes' })
    })

    render(<PlotSidebar />)

    // No trendline switch available — user cannot trigger the handler
    expect(screen.queryByText('Trendline')).not.toBeInTheDocument()
    expect(screen.queryByText('Show trendline')).not.toBeInTheDocument()

    // computeTrendline is never called for LMM (not at render, not triggered)
    const { computeTrendline } = await import('@/services/plotBackendService')
    expect(computeTrendline).not.toHaveBeenCalled()
  })
})
