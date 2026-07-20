/**
 * PlotsPanel Component - Phase 2 Plot View Redesign
 *
 * Three-zone horizontal layout:
 * - Left: PlotGallery (thumbnail grid with filters)
 * - Center: PlotCanvas (constrained plot with scale controls)
 * - Right: PlotSidebar (tabbed settings with integrated Data tab)
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PanelGroup, Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels'
import { cn } from '@/lib/utils'
import { PlotGallery } from './PlotGallery'
import { PlotCanvas } from './PlotCanvas'
import { PlotSidebar } from './PlotSidebar'
import { CreatePlotDialog } from './CreatePlotDialog'
import { usePlotsStore, type PlotSpec } from '@/store/plots-store'
import { useDataStore } from '@/store/data-store'
import { useAppStore } from '@/store/app-store'
import { useViewportMode } from '@/hooks/useViewportMode'

// ============================================================================
// Types
// ============================================================================

export interface PlotsPanelProps {
  /** CSS class name */
  className?: string
}

const LARGE_DATASET_PLOT_THRESHOLD = 1_000_000

// ============================================================================
// Component
// ============================================================================

/**
 * PlotsPanel - Main 3-zone horizontal layout container
 */
export function PlotsPanel({ className }: PlotsPanelProps) {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [plotScale, setPlotScale] = useState(1)
  const { mode, isCompact, isConstrained } = useViewportMode()

  // Store state and actions
  const { plots, addPlot } = usePlotsStore(
    useShallow((state) => ({
      plots: state.plots,
      addPlot: state.addPlot,
    }))
  )
  const currentDataset = useDataStore((state) => state.currentDataset)
  const { activeFamilyId, showPlotSidebar, setShowPlotSidebar, showNavigator, setShowNavigator } = useAppStore(
    useShallow((state) => ({
      activeFamilyId: state.activeFamilyId,
      showPlotSidebar: state.showPlotSidebar,
      setShowPlotSidebar: state.setShowPlotSidebar,
      showNavigator: state.showNavigator,
      setShowNavigator: state.setShowNavigator,
    }))
  )

  // Ref for imperative panel control (smooth collapse/expand)
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null)

  // Sync panel collapse state with store
  useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return

    if (showPlotSidebar) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [showPlotSidebar])

  // Sync store when panel is manually collapsed/expanded
  const handleSidebarCollapse = useCallback(() => {
    setShowPlotSidebar(false)
  }, [setShowPlotSidebar])

  const handleSidebarExpand = useCallback(() => {
    setShowPlotSidebar(true)
  }, [setShowPlotSidebar])

  const prevModeRef = useRef(mode)
  useEffect(() => {
    const previousMode = prevModeRef.current
    if (previousMode !== mode && mode !== 'full' && showPlotSidebar) {
      setShowPlotSidebar(false)
    }
    prevModeRef.current = mode
  }, [mode, setShowPlotSidebar, showPlotSidebar])

  const navigatorStateBeforeAutoCollapseRef = useRef<boolean | null>(null)
  const navigatorAutoCollapsedRef = useRef(false)
  useEffect(() => {
    if (!showPlotSidebar) {
      if (
        navigatorAutoCollapsedRef.current &&
        navigatorStateBeforeAutoCollapseRef.current !== null
      ) {
        const shouldRestoreNavigator = navigatorStateBeforeAutoCollapseRef.current
        navigatorStateBeforeAutoCollapseRef.current = null
        navigatorAutoCollapsedRef.current = false
        setShowNavigator(shouldRestoreNavigator)
        return
      }

      navigatorStateBeforeAutoCollapseRef.current = null
      navigatorAutoCollapsedRef.current = false
      return
    }

    if (mode === 'full') {
      return
    }

    if (navigatorStateBeforeAutoCollapseRef.current === null) {
      navigatorStateBeforeAutoCollapseRef.current = showNavigator
    }

    if (!showNavigator) {
      return
    }

    if (navigatorAutoCollapsedRef.current) {
      navigatorAutoCollapsedRef.current = false
      navigatorStateBeforeAutoCollapseRef.current = null
      return
    }

    navigatorAutoCollapsedRef.current = true
    setShowNavigator(false)
  }, [mode, showPlotSidebar, showNavigator, setShowNavigator])

  const panelAutoSaveId = useMemo(() => {
    if (isConstrained) return 'plots-panel-constrained-v1'
    if (isCompact) return 'plots-panel-compact-v1'
    return 'plots-panel-full-v2'
  }, [isCompact, isConstrained])

  const leftPanelDefaultSize = isConstrained ? 14 : isCompact ? 15 : 18
  const leftPanelMinSize = isConstrained ? 9 : isCompact ? 10 : 12
  const rightPanelDefaultSize = isConstrained ? 22 : isCompact ? 23 : 24
  const rightPanelMinSize = isConstrained ? 16 : isCompact ? 18 : 20

  const plotCount = useMemo(() => {
    const familyId = activeFamilyId ?? 'statistics-1'
    return plots.filter((plot) => (plot.statisticsFamilyId ?? 'statistics-1') === familyId)
      .length
  }, [plots, activeFamilyId])
  const isLargeDataset = useMemo(() => {
    const rows = currentDataset?.dataRowCount ?? currentDataset?.rowCount ?? 0
    return rows >= LARGE_DATASET_PLOT_THRESHOLD
  }, [currentDataset?.dataRowCount, currentDataset?.rowCount])

  // Handle "Create Plot" button click
  const handleCreatePlot = useCallback(() => {
    setIsCreateDialogOpen(true)
  }, [])

  // Handle plot creation from dialog
  const handlePlotCreated = useCallback(
    (plotSpec: PlotSpec) => {
      addPlot(plotSpec)
    },
    [addPlot]
  )

  return (
    <div
      data-testid="plots-panel"
      className={cn(
        'flex flex-col h-full w-full bg-[#fafbfc] dark:bg-zinc-950',
        className
      )}
    >
      {/* Main content area with resizable panels */}
      <div className="flex-1 overflow-hidden">
        {isLargeDataset && (
          <div className="mx-3 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Plots disabled for large datasets. Run statistics only, or sample/export data for plotting.
          </div>
        )}
        <PanelGroup direction="horizontal" autoSaveId={panelAutoSaveId}>
          {/* Left Zone: Gallery */}
          <Panel
            defaultSize={leftPanelDefaultSize}
            minSize={leftPanelMinSize}
            maxSize={28}
            className="min-w-0 border-r border-zinc-200 dark:border-zinc-800"
          >
            <PlotGallery onCreatePlot={handleCreatePlot} />
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle className="w-1 bg-zinc-100 dark:bg-zinc-900 hover:bg-cyan-500/30 transition-colors" />

          {/* Center Zone: Plot Canvas */}
          <Panel defaultSize={58} minSize={40} className="min-w-0">
            <PlotCanvas scale={plotScale} onScaleChange={setPlotScale} />
          </Panel>

          {/* Resize Handle - hidden when sidebar collapsed */}
          <PanelResizeHandle
            className={cn(
              'w-1 bg-zinc-100 dark:bg-zinc-900 hover:bg-cyan-500/30 transition-all duration-200',
              !showPlotSidebar && 'opacity-0'
            )}
          />

          {/* Right Zone: Settings Sidebar (collapsible with animation) */}
          <Panel
            ref={sidebarPanelRef}
            defaultSize={rightPanelDefaultSize}
            minSize={rightPanelMinSize}
            maxSize={35}
            collapsible
            collapsedSize={0}
            onCollapse={handleSidebarCollapse}
            onExpand={handleSidebarExpand}
            className={cn(
              'min-w-0 border-l border-zinc-200 dark:border-zinc-800 transition-all duration-200 ease-out',
              !showPlotSidebar && 'border-l-0'
            )}
          >
            <PlotSidebar />
          </Panel>
        </PanelGroup>
      </div>

      {/* Status Bar */}
      <StatusBar plotCount={plotCount} scale={plotScale} />

      {/* Create Plot Dialog */}
      <CreatePlotDialog
        open={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onCreatePlot={handlePlotCreated}
      />
    </div>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * StatusBar - Bottom status information
 */
function StatusBar({ plotCount, scale }: { plotCount: number; scale: number }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-500">
      <span className="font-mono">
        {plotCount} {plotCount === 1 ? 'plot' : 'plots'}
      </span>
      <span className="font-mono">Scale: {Math.round(scale * 100)}%</span>
    </div>
  )
}

export default PlotsPanel
