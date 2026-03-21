import type React from 'react'
import { act, render, screen } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlotGallery } from '../PlotGallery'
import { usePlotsStore } from '@/store/plots-store'
import { useAppStore } from '@/store/app-store'

vi.mock('@/hooks/useViewportMode', () => ({
  useViewportMode: () => ({
    mode: 'full',
    isFull: true,
    isNotFull: false,
    isCompact: false,
    isConstrained: false,
  }),
}))

vi.mock('../PlotThumbnail', () => ({
  PlotThumbnail: ({ plot, density }: { plot: { title: string }; density?: string }) => (
    <div data-testid="plot-thumbnail" data-density={density ?? 'wide'}>
      {plot.title}
    </div>
  ),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  private callback: ResizeObserverCallback
  private target: Element | null = null

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.target = target
  }

  unobserve() {}

  disconnect() {}

  trigger(width: number, height: number = 400) {
    if (!this.target) return
    this.callback(
      [
        {
          target: this.target,
          contentRect: {
            width,
            height,
            x: 0,
            y: 0,
            top: 0,
            right: width,
            bottom: height,
            left: 0,
            toJSON: () => ({}),
          },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    )
  }
}

const basePlot = {
  type: 'interaction_plot',
  statisticsFamilyId: 'statistics-1',
  plotlyData: [],
  plotlyLayout: {},
  plotlyConfig: {},
  dataPolicy: 'aggregated',
  samplingConfig: null,
  aggregationConfig: null,
  sourceType: 'test_result',
  resultId: 'result-1',
  testType: 'two_way_anova',
  testFamily: 'parametric',
  dataSnapshot: null,
} as const

describe('PlotGallery responsive layout', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  beforeEach(() => {
    FakeResizeObserver.instances = []
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    act(() => {
      usePlotsStore.setState({
        plots: [
          {
            ...basePlot,
            id: 'plot-1',
            title: 'Interaction Plot',
            createdAt: '2026-03-07T12:00:00.000Z',
            updatedAt: '2026-03-07T12:00:00.000Z',
          },
          {
            ...basePlot,
            id: 'plot-2',
            title: 'Cell Means',
            createdAt: '2026-03-07T12:05:00.000Z',
            updatedAt: '2026-03-07T12:05:00.000Z',
          },
        ] as never,
        activePlotId: 'plot-1',
      })
      useAppStore.setState({ activeFamilyId: 'statistics-1' })
    })
  })

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
    act(() => {
      usePlotsStore.setState({ plots: [], activePlotId: null })
    })
  })

  it('does not default to wide density before resize observation and stays single-column when narrow', () => {
    const { container } = render(<PlotGallery />)

    const grid = container.querySelector('.grid')
    expect(grid).toBeTruthy()
    expect(grid?.className).toContain('grid-cols-1')
    expect(screen.getAllByTestId('plot-thumbnail')[0]).toHaveAttribute('data-density', 'compact')

    act(() => {
      FakeResizeObserver.instances[0]?.trigger(180)
    })

    expect(grid?.className).toContain('grid-cols-1')
    expect(screen.getAllByTestId('plot-thumbnail')[0]).toHaveAttribute('data-density', 'compact')
  })
})
