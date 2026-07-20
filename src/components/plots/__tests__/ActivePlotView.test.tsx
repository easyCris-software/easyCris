/**
 * ActivePlotView — topbar controls
 *
 * Verifies that the lmm-swap-styles-topbar button has been removed.
 */
import React from 'react'
import { act, render, screen } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivePlotView } from '../ActivePlotView'
import { usePlotsStore } from '@/store/plots-store'

// ---------------------------------------------------------------------------
// Module mocks — heavy / tauri / side-effectful imports
// ---------------------------------------------------------------------------

vi.mock('@/components/plotly/PlotlyLazy', () => ({
  default: () => <div data-testid="plotly-lazy" />,
}))

vi.mock('@/services/plotExportService', () => ({
  getCachedKaleidoCapabilities: vi.fn().mockReturnValue(null),
  getKaleidoCapabilities: vi.fn().mockResolvedValue({ tiff: { supported: true } }),
  exportPlotWithKaleido: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/tauriApi', () => ({
  default: {
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <span>{children}</span>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../plotTitle', () => ({
  resolvePlotDisplayTitle: vi.fn().mockReturnValue('Test Plot'),
}))

// ---------------------------------------------------------------------------
// Minimal LMM trajectory plot fixture (eligible for swap in old code)
// ---------------------------------------------------------------------------

function makeLmmTrajectoryPlot() {
  return {
    id: 'plot-lmm-1',
    title: 'LMM Trajectory',
    type: 'line',
    statisticsFamilyId: 'statistics-1',
    sourceType: 'test_result' as const,
    resultId: 'result-1',
    testType: 'lmm_anova',
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
      meta: {
        traceRoleMapping: {
          resolved: true,
          dashMap: { VEH: 'dot', THC: 'solid' },
          sharedColor: '#636EFA',
          lineStyleFactor: 'treatment',
          colorFactor: null,
          reason: '',
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    usePlotsStore.setState({
      plots: [makeLmmTrajectoryPlot() as never],
      activePlotId: 'plot-lmm-1',
    })
  })
})

afterEach(() => {
  act(() => {
    usePlotsStore.setState({ plots: [], activePlotId: null })
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivePlotView — topbar swap button removed', () => {
  it('does not render lmm-swap-styles-topbar button for an LMM trajectory plot', () => {
    render(<ActivePlotView />)
    expect(screen.queryByTestId('lmm-swap-styles-topbar')).toBeNull()
  })

  it('does not render lmm-swap-styles-topbar button when no plot is active', () => {
    act(() => {
      usePlotsStore.setState({ plots: [], activePlotId: null })
    })
    // Render with no plot — shows empty state
    render(<ActivePlotView />)
    expect(screen.queryByTestId('lmm-swap-styles-topbar')).toBeNull()
  })
})
