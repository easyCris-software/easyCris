/**
 * ROC Curve Plot Builder
 *
 * Generates Receiver Operating Characteristic (ROC) curves for binary logistic regression.
 * Shows True Positive Rate (TPR) vs False Positive Rate (FPR) with AUC annotation.
 *
 * Data source: Reads roc_fpr and roc_tpr from Python result (already computed)
 */

import type { PlotBuilderOutput } from './types'
import type { TestResult } from '@/store/results-store'
import type { Data, Layout } from 'plotly.js'
import { createBaseLayout, createDefaultConfig } from './common'

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface LogisticRegressionResult {
  success: boolean
  roc_fpr?: number[]  // False Positive Rate (binary)
  roc_tpr?: number[]  // True Positive Rate (binary)
  roc_thresholds?: number[]  // Thresholds (binary)
  auc_roc?: number    // Area Under Curve (binary)
  auc_roc_macro?: number  // Macro AUC (multiclass)
  roc_curves?: {      // ROC curves (multiclass, one-vs-rest)
    [classIdx: string]: {
      fpr: number[] | null
      tpr: number[] | null
      auc: number | null
      thresholds?: number[] | null
    }
  }
  category_mapping?: Record<string, string>  // Class labels
  goodness_of_fit?: {
    roc_auc?: {
      auc?: number
      macro_auc?: number
    }
  }
}

// =============================================================================
// BUILDER FUNCTION
// =============================================================================

/**
 * Build ROC curve plot from binary logistic regression result
 */
export function buildROCCurveFromResult(result: TestResult): PlotBuilderOutput {
  const stats: Record<string, number> = {}

  const logisticResult = resolveRawOutput(result)
  if (!logisticResult || !logisticResult.success) {
    return createPlaceholderOutput('ROC Curve', 'No logistic regression data available')
  }

  const fpr = logisticResult.roc_fpr
  const tpr = logisticResult.roc_tpr
  const thresholds = logisticResult.roc_thresholds

  if (!fpr || !tpr || fpr.length === 0 || tpr.length === 0) {
    return createPlaceholderOutput('ROC Curve', 'No ROC curve data (roc_fpr/roc_tpr) found')
  }

  if (fpr.length !== tpr.length) {
    return createPlaceholderOutput(
      'ROC Curve',
      `ROC data length mismatch: fpr=${fpr.length}, tpr=${tpr.length}`,
    )
  }

  // Get AUC value (try multiple possible locations in result)
  const auc =
    logisticResult.auc_roc ??
    logisticResult.goodness_of_fit?.roc_auc?.auc ??
    0

  // Calculate stats for E2E validation
  const fprFiltered = fpr.filter((v) => Number.isFinite(v))
  const tprFiltered = tpr.filter((v) => Number.isFinite(v))

  const fprMedian = median(fprFiltered)
  const tprMedian = median(tprFiltered)
  const thresholdFiltered = Array.isArray(thresholds)
    ? thresholds.filter((v) => Number.isFinite(v))
    : []
  const thresholdMin = thresholdFiltered.length > 0 ? Math.min(...thresholdFiltered) : 0
  const thresholdMax = thresholdFiltered.length > 0 ? Math.max(...thresholdFiltered) : 0

  // Legacy keys (backward compatibility with existing baselines)
  stats.roc_points = fpr.length
  stats.auc = auc
  stats.fpr_min = fprFiltered.length > 0 ? Math.min(...fprFiltered) : 0
  stats.fpr_max = fprFiltered.length > 0 ? Math.max(...fprFiltered) : 1
  stats.tpr_min = tprFiltered.length > 0 ? Math.min(...tprFiltered) : 0
  stats.tpr_max = tprFiltered.length > 0 ? Math.max(...tprFiltered) : 1

  // Canonical keys (new baseline)
  stats.roc_point_count = fpr.length
  stats.roc_auc = auc
  stats.roc_fpr_min = stats.fpr_min
  stats.roc_fpr_max = stats.fpr_max
  stats.roc_tpr_min = stats.tpr_min
  stats.roc_tpr_max = stats.tpr_max
  if (fprMedian !== null) stats.roc_fpr_median = fprMedian
  if (tprMedian !== null) stats.roc_tpr_median = tprMedian
  stats.roc_threshold_min = thresholdMin
  stats.roc_threshold_max = thresholdMax

  // Create ROC curve trace
  const rocTrace: Data = {
    type: 'scatter',
    mode: 'lines',
    x: fpr,
    y: tpr,
    name: `ROC Curve (AUC = ${auc.toFixed(3)})`,
    line: {
      color: '#2563eb',  // Blue
      width: 2,
    },
    hovertemplate: 'FPR: %{x:.3f}<br>TPR: %{y:.3f}<extra></extra>',
  }

  // Create diagonal reference line (random classifier)
  const refTrace: Data = {
    type: 'scatter',
    mode: 'lines',
    x: [0, 1],
    y: [0, 1],
    name: 'Random Classifier',
    line: {
      color: '#9ca3af',  // Gray
      width: 1,
      dash: 'dash',
    },
    hoverinfo: 'skip',
    showlegend: true,
  }

  const data: Data[] = [rocTrace, refTrace]

  // Axis font
  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  // Create layout
  const baseLayout = createBaseLayout({
    title: `ROC Curve (AUC = ${auc.toFixed(3)})`,
    showLegend: true,
  })

  const layout: Partial<Layout> = {
    ...baseLayout,
    meta: {
      ...(baseLayout.meta ?? {}),
    },
    xaxis: {
      title: {
        text: 'False Positive Rate (1 - Specificity)',
        font: axisFont,
      },
      range: [0, 1],
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
      showgrid: true,
      gridcolor: '#e5e7eb',
      zeroline: true,
    },
    yaxis: {
      title: {
        text: 'True Positive Rate (Sensitivity)',
        font: axisFont,
      },
      range: [0, 1],
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
      showgrid: true,
      gridcolor: '#e5e7eb',
      zeroline: true,
    },
    legend: {
      x: 0.98,
      y: 0.02,
      xanchor: 'right',
      yanchor: 'bottom',
      bgcolor: 'rgba(255,255,255,0.8)',
      bordercolor: '#111827',
      borderwidth: 1,
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

/**
 * Build multiclass ROC curve plot (one-vs-rest) from multinomial logistic regression result
 */
export function buildMulticlassROCCurveFromResult(result: TestResult): PlotBuilderOutput {
  const stats: Record<string, number> = {}

  const logisticResult = resolveRawOutput(result)
  if (!logisticResult || !logisticResult.success) {
    return createPlaceholderOutput('ROC Curve', 'No logistic regression data available')
  }

  const rocCurves = logisticResult.roc_curves
  if (!rocCurves || Object.keys(rocCurves).length === 0) {
    return createPlaceholderOutput(
      'ROC Curve',
      'No ROC curve data (roc_curves) found. This plot requires Python backend to compute ROC curves.',
    )
  }

  const categoryMapping = logisticResult.category_mapping ?? {}
  const data: Data[] = []

  // Color palette for classes (default discrete scale)
  const colors = ['#F8766D', '#00BFC4', '#00BA38', '#C77CFF', '#F564E3', '#619CFF']

  // Create one trace per class (one-vs-rest)
  let hasCurve = false
  Object.keys(rocCurves)
    .sort()
    .forEach((classIdx, idx) => {
      const curve = rocCurves[classIdx]
      if (!curve || !curve.fpr || !curve.tpr || curve.fpr.length === 0 || curve.tpr.length === 0) {
        return
      }

      hasCurve = true
      const classLabel = categoryMapping[classIdx] ?? `Class ${classIdx}`
      const classKey = sanitizeLabel(classLabel)
      const auc = curve.auc ?? 0

      const rocTrace: Data = {
        type: 'scatter',
        mode: 'lines',
        x: curve.fpr,
        y: curve.tpr,
        name: `${classLabel} (AUC = ${auc.toFixed(3)})`,
        line: {
          color: colors[idx % colors.length],
          width: 2,
        },
        hovertemplate: `${classLabel}<br>FPR: %{x:.3f}<br>TPR: %{y:.3f}<extra></extra>`,
      }

      data.push(rocTrace)

      // Calculate stats for this class
      const fprFiltered = curve.fpr.filter((v) => Number.isFinite(v))
      const tprFiltered = curve.tpr.filter((v) => Number.isFinite(v))
      const fprMin = fprFiltered.length > 0 ? Math.min(...fprFiltered) : 0
      const fprMax = fprFiltered.length > 0 ? Math.max(...fprFiltered) : 1
      const tprMin = tprFiltered.length > 0 ? Math.min(...tprFiltered) : 0
      const tprMax = tprFiltered.length > 0 ? Math.max(...tprFiltered) : 1

      // Legacy keys
      stats[`auc_class_${classIdx}`] = auc
      stats[`points_class_${classIdx}`] = curve.fpr.length

      // Canonical keys (label-based)
      stats[`roc_auc_${classKey}`] = auc
      stats[`roc_${classKey}_point_count`] = curve.fpr.length
      stats[`roc_${classKey}_fpr_min`] = fprMin
      stats[`roc_${classKey}_fpr_max`] = fprMax
      stats[`roc_${classKey}_tpr_min`] = tprMin
      stats[`roc_${classKey}_tpr_max`] = tprMax
    })

  // Create diagonal reference line (random classifier)
  const refTrace: Data = {
    type: 'scatter',
    mode: 'lines',
    x: [0, 1],
    y: [0, 1],
    name: 'Random Classifier',
    line: {
      color: '#9ca3af', // Gray
      width: 1,
      dash: 'dash',
    },
    hoverinfo: 'skip',
    showlegend: true,
  }

  data.push(refTrace)

  if (!hasCurve) {
    return createPlaceholderOutput('ROC Curve', 'No usable ROC curve data found for any class')
  }

  // Axis font
  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  // Get macro AUC if available
  const macroAuc = logisticResult.auc_roc_macro ?? logisticResult.goodness_of_fit?.roc_auc?.macro_auc
  const titleSuffix = macroAuc !== undefined ? ` (Macro AUC = ${macroAuc.toFixed(3)})` : ''

  // Create layout
  const baseLayout = createBaseLayout({
    title: `ROC Curves (One-vs-Rest)${titleSuffix}`,
    showLegend: true,
  })

  const layout: Partial<Layout> = {
    ...baseLayout,
    meta: {
      ...(baseLayout.meta ?? {}),
    },
    xaxis: {
      title: {
        text: 'False Positive Rate (1 - Specificity)',
        font: axisFont,
      },
      range: [0, 1],
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
      showgrid: true,
      gridcolor: '#e5e7eb',
      zeroline: true,
    },
    yaxis: {
      title: {
        text: 'True Positive Rate (Sensitivity)',
        font: axisFont,
      },
      range: [0, 1],
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
      showgrid: true,
      gridcolor: '#e5e7eb',
      zeroline: true,
    },
    legend: {
      x: 0.98,
      y: 0.02,
      xanchor: 'right',
      yanchor: 'bottom',
      bgcolor: 'rgba(255,255,255,0.8)',
      bordercolor: '#111827',
      borderwidth: 1,
    },
  }

  if (macroAuc !== undefined) {
    stats.macro_auc = macroAuc
    stats.roc_auc_macro = macroAuc
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

function resolveRawOutput(result: TestResult): LogisticRegressionResult | null {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return null

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const nested = parsed.results
      if (nested && typeof nested === 'object') {
        return nested as unknown as LogisticRegressionResult
      }
      return parsed as unknown as LogisticRegressionResult
    } catch {
      return null
    }
  }

  const nested = (raw as { results?: unknown }).results
  if (nested && typeof nested === 'object') {
    return nested as unknown as LogisticRegressionResult
  }

  return raw as unknown as LogisticRegressionResult
}

function median(values: number[]): number | null {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1]
    const upper = sorted[mid]
    if (lower === undefined || upper === undefined) return null
    return (lower + upper) / 2
  }
  return sorted[mid] ?? null
}

function sanitizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, '_').replace(/[^\w]/g, '') || 'class'
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
