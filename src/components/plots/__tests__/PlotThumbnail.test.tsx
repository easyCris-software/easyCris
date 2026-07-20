import { render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { PlotThumbnail } from '../PlotThumbnail'

vi.mock('@/components/plotly/PlotlyLazy', () => ({
  default: () => <div data-testid="plotly-thumbnail" />,
}))

const plot = {
  id: 'plot-1',
  type: 'interaction_plot',
  title: 'Interaction Plot',
  statisticsFamilyId: 'statistics-1',
  plotlyData: [],
  plotlyLayout: {},
  plotlyConfig: {},
  dataPolicy: 'aggregated',
  samplingConfig: null,
  aggregationConfig: null,
  createdAt: '2026-03-07T12:00:00.000Z',
  updatedAt: '2026-03-07T12:00:00.000Z',
  sourceType: 'test_result',
  resultId: 'result-1',
  testType: 'two_way_anova',
  testFamily: 'parametric',
  dataSnapshot: null,
} as const

describe('PlotThumbnail density modes', () => {
  it('keeps the plot type visible in narrow mode while keeping the title visible', () => {
    render(
      <PlotThumbnail
        plot={plot as never}
        isActive={false}
        onClick={() => {}}
        {...({ density: 'narrow' } as Record<string, unknown>)}
      />
    )

    expect(screen.getByText('Interaction Plot')).toBeInTheDocument()
    expect(screen.getByText('two way anova')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Patch 2 — density-based aspect ratios + tighter metadata padding
//
// Card footprint is dominated by the thumbnail (aspect-square = card-width tall).
// Switching to shorter ratios for compact/narrow cuts ~40-60px per card.
// Title bar padding is also tightened for compact/narrow.
// ---------------------------------------------------------------------------

describe('PlotThumbnail density — thumbnail aspect ratio', () => {
  it('wide density → thumbnail keeps aspect-square', () => {
    const { container } = render(
      <PlotThumbnail plot={plot as never} isActive={false} onClick={() => {}} density="wide" />
    )
    const preview = container.querySelector('.overflow-hidden') as HTMLElement
    const classes = preview.className.split(' ')
    expect(classes).toContain('aspect-square')
  })

  it('compact density → thumbnail uses aspect-[3/2] (1-col, landscape reduces scroll height)', () => {
    const { container } = render(
      <PlotThumbnail plot={plot as never} isActive={false} onClick={() => {}} density="compact" />
    )
    const preview = container.querySelector('.overflow-hidden') as HTMLElement
    const classes = preview.className.split(' ')
    expect(classes).toContain('aspect-[3/2]')
    expect(classes).not.toContain('aspect-square')
  })

  it('narrow density → thumbnail uses aspect-[3/2] (1-col, same policy as compact)', () => {
    const { container } = render(
      <PlotThumbnail plot={plot as never} isActive={false} onClick={() => {}} density="narrow" />
    )
    const preview = container.querySelector('.overflow-hidden') as HTMLElement
    const classes = preview.className.split(' ')
    expect(classes).toContain('aspect-[3/2]')
    expect(classes).not.toContain('aspect-square')
  })
})

describe('PlotThumbnail density — title bar padding', () => {
  it('wide density → title bar keeps py-1.5', () => {
    render(
      <PlotThumbnail plot={plot as never} isActive={false} onClick={() => {}} density="wide" />
    )
    const titleBar = screen.getByTestId('plot-thumbnail-title-bar')
    const classes = titleBar.className.split(' ')
    expect(classes).toContain('py-1.5')
  })

  it('compact density → title bar uses py-1 (not py-1.5)', () => {
    render(
      <PlotThumbnail plot={plot as never} isActive={false} onClick={() => {}} density="compact" />
    )
    const titleBar = screen.getByTestId('plot-thumbnail-title-bar')
    const classes = titleBar.className.split(' ')
    expect(classes).toContain('py-1')
    expect(classes).not.toContain('py-1.5')
  })

  it('narrow density → title bar uses py-1 (not py-2)', () => {
    render(
      <PlotThumbnail plot={plot as never} isActive={false} onClick={() => {}} density="narrow" />
    )
    const titleBar = screen.getByTestId('plot-thumbnail-title-bar')
    const classes = titleBar.className.split(' ')
    expect(classes).toContain('py-1')
    expect(classes).not.toContain('py-2')
  })
})
