import { beforeEach, describe, expect, it } from 'vitest'
import {
  createTestResultPlotSpec,
  createUserDerivedPlotSpec,
  usePlotsStore,
} from '@/store/plots-store'

describe('plots-store preserveActiveUserPlot', () => {
  beforeEach(() => {
    usePlotsStore.setState({
      plots: [],
      activePlotId: null,
      activeFamily: 'all',
      activeStatisticsFamilyId: 'statistics-1',
      computedStats: {},
    })
  })

  it('keeps active user plot focused when adding test-result plot with preserve flag', () => {
    const userPlot = createUserDerivedPlotSpec({
      id: 'plot-user-1',
      type: 'box',
      title: 'User Plot',
      statisticsFamilyId: 'statistics-1',
      datasetId: 'dataset-1',
      columns: [],
      totalRows: 10,
      sampledRows: 10,
      plotlyData: [],
      plotlyLayout: {},
    })

    const autoPlot = createTestResultPlotSpec({
      id: 'plot-auto-1',
      type: 'box',
      title: 'Auto Plot',
      statisticsFamilyId: 'statistics-1',
      resultId: 'result-1',
      testType: 'one_way_anova',
      testFamily: 'descriptive',
      plotlyData: [],
      plotlyLayout: {},
    })

    const store = usePlotsStore.getState()
    store.addPlot(userPlot)
    store.setActivePlot(userPlot.id)
    store.addPlot(autoPlot, { preserveActiveUserPlot: true })

    expect(usePlotsStore.getState().activePlotId).toBe(userPlot.id)
  })

  it('activates newly added test-result plot when preserve flag is not set', () => {
    const userPlot = createUserDerivedPlotSpec({
      id: 'plot-user-2',
      type: 'box',
      title: 'User Plot',
      statisticsFamilyId: 'statistics-1',
      datasetId: 'dataset-1',
      columns: [],
      totalRows: 10,
      sampledRows: 10,
      plotlyData: [],
      plotlyLayout: {},
    })

    const autoPlot = createTestResultPlotSpec({
      id: 'plot-auto-2',
      type: 'box',
      title: 'Auto Plot',
      statisticsFamilyId: 'statistics-1',
      resultId: 'result-2',
      testType: 'one_way_anova',
      testFamily: 'descriptive',
      plotlyData: [],
      plotlyLayout: {},
    })

    const store = usePlotsStore.getState()
    store.addPlot(userPlot)
    store.setActivePlot(userPlot.id)
    store.addPlot(autoPlot)

    expect(usePlotsStore.getState().activePlotId).toBe(autoPlot.id)
  })
})

