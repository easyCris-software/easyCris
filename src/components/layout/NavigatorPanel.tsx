/**
 * NavigatorPanel Component
 *
 * Left navigator showing:
 * - Statistics families (top-level tabs: Statistics, Statistics #2)
 * - Data/Results/Plots views for each family
 * - Recent projects list
 *
 * Mirrors Avalonia's Navigator architecture from MainWindow.axaml.
 *
 * Phase 3B Step 1 implementation.
 */

import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { ChevronRight, ChevronDown, Table2, LineChart, Clock, FolderOpen, Plus, X, FileText, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore, type StatisticsFamily } from '@/store/app-store'
import { useRNAseqStore } from '@/store/rnaseq-store'
import { Button } from '@/components/ui/button'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import { clearViewStateCacheForKey } from '@/lib/grid/viewStateCache'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { RNAseqNavigatorSection } from '@/components/rnaseq'
import { tauriApi } from '@/services/tauriApi'
import { toast } from 'sonner'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'

interface NavigatorPanelProps {
  className?: string
  onOpenRecentProject?: (filePath: string) => Promise<void>
  isRNAseqActive?: boolean
  interactionLocked?: boolean
  pasteInProgress?: boolean
}

export function NavigatorPanel({
  className,
  onOpenRecentProject,
  isRNAseqActive,
  interactionLocked = false,
  pasteInProgress = false,
}: NavigatorPanelProps) {
  const {
    families,
    activeFamilyId,
    recentProjects,
    recentProjectsLoading, // Fix #5: Loading state for recent projects
    workspaceViewMode,
    setActiveFamily,
    createFamily,
    removeFamily,
    setWorkspaceViewMode,
    removeRecentProject,
  } = useAppStore()
  const projectId = useAppStore(state => state.projectId)
  const { setActiveProject } = useRNAseqStore()

  // Track which recent project is currently loading
  const [loadingRecentPath, setLoadingRecentPath] = useState<string | null>(null)

  const getFamilyResultCount = useResultsStore(state => state.getFamilyResultCount)
  const plots = usePlotsStore(state => state.plots)

  const familiesById = useMemo(() => {
    const map = new Map<string, StatisticsFamily>()
    families.forEach(family => {
      map.set(family.id, family)
    })
    return map
  }, [families])

  const plotCountByFamily = useMemo(() => {
    const counts = new Map<string, number>()
    for (const plot of plots) {
      const familyId = plot.statisticsFamilyId ?? 'statistics-1'
      counts.set(familyId, (counts.get(familyId) ?? 0) + 1)
    }
    return counts
  }, [plots])

  // Track which families are expanded in the tree
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(
    new Set(['statistics-1']) // Default first family expanded
  )
  useEffect(() => {
    logRuntimeDebug('app', 'navigator_create_family_button_state', {
      activeFamilyId,
      disabled: interactionLocked || pasteInProgress,
      familyCount: families.length,
      interactionLocked,
      pasteInProgress,
    })
  }, [activeFamilyId, families.length, interactionLocked, pasteInProgress])

  const blockIfLocked = useCallback((action: string): boolean => {
    if (pasteInProgress) {
      logRuntimeDebug('app', 'navigator_action_blocked', {
        action,
        reason: 'paste_in_progress',
        activeFamilyId,
        familyCount: families.length,
      })
      toast.warning(`${action} is unavailable while paste is in progress.`)
      return true
    }
    if (!interactionLocked) {
      logRuntimeDebug('app', 'navigator_action_allowed', {
        action,
        activeFamilyId,
        familyCount: families.length,
      })
      return false
    }
    logRuntimeDebug('app', 'navigator_action_blocked', {
      action,
      reason: 'interaction_locked',
      activeFamilyId,
      familyCount: families.length,
    })
    toast.warning(`${action} is unavailable while analysis is running.`)
    return true
  }, [activeFamilyId, families.length, interactionLocked, pasteInProgress])

  const toggleFamilyExpanded = useCallback((familyId: string) => {
    setExpandedFamilies(prev => {
      const next = new Set(prev)
      if (next.has(familyId)) {
        next.delete(familyId)
      } else {
        next.add(familyId)
      }
      return next
    })
  }, [])

  const handleFamilyClick = useCallback(async (familyId: string) => {
    if (blockIfLocked('Switching families')) return
    if (isRNAseqActive) {
      setActiveProject(null)
    }
    await setActiveFamily(familyId)
    setExpandedFamilies(prev => new Set(prev).add(familyId))
  }, [blockIfLocked, isRNAseqActive, setActiveProject, setActiveFamily])

  const handleViewClick = useCallback(
    async (familyId: string, view: 'data' | 'results' | 'plots') => {
    if (blockIfLocked('Switching views')) return
    if (isRNAseqActive) {
      setActiveProject(null)
    }
    await setActiveFamily(familyId)
    setWorkspaceViewMode(view)
    },
    [blockIfLocked, isRNAseqActive, setActiveProject, setActiveFamily, setWorkspaceViewMode]
  )

  const handleCreateFamily = useCallback(async () => {
    logRuntimeDebug('app', 'navigator_create_family_click', {
      activeFamilyId,
      familyCount: families.length,
      interactionLocked,
      pasteInProgress,
    })
    if (blockIfLocked('Creating a family')) return
    if (isRNAseqActive) {
      setActiveProject(null)
    }
    const newFamily = await createFamily()
    logRuntimeDebug('app', 'navigator_create_family_result', {
      activeFamilyId,
      familyCountBefore: families.length,
      newFamilyId: newFamily?.id ?? null,
      newFamilyDatasetId: newFamily?.datasetId ?? null,
      returnedFamily: newFamily ? { id: newFamily.id, name: newFamily.name, datasetId: newFamily.datasetId ?? null } : null,
    })
    if (newFamily?.id) {
      setExpandedFamilies(prev => new Set(prev).add(newFamily.id))
      const prefix = projectId ? `project:${projectId}:` : ''
      clearViewStateCacheForKey(`${prefix}statistics:${newFamily.id}`)
    }
  }, [activeFamilyId, blockIfLocked, createFamily, families.length, interactionLocked, isRNAseqActive, pasteInProgress, projectId, setActiveProject])

  const handleRemoveFamily = useCallback(async (familyId: string, e: SyntheticEvent) => {
    if (blockIfLocked('Removing a family')) return
    e.stopPropagation()
    if (families.length > 1) {
      // Prevent removing last family
      const family = familiesById.get(familyId)
      const resultsCount = getFamilyResultCount(familyId)
      const hasData = Boolean(family?.hasData)
      const hasResults = Boolean(family?.hasResults) || resultsCount > 0

      if (hasData || hasResults) {
        const parts: string[] = []
        if (hasData) parts.push('data')
        if (hasResults) parts.push(`results (${resultsCount})`)
        const message =
          `This Statistics family contains ${parts.join(' and ')}.\n\n` +
          `Closing it will remove its child items. Continue?`

        const ok = await confirm(message, {
          title: 'Close Statistics Family',
          kind: 'warning',
        })

        if (!ok) return
      }

      removeFamily(familyId)
    }
  }, [blockIfLocked, families.length, familiesById, getFamilyResultCount, removeFamily])

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-background border-r border-border',
        className
      )}
    >
      {/* Navigator Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Navigator</h2>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {/* Statistics Families */}
        <div className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-muted-foreground">
          <Table2 className="h-3.5 w-3.5" />
          <span>Statistics</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 ml-auto"
            onClick={handleCreateFamily}
            title="New Statistics Family"
            disabled={interactionLocked || pasteInProgress}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="space-y-1">
          {families.map(family => {
            const plotCount = plotCountByFamily.get(family.id) ?? 0
            return (
              <FamilyTreeNode
                key={family.id}
                family={family}
                isActive={!isRNAseqActive && family.id === activeFamilyId}
                isExpanded={expandedFamilies.has(family.id)}
                currentView={
                  !isRNAseqActive && family.id === activeFamilyId ? workspaceViewMode : null
                }
                hasData={family.hasData}
                hasResults={family.hasResults}
                hasPlots={plotCount > 0}
                canRemove={families.length > 1}
                onFamilyClick={handleFamilyClick}
                onToggleExpand={toggleFamilyExpanded}
                onViewClick={handleViewClick}
                onRemove={handleRemoveFamily}
              />
            )
          })}
        </div>

        {/* RNA-seq Section - Isolated from Statistics module */}
        <div className="mt-4 pt-2 border-t border-border">
          <RNAseqNavigatorSection interactionLocked={interactionLocked} />
        </div>

        {/* Recent Projects Section - Fix #5: Show loading state */}
        {(recentProjects.length > 0 || recentProjectsLoading) && (
          <div className="mt-4">
            <div className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>Recent</span>
              {recentProjectsLoading && (
                <Loader2 className="h-3 w-3 animate-spin ml-auto" />
              )}
            </div>
            <div className="space-y-0.5">
              {recentProjects.map(project => {
                const isLoading = loadingRecentPath === project.path
                const lastOpenedLabel =
                  project.lastOpened instanceof Date
                    ? project.lastOpened.toLocaleString()
                    : new Date(project.lastOpened).toLocaleString()

                const handleClick = async () => {
                  if (blockIfLocked('Opening project')) return
                  if (isLoading || !onOpenRecentProject) return

                  // Pre-click file existence check
                  try {
                    const exists = await tauriApi.checkProjectFileExists(project.path)
                    if (!exists) {
                      const shouldRemove = await confirm(
                        `Project file not found:\n${project.path}\n\nRemove from recent list?`,
                        { title: 'File Not Found', kind: 'warning' }
                      )
                      if (shouldRemove) {
                        try {
                          await tauriApi.removeRecentProject(project.path)
                          removeRecentProject(project.path)
                          toast.info('Removed from recent projects')
                        } catch (error) {
                          const message = error instanceof Error ? error.message : String(error)
                          toast.error(`Failed to remove recent project: ${message}`)
                        }
                      }
                      return
                    }
                  } catch {
                    // If check fails, proceed anyway and let load handle errors
                  }

                  setLoadingRecentPath(project.path)
                  try {
                    await onOpenRecentProject(project.path)
                  } finally {
                    setLoadingRecentPath(null)
                  }
                }

                const handleRemove = async () => {
                  if (blockIfLocked('Removing recent project')) return
                  const shouldRemove = await confirm(
                    `Remove "${project.name}" from recent projects?`,
                    { title: 'Remove Recent Project', kind: 'warning' }
                  )
                  if (shouldRemove) {
                    try {
                      await tauriApi.removeRecentProject(project.path)
                      removeRecentProject(project.path)
                      toast.info('Removed from recent projects')
                    } catch (error) {
                      const message = error instanceof Error ? error.message : String(error)
                      toast.error(`Failed to remove recent project: ${message}`)
                    }
                  }
                }

                return (
                  <ContextMenu key={project.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 text-sm text-foreground hover:bg-accent rounded-sm transition-colors text-left',
                          isLoading && 'opacity-50 cursor-wait'
                        )}
                        title={`Last opened: ${lastOpenedLabel}\n${project.path}`}
                        onClick={handleClick}
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 text-muted-foreground shrink-0 animate-spin" />
                        ) : (
                          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate">{project.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            Last opened: {lastOpenedLabel}
                          </div>
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={handleClick} disabled={isLoading}>
                        Open Project
                      </ContextMenuItem>
                      <ContextMenuItem onClick={handleRemove} className="text-destructive">
                        Remove from Recent
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface FamilyTreeNodeProps {
  family: StatisticsFamily
  isActive: boolean
  isExpanded: boolean
  currentView: 'data' | 'results' | 'plots' | null
  hasData: boolean
  hasResults: boolean
  hasPlots: boolean
  canRemove: boolean
  onFamilyClick: (familyId: string) => void
  onToggleExpand: (familyId: string) => void
  onViewClick: (familyId: string, view: 'data' | 'results' | 'plots') => void
  onRemove: (familyId: string, e: SyntheticEvent) => void | Promise<void>
}

function FamilyTreeNode({
  family,
  isActive,
  isExpanded,
  currentView,
  hasData,
  hasResults,
  hasPlots,
  canRemove,
  onFamilyClick,
  onToggleExpand,
  onViewClick,
  onRemove,
}: FamilyTreeNodeProps) {
  const handleChildContextMenu = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
  }, [])

  return (
    <div>
      {/* Family Node */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            data-testid={`family-node-${family.id}`}
            data-family-id={family.id}
            className={cn(
              'w-full flex items-center gap-1 px-2 py-1.5 text-sm rounded-sm transition-colors group',
              isActive && !currentView
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50 text-foreground'
            )}
            onClick={() => onFamilyClick(family.id)}
          >
            {/* Expand/Collapse Icon */}
            <span
              role="button"
              tabIndex={0}
              onClick={e => {
                e.stopPropagation()
                onToggleExpand(family.id)
              }}
              onKeyDown={e => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                onToggleExpand(family.id)
              }}
              className="shrink-0"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </span>

            {/* Family Name */}
            <span className="flex-1 truncate font-medium">{family.name}</span>

            {/* Data Indicator */}
            {hasData && (
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}

            {/* Remove Button (on hover) */}
            {canRemove && (
              <span
                role="button"
                tabIndex={0}
                onClick={e => void onRemove(family.id, e)}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  void onRemove(family.id, e as unknown as SyntheticEvent)
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onFamilyClick(family.id)}>
            Select Family
          </ContextMenuItem>
          {canRemove && (
            <ContextMenuItem
              onClick={e => void onRemove(family.id, e)}
              className="text-destructive"
            >
              Remove Family
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Child Views (Data/Results/Plots) - Phase 4 Fix: Added Results */}
      {isExpanded && (
        <div className="ml-4 space-y-0.5 mt-0.5">
          {/* Data View */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && currentView === 'data'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground'
            )}
            onClick={() => onViewClick(family.id, 'data')}
            onContextMenu={handleChildContextMenu}
          >
            <Table2 className="h-4 w-4 text-[#2E86AB] shrink-0" />
            <span className="flex-1 text-left">Data</span>
            {hasData && (
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}
          </button>

          {/* Results View - Phase 4 Fix */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && currentView === 'results'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground',
              !hasResults && 'opacity-50'
            )}
            onClick={() => onViewClick(family.id, 'results')}
            disabled={!hasResults}
            onContextMenu={handleChildContextMenu}
          >
            <FileText className="h-4 w-4 text-[#8B5CF6] shrink-0" />
            <span className="flex-1 text-left">Results</span>
            {hasResults && (
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}
          </button>

          {/* Plots View - Available when data is loaded (user-derived plots don't require test results) */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && currentView === 'plots'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground',
              !hasData && 'opacity-50'
            )}
            onClick={() => onViewClick(family.id, 'plots')}
            disabled={!hasData}
            onContextMenu={handleChildContextMenu}
          >
            <LineChart className="h-4 w-4 text-[#C73E1D] shrink-0" />
            <span className="flex-1 text-left">Plots</span>
            {hasPlots && (
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}
          </button>
        </div>
      )}
    </div>
  )
}

export default NavigatorPanel
