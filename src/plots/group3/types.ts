/**
 * Group 3: Regression & Correlation Plot Types
 */

import type { Layout, Config } from 'plotly.js'
import type { TestResult } from '@/store/results-store'

export interface Group3PlotOutput {
  plotlyData: unknown[]
  plotlyLayout: Partial<Layout>
  plotlyConfig: Partial<Config>
}

export interface CorrelationPlotInput {
  result: TestResult
  xColumn: string
  yColumn: string
}

export interface RegressionPlotInput {
  result: TestResult
  dependentVariable: string
  predictorVariables: string[]
}
