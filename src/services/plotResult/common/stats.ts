/**
 * Statistics Helpers
 * 
 * Utility functions for calculating and extracting statistical metrics
 */

import type { Data } from 'plotly.js'
import { calculateMeanSE } from '@/utils/plotBuilders/common'

/**
 * Calculate median of numeric array
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    const v1 = sorted[mid - 1]
    const v2 = sorted[mid]
    if (v1 !== undefined && v2 !== undefined) {
      return (v1 + v2) / 2
    }
    return 0
  }
  const medianValue = sorted[mid]
  return medianValue !== undefined ? medianValue : 0
}

/**
 * Recursively extract numeric values from nested object
 */
export function extractNumericStats(source: unknown, prefix = ''): Record<string, number> {
  const stats: Record<string, number> = {}
  if (!source || typeof source !== 'object') return stats

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}_${key}` : key
    if (typeof value === 'number' && !Number.isNaN(value)) {
      stats[nextKey] = value
    } else if (value && typeof value === 'object') {
      Object.assign(stats, extractNumericStats(value, nextKey))
    }
  }
  return stats
}

/**
 * Extract plot-specific stats from Plotly trace data
 * Ensures E2E tests can validate group_count, n, mean, std from plots
 */
export function extractStatsFromPlotlyData(data: Data[]): Record<string, number> {
  const stats: Record<string, number> = {}

  // Count groups (unique traces by default)
  let groupCount = data.length
  const traceTypes = new Set(
    data.map((trace) => (trace as { type?: string }).type).filter((t): t is string => Boolean(t))
  )
  if (data.length === 1) {
    if (traceTypes.has('bar')) {
      const barTrace = data[0] as { x?: unknown[]; y?: unknown[] }
      if (Array.isArray(barTrace.x) && barTrace.x.length > 0) {
        groupCount = barTrace.x.length
      } else if (Array.isArray(barTrace.y) && barTrace.y.length > 0) {
        groupCount = barTrace.y.length
      }
    } else if (traceTypes.has('box') || traceTypes.has('violin')) {
      const trace = data[0] as { x?: unknown[] }
      if (Array.isArray(trace.x) && trace.x.length > 0) {
        const uniqueGroups = new Set(trace.x.map((value) => String(value)))
        groupCount = uniqueGroups.size
      }
    }
  }
  stats.group_count = groupCount

  // Count total points and collect all values
  const allPoints: number[] = []
  for (const trace of data) {
    const traceData = trace as { y?: unknown[]; x?: unknown[] }
    const values = (traceData.y ?? traceData.x ?? []).filter(
      (v): v is number => typeof v === 'number'
    )
    allPoints.push(...values)
  }

  stats.n = allPoints.length

  // Compute mean, std
  if (allPoints.length > 0) {
    const { mean, std } = calculateMeanSE(allPoints)
    stats.value_mean = mean
    stats.value_std = std
  }

  return stats
}
