/**
 * Toolbar Component
 *
 * Ribbon-style toolbar with File/View/Data/Analysis/Visualization tabs.
 * Provides quick access to major application functions.
 *
 * Matches Avalonia's ribbon architecture but adapted for modern web UI.
 * Phase 3B Step 3 implementation.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  FolderPlus,
  Folder,
  Save,
  SaveAll,
  PanelLeftClose,
  PanelLeft,
  FolderDown,
  Play,
  LineChart,
  Axis3d,
  Table2,
  Filter,
  RotateCcw,
  TableProperties,
  HardDrive,
  Trash2,
  Settings,
} from 'lucide-react'
import { Palette, SortAscendingIcon } from '@phosphor-icons/react'
import { TablePivotIcon, TablePivotReverseIcon } from '@/components/icons/TablePivotIcon'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store/app-store'
import { usePlotsStore } from '@/store/plots-store'
import { useResultsStore } from '@/store/results-store'
import type { CacheHealthSummary } from '@/services/cacheService'
import { executeCommand, useCommandContext } from '@/lib/commands'

interface ToolbarProps {
  className?: string
  hasData?: boolean
  viewAttentionPulseToken?: number
  onNewProject?: () => void
  onOpenProject?: () => void
  onSaveProject?: () => void
  onSaveProjectAs?: () => void
  onClearCurrentProjectCache?: () => void
  onClearUnsavedAppCache?: () => void
  onClearAllCache?: () => void
  cacheHealthSummary?: CacheHealthSummary | null
  onImportData?: () => void
  onSort?: () => void
  onPivotWider?: () => void
  onPivotLonger?: () => void
  onGroupAggregate?: () => void
  onAdvancedFilter?: () => void
  onUndoTransform?: () => void
  canUndoTransform?: boolean
  onRunAnalysis?: () => void
}

export function Toolbar({
  className,
  hasData: hasDataProp,
  viewAttentionPulseToken,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onClearCurrentProjectCache,
  onClearUnsavedAppCache,
  onClearAllCache,
  cacheHealthSummary,
  onImportData,
  onSort,
  onPivotWider,
  onPivotLonger,
  onGroupAggregate,
  onAdvancedFilter,
  onUndoTransform,
  canUndoTransform = false,
  onRunAnalysis,
}: ToolbarProps) {
  const commandContext = useCommandContext()
  const {
    showNavigator,
    toggleNavigator,
    setWorkspaceViewMode,
    setPlotSidebarTab,
    setShowPlotSidebar,
    workspaceViewMode,
    families,
    activeFamilyId,
    plotSidebarTab,
    showPlotSidebar,
  } = useAppStore()
  const activeFamily = useMemo(
    () => families.find((family) => family.id === activeFamilyId),
    [families, activeFamilyId]
  )
  const familyResultCount = useResultsStore((state) =>
    activeFamilyId ? state.getFamilyResultCount(activeFamilyId) : 0
  )
  const plotCountForActiveFamily = usePlotsStore((state) =>
    activeFamilyId
      ? state.plots.filter((plot) => (plot.statisticsFamilyId ?? 'statistics-1') === activeFamilyId).length
      : 0
  )
  const hasData = hasDataProp ?? activeFamily?.hasData ?? false
  const hasResults = (activeFamily?.hasResults ?? false) || familyResultCount > 0
  const hasPlots = plotCountForActiveFamily > 0
  const shouldShowViewAttentionDot = !showNavigator && (hasData || hasResults || hasPlots)
  const [viewAttentionPulse, setViewAttentionPulse] = useState(false)
  const formatCacheBytes = (bytes: number): string => {
    if (bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
  }
  const cacheSummaryLabel = cacheHealthSummary
    ? `AppData: ${formatCacheBytes(cacheHealthSummary.appCacheBytes ?? 0)} · Project: ${formatCacheBytes(cacheHealthSummary.projectDataBytes ?? 0)}`
    : null

  useEffect(() => {
    if (!shouldShowViewAttentionDot) {
      setViewAttentionPulse(false)
      return
    }
    if (!viewAttentionPulseToken) return
    setViewAttentionPulse(true)
    const timeoutId = window.setTimeout(() => setViewAttentionPulse(false), 1800)
    return () => window.clearTimeout(timeoutId)
  }, [shouldShowViewAttentionDot, viewAttentionPulseToken])

  const viewToggleTooltip = shouldShowViewAttentionDot
    ? 'Show Navigator (Data/Results/Plots available)'
    : 'Toggle navigator panel'
  const groupWidths = {
    file: 'w-[156px]',
    view: 'w-[36px]',
    data: 'w-[76px]',
    analysis: 'w-[36px]',
    visualization: 'w-[156px]',
  }

  return (
    <div
      className={cn('flex flex-col bg-background border-b border-border', className)}
    >
      {/* All Icons Exposed - Grouped Ribbon Style (like z4.png) */}
      <TooltipProvider>
        <div className="flex flex-col">
          {/* Labels Row - Non-clickable headers aligned with icon groups */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            {/* File Dropdown */}
            <div className={cn('flex items-center justify-center', groupWidths.file)}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground font-medium hover:text-foreground transition-colors cursor-pointer"
                  >
                    File
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => onNewProject?.()}>
                    <FolderPlus className="mr-2 h-4 w-4" />
                    New Project
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onOpenProject?.()}>
                    <Folder className="mr-2 h-4 w-4" />
                    Open Project
                    <DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onSaveProject?.()}>
                    <Save className="mr-2 h-4 w-4" />
                    Save
                    <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onSaveProjectAs?.()}>
                    <SaveAll className="mr-2 h-4 w-4" />
                    Save As...
                    <DropdownMenuShortcut>Ctrl+Shift+S</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => executeCommand('open-preferences', commandContext)}
                  >
                    <Settings className="mr-2 h-4 w-4" />
                    Preferences...
                    <DropdownMenuShortcut>Ctrl+,</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <HardDrive className="mr-2 h-4 w-4" />
                      Cache
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {cacheSummaryLabel && (
                        <>
                          <DropdownMenuItem disabled className="cursor-default opacity-80">
                            {cacheSummaryLabel}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <DropdownMenuItem onSelect={() => onClearCurrentProjectCache?.()}>
                        Clear Current Project Cache
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onClearUnsavedAppCache?.()}>
                        Clear Unsaved/AppData Cache
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onClearAllCache?.()}>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Clear All Cache
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Separator orientation="vertical" className="h-4" />

            {/* View Label */}
            <div className={cn('flex items-center justify-center', groupWidths.view)}>
              <span className="text-xs text-muted-foreground font-medium">View</span>
            </div>

            <Separator orientation="vertical" className="h-4" />

            {/* Data Dropdown */}
            <div className={cn('flex items-center justify-center', groupWidths.data)}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground font-medium hover:text-foreground transition-colors cursor-pointer"
                  >
                    Data
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => onImportData?.()} disabled={false}>
                    <FolderDown className="mr-2 h-4 w-4" />
                    Import Data...
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onSort?.()} disabled={!hasData}>
                    <SortAscendingIcon className="mr-2 h-4 w-4" weight="regular" />
                    Sort...
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onPivotWider?.()} disabled={!hasData}>
                    <TablePivotIcon className="mr-2" size={16} />
                    Pivot Wider...
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onPivotLonger?.()} disabled={!hasData}>
                    <TablePivotReverseIcon className="mr-2" size={16} />
                    Pivot Longer...
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAdvancedFilter?.()} disabled={!hasData}>
                    <Filter className="mr-2 h-4 w-4" />
                    Advanced Filter...
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onGroupAggregate?.()} disabled={!hasData}>
                    <TableProperties className="mr-2 h-4 w-4" />
                    Group & Aggregate...
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onUndoTransform?.()}
                    disabled={!hasData || !canUndoTransform}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Undo Transform
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Separator orientation="vertical" className="h-4" />

            {/* Analysis Label */}
            <div className={cn('flex items-center justify-center', groupWidths.analysis)}>
              <span className="text-xs text-muted-foreground font-medium">Analysis</span>
            </div>

            <Separator orientation="vertical" className="h-4" />

            {/* Visualization Label */}
            <div className={cn('flex items-center justify-center', groupWidths.visualization)}>
              <span className="text-xs text-muted-foreground font-medium">Visualization</span>
            </div>
          </div>

          {/* Icons Row - Grouped by function */}
          <div className="flex items-center gap-2 px-3 py-2 h-12">
            {/* File Group */}
            <div className={cn('flex items-center justify-center gap-1', groupWidths.file)}>
              <ToolbarIconButton
                icon={<FolderPlus className="h-5 w-5" />}
                tooltip="New project"
                onClick={onNewProject}
              />
              <ToolbarIconButton
                icon={<Folder className="h-5 w-5" />}
                tooltip="Open project (Ctrl+O)"
                onClick={onOpenProject}
              />
              <ToolbarIconButton
                icon={<Save className="h-5 w-5" />}
                tooltip="Save project (Ctrl+S)"
                onClick={onSaveProject}
              />
              <ToolbarIconButton
                icon={<SaveAll className="h-5 w-5" />}
                tooltip="Save project as..."
                onClick={onSaveProjectAs}
              />
            </div>

            <Separator orientation="vertical" className="h-8" />

            {/* View Group */}
            <div className={cn('flex items-center justify-center gap-1', groupWidths.view)}>
              <ToolbarIconButton
                icon={showNavigator ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeft className="h-5 w-5" />}
                tooltip={viewToggleTooltip}
                onClick={toggleNavigator}
                isActive={showNavigator}
                attentionDot={shouldShowViewAttentionDot}
                attentionDotPulse={viewAttentionPulse}
              />
            </div>

            <Separator orientation="vertical" className="h-8" />

            {/* Data Group */}
            <div className={cn('flex items-center justify-center gap-1', groupWidths.data)}>
              <ToolbarIconButton
                icon={<FolderDown className="h-5 w-5" />}
                tooltip="Import data (CSV, TSV, Excel)"
                onClick={onImportData}
              />
              <ToolbarIconButton
                icon={<SortAscendingIcon size={20} weight="regular" />}
                tooltip="Sort data"
                onClick={onSort}
              />
            </div>

            <Separator orientation="vertical" className="h-8" />

            {/* Analysis Group */}
            <div className={cn('flex items-center justify-center gap-1', groupWidths.analysis)}>
              <ToolbarIconButton
                icon={<Play className="h-5 w-5" />}
                tooltip="Perform statistical test"
                onClick={onRunAnalysis}
              />
            </div>

            <Separator orientation="vertical" className="h-8" />

            {/* Visualization Group */}
            <div className={cn('flex items-center justify-center gap-1', groupWidths.visualization)}>
              <ToolbarIconButton
                icon={<LineChart className="h-5 w-5" />}
                tooltip="View plots"
                onClick={() => {
                  setWorkspaceViewMode('plots')
                }}
                isActive={workspaceViewMode === 'plots'}
                disabled={!hasData}
              />
              <ToolbarIconButton
                icon={<Palette className="h-5 w-5" weight="bold" />}
                tooltip="Plot colors"
                onClick={() => {
                  setWorkspaceViewMode('plots')
                  setPlotSidebarTab('colors')
                  setShowPlotSidebar(true)
                }}
                isActive={workspaceViewMode === 'plots' && plotSidebarTab === 'colors' && showPlotSidebar}
                showActive={false}
                disabled={!hasData}
              />
              <ToolbarIconButton
                icon={<Axis3d className="h-5 w-5" />}
                tooltip="Plot axes"
                onClick={() => {
                  setWorkspaceViewMode('plots')
                  setPlotSidebarTab('axes')
                  setShowPlotSidebar(true)
                }}
                isActive={workspaceViewMode === 'plots' && plotSidebarTab === 'axes' && showPlotSidebar}
                showActive={false}
                disabled={!hasData}
              />
              <ToolbarIconButton
                icon={<Table2 className="h-5 w-5" />}
                tooltip="Plot data"
                onClick={() => {
                  setWorkspaceViewMode('plots')
                  setPlotSidebarTab('data')
                  setShowPlotSidebar(true)
                }}
                isActive={workspaceViewMode === 'plots' && plotSidebarTab === 'data' && showPlotSidebar}
                showActive={false}
                disabled={!hasData}
              />
            </div>
          </div>
        </div>
      </TooltipProvider>
    </div>
  )
}

interface ToolbarIconButtonProps {
  icon: React.ReactNode
  tooltip: string
  onClick?: () => void
  isActive?: boolean
  disabled?: boolean
  showActive?: boolean
  attentionDot?: boolean
  attentionDotPulse?: boolean
}

function ToolbarIconButton({
  icon,
  tooltip,
  onClick,
  isActive = false,
  disabled = false,
  showActive = true,
  attentionDot = false,
  attentionDotPulse = false,
}: ToolbarIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'relative h-9 w-9 text-muted-foreground hover:text-foreground',
            showActive && isActive && 'bg-accent text-foreground'
          )}
        >
          {icon}
          {attentionDot && (
            <span
              className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#06A77D]"
              aria-hidden="true"
            />
          )}
          {attentionDotPulse && (
            <span
              className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#06A77D] animate-ping"
              aria-hidden="true"
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export default Toolbar
