/**
 * ShapesAnnotationsEditor Component
 *
 * Unified editor for custom shapes and annotations on plots.
 * - Shapes: line, rect, circle (stored in layout.shapes)
 * - Annotations: textbox + arrow (stored in layout.annotations)
 *
 * Custom items are tagged with meta.customMarkup = true to distinguish
 * from system-managed items (legends, trendlines, IC50 labels, etc.)
 */

import { useState, useMemo, useCallback, useRef, useEffect, useId } from 'react'
import { debounce } from 'lodash'
import type { Layout } from 'plotly.js'
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Type,
  ArrowRight,
  Square,
  Circle,
  Minus,
  RotateCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { useViewportMode } from '@/hooks/useViewportMode'
import { PLOT_FONTS, resolvePlotFontFamily } from '@/lib/plots/plotFonts'
// Dropdown menu removed in favor of inline palette

// ============================================================================
// Types
// ============================================================================

export interface CustomShape {
  type: 'line' | 'rect' | 'circle' | 'path'
  x0: number | string
  x1: number | string
  y0: number | string
  y1: number | string
  xref?: string
  yref?: string
  name?: string
  visible?: boolean
  path?: string  // SVG path string for freeform shapes
  line?: {
    color?: string
    width?: number
    dash?: string
  }
  fillcolor?: string
  opacity?: number
  label?: {
    text?: string
    font?: { size?: number; color?: string; family?: string }
    textposition?: string
    textangle?: number | 'auto'  // Label text rotation
  }
  meta?: { customMarkup?: boolean; id?: string; rotationAngle?: number }
}

export interface CustomAnnotation {
  name?: string
  text: string
  x: number | string
  y: number | string
  xref?: string
  yref?: string
  showarrow?: boolean
  arrowhead?: number
  arrowsize?: number
  arrowwidth?: number
  arrowcolor?: string
  ax?: number
  ay?: number
  bgcolor?: string
  bordercolor?: string
  borderwidth?: number
  borderpad?: number
  font?: { size?: number; color?: string; family?: string }
  align?: 'left' | 'center' | 'right'
  textangle?: number  // Text rotation angle in degrees
  opacity?: number
  meta?: { customMarkup?: boolean; id?: string }
}

type MarkupItem =
  | { kind: 'shape'; index: number; data: CustomShape }
  | { kind: 'annotation'; index: number; data: CustomAnnotation }

type DrawTool = 'line' | 'rect' | 'circle' | 'path' | null
type DrawCoordinateMode = 'auto' | 'data' | 'paper'
type LayoutMeta = {
  activeShapeTool?: DrawTool
  customMarkupEnabled?: boolean
  shapeCoordinateMode?: DrawCoordinateMode
  lastCreatedCustomMarkupId?: string | null
}

export interface ShapesAnnotationsEditorProps {
  layout: Partial<Layout>
  onUpdateLayout: (updates: Partial<Layout>) => void
  className?: string
}

// ============================================================================
// Constants
// ============================================================================

const DASH_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dot', label: 'Dotted' },
  { value: 'dash', label: 'Dashed' },
  { value: 'longdash', label: 'Long Dash' },
  { value: 'dashdot', label: 'Dash-Dot' },
  { value: 'longdashdot', label: 'Long Dash-Dot' },
]

const ARROW_HEADS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Wide' },
  { value: 2, label: 'Narrow' },
  { value: 3, label: 'Barbed' },
  { value: 4, label: 'Wide Line' },
  { value: 5, label: 'Narrow Line' },
  { value: 6, label: 'Circle' },
  { value: 7, label: 'Square' },
]

const TEXT_POSITIONS = [
  { value: 'top left', label: 'Top Left' },
  { value: 'top center', label: 'Top Center' },
  { value: 'top right', label: 'Top Right' },
  { value: 'middle left', label: 'Middle Left' },
  { value: 'middle center', label: 'Middle Center' },
  { value: 'middle right', label: 'Middle Right' },
  { value: 'bottom left', label: 'Bottom Left' },
  { value: 'bottom center', label: 'Bottom Center' },
  { value: 'bottom right', label: 'Bottom Right' },
]

const LINE_TEXT_POSITIONS = [
  { value: 'start', label: 'Start' },
  { value: 'middle', label: 'Middle' },
  { value: 'end', label: 'End' },
]

const CUSTOM_MARKUP_NAME_PREFIX = 'custom_markup_'

const generateId = () => `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// ============================================================================
// Rotation Helper Functions
// ============================================================================

/**
 * Rotate a point (x, y) around a center (cx, cy) by angle (in degrees)
 */
function rotatePoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angleDeg: number
): { x: number; y: number } {
  const angleRad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const dx = x - cx
  const dy = y - cy
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }
}

function normalizeAngle(angle: number): number {
  const normalized = ((angle + 180) % 360 + 360) % 360 - 180
  return normalized
}

/**
 * Calculate angle (in degrees) of a line from (x0, y0) to (x1, y1)
 */
function getLineAngle(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0
  const dy = y1 - y0
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

/**
 * Rotate a line shape around its center by delta degrees
 */
function rotateLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  newAngleDeg: number
): { x0: number; y0: number; x1: number; y1: number } {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const currentAngle = getLineAngle(x0, y0, x1, y1)
  const delta = normalizeAngle(newAngleDeg - currentAngle)
  const p0 = rotatePoint(x0, y0, cx, cy, delta)
  const p1 = rotatePoint(x1, y1, cx, cy, delta)
  return { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y }
}

/**
 * Parse SVG path string and extract numeric coordinates
 * Returns array of { cmd, coords } where coords are the numeric values
 */
function parseSvgPath(path: string): Array<{ cmd: string; coords: number[]; relative: boolean }> {
  const result: Array<{ cmd: string; coords: number[]; relative: boolean }> = []
  // Match command letter followed by numbers (supports scientific notation)
  const regex = /([MLHVQCTSZ])([^MLHVQCTSZ]*)/gi
  let match
  while ((match = regex.exec(path)) !== null) {
    const rawCmd = match[1] ?? ''
    const cmd = rawCmd.toUpperCase()
    const relative = rawCmd !== cmd
    const coordStr = match[2] ?? ''
    // Extract numbers from the coordinate string
    const coords =
      coordStr
        .match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
        ?.map(Number)
        .filter((n) => !Number.isNaN(n)) ?? []
    result.push({ cmd, coords, relative })
  }
  return result
}

/**
 * Serialize parsed path back to string
 */
function serializeSvgPath(parsed: Array<{ cmd: string; coords: number[] }>): string {
  return parsed
    .map(({ cmd, coords }) => {
      if (coords.length === 0) return cmd
      return `${cmd}${coords.map(n => n.toFixed(4)).join(' ')}`
    })
    .join(' ')
}

/**
 * Rotate an SVG path around its bounding box center by delta degrees
 */
function rotateSvgPath(path: string, newAngleDeg: number, currentAngleDeg: number): string {
  const parsed = parseSvgPath(path)
  if (parsed.length === 0) return path

  // Extract all x,y points to find bounding box
  const points: Array<{ x: number; y: number }> = []
  let cursorX = 0
  let cursorY = 0
  let startX = 0
  let startY = 0
  parsed.forEach(({ cmd, coords, relative }) => {
    const toAbsolute = (x: number, y: number) =>
      relative ? { x: cursorX + x, y: cursorY + y } : { x, y }

    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i < coords.length - 1; i += 2) {
        const next = toAbsolute(coords[i] ?? 0, coords[i + 1] ?? 0)
        points.push({ x: next.x, y: next.y })
        cursorX = next.x
        cursorY = next.y
        if (cmd === 'M' && i === 0) {
          startX = next.x
          startY = next.y
        }
      }
    } else if (cmd === 'H') {
      coords.forEach((x) => {
        const next = toAbsolute(x ?? 0, 0)
        points.push({ x: next.x, y: cursorY })
        cursorX = next.x
      })
    } else if (cmd === 'V') {
      coords.forEach((y) => {
        const next = toAbsolute(0, y ?? 0)
        points.push({ x: cursorX, y: next.y })
        cursorY = next.y
      })
    } else if (cmd === 'Q') {
      for (let i = 0; i < coords.length - 3; i += 4) {
        const c1 = toAbsolute(coords[i] ?? 0, coords[i + 1] ?? 0)
        const end = toAbsolute(coords[i + 2] ?? 0, coords[i + 3] ?? 0)
        points.push({ x: c1.x, y: c1.y }, { x: end.x, y: end.y })
        cursorX = end.x
        cursorY = end.y
      }
    } else if (cmd === 'C') {
      for (let i = 0; i < coords.length - 5; i += 6) {
        const c1 = toAbsolute(coords[i] ?? 0, coords[i + 1] ?? 0)
        const c2 = toAbsolute(coords[i + 2] ?? 0, coords[i + 3] ?? 0)
        const end = toAbsolute(coords[i + 4] ?? 0, coords[i + 5] ?? 0)
        points.push({ x: c1.x, y: c1.y }, { x: c2.x, y: c2.y }, { x: end.x, y: end.y })
        cursorX = end.x
        cursorY = end.y
      }
    } else if (cmd === 'Z') {
      cursorX = startX
      cursorY = startY
    }
  })

  if (points.length === 0) return path

  // Calculate bounding box center
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2

  const delta = normalizeAngle(newAngleDeg - currentAngleDeg)

  // Rotate all coordinates
  let currentX = 0
  let currentY = 0
  let subpathStartX = 0
  let subpathStartY = 0

  const rotated = parsed.map(({ cmd, coords, relative }) => {
    if (cmd === 'Z') {
      currentX = subpathStartX
      currentY = subpathStartY
      return { cmd, coords: [] }
    }

    const newCoords: number[] = []
    const toAbsolute = (x: number, y: number) =>
      relative ? { x: currentX + x, y: currentY + y } : { x, y }

    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i < coords.length - 1; i += 2) {
        const abs = toAbsolute(coords[i] ?? 0, coords[i + 1] ?? 0)
        const p = rotatePoint(abs.x, abs.y, cx, cy, delta)
        newCoords.push(p.x, p.y)
        currentX = abs.x
        currentY = abs.y
        if (cmd === 'M' && i === 0) {
          subpathStartX = abs.x
          subpathStartY = abs.y
        }
      }
      return { cmd, coords: newCoords }
    }

    if (cmd === 'H') {
      coords.forEach((x) => {
        const abs = toAbsolute(x ?? 0, 0)
        const p = rotatePoint(abs.x, currentY, cx, cy, delta)
        newCoords.push(p.x, p.y)
        currentX = abs.x
      })
      return { cmd: 'L', coords: newCoords }
    }

    if (cmd === 'V') {
      coords.forEach((y) => {
        const abs = toAbsolute(0, y ?? 0)
        const p = rotatePoint(currentX, abs.y, cx, cy, delta)
        newCoords.push(p.x, p.y)
        currentY = abs.y
      })
      return { cmd: 'L', coords: newCoords }
    }

    if (cmd === 'Q') {
      for (let i = 0; i < coords.length - 3; i += 4) {
        const c1 = toAbsolute(coords[i] ?? 0, coords[i + 1] ?? 0)
        const end = toAbsolute(coords[i + 2] ?? 0, coords[i + 3] ?? 0)
        const rp1 = rotatePoint(c1.x, c1.y, cx, cy, delta)
        const rp2 = rotatePoint(end.x, end.y, cx, cy, delta)
        newCoords.push(rp1.x, rp1.y, rp2.x, rp2.y)
        currentX = end.x
        currentY = end.y
      }
      return { cmd, coords: newCoords }
    }

    if (cmd === 'C') {
      for (let i = 0; i < coords.length - 5; i += 6) {
        const c1 = toAbsolute(coords[i] ?? 0, coords[i + 1] ?? 0)
        const c2 = toAbsolute(coords[i + 2] ?? 0, coords[i + 3] ?? 0)
        const end = toAbsolute(coords[i + 4] ?? 0, coords[i + 5] ?? 0)
        const rp1 = rotatePoint(c1.x, c1.y, cx, cy, delta)
        const rp2 = rotatePoint(c2.x, c2.y, cx, cy, delta)
        const rp3 = rotatePoint(end.x, end.y, cx, cy, delta)
        newCoords.push(rp1.x, rp1.y, rp2.x, rp2.y, rp3.x, rp3.y)
        currentX = end.x
        currentY = end.y
      }
      return { cmd, coords: newCoords }
    }

    return { cmd, coords }
  })

  return serializeSvgPath(rotated)
}

/**
 * Get angle of arrow from ax, ay (in degrees, 0 = right, 90 = down)
 */
function getArrowAngle(ax: number, ay: number): number {
  return (Math.atan2(-ay, -ax) * 180) / Math.PI
}

/**
 * Calculate ax, ay from angle and length
 */
function arrowFromAngle(angleDeg: number, length: number): { ax: number; ay: number } {
  const angleRad = (angleDeg * Math.PI) / 180
  return {
    ax: -length * Math.cos(angleRad),
    ay: -length * Math.sin(angleRad),
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function isCustomMarkup(item: any): boolean {
  if (item?.meta?.customMarkup === true) return true
  if (typeof item?.name === 'string' && item.name.startsWith(CUSTOM_MARKUP_NAME_PREFIX)) {
    return true
  }
  return false
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.startsWith('#')) {
    if (trimmed.length === 4) {
      const r = trimmed[1]
      const g = trimmed[2]
      const b = trimmed[3]
      return `#${r}${r}${g}${g}${b}${b}`
    }
    if (trimmed.length >= 7) {
      return trimmed.slice(0, 7)
    }
    return null
  }

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/)
  if (rgbMatch && rgbMatch[1]) {
    const parts = rgbMatch[1].split(',').map((part) => part.trim())
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map((part) => Number(part))
      const r = nums[0] ?? 0
      const g = nums[1] ?? 0
      const b = nums[2] ?? 0
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`
      }
    }
  }

  return null
}

function resolveColorInput(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  return normalizeHexColor(value) ?? fallback
}

type AxisRange = { start: number; end: number; type?: string }

function getAxisRange(
  axis: Partial<Layout['xaxis']> | Partial<Layout['yaxis']> | undefined
): AxisRange | null {
  const range = Array.isArray(axis?.range) ? axis?.range : null
  if (!range || range.length < 2) return null
  const start = Number(range[0])
  const end = Number(range[1])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start, end, type: axis?.type }
}

function convertAxisValue(
  value: number | string,
  fromRef: string,
  toRef: string,
  axis: AxisRange | null
): number | string {
  const fromIsPaper = fromRef === 'paper'
  const toIsPaper = toRef === 'paper'
  if (fromIsPaper === toIsPaper) return value
  if (!axis) return value
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return value
  const span = axis.end - axis.start
  if (!Number.isFinite(span) || Math.abs(span) < 1e-12) return value

  if (axis.type === 'log') {
    const logStart = axis.start
    const logSpan = axis.end - axis.start
    if (!Number.isFinite(logSpan) || Math.abs(logSpan) < 1e-12) return value
    if (fromIsPaper && !toIsPaper) {
      return Math.pow(10, logStart + logSpan * numeric)
    }
    if (!fromIsPaper && toIsPaper) {
      if (numeric <= 0) return value
      const logValue = Math.log10(numeric)
      if (!Number.isFinite(logValue)) return value
      return (logValue - logStart) / logSpan
    }
    return value
  }

  if (fromIsPaper && !toIsPaper) {
    return axis.start + span * numeric
  }
  if (!fromIsPaper && toIsPaper) {
    return (numeric - axis.start) / span
  }
  return value
}

function getItemLabel(item: MarkupItem): string {
  if (item.kind === 'shape') {
    const shape = item.data as CustomShape
    const label = shape.label?.text
    if (label) return `${shape.type}: ${label}`
    return `${shape.type} shape`
  } else {
    const ann = item.data as CustomAnnotation
    const text = ann.text?.slice(0, 20) || 'Annotation'
    return ann.showarrow ? `Arrow: ${text}` : `Text: ${text}`
  }
}

function getItemIcon(item: MarkupItem) {
  if (item.kind === 'shape') {
    const shape = item.data as CustomShape
    switch (shape.type) {
      case 'line':
        return <Minus className="h-3.5 w-3.5" />
      case 'rect':
        return <Square className="h-3.5 w-3.5" />
      case 'circle':
        return <Circle className="h-3.5 w-3.5" />
      default:
        return <Square className="h-3.5 w-3.5" />
    }
  } else {
    const ann = item.data as CustomAnnotation
    return ann.showarrow ? (
      <ArrowRight className="h-3.5 w-3.5" />
    ) : (
      <Type className="h-3.5 w-3.5" />
    )
  }
}

// ============================================================================
// Component
// ============================================================================

export function ShapesAnnotationsEditor({
  layout,
  onUpdateLayout,
  className,
}: ShapesAnnotationsEditorProps) {
  const { isConstrained } = useViewportMode()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [activeDrawTool, setActiveDrawTool] = useState<DrawTool>(() => {
    const meta = (layout.meta as LayoutMeta | undefined) ?? {}
    return meta.activeShapeTool ?? null
  })
  const previousDragModeRef = useRef<string | undefined>(undefined)
  const handledCreatedShapeIdRef = useRef<string | null>(null)
  const coordinateMode: DrawCoordinateMode = (() => {
    const mode = ((layout.meta as LayoutMeta | undefined) ?? {}).shapeCoordinateMode
    return mode === 'data' || mode === 'paper' || mode === 'auto' ? mode : 'paper'
  })()

  // Get custom shapes and annotations only
  const customItems = useMemo<MarkupItem[]>(() => {
    const items: MarkupItem[] = []

    // Custom shapes
    const shapes = (layout.shapes as CustomShape[]) ?? []
    shapes.forEach((shape, index) => {
      if (isCustomMarkup(shape)) {
        items.push({ kind: 'shape', index, data: shape })
      }
    })

    // Custom annotations
    const annotations = (layout.annotations as CustomAnnotation[]) ?? []
    annotations.forEach((ann, index) => {
      if (isCustomMarkup(ann)) {
        items.push({ kind: 'annotation', index, data: ann })
      }
    })

    return items
  }, [layout.shapes, layout.annotations])

  const xAxisRange = useMemo(
    () => getAxisRange(layout.xaxis as Partial<Layout['xaxis']> | undefined),
    [layout.xaxis]
  )
  const yAxisRange = useMemo(
    () => getAxisRange(layout.yaxis as Partial<Layout['yaxis']> | undefined),
    [layout.yaxis]
  )
  const xAxisType = ((layout.xaxis as Partial<Layout['xaxis']> | undefined)?.type ?? '') as string
  const yAxisType = ((layout.yaxis as Partial<Layout['yaxis']> | undefined)?.type ?? '') as string

  // -------------------------------------------------------------------------
  // Add new items
  // -------------------------------------------------------------------------

  const addAnnotation = useCallback(
    (withArrow: boolean) => {
      const xCanUseDataInAuto =
        xAxisType !== 'category' && xAxisType !== 'date' && Boolean(xAxisRange)
      const yCanUseDataInAuto =
        yAxisType !== 'category' && yAxisType !== 'date' && Boolean(yAxisRange)
      const xUseDataCoords =
        coordinateMode === 'data' || (coordinateMode === 'auto' && xCanUseDataInAuto)
      const yUseDataCoords =
        coordinateMode === 'data' || (coordinateMode === 'auto' && yCanUseDataInAuto)

      const resolvedX = xUseDataCoords
        ? convertAxisValue(0.5, 'paper', 'x', xAxisRange)
        : 0.5
      const resolvedY = yUseDataCoords
        ? convertAxisValue(0.5, 'paper', 'y', yAxisRange)
        : 0.5
      const safeX =
        typeof resolvedX === 'number' && !Number.isFinite(resolvedX) ? 0.5 : resolvedX
      const safeY =
        typeof resolvedY === 'number' && !Number.isFinite(resolvedY) ? 0.5 : resolvedY
      const id = generateId()
      const name = `${CUSTOM_MARKUP_NAME_PREFIX}${id}`
      const xRef: 'x' | 'paper' =
        xUseDataCoords && xAxisRange ? 'x' : 'paper'
      const yRef: 'y' | 'paper' =
        yUseDataCoords && yAxisRange ? 'y' : 'paper'
      const newAnnotation: CustomAnnotation = {
        text: 'Label',
        x: safeX,
        y: safeY,
        xref: xRef,
        yref: yRef,
        name,
        showarrow: withArrow,
        arrowhead: withArrow ? 2 : 0,
        arrowsize: 1,
        arrowwidth: 2,
        arrowcolor: '#636363',
        ax: withArrow ? -40 : 0,
        ay: withArrow ? -40 : 0,
        bgcolor: 'rgba(0, 0, 0, 0)',
        bordercolor: 'rgba(0, 0, 0, 0)',
        borderwidth: 0,
        borderpad: 0,
        font: { size: 12, color: '#000000' },
        align: 'center',
        opacity: 1,
        meta: { customMarkup: true, id },
      }

      const annotations = [
        ...((layout.annotations as CustomAnnotation[]) ?? []),
        newAnnotation,
      ]
      onUpdateLayout({ annotations })
      setSelectedId(id)
      setExpandedItems((prev) => new Set([...prev, id]))
    },
    [
      coordinateMode,
      layout.annotations,
      onUpdateLayout,
      xAxisRange,
      yAxisRange,
      xAxisType,
      yAxisType,
    ]
  )

  const activateDrawTool = useCallback(
    (tool: DrawTool) => {
      const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
      if (tool === activeDrawTool) {
        const restored = previousDragModeRef.current ?? (layout.dragmode as string | undefined) ?? 'zoom'
        onUpdateLayout({
          dragmode: restored,
          meta: { ...currentMeta, activeShapeTool: null },
        })
        setActiveDrawTool(null)
        return
      }

      previousDragModeRef.current = (layout.dragmode as string | undefined) ?? 'zoom'
      const dragmode =
        tool === 'line'
          ? 'drawline'
          : tool === 'rect'
            ? 'drawrect'
            : tool === 'circle'
              ? 'drawcircle'
              : tool === 'path'
                ? 'drawopenpath'
                : previousDragModeRef.current

      const newshape = tool
        ? {
            line: { color: '#2563eb', width: 2, dash: 'solid' },
            ...(tool === 'line' || tool === 'path'
              ? {}
              : { fillcolor: 'rgba(37, 99, 235, 0.2)' }),
            opacity: 1,
          }
        : undefined

      onUpdateLayout({
        dragmode,
        ...(newshape ? { newshape } : {}),
        meta: {
          ...currentMeta,
          activeShapeTool: tool,
          customMarkupEnabled: true,
          shapeCoordinateMode:
            currentMeta.shapeCoordinateMode === 'data' || currentMeta.shapeCoordinateMode === 'paper'
              ? currentMeta.shapeCoordinateMode
              : 'paper',
        },
      })
      setActiveDrawTool(tool)
    },
    [activeDrawTool, layout.dragmode, layout.meta, onUpdateLayout]
  )

  // Enable custom markup mode when shapes/annotations exist
  useEffect(() => {
    if (customItems.length === 0) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    if (currentMeta.customMarkupEnabled === true) return
    onUpdateLayout({
      meta: { ...currentMeta, customMarkupEnabled: true },
    })
  }, [customItems.length, layout.meta, onUpdateLayout])

  useEffect(() => {
    const meta = (layout.meta as LayoutMeta | undefined) ?? {}
    const nextTool = meta.activeShapeTool ?? null
    if (nextTool !== activeDrawTool) {
      setActiveDrawTool(nextTool)
    }
  }, [activeDrawTool, layout.meta])

  useEffect(() => {
    const meta = (layout.meta as LayoutMeta | undefined) ?? {}
    const createdShapeId = meta.lastCreatedCustomMarkupId
    if (!createdShapeId) return
    if (handledCreatedShapeIdRef.current === createdShapeId) return
    handledCreatedShapeIdRef.current = createdShapeId
    setSelectedId(createdShapeId)
    setExpandedItems((prev) => new Set([...prev, createdShapeId]))
    onUpdateLayout({
      meta: {
        ...(layout.meta as Record<string, unknown> | undefined),
        lastCreatedCustomMarkupId: null,
      },
    })
  }, [layout.meta, onUpdateLayout])

  // -------------------------------------------------------------------------
  // Update items
  // -------------------------------------------------------------------------

  const updateShape = useCallback(
    (index: number, updates: Partial<CustomShape>) => {
      const shapes = [...((layout.shapes as CustomShape[]) ?? [])]
      const existing = shapes[index]
      if (existing) {
        let nextShape = { ...existing, ...updates } as CustomShape
        const currentXref = existing.xref ?? 'paper'
        const nextXref = updates.xref ?? currentXref
        if (nextXref !== currentXref) {
          nextShape = {
            ...nextShape,
            x0: convertAxisValue(nextShape.x0, currentXref, nextXref, xAxisRange),
            x1: convertAxisValue(nextShape.x1, currentXref, nextXref, xAxisRange),
            xref: nextXref,
          }
        }
        const currentYref = existing.yref ?? 'paper'
        const nextYref = updates.yref ?? currentYref
        if (nextYref !== currentYref) {
          nextShape = {
            ...nextShape,
            y0: convertAxisValue(nextShape.y0, currentYref, nextYref, yAxisRange),
            y1: convertAxisValue(nextShape.y1, currentYref, nextYref, yAxisRange),
            yref: nextYref,
          }
        }
        shapes[index] = nextShape
        onUpdateLayout({ shapes })
      }
    },
    [layout.shapes, onUpdateLayout, xAxisRange, yAxisRange]
  )

  const updateAnnotation = useCallback(
    (index: number, updates: Partial<CustomAnnotation>) => {
      const annotations = [...((layout.annotations as CustomAnnotation[]) ?? [])]
      const existing = annotations[index]
      if (existing) {
        annotations[index] = { ...existing, ...updates } as CustomAnnotation
        onUpdateLayout({ annotations })
      }
    },
    [layout.annotations, onUpdateLayout]
  )

  // -------------------------------------------------------------------------
  // Delete items
  // -------------------------------------------------------------------------

  const deleteItem = useCallback(
    (item: MarkupItem) => {
      const stableId = item.data.meta?.id ?? `${item.kind}-${item.index}`
      if (item.kind === 'shape') {
        const targetId = item.data.meta?.id
        const shapes = ((layout.shapes as CustomShape[]) ?? []).filter((shape, i) =>
          targetId ? shape.meta?.id !== targetId : i !== item.index
        )
        onUpdateLayout({ shapes })
      } else {
        const targetId = item.data.meta?.id
        const annotations = ((layout.annotations as CustomAnnotation[]) ?? []).filter(
          (annotation, i) => (targetId ? annotation.meta?.id !== targetId : i !== item.index)
        )
        onUpdateLayout({ annotations })
      }
      if (selectedId === stableId) {
        setSelectedId(null)
      }
    },
    [layout.shapes, layout.annotations, onUpdateLayout, selectedId]
  )

  // -------------------------------------------------------------------------
  // Toggle expand
  // -------------------------------------------------------------------------

  const toggleExpand = useCallback((id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className={cn('space-y-3', className)}>
      {/* Shapes palette */}
      <div className="space-y-2">
        <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          Shapes & Annotations
        </Label>
        <div className={cn('grid gap-2 items-center', isConstrained ? 'grid-cols-1' : 'grid-cols-[auto,1fr]')}>
          <Label className="text-xs text-zinc-500">Coordinate mode</Label>
          <Select
            value={coordinateMode}
            onValueChange={(value) => {
              const nextMode: DrawCoordinateMode =
                value === 'data' || value === 'paper' || value === 'auto' ? value : 'paper'
              const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
              onUpdateLayout({
                meta: {
                  ...currentMeta,
                  shapeCoordinateMode: nextMode,
                },
              })
            }}
          >
            <SelectTrigger className="h-8 text-xs" aria-label="Shape coordinate mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="data">Data</SelectItem>
              <SelectItem value="paper">Paper</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
          <Button
            variant={activeDrawTool === 'line' ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => activateDrawTool('line')}
          >
            <Minus className="h-3.5 w-3.5 mr-1" />
            Line
          </Button>
          <Button
            variant={activeDrawTool === 'rect' ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => activateDrawTool('rect')}
          >
            <Square className="h-3.5 w-3.5 mr-1" />
            Rectangle
          </Button>
          <Button
            variant={activeDrawTool === 'circle' ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => activateDrawTool('circle')}
          >
            <Circle className="h-3.5 w-3.5 mr-1" />
            Circle
          </Button>
          <Button
            variant={activeDrawTool === 'path' ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => activateDrawTool('path')}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Freeform
          </Button>
        </div>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => addAnnotation(false)}
          >
            <Type className="h-3.5 w-3.5 mr-1" />
            Text
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => addAnnotation(true)}
          >
            <ArrowRight className="h-3.5 w-3.5 mr-1" />
            Text + Arrow
          </Button>
        </div>
        {activeDrawTool && (
          <div className="text-[10px] text-zinc-500">
            Drag on the plot to draw a {activeDrawTool === 'path' ? 'freeform path' : activeDrawTool}.
            Click the active button again to exit draw mode.
          </div>
        )}
      </div>

      {/* Empty state */}
      {customItems.length === 0 && (
        <div className="text-xs text-zinc-500 text-center py-4 border border-dashed rounded">
          No custom shapes or annotations.
          <br />
          Use the tools above to draw or add one.
        </div>
      )}

      {/* Items list */}
      <div className="space-y-1">
        {customItems.map((item) => {
          const id = item.data.meta?.id ?? `${item.kind}-${item.index}`
          const isExpanded = expandedItems.has(id)
          const isSelected = selectedId === id

          return (
            <Collapsible key={id} open={isExpanded} onOpenChange={() => toggleExpand(id)}>
              <div
                className={cn(
                  'border rounded transition-colors',
                  isSelected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                    : 'border-zinc-200 dark:border-zinc-700'
                )}
              >
                {/* Item header */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${getItemLabel(item)}`}
                  className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  onClick={() => {
                    setSelectedId(id)
                    toggleExpand(id)
                    if (item.kind === 'shape' && item.data.visible === false) {
                      updateShape(item.index, { visible: true })
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedId(id)
                      toggleExpand(id)
                      if (item.kind === 'shape' && item.data.visible === false) {
                        updateShape(item.index, { visible: true })
                      }
                    }
                  }}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                  )}
                  {getItemIcon(item)}
                  <span className="text-xs flex-1 min-w-0 truncate">{getItemLabel(item)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-zinc-400 hover:text-red-500"
                    aria-label={`Delete ${getItemLabel(item)}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteItem(item)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>

                {/* Item editor */}
                <CollapsibleContent>
                  <div className="px-2 pb-2 pt-1 border-t border-zinc-200 dark:border-zinc-700">
                    {item.kind === 'shape' ? (
                      <ShapeEditor
                        shape={item.data}
                        isConstrained={isConstrained}
                        onUpdate={(updates) => updateShape(item.index, updates)}
                      />
                    ) : (
                      <AnnotationEditor
                        annotation={item.data}
                        isConstrained={isConstrained}
                        onUpdate={(updates) => updateAnnotation(item.index, updates)}
                      />
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// Shape Editor
// ============================================================================

interface ShapeEditorProps {
  shape: CustomShape
  isConstrained: boolean
  onUpdate: (updates: Partial<CustomShape>) => void
}

function ShapeEditor({ shape, isConstrained, onUpdate }: ShapeEditorProps) {
  const idBase = useId()
  const lineRotationLabelId = `${idBase}-line-rotation-label`
  const pathRotationLabelId = `${idBase}-path-rotation-label`
  const labelRotationLabelId = `${idBase}-label-rotation-label`
  const onUpdateRef = useRef(onUpdate)
  useEffect(() => {
    onUpdateRef.current = onUpdate
  }, [onUpdate])
  const debouncedColorUpdate = useMemo(
    () =>
      debounce((updates: Partial<CustomShape>) => {
        onUpdateRef.current(updates)
      }, 120),
    []
  )
  useEffect(() => {
    return () => debouncedColorUpdate.cancel()
  }, [debouncedColorUpdate])
  const labelPositions = shape.type === 'line' ? LINE_TEXT_POSITIONS : TEXT_POSITIONS
  const defaultLabelPosition = shape.type === 'line' ? 'middle' : 'middle center'
  const labelFontFamily = resolvePlotFontFamily(shape.label?.font?.family)
  const labelFontSize = Number.isFinite(Number(shape.label?.font?.size))
    ? Number(shape.label?.font?.size)
    : 12

  // Calculate current angle for line shapes
  const lineX0 = Number(shape.x0)
  const lineY0 = Number(shape.y0)
  const lineX1 = Number(shape.x1)
  const lineY1 = Number(shape.y1)
  const hasLineCoords =
    Number.isFinite(lineX0) &&
    Number.isFinite(lineY0) &&
    Number.isFinite(lineX1) &&
    Number.isFinite(lineY1)
  const currentLineAngle =
    shape.type === 'line' && hasLineCoords
      ? Math.round(getLineAngle(lineX0, lineY0, lineX1, lineY1))
      : 0

  // Get stored rotation angle for path shapes (stored in meta since path geometry changes)
  const pathRotationAngle = shape.meta?.rotationAngle ?? 0

  // Handle line rotation
  const handleLineRotation = (newAngle: number) => {
    if (!hasLineCoords) return
    const rotated = rotateLine(lineX0, lineY0, lineX1, lineY1, newAngle)
    onUpdate(rotated)
  }

  // Handle path rotation
  const handlePathRotation = (newAngle: number) => {
    if (!shape.path) return
    const currentAngle = shape.meta?.rotationAngle ?? 0
    const newPath = rotateSvgPath(shape.path, newAngle, currentAngle)
    // Preserve existing meta properties (customMarkup, id) while updating rotationAngle
    const existingMeta = typeof shape.meta === 'object' && shape.meta !== null ? shape.meta : {}
    onUpdate({
      path: newPath,
      meta: { ...existingMeta, rotationAngle: newAngle },
    })
  }

  return (
    <div className="space-y-3 text-xs">
      {/* Rotation control for line shapes */}
      {shape.type === 'line' && (
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-500 flex items-center gap-1" id={lineRotationLabelId}>
            <RotateCw className="h-3 w-3" aria-hidden="true" />
            Rotation
          </Label>
          {hasLineCoords ? (
            <div className="flex items-center gap-2">
              <Slider
                value={[currentLineAngle]}
                min={-180}
                max={180}
                step={1}
                onValueChange={([val]) => val !== undefined && handleLineRotation(val)}
                className="flex-1"
                aria-label="Line rotation angle"
                aria-labelledby={lineRotationLabelId}
              />
              <span className="text-[10px] text-zinc-500 w-10 text-right" aria-live="polite">{currentLineAngle}°</span>
            </div>
          ) : (
            <div className="text-[10px] text-zinc-400">
              Rotation is only available for numeric coordinates.
            </div>
          )}
        </div>
      )}

      {/* Rotation control for path shapes */}
      {shape.type === 'path' && (
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-500 flex items-center gap-1" id={pathRotationLabelId}>
            <RotateCw className="h-3 w-3" aria-hidden="true" />
            Rotation
          </Label>
          <div className="flex items-center gap-2">
            <Slider
              value={[pathRotationAngle]}
              min={-180}
              max={180}
              step={1}
              onValueChange={([val]) => val !== undefined && handlePathRotation(val)}
              className="flex-1"
              aria-label="Path rotation angle"
              aria-labelledby={pathRotationLabelId}
            />
            <span className="text-[10px] text-zinc-500 w-10 text-right" aria-live="polite">{pathRotationAngle}°</span>
          </div>
          <div className="text-[10px] text-zinc-400">
            Position editing not available for freeform paths.
          </div>
        </div>
      )}

      {/* Position controls (not for path shapes) */}
      {shape.type !== 'path' && (
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-500">Position</Label>
          <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400">X0</span>
              <Input
                type="number"
                step="0.01"
                value={shape.x0}
                onChange={(e) => onUpdate({ x0: toNumber(e.target.value, Number(shape.x0) || 0) })}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400">X1</span>
              <Input
                type="number"
                step="0.01"
                value={shape.x1}
                onChange={(e) => onUpdate({ x1: toNumber(e.target.value, Number(shape.x1) || 0) })}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400">Y0</span>
              <Input
                type="number"
                step="0.01"
                value={shape.y0}
                onChange={(e) => onUpdate({ y0: toNumber(e.target.value, Number(shape.y0) || 0) })}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400">Y1</span>
              <Input
                type="number"
                step="0.01"
                value={shape.y1}
                onChange={(e) => onUpdate({ y1: toNumber(e.target.value, Number(shape.y1) || 0) })}
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
            <Select
              value={shape.xref ?? 'paper'}
              onValueChange={(v) => onUpdate({ xref: v })}
            >
              <SelectTrigger className="h-7 text-xs" aria-label="X coordinate reference">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="paper">X: Paper (0-1)</SelectItem>
                <SelectItem value="x">X: Data</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={shape.yref ?? 'paper'}
              onValueChange={(v) => onUpdate({ yref: v })}
            >
              <SelectTrigger className="h-7 text-xs" aria-label="Y coordinate reference">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="paper">Y: Paper (0-1)</SelectItem>
                <SelectItem value="y">Y: Data</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Line style */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500">Line Style</Label>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-3')}>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Color</span>
            <Input
              type="color"
              value={resolveColorInput(shape.line?.color, '#2563eb')}
              onChange={(e) =>
                debouncedColorUpdate({
                  line: { ...shape.line, color: e.target.value },
                })
              }
              className="h-7 p-1"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Width</span>
            <Input
              type="number"
              min="0"
              max="20"
              step="0.5"
              value={shape.line?.width ?? 2}
              onChange={(e) =>
                onUpdate({ line: { ...shape.line, width: toNumber(e.target.value, shape.line?.width ?? 2) } })
              }
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Dash</span>
            <Select
              value={shape.line?.dash ?? 'solid'}
              onValueChange={(v) => onUpdate({ line: { ...shape.line, dash: v } })}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DASH_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Fill (for rect/circle) */}
      {shape.type !== 'line' && (
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-500">Fill</Label>
          <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400">Fill Color</span>
            <Input
              type="color"
              value={resolveColorInput(shape.fillcolor, '#2563eb')}
              onChange={(e) => {
                debouncedColorUpdate({ fillcolor: e.target.value })
              }}
              className="h-7 p-1"
            />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400">Opacity</span>
            <Input
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={shape.opacity ?? 1}
              onChange={(e) => onUpdate({ opacity: toNumber(e.target.value, shape.opacity ?? 1) })}
              className="h-7 text-xs"
            />
            </div>
          </div>
          <div className="text-[10px] text-zinc-400">
            Use Opacity for transparency.
          </div>
        </div>
      )}

      {/* Label */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500">Label</Label>
        <Input
          value={shape.label?.text ?? ''}
          onChange={(e) =>
            onUpdate({ label: { ...shape.label, text: e.target.value } })
          }
          placeholder="Shape label"
          className="h-7 text-xs"
        />
        {shape.label?.text && (
          <div className="space-y-2">
            <Select
              value={shape.label?.textposition ?? defaultLabelPosition}
              onValueChange={(v) =>
                onUpdate({ label: { ...shape.label, textposition: v } })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {labelPositions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Font</span>
                <Select
                  value={labelFontFamily}
                  onValueChange={(v) =>
                    onUpdate({
                      label: {
                        ...shape.label,
                        font: { ...(shape.label?.font ?? {}), family: v },
                      },
                    })
                  }
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLOT_FONTS.map((font) => (
                      <SelectItem
                        key={font.value}
                        value={font.value}
                        style={{ fontFamily: font.value }}
                      >
                        {font.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Size</span>
                <Input
                  type="number"
                  min="8"
                  max="72"
                  value={labelFontSize}
                  onChange={(e) =>
                    onUpdate({
                      label: {
                        ...shape.label,
                        font: {
                          ...(shape.label?.font ?? {}),
                          size: toNumber(e.target.value, labelFontSize),
                        },
                      },
                    })
                  }
                  className="h-7 text-xs"
                />
              </div>
            </div>
            <div>
              <Label className="text-[10px] text-zinc-500 flex items-center gap-1" id={labelRotationLabelId}>
                <RotateCw className="h-3 w-3" aria-hidden="true" />
                Label Rotation
              </Label>
              <div className="flex items-center gap-2">
                <Slider
                  value={[Number(shape.label?.textangle ?? 0)]}
                  min={-180}
                  max={180}
                  step={1}
                  onValueChange={([val]) =>
                    val !== undefined &&
                    onUpdate({ label: { ...shape.label, textangle: val } })
                  }
                  className="flex-1"
                  aria-label="Label rotation angle"
                  aria-labelledby={labelRotationLabelId}
                />
                <span className="text-[10px] text-zinc-500 w-10 text-right" aria-live="polite">
                  {Number(shape.label?.textangle ?? 0)}°
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Annotation Editor
// ============================================================================

interface AnnotationEditorProps {
  annotation: CustomAnnotation
  isConstrained: boolean
  onUpdate: (updates: Partial<CustomAnnotation>) => void
}

function AnnotationEditor({ annotation, isConstrained, onUpdate }: AnnotationEditorProps) {
  const idBase = useId()
  const textRotationLabelId = `${idBase}-text-rotation-label`
  const arrowAngleLabelId = `${idBase}-arrow-angle-label`
  const showArrowSwitchId = `${idBase}-show-arrow-switch`
  const onUpdateRef = useRef(onUpdate)
  useEffect(() => {
    onUpdateRef.current = onUpdate
  }, [onUpdate])
  const debouncedColorUpdate = useMemo(
    () =>
      debounce((updates: Partial<CustomAnnotation>) => {
        onUpdateRef.current(updates)
      }, 120),
    []
  )
  useEffect(() => {
    return () => debouncedColorUpdate.cancel()
  }, [debouncedColorUpdate])

  const annotationFontFamily = resolvePlotFontFamily(annotation.font?.family)
  // Calculate current arrow angle from ax, ay
  const ax = annotation.ax ?? 0
  const ay = annotation.ay ?? 0
  const arrowLength = Math.sqrt(ax * ax + ay * ay)
  const currentArrowAngle = Math.round(getArrowAngle(ax, ay))

  // Handle arrow rotation - keeps length, changes angle
  const handleArrowRotation = (newAngle: number) => {
    const length = arrowLength || 40 // default length if 0
    const { ax: newAx, ay: newAy } = arrowFromAngle(newAngle, length)
    onUpdate({ ax: Math.round(newAx), ay: Math.round(newAy) })
  }

  return (
    <div className="space-y-3 text-xs">
      {/* Text */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500">Text</Label>
        <Input
          value={annotation.text ?? ''}
          onChange={(e) => onUpdate({ text: e.target.value })}
          placeholder="Label text"
          className="h-7 text-xs"
        />
      </div>

      {/* Text Angle */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500 flex items-center gap-1" id={textRotationLabelId}>
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Text Rotation
        </Label>
        <div className="flex items-center gap-2">
          <Slider
            value={[annotation.textangle ?? 0]}
            min={-180}
            max={180}
            step={1}
            onValueChange={([val]) => val !== undefined && onUpdate({ textangle: val })}
            className="flex-1"
            aria-label="Text rotation angle"
            aria-labelledby={textRotationLabelId}
          />
          <span className="text-[10px] text-zinc-500 w-10 text-right" aria-live="polite">{annotation.textangle ?? 0}°</span>
        </div>
      </div>

      {/* Position */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500">Position</Label>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">X</span>
            <Input
              type="number"
              step="0.01"
              value={annotation.x}
              onChange={(e) => onUpdate({ x: toNumber(e.target.value, Number(annotation.x) || 0) })}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Y</span>
            <Input
              type="number"
              step="0.01"
              value={annotation.y}
              onChange={(e) => onUpdate({ y: toNumber(e.target.value, Number(annotation.y) || 0) })}
              className="h-7 text-xs"
            />
          </div>
        </div>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
          <Select
            value={annotation.xref ?? 'paper'}
            onValueChange={(v) => onUpdate({ xref: v })}
          >
            <SelectTrigger className="h-7 text-xs" aria-label="X coordinate reference">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paper">X: Paper (0-1)</SelectItem>
              <SelectItem value="x">X: Data</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={annotation.yref ?? 'paper'}
            onValueChange={(v) => onUpdate({ yref: v })}
          >
            <SelectTrigger className="h-7 text-xs" aria-label="Y coordinate reference">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paper">Y: Paper (0-1)</SelectItem>
              <SelectItem value="y">Y: Data</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Font */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500">Font</Label>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
          <div className="space-y-1 col-span-2">
            <span className="text-[10px] text-zinc-400">Font</span>
            <Select
              value={annotationFontFamily}
              onValueChange={(v) =>
                onUpdate({
                  font: { ...(annotation.font ?? {}), family: v },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLOT_FONTS.map((font) => (
                  <SelectItem
                    key={font.value}
                    value={font.value}
                    style={{ fontFamily: font.value }}
                  >
                    {font.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Size</span>
            <Input
              type="number"
              min="8"
              max="72"
              value={annotation.font?.size ?? 12}
              onChange={(e) =>
                onUpdate({ font: { ...annotation.font, size: toNumber(e.target.value, annotation.font?.size ?? 12) } })
              }
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Color</span>
            <Input
              type="color"
              value={resolveColorInput(annotation.font?.color, '#000000')}
              onChange={(e) =>
                debouncedColorUpdate({
                  font: { ...annotation.font, color: e.target.value },
                })
              }
              className="h-7 p-1"
            />
          </div>
        </div>
      </div>

      {/* Background */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-500">Background</Label>
        <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Fill</span>
            <Input
              type="color"
              value={resolveColorInput(annotation.bgcolor, '#ffffff')}
              onChange={(e) => debouncedColorUpdate({ bgcolor: e.target.value })}
              className="h-7 p-1"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400">Border</span>
            <Input
              type="color"
              value={resolveColorInput(annotation.bordercolor, '#c7c7c7')}
              onChange={(e) => debouncedColorUpdate({ bordercolor: e.target.value })}
              className="h-7 p-1"
            />
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Switch
            id={showArrowSwitchId}
            checked={annotation.showarrow ?? false}
            onCheckedChange={(checked) => onUpdate({ showarrow: checked })}
            aria-label="Show arrow"
          />
          <Label htmlFor={showArrowSwitchId} className="text-xs text-zinc-500">Show Arrow</Label>
        </div>

        {annotation.showarrow && (
          <div className="space-y-2 pl-2 border-l-2 border-zinc-200 dark:border-zinc-700">
            {/* Arrow Rotation */}
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400 flex items-center gap-1" id={arrowAngleLabelId}>
                <RotateCw className="h-2.5 w-2.5" aria-hidden="true" />
                Arrow Angle
              </span>
              <div className="flex items-center gap-2">
                <Slider
                  value={[currentArrowAngle]}
                  min={-180}
                  max={180}
                  step={1}
                  onValueChange={([val]) => val !== undefined && handleArrowRotation(val)}
                  className="flex-1"
                  aria-label="Arrow angle"
                  aria-labelledby={arrowAngleLabelId}
                />
                <span className="text-[10px] text-zinc-500 w-10 text-right" aria-live="polite">{currentArrowAngle}°</span>
              </div>
            </div>
            <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Arrow Head</span>
                <Select
                  value={String(annotation.arrowhead ?? 2)}
                  onValueChange={(v) => onUpdate({ arrowhead: parseInt(v) })}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ARROW_HEADS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Color</span>
                <Input
                  type="color"
                  value={annotation.arrowcolor ?? '#636363'}
                  onChange={(e) => debouncedColorUpdate({ arrowcolor: e.target.value })}
                  className="h-7 p-1"
                />
              </div>
            </div>
            <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Tail X (px)</span>
                <Input
                  type="number"
                  value={annotation.ax ?? -40}
                  onChange={(e) => onUpdate({ ax: toNumber(e.target.value, annotation.ax ?? -40) })}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Tail Y (px)</span>
                <Input
                  type="number"
                  value={annotation.ay ?? -40}
                  onChange={(e) => onUpdate({ ay: toNumber(e.target.value, annotation.ay ?? -40) })}
                  className="h-7 text-xs"
                />
              </div>
            </div>
            <div className={cn('grid gap-2', isConstrained ? 'grid-cols-1' : 'grid-cols-2')}>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Width</span>
                <Input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.5"
                  value={annotation.arrowwidth ?? 2}
                  onChange={(e) => onUpdate({ arrowwidth: toNumber(e.target.value, annotation.arrowwidth ?? 2) })}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Size</span>
                <Input
                  type="number"
                  min="0.3"
                  max="3"
                  step="0.1"
                  value={annotation.arrowsize ?? 1}
                  onChange={(e) => onUpdate({ arrowsize: toNumber(e.target.value, annotation.arrowsize ?? 1) })}
                  className="h-7 text-xs"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default ShapesAnnotationsEditor
