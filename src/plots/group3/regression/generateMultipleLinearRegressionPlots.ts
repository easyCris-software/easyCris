/**
 * Generate multiple linear regression plots
 *
 * Plot 1: Forest plot (β ± 95% CI)
 * Plot 2: Residual vs Fitted (shared with simple linear)
 */

import type { TestResult } from '@/store/results-store'
import type { Group3PlotOutput } from '../types'
import type { Layout } from 'plotly.js'
import { forestPlotBuilder, type PlotBuilderInput } from '@/utils/plotBuilders'
import { DEFAULT_COLORS } from '@/utils/plotBuilders/common'
import { toNumber } from '@/services/plotResult/common/normalize'

/**
 * Generate forest plot for multiple linear regression coefficients
 */
export function generateMultipleLinearForestPlot(result: TestResult): Group3PlotOutput | null {
  const rawOutput = (result.rawOutput as Record<string, unknown>) ?? {}

  const regressionCoeffs = rawOutput.regression_coefficients as Array<{
    term?: string
    term_display?: string
    beta?: number
    ci_lower?: number
    ci_upper?: number
    std_error?: number
    p_value?: number
  }> | undefined

  if (!regressionCoeffs || regressionCoeffs.length === 0) {
    return null
  }

  // Convert regression coefficients to forest plot format
  const coefficients = regressionCoeffs.map((coeff) => ({
    name: coeff.term_display ?? coeff.term ?? 'Unknown',
    estimate: coeff.beta ?? 0,
    confidenceInterval:
      coeff.ci_lower !== undefined && coeff.ci_upper !== undefined
        ? ([coeff.ci_lower, coeff.ci_upper] as [number, number])
        : undefined,
    stdError: toNumber(coeff.std_error) ?? 0,
    pValue: toNumber(coeff.p_value) ?? 1,
  }))

  // Build forest plot using existing builder
  const input: PlotBuilderInput = {
    source: 'test_result',
    columns: [],
    testResult: {
      ...result,
      coefficients,
    },
    options: {
      title: 'Multiple Linear Regression Coefficients',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }

  const builderOutput = forestPlotBuilder(input)

  // Add stats for E2E validation
  const coefValues = regressionCoeffs.map((c) => c.beta ?? 0).filter((v) => Number.isFinite(v))
  const ciLowers = regressionCoeffs.map((c) => c.ci_lower ?? 0).filter((v) => Number.isFinite(v))
  const ciUppers = regressionCoeffs.map((c) => c.ci_upper ?? 0).filter((v) => Number.isFinite(v))

  const stats = {
    ...builderOutput.stats,
    n_coeffs: regressionCoeffs.length,
    coef_min: coefValues.length > 0 ? Math.min(...coefValues) : 0,
    coef_max: coefValues.length > 0 ? Math.max(...coefValues) : 0,
    ci_min: ciLowers.length > 0 ? Math.min(...ciLowers) : 0,
    ci_max: ciUppers.length > 0 ? Math.max(...ciUppers) : 0,
  }

  const maxLabelLength = coefficients.reduce((max, coeff) => Math.max(max, coeff.name.length), 0)
  const leftMargin = Math.min(360, Math.max(120, Math.round(maxLabelLength * 7)))
  const baseLayout = builderOutput.layout as Partial<Layout>
  const baseMargin = baseLayout.margin ?? { t: 50, r: 50, b: 50, l: 60 }

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(baseLayout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats,
      },
      margin: {
        ...baseMargin,
        l: Math.max(baseMargin.l ?? 60, leftMargin),
      },
      yaxis: {
        ...(baseLayout.yaxis ?? {}),
        automargin: true,
      },
      // Add vertical line at β=0 (reference line for no effect)
      shapes: [
        {
          type: 'line',
          x0: 0,
          x1: 0,
          y0: 0,
          y1: 1,
          yref: 'paper',
          line: {
            color: '#9ca3af',
            width: 1,
            dash: 'dash',
          },
        },
      ],
    },
    plotlyConfig: builderOutput.config,
  }
}

/**
 * Generate residual vs fitted plot for multiple linear regression
 * (Reuses the same function as simple linear regression)
 */
export { generateLinearRegressionResidualPlot as generateMultipleLinearResidualPlot } from './generateLinearRegressionPlots'
