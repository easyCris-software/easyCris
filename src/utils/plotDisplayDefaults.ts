import type { Data, Layout } from 'plotly.js'
import { getBarOutlineWidthState } from '@/lib/plots/barOutlineState'

const OUTLINE_COLOR = '#000000'
const OUTLINE_WIDTH = 1

const parseHex = (hex: string): { r: number; g: number; b: number } | null => {
  const normalized = hex.replace('#', '').trim()
  const expanded =
    normalized.length === 3
      ? normalized.split('').map((ch) => ch + ch).join('')
      : normalized.length === 6
        ? normalized
        : normalized.length === 8
          ? normalized.slice(0, 6)
          : ''
  if (expanded.length !== 6) return null
  const r = parseInt(expanded.slice(0, 2), 16)
  const g = parseInt(expanded.slice(2, 4), 16)
  const b = parseInt(expanded.slice(4, 6), 16)
  if (![r, g, b].every((value) => Number.isFinite(value))) return null
  return { r, g, b }
}

const parseRgb = (value: string): { r: number; g: number; b: number } | null => {
  const matches = value.match(/\d+(\.\d+)?/g) ?? []
  if (matches.length < 3) return null
  const r = Number(matches[0])
  const g = Number(matches[1])
  const b = Number(matches[2])
  if (![r, g, b].every((channel) => Number.isFinite(channel))) return null
  return { r, g, b }
}

const parseColor = (value: string): { r: number; g: number; b: number } | null => {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('#')) return parseHex(trimmed)
  if (trimmed.startsWith('rgb')) return parseRgb(trimmed)
  return null
}

const colorsEquivalent = (a?: string, b?: string): boolean => {
  if (!a || !b) return false
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true
  const parsedA = parseColor(a)
  const parsedB = parseColor(b)
  if (!parsedA || !parsedB) return false
  return (
    parsedA.r === parsedB.r &&
    parsedA.g === parsedB.g &&
    parsedA.b === parsedB.b
  )
}

const getContrastOutline = (color: string): string => {
  // easyCris policy: bar outlines are always black for guaranteed contrast.
  void color
  return OUTLINE_COLOR
}

const resolveOutlineColor = (
  fill: string | string[] | undefined,
  line: string | string[] | undefined
): string | string[] | undefined => {
  if (typeof fill === 'string') {
    if (typeof line === 'string' && !colorsEquivalent(fill, line)) return line
    return getContrastOutline(fill)
  }
  if (Array.isArray(fill)) {
    if (Array.isArray(line)) {
      const same = fill.every((entry, idx) =>
        typeof entry === 'string' && typeof line[idx] === 'string'
          ? colorsEquivalent(entry, line[idx])
          : false
      )
      if (!same) return line
      return fill.map((entry) =>
        typeof entry === 'string' ? getContrastOutline(entry) : OUTLINE_COLOR
      )
    }
    if (typeof line === 'string') {
      const same = fill.every((entry) =>
        typeof entry === 'string' ? colorsEquivalent(entry, line) : false
      )
      if (!same) return line
    }
    return fill.map((entry) =>
      typeof entry === 'string' ? getContrastOutline(entry) : OUTLINE_COLOR
    )
  }
  return line
}

const areOutlineColorsEquivalent = (a: string | string[], b: string | string[]): boolean => {
  if (typeof a === 'string' && typeof b === 'string') {
    return colorsEquivalent(a, b)
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((entry, idx) =>
      typeof entry === 'string' && typeof b[idx] === 'string'
        ? colorsEquivalent(entry, b[idx])
        : entry === b[idx]
    )
  }
  if (Array.isArray(a) && typeof b === 'string') {
    return a.every((entry) => (typeof entry === 'string' ? colorsEquivalent(entry, b) : false))
  }
  if (typeof a === 'string' && Array.isArray(b)) {
    return b.every((entry) => (typeof entry === 'string' ? colorsEquivalent(a, entry) : false))
  }
  return false
}

export const applyAutoBarOutlines = (data: Data[]): { data: Data[]; changed: boolean } => {
  if (!Array.isArray(data) || data.length === 0) {
    return { data, changed: false }
  }

  let changed = false
  const next = data.map((trace) => {
    const t = trace as Data & { type?: string; marker?: any }
    if (t.type !== 'bar') return trace

    const marker = t.marker && typeof t.marker === 'object' ? t.marker : {}
    const line = marker.line && typeof marker.line === 'object' ? marker.line : {}
    const lineWidthState = getBarOutlineWidthState(line.width, true)
    if (!lineWidthState.enabled) return trace

    const shouldWriteDefaultWidth = lineWidthState.mode === 'missing'
    const fillColor = marker.color as string | string[] | undefined
    const lineColor = line.color as string | string[] | undefined
    const resolvedColor = resolveOutlineColor(fillColor, lineColor)

    const shouldUpdateColor =
      resolvedColor !== undefined &&
      (typeof lineColor === 'undefined' || !areOutlineColorsEquivalent(resolvedColor, lineColor))

    const shouldUpdateWidth = shouldWriteDefaultWidth

    if (!shouldUpdateColor && !shouldUpdateWidth) return trace

    changed = true
    const nextLine: Record<string, unknown> = {
      ...line,
      ...(resolvedColor !== undefined ? { color: resolvedColor } : {}),
    }
    if (shouldWriteDefaultWidth) {
      nextLine.width = OUTLINE_WIDTH
    }

    return {
      ...trace,
      marker: {
        ...marker,
        line: nextLine,
      },
    }
  })

  return { data: changed ? next : data, changed }
}

export const getEffectiveShowLegend = (
  layout: Partial<Layout>,
  data: Data[]
): { showLegend: boolean; isAuto: boolean } => {
  const meta = (layout.meta as Record<string, unknown> | undefined) ?? {}
  const legendUserSet = meta.legendUserSet === true
  const layoutShowLegend =
    typeof layout.showlegend === 'boolean' ? layout.showlegend : undefined

  if (legendUserSet) {
    return { showLegend: layoutShowLegend ?? true, isAuto: false }
  }

  const baseShowLegend = layoutShowLegend ?? true
  const barTraces = data.filter((trace) => (trace as { type?: string }).type === 'bar')
  if (barTraces.length === 0) {
    return { showLegend: baseShowLegend, isAuto: false }
  }

  if (baseShowLegend) {
    return { showLegend: true, isAuto: false }
  }

  const visibleBarTraces = barTraces.filter((trace) => (trace as { showlegend?: boolean }).showlegend !== false)
  if (visibleBarTraces.length > 1) {
    return { showLegend: true, isAuto: true }
  }

  const hasPattern = visibleBarTraces.some((trace) => {
    const marker = (trace as { marker?: { pattern?: { shape?: unknown } } }).marker
    const shape = marker?.pattern?.shape
    if (Array.isArray(shape)) {
      return shape.some((entry) => typeof entry === 'string' && entry !== '' && entry !== 'solid')
    }
    return typeof shape === 'string' && shape !== '' && shape !== 'solid'
  })
  if (hasPattern) {
    return { showLegend: true, isAuto: true }
  }

  const hasLegendGroup = visibleBarTraces.some((trace) => {
    const group = (trace as { legendgroup?: unknown }).legendgroup
    return typeof group === 'string' && group.trim().length > 0
  })
  if (hasLegendGroup) {
    return { showLegend: true, isAuto: true }
  }

  return { showLegend: false, isAuto: true }
}
