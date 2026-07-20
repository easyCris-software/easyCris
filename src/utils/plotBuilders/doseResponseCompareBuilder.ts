/**
 * Dose-Response Model Comparison Builder
 *
 * Overlays 3PL, 4PL, 5PL fitted curves on single plot for visual comparison.
 * Includes legend with AIC/BIC values for model selection.
 * Recommended model is highlighted with thicker line.
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
  ci_lower?: number
  ci_upper?: number
}

interface DoseResponseParameters {
  bottom: ParameterValue
  top: ParameterValue
  ic50: ParameterValue
  hill: ParameterValue
  asymmetry?: ParameterValue
}

interface GoodnessOfFit {
  r_squared?: number
  adj_r_squared?: number
  aic?: number
  bic?: number
  rmse?: number
}

interface DoseResponseModelResult {
  success: boolean
  parameters: DoseResponseParameters
  goodness_of_fit?: GoodnessOfFit
}

interface ModelComparison {
  aic_ranking?: Array<{ model: string; aic: number; delta_aic: number }>
  recommended_model?: string
}

function normalizeDoseResponseModelType(value?: string): '3PL' | '4PL' | '5PL' {
  if (!value) return '4PL'
  const cleaned = value.replace(/_DRC.*$/i, '').replace(/_SCALED$/i, '')
  const upper = cleaned.toUpperCase()
  if (upper.startsWith('3PL')) return '3PL'
  if (upper.startsWith('4PL')) return '4PL'
  if (upper.startsWith('5PL')) return '5PL'
  if (upper.includes('DOSE_RESPONSE_3PL')) return '3PL'
  if (upper.includes('DOSE_RESPONSE_4PL')) return '4PL'
  if (upper.includes('DOSE_RESPONSE_5PL')) return '5PL'
  return '4PL'
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

// =============================================================================
// MODEL FUNCTIONS
// =============================================================================

function fourPL(dose: number, bottom: number, top: number, ic50: number, hill: number): number {
  if (dose <= 0 || ic50 <= 0) return bottom
  return bottom + (top - bottom) / (1 + Math.pow(dose / ic50, -hill))
}

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

function generateFittedCurve(
  params: { bottom: number; top: number; ic50: number; hill: number; asymmetry?: number },
  doseRange: [number, number],
  modelType: '3PL' | '4PL' | '5PL',
  nPoints: number = 100
): { x: number[]; y: number[] } {
  const { bottom, top, ic50, hill, asymmetry = 1.0 } = params
  const logMin = Math.log10(Math.max(doseRange[0], 1e-10))
  const logMax = Math.log10(doseRange[1])

  const x: number[] = []
  const y: number[] = []

  for (let i = 0; i < nPoints; i++) {
    const logDose = logMin + (logMax - logMin) * (i / (nPoints - 1))
    const dose = Math.pow(10, logDose)

    let response: number
    if (modelType === '5PL') {
      response = fivePL(dose, bottom, top, ic50, hill, asymmetry)
    } else {
      response = fourPL(dose, bottom, top, ic50, hill)
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
 * Build dose-response model comparison overlay plot from test result
 *
 * Expects result.rawOutput to contain:
 * - models: { '3PL'?: DoseResponseModelResult, '4PL'?: DoseResponseModelResult, '5PL'?: DoseResponseModelResult }
 * - comparison: { aic_ranking?: Array<{ model, aic, delta_aic }>, recommended_model?: string }
 * - input_doses: number[] (preserved from payload)
 * - input_responses: number[] (recovered from fitted + residuals)
 */
export function buildDoseResponseCompareFromResult(result: TestResult): PlotBuilderOutput | null {
  const rawOutput = resolveRawOutput(result)
  if (!rawOutput) return null

  const models = rawOutput.models as
    | {
        '3PL'?: DoseResponseModelResult
        '4PL'?: DoseResponseModelResult
        '5PL'?: DoseResponseModelResult
      }
    | undefined

  const comparison = rawOutput.comparison as ModelComparison | undefined

  if (!models) {
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

  // Determine dose range from input data (use actual range, not artificially expanded)
  const positiveDoses = inputDoses?.filter((d) => d > 0) ?? []
  const minDose = positiveDoses.length > 0 ? Math.min(...positiveDoses) : 0.001
  const maxDose = positiveDoses.length > 0 ? Math.max(...positiveDoses) : 1000

  // Build Plotly traces
  const traces: Data[] = []

  // Color palette for models
  const colors: Record<string, string> = {
    '3PL': '#1f77b4', // blue
    '4PL': '#ff7f0e', // orange
    '5PL': '#2ca02c', // green
  }

  // Add curve for each model that succeeded
  const modelEntries = Object.entries(models) as Array<[string, DoseResponseModelResult | undefined]>
  for (const [modelType, modelResult] of modelEntries) {
    if (!modelResult) continue
    const isSuccess =
      (modelResult as { success?: boolean }).success ??
      (modelResult as { fitted?: boolean }).fitted ??
      false
    if (!isSuccess || !modelResult.parameters) continue

    const normalizedType = normalizeDoseResponseModelType(modelType)
    const params = modelResult.parameters
    const fixedBottom = toNumber((modelResult as { fixed_bottom?: unknown }).fixed_bottom)
    const bottomValue = toNumber(params.bottom?.value) ?? fixedBottom ?? 0
    const topValue = toNumber(params.top?.value)
    const ic50Value = toNumber(params.ic50?.value)
    const hillValue = toNumber(params.hill?.value)
    const asymmetryValue = toNumber(params.asymmetry?.value) ?? 1.0
    if (topValue === null || ic50Value === null || hillValue === null) {
      continue
    }
    const curve = generateFittedCurve(
      {
        bottom: bottomValue,
        top: topValue,
        ic50: ic50Value,
        hill: hillValue,
        asymmetry: asymmetryValue,
      },
      [minDose, maxDose],
      normalizedType
    )

    // Get AIC for legend
    const aicValue = toNumber(modelResult.goodness_of_fit?.aic)
    const aicLabel = aicValue === null ? 'n/a' : aicValue.toFixed(1)
    const isRecommended =
      normalizeDoseResponseModelType(comparison?.recommended_model) === normalizedType

    traces.push({
      type: 'scatter',
      mode: 'lines',
      x: curve.x,
      y: curve.y,
      name: `${normalizedType} (AIC: ${aicLabel})${isRecommended ? ' *' : ''}`,
      line: {
        color: colors[normalizedType] ?? '#333333',
        width: isRecommended ? 3 : 2,
        dash: isRecommended ? 'solid' : 'dot',
      },
    })
  }

  // Add observed points
  if (inputDoses && inputResponses && inputDoses.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      x: inputDoses,
      y: inputResponses,
      name: 'Observed',
      marker: { color: '#333333', size: 8, symbol: 'circle' },
    })
  }

  const rangeValues: number[] = []
  if (inputResponses && inputResponses.length > 0) {
    rangeValues.push(...inputResponses)
  }
  for (const [, modelResult] of modelEntries) {
    if (!modelResult?.parameters) continue
    const params = modelResult.parameters
    const topValue = toNumber(params.top?.value)
    const bottomValue =
      toNumber(params.bottom?.value) ??
      toNumber((modelResult as { fixed_bottom?: unknown }).fixed_bottom)
    if (topValue !== null) rangeValues.push(topValue)
    if (bottomValue !== null) rangeValues.push(bottomValue)
  }

  const [yAxisMin, yAxisMax] = calculateBarPlotRange(rangeValues, 0.05)

  const baseLayout = createBaseLayout({
    title: 'Dose-Response Model Comparison',
    showLegend: true,
  })
  const axisFont = {
    ...(baseLayout.font ?? { family: 'Inter, sans-serif', size: 12, color: '#333333' }),
    weight: 700,
  }

  // Build layout with consistent axis styling
  const layout: Partial<Layout> = {
    ...baseLayout,
    title: { text: 'Dose-Response Model Comparison' },
    xaxis: {
      title: {
        text: 'Dose (log scale)',
        font: axisFont,
        standoff: 15,
      },
      type: 'log',
      dtick: 1, // Plotly native: ticks at every power of 10 (1, 10, 100, 1000)
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
    showlegend: true,
    legend: { x: 1.02, y: 1, xanchor: 'left' },
    meta: {
      ...(typeof baseLayout.meta === 'object' && baseLayout.meta !== null ? baseLayout.meta : {}),
      showIc50Label: true,
      showCiBand: true,
    },
  }

  // Build stats for E2E validation
  const stats: Record<string, number | string> = {
    recommended_model: comparison?.recommended_model ?? 'N/A',
    models_fitted: Object.values(models).filter((m) => {
      if (!m) return false
      return (m as { success?: boolean }).success ?? (m as { fitted?: boolean }).fitted ?? false
    }).length,
    observed_point_count: inputDoses?.length ?? 0,
  }

  // Add per-model AIC values
  for (const [modelType, modelResult] of modelEntries) {
    const normalizedType = normalizeDoseResponseModelType(modelType)
    if (modelResult?.goodness_of_fit?.aic !== undefined) {
      stats[`${normalizedType.toLowerCase()}_aic`] = modelResult.goodness_of_fit.aic
    }
    if (modelResult?.parameters?.ic50?.value !== undefined) {
      stats[`${normalizedType.toLowerCase()}_ic50`] = modelResult.parameters.ic50.value
    }
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

export default buildDoseResponseCompareFromResult
