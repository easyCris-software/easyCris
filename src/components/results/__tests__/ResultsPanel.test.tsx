import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { ResultsPanel } from '@/components/results/ResultsPanel'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import type { TestResult } from '@/store/results-store'

const baseResult: TestResult = {
  id: 'result-1',
  testId: 'lmm_anova',
  testName: 'Linear Mixed Model',
  family: 'parametric',
  executedAt: new Date('2026-03-12T00:21:37.994Z'),
  statistics: {},
  summary: {
    Test: 'Linear Mixed Model',
    Columns: 'Value, Treatment, Day',
  },
}

describe('ResultsPanel', () => {
  afterEach(() => {
    useResultsStore.setState({
      results: [],
      currentResult: null,
      currentResultIdByFamily: {},
      activeStatisticsFamilyId: null,
    })
    usePlotsStore.setState({
      plots: [],
      activePlotId: null,
      computedStats: {},
    })
  })

  it('renders without crashing when model fit values are null', () => {
    const resultWithNullModelFit: TestResult = {
      ...baseResult,
      modelFit: {
        aic: null as unknown as number,
        bic: null as unknown as number,
        logLikelihood: null as unknown as number,
        residualVariance: null as unknown as number,
        converged: true,
      },
      summary: {
        ...baseResult.summary,
        Converged: 'Yes',
        'Singular Fit': 'Yes',
      },
    }

    act(() => {
      useResultsStore.setState({
        results: [resultWithNullModelFit],
        currentResult: resultWithNullModelFit,
        currentResultIdByFamily: {},
        activeStatisticsFamilyId: null,
      })
    })

    act(() => {
      render(<ResultsPanel />)
    })

    expect(screen.getByTestId('results-panel')).toBeInTheDocument()
    expect(screen.getByText('Model Fit')).toBeInTheDocument()
    expect(screen.getByText('AIC')).toBeInTheDocument()
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)
  })
})
