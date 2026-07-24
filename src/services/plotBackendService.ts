/**
 * plotBackendService.ts - TypeScript interface for plot.py
 *
 * Handles communication with the Python plot backend for:
 * - Trendline computation
 * - Other plot enhancements (future)
 */

import { invoke } from '@tauri-apps/api/core'

// ============================================================================
// Types
// ============================================================================

export type TrendlineType = 'linear' | 'polynomial'
export type LineDash = 'solid' | 'dash' | 'dot' | 'dashdot'

export interface TrendlineRequest {
  x: number[]
  y: number[]
  type?: TrendlineType
  degree?: number // 2-5 for polynomial
  lineColor?: string
  lineDash?: LineDash
  showEquation?: boolean
  showRSquared?: boolean
}

export interface TrendlineTrace {
  x: number[]
  y: number[]
  mode: 'lines'
  type: 'scatter'
  name: string
  meta?: TrendlineStats
  line: {
    dash: string
    color: string
    width: number
  }
  hoverinfo: string
  showlegend: boolean
}

export interface TrendlineStats {
  type: TrendlineType
  degree: number
  coefficients: number[]
  r_squared: number
  n_points: number
  trendline?: boolean
  equation?: string
  r_squared_display?: string
  slope?: number // linear only
  intercept?: number // linear only
}

export interface TrendlineResult {
  success: true
  trace: TrendlineTrace
  stats: TrendlineStats
}

export interface TrendlineError {
  success: false
  error: string
}

export type TrendlineResponse = TrendlineResult | TrendlineError

export interface PlotExportRequest {
  plotlyJson: Record<string, unknown>
  outputPath: string
  options: {
    format: 'png' | 'jpg' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'tiff' | 'tif'
    width?: number
    height?: number
    dpi?: number
    scale?: number
    transparent?: boolean
  }
}

export interface PlotExportResponse {
  success: boolean
  path?: string
  format?: string
  width?: number
  height?: number
  dpi?: number
  scale?: number | null
  error?: string
  error_type?: string
  details?: string
  message?: string
  suspect_paths?: string[]
  debug_payload_path?: string
  replay_command?: string
  backend_fingerprint?: Record<string, unknown>
}

// ============================================================================
// Backend Communication
// ============================================================================

/**
 * Call the plot.py with a JSON request
 */
async function callPlotBackend<T>(request: Record<string, unknown>): Promise<T> {
  const input = JSON.stringify(request)

  try {
    const result = await invoke<string>('run_plot', { input })
    return JSON.parse(result) as T
  } catch (error) {
    console.error('Plot backend error:', error)
    if (error && typeof error === 'object') {
      throw error
    }
    if (typeof error === 'string') {
      throw new Error(error)
    }
    throw new Error('Plot backend failed')
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute a trendline for scatter plot data
 *
 * @param request - Trendline parameters (x, y arrays + options)
 * @returns Plotly trace and statistics
 *
 * @example
 * const result = await computeTrendline({
 *   x: [1, 2, 3, 4, 5],
 *   y: [2, 4, 6, 8, 10],
 *   type: 'linear'
 * })
 * if (result.success) {
 *   // Append result.trace to plot data
 *   // Display result.stats.equation, result.stats.r_squared
 * }
 */
export async function computeTrendline(
  request: TrendlineRequest
): Promise<TrendlineResponse> {
  return callPlotBackend<TrendlineResponse>({
    action: 'trendline',
    x: request.x,
    y: request.y,
    type: request.type ?? 'linear',
    degree: request.degree ?? 2,
    lineColor: request.lineColor,
    lineDash: request.lineDash ?? 'solid',
    showEquation: request.showEquation ?? true,
    showRSquared: request.showRSquared ?? true,
  })
}

/**
 * Ping the plot backend to check if it's ready
 */
export async function pingPlotBackend(): Promise<boolean> {
  try {
    const result = await callPlotBackend<{ success: boolean }>({ action: 'ping' })
    return result.success
  } catch {
    return false
  }
}

/**
 * Export plot image through the dedicated plot backend action.
 * Release-safe path (compiled plot backend in hardened builds).
 */
export async function exportPlotImageViaBackend(
  request: PlotExportRequest
): Promise<PlotExportResponse> {
  return callPlotBackend<PlotExportResponse>({
    action: 'export_plot',
    plotly_json: request.plotlyJson,
    output_path: request.outputPath,
    options: request.options,
  })
}

export default {
  computeTrendline,
  pingPlotBackend,
  exportPlotImageViaBackend,
}
