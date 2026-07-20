/**
 * PCA Biplot Builder
 *
 * Creates Plotly PCA biplot showing sample scores with gene loading arrows.
 *
 * Features:
 * - Sample points colored by experimental factor
 * - Gene loading arrows (top N contributors)
 * - Variance explained in axis labels
 * - Confidence ellipses (optional) with supported types:
 *   - 't': Robust t-distribution (default, resistant to outliers)
 *   - 'norm': Normal distribution (standard covariance)
 *   - 'euclid': Euclidean circle with fixed radius
 */

import type { Data, Layout } from 'plotly.js'
import type { PCAResult, BiplotOptions, EllipseType, GeneDirection } from '@/types/rnaseq'
import { repelLabels } from './labelRepel'

export interface PCABiplotData {
  data: Data[]
  layout: Partial<Layout>
  sampleLegend: Array<{
    label: string
    color: string
    role: 'reference' | 'test' | 'group'
  }>
}

export interface EllipseResult {
  path: string
  center: { x: number; y: number }
  radiusX: number
  radiusY: number
  angle: number
}

const DEFAULT_OPTIONS: BiplotOptions = {
  colorBy: 'treatment',
  useContrastRoleColors: false,
  referenceLevel: undefined,
  testLevel: undefined,
  showEllipses: true,
  ellipseType: 't',
  ellipseLevel: 0.95,
  showLabels: true,
  nGeneArrows: 5,
  arrowScale: 1.0,
  colorArrowsByDirection: false, // Default: black arrows (MDPI style)
  colorLabelsByDirection: true, // Color gene label text by direction (up/down/ns)
  showLabelBackground: false, // Default: plain text labels (no background)
  repelForce: 1.0, // Default label repulsion strength
}

// Colorblind-friendly palette for categorical groups (fallback)
const GROUP_COLORS = [
  '#D95F02', // orange
  '#1B9E77', // teal
  '#66A61E', // green
  '#E6AB02', // mustard
  '#7570B3', // purple
  '#A6761D', // brown
  '#2CA25F', // emerald
  '#8C6BB1', // violet
  '#B8860B', // dark goldenrod
]

const REFERENCE_COLOR = '#0000FF'
const TEST_COLOR = '#FF0000'

// Shape palette for secondary factor fallback
const SHAPE_SYMBOLS = ['circle', 'triangle-up', 'square', 'diamond', 'cross', 'x']

const OUTLINE_COLORS = [
  '#111827',
  '#F97316',
  '#16A34A',
  '#0EA5E9',
  '#D946EF',
  '#FACC15',
  '#A855F7',
  '#F43F5E',
]

const SEX_SHAPES: Record<string, string> = {
  female: 'circle',
  male: 'triangle-up',
}

// Gene direction colors (matching R's direction_colors)
const DIRECTION_COLORS: Record<GeneDirection, string> = {
  up: '#FFA500',   // orange (upregulated)
  down: '#00441b', // dark green (downregulated)
  ns: '#6B7280',   // gray (not significant)
}

/**
 * Adjust hex color brightness
 * @param hex - Hex color string (e.g., '#3B82F6')
 * @param factor - Brightness factor: >1 = lighter, <1 = darker
 */
function adjustColorBrightness(hex: string, factor: number): string {
  // Parse hex color
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return hex

  let r = parseInt(result[1] ?? '0', 16)
  let g = parseInt(result[2] ?? '0', 16)
  let b = parseInt(result[3] ?? '0', 16)

  // Adjust brightness
  r = Math.round(Math.min(255, r * factor))
  g = Math.round(Math.min(255, g * factor))
  b = Math.round(Math.min(255, b * factor))

  // Convert back to hex
  const toHex = (n: number) => {
    const hex = n.toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function getEllipseStyle(type: EllipseType): {
  dash: 'solid' | 'dash' | 'dot'
  fillAlpha: number
  lineWidth: number
  colorFactor: number // brightness multiplier for fill color
} {
  switch (type) {
    case 'euclid':
      return { dash: 'dot', fillAlpha: 0.06, lineWidth: 2, colorFactor: 1.5 } // lightest
    case 'norm':
      return { dash: 'dash', fillAlpha: 0.08, lineWidth: 2, colorFactor: 1.2 } // medium
    case 't':
    default:
      return { dash: 'solid', fillAlpha: 0.1, lineWidth: 2, colorFactor: 1.0 } // original color
  }
}

function toRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return hex
  const r = parseInt(result[1] ?? '0', 16)
  const g = parseInt(result[2] ?? '0', 16)
  const b = parseInt(result[3] ?? '0', 16)
  const clampedAlpha = Math.min(Math.max(alpha, 0), 1)
  return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`
}


function buildColorMap(
  groups: string[],
  options: Pick<BiplotOptions, 'useContrastRoleColors' | 'referenceLevel' | 'testLevel'>
): {
  map: Map<string, string>
  legend: Array<{ label: string; color: string; role: 'reference' | 'test' | 'group' }>
} {
  const map = new Map<string, string>()
  const legend: Array<{ label: string; color: string; role: 'reference' | 'test' | 'group' }> = []
  const remaining = new Set(groups)

  const useContrastRoleColors = Boolean(options.useContrastRoleColors)
  const normalizedReference = options.referenceLevel ? normalizeCategory(options.referenceLevel) : ''
  const normalizedTest = options.testLevel ? normalizeCategory(options.testLevel) : ''

  if (useContrastRoleColors && normalizedReference && normalizedTest && normalizedReference === normalizedTest) {
    console.warn('[PCA] referenceLevel and testLevel are identical. Falling back to neutral palette mapping.')
  } else if (useContrastRoleColors) {
    if (normalizedReference) {
      const referenceMatch = groups.find((group) => normalizeCategory(group) === normalizedReference)
      if (referenceMatch) {
        map.set(referenceMatch, REFERENCE_COLOR)
        legend.push({ label: referenceMatch, color: REFERENCE_COLOR, role: 'reference' })
        remaining.delete(referenceMatch)
      }
    }
    if (normalizedTest) {
      const testMatch = groups.find((group) => normalizeCategory(group) === normalizedTest)
      if (testMatch) {
        map.set(testMatch, TEST_COLOR)
        legend.push({ label: testMatch, color: TEST_COLOR, role: 'test' })
        remaining.delete(testMatch)
      }
    }
  }

  const usedColors = new Set([...map.values()].map((color) => color.toLowerCase()))
  const fallbackGroups = [...remaining].sort((a, b) => a.localeCompare(b))
  let idx = 0
  for (const group of fallbackGroups) {
    let color = GROUP_COLORS[0] ?? '#4477AA'
    let attempts = 0
    while (attempts < GROUP_COLORS.length) {
      const candidate = GROUP_COLORS[idx % GROUP_COLORS.length] ?? GROUP_COLORS[0] ?? '#4477AA'
      idx += 1
      attempts += 1
      if (!usedColors.has(candidate.toLowerCase())) {
        color = candidate
        break
      }
      color = candidate
    }
    map.set(group, color)
    usedColors.add(color.toLowerCase())
    legend.push({ label: group, color, role: 'group' })
  }

  return { map, legend }
}

function buildShapeMap(groups: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const remaining = new Set(groups)
  const orderedKnown = ['female', 'male']

  const hasKnown = groups.some((group) => normalizeCategory(group) in SEX_SHAPES)
  if (hasKnown) {
    for (const key of orderedKnown) {
      const match = groups.find((group) => normalizeCategory(group) === key)
      const symbol = SEX_SHAPES[key]
      if (match && symbol) {
        map.set(match, symbol)
        remaining.delete(match)
      }
    }
  }

  const fallbackGroups = [...remaining].sort((a, b) => a.localeCompare(b))
  let idx = 0
  for (const group of fallbackGroups) {
    const symbol = SHAPE_SYMBOLS[idx % SHAPE_SYMBOLS.length] ?? SHAPE_SYMBOLS[0] ?? 'circle'
    map.set(group, symbol)
    idx++
  }

  return map
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase()
}

type ThirdFactorInfo =
  | { kind: 'none'; label: string; valueBySampleId: Map<string, null> }
  | {
      kind: 'categorical'
      label: string
      valueBySampleId: Map<string, string>
      colorMap: Map<string, string>
    }
  | {
      kind: 'numeric'
      label: string
      valueBySampleId: Map<string, number>
      min: number
      max: number
      sizeRange: [number, number]
    }

function buildThirdFactorInfo(
  samples: PCAResult['samples'],
  thirdBy?: string
): ThirdFactorInfo {
  if (!thirdBy || !thirdBy.trim()) {
    return { kind: 'none', label: '', valueBySampleId: new Map() }
  }

  const label = thirdBy.trim()
  const numericValues: number[] = []
  const rawValues: Array<string | number> = []
  const valueBySampleId = new Map<string, string | number>()

  for (const sample of samples) {
    const raw = sample.metadata[label]
    if (raw === null || raw === undefined) continue
    rawValues.push(raw)
    valueBySampleId.set(sample.sampleId, raw)
    const parsed = coerceNumber(raw)
    if (parsed !== null) numericValues.push(parsed)
  }

  if (rawValues.length === 0) {
    return { kind: 'none', label, valueBySampleId: new Map() }
  }

  const isNumeric = numericValues.length === rawValues.length
  if (isNumeric) {
    const min = Math.min(...numericValues)
    const max = Math.max(...numericValues)
    const sizeRange: [number, number] = [6, 14]
    const numericMap = new Map<string, number>()
    for (const sample of samples) {
      const raw = sample.metadata[label]
      const parsed = coerceNumber(raw)
      if (parsed !== null) {
        numericMap.set(sample.sampleId, parsed)
      }
    }
    return {
      kind: 'numeric',
      label,
      valueBySampleId: numericMap,
      min,
      max,
      sizeRange,
    }
  }

  const categories = Array.from(new Set(rawValues.map((value) => String(value)))).sort((a, b) => a.localeCompare(b))
  const colorMap = new Map<string, string>()
  categories.forEach((category, idx) => {
    const color = OUTLINE_COLORS[idx % OUTLINE_COLORS.length] ?? OUTLINE_COLORS[0] ?? '#111827'
    colorMap.set(category, color)
  })
  const categoricalMap = new Map<string, string>()
  for (const sample of samples) {
    const raw = sample.metadata[label]
    if (raw === null || raw === undefined) continue
    categoricalMap.set(sample.sampleId, String(raw))
  }

  return {
    kind: 'categorical',
    label,
    valueBySampleId: categoricalMap,
    colorMap,
  }
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function scaleMarkerSize(info: ThirdFactorInfo, sampleId: string): number {
  if (info.kind !== 'numeric') return 10
  const value = info.valueBySampleId.get(sampleId)
  if (value === undefined) return 10
  if (info.max === info.min) return (info.sizeRange[0] + info.sizeRange[1]) / 2
  const t = (value - info.min) / (info.max - info.min)
  const [minSize, maxSize] = info.sizeRange
  return minSize + t * (maxSize - minSize)
}

export function buildPCABiplot(
  pcaResult: PCAResult,
  options: Partial<BiplotOptions> = {}
): PCABiplotData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const { samples: rawSamples, loadings, varianceExplained } = pcaResult
  const samples = rawSamples.filter(
    (sample) => Number.isFinite(sample.PC1) && Number.isFinite(sample.PC2)
  )
  const finiteLoadings = loadings.filter(
    (loading) => Number.isFinite(loading.PC1) && Number.isFinite(loading.PC2)
  )

  const traces: Data[] = []
  // Typed inline for Plotly layout
  const shapes: Array<Record<string, unknown>> = []
  const annotations: Array<Record<string, unknown>> = []

  // Build color and shape mappings
  const colorGroups = new Set<string>()
  const shapeGroups = new Set<string>()

  for (const sample of samples) {
    colorGroups.add(String(sample.metadata[opts.colorBy] ?? 'Unknown'))
    if (opts.shapeBy) {
      shapeGroups.add(String(sample.metadata[opts.shapeBy] ?? 'Unknown'))
    }
  }

  const { map: colorMap, legend: sampleLegend } = buildColorMap([...colorGroups], {
    useContrastRoleColors: opts.useContrastRoleColors,
    referenceLevel: opts.referenceLevel,
    testLevel: opts.testLevel,
  })
  const shapeMap = buildShapeMap([...shapeGroups])
  const thirdInfo = buildThirdFactorInfo(samples, opts.thirdBy)

  // Group samples by color factor (and optionally shape factor)
  // Key format: "colorValue" or "colorValue|shapeValue" if shapeBy is set
  const groupedSamples = new Map<string, typeof samples>()

  for (const sample of samples) {
    const colorValue = String(sample.metadata[opts.colorBy] ?? 'Unknown')
    const shapeValue = opts.shapeBy ? String(sample.metadata[opts.shapeBy] ?? 'Unknown') : null
    const key = shapeValue ? `${colorValue}|${shapeValue}` : colorValue

    if (!groupedSamples.has(key)) {
      groupedSamples.set(key, [])
    }
    groupedSamples.get(key)!.push(sample)
  }

  // Create traces for each group
  for (const [groupKey, groupSamples] of groupedSamples) {
    const [colorValue, shapeValue] = groupKey.includes('|')
      ? groupKey.split('|')
      : [groupKey, null]

    const color = colorMap.get(colorValue!) ?? GROUP_COLORS[0]
    const symbol = shapeValue ? (shapeMap.get(shapeValue) ?? 'circle') : 'circle'

    // Build legend name
    const legendName = shapeValue ? `${colorValue} / ${shapeValue}` : colorValue!

    // Build hover template
    const hoverLines = [
      '<b>%{text}</b>',
      `${opts.colorBy}: ${colorValue}`,
    ]
    if (opts.shapeBy && shapeValue) {
      hoverLines.push(`${opts.shapeBy}: ${shapeValue}`)
    }
    if (thirdInfo.kind === 'categorical') {
      hoverLines.push(`${thirdInfo.label}: %{customdata}`)
    } else if (thirdInfo.kind === 'numeric') {
      hoverLines.push(`${thirdInfo.label}: %{customdata:.2f}`)
    }
    hoverLines.push('PC1: %{x:.2f}', 'PC2: %{y:.2f}', '<extra></extra>')

    // Sample points
    traces.push({
      type: 'scatter',
      mode: opts.showLabels ? 'markers+text' : 'markers',
      name: legendName,
      legendgroup: colorValue, // Group legend by color factor
      x: groupSamples.map((s) => s.PC1),
      y: groupSamples.map((s) => s.PC2),
      text: groupSamples.map((s) => s.sampleId),
      textposition: 'top center',
      textfont: { size: 9, color },
      customdata: groupSamples.map((s) => thirdInfo.valueBySampleId.get(s.sampleId) ?? null),
      hovertemplate: hoverLines.join('<br>'),
      marker: {
        color,
        size: thirdInfo.kind === 'numeric'
          ? groupSamples.map((s) => scaleMarkerSize(thirdInfo, s.sampleId))
          : 10,
        symbol,
        line: thirdInfo.kind === 'categorical'
          ? {
              color: groupSamples.map(
                (s) => thirdInfo.colorMap.get(String(thirdInfo.valueBySampleId.get(s.sampleId))) ?? '#111827'
              ),
              width: 2,
            }
          : { color: 'white', width: 1 },
      },
    })
  }

  // Calculate scaling for gene loading arrows
  const sampleRange =
    samples.length > 0
      ? {
          xMin: Math.min(...samples.map((s) => s.PC1)),
          xMax: Math.max(...samples.map((s) => s.PC1)),
          yMin: Math.min(...samples.map((s) => s.PC2)),
          yMax: Math.max(...samples.map((s) => s.PC2)),
        }
      : { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }

  const sampleSpread =
    samples.length > 0
      ? Math.max(sampleRange.xMax - sampleRange.xMin, sampleRange.yMax - sampleRange.yMin)
      : 1

  // Create ellipses per color group (not per color+shape combination)
  if (opts.showEllipses && samples.length >= 2) {
    const ellipseStyle = getEllipseStyle(opts.ellipseType)

    // ellipseLevel is already in the correct units:
    // - For t/norm: confidence level (0.95 = 95%)
    // - For euclid: radius in standard deviations (2.0 SD)

    // Check if we have precomputed ellipse metrics from Python backend
    const precomputedMetrics = pcaResult.ellipse_metrics?.[opts.ellipseType]

    for (const colorValue of colorGroups) {
      const colorGroupSamples = samples.filter(
        (s) => String(s.metadata[opts.colorBy] ?? 'Unknown') === colorValue
      )

      if (colorGroupSamples.length >= 4) {
        // Prefer precomputed ellipse from Python backend (exact R match)
        const precomputed = precomputedMetrics?.find((m) => m.group === colorValue)

        let ellipse: EllipseResult | null = null
        if (precomputed) {
          // Use precomputed metrics from Python backend (matches R exactly)
          ellipse = {
            path: precomputed.path,
            center: { x: precomputed.centerX, y: precomputed.centerY },
            radiusX: precomputed.radiusX,
            radiusY: precomputed.radiusY,
            angle: precomputed.angle,
          }
        } else {
          // Fallback to TypeScript calculation for backwards compatibility
          ellipse = calculateEllipse(
            colorGroupSamples.map((s) => s.PC1),
            colorGroupSamples.map((s) => s.PC2),
            opts.ellipseType,
            opts.ellipseLevel
          )
        }

        if (ellipse) {
          const baseColor = colorMap.get(colorValue) ?? GROUP_COLORS[0] ?? '#4477AA'
          const fillColor = adjustColorBrightness(baseColor, ellipseStyle.colorFactor)
          shapes.push({
            type: 'path',
            path: ellipse.path,
            line: { color: baseColor, width: ellipseStyle.lineWidth, dash: ellipseStyle.dash },
            fillcolor: toRgba(fillColor, ellipseStyle.fillAlpha),
          })
        }
      } else if (colorGroupSamples.length >= 2) {
        const fallback = buildFallbackCircle(
          colorGroupSamples.map((s) => s.PC1),
          colorGroupSamples.map((s) => s.PC2),
          sampleSpread
        )

        if (fallback) {
          const baseColor = colorMap.get(colorValue) ?? GROUP_COLORS[0] ?? '#4477AA'
          const fillColor = adjustColorBrightness(baseColor, ellipseStyle.colorFactor)
          shapes.push({
            type: 'path',
            path: fallback.path,
            line: { color: baseColor, width: ellipseStyle.lineWidth, dash: ellipseStyle.dash },
            fillcolor: toRgba(fillColor, ellipseStyle.fillAlpha * 0.8),
          })
        }
      }
    }
  }

  // Get top loading genes
  const topLoadings = finiteLoadings.slice(0, opts.nGeneArrows)

  if (topLoadings.length > 0) {
    // Simple robust scaling: longest arrow reaches ~40% of sample spread
    // This matches R's biplot behavior better than complex formulas
    const maxLoadingLength = Math.max(
      ...topLoadings.map((l) => Math.sqrt(l.PC1 * l.PC1 + l.PC2 * l.PC2)),
      1e-10
    )
    if (Number.isFinite(maxLoadingLength) && maxLoadingLength > 0) {
      const targetLength = sampleSpread * 0.4 * opts.arrowScale
      const arrowScale = targetLength / maxLoadingLength

      const geneLabels: Array<{
        anchorX: number
        anchorY: number
        labelX: number
        labelY: number
        text: string
        direction: GeneDirection
      }> = []

      // Create arrow annotations
      for (const loading of topLoadings) {
        const scaledX = loading.PC1 * arrowScale
        const scaledY = loading.PC2 * arrowScale
        if (!Number.isFinite(scaledX) || !Number.isFinite(scaledY)) continue
        const direction = loading.direction ?? 'ns'
        // Black arrows by default (MDPI style), or colored by direction if enabled
        const arrowColor = opts.colorArrowsByDirection ? DIRECTION_COLORS[direction] : '#000000'

        // Arrow line
        annotations.push({
          x: scaledX,
          y: scaledY,
          ax: 0,
          ay: 0,
          xref: 'x',
          yref: 'y',
          axref: 'x',
          ayref: 'y',
          showarrow: true,
          arrowhead: 2,
          arrowsize: 1,
          arrowwidth: 1.5,
          arrowcolor: arrowColor,
        })

        const labelOffset = 1.04
        const text = loading.geneSymbol || loading.geneId || ''
        if (text) {
          geneLabels.push({
            anchorX: scaledX,
            anchorY: scaledY,
            labelX: scaledX * labelOffset,
            labelY: scaledY * labelOffset,
            text,
            direction,
          })
        }
      }

      if (geneLabels.length > 0) {
        const xValues = [
          ...samples.map((s) => s.PC1),
          ...geneLabels.map((g) => g.labelX),
          ...geneLabels.map((g) => g.anchorX),
        ]
        const yValues = [
          ...samples.map((s) => s.PC2),
          ...geneLabels.map((g) => g.labelY),
          ...geneLabels.map((g) => g.anchorY),
        ]
        const minX = Math.min(...xValues)
        const maxX = Math.max(...xValues)
        const minY = Math.min(...yValues)
        const maxY = Math.max(...yValues)
        const padX = (maxX - minX) * 0.05
        const padY = (maxY - minY) * 0.05

        // Label repulsion parameters
        const minSegLen = sampleSpread * 0.015 // Draw leader line if displaced more than this
        const maxOverlaps = 8 // Hide labels with too many overlaps

        const repelled = repelLabels(geneLabels, {
          xRange: [minX - padX, maxX + padX],
          yRange: [minY - padY, maxY + padY],
          padding: Math.min(maxX - minX, maxY - minY) * 0.008,
          pull: 0.08,
          step: 0.35,
          maxOffset: (label) => {
            const anchorDistance = Math.hypot(label.anchorX, label.anchorY)
            const minOffset = sampleSpread * 0.02
            const maxOffset = sampleSpread * 0.08 // Allow more displacement with leader lines
            const scaled = anchorDistance * 0.3
            return Math.max(minOffset, Math.min(maxOffset, scaled))
          },
          minSegmentLength: minSegLen,
          maxOverlaps,
          repelForce: opts.repelForce ?? 1.0,
        })

        // Filter out labels with too many overlaps
        const visibleLabels = repelled.filter((l) => l.overlapCount <= maxOverlaps)

        // Add gene labels with leader lines
        for (const label of visibleLabels) {
          // Draw leader line if label was significantly displaced
          if (label.needsLeaderLine) {
            shapes.push({
              type: 'line',
              x0: label.anchorX,
              y0: label.anchorY,
              x1: label.labelX,
              y1: label.labelY,
              line: { color: '#9CA3AF', width: 0.75, dash: 'dot' },
            })
          }

          const labelAnnotation: Record<string, unknown> = {
            x: label.labelX,
            y: label.labelY,
            xref: 'x',
            yref: 'y',
            text: label.text,
            showarrow: false,
            xanchor: label.labelX >= label.anchorX ? 'left' : 'right',
            yanchor: label.labelY >= label.anchorY ? 'bottom' : 'top',
          }

          if (opts.showLabelBackground) {
            // R style: colored background with white text
            const bgColor = DIRECTION_COLORS[label.direction]
            labelAnnotation.font = { size: 9, color: '#FFFFFF' }
            labelAnnotation.bgcolor = bgColor
            labelAnnotation.borderpad = 2
            labelAnnotation.opacity = 0.85
          } else if (opts.colorLabelsByDirection) {
            // Color label text by direction (no background)
            const textColor = DIRECTION_COLORS[label.direction]
            labelAnnotation.font = { size: 10, color: textColor, weight: 600 }
          } else {
            // Plain gray text, no background
            labelAnnotation.font = { size: 10, color: '#374151' }
          }

          annotations.push(labelAnnotation)
        }
      }
    }
  }

  // Add axis lines through origin
  const axisExtent = sampleSpread * 0.6
  shapes.push(
    {
      type: 'line',
      x0: -axisExtent,
      x1: axisExtent,
      y0: 0,
      y1: 0,
      line: { color: '#E5E7EB', width: 1 },
    },
    {
      type: 'line',
      x0: 0,
      x1: 0,
      y0: -axisExtent,
      y1: axisExtent,
      line: { color: '#E5E7EB', width: 1 },
    }
  )

  // Add gene direction legend entries (if arrows or labels are colored by direction)
  if ((opts.colorArrowsByDirection || opts.colorLabelsByDirection) && topLoadings.length > 0) {
    // Count genes by direction for legend labels
    const directionCounts = { up: 0, down: 0, ns: 0 }
    for (const loading of topLoadings) {
      const dir = loading.direction ?? 'ns'
      directionCounts[dir]++
    }

    // Direction symbols: up-arrow for Up, down-arrow for Down, circle for NS
    const directionSymbols: Record<GeneDirection, string> = {
      up: 'triangle-up',
      down: 'triangle-down',
      ns: 'circle',
    }

    const directionLabels: Array<{ key: GeneDirection; label: string }> = [
      { key: 'up', label: `Up (${directionCounts.up})` },
      { key: 'down', label: `Down (${directionCounts.down})` },
      { key: 'ns', label: `NS (${directionCounts.ns})` },
    ]

    // Add invisible marker traces for legend (positioned off-plot)
    for (const { key, label } of directionLabels) {
      // Only show legend entry if there are genes with this direction
      if (directionCounts[key] > 0) {
        traces.push({
          type: 'scatter',
          mode: 'markers',
          name: label,
          x: [null],
          y: [null],
          marker: {
            color: DIRECTION_COLORS[key],
            size: 8,
            symbol: directionSymbols[key],
          },
          legendgroup: 'gene-direction',
          legendgrouptitle: { text: 'Gene Direction' },
          showlegend: true,
        })
      }
    }
  }

  // Layout
  const pc1Var = varianceExplained[0]?.toFixed(1) ?? '?'
  const pc2Var = varianceExplained[1]?.toFixed(1) ?? '?'

  const layout: Partial<Layout> = {
    title: {
      text: 'PCA Biplot',
      font: { size: 16 },
    },
    xaxis: {
      title: `PC1 (${pc1Var}% variance)`,
      zeroline: false,
      scaleanchor: 'y',
      scaleratio: 1,
    },
    yaxis: {
      title: `PC2 (${pc2Var}% variance)`,
      zeroline: false,
    },
    shapes,
    annotations,
    legend: {
      title: { text: opts.colorBy },
      orientation: 'v',
      yanchor: 'top',
      y: 1,
      xanchor: 'left',
      x: 1.02,
    },
    hovermode: 'closest',
    margin: { t: 60, b: 60, l: 60, r: 120 },
  }

  return { data: traces, layout, sampleLegend }
}

/**
 * Eigenvalues for a 2x2 symmetric matrix [[a, b], [b, d]]
 * Returned in descending order (lambda1 >= lambda2).
 */
function eigenvalues2x2(
  a: number,
  b: number,
  d: number
): { lambda1: number; lambda2: number } {
  const trace = a + d
  const delta = Math.sqrt((a - d) * (a - d) + 4 * b * b)
  const lambda1 = (trace + delta) / 2
  const lambda2 = (trace - delta) / 2
  return { lambda1, lambda2 }
}

/**
 * Calculate confidence ellipse for a set of points
 * Matches the parameterization used by our validation baselines.
 *
 * @param x - X coordinates
 * @param y - Y coordinates
 * @param type - Ellipse type: 't' (robust), 'norm' (chi-square), 'euclid' (circle)
 * @param level - Confidence level (0-1) or radius for 'euclid'
 * @returns SVG path string for the ellipse, or null if insufficient data
 */
export function calculateEllipse(
  x: number[],
  y: number[],
  type: EllipseType,
  level: number
): EllipseResult | null {
  const n = x.length
  const dfn = 2
  const dfd = n - 1

  // Require at least 4 points (minimum for ellipse calculation)
  if (n < 4 || dfd < 3) return null

  // Calculate covariance based on type
  let center: { x: number; y: number }
  let cov: { cov00: number; cov01: number; cov11: number }

  if (type === 't') {
    // Robust covariance estimation (simplified M-estimator)
    // Uses iteratively reweighted covariance with Huber-like weights
    const robust = robustCovarianceEstimate(x, y)
    center = robust.center
    cov = robust.cov
  } else {
    // Standard weighted covariance for 'norm' and 'euclid'
    center = {
      x: x.reduce((a, b) => a + b, 0) / n,
      y: y.reduce((a, b) => a + b, 0) / n,
    }
    cov = standardCovariance(x, y, center)
  }

  // For 'euclid', use spherical covariance (circle)
  if (type === 'euclid') {
    const minVar = Math.min(cov.cov00, cov.cov11)
    cov = { cov00: minVar, cov01: 0, cov11: minVar }
  }

  const { lambda1, lambda2 } = eigenvalues2x2(cov.cov00, cov.cov01, cov.cov11)
  if (!Number.isFinite(lambda1) || !Number.isFinite(lambda2) || lambda1 <= 0 || lambda2 <= 0) {
    return null
  }

  // Calculate radius based on type
  let radius: number
  if (type === 'euclid') {
    if (!(level > 0)) return null
    // For euclid: level/max(chol_decomp)
    // Note: cov has been forced to spherical minVar * I, so max(chol(cov)) == sqrt(minVar).
    radius = level / Math.sqrt(cov.cov00)
  } else {
    // For 't' AND 'norm': sqrt(dfn * qf(level, dfn, dfd))
    // Note: Uses F-distribution for BOTH types (not chi-square for norm)
    if (!(level > 0 && level < 1)) return null
    const f = fQuantile(level, dfn, dfd)
    if (!Number.isFinite(f)) return null
    radius = Math.sqrt(dfn * f)
  }

  if (!Number.isFinite(radius)) return null

  const radiusX = Math.sqrt(lambda1) * radius
  const radiusY = Math.sqrt(lambda2) * radius

  // Match validation baseline angle derivation:
  // angle <- atan2(lambda1 - cov[1,1], cov[1,2]) (with cov12==0 special-case)
  let ellipseAngle = 0
  if (cov.cov01 !== 0) {
    ellipseAngle = Math.atan2(lambda1 - cov.cov00, cov.cov01)
  } else if (cov.cov00 < cov.cov11) {
    ellipseAngle = Math.PI / 2
  }

  // Generate ellipse path (51 segments); parameterized by center/radii/angle.
  const points: string[] = []
  const numSegments = 51
  const cosA = Math.cos(ellipseAngle)
  const sinA = Math.sin(ellipseAngle)
  for (let i = 0; i <= numSegments; i++) {
    const t = (2 * Math.PI * i) / numSegments
    const ct = Math.cos(t)
    const st = Math.sin(t)

    // Rotation of axis-aligned ellipse.
    const px = center.x + radiusX * ct * cosA - radiusY * st * sinA
    const py = center.y + radiusX * ct * sinA + radiusY * st * cosA

    points.push(i === 0 ? `M ${px} ${py}` : `L ${px} ${py}`)
  }
  points.push('Z')

  return {
    path: points.join(' '),
    center,
    radiusX,
    radiusY,
    angle: ellipseAngle,
  }
}

function buildFallbackCircle(
  x: number[],
  y: number[],
  overallSpread: number
): { path: string } | null {
  if (x.length === 0 || y.length === 0) return null
  const centerX = x.reduce((sum, value) => sum + value, 0) / x.length
  const centerY = y.reduce((sum, value) => sum + value, 0) / y.length

  let maxDist = 0
  for (let i = 0; i < x.length; i++) {
    const dx = (x[i] ?? 0) - centerX
    const dy = (y[i] ?? 0) - centerY
    maxDist = Math.max(maxDist, Math.hypot(dx, dy))
  }

  const radius = Math.max(maxDist * 1.1, overallSpread * 0.03)
  if (!Number.isFinite(radius) || radius <= 0) return null

  const numSegments = 51
  const points: string[] = []
  for (let i = 0; i <= numSegments; i++) {
    const t = (2 * Math.PI * i) / numSegments
    const px = centerX + radius * Math.cos(t)
    const py = centerY + radius * Math.sin(t)
    points.push(i === 0 ? `M ${px} ${py}` : `L ${px} ${py}`)
  }
  points.push('Z')

  return { path: points.join(' ') }
}

/**
 * Standard sample covariance calculation
 */
function standardCovariance(
  x: number[],
  y: number[],
  center: { x: number; y: number }
): { cov00: number; cov01: number; cov11: number } {
  const n = x.length
  let cov00 = 0,
    cov01 = 0,
    cov11 = 0

  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - center.x
    const dy = (y[i] ?? 0) - center.y
    cov00 += dx * dx
    cov01 += dx * dy
    cov11 += dy * dy
  }

  return {
    cov00: cov00 / (n - 1),
    cov01: cov01 / (n - 1),
    cov11: cov11 / (n - 1),
  }
}

/**
 * Robust covariance estimation using iteratively reweighted algorithm
 * Simplified version of MASS::cov.trob (M-estimator with Huber-like weights)
 *
 * This provides outlier-resistant covariance estimation by down-weighting
 * points that are far from the center based on Mahalanobis distance.
 */
function robustCovarianceEstimate(
  x: number[],
  y: number[]
): {
  center: { x: number; y: number }
  cov: { cov00: number; cov01: number; cov11: number }
} {
  // Port of MASS::cov.trob (default args: nu=5, maxit=25, tol=0.01, center=TRUE)
  // This needs to match validation baseline ellipse calculation precisely for E2E validation.
  const n = x.length
  const p = 2
  const nu = 5
  const maxit = 25
  const tol = 0.01

  // wt = rep(1, n) (weight normalized then multiplied by n)
  const wt = new Array(n).fill(1)
  const sumWt = n

  let locX = x.reduce((s, v, i) => s + (wt[i] ?? 0) * (v ?? 0), 0) / sumWt
  let locY = y.reduce((s, v, i) => s + (wt[i] ?? 0) * (v ?? 0), 0) / sumWt

  // w <- wt * (1 + p/nu)
  let w = wt.map((v) => v * (1 + p / nu))

  for (let iter = 0; iter < maxit; iter++) {
    const w0 = w

    const sumW = w.reduce((s, v) => s + v, 0)
    if (!(sumW > 0)) break

    // X <- x - loc
    const X0: number[] = new Array(n)
    const X1: number[] = new Array(n)
    for (let i = 0; i < n; i++) {
      X0[i] = (x[i] ?? 0) - locX
      X1[i] = (y[i] ?? 0) - locY
    }

    // sX <- svd(sqrt(w/sum(w)) * X, nu = 0)
    // For an n x 2 matrix, we can get V and d from eigen(A^T A).
    let m00 = 0
    let m01 = 0
    let m11 = 0
    for (let i = 0; i < n; i++) {
      const scale = Math.sqrt((w[i] ?? 0) / sumW)
      const a0 = (X0[i] ?? 0) * scale
      const a1 = (X1[i] ?? 0) * scale
      m00 += a0 * a0
      m01 += a0 * a1
      m11 += a1 * a1
    }

    const eig = eigen2x2(m00, m01, m11)
    const d0 = Math.sqrt(Math.max(0, eig.values[0] ?? 0))
    const d1 = Math.sqrt(Math.max(0, eig.values[1] ?? 0))
    const v00 = eig.vectors[0]?.[0] ?? 1
    const v10 = eig.vectors[1]?.[0] ?? 0
    const v01 = eig.vectors[0]?.[1] ?? 0
    const v11 = eig.vectors[1]?.[1] ?? 1

    // wX <- X %*% V %*% diag(1/d)
    // Q <- rowSums(wX^2)
    const Q: number[] = new Array(n).fill(0)
    const invD0 = d0 > 0 ? 1 / d0 : 0
    const invD1 = d1 > 0 ? 1 / d1 : 0
    for (let i = 0; i < n; i++) {
      const xi0 = X0[i] ?? 0
      const xi1 = X1[i] ?? 0
      const z0 = (xi0 * v00 + xi1 * v10) * invD0
      const z1 = (xi0 * v01 + xi1 * v11) * invD1
      Q[i] = z0 * z0 + z1 * z1
    }

    // w <- (wt * (nu + p)) / (nu + Q)
    w = wt.map((wti, i) => (wti * (nu + p)) / (nu + (Q[i] ?? 0)))

    // loc <- colSums(w * x) / sum(w)
    const sumW2 = w.reduce((s, v) => s + v, 0)
    if (!(sumW2 > 0)) break
    locX = x.reduce((s, v, i) => s + (w[i] ?? 0) * (v ?? 0), 0) / sumW2
    locY = y.reduce((s, v, i) => s + (w[i] ?? 0) * (v ?? 0), 0) / sumW2

    if (w.every((wi, i) => Math.abs(wi - (w0[i] ?? 0)) < tol)) {
      break
    }
  }

  // cov <- crossprod(sqrt(w) * X) / sum(wt)
  // NOTE: divisor is sum(wt), not sum(w).
  let c00 = 0
  let c01 = 0
  let c11 = 0
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - locX
    const dy = (y[i] ?? 0) - locY
    const wi = w[i] ?? 0
    c00 += wi * dx * dx
    c01 += wi * dx * dy
    c11 += wi * dy * dy
  }
  c00 /= sumWt
  c01 /= sumWt
  c11 /= sumWt

  return {
    center: { x: locX, y: locY },
    cov: { cov00: c00, cov01: c01, cov11: c11 },
  }
}

function eigen2x2(
  m00: number,
  m01: number,
  m11: number
): { values: [number, number]; vectors: [[number, number], [number, number]] } {
  const trace = m00 + m11
  const det = m00 * m11 - m01 * m01
  const discriminant = Math.sqrt(Math.max(0, trace * trace / 4 - det))
  const l0 = trace / 2 + discriminant
  const l1 = trace / 2 - discriminant

  // Eigenvectors for symmetric 2x2. For m01 ~ 0 use axis-aligned vectors.
  let v0x = 1
  let v0y = 0
  let v1x = 0
  let v1y = 1

  if (Math.abs(m01) > 0) {
    v0x = l0 - m11
    v0y = m01
    const norm0 = Math.hypot(v0x, v0y) || 1
    v0x /= norm0
    v0y /= norm0

    // Orthonormal complement
    v1x = -v0y
    v1y = v0x
  } else if (m00 < m11) {
    // First axis aligns with Y when variance is larger along Y.
    v0x = 0
    v0y = 1
    v1x = 1
    v1y = 0
  }

  return {
    values: [l0, l1],
    vectors: [
      [v0x, v1x],
      [v0y, v1y],
    ],
  }
}

function fQuantile(p: number, d1: number, d2: number): number {
  if (!(p > 0 && p < 1) || d1 <= 0 || d2 <= 0) return NaN
  let lower = 0
  let upper = 1
  let cdf = fCdf(upper, d1, d2)
  let guard = 0
  while (cdf < p && upper < 1e6 && guard < 60) {
    upper *= 2
    cdf = fCdf(upper, d1, d2)
    guard += 1
  }
  if (!Number.isFinite(cdf)) return NaN
  for (let i = 0; i < 80; i++) {
    const mid = (lower + upper) / 2
    const midCdf = fCdf(mid, d1, d2)
    if (!Number.isFinite(midCdf)) break
    if (midCdf > p) {
      upper = mid
    } else {
      lower = mid
    }
  }
  return (lower + upper) / 2
}

function fCdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0
  const a = d1 / 2
  const b = d2 / 2
  const z = (d1 * x) / (d1 * x + d2)
  return regularizedIncompleteBeta(a, b, z)
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  // Closed forms for edge-shape parameters.
  // For our ellipse use-case, dfn=2 so a=dfn/2=1 exactly (critical for accurate F quantiles).
  if (a === 1) {
    return 1 - Math.pow(1 - x, b)
  }
  if (b === 1) {
    return Math.pow(x, a)
  }
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta)
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200
  const epsilon = 3e-7
  const minValue = 1e-30

  let qab = a + b
  let qap = a + 1
  let qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < minValue) d = minValue
  d = 1 / d
  let h = d

  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < minValue) d = minValue
    c = 1 + aa / c
    if (Math.abs(c) < minValue) c = minValue
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < minValue) d = minValue
    c = 1 + aa / c
    if (Math.abs(c) < minValue) c = minValue
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < epsilon) break
  }
  return h
}

function logGamma(z: number): number {
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019571e-6,
    1.5056327351493116e-7,
  ]

  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
  }

  z -= 1
  let x = p[0] ?? 0
  for (let i = 1; i < p.length; i++) {
    const coeff = p[i] ?? 0
    x += coeff / (z + i)
  }
  const t = z + p.length - 0.5
  return (
    0.5 * Math.log(2 * Math.PI) +
    (z + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  )
}
