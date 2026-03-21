/**
 * PlotlyLazy Component
 *
 * Lazily loads react-plotly.js to avoid startup crashes and heavy bundles.
 * Renders a small fallback while loading and a safe message on error.
 *
 * Supports inline text editing via config.editable and event handlers.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PlotComponentProps } from 'react-plotly.js'
import type { Layout, Data } from 'plotly.js'

// Plotly event handler types (not fully typed in react-plotly.js)
type PlotRelayoutEvent = Partial<Layout> & Record<string, unknown>

export interface PlotlyLazyProps extends PlotComponentProps {
  fallback?: ReactNode
  errorFallback?: ReactNode
  /** Called when layout is changed (e.g., title edited, zoom, pan) */
  onRelayout?: (event: PlotRelayoutEvent) => void
  /** Called when trace data is restyled (e.g., legend text edited) */
  onRestyle?: (data: Partial<Data>[], traceIndices: number | number[]) => void
  /** Called after plot is first initialized */
  onInitialized?: (figure: { data: Data[]; layout: Partial<Layout> }, graphDiv: HTMLElement) => void
}

export function PlotlyLazy({
  fallback,
  errorFallback,
  ...props
}: PlotlyLazyProps) {
  const [PlotComponent, setPlotComponent] = useState<React.ComponentType<PlotComponentProps> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    import('react-plotly.js')
      .then((mod) => {
        if (cancelled) return
        setPlotComponent(() => mod.default)
      })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setLoadError(message)
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
        {errorFallback ?? 'Chart unavailable'}
      </div>
    )
  }

  if (!PlotComponent) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
        {fallback ?? 'Loading chart...'}
      </div>
    )
  }

  return <PlotComponent {...props} />
}

export default PlotlyLazy
