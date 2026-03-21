/**
 * DraggableLegend Component - Custom HTML legend overlay for plots
 *
 * Features:
 * - Draggable within plot container bounds
 * - Click to toggle trace visibility
 * - Shift+click to isolate trace (show only that trace)
 * - Position persists via callback
 * - Auto-clamps to container on resize
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import type { Data } from 'plotly.js'
import { cn } from '@/lib/utils'

export interface LegendItem {
  index: number
  name: string
  color: string
  visible: boolean
  type?: string
}

export interface LegendPosition {
  x: number
  y: number
}

export interface LegendSize {
  width: number
  height: number
}

export interface DraggableLegendProps {
  /** Plot trace data */
  traces: Data[]
  /** Container ref for bounds clamping */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Current legend position (0-1 normalized or pixels) */
  position?: LegendPosition
  /** Callback when position changes */
  onPositionChange?: (position: LegendPosition) => void
  /** Current legend size */
  size?: LegendSize
  /** Callback when size changes */
  onSizeChange?: (size: LegendSize) => void
  /** Callback when trace visibility toggled */
  onToggleTrace?: (traceIndex: number, visible: boolean) => void
  /** Callback for isolate (show only this trace) */
  onIsolateTrace?: (traceIndex: number) => void
  /** Whether to show the legend */
  show?: boolean
  /** Padding from container edges */
  padding?: number
  /** CSS class name */
  className?: string
}

/**
 * Extract color from trace data
 */
function getTraceColor(trace: Data, index: number): string {
  const t = trace as Record<string, unknown>
  // Try marker.color first
  if (typeof t.marker === 'object' && t.marker !== null) {
    const marker = t.marker as Record<string, unknown>
    if (typeof marker.color === 'string') return marker.color
    if (Array.isArray(marker.color) && typeof marker.color[0] === 'string') {
      return marker.color[0]
    }
  }
  // Try line.color
  if (typeof t.line === 'object' && t.line !== null) {
    const line = t.line as Record<string, unknown>
    if (typeof line.color === 'string') return line.color
  }
  // Try fillcolor
  if (typeof t.fillcolor === 'string') return t.fillcolor
  // Default colors
  const defaultColors = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
  ]
  const idx = Number.isFinite(index) ? index : 0
  return defaultColors[idx % defaultColors.length] ?? '#1f77b4'
}

/**
 * Extract legend items from traces
 */
function extractLegendItems(traces: Data[]): LegendItem[] {
  const items: LegendItem[] = []
  traces.forEach((trace, index) => {
    const t = trace as Record<string, unknown>
    // Skip traces that shouldn't show in legend
    if (t.showlegend === false) return
    // Skip internal traces (like trendlines with specific meta)
    const meta = t.meta as Record<string, unknown> | undefined
    if (meta?.trendline === true) return

    const name = typeof t.name === 'string' ? t.name : `Trace ${index + 1}`
    const color = getTraceColor(trace, index)
    const visible = t.visible !== false && t.visible !== 'legendonly'

    items.push({ index, name, color, visible, type: t.type as string })
  })
  return items
}

// Default legend size constraints
const DEFAULT_WIDTH = 150
const DEFAULT_HEIGHT = 200
const MIN_WIDTH = 80
const MIN_HEIGHT = 60
const MAX_WIDTH = 300
const MAX_HEIGHT = 400

export function DraggableLegend({
  traces,
  containerRef,
  position,
  onPositionChange,
  size,
  onSizeChange,
  onToggleTrace,
  onIsolateTrace,
  show = true,
  padding = 8,
  className,
}: DraggableLegendProps) {
  const legendRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [localPosition, setLocalPosition] = useState<LegendPosition>({ x: 0, y: 0 })
  const [localSize, setLocalSize] = useState<LegendSize>(() => ({
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, size?.width ?? DEFAULT_WIDTH)),
    height: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, size?.height ?? DEFAULT_HEIGHT)),
  }))
  const [initialized, setInitialized] = useState(false)
  const latestPositionRef = useRef(localPosition)
  const latestSizeRef = useRef(localSize)

  const legendItems = extractLegendItems(traces)

  const clampPosition = useCallback((pos: LegendPosition): LegendPosition => {
    const container = containerRef.current
    const legend = legendRef.current
    if (!container || !legend) return pos

    const containerRect = container.getBoundingClientRect()
    const legendRect = legend.getBoundingClientRect()

    const maxX = containerRect.width - legendRect.width - padding
    const maxY = containerRect.height - legendRect.height - padding

    return {
      x: Math.max(padding, Math.min(pos.x, maxX)),
      y: Math.max(padding, Math.min(pos.y, maxY)),
    }
  }, [containerRef, padding])

  const clampSize = useCallback((value: LegendSize): LegendSize => {
    return {
      width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value.width)),
      height: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, value.height)),
    }
  }, [])

  const resolvePosition = useCallback((pos: LegendPosition, containerRect: DOMRect) => {
    const isNormalized =
      pos.x >= 0 &&
      pos.x <= 1 &&
      pos.y >= 0 &&
      pos.y <= 1
    if (!isNormalized) return pos

    return {
      x: pos.x * containerRect.width,
      y: pos.y * containerRect.height,
    }
  }, [])

  // Initialize position (top-right default)
  useEffect(() => {
    if (initialized) return
    const container = containerRef.current
    const legend = legendRef.current
    if (!container || !legend) return

    const containerRect = container.getBoundingClientRect()
    const legendRect = legend.getBoundingClientRect()

    // Default: top-right with padding
    const defaultX = containerRect.width - legendRect.width - padding
    const defaultY = padding

    const initialPos = position
      ? resolvePosition(position, containerRect)
      : { x: defaultX, y: defaultY }
    setLocalPosition(clampPosition(initialPos))
    setInitialized(true)
  }, [containerRef, position, padding, initialized, clampPosition, resolvePosition])

  useEffect(() => {
    if (!position || isDragging) return
    const container = containerRef.current
    if (!container) return
    const resolved = resolvePosition(position, container.getBoundingClientRect())
    setLocalPosition(clampPosition(resolved))
    setInitialized(true)
  }, [position, isDragging, containerRef, clampPosition, resolvePosition])

  // Handle resize - re-clamp position
  useEffect(() => {
    const container = containerRef.current
    const legend = legendRef.current
    if (!container || !legend) return

    const observer = new ResizeObserver(() => {
      setLocalPosition((prev) => clampPosition(prev))
    })

    observer.observe(container)
    observer.observe(legend)
    return () => observer.disconnect()
  }, [containerRef, clampPosition])

  // Mouse down - start drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const legend = legendRef.current
    if (!legend) return

    const legendRect = legend.getBoundingClientRect()
    setDragOffset({
      x: e.clientX - legendRect.left,
      y: e.clientY - legendRect.top,
    })
    setIsDragging(true)
  }, [])

  // Mouse move - drag
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return

      const containerRect = container.getBoundingClientRect()
      const newX = e.clientX - containerRect.left - dragOffset.x
      const newY = e.clientY - containerRect.top - dragOffset.y

      const clampedPos = clampPosition({ x: newX, y: newY })
      latestPositionRef.current = clampedPos
      setLocalPosition(clampedPos)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onPositionChange?.(latestPositionRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, dragOffset, containerRef, clampPosition, onPositionChange, localPosition])

  useEffect(() => {
    latestPositionRef.current = localPosition
  }, [localPosition])

  useEffect(() => {
    latestSizeRef.current = localSize
  }, [localSize])

  // Sync size from props
  useEffect(() => {
    if (size && !isResizing) {
      setLocalSize(clampSize(size))
    }
  }, [size, isResizing, clampSize])

  // Mouse down - start resize
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
  }, [])

  // Mouse move/up - resize
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const legend = legendRef.current
      if (!legend) return

      const legendRect = legend.getBoundingClientRect()
      const nextSize = clampSize({
        width: e.clientX - legendRect.left,
        height: e.clientY - legendRect.top,
      })

      latestSizeRef.current = nextSize
      setLocalSize(nextSize)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      onSizeChange?.(latestSizeRef.current)
      onPositionChange?.(latestPositionRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, onSizeChange, onPositionChange, clampSize])

  // Handle legend item click
  const handleItemClick = useCallback((e: React.MouseEvent, item: LegendItem) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.shiftKey) {
      // Shift+click: isolate this trace
      onIsolateTrace?.(item.index)
    } else {
      // Regular click: toggle visibility
      onToggleTrace?.(item.index, !item.visible)
    }
  }, [onToggleTrace, onIsolateTrace])

  if (!show || legendItems.length === 0) return null

  return (
    <div
      ref={legendRef}
      className={cn(
        'absolute z-10 bg-white/95 dark:bg-gray-900/95 border border-gray-200 dark:border-gray-700',
        'rounded-md shadow-sm px-2 py-1.5 select-none flex flex-col',
        isDragging ? 'cursor-grabbing' : 'cursor-default',
        isResizing && 'cursor-se-resize',
        className
      )}
      style={{
        left: localPosition.x,
        top: localPosition.y,
        width: localSize.width,
        height: localSize.height,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        overflow: 'hidden',
      }}
    >
      {/* Drag handle indicator */}
      <div
        className={cn(
          'flex items-center gap-1 mb-1 pb-1 border-b border-gray-100 dark:border-gray-800',
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onMouseDown={handleMouseDown}
        title="Drag legend"
      >
        <div className="flex gap-0.5">
          <span className="w-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
          <span className="w-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
          <span className="w-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
        </div>
        <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-1">Legend</span>
      </div>

      {/* Legend items (scrollable) */}
      <div className="space-y-0.5 overflow-y-auto flex-1 pr-1">
        {legendItems.map((item) => (
          <div
            key={item.index}
            className={cn(
              'flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer',
              'hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors',
              !item.visible && 'opacity-40'
            )}
            onClick={(e) => handleItemClick(e, item)}
            title={item.visible ? 'Click to hide, Shift+click to isolate' : 'Click to show'}
          >
            {/* Color swatch */}
            <span
              className="w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: item.color }}
            />
            {/* Name */}
            <span className="text-xs text-gray-700 dark:text-gray-300 truncate">
              {item.name}
            </span>
          </div>
        ))}
      </div>

      {/* Resize handle (bottom-right corner) */}
      <div
        className={cn(
          'absolute bottom-0 right-0 w-3 h-3 cursor-se-resize',
          'flex items-center justify-center'
        )}
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize"
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className="text-gray-400 dark:text-gray-500"
        >
          <path
            d="M7 1L1 7M7 4L4 7M7 7L7 7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  )
}

export default DraggableLegend
