/**
 * Generate simple linear regression plots
 *
 * Plot 1: Scatter + fitted line + 95% CI band
 * Plot 2: Residual vs Fitted
 */

import type { TestResult } from '@/store/results-store'
import type { Group3PlotOutput } from '../types'
import type { Data, Layout } from 'plotly.js'
import { residualBuilder, createBaseLayout, createDefaultConfig, type PlotBuilderInput } from '@/utils/plotBuilders'
import { tCriticalFromDf, toNumber } from '@/services/plotResult/common/normalize'

/**
 * Generate scatter plot with regression line and CI band for simple linear regression
 */
export function generateLinearRegressionScatterWithFit(
  result: TestResult,
  xData: number[],
  yData: number[],
  xLabel: string,
  yLabel: string,
): Group3PlotOutput | null {
  const rawOutput = (result.rawOutput as Record<string, unknown>) ?? {}
  const regressionSummary = rawOutput.regression_summary as Record<string, unknown> | undefined
  const modelFitMetrics = rawOutput.model_fit_metrics as Record<string, unknown> | undefined

  // Extract parameters
  const fittedValues = rawOutput.fitted_values as number[] | undefined
  const regressionCoeffs = rawOutput.regression_coefficients as Array<{
    term: string
    term_display?: string
    term_type?: string
    beta?: number
  }> | undefined
  const rSquared = rawOutput.r_squared as number | undefined

  if (!fittedValues || !regressionCoeffs) {
    return null
  }

  // Get slope and intercept from regression coefficients
  const interceptCoeff = regressionCoeffs.find((c) =>
    c.term_type === 'intercept' ||
    c.term === 'const' ||
    c.term === 'Intercept' ||
    c.term === '(Intercept)' ||
    c.term_display === 'Intercept'
  )
  const slopeCoeff = regressionCoeffs.find((c) =>
    c.term_type === 'predictor' ||
    (c.term !== 'Intercept' && c.term !== '(Intercept)' && c.term !== 'const')
  )

  const intercept = interceptCoeff?.beta ?? 0
  const slope = slopeCoeff?.beta ?? 0

  // Calculate fitted line points (use full range of x)
  const xMin = Math.min(...xData)
  const xMax = Math.max(...xData)
  const fittedX = [xMin, xMax]
  const fittedY = fittedX.map((x) => intercept + slope * x)

  // Create traces
  const stats: Record<string, number> = {}

  stats.n_points = xData.length
  stats.slope = slope
  stats.intercept = intercept
  stats.r_squared = rSquared ?? 0

  const n = xData.length
  const xMean = n > 0 ? xData.reduce((sum, v) => sum + v, 0) / n : 0
  const ssx = xData.reduce((sum, v) => sum + Math.pow(v - xMean, 2), 0)
  const dfResid = toNumber(regressionSummary?.df_resid) ??
    toNumber(rawOutput.df_resid) ??
    Math.max(n - 2, 1)
  const alpha = toNumber(rawOutput.alpha) ?? toNumber(regressionSummary?.alpha) ?? 0.05
  const rmse = toNumber(modelFitMetrics?.rmse) ?? toNumber(rawOutput.rmse) ?? 0
  const tCrit = tCriticalFromDf(dfResid, alpha)

  const data: Data[] = [
    // Scatter points
    {
      type: 'scatter',
      mode: 'markers',
      x: xData,
      y: yData,
      name: 'Observed',
      marker: {
        color: '#3b82f6',
        size: 8,
      },
      hovertemplate: `${xLabel}: %{x}<br>${yLabel}: %{y}<extra></extra>`,
    },
  ]

  // 95% CI band (mean response)
  if (Number.isFinite(rmse) && rmse > 0 && ssx > 0) {
    const bandPoints = 100
    const step = (xMax - xMin) / (bandPoints - 1)
    const bandX: number[] = []
    const bandUpper: number[] = []
    const bandLower: number[] = []

    for (let i = 0; i < bandPoints; i++) {
      const xVal = xMin + step * i
      const yHat = intercept + slope * xVal
      const seFit = rmse * Math.sqrt(1 / n + Math.pow(xVal - xMean, 2) / ssx)
      const margin = tCrit * seFit
      bandX.push(xVal)
      bandUpper.push(yHat + margin)
      bandLower.push(yHat - margin)
    }

    data.push({
      type: 'scatter',
      mode: 'lines',
      x: [...bandX, ...bandX.slice().reverse()],
      y: [...bandUpper, ...bandLower.slice().reverse()],
      fill: 'toself',
      fillcolor: 'rgba(59,130,246,0.2)',
      line: { width: 0 },
      name: '95% CI',
      hoverinfo: 'skip',
    })

    stats.ci_band_points = bandX.length
  } else {
    stats.ci_band_points = 0
  }

  // Fitted line (keep on top of CI band)
  data.push({
    type: 'scatter',
    mode: 'lines',
    x: fittedX,
    y: fittedY,
    name: `Fitted (R² = ${(rSquared ?? 0).toFixed(3)})`,
    line: {
      color: '#ef4444',
      width: 2,
    },
    hoverinfo: 'skip',
  })

  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  const baseLayout = createBaseLayout({
    title: `Linear Regression: ${yLabel} vs ${xLabel}`,
    showLegend: true,
  })

  const layout: Partial<Layout> = {
    ...baseLayout,
    meta: {
      ...(baseLayout.meta ?? {}),
      stats,
    },
    xaxis: {
      title: {
        text: xLabel,
        font: axisFont,
      },
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    yaxis: {
      title: {
        text: yLabel,
        font: axisFont,
      },
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
  }

  return {
    plotlyData: data,
    plotlyLayout: layout,
    plotlyConfig: createDefaultConfig(),
  }
}

/**
 * Generate residual vs fitted plot for linear regression
 */
export function generateLinearRegressionResidualPlot(result: TestResult): Group3PlotOutput | null {
  const rawOutput = (result.rawOutput as Record<string, unknown>) ?? {}

  const fittedValues = rawOutput.fitted_values as number[] | undefined
  const residuals = rawOutput.residuals as number[] | undefined

  if (!fittedValues || !residuals) {
    return null
  }

  // Use residualBuilder with fitted values as x and residuals as y
  const input: PlotBuilderInput = {
    source: 'test_result',
    columns: [
      {
        columnId: 'fitted_values',
        columnName: 'Fitted Values',
        role: 'x',
        inferredType: 'numeric',
        values: fittedValues,
      },
      {
        columnId: 'residuals',
        columnName: 'Residuals',
        role: 'y',
        inferredType: 'numeric',
        values: residuals,
      },
    ],
    testResult: result,
    options: {
      title: 'Residual vs Fitted',
      showLegend: true,
      showGrid: true,
      colorPalette: ['#111827'],
    },
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }

  const builderOutput = residualBuilder(input)

  // Add stats for E2E validation
  const residualsFiltered = residuals.filter((r) => Number.isFinite(r))
  const fittedFiltered = fittedValues.filter((f) => Number.isFinite(f))
  const fittedMean =
    fittedFiltered.length > 0
      ? fittedFiltered.reduce((sum, v) => sum + v, 0) / fittedFiltered.length
      : 0
  const residualMean =
    residualsFiltered.length > 0
      ? residualsFiltered.reduce((sum, r) => sum + r, 0) / residualsFiltered.length
      : 0

  const stats = {
    ...builderOutput.stats,
    n_points: residuals.length,
    residual_mean: residualMean,
    residual_sd: residualsFiltered.length > 1
      ? Math.sqrt(
          residualsFiltered.reduce((sum, r) => {
            return sum + Math.pow(r - residualMean, 2)
          }, 0) / (residualsFiltered.length - 1)
        )
      : 0,
    residual_std: residualsFiltered.length > 1
      ? Math.sqrt(
          residualsFiltered.reduce((sum, r) => {
            return sum + Math.pow(r - residualMean, 2)
          }, 0) / (residualsFiltered.length - 1)
        )
      : 0,
    residual_min: residualsFiltered.length > 0 ? Math.min(...residualsFiltered) : 0,
    residual_max: residualsFiltered.length > 0 ? Math.max(...residualsFiltered) : 0,
    fitted_mean: fittedMean,
    fitted_min: fittedFiltered.length > 0 ? Math.min(...fittedFiltered) : 0,
    fitted_max: fittedFiltered.length > 0 ? Math.max(...fittedFiltered) : 0,
  }

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(builderOutput.layout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats,
      },
    },
    plotlyConfig: builderOutput.config,
  }
}
