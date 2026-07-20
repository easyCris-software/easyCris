/**
 * ActionToolbar Component
 *
 * Quick action bar with frequently used operations:
 * - Import Data (CSV/TSV/Excel)
 * - Run Analysis (opens TestSelectionDialog)
 * - Clear Dataset
 * - Copy/Paste/Undo/Redo shortcuts
 *
 * Positioned below the Toolbar ribbon, above the workspace.
 * Phase 3B Step 4 implementation.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { debounce } from 'lodash'
import { FolderDown, Play, Trash2, Copy, ClipboardPaste, Undo2, Redo2, Download, ArrowUpDown, Settings2, Type, Palette, Axis3d, Scissors, Bug, Lightbulb, BookOpen, BookText, FileText, Wrench, RefreshCw, Plus, Star, ExternalLink, Mail, Filter as FilterIcon } from 'lucide-react'
import { WarningCircle } from '@phosphor-icons/react'
import { invoke } from '@tauri-apps/api/core'
import { save, confirm } from '@tauri-apps/plugin-dialog'
import { BaseDirectory, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { openUrl } from '@tauri-apps/plugin-opener'
import { resolveResource } from '@tauri-apps/api/path'
import { toast } from 'sonner'
import { buildFeedbackItems } from '@/lib/feedback/feedbackItems'
import type { Layout } from 'plotly.js'
import { cn } from '@/lib/utils'
import { hasUsableRows } from '@/lib/datasetRows'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { useDataStore } from '@/store/data-store'
import { useAnalysisStore } from '@/store/analysis-store'
import { useAppStore, type WorkspaceViewMode } from '@/store/app-store'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import {
  readUpdaterStatusSnapshot,
  runUpdaterFlow,
  type UpdaterPhase,
  type UpdaterProgressEvent,
  type UpdaterStatusSnapshot,
} from '@/lib/updater'
import { useViewportMode } from '@/hooks/useViewportMode'

// Available plot fonts (same as PlotSidebar)
const PLOT_FONTS = [
  // Sans-Serif
  { value: 'Inter', label: 'Inter' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Noto Sans', label: 'Noto Sans' },
  { value: 'PT Sans', label: 'PT Sans' },
  { value: 'Source Sans 3', label: 'Source Sans 3' },
  { value: 'Nunito Sans', label: 'Nunito Sans' },
  { value: 'Liberation Sans', label: 'Liberation Sans' },
  { value: 'Arimo', label: 'Arimo' },
  // Serif (Publications)
  { value: 'Tinos', label: 'Tinos' },
  { value: 'Roboto Slab', label: 'Roboto Slab' },
  // Monospace
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
] as const

const FONT_ALIASES: Record<string, string> = {
  Arial: 'Arimo',
  'Times New Roman': 'Tinos',
  'Source Sans Pro': 'Source Sans 3',
}

const resolveFontFamily = (font?: string) => {
  if (font && PLOT_FONTS.some((candidate) => candidate.value === font)) {
    return font
  }
  if (font && FONT_ALIASES[font]) {
    return FONT_ALIASES[font]
  }
  return 'Inter'
}

// Common font sizes for publications
const FONT_SIZES = [10, 11, 12, 14, 16, 18, 24, 36] as const

const parseColorToRgb = (color: string): { r: number; g: number; b: number } | null => {
  const normalized = color.trim().toLowerCase()
  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1)
    if (hex.length === 3) {
      const c0 = hex[0] ?? '0'
      const c1 = hex[1] ?? '0'
      const c2 = hex[2] ?? '0'
      const r = parseInt(c0 + c0, 16)
      const g = parseInt(c1 + c1, 16)
      const b = parseInt(c2 + c2, 16)
      return { r, g, b }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return { r, g, b }
    }
    return null
  }

  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (rgbMatch && rgbMatch[1]) {
    const parts = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length >= 3) {
      const r = Number(parts[0])
      const g = Number(parts[1])
      const b = Number(parts[2])
      if ([r, g, b].every((value) => Number.isFinite(value))) {
        return { r, g, b }
      }
    }
  }

  return null
}

const formatColorForInput = (color?: string): string => {
  if (!color) return '#000000'
  const trimmed = color.trim()
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    if (hex.length === 6) return `#${hex}`
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    }
    if (hex.length === 8) return `#${hex.slice(0, 6)}`
  }
  const rgb = parseColorToRgb(trimmed)
  if (!rgb) return '#000000'
  const value = ((rgb.r & 0xff) << 16) | ((rgb.g & 0xff) << 8) | (rgb.b & 0xff)
  return `#${value.toString(16).padStart(6, '0')}`
}

type LegalResource = {
  id: 'third-party' | 'privacy' | 'eula'
  label: string
  description: string
  file: string
  Icon: typeof BookOpen
}

const LEGAL_RESOURCES: LegalResource[] = [
  {
    id: 'third-party',
    label: 'Third-Party Licenses',
    description: 'Bundled license notices',
    file: 'legal/THIRD_PARTY_LICENSES.txt',
    Icon: BookOpen,
  },
  {
    id: 'privacy',
    label: 'Privacy Policy',
    description: 'How easyCris handles data',
    file: 'legal/PRIVACY_POLICY.txt',
    Icon: FileText,
  },
  {
    id: 'eula',
    label: 'License Terms',
    description: 'easyCris End User License Agreement (EULA)',
    file: 'legal/EULA.txt',
    Icon: FileText,
  },
]

const LEGAL_PREVIEW_LIMIT = 200_000
const EASYCRIS_RELEASE_NOTES_URL = 'https://github.com/easyCris-software/easyCris/releases/latest'

const UPDATER_ACTIVE_PHASES: UpdaterPhase[] = [
  'checking',
  'update_available',
  'downloading',
  'verifying',
  'installing',
  'closing_for_install',
  'relaunching',
]

const isUpdaterPhaseActive = (phase: UpdaterPhase) => UPDATER_ACTIVE_PHASES.includes(phase)

const formatUpdaterBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return null
  }
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatUpdaterTimestamp = (iso: string | null) => {
  if (!iso) return 'Never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
}

const getUpdaterButtonLabel = (
  progress: UpdaterProgressEvent
) => {
  switch (progress.phase) {
    case 'checking':
      return 'Checking…'
    case 'update_available':
      return 'Update available'
    case 'downloading':
      return progress.progressPercent !== null && progress.progressPercent !== undefined
        ? `Downloading ${progress.progressPercent}%`
        : 'Downloading…'
    case 'verifying':
      return 'Verifying…'
    case 'installing':
      return 'Installing…'
    case 'closing_for_install':
      return 'Closing…'
    case 'relaunching':
      return 'Restarting…'
    case 'failed':
      return 'Retry update'
    default:
      return 'Update easyCris'
  }
}

interface ActionToolbarProps {
  className?: string
  workspaceViewMode?: WorkspaceViewMode
  hasDataRows?: boolean
  onImportData?: () => void
  onBrowseExamples?: () => void
  onOpenCheatsheet?: () => void
  onOpenDataCleaningGuide?: () => void
  onOpenRNAseqGuide?: () => void
  onImportRNAseqSample?: () => void
  onPerformTest?: () => void
  onSort?: () => void
  onFilter?: (bounds: { x: number; y: number; width: number; height: number }) => void
  onClearData?: () => void
  onCopy?: () => void | Promise<void>
  onCut?: () => void | Promise<void>
  onPaste?: () => void | Promise<void>
  onUndo?: () => void | Promise<void>
  onRedo?: () => void | Promise<void>
  onInsertMenu?: (x: number, y: number) => void
}

export function ActionToolbar({
  className,
  workspaceViewMode = 'data',
  hasDataRows: hasDataRowsProp,
  onImportData,
  onBrowseExamples,
  onOpenCheatsheet,
  onOpenDataCleaningGuide,
  onOpenRNAseqGuide,
  onImportRNAseqSample,
  onPerformTest,
  onSort,
  onFilter,
  onClearData,
  onCopy,
  onCut,
  onPaste,
  onUndo,
  onRedo,
  onInsertMenu,
}: ActionToolbarProps) {
  const [showReportDialog, setShowReportDialog] = useState(false)
  const [updaterProgress, setUpdaterProgress] = useState<UpdaterProgressEvent>({
    phase: 'idle',
    message: 'Idle',
    version: null,
    releaseNotes: null,
    downloadedBytes: null,
    totalBytes: null,
    progressPercent: null,
    error: null,
  })
  const [updaterStatusSnapshot, setUpdaterStatusSnapshot] = useState<UpdaterStatusSnapshot>(
    () => readUpdaterStatusSnapshot()
  )
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [legalView, setLegalView] = useState<{ resource: LegalResource; content: string } | null>(null)
  const [legalLoading, setLegalLoading] = useState(false)
  const [legalError, setLegalError] = useState<string | null>(null)
  const [legalPreviewExpanded, setLegalPreviewExpanded] = useState(false)
  const legalLoadId = useRef(0)
  const legalCache = useRef(new Map<string, string>())
  const updateCheckInFlightRef = useRef(false)
  const { currentDataset } = useDataStore()
  const { execution } = useAnalysisStore()
  const {
    setStatusMessage,
    togglePlotSidebar,
    showPlotSidebar,
    setPlotSidebarTab,
    setShowPlotSidebar,
    activeFamilyId,
    plotSettingsAttentionByFamily,
    saveProject,
  } = useAppStore()
  const { isNotFull } = useViewportMode()
  const results = useResultsStore((state) => state.results)
  const plots = usePlotsStore((state) => state.plots)
  const activePlotId = usePlotsStore((state) => state.activePlotId)

  const hasData = !!currentDataset
  const hasDataRows = hasDataRowsProp ?? hasUsableRows(currentDataset)
  const hasResults = results.length > 0
  const isRunning = execution.status === 'running' || execution.status === 'validating'
  const activePlot = plots.find((p) => p.id === activePlotId)
  const updatePlot = usePlotsStore((state) => state.updatePlot)
  const activeFamilyAttention =
    plotSettingsAttentionByFamily[activeFamilyId ?? 'statistics-1']
  const hasUnseenAutoPlotSettings = activeFamilyAttention?.unseenAutoPlot === true
  const hasUnseenUserPlotSettings = activeFamilyAttention?.unseenUserPlot === true
  const shouldShowPlotSettingsAttentionBadge =
    !showPlotSidebar &&
    (hasUnseenAutoPlotSettings || hasUnseenUserPlotSettings)
  const plotSettingsTooltipMessage = shouldShowPlotSettingsAttentionBadge
    ? hasUnseenAutoPlotSettings
      ? 'New auto-generated plot settings available'
      : 'New plot settings available'
    : showPlotSidebar
      ? 'Hide the plot settings panel'
      : 'Show the plot settings panel'

  const legalContent = legalView?.content ?? ''
  const legalIsLarge = legalContent.length > LEGAL_PREVIEW_LIMIT
  const legalShowingPreview = legalIsLarge && !legalPreviewExpanded
  const legalFullView =
    legalContent.length > 0 && !legalShowingPreview && !legalLoading && !legalError
  const legalDisplayedContent = legalShowingPreview
    ? legalContent.slice(0, LEGAL_PREVIEW_LIMIT)
    : legalContent
  const legalPreviewSizeKb = Math.ceil(Math.min(legalContent.length, LEGAL_PREVIEW_LIMIT) / 1024)
  const legalTotalSizeKb = Math.ceil(legalContent.length / 1024)
  const updaterInProgress = isUpdaterPhaseActive(updaterProgress.phase)

  // Get current plot settings
  const plotLayout = (activePlot?.plotlyLayout as Partial<Layout>) ?? {}
  const rawFontFamily = (plotLayout.font as Partial<Layout['font']> | undefined)?.family
  const currentFontSize = (plotLayout.font as Partial<Layout['font']> | undefined)?.size ?? 12
  const currentTitle = activePlot?.title ?? ''
  const layoutFontColor = (plotLayout.font as Partial<Layout['font']> | undefined)?.color
  const normalizedFont = resolveFontFamily(rawFontFamily)

  // Title-specific font settings
  const titleObj = typeof plotLayout.title === 'object' ? plotLayout.title : {}
  const rawTitleFontFamily = (titleObj.font as Partial<Layout['font']> | undefined)?.family
  const currentTitleFontSize = (titleObj.font as Partial<Layout['font']> | undefined)?.size ?? Math.round(currentFontSize * 1.2)
  const currentTitleFontColor = (titleObj.font as Partial<Layout['font']> | undefined)?.color ?? layoutFontColor ?? '#374151'
  const normalizedTitleFont = resolveFontFamily(rawTitleFontFamily ?? rawFontFamily)
  const xAxisObj = (plotLayout.xaxis as any) ?? {}
  const yAxisObj = (plotLayout.yaxis as any) ?? {}
  const currentAxisFontColor =
    xAxisObj?.title?.font?.color ??
    yAxisObj?.title?.font?.color ??
    xAxisObj?.tickfont?.color ??
    yAxisObj?.tickfont?.color ??
    layoutFontColor ??
    '#374151'
  const [axisColorInput, setAxisColorInput] = useState(
    formatColorForInput(currentAxisFontColor)
  )

  useEffect(() => {
    let cancelled = false
    const loadInstalledVersion = async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app')
        const version = await getVersion()
        if (!cancelled) {
          setInstalledVersion(version)
        }
      } catch {
        if (!cancelled) {
          setInstalledVersion(null)
        }
      }
    }

    void loadInstalledVersion()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setAxisColorInput(formatColorForInput(currentAxisFontColor))
  }, [currentAxisFontColor])

  const getResourceCandidates = (resourceName: string) => {
    const normalized = resourceName.replace(/\\/g, '/').replace(/^\/+/, '')
    const fallback = normalized.split('/').pop()
    const candidates = new Set<string>()

    candidates.add(normalized)
    if (!normalized.startsWith('resources/')) {
      candidates.add(`resources/${normalized}`)
    }

    if (fallback) {
      candidates.add(fallback)
      if (!fallback.startsWith('resources/')) {
        candidates.add(`resources/${fallback}`)
      }
    }

    return [...candidates]
  }

  const resolveBundledResource = async (resourceName: string) => {
    const candidates = getResourceCandidates(resourceName)
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        return await resolveResource(candidate)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error(`Unable to resolve resource: ${resourceName}`)
  }

  const readBundledResourceText = async (resourceName: string) => {
    const candidates = getResourceCandidates(resourceName)
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        return await readTextFile(candidate, { baseDir: BaseDirectory.Resource })
      } catch (error) {
        lastError = error
      }
    }
    for (const candidate of candidates) {
      try {
        const resolvedPath = await resolveResource(candidate)
        return await readTextFile(resolvedPath)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error(`Unable to read resource: ${resourceName}`)
  }

  const preloadBundledResourceText = async (resource: LegalResource) => {
    if (legalCache.current.has(resource.file)) {
      return
    }
    try {
      const content = await readBundledResourceText(resource.file)
      legalCache.current.set(resource.file, content)
    } catch (error) {
      console.warn(`[Help] Failed to preload ${resource.file}:`, error)
    }
  }

  const openBundledResource = async (resource: LegalResource) => {
    try {
      await resolveBundledResource(resource.file)
      setStatusMessage('Use in-app preview or save a local copy to open externally.')
    } catch (error) {
      console.warn(`[Help] Failed to open ${resource.file} directly:`, error)
    }

    const fallbackPath = await save({
      defaultPath: resource.file.split('/').pop() ?? resource.label,
    })

    if (!fallbackPath) {
      setStatusMessage('Open file canceled.')
      return
    }

    try {
      const cached = legalCache.current.get(resource.file)
      const content = cached ?? await readBundledResourceText(resource.file)
      legalCache.current.set(resource.file, content)
      await writeTextFile(fallbackPath, content)
      setStatusMessage(`Saved copy to ${fallbackPath}. Open it from your file manager.`)
    } catch (fallbackError) {
      setStatusMessage(`Could not save ${resource.label}.`)
      console.error(`[Help] Failed to save ${resource.file}:`, fallbackError)
    }
  }

  const loadBundledResourceText = async (resource: LegalResource) => {
    const requestId = ++legalLoadId.current
    setLegalError(null)
    setLegalPreviewExpanded(false)
    const cached = legalCache.current.get(resource.file)
    if (cached) {
      setLegalLoading(false)
      setLegalView({ resource, content: cached })
      return
    }
    setLegalLoading(true)
    setLegalView({ resource, content: '' })
    try {
      const content = await readBundledResourceText(resource.file)
      if (legalLoadId.current !== requestId) {
        return
      }
      legalCache.current.set(resource.file, content)
      setLegalView({ resource, content })
    } catch (error) {
      if (legalLoadId.current !== requestId) {
        return
      }
      setLegalError(`Could not load ${resource.label}.`)
      setStatusMessage(`Could not load ${resource.label}.`)
      console.error(`[Help] Failed to load ${resource.file}:`, error)
    } finally {
      if (legalLoadId.current === requestId) {
        setLegalLoading(false)
      }
    }
  }

  useEffect(() => {
    if (showReportDialog) return
    legalLoadId.current += 1
    setLegalView(null)
    setLegalError(null)
    setLegalLoading(false)
    setLegalPreviewExpanded(false)
  }, [showReportDialog])

  useEffect(() => {
    if (!showReportDialog) return
    const resource = LEGAL_RESOURCES.find((entry) => entry.id === 'third-party')
    if (!resource) return
    const timeout = window.setTimeout(() => {
      void preloadBundledResourceText(resource)
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [showReportDialog])

  useEffect(() => {
    if (!showReportDialog) return
    setUpdaterStatusSnapshot(readUpdaterStatusSnapshot())
    const interval = window.setInterval(() => {
      setUpdaterStatusSnapshot(readUpdaterStatusSnapshot())
    }, 1500)
    return () => window.clearInterval(interval)
  }, [showReportDialog])

  const getLatestActivePlot = () => {
    const state = usePlotsStore.getState()
    const plotId = activePlotId ?? state.activePlotId
    if (!plotId) return null
    return state.plots.find((plot) => plot.id === plotId) ?? null
  }

  useEffect(() => {
    if (!activePlot) return
    const hasValidFont =
      typeof rawFontFamily === 'string' &&
      PLOT_FONTS.some((font) => font.value === rawFontFamily)
    const resolvedFont = resolveFontFamily(rawFontFamily)
    if (hasValidFont) return
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentFontObj = (latestLayout.font as Partial<Layout['font']>) ?? {}
    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        font: {
          ...currentFontObj,
          family: resolvedFont,
        },
      },
    })
  }, [activePlot, rawFontFamily, updatePlot])

  // Update plot title
  const handleTitleChange = (title: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentTitleObj = latestLayout.title

    updatePlot(latestPlot.id, {
      title,
      plotlyLayout: {
        ...latestLayout,
        title: {
          ...(typeof currentTitleObj === 'object' ? currentTitleObj : {}),
          text: title,
        },
      },
    })
  }

  // Update title font family
  const handleTitleFontChange = (fontFamily: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentTitleObj = typeof latestLayout.title === 'object' ? latestLayout.title : {}

    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        title: {
          ...currentTitleObj,
          font: {
            ...(currentTitleObj.font ?? {}),
            family: fontFamily,
          },
        },
      },
    })
  }

  // Update title font size
  const handleTitleFontSizeChange = (size: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentTitleObj = typeof latestLayout.title === 'object' ? latestLayout.title : {}
    const currentMeta = (latestLayout.meta as Record<string, unknown> | undefined) ?? {}

    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        title: {
          ...currentTitleObj,
          font: {
            ...(currentTitleObj.font ?? {}),
            size: Number(size),
          },
        },
        meta: {
          ...currentMeta,
          titleFontSizeCustom: true,
        },
      },
    })
  }

  const handleTitleFontColorChange = (color: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentTitleObj = typeof latestLayout.title === 'object' ? latestLayout.title : {}
    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        title: {
          ...currentTitleObj,
          font: {
            ...(currentTitleObj.font ?? {}),
            color,
          },
        },
      },
    })
  }

  // Update axis font
  const handleFontChange = (fontFamily: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentFontObj = (latestLayout.font as Partial<Layout['font']>) ?? {}

    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        font: {
          ...currentFontObj,
          family: fontFamily,
        },
      },
    })
  }

  // Update plot font size
  const handleFontSizeChange = (size: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentMeta = (latestLayout.meta as Record<string, unknown> | undefined) ?? {}
    const titleFontCustom = currentMeta.titleFontSizeCustom === true
    const currentFontObj = (latestLayout.font as Partial<Layout['font']>) ?? {}
    const currentTitle = latestLayout.title
    const currentTitleFont =
      typeof currentTitle === 'object'
        ? ((currentTitle.font as Partial<Layout['font']>) ?? {})
        : {}
    const currentXaxis = (latestLayout.xaxis as any) ?? {}
    const currentYaxis = (latestLayout.yaxis as any) ?? {}
    const currentLegend = (latestLayout.legend as any) ?? {}
    const nextSize = Number(size)
    const nextTitleFontSize =
      titleFontCustom && typeof currentTitleFont.size === 'number'
        ? currentTitleFont.size
        : Math.round(nextSize * 1.2)

    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        font: {
          ...currentFontObj,
          size: nextSize,
        },
        title: {
          ...(typeof currentTitle === 'object' ? currentTitle : {}),
          font: {
            ...currentTitleFont,
            size: nextTitleFontSize,
          },
        },
        xaxis: {
          ...currentXaxis,
          title: {
            ...(currentXaxis.title ?? {}),
            font: {
              ...(currentXaxis.title?.font ?? {}),
              size: nextSize,
            },
          },
          tickfont: {
            ...(currentXaxis.tickfont ?? {}),
            size: Math.round(nextSize * 0.9),
          },
        },
        yaxis: {
          ...currentYaxis,
          title: {
            ...(currentYaxis.title ?? {}),
            font: {
              ...(currentYaxis.title?.font ?? {}),
              size: nextSize,
            },
          },
          tickfont: {
            ...(currentYaxis.tickfont ?? {}),
            size: Math.round(nextSize * 0.9),
          },
        },
        legend: {
          ...currentLegend,
          font: {
            ...(currentLegend.font ?? {}),
            size: Math.round(nextSize * 0.9),
          },
        },
        meta: currentMeta,
      },
    })
  }

  const handleAxisFontColorChange = (color: string) => {
    const latestPlot = getLatestActivePlot()
    if (!latestPlot) return
    const latestLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
    const currentXaxis = (latestLayout.xaxis as any) ?? {}
    const currentYaxis = (latestLayout.yaxis as any) ?? {}
    const currentLegend = (latestLayout.legend as any) ?? {}

    updatePlot(latestPlot.id, {
      plotlyLayout: {
        ...latestLayout,
        xaxis: {
          ...currentXaxis,
          title: {
            ...(currentXaxis.title ?? {}),
            font: {
              ...(currentXaxis.title?.font ?? {}),
              color,
            },
          },
          tickfont: {
            ...(currentXaxis.tickfont ?? {}),
            color,
          },
        },
        yaxis: {
          ...currentYaxis,
          title: {
            ...(currentYaxis.title ?? {}),
            font: {
              ...(currentYaxis.title?.font ?? {}),
              color,
            },
          },
          tickfont: {
            ...(currentYaxis.tickfont ?? {}),
            color,
          },
        },
        legend: {
          ...currentLegend,
          font: {
            ...(currentLegend.font ?? {}),
            color,
          },
        },
      },
    })
  }

  const handleAxisFontColorChangeRef = useRef(handleAxisFontColorChange)
  useEffect(() => {
    handleAxisFontColorChangeRef.current = handleAxisFontColorChange
  }, [handleAxisFontColorChange])

  const debouncedHandleAxisFontColorChange = useMemo(
    () =>
      debounce((color: string) => {
        handleAxisFontColorChangeRef.current(color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedHandleAxisFontColorChange.cancel()
  }, [debouncedHandleAxisFontColorChange])

  /**
   * Export statistical results to Excel file
   * Uses rust_xlsxwriter via Tauri command
   */
  const handleExportExcel = async () => {
    if (results.length === 0) {
      setStatusMessage('No results to export')
      return
    }

    try {
      const latestResult = results.reduce((latest, candidate) => {
        const latestTime = latest.executedAt instanceof Date
          ? latest.executedAt.getTime()
          : new Date(latest.executedAt).getTime()
        const candidateTime = candidate.executedAt instanceof Date
          ? candidate.executedAt.getTime()
          : new Date(candidate.executedAt).getTime()
        return candidateTime > latestTime ? candidate : latest
      }, results[0]!)

      const testNameSlug = String(latestResult?.testName ?? 'statistics')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'statistics'
      const now = new Date()
      const dateStamp = [
        now.getFullYear().toString(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('')
      const timeStamp = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')
      const defaultFilename = `${testNameSlug}_statistics_${dateStamp}_${timeStamp}.xlsx`

      // Open save dialog
      const filePath = await save({
        defaultPath: defaultFilename,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      })

      if (!filePath) {
        // User cancelled
        return
      }

      // Export container with full TestResult data (all fields)
      // Container approach allows Rust to render any field that exists
      const exportContainer = {
        version: '1.0', // Schema version for backward compatibility
        results: results.map(r => ({
          ...r, // Spread entire TestResult object (includes ecpTableCollection, assumptions, postHoc, coefficients, etc.)
          executedAt: r.executedAt instanceof Date
            ? r.executedAt.toISOString()
            : String(r.executedAt),
        })),
      }

      // Invoke Rust export command
      await invoke('export_results_excel', {
        container: JSON.stringify(exportContainer), // Changed from 'results' to 'container'
        filePath,
      })

      setStatusMessage(`Results exported to ${filePath}`)
      toast.success('Results exported successfully', { description: filePath })
    } catch (error) {
      console.error('Export failed:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      setStatusMessage(`Export failed: ${errorMessage}`)
      toast.error('Results export failed', { description: errorMessage })
    }
  }

  // FIX: Use handlers from props (wired to same functions as keyboard shortcuts)
  const handleCopy = () => {
    if (onCopy) {
      onCopy()
    } else {
      setStatusMessage('Copy: Not yet implemented')
    }
  }

  const handleCut = () => {
    if (onCut) {
      onCut()
    } else {
      setStatusMessage('Cut: Not yet implemented')
    }
  }

  const handlePaste = () => {
    if (onPaste) {
      onPaste()
    } else {
      setStatusMessage('Paste: Not yet implemented')
    }
  }

  const handleUndo = () => {
    if (onUndo) {
      onUndo()
    } else {
      setStatusMessage('Undo: Not yet implemented')
    }
  }

  const handleRedo = () => {
    if (onRedo) {
      onRedo()
    } else {
      setStatusMessage('Redo: Not yet implemented')
    }
  }

  const handleClear = () => {
    if (onClearData) {
      onClearData()
    } else {
      setStatusMessage('Clear dataset')
    }
  }

  const handleCheckForUpdates = async () => {
    if (updaterInProgress || updateCheckInFlightRef.current) return
    updateCheckInFlightRef.current = true
    try {

      const ensureUpdateInstallPreflight = async (): Promise<boolean> => {
        if (!useAppStore.getState().projectDirty) return true

        const saveBeforeUpdate = await confirm(
          'You have unsaved changes.\n\nSave before installing this update?',
          {
            title: 'Unsaved Changes',
            kind: 'warning',
          }
        )

        if (saveBeforeUpdate) {
          const saveHandler = useAppStore.getState().saveProjectHandler
          if (!saveHandler) {
            const continueWithoutSaving = await confirm(
              'Save is currently unavailable for this project.\n\nInstall update without saving?',
              {
                title: 'Save Unavailable',
                kind: 'warning',
              }
            )
            if (!continueWithoutSaving) {
              toast.info('Update canceled because save is unavailable.')
              return false
            }
          } else {
            await saveProject()
            if (useAppStore.getState().projectDirty) {
              toast.info('Update canceled because save did not complete.')
              return false
            }
          }
        } else {
          const continueWithoutSaving = await confirm(
            'Install update without saving?\n\nThe app may close during installer handoff.',
            {
              title: 'Install Without Saving',
              kind: 'warning',
            }
          )
          if (!continueWithoutSaving) {
            return false
          }
        }

        return true
      }

      const status = await runUpdaterFlow({
        source: 'menu',
        onProgress: setUpdaterProgress,
        beforeInstall: ensureUpdateInstallPreflight,
      })

      switch (status) {
        case 'no-update':
          toast.info('No updates available. You are on the latest version.')
          break
        case 'installed':
          if (/windows/i.test(navigator.userAgent)) {
            toast.success('Update handoff complete. Installer will continue update.')
          } else {
            toast.success('Update installed. Restart when prompted to finish.')
          }
          break
        case 'skipped':
          toast.info('Update installation skipped')
          break
        case 'busy':
          toast.info('Update check already in progress')
          break
        case 'failed':
          toast.error('Unable to check for updates right now. Please try again.')
          break
      }
      setUpdaterStatusSnapshot(readUpdaterStatusSnapshot())
    } finally {
      updateCheckInFlightRef.current = false
    }
  }

  const helpTroubleshootingItems = [
    onOpenCheatsheet
      ? {
          id: 'stats-guide',
          title: 'Statistical Tests Guide',
          description: 'Browse all available tests',
          icon: BookText,
          onSelect: () => {
            onOpenCheatsheet()
            setShowReportDialog(false)
          },
        }
      : null,
    onBrowseExamples
      ? {
          id: 'stats-samples',
          title: 'Statistics Sample Datasets',
          description: 'Browse bundled example data',
          icon: BookOpen,
          onSelect: () => {
            onBrowseExamples()
            setShowReportDialog(false)
          },
        }
      : null,
    onOpenRNAseqGuide
      ? {
          id: 'rnaseq-guide',
          title: 'Bulk RNA-seq Guide',
          description: 'easyCris workflow, models & interpretation',
          icon: BookText,
          onSelect: () => {
            onOpenRNAseqGuide()
            setShowReportDialog(false)
          },
        }
      : null,
    onImportRNAseqSample
      ? {
          id: 'rnaseq-sample',
          title: 'RNA-seq Sample Dataset',
          description: 'Import oncology demo (counts + metadata)',
          icon: BookOpen,
          onSelect: () => {
            onImportRNAseqSample()
            setShowReportDialog(false)
          },
        }
      : null,
    onOpenDataCleaningGuide
      ? {
          id: 'data-cleaning-guide',
          title: 'Data Cleaning Guide',
          description: 'Learn how to reshape, filter & summarize data',
          icon: Wrench,
          onSelect: () => {
            onOpenDataCleaningGuide()
            setShowReportDialog(false)
          },
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item))

  const openEmailUrl = async (url: string) => {
    try {
      await openUrl(url)
    } catch {
      toast.error(
        "Couldn't open email client — use the GitHub option or email hello@easycris.com directly."
      )
    }
  }

  const helpFeedbackItems = buildFeedbackItems({
    version: installedVersion ?? 'Unknown',
    openEmailFn: (url) => { void openEmailUrl(url) },
    openUrlFn: (url) => { void openUrl(url) },
    closeFn: () => { setShowReportDialog(false) },
  })

  const helpSupportDialog = (
    <AlertDialog open={showReportDialog} onOpenChange={setShowReportDialog}>
      <AlertDialogContent
        className="w-[460px] max-w-[90vw] max-h-[85dvh] p-0 gap-0 flex flex-col overflow-hidden font-sans"
        aria-labelledby="help-support-title"
        aria-describedby="help-support-description"
      >
        <AlertDialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <AlertDialogTitle id="help-support-title">Help & Support</AlertDialogTitle>
          <p id="help-support-description" className="sr-only">
            Browse troubleshooting guides, send feedback, and review legal documents.
          </p>
        </AlertDialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4">
          <Accordion
            type="multiple"
            defaultValue={['troubleshooting', 'feedback']}
            className="min-w-0"
            aria-label="Help and support sections"
          >
            <AccordionItem value="troubleshooting" className="border-b-0">
              <AccordionTrigger className="text-xs font-medium text-muted-foreground uppercase tracking-wide py-2 hover:no-underline">
                Troubleshooting
              </AccordionTrigger>
              <AccordionContent className="pb-2" aria-label="Troubleshooting resources">
                {helpTroubleshootingItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={item.onSelect}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-accent rounded-md text-left transition-colors mb-3"
                    >
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                    </button>
                  )
                })}
                <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">App updates</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/80">
                        Check and install the latest easyCris update.
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground/80">
                        Installed version: {installedVersion ?? 'Unknown'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => { void handleCheckForUpdates() }}
                      disabled={updaterInProgress}
                      className="h-7 px-2 text-xs shrink-0"
                    >
                      {updaterInProgress ? (
                        <>
                          <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
                          {getUpdaterButtonLabel(updaterProgress)}
                        </>
                      ) : (
                        getUpdaterButtonLabel(updaterProgress)
                      )}
                    </Button>
                  </div>

                  <div className="mt-2 space-y-1">
                    <p className="text-[11px] text-foreground/90">
                      Status: {updaterProgress.message}
                    </p>
                    {updaterProgress.version && (
                      <p className="text-[11px] text-muted-foreground/80">
                        Target version: {updaterProgress.version}
                      </p>
                    )}

                    {updaterInProgress && (
                      <>
                        <div
                          className="h-1.5 w-full overflow-hidden rounded bg-muted"
                          role="progressbar"
                          aria-label="Update download progress"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={
                            updaterProgress.progressPercent !== null &&
                            updaterProgress.progressPercent !== undefined
                              ? updaterProgress.progressPercent
                              : undefined
                          }
                          aria-valuetext={
                            updaterProgress.progressPercent !== null &&
                            updaterProgress.progressPercent !== undefined
                              ? `${updaterProgress.progressPercent}%`
                              : 'In progress'
                          }
                        >
                          <div
                            className={cn(
                              'h-full rounded bg-primary transition-all',
                              updaterProgress.progressPercent === null ? 'animate-pulse w-[8%]' : ''
                            )}
                            style={
                              updaterProgress.progressPercent !== null && updaterProgress.progressPercent !== undefined
                                ? { width: `${updaterProgress.progressPercent}%` }
                                : undefined
                            }
                          />
                        </div>
                        <p className="text-[11px] text-muted-foreground/80">
                          {updaterProgress.progressPercent !== null && updaterProgress.progressPercent !== undefined
                            ? `${updaterProgress.progressPercent}%`
                            : 'Working…'}
                          {updaterProgress.downloadedBytes !== null &&
                          updaterProgress.downloadedBytes !== undefined ? (
                            <>
                              {' '}(
                              {formatUpdaterBytes(updaterProgress.downloadedBytes)}
                              {updaterProgress.totalBytes !== null &&
                              updaterProgress.totalBytes !== undefined
                                ? ` / ${formatUpdaterBytes(updaterProgress.totalBytes)}`
                                : ''}
                              )
                            </>
                          ) : null}
                        </p>
                        <p className="text-[11px] text-amber-700 dark:text-amber-300">
                          Do not close easyCris during update download/install.
                        </p>
                      </>
                    )}

                    {updaterProgress.phase === 'failed' && updaterProgress.error && (
                      <p className="text-[11px] text-destructive/90">
                        Error: {updaterProgress.error}
                      </p>
                    )}

                    {updaterProgress.releaseNotes && (
                      <p className="text-[11px] text-muted-foreground/80 line-clamp-3">
                        What&apos;s new: {updaterProgress.releaseNotes}
                      </p>
                    )}

                    <p className="text-[11px] text-muted-foreground/80">
                      Last check: {formatUpdaterTimestamp(updaterStatusSnapshot.lastCheckAt)}
                    </p>
                    <p className="text-[11px] text-muted-foreground/80">
                      Last result: {updaterStatusSnapshot.lastResult ?? 'Unknown'}
                      {updaterStatusSnapshot.lastVersion
                        ? ` (version ${updaterStatusSnapshot.lastVersion})`
                        : ''}
                    </p>

                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={updaterInProgress}
                        onClick={() => { void handleCheckForUpdates() }}
                      >
                        Retry
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => { void openUrl(EASYCRIS_RELEASE_NOTES_URL) }}
                      >
                        View release notes
                      </Button>
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="feedback" className="border-b-0">
              <AccordionTrigger className="text-xs font-medium text-muted-foreground uppercase tracking-wide py-2 hover:no-underline">
                Feedback
              </AccordionTrigger>
              <AccordionContent className="pb-2" aria-label="Feedback links">
                <div className="space-y-1">
                  {helpFeedbackItems.map((item) => {
                    const iconMap: Record<string, React.ElementType> = {
                      'report-bug': Bug,
                      'request-feature': Lightbulb,
                      'love-easycris': Star,
                    }
                    const Icon = iconMap[item.id] ?? ExternalLink
                    const primaryIcon = item.id === 'love-easycris'
                      ? <Star className="h-3 w-3" />
                      : <Mail className="h-3 w-3" />
                    return (
                      <div
                        key={item.id}
                        className="flex items-start gap-3 px-3 py-2 rounded-md"
                      >
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{item.title}</p>
                          <p className="text-xs text-muted-foreground mb-2">{item.description}</p>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="default"
                              className="h-7 px-2 text-xs gap-1"
                              onClick={item.primaryAction}
                            >
                              {primaryIcon}
                              {item.primaryLabel}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs gap-1"
                              onClick={item.secondaryAction}
                            >
                              <ExternalLink className="h-3 w-3" />
                              {item.secondaryLabel}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="legal" className="border-b-0">
              <AccordionTrigger className="text-xs font-medium text-muted-foreground uppercase tracking-wide py-2 hover:no-underline">
                Legal
              </AccordionTrigger>
              <AccordionContent className="pb-2" aria-label="Legal resources">
                <div className="space-y-2">
                  {LEGAL_RESOURCES.map((resource) => {
                    const Icon = resource.Icon
                    return (
                      <div
                        key={resource.id}
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-accent/60 overflow-hidden"
                      >
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{resource.label}</p>
                            <p className="text-xs text-muted-foreground truncate">{resource.description}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { void loadBundledResourceText(resource) }}
                            className="h-7 px-2 text-xs"
                          >
                            View
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { void openBundledResource(resource) }}
                            className="h-7 px-2 text-xs"
                          >
                            Open file
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                  {legalView && (
                    <div className="rounded-md border border-border/50 bg-muted/30">
                      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
                        <p className="text-xs font-medium">{legalView.resource.label}</p>
                        <div className="flex items-center gap-2">
                          {legalShowingPreview && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setLegalPreviewExpanded(true)}
                              className="h-7 px-2 text-xs"
                            >
                              Show full
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLegalView(null)}
                            className="h-7 px-2 text-xs"
                          >
                            Hide
                          </Button>
                        </div>
                      </div>
                      {legalFullView ? (
                        <div className="px-3 py-2">
                          <textarea
                            readOnly
                            wrap="off"
                            spellCheck={false}
                            value={legalDisplayedContent}
                            className="h-44 w-full resize-none overflow-auto bg-transparent text-[11px] font-mono leading-relaxed outline-none"
                          />
                        </div>
                      ) : (
                        <div className="max-h-48 w-full min-w-0 overflow-auto overflow-x-hidden px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-words">
                          {legalLoading ? 'Loading…' : legalError ? legalError : legalDisplayedContent}
                          {!legalLoading && !legalError && legalShowingPreview && (
                            <p className="mt-2 text-[10px] text-muted-foreground">
                              Previewing first {legalPreviewSizeKb} KB of {legalTotalSizeKb} KB. Use
                              {' '}\"Show full\" or \"Open file\" for the complete text.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        <AlertDialogFooter className="px-6 py-4 border-t mt-0 shrink-0">
          <AlertDialogCancel type="button">Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // Plot-specific toolbar content
  if (workspaceViewMode === 'plots') {
    return (
      <>
        <TooltipProvider>
          <div
            className={cn(
              'flex items-center gap-2 py-2 px-3 bg-muted/10 border-b border-border h-10',
              isNotFull ? 'overflow-hidden' : 'overflow-x-auto whitespace-nowrap',
              className
            )}
          >
          {activePlot && (
            <>
              {!isNotFull && (
                <>
                  {/* TITLE GROUP */}
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Title</span>

                  {/* Title Text */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1">
                        <Type className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <Input
                          value={currentTitle}
                          onChange={(e) => handleTitleChange(e.target.value)}
                          placeholder="Plot title"
                          className="h-7 w-32 text-xs"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Edit plot title</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Title Font */}
                  <Tooltip>
                    <Select value={normalizedTitleFont} onValueChange={handleTitleFontChange}>
                      <TooltipTrigger asChild>
                        <SelectTrigger className="h-7 w-28 text-xs">
                          <SelectValue placeholder="Font" />
                        </SelectTrigger>
                      </TooltipTrigger>
                      <SelectContent>
                        {PLOT_FONTS.map((font) => (
                          <SelectItem
                            key={font.value}
                            value={font.value}
                            style={{ fontFamily: font.value }}
                            className="text-xs"
                          >
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <TooltipContent>
                      <p>Title font</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Title Font Size */}
                  <Tooltip>
                    <Select value={String(currentTitleFontSize)} onValueChange={handleTitleFontSizeChange}>
                      <TooltipTrigger asChild>
                        <SelectTrigger className="h-7 w-14 text-xs">
                          <SelectValue placeholder="Size" />
                        </SelectTrigger>
                      </TooltipTrigger>
                      <SelectContent>
                        {FONT_SIZES.map((size) => (
                          <SelectItem key={size} value={String(size)} className="text-xs">
                            {size}pt
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <TooltipContent>
                      <p>Title size</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Title Color */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Input
                        type="color"
                        value={formatColorForInput(currentTitleFontColor)}
                        onChange={(e) => handleTitleFontColorChange(e.target.value)}
                        className="h-7 w-10 p-1"
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Title color</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* AXIS GROUP */}
                  <Separator orientation="vertical" className="h-6 mx-2" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Axis</span>

                  {/* Axis Font */}
                  <Tooltip>
                    <Select value={normalizedFont} onValueChange={handleFontChange}>
                      <TooltipTrigger asChild>
                        <SelectTrigger className="h-7 w-28 text-xs">
                          <SelectValue placeholder="Font" />
                        </SelectTrigger>
                      </TooltipTrigger>
                      <SelectContent>
                        {PLOT_FONTS.map((font) => (
                          <SelectItem
                            key={font.value}
                            value={font.value}
                            style={{ fontFamily: font.value }}
                            className="text-xs"
                          >
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <TooltipContent>
                      <p>Axis font</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Axis Font Size */}
                  <Tooltip>
                    <Select value={String(currentFontSize)} onValueChange={handleFontSizeChange}>
                      <TooltipTrigger asChild>
                        <SelectTrigger className="h-7 w-14 text-xs">
                          <SelectValue placeholder="Size" />
                        </SelectTrigger>
                      </TooltipTrigger>
                      <SelectContent>
                        {FONT_SIZES.map((size) => (
                          <SelectItem key={size} value={String(size)} className="text-xs">
                            {size}pt
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <TooltipContent>
                      <p>Axis size</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Axis Color */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Input
                        type="color"
                        value={axisColorInput}
                        onChange={(e) => {
                          const next = e.target.value
                          setAxisColorInput(next)
                          debouncedHandleAxisFontColorChange(next)
                        }}
                        className="h-7 w-10 p-1"
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Axis color</p>
                    </TooltipContent>
                  </Tooltip>
                </>
              )}

              {isNotFull && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPlotSidebarTab('axes')
                        if (!showPlotSidebar) {
                          setShowPlotSidebar(true)
                        }
                      }}
                      className="flex items-center gap-1.5 h-7 text-muted-foreground hover:text-muted-foreground hover:bg-muted/20"
                    >
                      <Type className="h-4 w-4" />
                      <span className="text-xs">Typography</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Open typography controls in settings</p>
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Colors Tab Shortcut */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPlotSidebarTab('colors')
                      if (!showPlotSidebar) {
                        setShowPlotSidebar(true)
                      }
                    }}
                    className="flex items-center gap-1.5 h-7 text-muted-foreground hover:text-muted-foreground hover:bg-muted/20"
                  >
                    <Palette className="h-4 w-4" />
                    <span className="text-xs">Colors</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Open color settings</p>
                </TooltipContent>
              </Tooltip>

              {/* Axes Tab Shortcut */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPlotSidebarTab('axes')
                      if (!showPlotSidebar) {
                        setShowPlotSidebar(true)
                      }
                    }}
                    className="flex items-center gap-1.5 h-7 text-muted-foreground hover:text-muted-foreground hover:bg-muted/20"
                  >
                    <Axis3d className="h-4 w-4" />
                    <span className="text-xs">Axes</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Open axis & legend settings</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Plot settings toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showPlotSidebar ? 'secondary' : 'ghost'}
                size="sm"
                onClick={togglePlotSidebar}
                className={cn(
                  'relative flex items-center gap-2',
                  !showPlotSidebar && "text-muted-foreground hover:text-muted-foreground hover:bg-muted/20"
                )}
              >
                <Settings2 className="h-4 w-4" />
                {shouldShowPlotSettingsAttentionBadge && (
                  <span
                    className={cn(
                      'pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full shrink-0',
                      hasUnseenAutoPlotSettings
                        ? 'bg-[#06A77D]'
                        : 'bg-muted-foreground/70'
                    )}
                    aria-hidden="true"
                  />
                )}
                <span className="whitespace-nowrap text-xs">
                  {showPlotSidebar ? 'Hide settings' : 'Show settings'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{plotSettingsTooltipMessage}</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className={cn('h-6 mx-2', isNotFull && 'hidden')} />

          {/* Help */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowReportDialog(true)}
                className="flex items-center gap-1.5 h-8 text-muted-foreground hover:text-foreground"
              >
                <WarningCircle className="h-4 w-4" weight="bold" />
                <span className="text-xs">Help</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Help, support, and system tools</p>
            </TooltipContent>
          </Tooltip>
          </div>
        </TooltipProvider>

      {helpSupportDialog}
      </>
    )
  }

  // Data/Results toolbar (default)
  return (
    <>
      <TooltipProvider>
      <div
        className={cn(
          'flex items-center gap-2 py-2 px-3 bg-muted/10 border-b border-border h-10',
          className
        )}
      >
        {/* Primary Actions - [Import] [Perform Test] | [Export] [Clear] | [Group] [Sort] */}
        <div className="flex items-center gap-2">
          {/* Import Data Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size="sm"
                onClick={onImportData}
                className="flex items-center gap-2"
              >
                <FolderDown className="h-4 w-4" />
                <span>Import</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Import data from CSV, TSV, or Excel file</p>
            </TooltipContent>
          </Tooltip>

          {/* Perform Test Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="run-analysis-button"
                variant="default"
                size="sm"
                onClick={onPerformTest}
                disabled={!hasData || !hasDataRows || isRunning}
                className={cn(
                  'flex items-center gap-2 bg-[#059669] hover:bg-[#047857] text-white',
                  (!hasData || !hasDataRows) && 'opacity-50 cursor-not-allowed'
                )}
              >
                <Play className="h-4 w-4" />
                <span>
                  {isRunning ? 'Running...' : 'Perform Test'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                {hasData
                  ? hasDataRows
                    ? 'Select and run a statistical test'
                    : 'Enter or import data first to perform test'
                  : 'Import data first to perform test'}
              </p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2" />

          {/* Export Results Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExportExcel}
                disabled={!hasResults}
                className="flex items-center gap-2"
              >
                <Download className="h-4 w-4" />
                <span>Export</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
                <p>
                  {hasResults
                  ? `Export ${results.length} result(s)`
                  : 'Run analysis first to export results'}
                </p>
            </TooltipContent>
          </Tooltip>

          {/* Clear Dataset Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={!hasData}
                className="flex items-center gap-2"
                data-testid="toolbar-clear"
              >
                <Trash2 className="h-4 w-4" />
                <span>Clear</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Clear current dataset</p>
            </TooltipContent>
          </Tooltip>

          {/* Insert Operations Menu Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  if (!onInsertMenu) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  const x = Math.round(rect.left)
                  const y = Math.round(rect.bottom + 4)
                  onInsertMenu(x, y)
                }}
                disabled={!hasData || !onInsertMenu}
                className="flex items-center gap-2"
              >
                <Plus className="h-4 w-4" />
                <span>Insert</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Insert row/column operations</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2" />

          {/* Sort Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSort}
                disabled={!hasData || !hasDataRows || !onSort}
                className="flex items-center gap-2"
              >
                <ArrowUpDown className="h-4 w-4" />
                <span>Sort</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Sort rows by column values</p>
            </TooltipContent>
          </Tooltip>

          {/* Filter Button */}
          {onFilter && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    onFilter!({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
                  }}
                  disabled={!hasData || !hasDataRows}
                  className="flex items-center gap-2"
                >
                  <FilterIcon className="h-4 w-4" />
                  <span>Filter</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Filter rows by column values</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Spacer - push clipboard actions to the right */}
        <div className="flex-1" />

        {/* Clipboard Actions (Right) */}
        <div className="flex items-center gap-1">
          <Separator orientation="vertical" className="h-6 mr-2" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleCopy}
                disabled={!hasData}
                className="h-8 w-8"
                data-testid="toolbar-copy"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Copy selected cells (Ctrl+C)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleCut}
                disabled={!hasData}
                className="h-8 w-8"
                data-testid="toolbar-cut"
              >
                <Scissors className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Cut selected cells (Ctrl+X)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handlePaste}
                disabled={!hasData}
                className="h-8 w-8"
                data-testid="toolbar-paste"
              >
                <ClipboardPaste className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Paste from clipboard (Ctrl+V)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleUndo}
                disabled={!hasData}
                className="h-8 w-8"
                data-testid="toolbar-undo"
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Undo last action (Ctrl+Z)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRedo}
                disabled={!hasData}
                className="h-8 w-8"
                data-testid="toolbar-redo"
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Redo last action (Ctrl+Y)</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2" />

          {/* Help */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowReportDialog(true)}
                className="flex items-center gap-1.5 h-8 text-muted-foreground hover:text-foreground"
              >
                <WarningCircle className="h-4 w-4" weight="bold" />
                <span className="text-xs">Help</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Help, support, and system tools</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>

    {helpSupportDialog}
    </>
  )
}

export default ActionToolbar


