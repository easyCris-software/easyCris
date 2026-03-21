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
