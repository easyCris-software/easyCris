/**
 * PlotThumbnail Component - Phase 1 Plots Feature
 *
 * Displays a small preview of a plot in the gallery.
 * Uses static Plotly rendering for performance.
 */

import { useMemo } from 'react'
import PlotlyLazy from '@/components/plotly/PlotlyLazy'
import type { Layout, Config, Data } from 'plotly.js'
import { cn } from '@/lib/utils'
import type { PlotSpec } from '@/store/plots-store'
import { getPlotTemplate } from '@/config/plotRegistry'
import { applyAutoBarOutlines } from '@/utils/plotDisplayDefaults'
import { getPlotIcon } from '@/config/plotIconMap'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { resolvePlotDisplayTitle } from './plotTitle'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export interface PlotThumbnailProps {
  /** Plot specification */
  plot: PlotSpec

  /** Whether this thumbnail is selected */
  isActive: boolean

  /** Click handler */
  onClick: () => void

  /** Delete handler */
  onDelete?: () => void

  /** Thumbnail size (default: 120px) */
  size?: number

  /** Responsive density mode from gallery width */
  density?: 'wide' | 'compact' | 'narrow'

  /** CSS class name */
  className?: string
}

/**
 * PlotThumbnail - Small preview card for plot gallery
 */
export function PlotThumbnail({
  plot,
  isActive,
  onClick,
  onDelete,
  size: _size = 120,
  density = 'wide',
  className,
}: PlotThumbnailProps) {
  const template = getPlotTemplate(plot.type)
  const thumbnailSize = Math.max(80, _size)

  // Get icon component
  const IconComponent = useMemo(() => {
    return getPlotIcon(template?.icon)
  }, [template?.icon])

  // Thumbnail layout - minimal, static
  const thumbnailLayout = useMemo<Partial<Layout>>(() => {
    const baseLayout = plot.plotlyLayout as Partial<Layout>
    const baseFont = (baseLayout.font ?? {}) as Partial<Layout['font']>
    const baseAnnotations = Array.isArray(baseLayout.annotations)
      ? baseLayout.annotations
      : []
    const filteredAnnotations = baseAnnotations.filter((annotation) => {
      if (typeof annotation !== 'object' || annotation === null) return true
      const name = (annotation as { name?: string }).name
      return !['trendline_stats', '_title_', '_xaxis_title_', '_yaxis_title_'].includes(
        name ?? ''
      )
    })

    return {
      ...baseLayout,
      width: thumbnailSize,
      height: thumbnailSize,
      autosize: false,
      font: {
        ...baseFont,
        size: Math.max(8, Math.round((baseFont.size ?? 12) * 0.75)),
      },
      margin: { l: 5, r: 5, t: 5, b: 5 },
      showlegend: false,
      title: undefined, // Hide title in thumbnail
      annotations: filteredAnnotations.length > 0 ? filteredAnnotations : undefined,
      xaxis: {
        ...(plot.plotlyLayout as { xaxis?: object })?.xaxis,
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        domain: [0, 1],
        title: undefined,
      },
      yaxis: {
        ...(plot.plotlyLayout as { yaxis?: object })?.yaxis,
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        domain: [0, 1],
        title: undefined,
      },
    }
  }, [plot.plotlyLayout, thumbnailSize])

  const thumbnailData = useMemo<Data[]>(() => {
    const baseData = Array.isArray(plot.plotlyData) ? (plot.plotlyData as Data[]) : []
    return applyAutoBarOutlines(baseData).data
  }, [plot.plotlyData])

  // Static config for performance
  const thumbnailConfig = useMemo<Partial<Config>>(() => ({
    responsive: true,
    displayModeBar: false,
    staticPlot: true, // No interactions in thumbnail
  }), [])

  const displayTitle = resolvePlotDisplayTitle(plot)
  const subtitleText =
    plot.sourceType === 'test_result' && plot.testType
      ? plot.testType.replace(/_/g, ' ')
      : ''
  const showSubtitle = Boolean(subtitleText)
  const multiLineTitle = density !== 'wide'
  const stackedMetadata = density !== 'wide'

  return (
    <div
      className={cn(
        'group relative rounded-lg border transition-all cursor-pointer',
        'hover:border-primary/50 hover:shadow-sm w-full',
        isActive
          ? 'border-primary ring-2 ring-primary/20 bg-primary/5'
          : 'border-border bg-card',
        className
      )}
      data-plot-type={plot.type}
      data-plot-title={plot.title || ''}
      data-plot-source={plot.sourceType}
      data-plot-density={density}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      aria-pressed={isActive}
      aria-label={`Select plot: ${displayTitle || plot.title}`}
    >
      {/* Plot Preview */}
      <div
        className="overflow-hidden rounded-t-lg bg-muted/20 w-full aspect-square"
      >
        {plot.plotlyData && plot.plotlyData.length > 0 ? (
          <PlotlyLazy
        data={thumbnailData}
            layout={thumbnailLayout}
            config={thumbnailConfig}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler
          />
        ) : (
          // Fallback icon if no data
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <IconComponent className="h-10 w-10 opacity-50" />
          </div>
        )}
      </div>

      {/* Title Bar */}
      <div
        className={cn(
          'border-t border-border/50',
          density === 'narrow' ? 'px-2 py-2' : 'px-2 py-1.5'
        )}
      >
        <div className="flex items-center gap-1.5">
          <IconComponent className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span
            className={cn(
              'text-xs font-medium flex-1 min-w-0',
              multiLineTitle
                ? 'overflow-hidden [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] leading-4'
                : 'truncate'
            )}
            title={displayTitle || plot.title}
          >
            {displayTitle || plot.title || template?.displayName || 'Untitled'}
          </span>
        </div>

        {/* Source badge */}
        <div
          className={cn(
            'mt-0.5',
            stackedMetadata ? 'flex flex-col items-start gap-0.5' : 'flex items-center gap-1'
          )}
        >
          <span
            className={cn(
              'text-[10px] px-1 rounded',
              plot.sourceType === 'test_result'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
            )}
          >
            {plot.sourceType === 'test_result' ? 'Test' : 'User'}
          </span>
          {showSubtitle ? (
            <span
              className={cn(
                'text-[10px] text-muted-foreground min-w-0 max-w-full',
                stackedMetadata
                  ? 'overflow-hidden [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] leading-4'
                  : 'truncate'
              )}
            >
              {subtitleText}
            </span>
          ) : null}
        </div>
      </div>

      {/* Delete Button (visible on hover) */}
      {onDelete && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'absolute top-1 right-1 h-6 w-6',
                'opacity-0 group-hover:opacity-100 transition-opacity',
                'bg-destructive/10 hover:bg-destructive/20 text-destructive'
              )}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Delete plot</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

export default PlotThumbnail
