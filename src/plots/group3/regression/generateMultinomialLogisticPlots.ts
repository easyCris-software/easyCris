/**
 * Generate multinomial logistic regression plots
 *
 * Plot 1: Forest plot (OR ± 95% CI by class)
 * Plot 2: Predicted Probability Plot (by class)
 */

import type { TestResult } from '@/store/results-store'
import type { Group3PlotOutput } from '../types'
import type { Data, Layout } from 'plotly.js'
import { createBaseLayout, createDefaultConfig, getColor } from '@/utils/plotBuilders'
import { buildMulticlassROCCurveFromResult } from '@/utils/plotBuilders/rocCurveBuilder'

// Default discrete color scale
const DISCRETE_COLORS = ['#F8766D', '#00BFC4', '#00BA38', '#C77CFF', '#F564E3', '#619CFF']

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
 * Generate forest plot for multinomial logistic regression odds ratios (by class)
 * Creates separate traces per class with distinct colors
 */
export function generateMultinomialLogisticForestPlot(result: TestResult): Group3PlotOutput | null {
  const rawOutput = (result.rawOutput as Record<string, unknown>) ?? {}

  const regressionCoeffs = rawOutput.regression_coefficients as Array<{
    class_label?: string
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

  // Group coefficients by class
  const coeffsByClass = new Map<string, typeof regressionCoeffs>()
  regressionCoeffs.forEach((coeff) => {
    const classLabel = coeff.class_label ?? 'Unknown'
    if (!coeffsByClass.has(classLabel)) {
      coeffsByClass.set(classLabel, [])
    }
    coeffsByClass.get(classLabel)!.push(coeff)
  })

  // Build all labels (in order for y-axis)
  const allLabels = regressionCoeffs.map((c) => {
    const termLabel = c.term_display ?? c.term ?? 'Unknown'
    return `${c.class_label ?? 'Class'}:${termLabel}`
  })

  // Create one trace per class with distinct colors
  const data: Data[] = []
  const classLabels = Array.from(coeffsByClass.keys()).sort()

  classLabels.forEach((classLabel, classIdx) => {
    const classCoeffs = coeffsByClass.get(classLabel)!
    const color = DISCRETE_COLORS[classIdx % DISCRETE_COLORS.length]

    const labels: string[] = []
    const estimates: number[] = []
    const errPlus: number[] = []
    const errMinus: number[] = []

    classCoeffs.forEach((coeff) => {
      const termLabel = coeff.term_display ?? coeff.term ?? 'Unknown'
      const label = `${classLabel}:${termLabel}`
      labels.push(label)
      estimates.push(coeff.odds_ratio ?? 1)

      const ciLower = coeff.or_ci_lower
      const ciUpper = coeff.or_ci_upper
      if (ciLower !== undefined && ciUpper !== undefined) {
        errMinus.push((coeff.odds_ratio ?? 1) - ciLower)
        errPlus.push(ciUpper - (coeff.odds_ratio ?? 1))
      } else {
        errMinus.push(0)
        errPlus.push(0)
      }
    })

    data.push({
      type: 'scatter',
      mode: 'markers',
      x: estimates,
      y: labels,
      name: classLabel,
      marker: { color, size: 10 },
      error_x: {
        type: 'data',
        array: errPlus,
        arrayminus: errMinus,
        visible: true,
        color,
        thickness: 2,
      },
      hovertemplate: `${classLabel}<br>%{y}<br>OR: %{x:.3f}<extra></extra>`,
    })
  })

  // Add stats for E2E validation
  const orValues = regressionCoeffs.map((c) => c.odds_ratio ?? 1).filter((v) => Number.isFinite(v))
  const categoryMapping = rawOutput.category_mapping as Record<string, string> | undefined
  const totalClasses = categoryMapping ? Object.keys(categoryMapping).length : coeffsByClass.size + 1

  const stats: Record<string, number> = {
    n_coeffs: regressionCoeffs.length,
    n_classes: totalClasses,
    or_min: orValues.length > 0 ? Math.min(...orValues) : 1,
    or_max: orValues.length > 0 ? Math.max(...orValues) : 1,
  }

  // Build annotation rows for OR table
  const rows = regressionCoeffs.map((coeff) => ({
    label: `${coeff.class_label ?? 'Class'}:${coeff.term_display ?? coeff.term ?? 'Unknown'}`,
    estimate: coeff.odds_ratio ?? 1,
    confidenceInterval:
      coeff.or_ci_lower !== undefined && coeff.or_ci_upper !== undefined
        ? ([coeff.or_ci_lower, coeff.or_ci_upper] as [number, number])
        : undefined,
  }))
  const tableAnnotations = buildOddsRatioAnnotations(rows)

  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  const baseLayout = createBaseLayout({
    title: 'Multinomial Logistic Regression Odds Ratios by Class',
    showLegend: true,
  })
  const maxLabelLength = rows.reduce((max, row) => Math.max(max, row.label.length), 0)
  const leftMargin = Math.min(360, Math.max(120, Math.round(maxLabelLength * 7)))
  const baseMargin = baseLayout.margin ?? { t: 50, r: 50, b: 50, l: 60 }

  return {
    plotlyData: data,
    plotlyLayout: {
      ...baseLayout,
      meta: {
        ...(baseLayout.meta ?? {}),
        stats,
      },
      margin: {
        ...baseMargin,
        l: Math.max(baseMargin.l ?? 60, leftMargin, 200),
        r: 200,
      },
      xaxis: {
        title: {
          text: 'Odds Ratio',
          font: axisFont,
        },
        type: 'log',
        domain: [0, 0.68],
        tickformat: '.4~g',
        tickfont: axisFont,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        categoryorder: 'array',
        categoryarray: allLabels.slice().reverse(),
        tickfont: axisFont,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
        automargin: true,
      },
      annotations: tableAnnotations,
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
      legend: {
        x: 0.98,
        y: 0.98,
        xanchor: 'right',
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.8)',
        bordercolor: '#111827',
        borderwidth: 1,
      },
    },
    plotlyConfig: createDefaultConfig(),
  }
}

/**
 * Generate ROC curve plot for multinomial logistic regression (one-vs-rest)
 */
export function generateMultinomialLogisticROCPlot(result: TestResult): Group3PlotOutput | null {
  const builderOutput = buildMulticlassROCCurveFromResult(result)

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

/**
 * Generate predicted probability plot for multinomial logistic regression
 */
export function generateMultinomialLogisticProbabilityPlot(result: TestResult): Group3PlotOutput | null {
  const rawOutput = (result.rawOutput as Record<string, unknown>) ?? {}

  const probMatrix = rawOutput.predicted_probabilities as number[][] | undefined
  const classLabels = (rawOutput.class_labels as Record<string, string>) ?? {}

  if (!probMatrix || probMatrix.length === 0) {
    return null
  }

  // probMatrix is [n_samples, n_classes]
  const nSamples = probMatrix.length
  const nClasses = probMatrix[0]?.length ?? 0

  if (nClasses === 0) {
    return null
  }

  // Create observation indices
  const obsIndices = Array.from({ length: nSamples }, (_, i) => i + 1)

  // Transpose matrix to get probabilities by class
  const data: Data[] = []
  const allProbs: number[] = []

  for (let classIdx = 0; classIdx < nClasses; classIdx++) {
    const probabilities = probMatrix.map((row) => row[classIdx] ?? 0)
    allProbs.push(...probabilities)

    const className = classLabels[String(classIdx)] ?? `Class ${classIdx}`

    data.push({
      type: 'scatter',
      mode: 'lines+markers',
      x: obsIndices,
      y: probabilities,
      name: className,
      line: {
        color: getColor(classIdx),
        width: 2,
      },
      marker: {
        color: getColor(classIdx),
        size: 6,
      },
      hovertemplate: `${className}<br>Observation: %{x}<br>Probability: %{y:.3f}<extra></extra>`,
    })
  }

  // Add stats for E2E validation
  const probFiltered = allProbs.filter((p) => Number.isFinite(p))
  const probMean =
    probFiltered.length > 0
      ? probFiltered.reduce((sum, v) => sum + v, 0) / probFiltered.length
      : 0
  const stats: Record<string, number> = {
    n_points: nSamples,
    n_classes: nClasses,
    prob_rows: nSamples,
    prob_cols: nClasses,
    prob_min: probFiltered.length > 0 ? Math.min(...probFiltered) : 0,
    prob_max: probFiltered.length > 0 ? Math.max(...probFiltered) : 1,
    prob_mean: probMean,
  }

  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  const baseLayout = createBaseLayout({
    title: 'Predicted Probabilities by Class',
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
        text: 'Observation',
        font: axisFont,
      },
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    yaxis: {
      title: {
        text: 'Predicted Probability',
        font: axisFont,
      },
      range: [0, 1],
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    legend: {
      x: 0.98,
      y: 0.98,
      xanchor: 'right',
      yanchor: 'top',
      bgcolor: 'rgba(255,255,255,0.8)',
      bordercolor: '#111827',
      borderwidth: 1,
    },
  }

  return {
    plotlyData: data,
    plotlyLayout: layout,
    plotlyConfig: createDefaultConfig(),
  }
}
