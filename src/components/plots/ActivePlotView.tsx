/**
 * ActivePlotView Component - Phase 1 Plots Feature
 *
 * Center zone of the Plots panel - displays the active plot.
 * Includes hidden stats node for E2E validation.
 */

import { useMemo, useRef, useCallback, useState, useEffect } from 'react'
import type { MutableRefObject } from 'react'
import PlotlyLazy from '@/components/plotly/PlotlyLazy'
import type { Layout, Config, Data } from 'plotly.js'
import { Download, Maximize2, RefreshCw, Image, FileCode } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePlotsStore, type PlotSpec } from '@/store/plots-store'
import { getPlotTemplate } from '@/config/plotRegistry'
import { extractTrendlineStats, stripTrendlineStats } from '@/utils/plotStats'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import tauriApi from '@/services/tauriApi'
import { writeFile } from '@tauri-apps/plugin-fs'
import { toast } from 'sonner'
import {
  exportPlotWithKaleido,
  getCachedKaleidoCapabilities,
  getKaleidoCapabilities,
} from '@/services/plotExportService'
import { resolvePlotDisplayTitle } from './plotTitle'

export interface ActivePlotViewProps {
  /** Optional specific plot to display (overrides store) */
  plot?: PlotSpec

  /** CSS class name */
  className?: string

  /** Height (default: 100%) */
  height?: string | number
}

type PlotlyImageTarget = HTMLElement

const toDataAttributeKey = (key: string): string | null => {
  const normalized = key
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized ? `data-${normalized}` : null
}

/**
 * PlotWithStats - Wrapper that adds hidden stats node for E2E
 */
function PlotWithStats({
  spec,
  computedStats,
  layout,
  config,
  containerRef,
}: {
  spec: PlotSpec
  computedStats: Record<string, number | string>
  layout: Partial<Layout>
  config: Partial<Config>
  containerRef: MutableRefObject<HTMLDivElement | null>
}) {
  return (
    <div
      className="plot-container relative w-full h-full"
      data-testid="plot-container"
      ref={containerRef}
    >
      {/* Plotly chart */}
      <PlotlyLazy
        data={spec.plotlyData as Data[]}
        layout={layout}
        config={config}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />

      {/* Hidden stats node for E2E validation */}
      <div
        data-plot-stats
        data-plot-type={spec.type}
        data-plot-id={spec.id}
        data-source-type={spec.sourceType}
        data-test-type={spec.testType ?? ''}
        data-data-policy={spec.dataPolicy}
        style={{ display: 'none' }}
        {...Object.fromEntries(
          Object.entries(computedStats)
            .map(([key, value]) => {
              const attrKey = toDataAttributeKey(key)
              return attrKey ? [attrKey, value.toString()] : null
            })
            .filter((entry): entry is [string, string] => Boolean(entry))
        )}
      />
    </div>
  )
}

/**
 * ActivePlotView - Main plot display area
 */
export function ActivePlotView({
  plot: propPlot,
  className,
  height = '100%',
}: ActivePlotViewProps) {
  // Get plot from store if not provided as prop
  // NOTE: Inline selector to avoid infinite loop in React 19 (don't call getActivePlot())
  const activePlotId = usePlotsStore((state) => state.activePlotId)
  const plots = usePlotsStore((state) => state.plots)
  const allComputedStats = usePlotsStore((state) => state.computedStats)

  const storePlot = useMemo(
    () => (activePlotId ? plots.find((p) => p.id === activePlotId) : undefined),
    [activePlotId, plots]
  )

  const plot = propPlot ?? storePlot
  const displayTitle = useMemo(() => resolvePlotDisplayTitle(plot), [plot])
  const computedStats = useMemo(() => {
    const baseStats = activePlotId ? allComputedStats[activePlotId] ?? {} : {}
    const trimmed = stripTrendlineStats(baseStats)
    const trendlineStats = extractTrendlineStats(plot?.plotlyData as Data[] | undefined)
    return { ...trimmed, ...trendlineStats }
  }, [activePlotId, allComputedStats, plot?.plotlyData])
  const template = plot ? getPlotTemplate(plot.type) : undefined
  const plotContainerRef = useRef<HTMLDivElement | null>(null)

  const [tiffExportUnavailableReason, setTiffExportUnavailableReason] = useState<string | null>(
    () => {
      const cached = getCachedKaleidoCapabilities()
      if (!cached || cached.tiff.supported) return null
      return cached.tiff.reason ?? 'TIFF export unavailable'
    }
  )

  const refreshKaleidoCapabilities = useCallback(() => {
    void getKaleidoCapabilities(true, true)
      .then((freshCapabilities) => {
        setTiffExportUnavailableReason(
          freshCapabilities.tiff.supported
            ? null
            : freshCapabilities.tiff.reason ?? 'TIFF export unavailable'
        )
      })
      .catch(() => {
        // Keep previous state.
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    void getKaleidoCapabilities()
      .then((capabilities) => {
        if (cancelled) return
        setTiffExportUnavailableReason(
          capabilities.tiff.supported ? null : capabilities.tiff.reason ?? 'TIFF export unavailable'
        )
      })
      .catch(() => {
        // Leave menu enabled if probe cannot run yet.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Merge layout with defaults
  const finalLayout = useMemo<Partial<Layout>>(() => {
    if (!plot) return {}

    const baseLayout = plot.plotlyLayout as Partial<Layout>
    return {
      ...baseLayout,
      autosize: true,
      margin: {
        l: 60,
        r: 40,
        t: displayTitle || plot.title ? 60 : 40,
        b: 50,
        ...(baseLayout.margin ?? {}),
      },
      title: {
        text: displayTitle || plot.title,
        font: { size: 16 },
        ...(typeof baseLayout.title === 'object' ? baseLayout.title : {}),
      },
    }
  }, [displayTitle, plot])

  // Merge config with defaults
  const finalConfig = useMemo<Partial<Config>>(() => {
    if (!plot) return {}

    return {
      responsive: true,
      displayModeBar: false,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      toImageButtonOptions: {
        format: 'png',
        filename: `${displayTitle || plot.title || 'plot'}-${plot.id}`,
        height: 600,
        width: 800,
        scale: 2,
      },
      ...plot.plotlyConfig,
    }
  }, [displayTitle, plot])

  const getPlotElement = useCallback(() => {
    return (
      plotContainerRef.current?.querySelector('.js-plotly-plot') ??
      plotContainerRef.current?.querySelector('.plotly')
    ) as PlotlyImageTarget | null
  }, [])

  const handleRefresh = useCallback(async () => {
    const plotElement = getPlotElement()
    if (!plotElement) {
      toast.error('Plot is not ready yet')
      return
    }

    try {
      const Plotly = await loadPlotly()
      if (Plotly?.Plots?.resize) {
        await Plotly.Plots.resize(plotElement)
      }
      if (Plotly?.Plots?.redraw) {
        await Plotly.Plots.redraw(plotElement)
      }
    } catch (error) {
      console.error('Plot refresh failed:', error)
      toast.error('Plot refresh failed')
    }
  }, [getPlotElement])

  const handleFullscreen = useCallback(async () => {
    const container = plotContainerRef.current
    if (!container) return

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }
      await container.requestFullscreen()
    } catch (error) {
      console.error('Fullscreen failed:', error)
      toast.error('Fullscreen not available')
    }
  }, [])

  // Export handlers
  const handleExport = async (format: 'png' | 'svg' | 'json' | 'html' | 'tiff') => {
    if (!plot) return
    if (format === 'tiff' && tiffExportUnavailableReason) {
      toast.error(`TIFF export unavailable: ${tiffExportUnavailableReason}`)
      return
    }

    const defaultName = `${displayTitle || plot.title || 'plot'}.${format}`
    const savePath = await tauriApi.saveFileDialog(defaultName, [
      { name: format.toUpperCase(), extensions: [format] },
    ])
    if (!savePath) return

    try {
      if (format === 'json') {
        const json = JSON.stringify(plot, null, 2)
        const bytes = new TextEncoder().encode(json)
        await writeFile(savePath, bytes)
        toast.success('Plot JSON exported')
        return
      }

      if (format === 'html') {
        const html = buildHtmlExport(plot)
        const bytes = new TextEncoder().encode(html)
        await writeFile(savePath, bytes)
        toast.success('Plot HTML exported')
        return
      }

      if (format === 'tiff') {
        const result = await exportPlotWithKaleido(plot, savePath, {
          format: 'tiff',
          width: 1000,
          height: 700,
          scale: 2,
        })
        if (!result.success) {
          toast.error(result.error ?? 'Plot export failed')
          return
        }
        toast.success('Plot exported')
        return
      }

      const plotElement = getPlotElement()
      if (!plotElement) {
        toast.error('Plot is not ready for export')
        return
      }

      const Plotly = await loadPlotly()
      if (!Plotly?.toImage) {
        toast.error('Plot export is not available')
        return
      }

      const imageDataUrl = await Plotly.toImage(plotElement, {
        format,
        width: 1000,
        height: 700,
        scale: 2,
      })
      const bytes = dataUrlToBytes(imageDataUrl)
      await writeFile(savePath, bytes)
      toast.success('Plot exported')
    } catch (error) {
      console.error('Export failed:', error)
      toast.error('Plot export failed')
    }
  }

  // Empty state
  if (!plot) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center h-full text-muted-foreground',
          className
        )}
        style={{ height }}
      >
        <Image className="h-16 w-16 opacity-30 mb-4" />
        <p className="text-lg font-medium">No Plot Selected</p>
        <p className="text-sm mt-1">
          Select a plot from the gallery or create a new one
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn('flex flex-col h-full', className)}
      style={{ height }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-card/50">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium truncate max-w-[300px]">
            {displayTitle || plot.title || template?.displayName || 'Untitled Plot'}
          </h3>
          <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
            {template?.displayName || plot.type}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Refresh */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleRefresh}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Refresh plot</p>
            </TooltipContent>
          </Tooltip>

          {/* Fullscreen */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleFullscreen}
              >
                <Maximize2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Fullscreen</p>
            </TooltipContent>
          </Tooltip>

          {/* Export Dropdown */}
          <DropdownMenu
            onOpenChange={(open) => {
              if (open && tiffExportUnavailableReason) {
                refreshKaleidoCapabilities()
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Export plot">
                <Download className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport('png')}>
                <Image className="h-4 w-4 mr-2" />
                Export as PNG
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleExport('tiff')}
                disabled={Boolean(tiffExportUnavailableReason)}
                title={tiffExportUnavailableReason ?? undefined}
              >
                <Image className="h-4 w-4 mr-2" />
                Export as TIFF{tiffExportUnavailableReason ? ' (Unavailable)' : ''}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('svg')}>
                <FileCode className="h-4 w-4 mr-2" />
                Export as SVG
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('html')}>
                <FileCode className="h-4 w-4 mr-2" />
                Export as HTML
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('json')}>
                <FileCode className="h-4 w-4 mr-2" />
                Export as JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Plot Area */}
      <div className="flex-1 p-4 overflow-hidden">
        <PlotWithStats
          spec={plot}
          computedStats={computedStats}
          layout={finalLayout}
          config={finalConfig}
          containerRef={plotContainerRef}
        />
      </div>

      {/* Footer - Metadata */}
      <div className="px-4 py-1.5 border-t text-xs text-muted-foreground flex items-center gap-4">
        <span>
          Source:{' '}
          {plot.sourceType === 'test_result' ? (
            <span className="text-blue-600 dark:text-blue-400">
              {plot.testType?.replace(/_/g, ' ')}
            </span>
          ) : (
            <span className="text-green-600 dark:text-green-400">
              User derived
            </span>
          )}
        </span>
        <span>Policy: {plot.dataPolicy}</span>
        <span>
          Created: {new Date(plot.createdAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  )
}

export default ActivePlotView

async function loadPlotly(): Promise<any> {
  const PlotlyModule = await import('plotly.js/dist/plotly.min.js')
  return (PlotlyModule as { default?: any }).default ?? PlotlyModule
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const [meta, data] = dataUrl.split(',', 2)
  if (meta?.includes(';base64')) {
    const binary = atob(data ?? '')
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  const text = decodeURIComponent(data ?? '')
  return new TextEncoder().encode(text)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeInlineScriptJson(json: string): string {
  return json
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function buildHtmlExport(plot: PlotSpec): string {
  const data = escapeInlineScriptJson(JSON.stringify(plot.plotlyData))
  const layout = escapeInlineScriptJson(JSON.stringify(plot.plotlyLayout))
  const displayTitle = resolvePlotDisplayTitle(plot)
  const safeTitle = escapeHtml(displayTitle || plot.title || 'Plot')
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
    <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  </head>
  <body>
    <div id="plot" style="width:100%;height:100%;"></div>
    <script>
      const data = ${data};
      const layout = ${layout};
      Plotly.newPlot('plot', data, layout);
    </script>
  </body>
</html>`
}

