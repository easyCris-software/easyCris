/**
 * Generate binary logistic regression plots
 *
 * Plot 1: Forest plot (OR ± 95% CI)
 * Plot 2: ROC Curve (AUC)
 */

import type { TestResult } from '@/store/results-store'
import type { Group3PlotOutput } from '../types'
import type { Layout } from 'plotly.js'
import { forestPlotBuilder, buildROCCurveFromResult, type PlotBuilderInput } from '@/utils/plotBuilders'
import { DEFAULT_COLORS } from '@/utils/plotBuilders/common'
import { toNumber } from '@/services/plotResult/common/normalize'

const FOREST_TABLE_X = {
  oddsRatio: 0.72,
}

function formatForestNumber(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'NA'
  const absVal = Math.abs(value)
  if (absVal >= 1000 || (absVal > 0 && absVal < 0.01)) {
    return value.toExponential(2).replace('e+', 'e')
  }
  return value.toFixed(2)
}

function buildOddsRatioAnnotations(rows: Array<{
  label: string
  estimate: number
  confidenceInterval?: [number, number]
}>): Layout['annotations'] {
  const annotations: NonNullable<Layout['annotations']> = [
    {
      name: 'or_header',
      xref: 'paper',
      yref: 'paper',
      x: FOREST_TABLE_X.oddsRatio,
      y: 1.04,
      text: 'OR (95% CI)',
      showarrow: false,
      xanchor: 'left',
      yanchor: 'bottom',
      font: { family: 'Inter, sans-serif', size: 12, color: '#111827' },
    },
  ]

  rows.forEach((row) => {
    const ci = row.confidenceInterval
    const orText = ci
      ? `${formatForestNumber(row.estimate)} (${formatForestNumber(ci[0])}, ${formatForestNumber(ci[1])})`
      : formatForestNumber(row.estimate)

    annotations.push(
      {
        name: `or_value_${row.label}`,
        xref: 'paper',
        yref: 'y',
        x: FOREST_TABLE_X.oddsRatio,
        y: row.label,
        text: orText,
        showarrow: false,
        xanchor: 'left',
        yanchor: 'middle',
        font: { family: 'Inter, sans-serif', size: 12, color: '#111827' },
      }
    )
  })

  return annotations
}

/**
 * Generate forest plot for binary logistic regression odds ratios
 */
export function generateBinaryLogisticForestPlot(result: TestResult): Group3PlotOutput | null {
  const rawOutput = (result.rawOutput as Record<string, unknown>) ?? {}

  const regressionCoeffs = rawOutput.regression_coefficients as Array<{
    term?: string
    term_display?: string
    odds_ratio?: number
    or_ci_lower?: number
    or_ci_upper?: number
    std_error?: number
    p_value?: number
  }> | undefined

  if (!regressionCoeffs || regressionCoeffs.length === 0) {
    return null
  }

  // Filter out intercept - OR for intercept is not interpretable and blows out the scale
  // (R's forest plots exclude intercept for the same reason)
  const predictorCoeffs = regressionCoeffs.filter((coeff) => {
    const term = coeff.term?.toLowerCase() ?? ''
    const termType = (coeff as Record<string, unknown>).term_type as string | undefined
    return termType !== 'intercept' && term !== 'const' && term !== '(intercept)' && term !== 'intercept'
  })

  // Convert regression coefficients to forest plot format (using OR instead of beta)
  const coefficients = predictorCoeffs.map((coeff) => ({
    name: coeff.term_display ?? coeff.term ?? 'Unknown',
    estimate: coeff.odds_ratio ?? 1,
    stdError: toNumber(coeff.std_error) ?? 0,
    pValue: toNumber(coeff.p_value) ?? 1,
    confidenceInterval:
      coeff.or_ci_lower !== undefined && coeff.or_ci_upper !== undefined
        ? ([coeff.or_ci_lower, coeff.or_ci_upper] as [number, number])
        : undefined,
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
      title: 'Binary Logistic Regression Odds Ratios',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }

  const builderOutput = forestPlotBuilder(input)

  // Add stats for E2E validation (use predictorCoeffs - what's actually displayed)
  const orValues = predictorCoeffs.map((c) => c.odds_ratio ?? 1).filter((v) => Number.isFinite(v))
  const ciLowers = predictorCoeffs.map((c) => c.or_ci_lower ?? 1).filter((v) => Number.isFinite(v))
  const ciUppers = predictorCoeffs.map((c) => c.or_ci_upper ?? 1).filter((v) => Number.isFinite(v))

  const stats = {
    ...builderOutput.stats,
    n_coeffs: predictorCoeffs.length,
    or_min: orValues.length > 0 ? Math.min(...orValues) : 1,
    or_max: orValues.length > 0 ? Math.max(...orValues) : 1,
    ci_min: ciLowers.length > 0 ? Math.min(...ciLowers) : 1,
    ci_max: ciUppers.length > 0 ? Math.max(...ciUppers) : 1,
  }

  const rows = coefficients.map((coeff) => ({
    label: coeff.name,
    estimate: coeff.estimate,
    confidenceInterval: coeff.confidenceInterval,
  }))
  const tableAnnotations = buildOddsRatioAnnotations(rows)
  const baseLayout = builderOutput.layout as Partial<Layout>
  const maxLabelLength = rows.reduce((max, row) => Math.max(max, row.label.length), 0)
  const leftMargin = Math.min(360, Math.max(120, Math.round(maxLabelLength * 7)))
  const baseMargin = baseLayout.margin ?? { t: 50, r: 50, b: 50, l: 60 }
  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

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
        l: Math.max(baseMargin.l ?? 60, leftMargin, 200),
        r: 200,
      },
      xaxis: {
        ...(baseLayout.xaxis ?? {}),
        title: {
          text: 'Odds Ratio',
          font: axisFont,
        },
        type: 'log',
        domain: [0, 0.68],
        // Trim trailing zeros and avoid SI prefixes on log ticks.
        // Plotly uses d3-format when tickformat is set (see axes.formatLog -> numFormat).
        tickformat: '.4~g',
        tickfont: axisFont,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        ...(baseLayout.yaxis ?? {}),
        automargin: true,
        tickfont: axisFont,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      annotations: [
        ...(baseLayout.annotations ?? []),
        ...(tableAnnotations ?? []),
      ],
      // Add vertical line at OR=1 (reference line for no effect)
      shapes: [
        {
          type: 'line',
          x0: 1,
          x1: 1,
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
 * Generate ROC curve for binary logistic regression
 */
export function generateBinaryLogisticROCCurve(result: TestResult): Group3PlotOutput | null {
  const builderOutput = buildROCCurveFromResult(result)

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(builderOutput.layout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats: builderOutput.stats,
      },
    },
    plotlyConfig: builderOutput.config,
  }
}
