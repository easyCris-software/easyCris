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

import { useState, useCallback, useEffect } from 'react'
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
import { useAppStore } from '@/store/app-store'
import type { RNAseqProject, RNAseqTab } from '@/types/rnaseq'
import { confirm } from '@tauri-apps/plugin-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import cacheService from '@/services/cacheService'
import { toast } from 'sonner'

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
  const {
    activeProjectId,
    createProject,
    deleteProject,
    setActiveProject,
    setActiveTab,
  } = useRNAseqStore()
  const { removeDataset } = useDataStore()
  const families = useAppStore((state) => state.families)

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
    setActiveProject(projectId)
    setExpandedProjects((prev) => new Set(prev).add(projectId))
    onProjectSelect?.(projectId)
  }

  const handleTabClick = (projectId: string, tab: RNAseqTab) => {
    if (blockIfLocked('Switching RNA-seq tab')) return
    setActiveProject(projectId)
    setActiveTab(projectId, tab)
    onTabSelect?.(projectId, tab)
  }

  const handleCreateProject = () => {
    if (blockIfLocked('Creating RNA-seq project')) return
    const project = createProject(`RNA-seq ${projects.length + 1}`)
    setExpandedProjects((prev) => new Set(prev).add(project.id))
  }

  const handleDeleteProject = async (projectId: string) => {
    if (blockIfLocked('Deleting RNA-seq project')) return
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    const hasData = project.countsDatasetId || project.metadataDatasetId
    const hasResults = project.results.length > 0

    if (hasData || hasResults) {
      const parts: string[] = []
      if (hasData) parts.push('data')
      if (hasResults) parts.push(`results (${project.results.length} runs)`)

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

    const datasetIds = [project.countsDatasetId, project.metadataDatasetId].filter(
      (id): id is string => Boolean(id)
    )
    const otherProjects = projects.filter((p) => p.id !== projectId)

    const isDatasetShared = (datasetId: string) => {
      const usedByStats = families.some((family) => family.datasetId === datasetId)
      const usedByRNAseq = otherProjects.some(
        (p) => p.countsDatasetId === datasetId || p.metadataDatasetId === datasetId
      )
      return usedByStats || usedByRNAseq
    }

    for (const datasetId of datasetIds) {
      if (isDatasetShared(datasetId)) continue
      removeDataset(datasetId)
      cacheService.removeDataset(datasetId).catch((error) => {
        console.error(`Failed to remove RNA-seq dataset ${datasetId} from cache`, error)
      })
    }

    deleteProject(projectId)
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
  onProjectClick: (projectId: string) => void
  onToggleExpand: (projectId: string) => void
  onTabClick: (projectId: string, tab: RNAseqTab) => void
  onDelete: (projectId: string) => Promise<void>
}

function RNAseqProjectNode({
  project,
  isActive,
  isExpanded,
  onProjectClick,
  onToggleExpand,
  onTabClick,
  onDelete,
}: RNAseqProjectNodeProps) {
  const activeTab = project.activeTab

  // Compute status indicators
  const hasCounts = Boolean(project.countsDatasetId)
  const hasMetadata = Boolean(project.metadataDatasetId)
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
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
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
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
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
              <div className="h-1.5 w-1.5 rounded-full bg-[#06A77D] shrink-0" />
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
