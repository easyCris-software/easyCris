/**
 * Dose-Response Curve Builder
 *
 * Generates publication-quality dose-response plots with:
 * - Observed data points (scatter markers)
 * - Smooth fitted curve (sigmoidal, 100+ points)
 * - 95% CI bands (shaded area from Python ci_band_* arrays)
 * - IC50 annotation (vertical + horizontal lines)
 * - Log-scale X-axis
 *
 * Part of Group 2 Pharmacology plot auto-generation.
 */

import type { PlotBuilderOutput } from './types'
import type { TestResult } from '@/store/results-store'
import type { Data, Layout } from 'plotly.js'
import { calculateBarPlotRange, createBaseLayout, createDefaultConfig } from './common'

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface ParameterValue {
  value: number
  stderr?: number
  ci_lower?: number
  ci_upper?: number
}

interface DoseResponseParameters {
  bottom?: ParameterValue
  top?: ParameterValue
  ic50?: ParameterValue
  hill?: ParameterValue
  asymmetry?: ParameterValue
}

interface GoodnessOfFit {
  r_squared?: number
  adj_r_squared?: number
  aic?: number
  bic?: number
  rmse?: number
}

function normalizeDoseResponseModelType(value?: string): '3PL' | '4PL' | '5PL' {
  if (!value) return '4PL'
  const cleaned = value.replace(/_SCALED$/i, '')
  const upper = cleaned.toUpperCase()
  if (upper.startsWith('3PL')) return '3PL'
  if (upper.startsWith('4PL')) return '4PL'
  if (upper.startsWith('5PL')) return '5PL'
  if (upper.includes('DOSE_RESPONSE_3PL')) return '3PL'
  if (upper.includes('DOSE_RESPONSE_4PL')) return '4PL'
  if (upper.includes('DOSE_RESPONSE_5PL')) return '5PL'
  return '4PL'
}

function resolveRawOutput(result: TestResult): Record<string, unknown> | null {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed.results === 'object' && parsed.results !== null) {
        return parsed.results as Record<string, unknown>
      }
      return parsed
    } catch {
      return null
    }
  }
  if (raw && typeof raw.results === 'object' && raw.results !== null) {
    return raw.results as Record<string, unknown>
  }
  return raw
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// =============================================================================
// MODEL FUNCTIONS
// =============================================================================

/**
 * 4-Parameter Logistic (4PL) model
 * Hill equation (log-dose style): f(x) = bottom + (top - bottom) / (1 + (x/ic50)^(-hill))
 */
function fourPL(dose: number, bottom: number, top: number, ic50: number, hill: number): number {
  if (dose <= 0 || ic50 <= 0) return bottom
  return bottom + (top - bottom) / (1 + Math.pow(dose / ic50, -hill))
}

/**
 * 3-Parameter Logistic (3PL) model
 * Same as 4PL but bottom is typically fixed at 0
 */
function threePL(dose: number, bottom: number, top: number, ic50: number, hill: number): number {
  return fourPL(dose, bottom, top, ic50, hill)
}

/**
 * 5-Parameter Logistic (5PL) model
 * Adds asymmetry parameter: f(x) = bottom + (top - bottom) / (1 + (x/ic50)^(-hill))^asymmetry
 */
function fivePL(
  dose: number,
  bottom: number,
  top: number,
  ic50: number,
  hill: number,
  asymmetry: number
): number {
  if (dose <= 0 || ic50 <= 0) return bottom
  return bottom + (top - bottom) / Math.pow(1 + Math.pow(dose / ic50, -hill), asymmetry)
}

// =============================================================================
// CURVE GENERATION
// =============================================================================

/**
 * Generate smooth fitted curve from parameters
 */
function generateFittedCurve(
  params: { bottom: number; top: number; ic50: number; hill: number; asymmetry?: number },
  doseRange: [number, number],
  modelType: '3PL' | '4PL' | '5PL',
  nPoints: number = 100
): { x: number[]; y: number[] } {
  const { bottom, top, ic50, hill, asymmetry = 1.0 } = params

  // Generate log-spaced doses
  const logMin = Math.log10(Math.max(doseRange[0], 1e-10))
  const logMax = Math.log10(doseRange[1])

  const x: number[] = []
  const y: number[] = []

  for (let i = 0; i < nPoints; i++) {
    const logDose = logMin + (logMax - logMin) * (i / (nPoints - 1))
    const dose = Math.pow(10, logDose)

    let response: number
    switch (modelType) {
      case '3PL':
        response = threePL(dose, bottom, top, ic50, hill)
        break
      case '4PL':
        response = fourPL(dose, bottom, top, ic50, hill)
        break
      case '5PL':
        response = fivePL(dose, bottom, top, ic50, hill, asymmetry)
        break
    }

    x.push(dose)
    y.push(response)
  }

  return { x, y }
}

// =============================================================================
// MAIN BUILDER
// =============================================================================

/**
 * Build dose-response curve plot from test result
 *
 * Expects result.rawOutput to contain:
 * - parameters: { bottom, top, ic50, hill, asymmetry? } with value/ci_lower/ci_upper
 * - input_doses: number[] (preserved from payload)
 * - input_responses: number[] (recovered from fitted + residuals)
 * - ci_band_doses: number[] (100 log-spaced points for CI band)
 * - ci_band_lower: number[] (lower CI bound at each dose)
 * - ci_band_upper: number[] (upper CI bound at each dose)
 * - goodness_of_fit: { r_squared, adj_r_squared, aic, bic, rmse }
 * - model_type: '3PL' | '4PL' | '5PL'
 */
export function buildDoseResponseCurveFromResult(result: TestResult): PlotBuilderOutput | null {
  const rawOutput = resolveRawOutput(result)
  if (!rawOutput) return null

  // Extract parameters from result
  const params = rawOutput.parameters as DoseResponseParameters | undefined
  const modelType = normalizeDoseResponseModelType(rawOutput.model_type as string | undefined)
  const fixedBottom = toNumber((rawOutput as { fixed_bottom?: unknown }).fixed_bottom)

  // Validate required parameters exist
  const bottomValue =
    toNumber(params?.bottom?.value) ?? (modelType === '3PL' ? fixedBottom ?? 0 : null)
  const topValue = toNumber(params?.top?.value)
  const ic50Value = toNumber(params?.ic50?.value)
  const hillValue = toNumber(params?.hill?.value)
  if (bottomValue === null || topValue === null || ic50Value === null || hillValue === null) {
    return null
  }

  // Get input data for observed points
  const payloadData = (result as { plotPayload?: { data?: Record<string, unknown> } }).plotPayload
    ?.data as Record<string, unknown> | undefined
  const inputDoses =
    (rawOutput.input_doses as number[] | undefined) ??
    (rawOutput.doses as number[] | undefined) ??
    (payloadData?.doses as number[] | undefined)
  let inputResponses =
    (rawOutput.input_responses as number[] | undefined) ??
    (rawOutput.responses as number[] | undefined) ??
    (payloadData?.responses as number[] | undefined)
  const fittedValues = rawOutput.fitted_values as number[] | undefined
  const residuals = rawOutput.residuals as number[] | undefined
  if (
    (!inputResponses || inputResponses.length === 0) &&
    fittedValues &&
    residuals &&
    fittedValues.length === residuals.length
  ) {
    inputResponses = fittedValues.map((value, index) => value + (residuals[index] ?? 0))
  }

  // Filter valid points (dose > 0) and build separate arrays per trace
  // This keeps alignment correct and avoids desync between dose/response pairs
  const fittedDoses: number[] = []
  const fittedYs: number[] = []
  const observedDoses: number[] = []
  const observedYs: number[] = []

  if (inputDoses && inputDoses.length > 0) {
    for (let i = 0; i < inputDoses.length; i++) {
      const dose = inputDoses[i]
      if (typeof dose !== 'number' || !Number.isFinite(dose) || dose <= 0) {
        continue // Skip invalid/non-positive doses for log scale
      }

      const fitted = fittedValues?.[i]
      if (Number.isFinite(fitted)) {
        fittedDoses.push(dose)
        fittedYs.push(fitted as number)
      }

      const resp = inputResponses?.[i]
      if (Number.isFinite(resp)) {
        observedDoses.push(dose)
        observedYs.push(resp as number)
      }
    }
  }

  // Get CI band arrays from Python
  const ciBandDoses = rawOutput.ci_band_doses as number[] | undefined
  const ciBandLower = rawOutput.ci_band_lower as number[] | undefined
  const ciBandUpper = rawOutput.ci_band_upper as number[] | undefined

  // Extract parameter values
  const bottom = bottomValue
  const top = topValue
  const ic50 = ic50Value
  const hill = hillValue
  const asymmetry = toNumber(params?.asymmetry?.value) ?? 1.0

  // Determine dose range from input data or CI band
  let minDose: number, maxDose: number
  if (ciBandDoses && ciBandDoses.length > 0) {
    // Use Python's CI band doses as authoritative range (already padded appropriately)
    minDose = Math.min(...ciBandDoses.filter((d) => d > 0))
    maxDose = Math.max(...ciBandDoses)
  } else if (inputDoses && inputDoses.length > 0) {
    // Use actual data range (Plotly log-scale will handle visual padding)
    const positiveDoses = inputDoses.filter((d) => d > 0)
    minDose = Math.min(...positiveDoses)
    maxDose = Math.max(...positiveDoses)
  } else {
    // Fallback: use IC50 ± 3 orders of magnitude
    minDose = ic50 / 1000
    maxDose = ic50 * 1000
  }

  // Generate smooth fitted curve
  const curve = generateFittedCurve(
    { bottom, top, ic50, hill, asymmetry },
    [minDose, maxDose],
    modelType
  )

  // Build Plotly traces
  const traces: Data[] = []

  // Trace 1: CI band (shaded area) - must come first for proper layering
  // Using a solid fill color (not edge-dependent) for consistent appearance
  if (ciBandDoses && ciBandLower && ciBandUpper && ciBandDoses.length > 0) {
    // Create filled polygon: upper band forward, lower band reversed
    const bandX = [...ciBandDoses, ...ciBandDoses.slice().reverse()]
    const bandY = [...ciBandUpper, ...ciBandLower.slice().reverse()]

    traces.push({
      type: 'scatter',
      mode: 'none', // No line, just fill
      x: bandX,
      y: bandY,
      fill: 'toself',
      fillcolor: 'rgba(100, 149, 237, 0.3)', // Cornflower blue with opacity
      line: { width: 0 }, // Explicitly no line
      name: '95% CI',
      hoverinfo: 'skip',
      showlegend: true,
      meta: { role: 'ci_band' },
    })
  }

  // Trace 2: Smooth fitted curve
  traces.push({
    type: 'scatter',
    mode: 'lines',
    x: curve.x,
    y: curve.y,
    name: `${modelType} Fitted Curve`,
    line: { color: '#1f77b4', width: 2 },
    meta: { role: 'fitted_curve' },
  })

  // Trace 3: Fitted points (OFF by default)
  if (fittedDoses.length > 0 && fittedYs.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      x: fittedDoses,
      y: fittedYs,
      name: 'Fitted',
      marker: {
        color: '#ff7f0e', // Orange to distinguish from observed
        size: 8,
        symbol: 'cross',
      },
      visible: false,
      showlegend: false,
      meta: { role: 'fitted_points' },
    })
  }

  // Trace 4: Observed points (ON by default)
  if (observedDoses.length > 0 && observedYs.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      x: observedDoses,
      y: observedYs,
      name: 'Observed',
      marker: { color: '#1f77b4', size: 8, symbol: 'circle' },
      visible: true,
      showlegend: true,
      meta: { role: 'observed_points' },
    })
  }

  // Collect max y values for axis range (use filtered arrays)
  const rangeValues: number[] = []
  rangeValues.push(...curve.y)
  if (fittedYs.length > 0) {
    rangeValues.push(...fittedYs)
  }
  if (observedYs.length > 0) {
    rangeValues.push(...observedYs)
  }
  rangeValues.push(bottom)
  const hasNegativeData = rangeValues.some((value) => value < 0)
  if (ciBandLower && ciBandLower.length > 0) {
    const lowerValues = hasNegativeData ? ciBandLower : ciBandLower.map((value) => Math.max(0, value))
    rangeValues.push(...lowerValues)
  }
  if (ciBandUpper && ciBandUpper.length > 0) {
    rangeValues.push(...ciBandUpper)
  }
  const [yAxisMin, yAxisMax] = calculateBarPlotRange(rangeValues, 0.05)
  const axisBaseline = 0

  // Calculate IC50 Y-value (50% between bottom and top)
  const ic50Y = bottom + (top - bottom) / 2

  // IC50 color (configurable from plot settings)
  const ic50Color = '#d62728' // Default red

  const ic50LabelX = 0.86
  const ic50LabelY = 0.045

  // Build layout with IC50 annotation shapes
  const shapes: Layout['shapes'] = [
    // Vertical line at IC50
    {
      type: 'line',
      x0: ic50,
      x1: ic50,
      y0: axisBaseline,
      y1: ic50Y,
      xref: 'x',
      yref: 'y',
      line: { color: ic50Color, width: 1.5, dash: 'dash' },
      name: 'ic50_vline',
      visible: true,
    },
    // Horizontal line at 50%
    {
      type: 'line',
      x0: minDose,
      x1: ic50,
      y0: ic50Y,
      y1: ic50Y,
      xref: 'x',
      yref: 'y',
      line: { color: ic50Color, width: 1.5, dash: 'dash' },
      name: 'ic50_hline',
      visible: true,
    },
  ]

  const baseLayout = createBaseLayout({
    title: `${modelType} Dose-Response Curve`,
    showLegend: true,
  })
  const axisFont = {
    ...(baseLayout.font ?? { family: 'Inter, sans-serif', size: 12, color: '#333333' }),
    weight: 700,
  }

  const layout: Partial<Layout> = {
    ...baseLayout,
    title: { text: `${modelType} Dose-Response Curve` },
    xaxis: {
      title: {
        text: 'Dose (log scale)',
        font: axisFont,
        standoff: 15,
      },
      type: 'log',
      dtick: 1, // Plotly native: ticks at every power of 10 (1, 10, 100, 1000)
      minor: {
        ticks: '', // Disable minor ticks to keep tick sizing consistent
        showgrid: false,
      },
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
      exponentformat: 'e',
    },
    yaxis: {
      title: {
        text: 'Response',
        font: axisFont,
      },
      range: [yAxisMin, yAxisMax],
      autorange: false,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
      tickfont: axisFont,
      zeroline: false,
    },
    shapes: shapes,
    annotations: [
      {
        // IC50 text box (below legend, draggable)
        x: ic50LabelX,
        y: ic50LabelY,
        xref: 'paper',
        yref: 'paper',
        text: `IC50 = ${ic50.toPrecision(3)}`,
        showarrow: false,
        name: 'ic50_label',
        xanchor: 'center',
        yanchor: 'middle',
        font: {
          size: 12,
          color: ic50Color,
          family: 'Inter, sans-serif',
        },
        bgcolor: 'rgba(255, 255, 255, 0.75)',
        bordercolor: 'rgba(0, 0, 0, 0)',
        borderwidth: 0,
        borderpad: 4,
        visible: true,
      },
    ],
    showlegend: true,
    legend: { x: 1.02, y: 1, xanchor: 'left' },
    meta: {
      ...(typeof baseLayout.meta === 'object' && baseLayout.meta !== null ? baseLayout.meta : {}),
      showIc50Label: true,
      showCiBand: true,
    showFittedPoints: false,
    showObservedPoints: true,
      ic50Color: ic50Color,
    },
  }

  // Build stats for E2E validation (includes CI band metrics from Python)
  const stats: Record<string, number | string> = {
    // Parameter values
    ic50: ic50,
    ic50_ci_lower: params?.ic50?.ci_lower ?? 0,
    ic50_ci_upper: params?.ic50?.ci_upper ?? 0,
    bottom: bottom,
    bottom_ci_lower: params?.bottom?.ci_lower ?? 0,
    bottom_ci_upper: params?.bottom?.ci_upper ?? 0,
    top: top,
    top_ci_lower: params?.top?.ci_lower ?? 0,
    top_ci_upper: params?.top?.ci_upper ?? 0,
    hill: hill,
    hill_ci_lower: params?.hill?.ci_lower ?? 0,
    hill_ci_upper: params?.hill?.ci_upper ?? 0,

    // Plot metrics
    model_type: modelType,
    curve_point_count: curve.x.length,
    fitted_point_count: fittedYs.length,
    observed_point_count: observedYs.length,
    ci_band_point_count: ciBandDoses?.length ?? 0,
  }

  // Add asymmetry for 5PL
  if (modelType === '5PL' && params?.asymmetry) {
    stats.asymmetry = params.asymmetry.value
    stats.asymmetry_ci_lower = params.asymmetry.ci_lower ?? 0
    stats.asymmetry_ci_upper = params.asymmetry.ci_upper ?? 0
  }

  // Add goodness of fit stats
  const gof = rawOutput.goodness_of_fit as GoodnessOfFit | undefined

  if (gof) {
    if (gof.r_squared !== undefined) stats.r_squared = gof.r_squared
    if (gof.adj_r_squared !== undefined) stats.adj_r_squared = gof.adj_r_squared
    if (gof.aic !== undefined) stats.aic = gof.aic
    if (gof.bic !== undefined) stats.bic = gof.bic
    if (gof.rmse !== undefined) stats.rmse = gof.rmse
  }

  return {
    data: traces,
    layout,
    config: createDefaultConfig(),
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

export default buildDoseResponseCurveFromResult
