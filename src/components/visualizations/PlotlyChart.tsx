/**
 * PlotlyChart Component
 *
 * Wrapper around react-plotly.js for statistical visualizations.
 * Integrates with results-store to display test results, plots, and diagnostic charts.
 *
 * Features:
 * - Interactive charts (zoom, pan, hover)
 * - Export to PNG/SVG via modebar
 * - Responsive sizing
 * - Theme integration
 */

import { useMemo, useCallback, useEffect, useState } from 'react'
import PlotlyLazy from '@/components/plotly/PlotlyLazy'
import type { Data, Layout, Config, PlotMouseEvent } from 'plotly.js'

/**
 * Props for PlotlyChart
 */
export interface PlotlyChartProps {
  /** Plotly data traces */
  data: Data[]

  /** Plotly layout configuration */
  layout?: Partial<Layout>

  /** Plotly config options */
  config?: Partial<Config>

  /** Chart title */
  title?: string

  /** Chart width (default: 100%) */
  width?: string | number

  /** Chart height (default: 400px) */
  height?: string | number

  /** CSS class name */
  className?: string

  /** Click event handler */
  onClick?: (event: PlotMouseEvent) => void

  /** Hover event handler */
  onHover?: (event: PlotMouseEvent) => void

  /** Use responsive mode (auto-resize) */
  responsive?: boolean
}

/**
 * PlotlyChart Component
 *
 * Displays interactive Plotly charts with theme integration.
 */
export function PlotlyChart({
  data,
  layout = {},
  config = {},
  title,
  width = '100%',
  height = 400,
  className,
  onClick,
  onHover,
  responsive = true,
}: PlotlyChartProps) {
  const [chartData, setChartData] = useState<Data[]>(data)
  const [chartLayout, setChartLayout] = useState<Partial<Layout>>(layout)

  useEffect(() => {
    setChartData(data)
  }, [data])

  useEffect(() => {
    setChartLayout(layout)
  }, [layout])

  // Merge default layout with provided layout
  const finalLayout = useMemo<Partial<Layout>>(
    () => ({
      // Default layout
      autosize: responsive,
      margin: {
        l: 50,
        r: 50,
        t: title ? 50 : 30,
        b: 50,
      },
      font: {
        family: 'var(--font-family, sans-serif)',
        size: 12,
        color: 'var(--text)',
      },
      paper_bgcolor: 'var(--background)',
      plot_bgcolor: 'var(--background-secondary)',
      // Grid styling
      xaxis: {
        gridcolor: 'var(--border)',
        zerolinecolor: 'var(--border)',
        ...chartLayout.xaxis,
      },
      yaxis: {
        gridcolor: 'var(--border)',
        zerolinecolor: 'var(--border)',
        ...chartLayout.yaxis,
      },
      // Title
      title: title
        ? {
            text: title,
            font: {
              size: 16,
              color: 'var(--text)',
            },
            ...chartLayout.title,
          }
        : chartLayout.title,
      // Merge with user layout
      ...chartLayout,
      legend: {
        bordercolor: '#000000',
        borderwidth: 1,
        ...(chartLayout.legend ?? {}),
      },
    }),
    [chartLayout, title, responsive]
  )

  // Merge default config with provided config
  const finalConfig = useMemo<Partial<Config>>(
    () => ({
      // Display mode bar on hover
      displayModeBar: true,
      displaylogo: false,
      // Export options
      toImageButtonOptions: {
        format: 'png',
        filename: 'easycris_plot',
        height: 800,
        width: 1200,
        scale: 2,
      },
      // Responsive mode
      responsive: responsive,
      // Merge with user config
      ...config,
      // Enable inline text editing on double-click
      editable: true,
      edits: {
        ...(config.edits ?? {}),
        titleText: true,
        axisTitleText: true,
        legendText: true,
        annotationText: true,
        colorbarTitleText: config.edits?.colorbarTitleText ?? false,
        annotationPosition: false,
        annotationTail: false,
        legendPosition: false,
        shapePosition: false,
      },
    }),
    [config, responsive]
  )

  const handleRelayout = useCallback((event: Partial<Layout>) => {
    const relayoutData = event as Record<string, unknown>
    setChartLayout((prev) => {
      const updates: Partial<Layout> = {}
      let hasChanges = false

      if ('title.text' in relayoutData || (event.title && typeof event.title === 'object')) {
        const newTitle =
          'title.text' in relayoutData
            ? relayoutData['title.text']
            : (event.title as { text?: string })?.text
        if (typeof newTitle === 'string') {
          updates.title = { ...(prev.title as object ?? {}), text: newTitle }
          hasChanges = true
        }
      }

      if (
        'xaxis.title.text' in relayoutData ||
        (event.xaxis && typeof event.xaxis === 'object')
      ) {
        const newXTitle =
          'xaxis.title.text' in relayoutData
            ? relayoutData['xaxis.title.text']
            : (event.xaxis as { title?: { text?: string } })?.title?.text
        if (typeof newXTitle === 'string') {
          const currentXAxis = (prev.xaxis ?? {}) as Partial<Layout['xaxis']>
          updates.xaxis = {
            ...currentXAxis,
            title: {
              ...(typeof currentXAxis.title === 'object' ? currentXAxis.title : {}),
              text: newXTitle,
            },
          }
          hasChanges = true
        }
      }

      if (
        'yaxis.title.text' in relayoutData ||
        (event.yaxis && typeof event.yaxis === 'object')
      ) {
        const newYTitle =
          'yaxis.title.text' in relayoutData
            ? relayoutData['yaxis.title.text']
            : (event.yaxis as { title?: { text?: string } })?.title?.text
        if (typeof newYTitle === 'string') {
          const currentYAxis = (prev.yaxis ?? {}) as Partial<Layout['yaxis']>
          updates.yaxis = {
            ...currentYAxis,
            title: {
              ...(typeof currentYAxis.title === 'object' ? currentYAxis.title : {}),
              text: newYTitle,
            },
          }
          hasChanges = true
        }
      }

      if (event.annotations) {
        updates.annotations = event.annotations
        hasChanges = true
      } else {
        const annotationEdits = Object.entries(relayoutData)
          .map(([key, value]) => {
            const match = key.match(/^annotations\[(\d+)\]\.text$/)
            if (!match || typeof value !== 'string') return null
            return { index: Number(match[1]), text: value }
          })
          .filter(Boolean) as Array<{ index: number; text: string }>

        if (annotationEdits.length > 0) {
          const currentAnnotations = Array.isArray(prev.annotations)
            ? [...prev.annotations]
            : []
          let annotationsChanged = false

          annotationEdits.forEach(({ index, text }) => {
            const existing = (currentAnnotations[index] as { text?: string } | undefined) ?? {}
            if (existing.text !== text) {
              currentAnnotations[index] = { ...existing, text }
              annotationsChanged = true
            }
          })

          if (annotationsChanged) {
            updates.annotations = currentAnnotations
            hasChanges = true
          }
        }
      }

      if (!hasChanges) return prev
      return { ...prev, ...updates }
    })
  }, [])

  const handleRestyle = useCallback(
    (updateData: Partial<Data>[], traceIndices: number | number[]) => {
      if (!updateData[0]) return

      const indices = Array.isArray(traceIndices) ? traceIndices : [traceIndices]
      setChartData((prev) => {
        const next = [...prev]
        let hasChanges = false

        indices.forEach((idx, i) => {
          const updateEntry = (updateData[i] ?? updateData[0]) as Record<string, unknown> | undefined
          if (!updateEntry || !next[idx]) return

          const newName = updateEntry.name
          const colorbarTitleText =
            updateEntry['colorbar.title.text'] ??
            updateEntry['colorbar.title'] ??
            (typeof updateEntry.colorbar === 'object'
              ? (updateEntry.colorbar as { title?: { text?: string } }).title?.text
              : undefined)

          const trace = next[idx] as Data & {
            name?: string
            colorbar?: { title?: { text?: string } | string }
          }
          let updatedTrace = trace

          if (typeof newName === 'string' && trace.name !== newName) {
            updatedTrace = { ...updatedTrace, name: newName }
          }

          if (typeof colorbarTitleText === 'string') {
            const existingColorbar = (updatedTrace.colorbar ?? {}) as {
              title?: { text?: string } | string
            }
            const existingTitle =
              typeof existingColorbar.title === 'object'
                ? existingColorbar.title
                : { text: existingColorbar.title }
            if (existingTitle?.text !== colorbarTitleText) {
              updatedTrace = {
                ...updatedTrace,
                colorbar: {
                  ...existingColorbar,
                  title: { ...(existingTitle ?? {}), text: colorbarTitleText },
                },
              }
            }
          }

          if (updatedTrace !== trace) {
            next[idx] = updatedTrace
            hasChanges = true
          }
        })

        return hasChanges ? next : prev
      })
    },
    []
  )

  return (
    <div className={className} style={{ width, height }}>
      <PlotlyLazy
        data={chartData}
        layout={finalLayout}
        config={finalConfig}
        style={{ width: '100%', height: '100%' }}
        onClick={onClick}
        onHover={onHover}
        useResizeHandler={responsive}
        onRelayout={handleRelayout}
        onRestyle={handleRestyle as any}
      />
    </div>
  )
}

export default PlotlyChart
