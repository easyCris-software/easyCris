import type { Data } from 'plotly.js'

export type PlotStats = Record<string, number | string>

export const stripTrendlineStats = (stats: PlotStats): PlotStats =>
  Object.fromEntries(
    Object.entries(stats).filter(([key]) => !key.startsWith('trendline_'))
  )

export const extractTrendlineStats = (plotData?: Data[]): PlotStats => {
  if (!plotData || plotData.length === 0) return {}

  const trendlineTrace = plotData.find((trace) => {
    const t = trace as any
    if (t?.meta?.trendline === true) return true
    if (typeof t?.name !== 'string') return false
    return t.name === 'Trendline' || t.name.startsWith('Trendline ')
  }) as any

  const meta = trendlineTrace?.meta
  if (!meta) return {}

  const payload: PlotStats = {}

  if (typeof meta.type === 'string') payload.trendline_type = meta.type
  if (typeof meta.degree === 'number' && Number.isFinite(meta.degree)) {
    payload.trendline_degree = meta.degree
  }
  if (typeof meta.r_squared === 'number' && Number.isFinite(meta.r_squared)) {
    payload.trendline_r_squared = meta.r_squared
  }
  if (typeof meta.n_points === 'number' && Number.isFinite(meta.n_points)) {
    payload.trendline_n_points = meta.n_points
  }
  if (typeof meta.equation === 'string' && meta.equation.trim()) {
    payload.trendline_equation = meta.equation
  }
  if (typeof meta.slope === 'number' && Number.isFinite(meta.slope)) {
    payload.trendline_slope = meta.slope
  }
  if (typeof meta.intercept === 'number' && Number.isFinite(meta.intercept)) {
    payload.trendline_intercept = meta.intercept
  }
  if (Array.isArray(meta.coefficients) && meta.coefficients.length > 0) {
    payload.trendline_coefficients = meta.coefficients.join(', ')
  }

  return payload
}
