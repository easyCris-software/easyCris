/**
 * Loewe Isobologram Builder
 *
 * Generates classic isobologram plots for Loewe Additivity:
 * - Scatter points: Actual combination doses colored by CI value
 *   - Red (CI < 1): Synergy (below additive line)
 *   - Black (CI ~ 1): Additive (on line)
 *   - Blue (CI > 1): Antagonism (above line)
 * - Additive isobole line: Theoretical doses achieving target effect
 *   from single-agent 4PL curves
 *
 * The isobologram is the gold standard visualization for Loewe synergy.
 */

import type { PlotBuilderOutput } from './types'
import type { TestResult } from '@/store/results-store'
import type { Data, Layout } from 'plotly.js'
import { createBaseLayout, createDefaultConfig } from './common'

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface DrugFit {
  ic50: number
  hill: number
  bottom: number
  top: number
  r_squared?: number
}

interface LoeweResult {
  success: boolean
  model: string
  combination_indices?: number[][]  // CI matrix
  doses_a?: number[]
  doses_b?: number[]
  drug_a_fit?: DrugFit
  drug_b_fit?: DrugFit
  summary?: {
    mean_synergy?: number
  }
}

// =============================================================================
// BUILDER FUNCTION
// =============================================================================

/**
 * Build Loewe isobologram from result
 * Only applicable to synergy_loewe results
 */
export function buildLoeweIsobologramFromResult(result: TestResult): PlotBuilderOutput {
  const stats: Record<string, number> = {}

  // Extract result data
  const loeweResult = resolveRawOutput(result)
  if (!loeweResult || !loeweResult.success) {
    return createPlaceholderOutput('Loewe Isobologram', 'No Loewe data available')
  }

  const ciMatrix = loeweResult.combination_indices
  const dosesA = loeweResult.doses_a
  const dosesB = loeweResult.doses_b
  const drugAFit = loeweResult.drug_a_fit
  const drugBFit = loeweResult.drug_b_fit

  if (!ciMatrix || !dosesA || !dosesB) {
    return createPlaceholderOutput('Loewe Isobologram', 'Missing CI matrix or dose axes')
  }

  if (!drugAFit || !drugBFit) {
    return createPlaceholderOutput('Loewe Isobologram', 'Missing drug fit parameters')
  }

  // Extract CI values and corresponding doses for scatter points
  const pointData: { doseA: number; doseB: number; ci: number }[] = []
  for (let i = 0; i < dosesA.length; i++) {
    for (let j = 0; j < dosesB.length; j++) {
      const ci = ciMatrix[i]?.[j]
      const doseA = dosesA[i]
      const doseB = dosesB[j]

      // Only include non-zero dose combinations (exclude single-agent wells)
      if (ci !== undefined && doseA !== undefined && doseB !== undefined) {
        if (doseA > 0 && doseB > 0) {
          pointData.push({ doseA, doseB, ci })
        }
      }
    }
  }

  // Separate points by CI value for coloring
  const synergistic = pointData.filter(p => p.ci < 0.9)   // CI < 0.9 = synergy
  const additive = pointData.filter(p => p.ci >= 0.9 && p.ci <= 1.1)  // CI ~ 1 = additive
  const antagonistic = pointData.filter(p => p.ci > 1.1)  // CI > 1.1 = antagonism

  // Calculate theoretical additive isobole line
  // Target effect: 50% inhibition (IC50 equivalent)
  const targetEffect = 50
  const doseA50 = calculateDoseForEffect(targetEffect, drugAFit)
  const doseB50 = calculateDoseForEffect(targetEffect, drugBFit)

  // Additive isobole equation: doseA/doseA50 + doseB/doseB50 = 1
  // Rearrange: doseB = doseB50 * (1 - doseA/doseA50)
  const isoboleX = Array.from({ length: 100 }, (_, i) => (i / 99) * doseA50)
  const isoboleY = isoboleX.map(x => Math.max(0, doseB50 * (1 - x / doseA50)))

  // Create Plotly traces
  const data: Data[] = [
    // Additive isobole line (diagonal reference)
    {
      type: 'scatter',
      mode: 'lines',
      name: 'Additive (CI = 1)',
      x: isoboleX,
      y: isoboleY,
      line: {
        color: 'black',
        width: 2,
        dash: 'dash',
      },
      hovertemplate: 'Additive Line<br>Drug A: %{x:.3f}<br>Drug B: %{y:.3f}<extra></extra>',
    },
    // Synergistic combinations (red, below line)
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Synergy (CI < 1)',
      x: synergistic.map(p => p.doseA),
      y: synergistic.map(p => p.doseB),
      marker: {
        color: 'red',
        size: 8,
        symbol: 'circle',
      },
      text: synergistic.map(p => `CI: ${p.ci.toFixed(3)}`),
      hovertemplate: 'Drug A: %{x:.3f}<br>Drug B: %{y:.3f}<br>%{text}<extra></extra>',
    },
    // Additive combinations (black, on line)
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Additive (CI ~ 1)',
      x: additive.map(p => p.doseA),
      y: additive.map(p => p.doseB),
      marker: {
        color: 'black',
        size: 8,
        symbol: 'circle',
      },
      text: additive.map(p => `CI: ${p.ci.toFixed(3)}`),
      hovertemplate: 'Drug A: %{x:.3f}<br>Drug B: %{y:.3f}<br>%{text}<extra></extra>',
    },
    // Antagonistic combinations (blue, above line)
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Antagonism (CI > 1)',
      x: antagonistic.map(p => p.doseA),
      y: antagonistic.map(p => p.doseB),
      marker: {
        color: 'blue',
        size: 8,
        symbol: 'circle',
      },
      text: antagonistic.map(p => `CI: ${p.ci.toFixed(3)}`),
      hovertemplate: 'Drug A: %{x:.3f}<br>Drug B: %{y:.3f}<br>%{text}<extra></extra>',
    },
  ]

  // Store stats (prefixed to avoid collisions in combined plot extraction)
  const allCiValues = pointData.map((point) => point.ci).filter((value) => Number.isFinite(value))
  const ciMin = allCiValues.length > 0 ? Math.min(...allCiValues) : 0
  const ciMax = allCiValues.length > 0 ? Math.max(...allCiValues) : 0
  stats.isobologram_n_synergistic = synergistic.length
  stats.isobologram_n_additive = additive.length
  stats.isobologram_n_antagonistic = antagonistic.length
  stats.isobologram_total_points = pointData.length
  stats.isobologram_ci_min = ciMin
  stats.isobologram_ci_max = ciMax
  stats.isobologram_drug_a_ic50 = drugAFit.ic50
  stats.isobologram_drug_b_ic50 = drugBFit.ic50

  const meanSynergy = loeweResult.summary?.mean_synergy ?? 0
  const title = `Loewe Isobologram (Mean Synergy: ${meanSynergy.toFixed(2)})`

  // Axis font matching dose-response plots
  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  const finiteDosesA = dosesA.filter((value) => Number.isFinite(value))
  const finiteDosesB = dosesB.filter((value) => Number.isFinite(value))
  const maxDoseA = finiteDosesA.length > 0 ? Math.max(...finiteDosesA) : doseA50 * 1.1
  const maxDoseB = finiteDosesB.length > 0 ? Math.max(...finiteDosesB) : doseB50 * 1.1

  const layout: Partial<Layout> = {
    ...createBaseLayout({ title, showLegend: true }),
    meta: {
      plotType: 'loewe_isobologram',
    },
    xaxis: {
      title: {
        text: 'Drug A Dose',
        font: axisFont,
        standoff: 15,
      },
      type: 'linear',
      showgrid: true,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
      range: [0, maxDoseA],
    },
    yaxis: {
      title: {
        text: 'Drug B Dose',
        font: axisFont,
      },
      type: 'linear',
      showgrid: true,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
      range: [0, maxDoseB],
    },
    legend: {
      x: 1.02,
      y: 1,
      xanchor: 'left',
      yanchor: 'top',
    },
  }

  return {
    data,
    layout,
    config: createDefaultConfig(),
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Calculate dose achieving target effect from 4PL curve
 * 4PL equation: response = bottom + (top - bottom) / (1 + (dose/ic50)^(-hill))
 * Rearrange to solve for dose:
 *   dose = ic50 * ((top - bottom) / (effect - bottom) - 1)^(-1/hill)
 */
function calculateDoseForEffect(effect: number, fit: DrugFit): number {
  const { ic50, hill, bottom, top } = fit

  // Handle edge cases
  if (effect <= bottom) return 0
  if (effect >= top) return Infinity

  // Calculate dose from rearranged 4PL equation
  const ratio = (top - bottom) / (effect - bottom)
  const dose = ic50 * Math.pow(ratio - 1, -1 / Math.abs(hill))

  return dose
}

function resolveRawOutput(result: TestResult): LoeweResult | null {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return null

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown as LoeweResult
      return parsed
    } catch {
      return null
    }
  }

  return raw as unknown as LoeweResult
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
