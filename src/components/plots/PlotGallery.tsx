/**
 * PlotGallery Component - Phase 1 Plots Feature
 *
 * Left zone of the Plots panel - displays a grid of plot thumbnails.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PlusCircle } from 'lucide-react'
import { FolderSimple } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { usePlotsStore, type PlotSpec } from '@/store/plots-store'
import { useAppStore } from '@/store/app-store'
import { PlotThumbnail } from './PlotThumbnail'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type GalleryDensity = 'wide' | 'compact' | 'narrow'

const getGalleryDensity = (width: number | null): GalleryDensity => {
  if (width === null) return 'compact'
  if (width < 180) return 'narrow'
  if (width < 260) return 'compact'
  return 'wide'
}

export interface PlotGalleryProps {
  /** Callback when "Create Plot" button is clicked */
  onCreatePlot?: () => void

  /** CSS class name */
  className?: string
}

/**
 * PlotGallery - Thumbnail grid
 */
export function PlotGallery({
  onCreatePlot,
  className,
}: PlotGalleryProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [galleryWidth, setGalleryWidth] = useState<number | null>(null)
  // Store state
  const plots = usePlotsStore((state) => state.plots)
  const activePlotId = usePlotsStore((state) => state.activePlotId)
  const activeStatisticsFamilyId = useAppStore((state) => state.activeFamilyId)
  const setActivePlot = usePlotsStore((state) => state.setActivePlot)
  const removePlot = usePlotsStore((state) => state.removePlot)

  const plotsForStatisticsFamily = useMemo(() => {
    const familyId = activeStatisticsFamilyId ?? 'statistics-1'
    return plots.filter(
      (p) => (p.statisticsFamilyId ?? 'statistics-1') === familyId
    )
  }, [plots, activeStatisticsFamilyId])

  const displayedPlots = useMemo(() => {
    return [...plotsForStatisticsFamily].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }, [plotsForStatisticsFamily])

  const handlePlotClick = (plot: PlotSpec) => {
    setActivePlot(plot.id)
  }

  const handleDeletePlot = (plotId: string) => {
    // Could add confirmation dialog here
    removePlot(plotId)
  }

  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element || typeof ResizeObserver === 'undefined') return

    const measure = () => {
      const nextWidth = element.getBoundingClientRect().width
      if (nextWidth > 0) {
        setGalleryWidth((current) => (current === nextWidth ? current : nextWidth))
      }
    }

    measure()

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setGalleryWidth((current) => (current === entry.contentRect.width ? current : entry.contentRect.width))
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const density = getGalleryDensity(galleryWidth)
  const gridColumnsClass = density === 'wide' ? 'grid-cols-2' : 'grid-cols-1'

  return (
    <div className={cn('flex flex-col h-full bg-muted/10', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <h3 className="text-sm font-medium">Plot Gallery</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onCreatePlot}
            >
              <PlusCircle className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Create new plot</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Gallery Grid */}
      <ScrollArea className="flex-1">
        <div ref={contentRef} className="p-3">
          {displayedPlots.length > 0 ? (
            <div className={cn('grid gap-2 min-w-0', gridColumnsClass)}>
              {displayedPlots.map((plot) => (
                <PlotThumbnail
                  key={plot.id}
                  plot={plot}
                  isActive={plot.id === activePlotId}
                  onClick={() => handlePlotClick(plot)}
                  onDelete={() => handleDeletePlot(plot.id)}
                  size={100}
                  density={density}
                  className="min-w-0"
                />
              ))}
            </div>
          ) : (
            // Empty state
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <FolderSimple className="h-10 w-10 opacity-50 mb-2" />
              <p className="text-sm font-medium">No plots found</p>
              <p className="text-xs mt-1">
                {plots.length === 0
                  ? 'Run a statistical test to generate plots'
                  : 'Create a plot to get started'}
              </p>
              {plots.length === 0 && onCreatePlot && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={onCreatePlot}
                >
                  <PlusCircle className="h-4 w-4 mr-1.5" />
                  Create Plot
                </Button>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

    </div>
  )
}

export default PlotGallery
