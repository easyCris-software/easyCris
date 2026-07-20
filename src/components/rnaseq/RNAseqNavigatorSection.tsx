/**
 * RNAseqNavigatorSection Component
 *
 * Navigator section for RNA-seq projects, separate from Statistics families.
 * Shows:
 * - RNA-seq header with "New Project" button
 * - List of RNA-seq projects with counts/metadata status
 * - Expandable views per project (Counts, Metadata, Results, Plots)
 *
 * Uses rnaseq-store for state management (isolated from Statistics module).
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Plus,
  X,
  Table2,
  FileSpreadsheet,
  FileText,
  LineChart,
} from 'lucide-react'
import { Dna } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  useRNAseqStore,
  useRNAseqProjects,
} from '@/store/rnaseq-store'
import { useDataStore } from '@/store/data-store'
import { useShallow } from 'zustand/react/shallow'
import type { RNAseqProject, RNAseqTab } from '@/types/rnaseq'
import { confirm } from '@tauri-apps/plugin-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { toast } from 'sonner'

type DatasetStatus = 'none' | 'missing' | 'scaffold' | 'data'

interface RNAseqNavigatorSectionProps {
  className?: string
  onProjectSelect?: (projectId: string) => void
  onTabSelect?: (projectId: string, tab: RNAseqTab) => void
  interactionLocked?: boolean
}

export function RNAseqNavigatorSection({
  className,
  onProjectSelect,
  onTabSelect,
  interactionLocked = false,
}: RNAseqNavigatorSectionProps) {
  const projects = useRNAseqProjects()
  // Narrow subscription: only re-render when activeProjectId changes, not on every store action.
  // Actions are read from getState() inside handlers — they are stable and don't need a subscription.
  const activeProjectId = useRNAseqStore((s) => s.activeProjectId)

  // B1 fix: build a Set once per project-ID change (O(m)) so selector loop is O(n) not O(n*m).
  // useMemo key is the sorted string of IDs — stable across unrelated store updates.
  const linkedIds = projects.flatMap((p) =>
    [p.countsDatasetId, p.metadataDatasetId].filter(Boolean) as string[]
  )
  const linkedIdsSet = useMemo(
    () => new Set(linkedIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linkedIds.join('\0')]
  )

  // Narrow subscription: derive a status record keyed by dataset ID for only the IDs
  // referenced by the current projects. useShallow ensures Zustand only rerenders when
  // effective status values actually change — unrelated dataset mutations are ignored.
  const datasetStatusRecord = useDataStore(
    useShallow((s) => {
      const record: Record<string, 'scaffold' | 'data'> = {}
      for (const ds of s.datasets) {
        if (!linkedIdsSet.has(ds.id)) continue
        const usable = ds.dataRowCount ?? ds.rowCount ?? 0
        record[ds.id] = usable > 0 ? 'data' : 'scaffold'
      }
      return record
    })
  )

  /** Returns explicit status for a dataset slot used to drive dots and delete safety. */
  const getDatasetStatus = (datasetId: string | null | undefined): DatasetStatus => {
    if (!datasetId) return 'none'
    return datasetStatusRecord[datasetId] ?? 'missing'
  }
  // Track which projects are expanded in the tree
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(projects.map((project) => project.id))
  )

  // Track if the RNA-seq section itself is expanded
  const [sectionExpanded, setSectionExpanded] = useState(true)

  useEffect(() => {
    if (projects.length === 0) return
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      for (const project of projects) {
        next.add(project.id)
      }
      return next
    })
  }, [projects])

  const blockIfLocked = useCallback((action: string): boolean => {
    if (!interactionLocked) return false
    toast.warning(`${action} is unavailable while analysis is running.`)
    return true
  }, [interactionLocked])

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  const handleProjectClick = (projectId: string) => {
    if (blockIfLocked('Switching RNA-seq project')) return
    useRNAseqStore.getState().setActiveProject(projectId)
    setExpandedProjects((prev) => new Set(prev).add(projectId))
    onProjectSelect?.(projectId)
  }

  const handleTabClick = (projectId: string, tab: RNAseqTab) => {
    if (blockIfLocked('Switching RNA-seq tab')) return
    const { setActiveProject, setActiveTab } = useRNAseqStore.getState()
    setActiveProject(projectId)
    setActiveTab(projectId, tab)
    onTabSelect?.(projectId, tab)
  }

  const handleCreateProject = async () => {
    if (blockIfLocked('Creating RNA-seq project')) return
    try {
      const project = await useRNAseqStore.getState().createProjectWithBootstrap(`RNA-seq ${projects.length + 1}`)
      setExpandedProjects((prev) => new Set(prev).add(project.id))
    } catch (err) {
      console.error('[RNAseq] Failed to create project with bootstrap:', err)
      toast.error('Failed to create RNA-seq project')
    }
  }

  const handleDeleteProject = async (projectId: string) => {
    if (blockIfLocked('Deleting RNA-seq project')) return
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    // Read dataset status at delete time via getState() — avoids wide render subscription
    // and ensures we see the most current snapshot, not a stale render value.
    const { datasets: currentDatasets } = useDataStore.getState()
    const resolveStatus = (datasetId: string | null | undefined): DatasetStatus => {
      if (!datasetId) return 'none'
      const ds = currentDatasets.find((d) => d.id === datasetId)
      if (!ds) return 'missing'
      const usable = ds.dataRowCount ?? ds.rowCount ?? 0
      return usable > 0 ? 'data' : 'scaffold'
    }

    // Strict-safe: 'missing' (ID exists, record absent) treated same as 'data' — cannot
    // silently skip confirm when we don't know the dataset's actual content.
    const countsStatus = resolveStatus(project.countsDatasetId)
    const metaStatus = resolveStatus(project.metadataDatasetId)
    const hasUserData =
      countsStatus === 'data' || countsStatus === 'missing' ||
      metaStatus === 'data' || metaStatus === 'missing'
    const hasResults = project.results.length > 0
    const hasConfiguredModels = project.models.length > 0

    if (hasUserData || hasResults || hasConfiguredModels) {
      const parts: string[] = []
      if (hasUserData) parts.push('data')
      if (hasResults) parts.push(`results (${project.results.length} runs)`)
      if (hasConfiguredModels) parts.push(`configured models (${project.models.length})`)

      const ok = await confirm(
        `This RNA-seq project "${project.name}" contains ${parts.join(' and ')}.\n\n` +
          `Deleting it will remove all associated data. Continue?`,
        {
          title: 'Delete RNA-seq Project',
          kind: 'warning',
        }
      )
      if (!ok) return
    }

    // Delegate all cleanup to the store — it handles reference checks, store + cache delete
    await useRNAseqStore.getState().deleteProject(projectId)
  }

  return (
    <div className={cn('space-y-1', className)}>
      {/* Section Header */}
      <div className="flex items-center gap-1">
        <button
          className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setSectionExpanded(!sectionExpanded)}
        >
          {sectionExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <Dna className="h-3.5 w-3.5" weight="bold" />
          <span>RNA-seq</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 ml-auto"
          onClick={handleCreateProject}
          title="New RNA-seq Project"
          disabled={interactionLocked}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Projects List */}
      {sectionExpanded && (
        <div className="ml-2 space-y-0.5">
          {projects.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground italic">
              No projects yet
            </div>
          ) : (
            projects.map((project) => (
              <RNAseqProjectNode
                key={project.id}
                project={project}
                isActive={project.id === activeProjectId}
                isExpanded={expandedProjects.has(project.id)}
                countsStatus={getDatasetStatus(project.countsDatasetId)}
                metadataStatus={getDatasetStatus(project.metadataDatasetId)}
                onProjectClick={handleProjectClick}
                onToggleExpand={toggleProjectExpanded}
                onTabClick={handleTabClick}
                onDelete={handleDeleteProject}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

interface RNAseqProjectNodeProps {
  project: RNAseqProject
  isActive: boolean
  isExpanded: boolean
  countsStatus: DatasetStatus
  metadataStatus: DatasetStatus
  onProjectClick: (projectId: string) => void
  onToggleExpand: (projectId: string) => void
  onTabClick: (projectId: string, tab: RNAseqTab) => void
  onDelete: (projectId: string) => Promise<void>
}

function RNAseqProjectNode({
  project,
  isActive,
  isExpanded,
  countsStatus,
  metadataStatus,
  onProjectClick,
  onToggleExpand,
  onTabClick,
  onDelete,
}: RNAseqProjectNodeProps) {
  const activeTab = project.activeTab

  // Dots reflect real imported data only — scaffold and missing do not show a green dot
  const hasCounts = countsStatus === 'data'
  const hasMetadata = metadataStatus === 'data'
  const hasResults = project.results.length > 0
  const hasPlots = project.activePlotType !== null // Simplified; could track plot count

  // Sample count estimate (would come from linked dataset)
  const sampleCountText = hasCounts ? '' : '' // Would need data-store integration for actual count

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  return (
    <div>
      {/* Project Node */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              'w-full flex items-center gap-1 px-2 py-1.5 text-sm rounded-sm transition-colors group',
              isActive && activeTab === null
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50 text-foreground'
            )}
            onClick={() => onProjectClick(project.id)}
          >
            {/* Expand/Collapse Icon */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand(project.id)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                onToggleExpand(project.id)
              }}
              className="shrink-0"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </span>

            {/* Project Icon */}
            <Dna className="h-4 w-4 text-[#8B5CF6] shrink-0" weight="bold" />

            {/* Project Name */}
            <span className="flex-1 truncate font-medium">{project.name}</span>

            {/* Sample count badge */}
            {sampleCountText && (
              <span className="text-xs text-muted-foreground">
                {sampleCountText}
              </span>
            )}

            {/* Data Indicator */}
            {(hasCounts || hasMetadata) && (
              <div data-testid="project-data-dot" className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}

            {/* Delete Button (on hover) */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                void onDelete(project.id)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                void onDelete(project.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onProjectClick(project.id)}>
            Select Project
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => void onDelete(project.id)}
            className="text-destructive"
          >
            Delete Project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Child Views (Counts/Metadata/Results/Plots) */}
      {isExpanded && (
        <div className="ml-4 space-y-0.5 mt-0.5">
          {/* Counts View */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && activeTab === 'counts'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground'
            )}
            onClick={() => onTabClick(project.id, 'counts')}
            onContextMenu={handleContextMenu}
          >
            <Table2 className="h-4 w-4 text-[#2E86AB] shrink-0" />
            <span className="flex-1 text-left">Counts</span>
            {hasCounts && (
              <div data-testid="counts-data-dot" className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}
          </button>

          {/* Metadata View */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && activeTab === 'metadata'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground'
            )}
            onClick={() => onTabClick(project.id, 'metadata')}
            onContextMenu={handleContextMenu}
          >
            <FileSpreadsheet className="h-4 w-4 text-[#F59E0B] shrink-0" />
            <span className="flex-1 text-left">Metadata</span>
            {hasMetadata && (
              <div data-testid="metadata-data-dot" className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
            )}
          </button>

          {/* Results View */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && activeTab === 'results'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground',
              !hasResults && 'opacity-50'
            )}
            onClick={() => onTabClick(project.id, 'results')}
            disabled={!hasResults}
            onContextMenu={handleContextMenu}
          >
            <FileText className="h-4 w-4 text-[#8B5CF6] shrink-0" />
            <span className="flex-1 text-left">Results</span>
            {hasResults && (
              <span className="text-xs text-muted-foreground">
                {project.results.length}
              </span>
            )}
          </button>

          {/* Plots View */}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm transition-colors',
              isActive && activeTab === 'plots'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent/50 text-foreground',
              !hasResults && 'opacity-50'
            )}
            onClick={() => onTabClick(project.id, 'plots')}
            disabled={!hasResults}
            onContextMenu={handleContextMenu}
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

export default RNAseqNavigatorSection
