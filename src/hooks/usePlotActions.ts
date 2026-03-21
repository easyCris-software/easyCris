/**
 * usePlotActions Hook - Shared plot action handlers
 *
 * Extracted from ActivePlotView.tsx to be reused by PlotCanvas.tsx
 * Provides: refresh, fullscreen, export (PNG/SVG/HTML/JSON)
 */

import { useRef, useCallback, useEffect } from 'react'
import type { PlotSpec } from '@/store/plots-store'
import type { Layout } from 'plotly.js'
import tauriApi from '@/services/tauriApi'
import { exportPlotWithKaleido } from '@/services/plotExportService'
import { writeFile } from '@tauri-apps/plugin-fs'
import { applyAxisDefaultsForExport } from '@/utils/plotExportUtils'
import { toast } from 'sonner'

// ============================================================================
// Helper Functions (non-hook, pure utilities)
// ============================================================================

async function loadPlotly(): Promise<any> {
  const PlotlyModule = await import('plotly.js/dist/plotly.min.js')
  return (PlotlyModule as { default?: any }).default ?? PlotlyModule
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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

function replaceExtension(filePath: string, extension: string): string {
  const normalizedExtension = extension.startsWith('.') ? extension.slice(1) : extension
  const lastSlashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dirPrefix = lastSlashIndex >= 0 ? filePath.slice(0, lastSlashIndex + 1) : ''
  const baseName = lastSlashIndex >= 0 ? filePath.slice(lastSlashIndex + 1) : filePath
  const dotIndex = baseName.lastIndexOf('.')

  if (dotIndex <= 0) {
    return `${filePath}.${normalizedExtension}`
  }

  return `${dirPrefix}${baseName.slice(0, dotIndex)}.${normalizedExtension}`
}

function summarizeExportError(error?: string): string {
  if (!error) return 'unknown error'
  const trimmed = error.trim()
  if (trimmed.length <= 140) return trimmed
  return `${trimmed.slice(0, 140)}...`
}

/**
 * Sanitize filename by removing/replacing invalid characters
 * Invalid on Windows: / \ : * ? " < > |
 * Invalid on macOS/Linux: / and null
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_') // Replace invalid chars with underscore
    .replace(/\s+/g, '_') // Replace spaces with underscore
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim leading/trailing underscores
    .slice(0, 200) // Limit length
    || 'plot' // Fallback if empty
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

function getDateStamp(date: Date = new Date()): string {
  return [
    date.getFullYear().toString(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('')
}

function buildDefaultExportFilename(plot: PlotSpec, format: ExportFormat): string {
  const testName = sanitizeFilename(plot.title || 'plot')
  const plotType = sanitizeFilename(String(plot.type || 'plot'))
  const dateStamp = getDateStamp()
  return `${testName}_${plotType}_${dateStamp}.${format}`
}

function buildHtmlExport(
  plot: PlotSpec,
  options?: { includeAxisOverlay?: boolean }
): string {
  const safeTitle = escapeHtml(plot.title || 'Plot')
  const data = escapeInlineScriptJson(JSON.stringify(plot.plotlyData))
  const normalizedLayout = applyAxisDefaultsForExport(
    (plot.plotlyLayout as Partial<Layout>) ?? {},
    options
  )
  const layout = escapeInlineScriptJson(JSON.stringify(normalizedLayout))
  // Use Plotly CDN matching the bundled Plotly.js version
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

type KaleidoStage = 'Preparing' | 'Exporting' | 'Finalizing' | 'Fallback'

function createKaleidoProgressToast(format: 'pdf' | 'tiff') {
  const formatLabel = format.toUpperCase()
  let progress = 8
  let stage: KaleidoStage = 'Preparing'
  let timer: number | null = null
  const id = `kaleido-export-${format}-${Date.now()}-${Math.random().toString(16).slice(2)}`

  const render = () => {
    const suffix = stage === 'Exporting' ? ` ${Math.round(progress)}%` : ''
    toast.loading(`${formatLabel} export: ${stage}${suffix}`, {
      id,
      duration: Infinity,
    })
  }

  const stopTimer = () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  const startExporting = () => {
    stage = 'Exporting'
    progress = Math.max(progress, 18)
    render()
    if (timer !== null) return
    timer = window.setInterval(() => {
      if (progress >= 95) return
      const increment = progress < 55 ? 7 : progress < 80 ? 4 : 2
      progress = Math.min(95, progress + increment)
      render()
    }, 700)
  }

  const setStage = (nextStage: KaleidoStage, nextProgress?: number) => {
    stage = nextStage
    if (typeof nextProgress === 'number' && Number.isFinite(nextProgress)) {
      progress = Math.max(0, Math.min(95, nextProgress))
    }
    render()
  }

  const succeed = (message: string) => {
    stopTimer()
    stage = 'Finalizing'
    progress = 100
    toast.success(message, { id, duration: 2800 })
  }

  const warn = (message: string) => {
    stopTimer()
    stage = 'Fallback'
    progress = 100
    toast.warning(message, { id, duration: 4200 })
  }

  const fail = (message: string) => {
    stopTimer()
    toast.error(message, { id, duration: 4200 })
  }

  render()
  return {
    setStage,
    startExporting,
    succeed,
    warn,
    fail,
  }
}

// Export Types
// ============================================================================

export type ExportFormat =
  | 'png'
  | 'jpg'
  | 'jpeg'
  | 'webp'
  | 'svg'
  | 'pdf'
  | 'tiff'
  | 'json'
  | 'html'

export interface ExportOptions {
  dpi?: 96 | 300 | 600
}

export interface UsePlotActionsReturn {
  /** Ref to attach to plot container div */
  plotContainerRef: React.MutableRefObject<HTMLDivElement | null>

  /** Get the Plotly DOM element from container */
  getPlotElement: () => HTMLElement | null

  /** Refresh/redraw the plot */
  handleRefresh: () => Promise<void>

  /** Toggle fullscreen mode */
  handleFullscreen: () => Promise<void>

  /** Export plot to various formats */
  handleExport: (format: ExportFormat, options?: ExportOptions) => Promise<void>
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function usePlotActions(
  plot: PlotSpec | undefined,
  canvasWidth?: number,
  canvasHeight?: number
): UsePlotActionsReturn {
  const plotContainerRef = useRef<HTMLDivElement | null>(null)
  const fullscreenResizeTimerRef = useRef<number | null>(null)

  const getPlotElement = useCallback((): HTMLElement | null => {
    return (
      plotContainerRef.current?.querySelector('.js-plotly-plot') ??
      plotContainerRef.current?.querySelector('.plotly')
    ) as HTMLElement | null
  }, [])

  const resizePlot = useCallback(async () => {
    const plotElement = getPlotElement()
    if (!plotElement) return
    const Plotly = await loadPlotly()
    if (Plotly?.Plots?.resize) {
      await Plotly.Plots.resize(plotElement)
    }
  }, [getPlotElement])

  // Keep Plotly sized correctly when fullscreen changes, including ESC exits.
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (fullscreenResizeTimerRef.current !== null) {
        window.clearTimeout(fullscreenResizeTimerRef.current)
      }
      fullscreenResizeTimerRef.current = window.setTimeout(() => {
        void resizePlot()
      }, 100)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      if (fullscreenResizeTimerRef.current !== null) {
        window.clearTimeout(fullscreenResizeTimerRef.current)
      }
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [resizePlot])

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
      toast.success('Plot refreshed')
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

  const handleExport = useCallback(
    async (format: ExportFormat, options: ExportOptions = {}) => {
      if (!plot) return

      // Disable export-only axis overlays to prevent duplicate axis lines in raster/vector exports.
      const includeAxisOverlay = false
      const defaultName = buildDefaultExportFilename(plot, format)
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
          const html = buildHtmlExport(plot, { includeAxisOverlay })
          const bytes = new TextEncoder().encode(html)
          await writeFile(savePath, bytes)
          toast.success('Plot HTML exported')
          return
        }

        const isBrowserPrimary =
          format === 'png' || format === 'jpg' || format === 'jpeg' || format === 'webp' || format === 'svg'
        const isKaleidoPrimary = format === 'pdf' || format === 'tiff'

        const plotElement = getPlotElement()
        const liveLayout = (plotElement as { layout?: Partial<Layout> } | null)?.layout
        const normalizedLayout = applyAxisDefaultsForExport(
          liveLayout ?? ((plot.plotlyLayout as Partial<Layout>) ?? {}),
          { includeAxisOverlay }
        )
        if (Array.isArray(normalizedLayout.annotations)) {
          normalizedLayout.annotations = normalizedLayout.annotations.map((annotation) => {
            if (!annotation || typeof annotation !== 'object') return annotation
            const { editable, ...rest } = annotation as Record<string, unknown>
            const entry = rest as { name?: string; x?: number; xanchor?: string; xref?: string }
            if (entry.name !== '_title_') return rest
            const x =
              typeof entry.x === 'number' && Number.isFinite(entry.x)
                ? Math.min(1, Math.max(0, entry.x))
                : 0.5
            const xanchor = entry.xanchor && entry.xanchor !== 'auto' ? entry.xanchor : 'center'
            return {
              ...rest,
              x,
              xanchor,
              xref: entry.xref ?? 'paper',
            }
          })
        }
        const layout = normalizedLayout as { width?: number; height?: number }
        const width = canvasWidth ?? (typeof layout.width === 'number' ? layout.width : 1000)
        const height = canvasHeight ?? (typeof layout.height === 'number' ? layout.height : 700)

        const exportObject = JSON.parse(
          JSON.stringify({
            data: plot.plotlyData ?? [],
            layout: normalizedLayout,
          })
        )

        const exportWithPlotlyToImage = async (): Promise<void> => {
          const Plotly = await loadPlotly()
          if (!Plotly?.toImage) {
            throw new Error('Plotly.toImage is unavailable')
          }
          // Plotly browser export accepts "jpeg", not "jpg".
          const browserFormat = format === 'jpg' ? 'jpeg' : format

          for (let attempt = 0; attempt < 2; attempt++) {
            let domError: unknown | null = null
            if (plotElement) {
              try {
                const imageDataUrl = await Plotly.toImage(plotElement, {
                  format: browserFormat,
                  width,
                  height,
                  scale: 2,
                })
                await writeFile(savePath, dataUrlToBytes(imageDataUrl))
                return
              } catch (error) {
                domError = error
              }
            }

            try {
              const imageDataUrl = await Plotly.toImage(exportObject, {
                format: browserFormat,
                width,
                height,
                scale: 2,
              })
              await writeFile(savePath, dataUrlToBytes(imageDataUrl))
              return
            } catch (objectError) {
              if (attempt === 1) {
                throw objectError ?? domError ?? new Error('Plotly.toImage failed')
              }
              if (plotElement && Plotly?.Plots?.resize) {
                await Plotly.Plots.resize(plotElement)
              }
              if (plotElement && Plotly?.Plots?.redraw) {
                await Plotly.Plots.redraw(plotElement)
              }
              await delay(120)
            }
          }
        }

        const exportPngFallback = async (targetPath: string): Promise<void> => {
          const Plotly = await loadPlotly()
          if (!Plotly?.toImage) {
            throw new Error('Plotly.toImage is unavailable')
          }

          if (plotElement) {
            try {
              const domDataUrl = await Plotly.toImage(plotElement, {
                format: 'png',
                width,
                height,
                scale: 2,
              })
              await writeFile(targetPath, dataUrlToBytes(domDataUrl))
              return
            } catch (domError) {
              console.warn('PNG fallback DOM export failed, trying object export:', domError)
            }
          }

          const objectDataUrl = await Plotly.toImage(exportObject, {
            format: 'png',
            width,
            height,
            scale: 2,
          })
          await writeFile(targetPath, dataUrlToBytes(objectDataUrl))
        }

        const runKaleidoExport = async (
          targetFormat: 'png' | 'jpg' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'tiff'
        ): Promise<{ success: boolean; error?: string }> => {
          const result = await exportPlotWithKaleido(
            { ...plot, plotlyLayout: normalizedLayout },
            savePath,
            {
              format: targetFormat,
              width,
              height,
              dpi: options.dpi ?? 300,
              transparent: targetFormat === 'png',
            }
          )
          if (result.success) return { success: true }
          console.error('[Kaleido] primary export attempt failed:', {
            format: targetFormat,
            error: result.error,
            errorType: result.error_type,
            details: result.details,
            suspectPaths: result.suspect_paths,
            debugPayloadPath: result.debug_payload_path,
            replayCommand: result.replay_command,
            backendFingerprint: result.backend_fingerprint,
          })

          await delay(120)
          const retryResult = await exportPlotWithKaleido(
            { ...plot, plotlyLayout: normalizedLayout },
            savePath,
            {
              format: targetFormat,
              width: Math.max(640, Math.round(width * 0.9)),
              height: Math.max(480, Math.round(height * 0.9)),
              dpi: options.dpi ?? 300,
              transparent: targetFormat === 'png',
            }
          )
          if (!retryResult.success) {
            console.error('[Kaleido] retry export attempt failed:', {
              format: targetFormat,
              error: retryResult.error,
              errorType: retryResult.error_type,
              details: retryResult.details,
              suspectPaths: retryResult.suspect_paths,
              debugPayloadPath: retryResult.debug_payload_path,
              replayCommand: retryResult.replay_command,
              backendFingerprint: retryResult.backend_fingerprint,
            })
          }
          const enrichedError =
            retryResult.error ??
            result.error ??
            `${targetFormat.toUpperCase()} export failed in backend`
          return { success: retryResult.success, error: enrichedError }
        }

        if (isBrowserPrimary) {
          try {
            await exportWithPlotlyToImage()
            toast.success('Plot exported')
            return
          } catch (browserError) {
            console.warn('Browser export failed, falling back to Kaleido:', browserError)
            const result = await runKaleidoExport(format)
            if (!result.success) {
              throw new Error(result.error || 'Kaleido export failed')
            }
            toast.success('Plot exported')
            return
          }
        }

        if (isKaleidoPrimary) {
          const progressToast = createKaleidoProgressToast(format)
          progressToast.startExporting()
          const result = await runKaleidoExport(format)
          if (result.success) {
            progressToast.setStage('Finalizing', 98)
            progressToast.succeed('Plot exported')
            return
          }

          // Fallback for real users: still give a usable export artifact
          try {
            progressToast.setStage('Fallback', 95)
            progressToast.startExporting()
            const fallbackPath = replaceExtension(savePath, 'png')
            await exportPngFallback(fallbackPath)
            const reason = summarizeExportError(result.error)
            progressToast.warn(
              `${format.toUpperCase()} export failed (${reason}). Exported PNG fallback instead.`
            )
            return
          } catch (fallbackError) {
            console.warn('PNG fallback export failed:', fallbackError)
            progressToast.fail(`${format.toUpperCase()} export failed`)
            return
          }
        }

        toast.error(`Export format ${format} is not supported`)
      } catch (error) {
        console.error('Export failed:', error)
        const message =
          error instanceof Error && error.message
            ? error.message
            : typeof error === 'string'
              ? error
              : 'Plot export failed'
        toast.error(message)
      }
    },
    [plot, canvasWidth, canvasHeight, getPlotElement]
  )

  return {
    plotContainerRef,
    getPlotElement,
    handleRefresh,
    handleFullscreen,
    handleExport,
  }
}

export default usePlotActions
