import type { Data } from 'plotly.js'
import { DEFAULT_COLORS } from '@/utils/plotBuilders/common'

export type BarPatternShape = 'solid' | '/' | '\\' | 'x' | '+' | '-' | '|' | '.'

export interface BarCategoryStyleEntry {
  color: string
  patternShape: BarPatternShape
  patternSize: number
  patternSolidity: number
  patternBgcolor: string
  patternFgcolor: string
  lineWidth: number
  lineColor: string
}

const VALID_PATTERN_SHAPES = new Set<BarPatternShape>([
  'solid',
  '/',
  '\\',
  'x',
  '+',
  '-',
  '|',
  '.',
])

const DEFAULT_PATTERN_SIZE = 6
const DEFAULT_PATTERN_SOLIDITY = 0.5
const DEFAULT_LINE_WIDTH = 1
const DEFAULT_LINE_COLOR = '#000000'

interface CategoryStyleMapEntry {
  color?: unknown
  patternShape?: unknown
  patternSize?: unknown
  patternSolidity?: unknown
  patternBgcolor?: unknown
  patternFgcolor?: unknown
  lineWidth?: unknown
  lineColor?: unknown
}

const buildCategoryKeys = (labels: string[]): string[] => {
  const seen = new Map<string, number>()
  return labels.map((label) => {
    const next = (seen.get(label) ?? 0) + 1
    seen.set(label, next)
    return `${label}__${next}`
  })
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const asString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

const asNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return clamp(numeric, min, max)
}

const getAt = (value: unknown, index: number): unknown => {
  if (Array.isArray(value)) return value[index]
  return value
}

const parseColorToRgb = (color: string): { r: number; g: number; b: number } | null => {
  const normalized = color.trim().toLowerCase()
  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1)
    if (hex.length === 3) {
      const c0 = hex[0] ?? '0'
      const c1 = hex[1] ?? '0'
      const c2 = hex[2] ?? '0'
      return {
        r: parseInt(c0 + c0, 16),
        g: parseInt(c1 + c1, 16),
        b: parseInt(c2 + c2, 16),
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      }
    }
    return null
  }
  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (rgbMatch && rgbMatch[1]) {
    const parts = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length >= 3) {
      const r = Number(parts[0])
      const g = Number(parts[1])
      const b = Number(parts[2])
      if ([r, g, b].every((entry) => Number.isFinite(entry))) {
        return { r, g, b }
      }
    }
  }
  return null
}

const getPatternLineColor = (color: string): string => {
  const rgb = parseColorToRgb(color)
  if (!rgb) return '#ffffff'
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
  return luminance > 0.6 ? '#000000' : '#ffffff'
}

const normalizePatternShape = (value: unknown): BarPatternShape => {
  const raw =
    typeof value === 'string'
      ? value === '' ? 'solid' : value
      : ''
  if (VALID_PATTERN_SHAPES.has(raw as BarPatternShape)) {
    return raw as BarPatternShape
  }
  return 'solid'
}

const toPlotlyPatternShape = (shape: BarPatternShape): string => {
  return shape === 'solid' ? '' : shape
}

const resolveStyleMap = (trace: Data): Record<string, CategoryStyleMapEntry> => {
  const traceRecord = trace as Record<string, unknown>
  const meta = asRecord(traceRecord.meta)
  const map = asRecord(meta?.categoryStyleMap)
  if (!map) return {}
  return map as Record<string, CategoryStyleMapEntry>
}

export const getBarCategoryLabels = (trace: Data): string[] => {
  const t = trace as Record<string, unknown>
  if (t.type !== 'bar' || !Array.isArray(t.x)) return []
  return (t.x as unknown[]).map((value, idx) =>
    value === null || value === undefined ? `Category ${idx + 1}` : String(value)
  )
}

export const extractBarCategoryStyles = (
  trace: Data,
  palette: string[] = DEFAULT_COLORS
): BarCategoryStyleEntry[] => {
  const labels = getBarCategoryLabels(trace)
  if (labels.length === 0) return []
  const categoryKeys = buildCategoryKeys(labels)

  const traceRecord = trace as Record<string, unknown>
  const marker = asRecord(traceRecord.marker) ?? {}
  const pattern = asRecord(marker.pattern) ?? {}
  const line = asRecord(marker.line) ?? {}
  const styleMap = resolveStyleMap(trace)

  return labels.map((label, idx) => {
    const key = categoryKeys[idx] ?? label
    const mapEntry = asRecord(styleMap[key] ?? styleMap[label]) ?? {}
    const fallbackColor = palette[idx % palette.length] ?? '#4e79a7'
    const color =
      asString(mapEntry.color) ??
      asString(getAt(marker.color, idx)) ??
      asString(marker.color) ??
      fallbackColor
    const patternShape = normalizePatternShape(
      mapEntry.patternShape ?? getAt(pattern.shape, idx) ?? pattern.shape
    )
    const patternSize = asNumber(
      mapEntry.patternSize ?? getAt(pattern.size, idx) ?? pattern.size,
      DEFAULT_PATTERN_SIZE,
      1,
      40
    )
    const patternSolidity = asNumber(
      mapEntry.patternSolidity ?? getAt(pattern.solidity, idx) ?? pattern.solidity,
      DEFAULT_PATTERN_SOLIDITY,
      0,
      1
    )
    const patternBgcolor =
      asString(mapEntry.patternBgcolor) ??
      asString(getAt(pattern.bgcolor, idx)) ??
      color
    const patternFgcolor =
      asString(mapEntry.patternFgcolor) ??
      asString(getAt(pattern.fgcolor, idx)) ??
      getPatternLineColor(color)
    const lineWidth = asNumber(
      mapEntry.lineWidth ?? getAt(line.width, idx) ?? line.width,
      DEFAULT_LINE_WIDTH,
      0,
      12
    )
    const lineColor =
      asString(mapEntry.lineColor) ??
      asString(getAt(line.color, idx)) ??
      DEFAULT_LINE_COLOR

    return {
      color,
      patternShape,
      patternSize,
      patternSolidity,
      patternBgcolor,
      patternFgcolor,
      lineWidth,
      lineColor,
    }
  })
}

export const applyBarCategoryStyles = (
  trace: Data,
  nextStyles: BarCategoryStyleEntry[]
): Data => {
  const labels = getBarCategoryLabels(trace)
  if (labels.length === 0) return trace
  const categoryKeys = buildCategoryKeys(labels)

  const currentStyles = extractBarCategoryStyles(trace)
  const resolvedStyles: BarCategoryStyleEntry[] = labels.map((_, idx) => {
    const next = nextStyles[idx]
    const fallback = currentStyles[idx]
    if (next) return next
    return (
      fallback ?? {
        color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length] ?? '#4e79a7',
        patternShape: 'solid' as BarPatternShape,
        patternSize: DEFAULT_PATTERN_SIZE,
        patternSolidity: DEFAULT_PATTERN_SOLIDITY,
        patternBgcolor: '#ffffff',
        patternFgcolor: '#000000',
        lineWidth: DEFAULT_LINE_WIDTH,
        lineColor: DEFAULT_LINE_COLOR,
      }
    )
  })

  const traceRecord = trace as Record<string, unknown>
  const marker = asRecord(traceRecord.marker) ?? {}
  const pattern = asRecord(marker.pattern) ?? {}
  const line = asRecord(marker.line) ?? {}
  const meta = asRecord(traceRecord.meta) ?? {}

  const styleMap = categoryKeys.reduce<Record<string, BarCategoryStyleEntry>>((acc, key, idx) => {
    acc[key] = resolvedStyles[idx]!
    return acc
  }, {})

  return {
    ...(trace as Record<string, unknown>),
    marker: {
      ...marker,
      color: resolvedStyles.map((style) => style.color),
      pattern: {
        ...pattern,
        shape: resolvedStyles.map((style) => toPlotlyPatternShape(style.patternShape)),
        size: resolvedStyles.map((style) => style.patternSize),
        solidity: resolvedStyles.map((style) => style.patternSolidity),
        bgcolor: resolvedStyles.map((style) => style.patternBgcolor),
        fgcolor: resolvedStyles.map((style) => style.patternFgcolor),
      },
      line: {
        ...line,
        width: resolvedStyles.map((style) => style.lineWidth),
        color: resolvedStyles.map((style) => style.lineColor),
      },
    },
    meta: {
      ...meta,
      categoryStyleMap: styleMap,
    },
  } as Data
}

export const setBarCategoryColor = (
  trace: Data,
  categoryIndex: number,
  color: string
): Data => {
  const styles = extractBarCategoryStyles(trace)
  const target = styles[categoryIndex]
  if (!target) return trace
  styles[categoryIndex] = {
    ...target,
    color,
    patternBgcolor: color,
    patternFgcolor: getPatternLineColor(color),
  }
  return applyBarCategoryStyles(trace, styles)
}

export const setBarCategoryPattern = (
  trace: Data,
  categoryIndex: number,
  patternShape: BarPatternShape
): Data => {
  const styles = extractBarCategoryStyles(trace)
  const target = styles[categoryIndex]
  if (!target) return trace
  styles[categoryIndex] = {
    ...target,
    patternShape,
    patternBgcolor: target.color,
    patternFgcolor: getPatternLineColor(target.color),
  }
  return applyBarCategoryStyles(trace, styles)
}

export const setBarCategoryPatternSize = (
  trace: Data,
  categoryIndex: number,
  size: number
): Data => {
  const styles = extractBarCategoryStyles(trace)
  const target = styles[categoryIndex]
  if (!target) return trace
  styles[categoryIndex] = { ...target, patternSize: asNumber(size, DEFAULT_PATTERN_SIZE, 1, 40) }
  return applyBarCategoryStyles(trace, styles)
}

export const setBarCategoryPatternSolidity = (
  trace: Data,
  categoryIndex: number,
  solidity: number
): Data => {
  const styles = extractBarCategoryStyles(trace)
  const target = styles[categoryIndex]
  if (!target) return trace
  styles[categoryIndex] = {
    ...target,
    patternSolidity: asNumber(solidity, DEFAULT_PATTERN_SOLIDITY, 0, 1),
  }
  return applyBarCategoryStyles(trace, styles)
}

export const setBarCategoryFrame = (
  trace: Data,
  categoryIndex: number,
  enabled: boolean
): Data => {
  const styles = extractBarCategoryStyles(trace)
  const target = styles[categoryIndex]
  if (!target) return trace
  styles[categoryIndex] = {
    ...target,
    lineWidth: enabled ? Math.max(1, target.lineWidth || DEFAULT_LINE_WIDTH) : 0,
    lineColor: enabled ? DEFAULT_LINE_COLOR : (target.lineColor || DEFAULT_LINE_COLOR),
  }
  return applyBarCategoryStyles(trace, styles)
}

export const applyColorToAllBarCategories = (trace: Data, color: string): Data => {
  const styles = extractBarCategoryStyles(trace)
  if (styles.length === 0) return trace
  const next = styles.map((style) => ({
    ...style,
    color,
    patternBgcolor: color,
    patternFgcolor: getPatternLineColor(color),
    lineColor: DEFAULT_LINE_COLOR,
  }))
  return applyBarCategoryStyles(trace, next)
}
