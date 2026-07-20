import type { Data } from 'plotly.js'
import { extractBarCategoryStyles, getBarCategoryLabels } from './barCategoryStyles'

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const pickValueAt = (value: unknown, index: number): unknown => {
  if (!Array.isArray(value)) return value
  return value[index]
}

const toPlotlyPatternShape = (shape: string): string => {
  return shape === 'solid' ? '' : shape
}

const isBarTrace = (trace: Data): boolean => {
  return (trace as { type?: string }).type === 'bar'
}

const isLegacySingleTraceBar = (trace: Data): boolean => {
  if (!isBarTrace(trace)) return false
  const t = trace as Record<string, unknown>
  return Array.isArray(t.x) && t.x.length > 1
}

const extractErrorArray = (trace: Data, axis: 'error_x' | 'error_y'): unknown[] | null => {
  const t = trace as Record<string, unknown>
  const error = asRecord(t[axis])
  if (!error) return null
  const arr = error.array
  return Array.isArray(arr) ? arr : null
}

const pickErrorValue = (arr: unknown[], index: number): unknown => {
  if (arr.length === 0) return undefined
  if (arr.length === 1) return arr[0]
  return arr[index]
}

const NON_POINT_ARRAY_KEYS = new Set(['colorscale'])

const sliceArraysByPointCount = (
  value: unknown,
  index: number,
  pointCount: number,
  depth = 3,
  key = ''
): unknown => {
  if (Array.isArray(value)) {
    if (NON_POINT_ARRAY_KEYS.has(key)) return value
    return value.length === pointCount ? [value[index]] : value
  }
  if (depth <= 0 || !value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  Object.entries(record).forEach(([entryKey, entryValue]) => {
    next[entryKey] = sliceArraysByPointCount(entryValue, index, pointCount, depth - 1, entryKey)
  })
  return next
}

const splitSingleBarTrace = (trace: Data): Data[] => {
  const t = trace as Record<string, unknown>
  const labels = getBarCategoryLabels(trace)
  const styles = extractBarCategoryStyles(trace)
  const xValues = Array.isArray(t.x) ? t.x : []
  const yValues = Array.isArray(t.y) ? t.y : []
  const pointCount = Math.max(xValues.length, yValues.length, labels.length)
  const textValues = Array.isArray(t.text) ? t.text : null
  const customData = Array.isArray(t.customdata) ? t.customdata : null
  const errorXArray = extractErrorArray(trace, 'error_x')
  const errorYArray = extractErrorArray(trace, 'error_y')

  const marker = asRecord(t.marker) ?? {}
  const pattern = asRecord(marker.pattern) ?? {}
  const line = asRecord(marker.line) ?? {}
  const traceMeta = asRecord(t.meta) ?? {}
  const { categoryStyleMap: _categoryStyleMap, ...metaRest } = traceMeta

  return labels.map((label, idx) => {
    const baseTrace = sliceArraysByPointCount(t, idx, pointCount, 3) as Record<string, unknown>
    const style = styles[idx]
    const xValue = xValues[idx]
    const yValue = yValues[idx]
    const splitMarker = {
      ...marker,
      color: style?.color ?? marker.color,
      pattern: {
        ...pattern,
        shape: toPlotlyPatternShape(style?.patternShape ?? 'solid'),
        size: style?.patternSize ?? pickValueAt(pattern.size, idx) ?? pattern.size,
        solidity:
          style?.patternSolidity ?? pickValueAt(pattern.solidity, idx) ?? pattern.solidity,
        bgcolor: style?.patternBgcolor ?? pickValueAt(pattern.bgcolor, idx) ?? pattern.bgcolor,
        fgcolor: style?.patternFgcolor ?? pickValueAt(pattern.fgcolor, idx) ?? pattern.fgcolor,
      },
      line: {
        ...line,
        color: style?.lineColor ?? pickValueAt(line.color, idx) ?? line.color,
        width: style?.lineWidth ?? pickValueAt(line.width, idx) ?? line.width,
      },
    }

    const next: Record<string, unknown> = {
      ...baseTrace,
      x: [xValue],
      y: [yValue],
      marker: splitMarker,
      name: label || `Category ${idx + 1}`,
      showlegend: true,
      legendgroup: String(label || `Category ${idx + 1}`),
      meta: {
        ...metaRest,
      },
    }

    if (textValues) {
      next.text = [textValues[idx]]
    }
    if (customData) {
      next.customdata = [customData[idx]]
    }

    const errorX = asRecord(baseTrace.error_x)
    if (errorX) {
      next.error_x = {
        ...errorX,
        ...(errorXArray ? { array: [errorXArray[idx]] } : {}),
      }
      const currentArrayMinus = Array.isArray(errorX.arrayminus) ? errorX.arrayminus : null
      if (currentArrayMinus) {
        ;(next.error_x as Record<string, unknown>).arrayminus = [pickErrorValue(currentArrayMinus, idx)]
      }
      const currentArrayPlus = Array.isArray(errorX.arrayplus) ? errorX.arrayplus : null
      if (currentArrayPlus) {
        ;(next.error_x as Record<string, unknown>).arrayplus = [pickErrorValue(currentArrayPlus, idx)]
      }
    }
    const errorY = asRecord(baseTrace.error_y)
    if (errorY) {
      next.error_y = {
        ...errorY,
        ...(errorYArray ? { array: [errorYArray[idx]] } : {}),
      }
      const currentArrayMinus = Array.isArray(errorY.arrayminus) ? errorY.arrayminus : null
      if (currentArrayMinus) {
        ;(next.error_y as Record<string, unknown>).arrayminus = [pickErrorValue(currentArrayMinus, idx)]
      }
      const currentArrayPlus = Array.isArray(errorY.arrayplus) ? errorY.arrayplus : null
      if (currentArrayPlus) {
        ;(next.error_y as Record<string, unknown>).arrayplus = [pickErrorValue(currentArrayPlus, idx)]
      }
    }

    return next as Data
  })
}

export const normalizeBarSplitTraces = (data: Data[]): { data: Data[]; changed: boolean } => {
  if (!Array.isArray(data) || data.length === 0) {
    return { data, changed: false }
  }

  let changed = false
  const next: Data[] = []

  data.forEach((trace) => {
    if (!isLegacySingleTraceBar(trace)) {
      next.push(trace)
      return
    }
    const split = splitSingleBarTrace(trace)
    if (split.length > 0) {
      next.push(...split)
      changed = true
    } else {
      next.push(trace)
    }
  })

  return { data: changed ? next : data, changed }
}

export const shouldNormalizeUserDerivedBarPlot = (
  sourceType: 'user_derived' | 'test_result' | undefined,
  plotType: string | undefined,
  data: Data[]
): boolean => {
  if (sourceType !== 'user_derived') return false
  if (plotType !== 'bar') return false
  return normalizeBarSplitTraces(data).changed
}
