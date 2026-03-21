/**
 * Unified Plot Renderer
 *
 * Renders plots from both Plotly and Observable Plot engines.
 * Supports hybrid rendering during Plotly → Observable migration.
 *
 * Architecture:
 * - Plotly: Used for scattergl (WebGL) and pie charts (no polar in Observable)
 * - Observable Plot: Used for all other plot types (18 of 20)
 *
 * The renderer detects the plot type via discriminated union and renders accordingly.
 */

import React, { useEffect, useRef } from 'react'
import PlotlyLazy from '@/components/plotly/PlotlyLazy'

type PlotlySpec = {
  renderer: 'plotly'
  data: any
  layout: any
  config?: any
}

type ObservableSpec = {
  renderer: 'observable'
  spec: Record<string, unknown>
}

type PlotSpecification = PlotlySpec | ObservableSpec

export interface UnifiedPlotRendererProps {
  /** Plot specification (Plotly or Observable Plot) */
  plotSpec: PlotSpecification

  /** Optional container class name */
  className?: string

  /** Optional ref for parent container access */
  containerRef?: React.RefObject<HTMLDivElement>

  /** Callback when plot is rendered (for export/caching) */
  onRender?: (element: SVGElement | HTMLElement) => void
}

/**
 * Unified Plot Renderer
 *
 * Renders both Plotly and Observable Plot with consistent API.
 *
 * @example
 * ```tsx
 * // Observable Plot
 * <UnifiedPlotRenderer
 *   plotSpec={{
 *     renderer: 'observable',
 *     spec: {
 *       marks: [Plot.barY(data, {x: 'category', y: 'value'})],
 *       x: { label: 'Category' },
 *       y: { label: 'Value', domain: [0, 100], nice: false }
 *     }
 *   }}
 * />
 *
 * // Plotly (scattergl, pie)
 * <UnifiedPlotRenderer
 *   plotSpec={{
 *     renderer: 'plotly',
 *     data: [{type: 'scattergl', ...}],
 *     layout: {...},
 *     config: {...}
 *   }}
 * />
 * ```
 */
export const UnifiedPlotRenderer: React.FC<UnifiedPlotRendererProps> = ({
  plotSpec,
  className = '',
  containerRef: externalRef,
  onRender,
}) => {
  const internalRef = useRef<HTMLDivElement>(null)
  const containerRef = externalRef || internalRef
  const plotElementRef = useRef<SVGElement | HTMLElement | null>(null)

  // Render based on plot type
  if (plotSpec.renderer === 'plotly') {
    // Plotly rendering (scattergl, pie)
    return (
      <div ref={containerRef} className={className}>
        <PlotlyLazy
          data={plotSpec.data}
          layout={plotSpec.layout}
          config={plotSpec.config}
        />
      </div>
    )
  } else {
    // Observable Plot rendering (18 plot types)
    useEffect(() => {
      if (!containerRef.current) return

      let isMounted = true

      const renderObservablePlot = async () => {
        try {
          // @ts-expect-error Optional dependency (Observable Plot may not be installed)
          const Plot = await import('@observablehq/plot')
          if (!isMounted || !containerRef.current) return

          const plotElement = Plot.plot(plotSpec.spec)

          // Clear container and append new plot
          containerRef.current.innerHTML = ''
          containerRef.current.appendChild(plotElement)

          // Store reference for export
          plotElementRef.current = plotElement

          // Notify parent
          if (onRender) {
            onRender(plotElement)
          }
        } catch (error) {
          console.warn('Observable Plot is not available:', error)
        }
      }

      void renderObservablePlot()

      // Cleanup on unmount
      return () => {
        isMounted = false
        if (plotElementRef.current) {
          plotElementRef.current.remove()
        }
      }
    }, [plotSpec, containerRef, onRender])

    return <div ref={containerRef} className={className} />
  }
}

export default UnifiedPlotRenderer
