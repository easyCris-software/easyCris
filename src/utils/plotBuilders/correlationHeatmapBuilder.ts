/**
 * Correlation Heatmap Plot Builder
 *
 * Generates correlation matrix heatmaps for Pearson, Spearman, and Kendall correlations.
 * Uses the shared matrixHeatmapHelper for consistent styling with synergy heatmaps.
 *
 * Data source: Reads correlation_matrices from Python result (all 3 types computed together)
 */

import type { PlotBuilderOutput } from './types'
import type { TestResult } from '@/store/results-store'
import { buildMatrixHeatmap } from './matrixHeatmapHelper'
import { createDefaultConfig } from './common'

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface CorrelationResult {
  success: boolean
  correlation_matrices?: {
    pearson?: number[][]
    spearman?: number[][]
    kendall?: number[][]
  }
  correlation_matrix_labels?: string[]
  pearson?: {
    correlation?: number
  }
  spearman?: {
    correlation?: number
  }
  kendall?: {
    correlation?: number
  }
  n?: number
}

// =============================================================================
// BUILDER FUNCTIONS
// =============================================================================

/**
 * Build Pearson correlation heatmap from test result
 */
export function buildPearsonCorrelationHeatmap(result: TestResult): PlotBuilderOutput {
  return buildCorrelationHeatmapForType(result, 'pearson', 'Pearson')
}

/**
 * Build Spearman correlation heatmap from test result
 */
export function buildSpearmanCorrelationHeatmap(result: TestResult): PlotBuilderOutput {
  return buildCorrelationHeatmapForType(result, 'spearman', 'Spearman')
}

/**
 * Build Kendall correlation heatmap from test result
 */
export function buildKendallCorrelationHeatmap(result: TestResult): PlotBuilderOutput {
  return buildCorrelationHeatmapForType(result, 'kendall', 'Kendall')
}

/**
 * Build correlation heatmap for a specific correlation type
 */
function buildCorrelationHeatmapForType(
  result: TestResult,
  type: 'pearson' | 'spearman' | 'kendall',
  typeName: string,
): PlotBuilderOutput {
  const corrResult = resolveRawOutput(result)
  if (!corrResult || !corrResult.success) {
    return createPlaceholderOutput(
      `${typeName} Correlation Heatmap`,
      'No correlation data available',
    )
  }

  const matrices = corrResult.correlation_matrices
  if (!matrices || !matrices[type]) {
    return createPlaceholderOutput(
      `${typeName} Correlation Heatmap`,
      `No ${type} correlation matrix found`,
    )
  }

  const matrix = matrices[type]!
  const rawLabels = corrResult.correlation_matrix_labels
  const nVars = matrix.length
  const labels =
    rawLabels && rawLabels.length === nVars
      ? rawLabels
      : Array.from({ length: nVars }, (_, idx) => `Variable ${idx + 1}`)

  // Only render heatmap if matrix is at least 3x3 (3+ variables)
  const rowLength = matrix[0]?.length ?? 0
  if (nVars < 3 || rowLength < 3) {
    return createPlaceholderOutput(
      `${typeName} Correlation Heatmap`,
      `Heatmap requires at least 3 variables (got ${nVars}). Use scatter plot for pairwise correlation.`,
    )
  }

  // Get correlation coefficient for annotation (from pairwise stats)
  const corrObj = corrResult[type]
  const r =
    typeof corrObj?.correlation === 'number'
      ? corrObj.correlation
      : Number.parseFloat(String(corrObj?.correlation ?? 0))

  const axisPositions = Array.from({ length: nVars }, (_, idx) => idx)

  // Build heatmap using helper
  const heatmapOutput = buildMatrixHeatmap({
    matrix,
    xLabels: axisPositions,
    yLabels: axisPositions,
    title: `${typeName} Correlation Matrix (r = ${r.toFixed(3)})`,
    xAxisTitle: '',
    yAxisTitle: '',
    colorbarTitle: 'Correlation',
    symmetricScale: true,  // Correlation ranges from -1 to +1
    xTickVals: axisPositions,
    xTickText: labels,
    yTickVals: axisPositions,
    yTickText: labels,
    colorscale: [
      [0, 'rgb(0,0,255)'],        // Blue = negative correlation
      [0.5, 'rgb(255,255,255)'],  // White = no correlation
      [1, 'rgb(255,0,0)'],        // Red = positive correlation
    ],
    showText: true,
    textDecimals: 3,
    hovertemplate: `<b>%{x} vs %{y}</b><br>Correlation: %{z:.3f}<extra></extra>`,
  })

  // Add correlation-specific stats (for E2E validation)
  const n = corrResult.n ?? 0
  // Off-diagonal stats (exclude diagonal 1.0 values)
  const offDiagonal: number[] = []
  for (let i = 0; i < nVars; i++) {
    for (let j = 0; j < nVars; j++) {
      if (i === j) continue
      const val = matrix[i]?.[j]
      if (val !== undefined && Number.isFinite(val)) {
        offDiagonal.push(val)
      }
    }
  }

  // Calculate diagonal mean (should be 1.0 for correlation matrix)
  const diagValues: number[] = []
  for (let i = 0; i < Math.min(matrix.length, matrix[0]?.length ?? 0); i++) {
    const val = matrix[i]?.[i]
    if (val !== undefined && Number.isFinite(val)) {
      diagValues.push(val)
    }
  }
  const diagMean = diagValues.length > 0
    ? diagValues.reduce((sum, v) => sum + v, 0) / diagValues.length
    : 0

  const stats = {
    ...heatmapOutput.stats,
    n_vars: labels.length,
    min_corr: offDiagonal.length > 0 ? Math.min(...offDiagonal) : 0,
    max_corr: offDiagonal.length > 0 ? Math.max(...offDiagonal) : 0,
    mean_corr: offDiagonal.length > 0
      ? offDiagonal.reduce((sum, v) => sum + v, 0) / offDiagonal.length
      : 0,
    diag_mean: diagMean,
    n_points: n,
    correlation_type: type,
  }

  return {
    data: heatmapOutput.data,
    layout: {
      ...heatmapOutput.layout,
      meta: {
        ...heatmapOutput.layout.meta,
        plotType: `correlation_heatmap_${type}`,
      },
    },
    config: {
      ...createDefaultConfig(),
      edits: {
        colorbarTitleText: false,
        annotationPosition: true,
        annotationText: false,
      },
    },
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function resolveRawOutput(result: TestResult): CorrelationResult | null {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return null

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CorrelationResult
    } catch {
      return null
    }
  }

  return raw as unknown as CorrelationResult
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
      title: { text: title },
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
