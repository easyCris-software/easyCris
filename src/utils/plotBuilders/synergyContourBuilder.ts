/**
 * Synergy Contour Plot Builder
 *
 * Generates 2D filled contour plots for drug synergy:
 * - Smooth interpolated regions (not discrete heatmap cells)
 * - Red-White-Blue diverging colorscale (red=synergy, blue=antagonism)
 * - Mean synergy score displayed in title
 * - Supports all 4 models: Bliss, HSA, Loewe, ZIP
 *
 * Data source: Reads directly from Python result structure (not column roles)
 */

import type { PlotBuilderOutput } from './types'
import type { TestResult } from '@/store/results-store'
import type { Data, Layout } from 'plotly.js'
import { createBaseLayout, createDefaultConfig } from './common'

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface SynergyResult {
  success: boolean
  model?: string
  synergy_matrix?: number[][]  // Bliss, HSA, Loewe
  zip_scores?: number[][]       // ZIP uses different key
  doses_a?: number[]
  doses_b?: number[]
  summary?: {
    mean_synergy?: number
    max_synergy?: number
    min_synergy?: number
    synergistic_fraction?: number
  }
  models?: Record<string, SynergyResult>  // For synergy_all
}

// =============================================================================
// BUILDER FUNCTION FOR INDIVIDUAL MODEL RESULTS
// =============================================================================

/**
 * Build synergy contour plot from individual model result
 * (synergy_bliss, synergy_hsa, synergy_loewe, synergy_zip)
 */
export function buildSynergyContourFromResult(result: TestResult): PlotBuilderOutput {
  const stats: Record<string, number> = {}

  // Extract result data
  const synergyResult = resolveRawOutput(result)
  if (!synergyResult || !synergyResult.success) {
    return createPlaceholderOutput('Synergy Contour', 'No synergy data available')
  }

  // Get synergy matrix (handle ZIP's different key name)
  const model = synergyResult.model || 'Unknown'
  const zKey = model === 'ZIP' ? 'zip_scores' : 'synergy_matrix'
  const synergyMatrix =
    (model === 'ZIP' ? synergyResult.zip_scores : synergyResult.synergy_matrix) ??
    synergyResult.synergy_matrix ??
    synergyResult.zip_scores

  if (!synergyMatrix || synergyMatrix.length === 0) {
    return createPlaceholderOutput('Synergy Contour', `No ${zKey} data in result`)
  }

  const dosesA = synergyResult.doses_a
  const dosesB = synergyResult.doses_b
  if (!dosesA || !dosesB) {
    return createPlaceholderOutput('Synergy Contour', 'Missing dose axes (doses_a/doses_b)')
  }

  const meanSynergy = synergyResult.summary?.mean_synergy ?? 0

  const flatValues = synergyMatrix.flat().filter((value) => Number.isFinite(value))
  const minValue = flatValues.length > 0 ? Math.min(...flatValues) : 0
  const maxValue = flatValues.length > 0 ? Math.max(...flatValues) : 0
  const maxAbs = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-6)

  // Store stats for E2E validation (prefixed to avoid collisions)
  stats.contour_mean_synergy = meanSynergy
  stats.contour_min_synergy = minValue
  stats.contour_max_synergy = maxValue
  stats.contour_n_doses_a = dosesA.length
  stats.contour_n_doses_b = dosesB.length
  stats.contour_total_points = dosesA.length * dosesB.length
  stats.contour_zmin = -maxAbs
  stats.contour_zmax = maxAbs

  const formatDoseLabel = (value: number) => {
    if (!Number.isFinite(value)) return ''
    return value.toString()
  }

  const buildLogAxis = (doses: number[]) => {
    const positives = doses.filter((dose) => dose > 0)
    if (positives.length === 0) {
      return {
        plotDoses: doses,
        tickVals: undefined,
        tickText: undefined,
        useLog: false,
      }
    }

    const minPositive = Math.min(...positives)
    const zeroReplacement = minPositive * 0.1
    const plotDoses = doses.map((dose) => Math.log10(dose > 0 ? dose : zeroReplacement))
    const tickPairs = doses.map((dose, index) => ({
      value: plotDoses[index]!,
      label: formatDoseLabel(dose),
    }))

    const tickValSet = new Set<number>()
    const tickVals: number[] = []
    const tickText: string[] = []
    for (const pair of tickPairs) {
      if (tickValSet.has(pair.value)) continue
      tickValSet.add(pair.value)
      tickVals.push(pair.value)
      tickText.push(pair.label)
    }

    return {
      plotDoses,
      tickVals,
      tickText,
      useLog: false,
    }
  }

  const axisA = buildLogAxis(dosesA)
  const axisB = buildLogAxis(dosesB)

  // Plotly expects z as [y][x], but synergyMatrix is [dose_a][dose_b].
  const plotMatrix = synergyMatrix[0]
    ? synergyMatrix[0].map((_, colIndex) => synergyMatrix.map((row) => row[colIndex]!))
    : synergyMatrix

  const customdata = dosesB.map((doseB) =>
    dosesA.map((doseA) => [doseA, doseB]),
  )

  // Create contour plot data
  const colorbarX = 1.02
  const colorbarLen = 0.88
  const colorbarPad = 6
  const colorbarTitleX = 1.04

  const data: Data[] = [
    {
      type: 'contour',
      z: plotMatrix,
      x: axisA.plotDoses,
      y: axisB.plotDoses,
      contours: {
        coloring: 'fill',  // Filled regions for smooth contours
        showlines: true,
        size: maxAbs / 10,  // 20 levels total (10 positive, 10 negative) for finer detail
        start: -maxAbs,
        end: maxAbs,
      },
      line: {
        smoothing: 0.85,  // Reduce smoothing from default 1.3 to prevent hotspot enlargement
      },
      colorscale: [
        [0, 'rgb(0,0,255)'],        // Blue = antagonism (negative synergy)
        [0.5, 'rgb(255,255,255)'],  // White = additive (zero synergy)
        [1, 'rgb(255,0,0)'],        // Red = synergy (positive synergy)
      ],
      zmin: -maxAbs,
      zmax: maxAbs,
      zmid: 0,
      colorbar: {
        title: { text: '' },
        tickformat: '.2f',
        x: colorbarX,
        xanchor: 'left',
        xpad: colorbarPad,
        len: colorbarLen,
      },
      customdata,
      hovertemplate:
        'Drug A: %{customdata[0]}<br>Drug B: %{customdata[1]}<br>Synergy: %{z:.2f}<extra></extra>',
    },
  ]

  // Create layout with mean synergy in title
  const title = `${model} Synergy (Mean: ${meanSynergy.toFixed(2)})`

  // Axis font matching dose-response plots
  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  const baseLayout = createBaseLayout({ title, showLegend: false })
  const existingAnnotations =
    (baseLayout as { annotations?: Layout['annotations'] }).annotations ?? []
  const colorbarTitle: Layout['annotations'] = [
    {
      xref: 'paper',
      yref: 'paper',
      x: colorbarTitleX,
      y: 1.0,
      xanchor: 'left',
      yanchor: 'bottom',
      text: 'Synergy Score',
      showarrow: false,
      font: axisFont,
    },
  ]

  // Use log10-transformed doses on linear axes to match ggplot tile widths
  const layout: Partial<Layout> = {
    ...baseLayout,
    meta: {
      ...(baseLayout.meta ?? {}),
      plotType: 'synergy_contour',
    },
    annotations: [...existingAnnotations, ...colorbarTitle],
    xaxis: {
      title: {
        text: 'Drug A Dose',
        font: axisFont,
        standoff: 15,  // Space between title and axis
      },
      type: axisA.useLog ? 'log' : 'linear',
      exponentformat: 'none',  // Prevent exponential notation (e.g., 10^0) - keeps "1" readable
      tickmode: axisA.tickVals && axisA.tickText ? 'array' : 'auto',
      tickvals: axisA.tickVals,
      ticktext: axisA.tickText,
      automargin: true,
      showgrid: true,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
    },
    yaxis: {
      title: {
        text: 'Drug B Dose',
        font: axisFont,
      },
      type: axisB.useLog ? 'log' : 'linear',
      exponentformat: 'none',  // Prevent exponential notation (e.g., 10^0) - keeps "1" readable
      tickmode: axisB.tickVals && axisB.tickText ? 'array' : 'auto',
      tickvals: axisB.tickVals,
      ticktext: axisB.tickText,
      automargin: true,
      showgrid: true,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
    },
    margin: {
      ...(baseLayout.margin ?? {}),
      r: 240,
    },
  }

  const baseConfig = createDefaultConfig()

  return {
    data,
    layout,
    config: {
      ...baseConfig,
      edits: {
        ...(baseConfig.edits ?? {}),
        colorbarTitle: false,
        annotationPosition: true,  // Allow dragging annotations
        annotationText: false,     // Prevent text editing (no "click to enter" hint)
      },
    },
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

// =============================================================================
// BUILDER FUNCTION FOR synergy_all RESULTS
// =============================================================================

/**
 * Build multiple synergy contour plots from synergy_all result
 * Returns one contour plot per model (Bliss, HSA, Loewe, ZIP)
 */
export interface SynergyContourPlot {
  modelName: string
  plot: PlotBuilderOutput
}

export function buildSynergyContourPlotsFromAll(result: TestResult): SynergyContourPlot[] {
  const rawOutput = resolveRawOutput(result)
  if (!rawOutput || !rawOutput.success) {
    return []
  }

  // synergy_all has: { models: { Bliss: {...}, HSA: {...}, Loewe: {...}, ZIP: {...} } }
  const models = rawOutput.models as Record<string, SynergyResult> | undefined
  if (!models || typeof models !== 'object') {
    return []
  }

  const plots: SynergyContourPlot[] = []

  // Generate contour plot for each model
  const modelOrder = ['Bliss', 'HSA', 'Loewe', 'ZIP']
  for (const modelName of modelOrder) {
    const modelResult = models[modelName]
    if (!modelResult) continue
    const tempResult: TestResult = { ...result, rawOutput: modelResult }
    plots.push({
      modelName,
      plot: buildSynergyContourFromResult(tempResult),
    })
  }

  return plots
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function resolveRawOutput(result: TestResult): SynergyResult | null {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return null

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown as SynergyResult
      return parsed
    } catch {
      return null
    }
  }

  return raw as unknown as SynergyResult
}

function createPlaceholderOutput(title: string, message: string): PlotBuilderOutput {
  return {
    data: [
      {
        type: 'scatter',
        x: [0],
        y: [0],
        mode: 'text',
        text: [message],
        textfont: { size: 14, color: '#666' },
        showlegend: false,
      },
    ],
    layout: {
      ...createBaseLayout({ title, showLegend: false }),
      xaxis: { visible: false },
      yaxis: { visible: false },
    },
    config: createDefaultConfig(),
    stats: {},
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}
