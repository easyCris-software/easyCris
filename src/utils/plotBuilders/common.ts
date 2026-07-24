/**
 * Common Plot Utilities - Phase 1 Plots Feature
 *
 * Shared utilities for all plot builders:
 * - Color palettes (publication-ready)
 * - Layout helpers
 * - Statistical computations (quartiles, CI, etc.)
 * - Sampling utilities
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file contains core statistical functions used by Group 1 E2E validation (655 metrics).
 * Key functions: calculateQuartiles, calculateMeanSE, calculate95CI, calculateErrorBar,
 * createBracketShapes, stackBrackets - all validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { Layout, Config } from 'plotly.js'
import type { PlotSettings, SignificanceBracket, BracketSettings, PlotFontConfig } from './types'
import { formatPValue as formatEcpPValue } from '@/utils/ecpTableBuilders'

// Plotly shape types (simplified from plotly.js)
interface PlotlyShape {
  type: 'line' | 'rect' | 'circle' | 'path'
  name?: string
  x0?: string | number
  x1?: string | number
  y0?: number
  y1?: number
  xref?: 'x' | 'paper'
  yref?: 'y' | 'paper'
  path?: string  // SVG path syntax for 'path' type
  line?: {
    color: string
    width: number
  }
  layer?: 'below' | 'above'  // Z-order: 'above' renders on top of data traces
  label?: {
    text: string
    textposition?: 'top left' | 'top center' | 'top right' | 'middle left' | 'middle center' | 'middle right' | 'bottom left' | 'bottom center' | 'bottom right' | 'start' | 'middle' | 'end'
    font?: {
      family: string
      size: number
      color: string
    }
    xanchor?: 'auto' | 'left' | 'center' | 'right'
    yanchor?: 'top' | 'middle' | 'bottom'
    padding?: number
  }
}

// =============================================================================
// COLOR PALETTES
// =============================================================================

/**
 * Default color palette - Deep saturated colors
 */
export const DEFAULT_COLORS = [
  '#0000FF', '#FF0000', '#00AA00', '#FF8C00', '#8B00FF',
  '#00CED1', '#DC143C', '#228B22', '#FFD700', '#4B0082',
]

/**
 * High contrast palette for publications
 */
export const HIGH_CONTRAST_COLORS = [
  '#000000', '#e69f00', '#56b4e9', '#009e73', '#f0e442',
  '#0072b2', '#d55e00', '#cc79a7', '#999999', '#666666',
]

/**
 * Sequential palette for gradients
 */
export const SEQUENTIAL_COLORS = [
  '#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6',
  '#4292c6', '#2171b5', '#08519c', '#08306b',
]

/**
 * Diverging palette for +/- values
 */
export const DIVERGING_COLORS = [
  '#d73027', '#f46d43', '#fdae61', '#fee090', '#ffffbf',
  '#e0f3f8', '#abd9e9', '#74add1', '#4575b4',
]

/**
 * Get color from palette with wrap-around
 */
export function getColor(index: number, palette: string[] = DEFAULT_COLORS): string {
  const color = palette[index % palette.length]
  // TypeScript needs explicit type assertion since it can't track array length
  return color ?? palette[0] ?? '#0000FF'
}

export function applyAlpha(color: string, alpha: number): string {
  if (!Number.isFinite(alpha)) return color
  const clamped = Math.min(1, Math.max(0, alpha))
  if (color.startsWith('rgba(')) {
    const parts = color.slice(5, -1).split(',').map((part) => part.trim())
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamped})`
    }
    return color
  }
  if (color.startsWith('rgb(')) {
    const inner = color.slice(4, -1)
    return `rgba(${inner}, ${clamped})`
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const normalized = hex.length === 3
      ? hex.split('').map((c) => c + c).join('')
      : hex
    if (normalized.length === 6) {
      const r = parseInt(normalized.slice(0, 2), 16)
      const g = parseInt(normalized.slice(2, 4), 16)
      const b = parseInt(normalized.slice(4, 6), 16)
      if ([r, g, b].every((v) => Number.isFinite(v))) {
        return `rgba(${r}, ${g}, ${b}, ${clamped})`
      }
    }
  }
  return color
}

type PatternShape = '/' | '\\' | 'x' | '+' | '-' | '|' | '' | '.'

interface PatternConfig {
  shape: PatternShape
  bgcolor: string
  fgcolor: string
  size: number
  solidity: number
}

/**
 * Generate pattern configuration for grouped bar charts (publication style)
 */
export function getPatternConfig(index: number): PatternConfig {
  const patterns: Array<{
    shape: PatternShape
    size: number
    solidity: number
  }> = [
    { shape: '', size: 1, solidity: 1 },           // Solid
    { shape: '/', size: 6, solidity: 0.5 },        // Diagonal lines
    { shape: '\\', size: 6, solidity: 0.5 },       // Reverse diagonal
    { shape: 'x', size: 6, solidity: 0.4 },        // Cross-hatch
    { shape: '+', size: 6, solidity: 0.4 },        // Plus pattern
    { shape: '-', size: 6, solidity: 0.5 },        // Horizontal lines
    { shape: '|', size: 6, solidity: 0.5 },        // Vertical lines
    { shape: '.', size: 4, solidity: 0.3 },        // Dots
  ]

  const pattern = patterns[index % patterns.length]!
  const color = getColor(index)

  return {
    shape: pattern.shape,
    size: pattern.size,
    solidity: pattern.solidity,
    bgcolor: pattern.shape === '' ? color : '#ffffff',
    fgcolor: color,
  }
}

// =============================================================================
// LAYOUT HELPERS
// =============================================================================

/**
 * Create base layout with common settings
 */
export function createBaseLayout(settings: Partial<PlotSettings>): Partial<Layout> {
  return {
    title: {
      text: settings.title ?? '',
      font: fontConfigToPlotly(settings.titleFont),
    },
    paper_bgcolor: settings.paperColor ?? '#ffffff',
    plot_bgcolor: settings.backgroundColor ?? '#ffffff',
    showlegend: settings.showLegend ?? true,
    margin: settings.margin ?? { t: 50, r: 50, b: 50, l: 60 },
    font: fontConfigToPlotly(settings.titleFont),
    hovermode: 'closest',
    width: 1200,  // Expanded canvas width for more room to move legends/titles
    height: 900,  // Expanded canvas height for more room to move legends/titles
  }
}

/**
 * Convert PlotFontConfig to Plotly font format
 */
export function fontConfigToPlotly(font?: PlotFontConfig): {
  family: string
  size: number
  color: string
  weight: number
} {
  return {
    family: font?.family ?? 'Inter, sans-serif',
    size: font?.size ?? 12,
    color: font?.color ?? '#333333',
    weight: font?.weight ?? 700,
  }
}

/**
 * Create default Plotly config
 */
export function createDefaultConfig(): Partial<Config> {
  return {
    responsive: true,
    displayModeBar: false,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    toImageButtonOptions: {
      format: 'png',
      filename: 'easycris-plot',
      height: 900,  // Match expanded canvas height
      width: 1200,  // Match expanded canvas width
      scale: 2,
    },
  }
}

/**
 * Create thumbnail config (minimal, non-interactive)
 */
export function createThumbnailConfig(): Partial<Config> {
  return {
    responsive: true,
    displayModeBar: false,
    staticPlot: true,
  }
}

// =============================================================================
// STATISTICAL UTILITIES
// =============================================================================

/**
 * Calculate quartiles (Q1, median, Q3) using linear interpolation
 */
export function calculateQuartiles(values: number[]): {
  q1: number
  median: number
  q3: number
  min: number
  max: number
  iqr: number
  whiskerLow: number
  whiskerHigh: number
  outliers: number[]
} {
  if (values.length === 0) {
    return {
      q1: 0, median: 0, q3: 0, min: 0, max: 0,
      iqr: 0, whiskerLow: 0, whiskerHigh: 0, outliers: [],
    }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length

  const percentile = (p: number): number => {
    const idx = (p / 100) * (n - 1)
    const low = Math.floor(idx)
    const high = Math.ceil(idx)
    const lowVal = sorted[low] ?? 0
    const highVal = sorted[high] ?? 0
    if (low === high) return lowVal
    return lowVal + (highVal - lowVal) * (idx - low)
  }

  const q1 = percentile(25)
  const median = percentile(50)
  const q3 = percentile(75)
  const iqr = q3 - q1
  const min = sorted[0] ?? 0
  const max = sorted[n - 1] ?? 0

  // Tukey's fences for whiskers
  const lowerFence = q1 - 1.5 * iqr
  const upperFence = q3 + 1.5 * iqr

  // Whiskers extend to furthest point within fences
  const whiskerLow = sorted.find((v) => v >= lowerFence) ?? min
  const whiskerHigh = [...sorted].reverse().find((v) => v <= upperFence) ?? max

  // Outliers are points beyond fences
  const outliers = sorted.filter((v) => v < lowerFence || v > upperFence)

  return { q1, median, q3, min, max, iqr, whiskerLow, whiskerHigh, outliers }
}

/**
 * Calculate mean and standard error
 */
export function calculateMeanSE(values: number[]): {
  mean: number
  std: number
  se: number
  n: number
} {
  if (values.length === 0) {
    return { mean: 0, std: 0, se: 0, n: 0 }
  }

  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n

  if (n === 1) {
    return { mean, std: 0, se: 0, n }
  }

  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1)
  const std = Math.sqrt(variance)
  const se = std / Math.sqrt(n)

  return { mean, std, se, n }
}

/**
 * Calculate 95% confidence interval
 */
export function calculate95CI(values: number[]): {
  mean: number
  lower: number
  upper: number
} {
  const { mean, se, n } = calculateMeanSE(values)

  if (n < 2) {
    return { mean, lower: mean, upper: mean }
  }

  // Use t-distribution critical value for 95% CI
  // Approximate for n > 30, exact would need t-table
  const tCrit = n > 30 ? 1.96 : getTCritical(n - 1, 0.975)
  const margin = tCrit * se

  return {
    mean,
    lower: mean - margin,
    upper: mean + margin,
  }
}

/**
 * Calculate error bar value based on type
 * Returns the +/- value for error bars
 */
export function calculateErrorBar(
  values: number[],
  type: 'se' | 'sd' | 'ci' | 'iqr' | 'none' = 'se'
): number {
  if (values.length === 0) return 0
  if (values.length === 1) return 0

  const stats = calculateMeanSE(values)

  switch (type) {
    case 'none':
      return 0
    case 'se':
      // Standard Error: SD / sqrt(n)
      return stats.se
    case 'sd':
      // Standard Deviation
      return stats.std
    case 'iqr': {
      const { iqr } = calculateQuartiles(values)
      // Symmetric half-IQR around the median for error bar length
      return iqr / 2
    }
    case 'ci': {
      // 95% Confidence Interval (returns half-width)
      const ci = calculate95CI(values)
      return ci.upper - ci.mean
    }
    default:
      return stats.se
  }
}

/**
 * Approximate t-distribution critical value
 * For exact values, use a t-distribution table
 */
function getTCritical(df: number, _p: number): number {
  // Common values for 95% CI (p = 0.975)
  const tTable: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042,
  }

  const exactValue = tTable[df]
  if (exactValue !== undefined) return exactValue
  if (df > 30) return 1.96 // Normal approximation

  // Linear interpolation for in-between values
  const keys = Object.keys(tTable).map(Number).sort((a, b) => a - b)
  for (let i = 0; i < keys.length - 1; i++) {
    const k1 = keys[i]
    const k2 = keys[i + 1]
    if (k1 !== undefined && k2 !== undefined && df > k1 && df < k2) {
      const t1 = tTable[k1] ?? 2.0
      const t2 = tTable[k2] ?? 2.0
      const ratio = (df - k1) / (k2 - k1)
      return t1 + ratio * (t2 - t1)
    }
  }

  return 2.0 // Fallback
}

// =============================================================================
// SAMPLING UTILITIES
// =============================================================================

/**
 * Deterministic sampling using seed
 */
export function sampleRows<T>(
  data: T[],
  sampleSize: number,
  seed: number = 42
): T[] {
  if (data.length <= sampleSize) return data

  // Simple seeded random for reproducibility
  const random = createSeededRandom(seed)
  const indices = new Set<number>()

  while (indices.size < sampleSize) {
    const idx = Math.floor(random() * data.length)
    indices.add(idx)
  }

  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => data[i])
    .filter((item): item is T => item !== undefined)
}

/**
 * Systematic sampling (every nth element)
 */
export function systematicSample<T>(data: T[], sampleSize: number): T[] {
  if (data.length <= sampleSize) return data

  const step = data.length / sampleSize
  const result: T[] = []

  for (let i = 0; result.length < sampleSize; i += step) {
    const item = data[Math.floor(i)]
    if (item !== undefined) {
      result.push(item)
    }
  }

  return result
}

/**
 * Create seeded random number generator
 */
function createSeededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

// =============================================================================
// SIGNIFICANCE BRACKETS
// =============================================================================

/**
 * Generate Plotly shapes for significance brackets
 */
export function createBracketShapes(
  brackets: SignificanceBracket[],
  settings: BracketSettings,
  yBase: number,
  yScale: number,
  categoryOrder?: Map<string, number>,
  dataRange?: { yMin: number; yMax: number }  // Optional: explicit data range for stable direction
): PlotlyShape[] {
  if (!settings.show || brackets.length === 0) return []

  const shapes: PlotlyShape[] = []
  const labeledBrackets = brackets
    .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, settings) }))
    .filter((entry) => Boolean(entry.label))
  const safeScale = Math.max(1, Math.abs(yScale))
  const safeBase = Number.isFinite(yBase) ? yBase : 0
  const tipHeight = safeScale * settings.tipLength
  const leftTipHeight = Math.max(0, tipHeight)
  const rightTipHeight = Math.max(0, tipHeight)

  const resolvePosition = (value: number | string, shift?: number): number => {
    const offset = typeof shift === 'number' ? shift : 0
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value + offset
    }
    if (typeof value === 'string') {
      const mapped = categoryOrder?.get(value)
      if (typeof mapped === 'number' && Number.isFinite(mapped)) {
        return mapped + offset
      }
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed + offset
      }
    }
    return Number.NaN
  }

  // Stable direction determination: use data range if provided, otherwise infer from yBase
  // This prevents direction flipping when brackets are dragged near zero
  let direction: number
  if (dataRange && Number.isFinite(dataRange.yMin) && Number.isFinite(dataRange.yMax)) {
    // All positive data: tips up
    if (dataRange.yMin >= 0) {
      direction = 1
    }
    // All negative data: tips down
    else if (dataRange.yMax <= 0) {
      direction = -1
    }
    // Mixed data: default to tips up (traditional behavior)
    else {
      direction = 1
    }
  } else {
    // Fallback: infer from yBase (original behavior)
    direction = safeBase < 0 ? -1 : 1
  }

  labeledBrackets.forEach(({ bracket, label }, index) => {
    // Position relative to yBase; direction controls offset/flip for negative values
    const yOffset = safeScale * (settings.offsetY + bracket.height)
    const y = direction > 0 ? safeBase + yOffset : safeBase - yOffset

    const x0 = resolvePosition(bracket.group1, bracket.group1Shift)
    const x1 = resolvePosition(bracket.group2, bracket.group2Shift)
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) return

    // Position brackets exactly at bar centers (where error bars are)
    const leftX = x0
    const rightX = x1

    // Flip tips based on direction: positive -> tips upward; negative -> tips downward
    const tipSign = direction > 0 ? -1 : 1
    const pathStr = `M ${leftX},${y + tipSign * leftTipHeight} L ${leftX},${y} L ${rightX},${y} L ${rightX},${y + tipSign * rightTipHeight}`

    shapes.push({
      type: 'path',
      name: `sig_bracket_${index}`,
      path: pathStr,
      xref: 'x',
      yref: 'y',
      layer: 'above',  // Render on top of data traces
      line: {
        color: settings.lineColor,
        width: Math.max(settings.lineWidth, 3),
      },
      label: {
        text: label,  // Significance label (e.g., "***" or "p=0.012")
        textposition: direction > 0 ? 'top center' : 'bottom center',
        font: fontConfigToPlotly(settings.font),
        padding: 2,
        xanchor: 'center',
        yanchor: direction > 0 ? 'bottom' : 'top',  // Keep text above bracket in both directions
      },
    })
  })

  return shapes
}

export function formatBracketLabel(
  bracket: SignificanceBracket,
  settings: BracketSettings
): string {
  const mode = settings.labelMode ?? 'stars'
  if (mode === 'pvalue') {
    if (!bracket.label && !settings.showNs) return ''
    const valueLabel = bracket.valueLabel === 'q' ? 'q' : 'p'
    const rawText = bracket.pValueText?.trim()
    let resolvedValue = bracket.pValue
    if (rawText && !/[<>]/.test(rawText)) {
      const normalized = rawText
        .replace(/^[pqPQ]\s*[=:<>]\s*/g, '')
        .replace(/\s+/g, '')
      const match = normalized.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/i)
      if (match && match[0]) {
        const parsed = Number(match[0])
        if (Number.isFinite(parsed)) {
          resolvedValue = parsed
        }
      }
    }
    let formatted = formatEcpPValue(resolvedValue)
    if (formatted === '.') {
      formatted = ''
    }
    if (!formatted) {
      if (rawText) {
        const sanitized = rawText.replace(/^[pqPQ]\s*[=:<>]\s*/g, '').trim()
        formatted = sanitized
      }
    }
    if (!formatted) return ''
    const label = formatted.startsWith('<')
      ? `${valueLabel} ${formatted}`
      : `${valueLabel} = ${formatted}`
    return label
  }
  return bracket.label
}

/**
 * Generate Plotly annotations for bracket labels
 */
/**
 * Stack brackets to avoid overlaps
 * Assigns heights to brackets based on their span
 */
export function stackBrackets(
  brackets: SignificanceBracket[],
  settings: BracketSettings,
  categoryOrder?: Map<string, number>
): SignificanceBracket[] {
  if (brackets.length === 0) return []

  const resolvePosition = (value: number | string, shift?: number): number => {
    const offset = typeof shift === 'number' ? shift : 0
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value + offset
    }
    if (typeof value === 'string') {
      const mapped = categoryOrder?.get(value)
      if (typeof mapped === 'number' && Number.isFinite(mapped)) {
        return mapped + offset
      }
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed + offset
      }
    }
    return Number.NaN
  }

  // Sort by span width (wider brackets go higher)
  const sorted = [...brackets].sort((a, b) => {
    const spanA = Math.abs(
      resolvePosition(a.group2, a.group2Shift) - resolvePosition(a.group1, a.group1Shift)
    )
    const spanB = Math.abs(
      resolvePosition(b.group2, b.group2Shift) - resolvePosition(b.group1, b.group1Shift)
    )
    if (!Number.isFinite(spanA) || !Number.isFinite(spanB)) {
      return 0
    }
    return spanA - spanB // Narrower brackets first (lower)
  })

  // Assign heights
  const assigned: SignificanceBracket[] = []
  const levels: { x1: number; x2: number; level: number }[] = []

  for (const bracket of sorted) {
    const x1 = resolvePosition(bracket.group1)
    const x2 = resolvePosition(bracket.group2)
    if (!Number.isFinite(x1) || !Number.isFinite(x2)) {
      const level = levels.length
      levels.push({ x1: level, x2: level, level })
      assigned.push({
        ...bracket,
        height: level * settings.heightStep,
      })
      continue
    }
    const minX = Math.min(x1, x2)
    const maxX = Math.max(x1, x2)

    // Find lowest level that doesn't overlap
    let level = 0
    for (const existing of levels) {
      const overlapX = !(maxX < existing.x1 || minX > existing.x2)
      if (overlapX && existing.level >= level) {
        level = existing.level + 1
      }
    }

    levels.push({ x1: minX, x2: maxX, level })
    assigned.push({
      ...bracket,
      height: level * settings.heightStep,
    })
  }

  return assigned
}

/**
 * Apply explicit spacing to brackets - use fixed heightStep multiplier for clean separation
 */
export function repelBracketLayout(
  brackets: SignificanceBracket[],
  settings: BracketSettings,
  _yMin: number,
  _yMax: number,
  _iterations = 60
): SignificanceBracket[] {
  if (!settings.show || brackets.length <= 1) {
    return brackets
  }

  // Use explicit spacing with heightStep * multiplier for cleaner visual separation
  // This gives consistent spacing instead of physics-based simulation
  const spacingMultiplier = 2.6
  return brackets.map((bracket) => {
    return {
      ...bracket,
      height: bracket.height * spacingMultiplier,
    }
  })
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

/**
 * Generate unique plot ID
 */
export function generatePlotId(): string {
  return `plot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Format number for display
 */
export function formatNumber(value: number, decimals: number = 4): string {
  if (Math.abs(value) < 0.0001 || Math.abs(value) >= 10000) {
    return value.toExponential(decimals)
  }
  return value.toFixed(decimals)
}

/**
 * Calculate axis range for continuous scales (line plots, scatter plots)
 * with standard expansion strategy.
 *
 * Default for continuous scales: 5% symmetric expansion
 * - Apply 5% symmetric multiplicative expansion on both ends
 * - NO zero clamping (data can naturally extend into negative ranges)
 *
 * For bar plots, use `calculateBarPlotRange()` instead (zero-baseline logic).
 *
 * @param values - Array of numeric values
 * @param expansionMult - Multiplicative expansion factor (default 0.05 = 5%)
 * @returns [min, max] range for axis
 */
export function calculateAxisRange(
  values: number[],
  expansionMult: number = 0.05
): [number, number] {
  if (values.length === 0) {
    return [0, 1]
  }

  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1]
  }

  // If all values are the same, create a small range around the value
  if (min === max) {
    const center = min
    const offset = Math.abs(center) * 0.1 || 0.5 // 10% of value, or 0.5 if zero
    return [center - offset, center + offset]
  }

  // Calculate range and expansion padding
  const range = max - min
  const safeMult = Number.isFinite(expansionMult) && expansionMult >= 0 ? expansionMult : 0
  const padding = range * safeMult

  // Apply symmetric expansion (standard for continuous scales)
  const rangeMin = min - padding
  const rangeMax = max + padding

  return [rangeMin, rangeMax]
}

/**
 * Calculate axis range for bar plot visualization.
 *
 * Bars always span from the data value to zero:
 * - ymin = pmin(y, 0)
 * - ymax = pmax(y, 0)
 *
 * Expansion strategy:
 * - Apply 5% symmetric expansion to the full [ymin, ymax] range.
 * - This keeps zero inside the plot area for all-negative or all-positive data.
 *
 * @param values - Array of numeric values (bar heights, including error bars)
 * @param expansionMult - Multiplicative expansion factor (default 0.05 = 5%)
 * @returns [min, max] range for axis
 */
export function calculateBarPlotRange(
  values: number[],
  expansionMult: number = 0.1
): [number, number] {
  if (values.length === 0) {
    return [0, 1]
  }

  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1]
  }

  // Bar chart behavior: bars anchor to zero, asymmetric expansion
  // - 0% expansion at the baseline (zero)
  // - 10% expansion away from baseline (above for positive, below for negative)
  const minWithZero = Math.min(min, 0)
  const maxWithZero = Math.max(max, 0)

  if (minWithZero === maxWithZero) {
    const center = minWithZero
    const offset = Math.abs(center) * 0.1 || 0.5
    return [center - offset, center + offset]
  }

  const safeMult = Number.isFinite(expansionMult) && expansionMult >= 0 ? expansionMult : 0.1

  // Asymmetric expansion: mult = c(0, .1)
  // - No padding at baseline (0)
  // - 10% padding away from baseline
  if (maxWithZero > 0 && minWithZero >= 0) {
    // All positive: expand above only
    const padding = maxWithZero * safeMult
    return [0, maxWithZero + padding]
  } else if (maxWithZero <= 0 && minWithZero < 0) {
    // All negative: expand below only
    const padding = Math.abs(minWithZero) * safeMult
    return [minWithZero - padding, 0]
  } else {
    // Mixed positive/negative: expand both directions from zero
    const posPadding = maxWithZero * safeMult
    const negPadding = Math.abs(minWithZero) * safeMult
    return [minWithZero - negPadding, maxWithZero + posPadding]
  }
}

