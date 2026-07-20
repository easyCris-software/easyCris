import { act, render, screen } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlotCanvas } from '../PlotCanvas'
import { usePlotsStore } from '@/store/plots-store'

vi.mock('@/utils/webgl', () => ({
  isWebGLSupported: vi.fn(() => false),
}))

vi.mock('@/services/plotExportService', () => ({
  getCachedKaleidoCapabilities: vi.fn().mockReturnValue(null),
  getKaleidoCapabilities: vi.fn(() => new Promise(() => {})),
  exportPlotWithKaleido: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
  remove: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { Temp: 'Temp' },
}))

vi.mock('@tauri-apps/api/path', () => ({
  tempDir: vi.fn().mockResolvedValue('C:/tmp'),
  join: vi.fn().mockResolvedValue('C:/tmp/plot.png'),
}))

vi.mock('@/services/tauriApi', () => ({
  default: {
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const scatterGlPlot = {
  id: 'plot-scattergl-1',
  title: 'ScatterGL Plot Validation',
  type: 'scattergl',
  statisticsFamilyId: 'statistics-1',
  sourceType: 'user_derived' as const,
  resultId: null,
  testType: null,
  testFamily: 'user_derived' as const,
  dataSnapshot: {
    columns: [],
    metadata: {
      totalRows: 150000,
      sampledRows: 100000,
      snapshotTimestamp: '2026-01-01T00:00:00.000Z',
      datasetId: 'dataset-1',
    },
  },
  facetKey: null,
  lmmMode: null,
  plotlyData: [
    { type: 'scattergl', mode: 'markers', x: [1, 2], y: [3, 4], name: 'Data' },
  ],
  plotlyConfig: {},
  dataPolicy: 'sampled' as const,
  samplingConfig: { method: 'systematic' as const, sampleSize: 100000, seed: null },
  aggregationConfig: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  plotlyLayout: {},
}

beforeEach(() => {
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: TestResizeObserver,
  })
  act(() => {
    usePlotsStore.setState({
      plots: [scatterGlPlot as never],
      activePlotId: 'plot-scattergl-1',
      computedStats: {},
    })
  })
})

afterEach(() => {
  act(() => {
    usePlotsStore.setState({ plots: [], activePlotId: null, computedStats: {} })
  })
})

describe('PlotCanvas ScatterGL WebGL fallback', () => {
  it('shows an app-owned fallback instead of mounting Plotly when WebGL is unavailable', () => {
    render(<PlotCanvas scale={1} onScaleChange={() => {}} />)

    expect(screen.getByText('ScatterGL requires WebGL')).toBeInTheDocument()
    expect(screen.getByText(/Use Scatter Plot for smaller or sampled data/i)).toBeInTheDocument()
    expect(screen.queryByText(/WebGL is not supported by your browser/i)).toBeNull()
    expect(screen.queryByTestId('plotly-lazy')).toBeNull()
  })
})
