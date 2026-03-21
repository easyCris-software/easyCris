/**
 * SpreadsheetView - Excel-like data grid using Glide Data Grid
 *
 * Features:
 * - Integrates with data-store for dataset display
 * - Virtualization for large datasets
 * - Column resizing, sorting, filtering
 * - Cell selection and editing
 * - Toolbar with import/export actions
 */

import { useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { debounce } from 'lodash'
import { toast } from 'sonner'
import {
  DataEditor,
  type DataEditorRef,
  GridCell,
  GridCellKind,
  GridColumn,
  Item,
  EditableGridCell,
  GridSelection,
  Theme,
  CompactSelection,
  FillPatternEventArgs,
  type CellClickedEventArgs,
  type HeaderClickedEventArgs,
  type Highlight,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useDataStore } from '@/store/data-store'
import { useAppStore, ensureProjectId } from '@/store/app-store'
import type { ColumnMetadata, Dataset } from '@/store/data-store'
import { tauriApi } from '@/services/tauriApi'
import cacheService from '@/services/cacheService'
import type { DatasetStorageInfo } from '@/services/cacheService'
import { confirm } from '@tauri-apps/plugin-dialog'
import { createEditExecutor } from '@/lib/grid/editExecutor'
import { decideFillMode, computeFilledValue } from '@/lib/grid/fillUtils'
import { buildAutoFillDownDestination, isPointInFillHandleZone } from '@/lib/grid/fillHandleAutoFill'
import type { CellEdit } from '@/lib/grid/types'
import { clipboard, parseClipboardText } from '@/lib/grid/clipboard'
import { undoService, type UndoOperation } from '@/services/undoService'
import { createFormulaService, columnIndexToLetter, FormulaService, type AsyncAggregateRequest, type BackendEvalRequest, type FormulaEdit } from '@/lib/grid/formulas/formulaService'
import {
  extractFormulaReferenceRegions,
  extractFormulaReferenceTokenSpans,
} from '@/lib/grid/formulas/formulaUtils'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useTheme } from '@/hooks/use-theme'
import { getViewStateCache, setViewStateCache } from '@/lib/grid/viewStateCache'
import { FormulaCellEditor, type FormulaEditorBridge, type FormulaSessionSnapshot } from './FormulaCellEditor'
import { AutocompleteDropdown } from './AutocompleteDropdown'
import { SortDialog } from '@/components/dialogs/SortDialog'
import { OutlineDialog } from '@/components/dialogs/OutlineDialog'
import { FindReplaceDialog } from '@/components/dialogs/FindReplaceDialog'
import { PaintBucket } from '@phosphor-icons/react'
import type { SearchMatch } from '@/lib/grid/findReplace'
import { LoadingOverlay } from '@/components/ui/LoadingOverlay'
import { getTransformPreflight } from '@/utils/transformPreflight'
import { useFormulaAutocomplete } from '@/hooks/useFormulaAutocomplete'
import {
  insertReferenceIntoFormulaDraft,
  isFormulaRangePickMode,
  normalizeFormulaBeforeCommit,
  stripSheetQualifiedReferences,
  toggleAbsoluteReferenceAtCaret,
  type FormulaInsertionSpan,
} from '@/lib/grid/formulas/formulaEditUtils'
import { getFormulaBarFocusAction } from './formulaSessionFocus'
import {
  isRangePickFormulaMode,
  transitionFormulaEditMode,
  type FormulaEditMode,
} from './formulaEditStateMachine'
import {
  deriveInteractionModeFromSession,
  resolveModeAfterFill,
  shouldBlockFillPattern,
  shouldEnableFillHandle,
  shouldProcessFormulaSelection,
  type GridInteractionMode,
} from './formulaInteractionArbitration'
import {
  bumpFormulaOwnerVersion,
  resolveFormulaOwnerUpdate,
} from './formulaOwnerManager'
import {
  decideFormulaRangePickApply,
  resolveFormulaRangePickSelection,
  transitionFormulaRangeGesturePhase,
  type FormulaRangeGesturePhase,
} from './formulaRangeService'
import { resolveColumnRenameTarget } from './columnRenameUtils'
import {
  areFormulaBarAutocompletePlacementsEqual,
  isAutocompleteDropdownEventTarget,
  type FormulaBarAutocompletePlacement,
} from './formulaAutocompletePlacement'

/**
 * Format number for display, removing floating-point artifacts
 * Examples: 10.299999999999999 → 10.3, 0.1 + 0.2 → 0.3
 */
const NUMBER_FORMAT_CACHE_LIMIT = 1000
const numberFormatCache = new Map<number, string>()
const AUTOFIT_MIN_WIDTH = 72
const AUTOFIT_MAX_WIDTH = 420
const AUTOFIT_SAMPLE_ROWS = 300
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86400000
const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})
const DATETIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})
const DATE_FORMULA_PATTERN = /^\s*=?\s*(TODAY|NOW)\s*\(\s*\)\s*$/i
const FORMULA_REFERENCE_COLORS = [
  '#0000FF40', // deep blue (translucent)
  '#FF000040', // deep red (translucent)
  '#F59E0B40', // amber
  '#EF444440', // red
  '#8B5CF640', // violet
  '#EC489940', // pink
]

const FORMULA_BAR_TOKEN_TEXT_COLORS_LIGHT = [
  '#0000CC',
  '#CC0000',
  '#B45309',
  '#B91C1C',
  '#6D28D9',
  '#BE185D',
]

const FORMULA_BAR_TOKEN_TEXT_COLORS_DARK = [
  '#60A5FA',
  '#F87171',
  '#FBBF24',
  '#FB7185',
  '#A78BFA',
  '#F472B6',
]

type FormulaBarTextSegment = {
  text: string
  color: string
}

export function getFormulaBarTokenTextColors(theme: 'light' | 'dark'): readonly string[] {
  return theme === 'dark'
    ? FORMULA_BAR_TOKEN_TEXT_COLORS_DARK
    : FORMULA_BAR_TOKEN_TEXT_COLORS_LIGHT
}

export function buildFormulaBarTokenSegments(
  text: string,
  defaultTextColor: string,
  tokenTextColors: readonly string[] = FORMULA_BAR_TOKEN_TEXT_COLORS_LIGHT
): FormulaBarTextSegment[] {
  if (!text.startsWith('=')) {
    return [{ text, color: defaultTextColor }]
  }
  const spans = extractFormulaReferenceTokenSpans(text)
  if (spans.length === 0) {
    return [{ text, color: defaultTextColor }]
  }

  const segments: FormulaBarTextSegment[] = []
  let cursor = 0
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, text.length))
    const end = Math.max(start, Math.min(span.end, text.length))
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), color: defaultTextColor })
    }
    segments.push({
      text: text.slice(start, end),
      color:
        tokenTextColors[span.tokenIndex % tokenTextColors.length] ??
        defaultTextColor,
    })
    cursor = end
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), color: defaultTextColor })
  }
  return segments
}

function formatExcelSerialDate(value: number): string | null {
  if (!Number.isFinite(value)) return null
  const jsTimestamp = EXCEL_EPOCH_MS + value * MS_PER_DAY
  const date = new Date(jsTimestamp)
  if (Number.isNaN(date.getTime())) return null
  const hasTime = Math.abs(value % 1) > 1e-9
  return (hasTime ? DATETIME_FORMATTER : DATE_FORMATTER).format(date)
}

function formatNumber(value: number): string {
  const cached = numberFormatCache.get(value)
  if (cached) return cached

  const abs = Math.abs(value)
  if (abs > 0 && abs < 1e-10) {
    // Preserve very small non-zero values so formula outputs do not appear as 0.
    const scientific = value.toExponential(6)
    if (numberFormatCache.size >= NUMBER_FORMAT_CACHE_LIMIT) {
      const firstKey = numberFormatCache.keys().next().value
      if (firstKey !== undefined) numberFormatCache.delete(firstKey)
    }
    numberFormatCache.set(value, scientific)
    return scientific
  }

  // For integers, return as-is
  if (Number.isInteger(value)) {
    const integerText = value.toString()
    if (numberFormatCache.size >= NUMBER_FORMAT_CACHE_LIMIT) {
      const firstKey = numberFormatCache.keys().next().value
      if (firstKey !== undefined) numberFormatCache.delete(firstKey)
    }
    numberFormatCache.set(value, integerText)
    return integerText
  }

  // Round to 10 decimal places to eliminate floating-point errors
  // This is more than enough precision for scientific data display
  // while removing artifacts like 10.299999999998
  const rounded = Math.round(value * 1e10) / 1e10

  // Convert to string and remove trailing zeros
  const formatted = rounded.toString().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  if (numberFormatCache.size >= NUMBER_FORMAT_CACHE_LIMIT) {
    const firstKey = numberFormatCache.keys().next().value
    if (firstKey !== undefined) numberFormatCache.delete(firstKey)
  }
  numberFormatCache.set(value, formatted)
  return formatted
}


/**
 * Compare values for sorting
 * Handles nulls, numbers, strings, and dates
 */
function normalizeSortValue(value: unknown): unknown {
  // Treat blank strings as missing so they sort last and don't coerce to 0 in numeric sorting.
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

function compareValues(
  a: unknown,
  b: unknown,
  type?: ColumnMetadata['type']
): number {
  a = normalizeSortValue(a)
  b = normalizeSortValue(b)

  // Nulls last
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1

  // Try numeric comparison whenever both sides look numeric, or column is numeric
  const numA = Number(a)
  const numB = Number(b)
  const bothNumeric = !Number.isNaN(numA) && !Number.isNaN(numB)

  if (type === 'numeric' || bothNumeric) {
    if (Number.isNaN(numA) && Number.isNaN(numB)) return 0
    if (Number.isNaN(numA)) return 1
    if (Number.isNaN(numB)) return -1
    return numA - numB
  }

  switch (type) {
    case 'datetime': {
      const dateA = new Date(String(a))
      const dateB = new Date(String(b))
      if (isNaN(dateA.getTime()) && isNaN(dateB.getTime())) return 0
      if (isNaN(dateA.getTime())) return 1
      if (isNaN(dateB.getTime())) return -1
      return dateA.getTime() - dateB.getTime()
    }

    case 'categorical':
    case 'text':
    default: {
      // String comparison
      const strA = String(a).toLowerCase()
      const strB = String(b).toLowerCase()
      return strA.localeCompare(strB)
    }
  }
}

/**
 * easyCris Grid Theme - SukiUI Blue matching Avalonia TreeDataGrid
 * Light blue palette with compact rows and striping
 */
const easyCrisGridThemeLight: Partial<Theme> = {
  accentColor: '#3B82F6',          // Blue-500 (SukiUI Blue primary)
  accentFg: '#FFFFFF',             // White text on blue
  accentLight: 'rgba(59, 130, 246, 0.1)', // Light blue tint

  // Cell backgrounds - very light blue tints with striping
  bgCell: '#FFFFFF',               // White for even rows
  bgCellMedium: '#EFF3F8',         // Light blue-gray for alternate cells
  bgHeader: '#E2E8F0',             // Slate-200 (header background)
  bgHeaderHasFocus: '#DBEAFE',     // Blue-100 (focused header)
  bgHeaderHovered: '#DBEAFE',      // Blue-100 (hovered header)

  // Text colors
  textDark: '#1E293B',             // Slate-800 (dark text)
  textMedium: '#64748B',           // Slate-500 (medium text)
  textLight: '#94A3B8',            // Slate-400 (light text)
  textHeader: '#1C4A6E',           // Blue-900 (header text)
  textBubble: '#1E293B',           // Dark text for overlays

  // Borders
  borderColor: '#D6E3F5',          // Light blue border
  horizontalBorderColor: 'rgba(226, 232, 240, 0.8)', // Semi-transparent border

  // Header styling
  headerFontStyle: '500 12px "Segoe UI", -apple-system, sans-serif',
  baseFontStyle: '12px "Segoe UI", -apple-system, sans-serif',

  // Icons
  bgIconHeader: '#64748B',         // Medium slate for icons
  fgIconHeader: '#1E293B',         // Dark for icon foreground
}

const easyCrisGridThemeDark: Partial<Theme> = {
  accentColor: '#60A5FA',
  accentFg: '#0F172A',
  accentLight: 'rgba(96, 165, 250, 0.18)',
  bgCell: '#0F172A',
  bgCellMedium: '#132033',
  bgHeader: '#1E293B',
  bgHeaderHasFocus: '#1D4ED8',
  bgHeaderHovered: '#1E40AF',
  textDark: '#E2E8F0',
  textMedium: '#94A3B8',
  textLight: '#64748B',
  textHeader: '#F8FAFC',
  textBubble: '#F8FAFC',
  borderColor: '#334155',
  horizontalBorderColor: 'rgba(51, 65, 85, 0.8)',
  headerFontStyle: '500 12px "Segoe UI", -apple-system, sans-serif',
  baseFontStyle: '12px "Segoe UI", -apple-system, sans-serif',
  bgIconHeader: '#94A3B8',
  fgIconHeader: '#F8FAFC',
}

type SpreadsheetPalette = {
  formulaBarBg: string
  formulaBarBorder: string
  formulaBarLabel: string
  inputBorder: string
  inputText: string
  inputCaret: string
  emptyText: string
  addColumnBg: string
  groupHeaderBg: string
  groupHeaderText: string
  pendingText: string
  menuBg: string
  menuBorder: string
  menuText: string
  menuMutedText: string
  menuHoverBg: string
  menuShadow: string
  menuIcon: string
}

const spreadsheetPaletteLight: SpreadsheetPalette = {
  formulaBarBg: '#FFFFFF',
  formulaBarBorder: '#E5E7EB',
  formulaBarLabel: '#475569',
  inputBorder: '#CBD5E1',
  inputText: '#111827',
  inputCaret: '#111827',
  emptyText: '#64748B',
  addColumnBg: '#F9FAFB',
  groupHeaderBg: '#F3F4F6',
  groupHeaderText: '#111827',
  pendingText: '#94A3B8',
  menuBg: '#FFFFFF',
  menuBorder: '#E5E7EB',
  menuText: '#111827',
  menuMutedText: '#9CA3AF',
  menuHoverBg: '#F3F4F6',
  menuShadow: '0 10px 25px rgba(15, 23, 42, 0.15)',
  menuIcon: '#374151',
}

const spreadsheetPaletteDark: SpreadsheetPalette = {
  formulaBarBg: '#0F172A',
  formulaBarBorder: '#334155',
  formulaBarLabel: '#94A3B8',
  inputBorder: '#475569',
  inputText: '#F8FAFC',
  inputCaret: '#F8FAFC',
  emptyText: '#94A3B8',
  addColumnBg: '#111827',
  groupHeaderBg: '#1E293B',
  groupHeaderText: '#F8FAFC',
  pendingText: '#64748B',
  menuBg: '#0F172A',
  menuBorder: '#334155',
  menuText: '#E2E8F0',
  menuMutedText: '#94A3B8',
  menuHoverBg: '#1E293B',
  menuShadow: '0 16px 36px rgba(2, 6, 23, 0.5)',
  menuIcon: '#CBD5E1',
}

type ActiveCellState = {
  rowIndex: number
  colIndex: number
  columnId: string
}

type FormulaEditSource = 'bar' | 'cell'

type FormulaEditSession = {
  active: boolean
  mode: FormulaEditMode
  source: FormulaEditSource
  version: number
  editorSessionId: number | null
  targetCell: ActiveCellState | null
  text: string
  caretStart: number
  caretEnd: number
  isRangePickMode: boolean
  lastInsertedRange: FormulaInsertionSpan | null
}

type FormulaSessionUpdate = Omit<FormulaEditSession, 'active' | 'source' | 'mode' | 'version'> & {
  preserveLastInsertedRange?: boolean
}

type ViewState = {
  datasetId: string | null
  schemaKey: string | null
  sortColumn: string | null
  sortDirection: 'asc' | 'desc' | null
  groupByColumnId: string | null
  collapsedGroupKeys: string[]
  gridSelection: GridSelection | null
  activeCell: ActiveCellState | null
  scroll: { x: number; y: number } | null
}

type GridContextMenuTarget =
  | { kind: 'grid' }
  | { kind: 'header'; colIndex: number }
  | { kind: 'cell'; colIndex: number; rowIndex: number }

type ContextSubmenuPlacement = {
  x: number
  y: number
  direction: 'left' | 'right'
}

const CONTEXT_MENU_VIEWPORT_PADDING = 8
const CONTEXT_MENU_ANCHOR_GAP = 6
const CONTEXT_MENU_ESTIMATED_WIDTH = 188
const CONTEXT_MENU_ESTIMATED_HEIGHT = 360
const FORMULA_BAR_AUTOCOMPLETE_GAP = 4
const FORMULA_BAR_AUTOCOMPLETE_VIEWPORT_PADDING = 8
const FORMULA_BAR_AUTOCOMPLETE_MIN_HEIGHT = 120
const FORMULA_BAR_AUTOCOMPLETE_MAX_HEIGHT = 200
const FORMULA_BAR_AUTOCOMPLETE_TARGET_WIDTH = 520

const buildViewStateCacheKey = (
  viewKey: string | null,
  datasetId: string | null,
  schemaKey: string | null
): string | null => {
  if (!viewKey && !datasetId && !schemaKey) return null
  const safeViewKey = viewKey ?? 'default'
  const safeDatasetId = datasetId ?? 'none'
  const safeSchemaKey = schemaKey ?? 'schema:none'
  return `${safeViewKey}::${safeDatasetId}::${safeSchemaKey}`
}

const computeSchemaKey = (dataset: Dataset | null): string | null => {
  if (!dataset) return null
  const ids = dataset.columns.map((col) => col.id).sort()
  let hash = 0
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0
    }
    hash = (hash * 31 + 124) | 0
  }
  return `${ids.length}:${hash}`
}

/**
 * Props for SpreadsheetView
 */
interface SpreadsheetViewProps {
  height?: string | number
  width?: string | number
  className?: string
  /** Explicit dataset to render (avoids relying on global currentDataset) */
  datasetId?: string
  /** Key used to isolate sort/selection state across workspaces */
  viewStateKey?: string
  /** Disable statistics-family data tracking for non-statistics grids */
  trackActiveFamilyData?: boolean
  /** Callback to expose sort dialog trigger to parent */
  onSortDialogRequest?: (open: () => void) => void
  /** Callback to expose group dialog trigger to parent */
  onGroupDialogRequest?: (open: () => void) => void
  /** Callback to expose copy handler to parent */
  onCopyRequest?: (copy: () => void | Promise<void>) => void
  /** Callback to expose cut handler to parent */
  onCutRequest?: (cut: () => void | Promise<void>) => void
  /** Callback to expose paste handler to parent */
  onPasteRequest?: (paste: () => void | Promise<void>) => void
  /** Callback to expose undo handler to parent */
  onUndoRequest?: (undo: () => void | Promise<void>) => void
  /** Callback to expose insert menu opener to parent toolbar */
  onInsertMenuRequest?: (open: ((x: number, y: number) => void) | null) => void
}

/**
 * SpreadsheetView Component
 *
 * Displays dataset in an Excel-like grid with full editing capabilities.
 */
export function SpreadsheetView({
  height = '100%',
  width = '100%',
  className,
  datasetId,
  viewStateKey,
  trackActiveFamilyData = true,
  onSortDialogRequest,
  onGroupDialogRequest,
  onCopyRequest,
  onCutRequest,
  onPasteRequest,
  onUndoRequest,
  onInsertMenuRequest,
}: SpreadsheetViewProps) {
  const { resolvedTheme } = useTheme()
  const dataEditorRef = useRef<DataEditorRef | null>(null)
  const gridContainerRef = useRef<HTMLDivElement | null>(null)
  const {
    currentDataset: storeDataset,
    datasets,
    loadingOperation,
    setLoadingOperation,
    setSelectedRows,
    setSelectedColumns,
    setSelectionStats,
    updateViewport,
    // dataCache removed - streaming row provider now loads data on demand via backend (hybrid cache)
    updateCellValue,
    updateDataset,
    invalidateColumns,
    allocateNextAutoColumnName,
    rollbackAutoColumnNameAllocation,
    insertColumnAtDataset,
    insertRowAtDataset,
    removeColumnAtDataset,
    removeRowAtDataset,
    setHighlightsBatch,
    removeHighlightsBatch,
  } = useDataStore()
  const datasetsById = useMemo(() => {
    const map = new Map<string, Dataset>()
    datasets.forEach(dataset => {
      map.set(dataset.id, dataset)
    })
    return map
  }, [datasets])
  const currentDataset = useMemo(() => {
    if (!datasetId) {
      return storeDataset
    }
    return datasetsById.get(datasetId) ?? null
  }, [datasetId, datasetsById, storeDataset])
  const activeFamilyId = useAppStore(state => state.activeFamilyId)
  const projectId = useAppStore(state => state.projectId)
  const resolvedViewStateKey = useMemo(() => {
    const baseKey = viewStateKey ?? `statistics:${activeFamilyId ?? 'statistics-1'}`
    if (!projectId) return baseKey
    const prefix = `project:${projectId}:`
    return baseKey.startsWith(prefix) ? baseKey : `${prefix}${baseKey}`
  }, [viewStateKey, activeFamilyId, projectId])
  const currentSchemaKey = useMemo(
    () => computeSchemaKey(currentDataset),
    [currentDataset?.id, currentDataset?.columns]
  )
  const resolvedStateKey = useMemo(
    () => buildViewStateCacheKey(resolvedViewStateKey ?? null, currentDataset?.id ?? null, currentSchemaKey),
    [resolvedViewStateKey, currentDataset?.id, currentSchemaKey]
  )

  // Local row data cache (Map<rowIndex, rowData>)
  // Now SPARSE - only contains loaded rows, not entire dataset
  const rowDataRef = useRef<Map<number, Record<string, unknown>>>(new Map())
  const [rowDataVersion, setRowDataVersion] = useState(0)
  const selectionStatsDirtyRafRef = useRef<number | null>(null)
  const markSelectionStatsDirty = useCallback(() => {
    if (selectionStatsDirtyRafRef.current !== null) return
    selectionStatsDirtyRafRef.current = requestAnimationFrame(() => {
      selectionStatsDirtyRafRef.current = null
      setRowDataVersion(prev => prev + 1)
    })
  }, [])
  useEffect(() => {
    return () => {
      if (selectionStatsDirtyRafRef.current !== null) {
        cancelAnimationFrame(selectionStatsDirtyRafRef.current)
      }
    }
  }, [])
  const updateRowDataRef = useCallback(
    (updater: (prev: Map<number, Record<string, unknown>>) => Map<number, Record<string, unknown>>) => {
      rowDataRef.current = updater(rowDataRef.current)
      markSelectionStatsDirty()
    },
    [markSelectionStatsDirty]
  )
  const visibleRegionRef = useRef<{ x: number; y: number; width: number; height: number }>({
    x: 0,
    y: 0,
    width: 20,
    height: 60,
  })
  const lastViewportRef = useRef<{ x: number; y: number; width: number; height: number } | null>(
    null
  )
  const pendingVisibleRegionRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const visibleRegionRafRef = useRef<number | null>(null)
  // Track last range for scroll debounce - skip work if range unchanged (Phase 2)
  const lastRangeRef = useRef<{ y: number; height: number } | null>(null)
  const pendingScrollRestoreRef = useRef<{ x: number; y: number } | null>(null)
  const [scrollRestoreNonce, setScrollRestoreNonce] = useState(0)
  const pendingViewportDamageRef = useRef(false)
  const pendingBlockLoadsRef = useRef<Set<number>>(new Set()) // Track pending block loads to avoid duplicate fetches
  const scheduleViewportDamageRef = useRef<(loadedModelRows?: Set<number>) => void>(() => {})
  const scheduleCellUpdatesRef = useRef<
    (updates: Array<{ cell: readonly [number, number] }>) => void
  >(() => {})
  const cellRefreshReadyRef = useRef(false)
  const pendingCellRefreshBatchesRef = useRef<Array<Array<{ cell: readonly [number, number] }>>>([])
  const storageInfoRef = useRef<Map<string, DatasetStorageInfo>>(new Map())

  // Streaming Row Provider - Phase 5
  // Block size for windowed loading (512 rows per block)
  const BLOCK_SIZE = 512
  // Keep nearby blocks in memory to avoid scroll flicker.
  const CACHE_HALO_BLOCKS = 2
  // Keep in sync with AppShell ROW_BUFFER to preserve manual entry rows.
  const ROW_BUFFER = 50
  // Cap per-frame updates to avoid huge repaint bursts.
  const MAX_CELLS_PER_UPDATE = 500

  // Track which blocks are loaded (keyed by `${datasetId}:block:${blockIndex}`)
  const loadedBlocksRef = useRef<Set<string>>(new Set())

  // Track in-flight block fetches to avoid duplicate requests
  const pendingBlocksRef = useRef<Set<string>>(new Set())
  // Track which blocks are currently "wanted" for the viewport window (used to skip stale loads and evict old data)
  const wantedBlocksRef = useRef<Set<string>>(new Set())

  // Ref for rowOrder to pass to FormulaService (allows view-aware formula evaluation)
  const rowOrderRef = useRef<number[]>([])
  const viewToModelRef = useRef<(viewRow: number) => number>((viewRow: number) => viewRow)

  const getStorageInfo = useCallback(
    async (datasetId: string): Promise<DatasetStorageInfo | null> => {
      const cached = storageInfoRef.current.get(datasetId)
      if (cached) return cached

      try {
        // Ensure backend namespacing is aligned with current project
        await ensureProjectId()
      } catch {
        // Best-effort; continue and surface dataset-not-found if it fails
      }

      try {
        const info = await cacheService.getDatasetStorageInfo(datasetId)
        storageInfoRef.current.set(datasetId, info)
        return info
      } catch {
        if (currentDataset?.id === datasetId && currentDataset.duckdbPath) {
          const fallback: DatasetStorageInfo = {
            isLarge: true,
            duckdbPath: currentDataset.duckdbPath,
          }
          storageInfoRef.current.set(datasetId, fallback)
          return fallback
        }
        return null
      }
    },
    [currentDataset?.id, currentDataset?.duckdbPath]
  )

  // Clear storage info cache when dataset changes to avoid stale project/dataset mappings.
  useEffect(() => {
    storageInfoRef.current = new Map()
    if (currentDataset?.id) {
      void ensureProjectId()
    }
  }, [currentDataset?.id])

  const resolveDataRowCount = useCallback(
    (dataset: Dataset | null): number => {
      if (!dataset) return 0
      if (typeof dataset.dataRowCount === 'number') return dataset.dataRowCount

      const storageInfo = storageInfoRef.current.get(dataset.id)
      if (storageInfo?.isLarge) {
        return Math.max(0, dataset.rowCount - ROW_BUFFER)
      }

      return dataset.rowCount
    },
    [ROW_BUFFER]
  )

  // Ensure storage info is cached early for dataRowCount fallback logic.
  useEffect(() => {
    if (!currentDataset) return
    void getStorageInfo(currentDataset.id)
  }, [currentDataset?.id, getStorageInfo])

  // Backfill dataRowCount for large datasets if missing (buffer rows must be editable).
  useEffect(() => {
    if (!currentDataset) return
    if (typeof currentDataset.dataRowCount === 'number') return

    let cancelled = false
    void (async () => {
      const info = await getStorageInfo(currentDataset.id)
      if (cancelled || !info?.isLarge) return

      const inferred = Math.max(0, currentDataset.rowCount - ROW_BUFFER)
      updateDataset(currentDataset.id, { dataRowCount: inferred })
    })()

    return () => {
      cancelled = true
    }
  }, [currentDataset?.id, currentDataset?.dataRowCount, currentDataset?.rowCount, getStorageInfo, updateDataset, ROW_BUFFER])

  // Controlled selection state (CRITICAL for editing to work)
  const [gridSelection, setGridSelection] = useState<GridSelection>({
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  })
  const gridSelectionRef = useRef<GridSelection>(gridSelection)

  useEffect(() => {
    gridSelectionRef.current = gridSelection
  }, [gridSelection])

  const syncSelectionToStore = useCallback(
    (selection: GridSelection | null, dataset: Dataset | null) => {
      if (!dataset || !selection) {
        setSelectedRows([])
        setSelectedColumns([])
        setSelectionStats(null)
        return
      }

      const selectedRowSet = new Set<number>()
      const selectedColSet = new Set<string>()
      const selectionRanges = selection.current
        ? [selection.current.range, ...(selection.current.rangeStack ?? [])]
        : []

      if (selection.columns.length > 0) {
        for (const colIndex of selection.columns) {
          const col = dataset.columns[colIndex]
          if (col) {
            selectedColSet.add(col.id)
          }
        }
      }

      if (selection.rows.length > 0) {
        for (const rowIndex of selection.rows) {
          selectedRowSet.add(rowIndex)
        }
      }

      if (
        selectionRanges.length > 0 &&
        selection.rows.length === 0 &&
        selection.columns.length === 0
      ) {
        for (const range of selectionRanges) {
          const { x, y, width, height } = range
          for (let colIndex = x; colIndex < x + width; colIndex += 1) {
            const col = dataset.columns[colIndex]
            if (col) {
              selectedColSet.add(col.id)
            }
          }
          for (let rowIndex = y; rowIndex < y + height; rowIndex += 1) {
            selectedRowSet.add(rowIndex)
          }
        }
      }

      setSelectedRows(Array.from(selectedRowSet))
      setSelectedColumns(Array.from(selectedColSet))

      if (selectionRanges.length === 0) {
        setSelectionStats(null)
        return
      }

      // Keep stats deterministic and avoid misleading aggregates for row/column-only
      // selections where the selected cell set can be extremely large/implicit.
      if (selection.rows.length > 0 || selection.columns.length > 0) {
        setSelectionStats(null)
        return
      }

      // In lazy-grouped mode, defer stats until group metadata is available to avoid
      // view-index fallback reading the wrong model rows.
      if (isLazyGroupedRef.current && lazyGroupMetaRef.current.length === 0) {
        setSelectionStats(null)
        return
      }

      const maxCellsForStats = 20000
      const maxViewRows = rowOrderRef.current.length > 0 ? rowOrderRef.current.length : dataset.rowCount
      const selectedCells = new Map<string, { viewRow: number; columnId: string }>()

      outer: for (const range of selectionRanges) {
        const { x, y, width, height } = range
        if (width <= 0 || height <= 0) {
          continue
        }
        for (let viewRow = y; viewRow < y + height; viewRow += 1) {
          if (viewRow < 0 || viewRow >= maxViewRows) {
            continue
          }
          for (let colIndex = x; colIndex < x + width; colIndex += 1) {
            const column = dataset.columns[colIndex]
            if (!column?.id) {
              continue
            }
            const cellKey = `${viewRow}:${colIndex}`
            if (!selectedCells.has(cellKey)) {
              selectedCells.set(cellKey, { viewRow, columnId: column.id })
              if (selectedCells.size > maxCellsForStats) {
                break outer
              }
            }
          }
        }
      }

      if (selectedCells.size <= 1 || selectedCells.size > maxCellsForStats) {
        setSelectionStats(null)
        return
      }

      let count = 0
      let sum = 0
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      const expectedCellCount = selectedCells.size
      let consideredCellCount = 0
      const modelRowCache = new Map<number, number>()
      const rowRecordCache = new Map<number, Record<string, unknown> | null>()

      for (const cell of selectedCells.values()) {
        let modelRow = modelRowCache.get(cell.viewRow)
        if (modelRow === undefined) {
          modelRow = viewToModelRef.current(cell.viewRow)
          modelRowCache.set(cell.viewRow, modelRow)
        }
        if (modelRow < 0) continue

        let rowRecord = rowRecordCache.get(modelRow)
        if (rowRecord === undefined) {
          rowRecord = rowDataRef.current.get(modelRow) ?? null
          rowRecordCache.set(modelRow, rowRecord)
        }
        if (!rowRecord) continue

        consideredCellCount += 1

        const rawValue = rowRecord[cell.columnId]
        if (rawValue === null || rawValue === undefined) continue
        const numeric =
          typeof rawValue === 'number'
            ? rawValue
            : typeof rawValue === 'string'
              ? rawValue.trim() === ''
                ? Number.NaN
                : Number(rawValue.trim())
              : Number(rawValue)
        if (!Number.isFinite(numeric)) continue
        count += 1
        sum += numeric
        min = Math.min(min, numeric)
        max = Math.max(max, numeric)
      }

      if (count === 0) {
        setSelectionStats(null)
        return
      }

      setSelectionStats({
        sum,
        avg: sum / count,
        count,
        min,
        max,
        expectedCellCount,
        consideredCellCount,
        partial: consideredCellCount < expectedCellCount,
      })
    },
    [setSelectedRows, setSelectedColumns, setSelectionStats]
  )

  const buildEmptySelection = useCallback(
    () => ({
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
    }),
    []
  )

  const spreadsheetPalette = useMemo(
    () => (resolvedTheme === 'dark' ? spreadsheetPaletteDark : spreadsheetPaletteLight),
    [resolvedTheme]
  )

  const dataEditorTheme = useMemo(
    () => (resolvedTheme === 'dark' ? easyCrisGridThemeDark : easyCrisGridThemeLight),
    [resolvedTheme]
  )

  const addColumnCellTheme = useMemo(
    () => ({ bgCell: spreadsheetPalette.addColumnBg }),
    [spreadsheetPalette.addColumnBg]
  )

  const groupHeaderCellTheme = useMemo(
    () => ({
      bgCell: spreadsheetPalette.groupHeaderBg,
      textDark: spreadsheetPalette.groupHeaderText,
    }),
    [spreadsheetPalette.groupHeaderBg, spreadsheetPalette.groupHeaderText]
  )

  const pendingFormulaTheme = useMemo(
    () => ({ textMedium: spreadsheetPalette.pendingText }),
    [spreadsheetPalette.pendingText]
  )

  const menuSurfaceStyle = useMemo(
    () => ({
      backgroundColor: spreadsheetPalette.menuBg,
      border: `1px solid ${spreadsheetPalette.menuBorder}`,
      borderRadius: '6px',
      boxShadow: spreadsheetPalette.menuShadow,
    }),
    [
      spreadsheetPalette.menuBg,
      spreadsheetPalette.menuBorder,
      spreadsheetPalette.menuShadow,
    ]
  )

  const menuButtonBaseStyle = useMemo(
    () => ({
      width: '100%',
      textAlign: 'left' as const,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: spreadsheetPalette.menuText,
    }),
    [spreadsheetPalette.menuText]
  )

  const menuDividerStyle = useMemo(
    () => ({
      borderTop: `1px solid ${spreadsheetPalette.menuBorder}`,
    }),
    [spreadsheetPalette.menuBorder]
  )

  // View-Model Separation (Phase 1 - Sort & Group By)
  // rowOrder[viewRow] = modelRow - maps display order to data indices
  // Initialized to identity [0, 1, 2, ...] when dataset loads
  const [rowOrder, setRowOrder] = useState<number[]>([])

  // Keep rowOrderRef in sync with rowOrder state (for FormulaService)
  useEffect(() => {
    rowOrderRef.current = rowOrder
  }, [rowOrder])

  // Collapsed groups state (moved here for viewToModel dependency)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const collapsedGroupsRef = useRef<Set<string>>(collapsedGroups)

  useEffect(() => {
    collapsedGroupsRef.current = collapsedGroups
  }, [collapsedGroups])

  // Lazy grouping state (Phase 3 - Scroll Performance for large grouped datasets)
  // When true, rowOrder is NOT stored (saves memory for 18M+ rows)
  // Instead, we compute view row → model row on demand from lazyGroupMeta
  const [isLazyGrouped, setIsLazyGrouped] = useState(false)
  const [lazyGroupMeta, setLazyGroupMeta] = useState<
    Array<{
      key: string
      size: number
      firstRowIndex: number
      startViewRow: number // Cumulative view row offset (computed client-side)
    }>
  >([])
  const isLazyGroupedRef = useRef(isLazyGrouped)
  const lazyGroupMetaRef = useRef(lazyGroupMeta)

  useEffect(() => {
    isLazyGroupedRef.current = isLazyGrouped
  }, [isLazyGrouped])

  useEffect(() => {
    lazyGroupMetaRef.current = lazyGroupMeta
  }, [lazyGroupMeta])
  // Cache for lazy row lookups: viewRow → modelRow (sparse, filled on demand)
  const lazyRowCacheRef = useRef<Map<number, number>>(new Map())

  // Convert view row (display position) → model row (data index)
  // O(1) for regular mode, O(log n) for lazy grouped mode via binary search
  // Use this in ALL hot paths (getCellContent, edits, etc.)
  const viewToModel = useCallback(
    (viewRow: number): number => {
      // Lazy grouped mode: compute from lazyGroupMeta
      if (isLazyGrouped && lazyGroupMeta.length > 0) {
        // Check cache first
        const cached = lazyRowCacheRef.current.get(viewRow)
        if (cached !== undefined) return cached

        // Binary search to find which group contains this view row
        let low = 0
        let high = lazyGroupMeta.length - 1
        while (low < high) {
          const mid = Math.floor((low + high + 1) / 2)
          const midGroup = lazyGroupMeta[mid]
          if (midGroup && midGroup.startViewRow <= viewRow) {
            low = mid
          } else {
            high = mid - 1
          }
        }

        const group = lazyGroupMeta[low]
        if (!group) return viewRow // Fallback

        const isCollapsed = collapsedGroups.has(group.key)
        const offsetInGroup = viewRow - group.startViewRow

        // For collapsed groups or header row (offset 0), return firstRowIndex
        // For expanded groups, we need to fetch the actual row
        // For now, return firstRowIndex for header, and a placeholder for others
        // The actual row loading happens via ensureRangeLoaded
        if (isCollapsed || offsetInGroup === 0) {
          const modelRow = group.firstRowIndex
          lazyRowCacheRef.current.set(viewRow, modelRow)
          return modelRow
        }

        // For non-header rows in expanded groups, we need to return a model row
        // This is computed lazily when ensureRangeLoaded fetches the group rows
        // For now, use a placeholder (will be updated when data is loaded)
        // Return -1 to indicate "needs loading" - the grid will show loading state
        return -1
      }

      return rowOrder[viewRow] ?? viewRow // Fallback to identity if rowOrder not initialized
    },
    [isLazyGrouped, lazyGroupMeta, collapsedGroups, rowOrder]
  )

  useEffect(() => {
    viewToModelRef.current = viewToModel
  }, [viewToModel])

  useEffect(() => {
    if (!currentDataset) {
      setSelectionStats(null)
      return
    }
    syncSelectionToStore(gridSelectionRef.current, currentDataset)
  }, [
    collapsedGroups,
    currentDataset,
    isLazyGrouped,
    lazyGroupMeta,
    rowDataVersion,
    rowOrder,
    setSelectionStats,
    syncSelectionToStore,
  ])

  const MODEL_TO_VIEW_CACHE_THRESHOLD = 250_000
  const modelToViewMap = useMemo(() => {
    if (rowOrder.length === 0 || rowOrder.length > MODEL_TO_VIEW_CACHE_THRESHOLD) {
      return null
    }
    const map = new Map<number, number>()
    rowOrder.forEach((modelRow, viewRow) => {
      if (modelRow === undefined) return
      if (!map.has(modelRow)) {
        map.set(modelRow, viewRow)
      }
    })
    return map
  }, [rowOrder])

  // Convert model row (data index)   view row (display position)
  // O(n) operation - AVOID in hot paths, only use for updateCells after edits
  const modelToView = useCallback(
    (modelRow: number): number => {
      const mapped = modelToViewMap?.get(modelRow)
      if (mapped !== undefined) return mapped
      const viewRow = rowOrder.indexOf(modelRow)
      return viewRow >= 0 ? viewRow : modelRow // Fallback to identity if not found
    },
    [rowOrder, modelToViewMap]
  )

  // Sort state (Phase 3 - Sorting)
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc' | null>(null)
  const [showSortDialog, setShowSortDialog] = useState(false)
  const [showGroupDialog, setShowGroupDialog] = useState(false)

  const sortColumnRef = useRef<string | null>(sortColumn)
  const sortDirectionRef = useRef<'asc' | 'desc' | null>(sortDirection)
  const [pendingInsertSortReplay, setPendingInsertSortReplay] = useState<{
    datasetId: string
    columnId: string
    direction: 'asc' | 'desc'
    expectedRowCount: number
  } | null>(null)

  useEffect(() => {
    sortColumnRef.current = sortColumn
  }, [sortColumn])

  useEffect(() => {
    sortDirectionRef.current = sortDirection
  }, [sortDirection])

  // Grid revision counter to force re-render on structural changes (e.g., add/remove rows/columns)
  const [gridRevision, setGridRevision] = useState(0)

  type GridRefreshRequest =
    | {
        reason: string
        scope: 'remount'
      }
    | {
        reason: string
        scope: 'cells'
        cellUpdates: Array<{ cell: readonly [number, number] }>
        deferToAnimationFrame?: boolean
      }
    | {
        reason: string
        scope: 'viewport'
        loadedModelRows?: Set<number>
      }

  const requestGridRefresh = useCallback((request: GridRefreshRequest) => {
    const dispatchCellUpdates = (updates: Array<{ cell: readonly [number, number] }>) => {
      if (updates.length === 0) return
      if (!cellRefreshReadyRef.current) {
        pendingCellRefreshBatchesRef.current.push(updates)
        return
      }
      scheduleCellUpdatesRef.current(updates)
    }

    const shouldLogGridRefresh =
      import.meta.env.DEV &&
      (globalThis as { __EASYCRIS_DEBUG_GRID_REFRESH__?: boolean }).__EASYCRIS_DEBUG_GRID_REFRESH__ ===
        true
    if (shouldLogGridRefresh) {
      console.debug('[GridRefresh]', request)
    }

    if (request.scope === 'remount') {
      setGridRevision((prev) => prev + 1)
      return
    }

    if (request.scope === 'cells') {
      if (request.cellUpdates.length === 0) return
      if (request.deferToAnimationFrame) {
        requestAnimationFrame(() => {
          dispatchCellUpdates(request.cellUpdates)
        })
        return
      }
      dispatchCellUpdates(request.cellUpdates)
      return
    }

    scheduleViewportDamageRef.current(request.loadedModelRows)
  }, [])

  const requestScrollRestore = useCallback((target: { x: number; y: number }) => {
    pendingScrollRestoreRef.current = target
    setScrollRestoreNonce((prev) => prev + 1)
  }, [])

  const clampScrollTarget = useCallback(
    (target: { x: number; y: number }, dataset: Dataset | null): { x: number; y: number } => {
      if (!dataset) return target
      const maxCol = Math.max(0, dataset.columns.length - 1)

      let viewRowCount = dataset.rowCount
      const lazyMeta = lazyGroupMetaRef.current
      if (isLazyGroupedRef.current && lazyMeta.length > 0) {
        viewRowCount = lazyMeta.reduce((total, g) => {
          const isCollapsed = collapsedGroupsRef.current.has(g.key)
          return total + (isCollapsed ? 1 : g.size)
        }, 0)
      } else if (rowOrderRef.current.length > 0) {
        viewRowCount = rowOrderRef.current.length
      }

      const maxRow = Math.max(0, viewRowCount - 1)
      return {
        x: Math.min(Math.max(0, target.x), maxCol),
        y: Math.min(Math.max(0, target.y), maxRow),
      }
    },
    []
  )

  // Restore scroll position after structural grid remounts (e.g., add column).
  // Keeping the target in a ref avoids timing issues with async state updates.
  useEffect(() => {
    const pending = pendingScrollRestoreRef.current
    if (!pending) return
    pendingScrollRestoreRef.current = null

    // DataEditor.scrollTo can early-return during the first few frames of a remount because
    // cell bounds may not be measurable yet. Retry for a short burst to ensure it sticks.
    let cancelled = false
    let attempts = 0
    const maxAttempts = 12

    const restore = () => {
      if (cancelled) return
      attempts += 1
      dataEditorRef.current?.scrollTo(pending.x, pending.y, 'both', 0, 0, {
        hAlign: 'start',
        vAlign: 'start',
      })
      if (attempts < maxAttempts) {
        requestAnimationFrame(restore)
      }
    }

    requestAnimationFrame(restore)
    return () => {
      cancelled = true
    }
  }, [scrollRestoreNonce])

  // Expose dialog triggers to parent (for ActionToolbar buttons)
  useEffect(() => {
    if (onSortDialogRequest) {
      onSortDialogRequest(() => setShowSortDialog(true))
    }
  }, [onSortDialogRequest])

  useEffect(() => {
    if (onGroupDialogRequest) {
      onGroupDialogRequest(() => setShowGroupDialog(true))
    }
  }, [onGroupDialogRequest])

  // Group By state (Phase 4 - Grouping)
  const [groupByColumnId, setGroupByColumnId] = useState<string | null>(null)
  // Note: collapsedGroups is declared earlier (before viewToModel)
  const [groupMeta, setGroupMeta] = useState<
    Array<{ startViewRow: number; key: string; size: number; collapsed: boolean }>
  >([])

  const groupByColumnIdRef = useRef<string | null>(groupByColumnId)

  useEffect(() => {
    groupByColumnIdRef.current = groupByColumnId
  }, [groupByColumnId])
  // Base sorted order (before grouping) - used by rebuildGrouping
  const baseSortedOrderRef = useRef<number[]>([])
  // Sort request ID for async race protection (last-call-wins)
  const sortRequestIdRef = useRef(0)
  // Note: isLazyGrouped, lazyGroupMeta, lazyRowCacheRef are declared earlier (before viewToModel)

  // Column rename dialog state
  const [renameDialog, setRenameDialog] = useState<{
    isOpen: boolean
    colIndex: number
    currentName: string
    newName: string
  } | null>(null)

  // Find & Replace state (Phase 8)
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [findReplaceMode, setFindReplaceMode] = useState<'find' | 'replace'>('find')
  const [findReplaceMatches, setFindReplaceMatches] = useState<SearchMatch[]>([])
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean
    x: number
    y: number
    showColorPicker: boolean
    showPasteOptions: boolean
    showInsertOptions: boolean
    target: GridContextMenuTarget
  }>({
    isOpen: false,
    x: 0,
    y: 0,
    showColorPicker: false,
    showPasteOptions: false,
    showInsertOptions: false,
    target: { kind: 'grid' },
  })
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const insertOptionsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pasteOptionsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const fillColorTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [insertSubmenuPlacement, setInsertSubmenuPlacement] = useState<ContextSubmenuPlacement | null>(null)
  const [pasteSubmenuPlacement, setPasteSubmenuPlacement] = useState<ContextSubmenuPlacement | null>(null)
  const [fillColorSubmenuPlacement, setFillColorSubmenuPlacement] = useState<ContextSubmenuPlacement | null>(null)

  // Track current fill color (default yellow, updates when user picks a color)
  const [currentFillColor, setCurrentFillColor] = useState<string>('#FFEB3B')
  const [insertMenu, setInsertMenu] = useState<{
    isOpen: boolean
    x: number
    y: number
    columnIndex: number
    rowIndex: number
  }>({
    isOpen: false,
    x: 0,
    y: 0,
    columnIndex: 0,
    rowIndex: 0,
  })
  const ignoreNextInsertMenuWindowClickRef = useRef(false)
  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({
      ...prev,
      isOpen: false,
      showColorPicker: false,
      showPasteOptions: false,
      showInsertOptions: false,
      target: { kind: 'grid' },
    }))
    setInsertSubmenuPlacement(null)
    setPasteSubmenuPlacement(null)
    setFillColorSubmenuPlacement(null)
  }, [])

  const closeInsertMenu = useCallback(() => {
    ignoreNextInsertMenuWindowClickRef.current = false
    setInsertMenu({
      isOpen: false,
      x: 0,
      y: 0,
      columnIndex: 0,
      rowIndex: 0,
    })
  }, [])

  const clampToRange = useCallback((value: number, min: number, max: number) => {
    if (max < min) {
      return min
    }
    return Math.min(Math.max(value, min), max)
  }, [])

  const clampMenuToViewport = useCallback(
    (x: number, y: number, width: number, height: number) => {
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const maxX = viewportWidth - width - CONTEXT_MENU_VIEWPORT_PADDING
      const maxY = viewportHeight - height - CONTEXT_MENU_VIEWPORT_PADDING
      return {
        x: clampToRange(Math.round(x), CONTEXT_MENU_VIEWPORT_PADDING, maxX),
        y: clampToRange(Math.round(y), CONTEXT_MENU_VIEWPORT_PADDING, maxY),
      }
    },
    [clampToRange]
  )

  const computeSubmenuPlacement = useCallback(
    (
      triggerButton: HTMLButtonElement | null,
      submenuWidth: number,
      submenuHeight: number
    ): ContextSubmenuPlacement | null => {
      if (!triggerButton) {
        return null
      }
      const rect = triggerButton.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const rightX = rect.right + CONTEXT_MENU_ANCHOR_GAP
      const leftX = rect.left - submenuWidth - CONTEXT_MENU_ANCHOR_GAP
      const shouldOpenRight =
        rightX + submenuWidth <= viewportWidth - CONTEXT_MENU_VIEWPORT_PADDING ||
        leftX < CONTEXT_MENU_VIEWPORT_PADDING
      const baseX = shouldOpenRight ? rightX : leftX
      const maxX = viewportWidth - submenuWidth - CONTEXT_MENU_VIEWPORT_PADDING
      const x = clampToRange(baseX, CONTEXT_MENU_VIEWPORT_PADDING, maxX)
      const maxY = viewportHeight - submenuHeight - CONTEXT_MENU_VIEWPORT_PADDING
      const y = clampToRange(rect.top, CONTEXT_MENU_VIEWPORT_PADDING, maxY)
      return {
        x: Math.round(x),
        y: Math.round(y),
        direction: shouldOpenRight ? 'right' : 'left',
      }
    },
    [clampToRange]
  )

  const openContextMenu = useCallback(
    (x: number, y: number, target: GridContextMenuTarget) => {
      const clamped = clampMenuToViewport(
        x,
        y,
        CONTEXT_MENU_ESTIMATED_WIDTH,
        CONTEXT_MENU_ESTIMATED_HEIGHT
      )
      setContextMenu({
        isOpen: true,
        x: clamped.x,
        y: clamped.y,
        showColorPicker: false,
        showPasteOptions: false,
        showInsertOptions: false,
        target,
      })
      setInsertSubmenuPlacement(null)
      setPasteSubmenuPlacement(null)
      setFillColorSubmenuPlacement(null)
    },
    [clampMenuToViewport]
  )

  const localToViewportPoint = useCallback((localX: number, localY: number) => {
    const rect = gridContainerRef.current?.getBoundingClientRect()
    if (!rect) {
      return { x: Math.round(localX), y: Math.round(localY) }
    }
    return {
      x: Math.round(rect.left + localX),
      y: Math.round(rect.top + localY),
    }
  }, [])

  const contextEventToViewportAnchor = useCallback(
    (event: { localEventX: number; localEventY: number; bounds?: { x: number; y: number; width: number; height: number } }) => {
      if (event.bounds) {
        return localToViewportPoint(
          event.bounds.x + event.bounds.width + CONTEXT_MENU_ANCHOR_GAP,
          event.bounds.y
        )
      }
      return localToViewportPoint(event.localEventX, event.localEventY)
    },
    [localToViewportPoint]
  )

  // Highlighted regions for cell reference highlighting (when typing formulas)
  const [highlightedRegions, setHighlightedRegions] = useState<Highlight[]>([])
  const [formulaRangePreview, setFormulaRangePreview] = useState<Highlight | null>(null)
  const [gridInteractionMode, setGridInteractionMode] = useState<GridInteractionMode>('normal')
  const [hasActiveFormulaSession, setHasActiveFormulaSession] = useState(false)
  const [activeFormulaSessionSource, setActiveFormulaSessionSource] = useState<FormulaEditSource | null>(null)
  const gridInteractionModeRef = useRef<GridInteractionMode>('normal')
  useEffect(() => {
    gridInteractionModeRef.current = gridInteractionMode
  }, [gridInteractionMode])

  // Track current formula text being edited for highlighting
  const handleFormulaTextChange = useCallback((formulaText: string) => {
    if (!formulaText || !formulaText.startsWith('=')) {
      setHighlightedRegions([])
      return
    }

    // Extract contiguous reference regions (single refs + ranges) in token order.
    const refs = extractFormulaReferenceRegions(formulaText)

    const regions = refs.map((ref, idx) => {
      const color = FORMULA_REFERENCE_COLORS[idx % FORMULA_REFERENCE_COLORS.length] || '#3B82F640'
      return {
      range: {
        x: ref.range.x,
        y: ref.range.y,
        width: ref.range.width,
        height: ref.range.height,
      },
      color,
      style: 'solid-outline' as const,
      }
    })

    setHighlightedRegions(regions)
  }, [])

  // Active cell + formula bar state
  const [activeCell, setActiveCell] = useState<ActiveCellState | null>(null)
  const activeCellRef = useRef<ActiveCellState | null>(activeCell)
  const [formulaBarText, setFormulaBarText] = useState('')
  const [isFormulaBarFocused, setIsFormulaBarFocused] = useState(false)
  const formulaBarInputRef = useRef<HTMLInputElement>(null)
  const [formulaBarAutocompletePlacement, setFormulaBarAutocompletePlacement] =
    useState<FormulaBarAutocompletePlacement | null>(null)
  const formulaBarAutocompletePlacementRafRef = useRef<number | null>(null)
  const formulaBarSuggestionClickRef = useRef(false)
  const lastPointerDownTargetRef = useRef<EventTarget | null>(null)
  const isPointerDownRef = useRef(false)
  const formulaRangeGesturePhaseRef = useRef<FormulaRangeGesturePhase>('idle')
  const pendingSelfOnlyRangeWarningRef = useRef(false)
  const pendingRangePickReferenceRef = useRef<{
    reference: string
    previewRange: { x: number; y: number; width: number; height: number }
    selectionForGrid: GridSelection
  } | null>(null)
  const formulaEditorBridgeRef = useRef<FormulaEditorBridge | null>(null)
  const formulaSessionRef = useRef<FormulaEditSession | null>(null)
  const latestCellEditorSessionIdRef = useRef<number | null>(null)

  const setFormulaSession = useCallback((nextSession: FormulaEditSession | null) => {
    formulaSessionRef.current = nextSession
    const sessionState = nextSession
      ? { active: nextSession.active, isRangePickMode: nextSession.isRangePickMode }
      : null
    setHasActiveFormulaSession(!!nextSession?.active)
    setActiveFormulaSessionSource(nextSession?.active ? nextSession.source : null)
    setGridInteractionMode((currentMode) => {
      const nextMode = deriveInteractionModeFromSession(sessionState, currentMode)
      gridInteractionModeRef.current = nextMode
      return nextMode
    })
  }, [])

  const {
    suggestions: formulaBarSuggestions,
    selectedIndex: formulaBarSuggestionIndex,
    updateSuggestions: updateFormulaBarSuggestions,
    insertSuggestion: insertFormulaBarSuggestion,
    selectIndex: selectFormulaBarSuggestionIndex,
    navigateUp: navigateFormulaBarSuggestionUp,
    navigateDown: navigateFormulaBarSuggestionDown,
    clearSuggestions: clearFormulaBarSuggestions,
    currentSignature: formulaBarSuggestionSignature,
  } = useFormulaAutocomplete()

  const computeFormulaBarAutocompletePlacement = useCallback((): FormulaBarAutocompletePlacement | null => {
    const input = formulaBarInputRef.current
    if (!input) {
      return null
    }

    const rect = input.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const padding = FORMULA_BAR_AUTOCOMPLETE_VIEWPORT_PADDING
    const gap = FORMULA_BAR_AUTOCOMPLETE_GAP
    const maxAvailableWidth = viewportWidth - padding * 2
    if (maxAvailableWidth <= 0) {
      return null
    }
    const width = Math.min(FORMULA_BAR_AUTOCOMPLETE_TARGET_WIDTH, maxAvailableWidth)
    const maxLeft = viewportWidth - width - padding
    const left = maxLeft < padding ? padding : Math.min(Math.max(rect.left, padding), maxLeft)

    const belowTop = rect.bottom + gap
    const aboveBottom = rect.top - gap
    const availableBelow = Math.max(0, viewportHeight - belowTop - padding)
    const availableAbove = Math.max(0, aboveBottom - padding)

    const canRenderBelow = availableBelow >= FORMULA_BAR_AUTOCOMPLETE_MIN_HEIGHT
    const canRenderAbove = availableAbove >= FORMULA_BAR_AUTOCOMPLETE_MIN_HEIGHT
    const renderBelow = canRenderBelow || (!canRenderAbove && availableBelow >= availableAbove)
    const chosenAvailable = renderBelow ? availableBelow : availableAbove
    const maxHeight = Math.min(FORMULA_BAR_AUTOCOMPLETE_MAX_HEIGHT, chosenAvailable)
    if (maxHeight <= 0) {
      return null
    }

    if (renderBelow) {
      return {
        top: Math.round(belowTop),
        left: Math.round(left),
        width: Math.round(width),
        maxHeight: Math.round(maxHeight),
      }
    }

    return {
      top: Math.round(Math.max(padding, rect.top - gap - maxHeight)),
      left: Math.round(left),
      width: Math.round(width),
      maxHeight: Math.round(maxHeight),
    }
  }, [])

  useLayoutEffect(() => {
    if (!isFormulaBarFocused || formulaBarSuggestions.length === 0) {
      if (formulaBarAutocompletePlacementRafRef.current !== null) {
        cancelAnimationFrame(formulaBarAutocompletePlacementRafRef.current)
        formulaBarAutocompletePlacementRafRef.current = null
      }
      setFormulaBarAutocompletePlacement(null)
      return
    }

    const flushPlacement = () => {
      const next = computeFormulaBarAutocompletePlacement()
      setFormulaBarAutocompletePlacement((prev) => (
        areFormulaBarAutocompletePlacementsEqual(prev, next) ? prev : next
      ))
    }

    const schedulePlacementUpdate = (event?: Event) => {
      if (event && isAutocompleteDropdownEventTarget(event.target)) {
        return
      }
      if (formulaBarAutocompletePlacementRafRef.current !== null) {
        return
      }
      formulaBarAutocompletePlacementRafRef.current = requestAnimationFrame(() => {
        formulaBarAutocompletePlacementRafRef.current = null
        flushPlacement()
      })
    }

    schedulePlacementUpdate()
    window.addEventListener('resize', schedulePlacementUpdate)
    window.addEventListener('scroll', schedulePlacementUpdate, true)

    let resizeObserver: ResizeObserver | null = null
    const input = formulaBarInputRef.current
    if (input && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        schedulePlacementUpdate()
      })
      resizeObserver.observe(input)
    }

    return () => {
      window.removeEventListener('resize', schedulePlacementUpdate)
      window.removeEventListener('scroll', schedulePlacementUpdate, true)
      resizeObserver?.disconnect()
      if (formulaBarAutocompletePlacementRafRef.current !== null) {
        cancelAnimationFrame(formulaBarAutocompletePlacementRafRef.current)
        formulaBarAutocompletePlacementRafRef.current = null
      }
    }
  }, [
    areFormulaBarAutocompletePlacementsEqual,
    computeFormulaBarAutocompletePlacement,
    formulaBarSuggestions.length,
    formulaBarAutocompletePlacementRafRef,
    isAutocompleteDropdownEventTarget,
    isFormulaBarFocused,
  ])

  const previousViewStateKeyRef = useRef<string | null>(resolvedStateKey ?? null)
  const previousDatasetIdRef = useRef<string | null>(currentDataset?.id ?? null)
  const previousSchemaKeyRef = useRef<string | null>(currentSchemaKey)
  const currentDatasetIdRef = useRef<string | null>(currentDataset?.id ?? null)
  const currentSchemaKeyRef = useRef<string | null>(currentSchemaKey)
  const datasetRevisionRef = useRef(0)
  const pendingRestoreSortRef = useRef<{
    columnId: string
    direction: 'asc' | 'desc'
    skipConfirm?: boolean
  } | null>(null)

  useEffect(() => {
    activeCellRef.current = activeCell
  }, [activeCell])

  useEffect(() => {
    currentSchemaKeyRef.current = currentSchemaKey
  }, [currentSchemaKey])

  const updateFormulaSession = useCallback(
    (source: FormulaEditSource, snapshot: FormulaSessionUpdate) => {
      const previous = formulaSessionRef.current
      const ownerResult = resolveFormulaOwnerUpdate({
        previous: previous
          ? {
              active: previous.active,
              mode: previous.mode,
              source: previous.source,
              version: previous.version,
              editorSessionId: previous.editorSessionId,
            }
          : null,
        source,
        rangePick: snapshot.isRangePickMode,
        editorSessionId: snapshot.editorSessionId ?? null,
        latestCellEditorSessionId: latestCellEditorSessionIdRef.current,
      })
      latestCellEditorSessionIdRef.current = ownerResult.latestCellEditorSessionId
      if (!ownerResult.accepted) {
        return
      }
      if (ownerResult.recovered) {
        console.warn('[FormulaSession] recovered rejected transition', {
          source,
          previousMode: previous?.mode ?? 'idle',
          resolvedMode: ownerResult.mode,
          requestedRangePick: snapshot.isRangePickMode,
        })
      }
      setFormulaSession({
        active: true,
        mode: ownerResult.mode,
        source: ownerResult.source,
        version: ownerResult.version,
        editorSessionId: ownerResult.editorSessionId,
        targetCell: snapshot.targetCell,
        text: snapshot.text,
        caretStart: snapshot.caretStart,
        caretEnd: snapshot.caretEnd,
        isRangePickMode: isRangePickFormulaMode(ownerResult.mode),
        lastInsertedRange:
          snapshot.preserveLastInsertedRange && previous && previous.source === ownerResult.source
            ? previous.lastInsertedRange
            : snapshot.lastInsertedRange,
      })
      handleFormulaTextChange(snapshot.text)
    },
    [handleFormulaTextChange, setFormulaSession]
  )

  const clearFormulaSession = useCallback(
    (source?: FormulaEditSource) => {
      const current = formulaSessionRef.current
      if (!current) return
      if (source && current.source !== source) return
      const nextMode = transitionFormulaEditMode(current.mode, { type: 'end_session' })
      if (nextMode !== 'idle') {
        return
      }
      pendingRangePickReferenceRef.current = null
      formulaRangeGesturePhaseRef.current = 'idle'
      setFormulaSession(null)
      setHighlightedRegions([])
      setFormulaRangePreview(null)
    },
    [setFormulaSession, setHighlightedRegions]
  )

  const updateFormulaBarSession = useCallback(
    (nextText: string, caretStart?: number, caretEnd?: number) => {
      const input = formulaBarInputRef.current
      const safeStart =
        typeof caretStart === 'number'
          ? caretStart
          : input?.selectionStart ?? nextText.length
      const safeEnd =
        typeof caretEnd === 'number'
          ? caretEnd
          : input?.selectionEnd ?? safeStart

      updateFormulaSession('bar', {
        editorSessionId: null,
        targetCell: activeCellRef.current,
        text: nextText,
        caretStart: safeStart,
        caretEnd: safeEnd,
        isRangePickMode: isFormulaRangePickMode(nextText, safeStart, safeEnd),
        lastInsertedRange: null,
        preserveLastInsertedRange: false,
      })
    },
    [updateFormulaSession]
  )

  const applyReferenceToActiveFormulaSession = useCallback(
    (reference: string): boolean => {
      const session = formulaSessionRef.current
      if (!session || !session.active || !isRangePickFormulaMode(session.mode)) {
        return false
      }

      const result = insertReferenceIntoFormulaDraft(
        session.text,
        reference,
        session.caretStart,
        session.caretEnd,
        session.lastInsertedRange
      )

      const nextSession: FormulaEditSession = {
        ...session,
        version: bumpFormulaOwnerVersion(session),
        text: result.text,
        caretStart: result.caretStart,
        caretEnd: result.caretEnd,
        lastInsertedRange: result.insertedSpan,
      }

      setFormulaSession(nextSession)
      handleFormulaTextChange(result.text)

      if (session.source === 'bar') {
        setFormulaBarText(result.text)
        updateFormulaBarSuggestions(result.text, result.caretStart)
        requestAnimationFrame(() => {
          const input = formulaBarInputRef.current
          if (!input) return
          input.focus()
          input.setSelectionRange(result.caretStart, result.caretEnd)
        })
        return true
      }

      formulaEditorBridgeRef.current?.applyDraft(
        result.text,
        result.caretStart,
        result.caretEnd
      )
      if (formulaEditorBridgeRef.current) {
        formulaEditorBridgeRef.current.focus()
        return true
      }
      // If inline editor unmounted during range-pick, continue in formula bar.
      const migratedMode = transitionFormulaEditMode(nextSession.mode, {
        type: 'migrate_cell_to_bar',
        rangePick: true,
      })
      setFormulaSession({
        ...nextSession,
        version: bumpFormulaOwnerVersion(nextSession),
        mode: migratedMode ?? 'bar_range_pick',
        source: 'bar',
        editorSessionId: null,
        isRangePickMode: isRangePickFormulaMode(migratedMode ?? 'bar_range_pick'),
      })
      setFormulaBarText(result.text)
      updateFormulaBarSuggestions(result.text, result.caretStart)
      setIsFormulaBarFocused(true)
      requestAnimationFrame(() => {
        const input = formulaBarInputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(result.caretStart, result.caretEnd)
      })
      return true
    },
    [handleFormulaTextChange, setFormulaSession, updateFormulaBarSuggestions]
  )

  const tryInsertReferenceFromSelection = useCallback(
    (selection: GridSelection): {
      handled: boolean
      previewRange: { x: number; y: number; width: number; height: number } | null
      selectionForGrid: GridSelection
    } => {
      const session = formulaSessionRef.current
      const resolution = resolveFormulaRangePickSelection(
        session
          ? {
              active: session.active,
              isRangePickMode: isRangePickFormulaMode(session.mode),
              targetCell: session.targetCell,
            }
          : null,
        selection,
        currentDataset?.columns.length ?? 0
      )

      if (resolution.status === 'inactive') {
        return { handled: false, previewRange: null, selectionForGrid: selection }
      }

      if (resolution.status === 'self_only') {
        pendingRangePickReferenceRef.current = null
        pendingSelfOnlyRangeWarningRef.current = true
        return { handled: true, previewRange: null, selectionForGrid: resolution.selectionForGrid }
      }
      pendingSelfOnlyRangeWarningRef.current = false

      if (resolution.status !== 'ready') {
        pendingRangePickReferenceRef.current = null
        return { handled: false, previewRange: null, selectionForGrid: resolution.selectionForGrid }
      }

      formulaRangeGesturePhaseRef.current = transitionFormulaRangeGesturePhase(
        formulaRangeGesturePhaseRef.current,
        'selection_update'
      )

      const applyDecision = decideFormulaRangePickApply(
        resolution,
        gridInteractionModeRef.current,
        formulaRangeGesturePhaseRef.current,
        isPointerDownRef.current
      )
      if (applyDecision.action === 'preview_only') {
        pendingRangePickReferenceRef.current = {
          reference: resolution.reference,
          previewRange: resolution.previewRange,
          selectionForGrid: resolution.selectionForGrid,
        }
        return {
          handled: true,
          previewRange: resolution.previewRange,
          selectionForGrid: resolution.selectionForGrid,
        }
      }
      if (applyDecision.action !== 'apply_now') {
        pendingRangePickReferenceRef.current = null
        return { handled: false, previewRange: null, selectionForGrid: resolution.selectionForGrid }
      }
      const applied = applyReferenceToActiveFormulaSession(applyDecision.reference)
      if (!applied) {
        pendingRangePickReferenceRef.current = null
        return { handled: false, previewRange: null, selectionForGrid: resolution.selectionForGrid }
      }

      return {
        handled: true,
        previewRange: resolution.previewRange,
        selectionForGrid: resolution.selectionForGrid,
      }
    },
    [applyReferenceToActiveFormulaSession, currentDataset]
  )

  const finalizePendingRangePickReference = useCallback(() => {
    const pending = pendingRangePickReferenceRef.current
    if (!pending) return
    pendingRangePickReferenceRef.current = null
    const session = formulaSessionRef.current
    if (!session || !session.active || !isRangePickFormulaMode(session.mode)) {
      return
    }
    applyReferenceToActiveFormulaSession(pending.reference)
  }, [applyReferenceToActiveFormulaSession])

  const applyFormulaSelectionHandling = useCallback(
    (formulaHandling: {
      handled: boolean
      previewRange: { x: number; y: number; width: number; height: number } | null
      selectionForGrid: GridSelection
    }): boolean => {
      if (!formulaHandling.handled) {
        return false
      }
      setGridSelection(formulaHandling.selectionForGrid)
      syncSelectionToStore(formulaHandling.selectionForGrid, currentDataset)
      if (formulaHandling.previewRange) {
        setFormulaRangePreview({
          range: formulaHandling.previewRange,
          color: '#3B82F640',
          style: 'solid-outline',
        })
      } else {
        setFormulaRangePreview(null)
      }
      return true
    },
    [currentDataset, syncSelectionToStore]
  )

  const moveFormulaRangePickSelection = useCallback(
    (
      movement: readonly [-1 | 0 | 1, -1 | 0 | 1],
      extendSelection: boolean
    ) => {
      const session = formulaSessionRef.current
      if (!session?.active || !isRangePickFormulaMode(session.mode)) {
        return
      }
      if (!currentDataset || currentDataset.columns.length <= 0) {
        return
      }

      const currentSelection = gridSelectionRef.current
      const currentCell =
        currentSelection.current?.cell ??
        (session.targetCell
          ? ([session.targetCell.colIndex, session.targetCell.rowIndex] as [number, number])
          : ([0, 0] as [number, number]))

      const currentRowCount =
        rowOrderRef.current.length > 0 ? rowOrderRef.current.length : currentDataset.rowCount
      if (currentRowCount <= 0) {
        return
      }

      const maxCol = Math.max(0, currentDataset.columns.length - 1)
      const maxRow = Math.max(0, currentRowCount - 1)
      const nextCell: [number, number] = [
        Math.min(maxCol, Math.max(0, currentCell[0] + movement[0])),
        Math.min(maxRow, Math.max(0, currentCell[1] + movement[1])),
      ]

      const baseRange = currentSelection.current?.range
      let nextRange = {
        x: nextCell[0],
        y: nextCell[1],
        width: 1,
        height: 1,
      }
      if (extendSelection && baseRange) {
        const left = Math.min(baseRange.x, nextCell[0])
        const right = Math.max(baseRange.x + baseRange.width - 1, nextCell[0])
        const top = Math.min(baseRange.y, nextCell[1])
        const bottom = Math.max(baseRange.y + baseRange.height - 1, nextCell[1])
        nextRange = {
          x: left,
          y: top,
          width: right - left + 1,
          height: bottom - top + 1,
        }
      }

      const nextSelection: GridSelection = {
        ...currentSelection,
        current: {
          cell: nextCell,
          range: nextRange,
          rangeStack: currentSelection.current?.rangeStack ?? [],
        },
      }

      const formulaHandling = tryInsertReferenceFromSelection(nextSelection)
      const handled = applyFormulaSelectionHandling(formulaHandling)
      if (!handled) {
        setFormulaRangePreview(null)
        setGridSelection(nextSelection)
        syncSelectionToStore(nextSelection, currentDataset)
      }
    },
    [
      applyFormulaSelectionHandling,
      currentDataset,
      syncSelectionToStore,
      tryInsertReferenceFromSelection,
    ]
  )

  useEffect(() => {
    const handlePointerDownCapture = (event: MouseEvent | TouchEvent) => {
      isPointerDownRef.current = true
      formulaRangeGesturePhaseRef.current = transitionFormulaRangeGesturePhase(
        formulaRangeGesturePhaseRef.current,
        'pointer_down'
      )
      lastPointerDownTargetRef.current = event.target
      pendingSelfOnlyRangeWarningRef.current = false
      pendingRangePickReferenceRef.current = null
    }

    const finalizePointerInteraction = (emitSelfOnlyWarning: boolean) => {
      isPointerDownRef.current = false
      formulaRangeGesturePhaseRef.current = transitionFormulaRangeGesturePhase(
        formulaRangeGesturePhaseRef.current,
        emitSelfOnlyWarning ? 'finish' : 'cancel'
      )
      finalizePendingRangePickReference()
      formulaRangeGesturePhaseRef.current = transitionFormulaRangeGesturePhase(
        formulaRangeGesturePhaseRef.current,
        'reset'
      )
      if (!emitSelfOnlyWarning) {
        pendingSelfOnlyRangeWarningRef.current = false
        return
      }
      if (!pendingSelfOnlyRangeWarningRef.current) return
      pendingSelfOnlyRangeWarningRef.current = false
      toast.info('Selection only includes the formula cell. Select other cells to build a range.')
    }

    const handlePointerUpCapture = () => {
      finalizePointerInteraction(true)
    }

    const handlePointerAbortCapture = () => {
      // Covers lost pointer-up scenarios (drag leaves window/app, OS interruption).
      finalizePointerInteraction(false)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handlePointerAbortCapture()
      }
    }

    window.addEventListener('mousedown', handlePointerDownCapture, true)
    window.addEventListener('touchstart', handlePointerDownCapture, true)
    window.addEventListener('mouseup', handlePointerUpCapture, true)
    window.addEventListener('touchend', handlePointerUpCapture, true)
    window.addEventListener('touchcancel', handlePointerAbortCapture, true)
    window.addEventListener('pointercancel', handlePointerAbortCapture, true)
    window.addEventListener('blur', handlePointerAbortCapture, true)
    document.addEventListener('visibilitychange', handleVisibilityChange, true)
    return () => {
      window.removeEventListener('mousedown', handlePointerDownCapture, true)
      window.removeEventListener('touchstart', handlePointerDownCapture, true)
      window.removeEventListener('mouseup', handlePointerUpCapture, true)
      window.removeEventListener('touchend', handlePointerUpCapture, true)
      window.removeEventListener('touchcancel', handlePointerAbortCapture, true)
      window.removeEventListener('pointercancel', handlePointerAbortCapture, true)
      window.removeEventListener('blur', handlePointerAbortCapture, true)
      document.removeEventListener('visibilitychange', handleVisibilityChange, true)
    }
  }, [finalizePendingRangePickReference])

  const isEditorOutsideClick = useCallback((event: MouseEvent | TouchEvent): boolean => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return true
    if (target.closest('.formula-autocomplete-dropdown')) {
      return false
    }
    const session = formulaSessionRef.current
    if (session?.active && session.source === 'cell' && isRangePickFormulaMode(session.mode)) {
      if (gridContainerRef.current?.contains(target)) {
        return false
      }
      if (formulaBarInputRef.current?.contains(target)) {
        return false
      }
      clearFormulaBarSuggestions()
      clearFormulaSession('cell')
      return true
    }
    return true
  }, [clearFormulaBarSuggestions, clearFormulaSession])

  const saveViewState = useCallback((stateKey: string | null) => {
    if (!stateKey) return
    setViewStateCache(stateKey, {
      datasetId: currentDatasetIdRef.current,
      schemaKey: currentSchemaKeyRef.current,
      sortColumn: sortColumnRef.current,
      sortDirection: sortDirectionRef.current,
      groupByColumnId: groupByColumnIdRef.current,
      collapsedGroupKeys: Array.from(collapsedGroupsRef.current),
      gridSelection: gridSelectionRef.current,
      activeCell: activeCellRef.current,
      scroll: {
        x: visibleRegionRef.current.x,
        y: visibleRegionRef.current.y,
      },
    })
  }, [])

  // Persist view state when switching keys or unmounting.
  useEffect(() => {
    const stateKey = resolvedStateKey ?? null
    return () => {
      saveViewState(stateKey)
    }
  }, [resolvedStateKey, saveViewState])

  // Initialize rowOrder and reset streaming state when dataset/family changes.
  //
  // NOTE: Rows are currently fixed-size from currentDataset.rowCount.
  // When we add real row insertion/deletion, we must:
  // - update rowData and currentDataset.rowCount
  // - update baseSortedOrderRef.current (append/remove model rows)
  // - call rebuildGrouping(baseSortedOrderRef.current, groupByColumnId, collapsedGroups)
  // - NEVER call setRowOrder directly; let rebuildGrouping own it
  useEffect(() => {
    const previousViewKey = previousViewStateKeyRef.current

    const nextViewKey = resolvedStateKey ?? null
    const nextDatasetId = currentDataset?.id ?? null
    const nextSchemaKey = currentSchemaKey
    const datasetChanged = previousDatasetIdRef.current !== nextDatasetId
    const schemaChanged = previousSchemaKeyRef.current !== nextSchemaKey
    const viewChanged = previousViewKey !== nextViewKey
    const structuralChanged = datasetChanged || schemaChanged

    previousViewStateKeyRef.current = nextViewKey
    previousDatasetIdRef.current = nextDatasetId
    previousSchemaKeyRef.current = nextSchemaKey
    currentDatasetIdRef.current = nextDatasetId
    if (structuralChanged) {
      datasetRevisionRef.current += 1

      // CRITICAL: Reset ALL streaming state on dataset/schema change
      loadedBlocksRef.current = new Set()
      pendingBlocksRef.current = new Set()
      wantedBlocksRef.current = new Set()
      pendingBlockLoadsRef.current = new Set()
      rowDataRef.current = new Map()
      markSelectionStatsDirty()
      setIsLazyGrouped(false)
      setLazyGroupMeta([])
      lazyRowCacheRef.current.clear()
    } else {
      setIsLazyGrouped(false)
      setLazyGroupMeta([])
      lazyRowCacheRef.current.clear()
    }

    if (structuralChanged || viewChanged) {
      const { width, height } = visibleRegionRef.current
      visibleRegionRef.current = { x: 0, y: 0, width, height }
      pendingVisibleRegionRef.current = visibleRegionRef.current
      lastRangeRef.current = null
      lastViewportRef.current = null
    }

    if (!currentDataset) {
      setRowOrder([])
      baseSortedOrderRef.current = []
      setGroupByColumnId(null)
      setCollapsedGroups(new Set())
      setGroupMeta([])
      setSortColumn(null)
      setSortDirection(null)
      const emptySelection = buildEmptySelection()
      setGridSelection(emptySelection)
      syncSelectionToStore(emptySelection, null)
      setActiveCell(null)
      if (structuralChanged || viewChanged) {
        requestScrollRestore({ x: 0, y: 0 })
      }
      return
    }

    const isSelectionValid = (selection: GridSelection): boolean => {
      if (selection.current) {
        const [colIndex, rowIndex] = selection.current.cell
        if (colIndex < 0 || colIndex >= currentDataset.columns.length) return false
        if (rowIndex < 0 || rowIndex >= currentDataset.rowCount) return false
      }
      for (const colIndex of selection.columns) {
        if (colIndex < 0 || colIndex >= currentDataset.columns.length) return false
      }
      for (const rowIndex of selection.rows) {
        if (rowIndex < 0 || rowIndex >= currentDataset.rowCount) return false
      }
      return true
    }

    const isActiveCellValid = (cell: ActiveCellState | null): cell is ActiveCellState => {
      if (!cell) return false
      if (cell.colIndex < 0 || cell.colIndex >= currentDataset.columns.length) return false
      if (cell.rowIndex < 0 || cell.rowIndex >= currentDataset.rowCount) return false
      return true
    }

    // Create identity mapping [0, 1, 2, ..., rowCount-1]
    // This naturally keeps data rows (0..dataRowCount-1) before buffer rows
    const defaultOrder = Array.from({ length: currentDataset.rowCount }, (_, i) => i)

    const savedState = nextViewKey ? getViewStateCache<ViewState>(nextViewKey) : undefined
    const canRestoreState =
      savedState &&
      savedState.datasetId === currentDataset.id &&
      savedState.schemaKey === nextSchemaKey
    if (canRestoreState) {
      const columnIdSet = new Set(currentDataset.columns.map((col) => col.id))
      const restoredSortColumn = savedState.sortColumn && columnIdSet.has(savedState.sortColumn)
        ? savedState.sortColumn
        : null
      const restoredGroupByColumn = savedState.groupByColumnId && columnIdSet.has(savedState.groupByColumnId)
        ? savedState.groupByColumnId
        : null
      const collapsedGroupKeys = restoredGroupByColumn ? savedState.collapsedGroupKeys : []

      baseSortedOrderRef.current = defaultOrder

      // Set a sensible initial order immediately; sort/group effects will refine this if needed.
      setRowOrder(defaultOrder)
      setGroupMeta([])
      setSortColumn(null)
      setSortDirection(null)
      setGroupByColumnId(restoredGroupByColumn)

      // Always create a new Set to ensure downstream effects run even if contents are unchanged.
      setCollapsedGroups(new Set(collapsedGroupKeys))

      if (restoredSortColumn) {
        pendingRestoreSortRef.current = {
          columnId: restoredSortColumn,
          direction: savedState.sortDirection ?? 'asc',
          skipConfirm: true,
        }
      }
    } else {
      setRowOrder(defaultOrder)
      baseSortedOrderRef.current = defaultOrder
      setGroupByColumnId(null)
      setCollapsedGroups(new Set())
      setGroupMeta([])
      setSortColumn(null)
      setSortDirection(null)
    }

    const emptySelection = buildEmptySelection()
    const selectionCandidate =
      canRestoreState ? savedState?.gridSelection ?? emptySelection : emptySelection
    const selectionToApply = isSelectionValid(selectionCandidate) ? selectionCandidate : emptySelection
    setGridSelection(selectionToApply)
    syncSelectionToStore(selectionToApply, currentDataset)

    const activeCellCandidate = canRestoreState ? savedState?.activeCell ?? null : null
    setActiveCell(isActiveCellValid(activeCellCandidate) ? activeCellCandidate : null)

    const restoredScroll = canRestoreState ? savedState?.scroll ?? null : null
    if (restoredScroll) {
      requestScrollRestore(clampScrollTarget(restoredScroll, currentDataset))
    } else if (structuralChanged || viewChanged) {
      requestScrollRestore({ x: 0, y: 0 })
    }

    // Trigger initial load for first visible rows
    // onVisibleRegionChanged will load more as user scrolls
    // Note: ensureRangeLoaded is not available yet in this effect,
    // so we rely on onVisibleRegionChanged to trigger the initial load
  }, [resolvedStateKey, currentSchemaKey, clampScrollTarget, requestScrollRestore]) // Depend on view + dataset schema changes


  // NOTE: Previous dataCache loading effect REMOVED (Phase 3 - Streaming Row Provider)
  // Data is now loaded on-demand via:
  // 1. onVisibleRegionChanged → ensureRangeLoaded (main path)
  // 2. getCellContent → ensureRangeLoaded (fallback for individual cells)
  // This enables handling millions of rows without materializing full JS array

  useEffect(() => {
    if (!contextMenu.isOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu()
      }
    }

    const handleClick = () => closeContextMenu()

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('click', handleClick)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('click', handleClick)
    }
  }, [contextMenu.isOpen, closeContextMenu])

  useEffect(() => {
    if (!insertMenu.isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeInsertMenu()
      }
    }

    const handleClick = () => {
      if (ignoreNextInsertMenuWindowClickRef.current) {
        ignoreNextInsertMenuWindowClickRef.current = false
        return
      }
      closeInsertMenu()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('click', handleClick)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('click', handleClick)
    }
  }, [insertMenu.isOpen, closeInsertMenu])

  // Build lookup map for dataset column metadata (id -> metadata)
  const columnMetadataMap = useMemo(() => {
    const map = new Map<string, ColumnMetadata>()
    currentDataset?.columns.forEach(col => {
      map.set(col.id, col)
    })
    return map
  }, [currentDataset?.columns])

  // Precompute row key fallbacks (id -> possible row keys) for datasets that
  // return rows keyed by display names instead of col-{idx} IDs.
  const columnRowKeyFallbacks = useMemo(() => {
    const map = new Map<string, string[]>()
    currentDataset?.columns.forEach((col) => {
      const keys = new Set<string>()
      keys.add(col.id)
      if (col.name && col.name !== col.id) {
        keys.add(col.name)
      }
      const idLower = col.id.toLowerCase()
      if (idLower !== col.id) keys.add(idLower)
      if (col.name) {
        const nameLower = col.name.toLowerCase()
        if (nameLower !== col.name) keys.add(nameLower)
      }
      map.set(col.id, Array.from(keys))
    })
    return map
  }, [currentDataset?.columns])

  // Create memoized FormulaService for formula evaluation (Phase 7)
  // Provides Excel-like formula support with dependency tracking
  // CRITICAL: Only recreate when dataset ID changes, not when dataset object changes
  // (otherwise formulas are lost on every edit due to immutable updates)
  const formulaService = useMemo(() => {
    if (!currentDataset) return null

    return createFormulaService(
      () => rowDataRef.current,
      currentDataset.columns,
      () => rowOrderRef.current // Pass rowOrder for view-aware formula evaluation
    )
  }, [currentDataset?.id, currentSchemaKey])

  // Load formulas from persistence layer on dataset change (Phase 7)
  useEffect(() => {
    if (!currentDataset || !formulaService) return

    const { getDatasetFormulas } = useDataStore.getState()
    const persistedFormulas = getDatasetFormulas(currentDataset.id)

    if (persistedFormulas.size === 0) return

    // Load formulas into FormulaService and get initial computed values
    const formulaEdits = formulaService.setFormulas(persistedFormulas)

    // Apply computed values to rowData
    if (formulaEdits.length > 0) {
      updateRowDataRef(prev => {
        const newData = new Map(prev)
        for (const edit of formulaEdits) {
          const row = newData.get(edit.row) || {}
          newData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
        }
        return newData
      })
    }
    // IMPORTANT: Do NOT re-run this effect on every dataset object change (modifiedAt/dataRowCount/etc.).
    // Rehydrating formulas repeatedly will overwrite in-memory edits (e.g., editing a formula in-place).
  }, [currentDataset?.id, formulaService, updateRowDataRef])

  // ============ Async Aggregate Formula Support (Phase 5.2) ============
  // Track pending async aggregate requests for cancellation
  const pendingAggregateRequestsRef = useRef<Map<string, AbortController>>(new Map())
  // Track pending backend eval requests for cancellation
  const pendingBackendEvalRequestsRef = useRef<Map<string, AbortController>>(new Map())
  const pendingAggregateRequestDatasetsRef = useRef<Map<string, string>>(new Map())
  const pendingBackendEvalRequestDatasetsRef = useRef<Map<string, string>>(new Map())
  // Column index lookup ref (avoid TDZ when callbacks are declared before memo init)
  const columnIndexByIdRef = useRef<Map<string, number>>(new Map())

  const scheduleCellUpdates = useCallback(
    (updates: Array<{ cell: readonly [number, number] }>) => {
      if (updates.length === 0) return

      if (updates.length <= MAX_CELLS_PER_UPDATE) {
        dataEditorRef.current?.updateCells(updates)
        return
      }

      let index = 0
      const flushChunk = () => {
        if (!dataEditorRef.current) return
        const chunk = updates.slice(index, index + MAX_CELLS_PER_UPDATE)
        dataEditorRef.current.updateCells(chunk)
        index += MAX_CELLS_PER_UPDATE
        if (index < updates.length) {
          requestAnimationFrame(flushChunk)
        }
      }

      requestAnimationFrame(flushChunk)
    },
    [MAX_CELLS_PER_UPDATE]
  )

  useEffect(() => {
    scheduleCellUpdatesRef.current = scheduleCellUpdates
    cellRefreshReadyRef.current = true

    const pending = pendingCellRefreshBatchesRef.current
    if (pending.length > 0) {
      pendingCellRefreshBatchesRef.current = []
      for (const batch of pending) {
        scheduleCellUpdates(batch)
      }
    }

    return () => {
      cellRefreshReadyRef.current = false
      scheduleCellUpdatesRef.current = () => {}
      pendingCellRefreshBatchesRef.current = []
    }
  }, [scheduleCellUpdates])

  // Volatile formulas are recalculated on explicit spreadsheet recalc events
  // (edits, paste/fill via EditExecutor, and F9), not on a background timer.

  // Handle async aggregate result injection
  const handleAsyncAggregateResult = useCallback((
    cellKey: string,
    value: number,
    requestId: string
  ) => {
    if (!formulaService || !currentDataset) return

    const requestDatasetId = pendingAggregateRequestDatasetsRef.current.get(requestId)
    if (!requestDatasetId || requestDatasetId !== currentDatasetIdRef.current) {
      if (import.meta.env.DEV) {
        console.warn('[AsyncAggregate] Ignoring result for stale dataset:', cellKey)
      }
      return
    }

    // Parse cellKey to get row/column
    const [rowStr, columnId] = cellKey.split(':')
    const row = parseInt(rowStr!, 10)
    if (!columnId || Number.isNaN(row)) return

    // Guard against stale dataset: Verify the formula still exists in the current FormulaService
    // This prevents updates from completing after a family switch (Statistics → RNA-seq → Statistics)
    if (!formulaService.hasFormula(cellKey)) {
      if (import.meta.env.DEV) {
        console.warn('[AsyncAggregate] Ignoring result for formula no longer in FormulaService:', cellKey)
      }
      return
    }

    const updates: Array<{ row: number; columnId: string; value: unknown }> = [
      { row, columnId, value },
    ]
    const affectedColumnIds = new Set<string>([columnId])

    // Update rowDataRef immediately so formula recalculation sees new value
    const updated = new Map(rowDataRef.current)
    const rowRecord = { ...(updated.get(row) || {}) }
    rowRecord[columnId] = value
    updated.set(row, rowRecord)
    rowDataRef.current = updated
    markSelectionStatsDirty()

    // Recalculate dependents (existing sync machinery)
    const dependentEdits = formulaService.recalculateDependents(cellKey)
    if (dependentEdits.length > 0) {
      for (const edit of dependentEdits) {
        const depRecord = { ...(updated.get(edit.row) || {}) }
        depRecord[edit.columnId] = edit.computedValue
        updated.set(edit.row, depRecord)
        updates.push({ row: edit.row, columnId: edit.columnId, value: edit.computedValue })
        affectedColumnIds.add(edit.columnId)
      }
    }

    rowDataRef.current = updated
    markSelectionStatsDirty()

    // Sync computed values to dataCache + backend
    for (const update of updates) {
      updateCellValue(currentDataset.id, update.row, update.columnId, update.value)
      cacheService.queueCellUpdate(currentDataset.id, update.row, update.columnId, update.value)
    }

    // Invalidate affected columns so analysis/typing stays accurate
    if (affectedColumnIds.size > 0) {
      invalidateColumns(Array.from(affectedColumnIds))
    }

    // Force grid repaint for the primary cell
    const colIndex = columnIndexByIdRef.current.get(columnId)
    if (colIndex !== undefined) {
      scheduleCellUpdates([{ cell: [colIndex, modelToView(row)] }])
    }
  }, [formulaService, currentDataset, modelToView, updateCellValue, invalidateColumns, scheduleCellUpdates])

  // Handle backend eval result injection
  const handleBackendEvalResult = useCallback((
    cellKey: string,
    value: unknown,
    requestId: string
  ) => {
    if (!formulaService || !currentDataset) {
      console.warn('[SpreadsheetView] Cannot inject result - no formulaService or currentDataset')
      return
    }

    const requestDatasetId = pendingBackendEvalRequestDatasetsRef.current.get(requestId)
    if (!requestDatasetId || requestDatasetId !== currentDatasetIdRef.current) {
      if (import.meta.env.DEV) {
        console.warn('[BackendEval] Ignoring result for stale dataset:', cellKey)
      }
      return
    }

    const [rowStr, columnId] = cellKey.split(':')
    const row = parseInt(rowStr!, 10)
    if (!columnId || Number.isNaN(row)) {
      console.error('[SpreadsheetView] Invalid cellKey:', cellKey)
      return
    }

    // Guard against stale dataset: Verify the formula still exists in the current FormulaService
    // This prevents updates from completing after a family switch (Statistics → RNA-seq → Statistics)
    if (!formulaService.hasFormula(cellKey)) {
      if (import.meta.env.DEV) {
        console.warn('[BackendEval] Ignoring result for formula no longer in FormulaService:', cellKey)
      }
      return
    }

    const to2DArray = (v: unknown): unknown[][] => {
      if (!Array.isArray(v)) return [[v]]
      // If top-level rows are arrays, treat as 2D; otherwise treat as single row.
      const rows = v as unknown[]
      if (rows.some(item => Array.isArray(item))) {
        return rows.map(rowVal => (Array.isArray(rowVal) ? rowVal : [rowVal]))
      }
      return [rows]
    }

    const array2D = to2DArray(value)
    const anchorColIndex = columnIndexByIdRef.current.get(columnId) ?? -1
    const columnsCurrent = columnsRef.current

    const updates: Array<{ row: number; columnId: string; value: unknown }> = []
    const affectedColumnIds = new Set<string>()

    for (let r = 0; r < array2D.length; r += 1) {
      const targetRow = row + r
      const rowValues = array2D[r] ?? []

      for (let c = 0; c < rowValues.length; c += 1) {
        const targetColIndex = anchorColIndex + c
        if (targetColIndex < 0 || targetColIndex >= columnsCurrent.length) continue

        const targetColumnId = columnsCurrent[targetColIndex]?.id
        if (!targetColumnId) continue

        const cellValue = rowValues[c]
        updates.push({ row: targetRow, columnId: targetColumnId, value: cellValue })
        affectedColumnIds.add(targetColumnId)
      }
    }

    if (updates.length === 0) {
      console.warn('[SpreadsheetView] No spill updates generated for backend result:', cellKey)
      return
    }
    const updated = new Map(rowDataRef.current)

    for (const update of updates) {
      const rowRecord = { ...(updated.get(update.row) || {}) }
      rowRecord[update.columnId] = update.value
      updated.set(update.row, rowRecord)
    }
    rowDataRef.current = updated
    markSelectionStatsDirty()

    const dependentEdits = formulaService.recalculateDependents(cellKey)
    if (dependentEdits.length > 0) {
      for (const edit of dependentEdits) {
        const depRecord = { ...(updated.get(edit.row) || {}) }
        depRecord[edit.columnId] = edit.computedValue
        updated.set(edit.row, depRecord)
        updates.push({ row: edit.row, columnId: edit.columnId, value: edit.computedValue })
        affectedColumnIds.add(edit.columnId)
      }
    }

    rowDataRef.current = updated
    markSelectionStatsDirty()

    for (const update of updates) {
      updateCellValue(currentDataset.id, update.row, update.columnId, update.value)
      cacheService.queueCellUpdate(currentDataset.id, update.row, update.columnId, update.value)
    }

    if (affectedColumnIds.size > 0) {
      invalidateColumns(Array.from(affectedColumnIds))
    }

    const cellUpdates: Array<{ cell: readonly [number, number] }> = []
    const seenCells = new Set<string>()
    for (const update of updates) {
      const colIndex = columnIndexByIdRef.current.get(update.columnId)
      if (colIndex === undefined) continue
      const viewRow = modelToView(update.row)
      const key = `${colIndex}:${viewRow}`
      if (seenCells.has(key)) continue
      seenCells.add(key)
      cellUpdates.push({ cell: [colIndex, viewRow] as const })
    }

    if (cellUpdates.length > 0) {
      scheduleCellUpdates(cellUpdates)
    } else {
      console.warn('[SpreadsheetView] Columns not found for result injection:', updates.map(u => u.columnId))
    }
  }, [formulaService, currentDataset, modelToView, updateCellValue, invalidateColumns, scheduleCellUpdates])

  const buildLazyRowOrderSlice = useCallback(
    async (startView: number, endView: number): Promise<number[] | null> => {
      if (!currentDataset || !isLazyGrouped || lazyGroupMeta.length === 0) return null
      if (!groupByColumnId) return null

      const normalizedStart = Math.max(0, startView)
      const normalizedEnd = Math.max(normalizedStart, endView)

      const viewRowCount = lazyGroupMeta.reduce((total, g) => {
        const isCollapsed = collapsedGroupsRef.current.has(g.key)
        return total + (isCollapsed ? 1 : g.size)
      }, 0)

      if (normalizedStart >= viewRowCount) return null

      const cappedEnd = Math.min(normalizedEnd, Math.max(0, viewRowCount - 1))
      const sliceLength = cappedEnd - normalizedStart + 1
      const result = new Array<number>(sliceLength)

      const capturedDatasetId = currentDataset.id
      const loadRevision = datasetRevisionRef.current
      const isStale = () =>
        datasetRevisionRef.current !== loadRevision || currentDatasetIdRef.current !== capturedDatasetId

      const fillFromCache = (viewRow: number): boolean => {
        const cached = lazyRowCacheRef.current.get(viewRow)
        if (cached !== undefined) {
          result[viewRow - normalizedStart] = cached
          return true
        }
        return false
      }

      const findGroupAtViewRow = (viewRow: number): number => {
        let low = 0
        let high = lazyGroupMeta.length - 1
        while (low < high) {
          const mid = Math.floor((low + high + 1) / 2)
          const midGroup = lazyGroupMeta[mid]
          if (midGroup && midGroup.startViewRow <= viewRow) {
            low = mid
          } else {
            high = mid - 1
          }
        }
        return low
      }

      const firstGroupIdx = findGroupAtViewRow(normalizedStart)
      const lastGroupIdx = findGroupAtViewRow(cappedEnd)
      const pending: Array<Promise<void>> = []

      for (let gIdx = firstGroupIdx; gIdx <= lastGroupIdx; gIdx++) {
        const group = lazyGroupMeta[gIdx]
        if (!group) continue

        const isCollapsed = collapsedGroupsRef.current.has(group.key)
        const groupViewSize = isCollapsed ? 1 : group.size
        const groupStartView = group.startViewRow
        const groupEndView = groupStartView + groupViewSize - 1

        const viewStart = Math.max(normalizedStart, groupStartView)
        const viewEnd = Math.min(cappedEnd, groupEndView)
        if (viewStart > viewEnd) continue

        if (isCollapsed) {
          const viewRow = groupStartView
          const modelRow = group.firstRowIndex
          lazyRowCacheRef.current.set(viewRow, modelRow)
          result[viewRow - normalizedStart] = modelRow
          continue
        }

        let needsFetch = false
        for (let viewRow = viewStart; viewRow <= viewEnd; viewRow++) {
          if (!fillFromCache(viewRow)) {
            needsFetch = true
            break
          }
        }

        if (!needsFetch) continue

        const offsetStart = viewStart - groupStartView
        const offsetEnd = viewEnd - groupStartView
        const limit = offsetEnd - offsetStart + 1

        pending.push((async () => {
          const rowIndices = await cacheService.getGroupRows(
            capturedDatasetId,
            groupByColumnId,
            group.key,
            sortColumn ?? null,
            sortDirection === 'desc',
            offsetStart,
            limit
          )

          if (isStale()) return

          for (let i = 0; i < rowIndices.length; i++) {
            const viewRow = groupStartView + offsetStart + i
            const modelRow = Number(rowIndices[i])
            if (!Number.isFinite(modelRow)) continue
            lazyRowCacheRef.current.set(viewRow, modelRow)
            if (viewRow >= normalizedStart && viewRow <= cappedEnd) {
              result[viewRow - normalizedStart] = modelRow
            }
          }
        })())
      }

      if (pending.length > 0) {
        await Promise.all(pending)
      }

      if (isStale()) return null

      for (let i = 0; i < result.length; i++) {
        if (typeof result[i] !== 'number' || Number.isNaN(result[i])) {
          return null
        }
      }

      return result
    },
    [
      currentDataset,
      isLazyGrouped,
      lazyGroupMeta,
      groupByColumnId,
      sortColumn,
      sortDirection,
    ]
  )

  // Enqueue async aggregate request
  const enqueueAggregate = useCallback(async (request: AsyncAggregateRequest) => {
    if (!currentDataset) return
    const AGGREGATE_TIMEOUT_MS = 60000

    // Cancel any existing request for this cell
    const existing = pendingAggregateRequestsRef.current.get(request.cellKey)
    if (existing) existing.abort()

    const controller = new AbortController()
    pendingAggregateRequestsRef.current.set(request.cellKey, controller)
    pendingAggregateRequestDatasetsRef.current.set(request.requestId, currentDataset.id)

    try {
      // Backend will flush overlay before computing
      const aggregateFunc =
        request.func as 'SUM' | 'AVG' | 'COUNT' | 'COUNTA' | 'STDEV' | 'STDEV_P' | 'VAR' | 'VAR_P' | 'MIN' | 'MAX'

      let rowIndices = request.rowIndices
      if (
        (!rowIndices || rowIndices.length === 0) &&
        request.viewRowBounds &&
        isLazyGrouped
      ) {
        const slice = await buildLazyRowOrderSlice(
          request.viewRowBounds.start,
          request.viewRowBounds.end
        )
        if (!slice || slice.length === 0) {
          throw new Error('Unable to resolve row order for grouped aggregate.')
        }
        rowIndices = slice
      }

      const aggregatePromise =
        Array.isArray(rowIndices) && rowIndices.length > 0
          ? cacheService.getColumnAggregateRows(
              currentDataset.id,
              request.columnId,
              aggregateFunc,
              rowIndices
            )
          : typeof request.startRow === 'number' && typeof request.endRow === 'number'
            ? cacheService.getColumnAggregateRange(
                currentDataset.id,
                request.columnId,
                aggregateFunc,
                request.startRow,
                request.endRow
              )
            : cacheService.getColumnAggregate(
                currentDataset.id,
                request.columnId,
                aggregateFunc
              )

      const result = await new Promise<number>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`Aggregate timed out after ${Math.round(AGGREGATE_TIMEOUT_MS / 1000)}s`))
        }, AGGREGATE_TIMEOUT_MS)

        aggregatePromise
          .then(resolve)
          .catch(reject)
          .finally(() => clearTimeout(timeoutId))
      })

      if (!controller.signal.aborted) {
        formulaService?.injectAsyncAggregateResult(
          request.cellKey,
          result,
          request.requestId
        )
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[AsyncAggregate] Failed:', error)
        if (error instanceof Error && error.message.includes('Aggregate timed out')) {
          toast.error('Aggregate timed out. Try a smaller range or use a full-column formula (e.g., SUM(I:I)).')
        }
        // Clear pending state so stale results are ignored
        formulaService?.clearPendingAggregate(request.cellKey, request.requestId)

        const requestDatasetId = pendingAggregateRequestDatasetsRef.current.get(request.requestId)
        if (!requestDatasetId || requestDatasetId !== currentDatasetIdRef.current) {
          if (import.meta.env.DEV) {
            console.warn('[AsyncAggregate] Skipping error update for stale dataset:', request.cellKey)
          }
          return
        }

        // Guard against stale dataset: Verify formula still exists
        if (!formulaService?.hasFormula(request.cellKey)) {
          if (import.meta.env.DEV) {
            console.warn('[AsyncAggregate] Skipping error update - formula no longer exists:', request.cellKey)
          }
          return
        }

        // Update cell with error - replace sentinel with error message
        const [rowStr, columnId] = request.cellKey.split(':')
        const row = parseInt(rowStr!, 10)
        if (!columnId || Number.isNaN(row)) return

        const errorMessage = error instanceof Error ? error.message : String(error)
        const isRangeTooLarge = /range too large|max_backend_range_cells/i.test(errorMessage)
        const errorValue = isRangeTooLarge ? '#VALUE!' : '#ERROR!'

        const updates: Array<{ row: number; columnId: string; value: unknown }> = [
          { row, columnId, value: errorValue },
        ]
        const affectedColumnIds = new Set<string>([columnId])

        const updated = new Map(rowDataRef.current)
        const rowRecord = { ...(updated.get(row) || {}) }
        rowRecord[columnId] = errorValue
        updated.set(row, rowRecord)
        rowDataRef.current = updated
        markSelectionStatsDirty()

        const dependentEdits = formulaService?.recalculateDependents(request.cellKey) ?? []
        if (dependentEdits.length > 0) {
          for (const edit of dependentEdits) {
            const depRecord = { ...(updated.get(edit.row) || {}) }
            depRecord[edit.columnId] = edit.computedValue
            updated.set(edit.row, depRecord)
            updates.push({ row: edit.row, columnId: edit.columnId, value: edit.computedValue })
            affectedColumnIds.add(edit.columnId)
          }
        }

        rowDataRef.current = updated
        markSelectionStatsDirty()

        for (const update of updates) {
          updateCellValue(currentDataset.id, update.row, update.columnId, update.value)
          cacheService.queueCellUpdate(currentDataset.id, update.row, update.columnId, update.value)
        }

        if (affectedColumnIds.size > 0) {
          invalidateColumns(Array.from(affectedColumnIds))
        }

        const cellUpdates: Array<{ cell: readonly [number, number] }> = []
        const seenCells = new Set<string>()
        for (const update of updates) {
          const colIndex = columnIndexByIdRef.current.get(update.columnId)
          if (colIndex === undefined) continue
          const viewRow = modelToView(update.row)
          const key = `${colIndex}:${viewRow}`
          if (seenCells.has(key)) continue
          seenCells.add(key)
          cellUpdates.push({ cell: [colIndex, viewRow] as const })
        }

        if (cellUpdates.length > 0) {
          scheduleCellUpdates(cellUpdates)
        }
    }
  } finally {
    pendingAggregateRequestsRef.current.delete(request.cellKey)
    pendingAggregateRequestDatasetsRef.current.delete(request.requestId)
  }
  }, [
    currentDataset,
    updateRowDataRef,
    updateCellValue,
    invalidateColumns,
    formulaService,
    modelToView,
    scheduleCellUpdates,
    isLazyGrouped,
    buildLazyRowOrderSlice,
  ])

  // Enqueue backend formula evaluation request
  const enqueueBackendEval = useCallback(async (request: BackendEvalRequest) => {
    if (!currentDataset) {
      console.warn('[enqueueBackendEval] No currentDataset - aborting')
      return
    }

    const existing = pendingBackendEvalRequestsRef.current.get(request.cellKey)
    if (existing) {
      existing.abort()
    }

    const controller = new AbortController()
    pendingBackendEvalRequestsRef.current.set(request.cellKey, controller)
    pendingBackendEvalRequestDatasetsRef.current.set(request.requestId, currentDataset.id)

    try {
      const storageInfo = storageInfoRef.current.get(currentDataset.id)
      if (!storageInfo?.duckdbPath) {
        const columns = currentDataset.columns.map(col => ({
          id: col.id,
          name: col.name,
        }))
        const updatedInfo = await cacheService.ensureDuckDbDataset(currentDataset.id, columns)
        storageInfoRef.current.set(currentDataset.id, updatedInfo)
      }

      let rowOrderSlice = request.rowOrderSlice
      if (!rowOrderSlice && request.rowBounds && isLazyGrouped) {
        const slice = await buildLazyRowOrderSlice(request.rowBounds.start, request.rowBounds.end)
        if (!slice || slice.length === 0) {
          throw new Error('Unable to resolve row order for grouped formula.')
        }
        rowOrderSlice = { start: request.rowBounds.start, data: slice }
      }

      const result = await cacheService.evaluateFormulaBackend(
        currentDataset.id,
        request.formula,
        request.position,
        Object.keys(request.columnLetterToIdMap).length > 0
          ? request.columnLetterToIdMap
          : currentDataset.columns.reduce<Record<string, string>>((acc, col, index) => {
              acc[columnIndexToLetter(index)] = col.id
              return acc
            }, {}),
        rowOrderSlice,
        currentDataset.rowCount
      )

      if (!controller.signal.aborted) {
        formulaService?.injectBackendEvalResult(
          request.cellKey,
          result,
          request.requestId
        )
      } else {
        console.warn('[enqueueBackendEval] Request was aborted, not injecting result:', request.cellKey)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[BackendEval] Failed:', error)
        formulaService?.clearPendingBackendEval(request.cellKey, request.requestId)

        const requestDatasetId = pendingBackendEvalRequestDatasetsRef.current.get(request.requestId)
        if (!requestDatasetId || requestDatasetId !== currentDatasetIdRef.current) {
          if (import.meta.env.DEV) {
            console.warn('[BackendEval] Skipping error update for stale dataset:', request.cellKey)
          }
          return
        }

        // Guard against stale dataset: Verify formula still exists
        if (!formulaService?.hasFormula(request.cellKey)) {
          if (import.meta.env.DEV) {
            console.warn('[BackendEval] Skipping error update - formula no longer exists:', request.cellKey)
          }
          return
        }

        const [rowStr, columnId] = request.cellKey.split(':')
        const row = parseInt(rowStr!, 10)
        if (!columnId || Number.isNaN(row)) return

        const updates: Array<{ row: number; columnId: string; value: unknown }> = [
          { row, columnId, value: '#ERROR!' },
        ]
        const affectedColumnIds = new Set<string>([columnId])

        const updated = new Map(rowDataRef.current)
        const rowRecord = { ...(updated.get(row) || {}) }
        rowRecord[columnId] = '#ERROR!'
        updated.set(row, rowRecord)
        rowDataRef.current = updated
        markSelectionStatsDirty()

        const dependentEdits = formulaService?.recalculateDependents(request.cellKey) ?? []
        if (dependentEdits.length > 0) {
          for (const edit of dependentEdits) {
            const depRecord = { ...(updated.get(edit.row) || {}) }
            depRecord[edit.columnId] = edit.computedValue
            updated.set(edit.row, depRecord)
            updates.push({ row: edit.row, columnId: edit.columnId, value: edit.computedValue })
            affectedColumnIds.add(edit.columnId)
          }
        }

        rowDataRef.current = updated
        markSelectionStatsDirty()

        for (const update of updates) {
          updateCellValue(currentDataset.id, update.row, update.columnId, update.value)
          cacheService.queueCellUpdate(currentDataset.id, update.row, update.columnId, update.value)
        }

        if (affectedColumnIds.size > 0) {
          invalidateColumns(Array.from(affectedColumnIds))
        }

        const colIndex = columnIndexByIdRef.current.get(columnId)
        if (colIndex !== undefined) {
          scheduleCellUpdates([{ cell: [colIndex, modelToView(row)] }])
        }
    }
  } finally {
    pendingBackendEvalRequestsRef.current.delete(request.cellKey)
    pendingBackendEvalRequestDatasetsRef.current.delete(request.requestId)
  }
  }, [
    currentDataset,
    updateCellValue,
    invalidateColumns,
    formulaService,
    modelToView,
    scheduleCellUpdates,
    isLazyGrouped,
    buildLazyRowOrderSlice,
  ])

  // Set up async aggregate context on formulaService
  useEffect(() => {
    if (!formulaService || !currentDataset) return

    const setupContext = async () => {
      const storageInfo = await getStorageInfo(currentDataset.id)

      formulaService.setAsyncAggregateContext({
        isLargeDataset: storageInfo?.isLarge ?? false,
        isSorted: sortColumn !== null,
        isGrouped: groupByColumnId !== null,
        supportsViewRowBounds: isLazyGrouped && lazyGroupMeta.length > 0,
        getRowData: () => rowDataRef.current,
        enqueueAggregate,
      })
    }

    setupContext()

    formulaService.setAsyncAggregateCallback(handleAsyncAggregateResult)

    return () => {
      formulaService.setAsyncAggregateContext(undefined)
      formulaService.setAsyncAggregateCallback(undefined)
      // Cancel any pending requests on unmount
      for (const controller of pendingAggregateRequestsRef.current.values()) {
        controller.abort()
      }
      pendingAggregateRequestsRef.current.clear()
    }
  }, [
    formulaService,
    currentDataset?.id,
    sortColumn,
    groupByColumnId,
    enqueueAggregate,
    handleAsyncAggregateResult,
    getStorageInfo,
    isLazyGrouped,
    lazyGroupMeta.length,
  ])

  const updateBackendEvalContext = useCallback((loadedRowRange?: { start: number; end: number }) => {
    if (!formulaService || !currentDataset) return

    const storageInfo = storageInfoRef.current.get(currentDataset.id)
    if (!storageInfo) return

    const columnLookup = {
      indexToId: (index: number) => currentDataset.columns[index]?.id ?? `col-${index}`,
      idToIndex: (columnId: string) => columnIndexByIdRef.current.get(columnId) ?? -1,
    }

    const range = loadedRowRange ?? (() => {
      const visible = visibleRegionRef.current
      const buffer = BLOCK_SIZE
      const start = Math.max(0, visible.y - buffer)
      let viewRowCount = rowOrder.length
      if (isLazyGroupedRef.current && lazyGroupMetaRef.current.length > 0) {
        viewRowCount = lazyGroupMetaRef.current.reduce((total, g) => {
          const isCollapsed = collapsedGroupsRef.current.has(g.key)
          return total + (isCollapsed ? 1 : g.size)
        }, 0)
      }
      const end = Math.min(viewRowCount, visible.y + visible.height + buffer)
      return { start, end }
    })()

    const isLazyGroupingActive =
      isLazyGroupedRef.current && lazyGroupMetaRef.current.length > 0 && groupByColumnId !== null

    formulaService.setBackendEvalContext({
      isLargeDataset: storageInfo.isLarge ?? true, // All-DuckDB: defaults to true
      isSorted: sortColumn !== null,
      isGrouped: groupByColumnId !== null,
      totalRows: currentDataset.rowCount,
      loadedRowRange: range,
      columnLookup,
      rowOrder: (sortColumn !== null || groupByColumnId !== null) && !isLazyGroupingActive
        ? rowOrderRef.current
        : null,
      supportsRowOrderSlice: isLazyGroupingActive,
      datasetId: currentDataset.id,
      isRowLoaded: (viewRow: number) => {
        if (viewRow < 0) return false
        if (isLazyGroupingActive) {
          const modelRow = viewToModel(viewRow)
          if (modelRow < 0) return false
          return rowDataRef.current.has(modelRow)
        }
        const rowOrder = rowOrderRef.current
        const modelRow = rowOrder.length > 0 ? (rowOrder[viewRow] ?? viewRow) : viewRow
        return rowDataRef.current.has(modelRow)
      },
      enqueueBackendEval,
    })
  }, [
    formulaService,
    currentDataset,
    sortColumn,
    groupByColumnId,
    enqueueBackendEval,
    rowOrder.length,
    viewToModel,
  ])

  // Set up backend eval context on formulaService
  // Only abort requests when dataset changes, not when sort/group/callbacks change
  const datasetIdRef = useRef<string | undefined>(currentDataset?.id)

  useEffect(() => {
    if (!formulaService || !currentDataset) return

    datasetIdRef.current = currentDataset.id

    const setupContext = async () => {
      const storageInfo = await getStorageInfo(currentDataset.id)
      if (!storageInfo) {
        console.warn('[SpreadsheetView] No storageInfo - backend context NOT set! Formulas will fail.')
        return
      }
      updateBackendEvalContext()
    }

    setupContext()
    formulaService.setBackendEvalCallback(handleBackendEvalResult)

    return () => {
      const currentId = currentDataset.id
      const nextId = datasetIdRef.current
      const willChangeDataset = currentId !== nextId

      formulaService.setBackendEvalContext(undefined)
      formulaService.setBackendEvalCallback(undefined)

      // Only abort pending requests if dataset is actually changing (not just sort/group updates)
      if (willChangeDataset) {
        for (const controller of pendingBackendEvalRequestsRef.current.values()) {
          controller.abort()
        }
        pendingBackendEvalRequestsRef.current.clear()
      } else {
      }
    }
  }, [
    formulaService,
    currentDataset?.id,
    sortColumn,
    groupByColumnId,
    updateBackendEvalContext,
    handleBackendEvalResult,
    getStorageInfo,
  ])

  // Streaming Row Provider: Ensure rows in range are loaded
  // This function loads blocks on demand via hybrid cache (DuckDB for large datasets)
  // IMPORTANT: Fire-and-forget from UI. Never await in render paths.
  const ensureRangeLoaded = useCallback(
    async (startModel: number, endModel: number) => {
      if (!currentDataset) return

      // GUARD 1: Capture datasetId to detect dataset switch during fetch
      const capturedDatasetId = currentDataset.id
      const loadRevision = datasetRevisionRef.current
      const isStale = () =>
        datasetRevisionRef.current !== loadRevision || currentDatasetIdRef.current !== capturedDatasetId
      const rowCount = currentDataset.rowCount
      const storageInfo = await getStorageInfo(capturedDatasetId)
      if (isStale()) return
      const isLargeDataset = storageInfo?.isLarge === true
      const dataRowCount = resolveDataRowCount(currentDataset)
      const effectiveRowCount = isLargeDataset ? dataRowCount : rowCount

      // Clamp to valid range
      const start = Math.max(0, startModel)
      const end = Math.min(effectiveRowCount, endModel)

      if (start >= end) return

      // Calculate which blocks we need
      const firstBlock = Math.floor(start / BLOCK_SIZE)
      const lastBlock = Math.floor((end - 1) / BLOCK_SIZE)

      const blocksToFetch: number[] = []

      for (let block = firstBlock; block <= lastBlock; block++) {
        const blockKey = `${capturedDatasetId}:block:${block}`

        // Mark blocks in this requested range as wanted. This is important for:
        // - initial dataset load (before onVisibleRegionChanged fires)
        // - getCellContent fallback loads (single-cell request)
        wantedBlocksRef.current.add(blockKey)

        // Skip if already loaded or in-flight
        if (loadedBlocksRef.current.has(blockKey)) continue
        if (pendingBlocksRef.current.has(blockKey)) continue

        blocksToFetch.push(block)
        pendingBlocksRef.current.add(blockKey)
      }

      if (blocksToFetch.length === 0) return

      const rowsByIndex = new Map<number, Record<string, unknown>>()
      let shouldDamageViewport = false

      // Fetch blocks in parallel (fire and forget - don't await in caller)
      await Promise.all(
        blocksToFetch.map(async (block) => {
          const blockKey = `${capturedDatasetId}:block:${block}`
          const blockStart = block * BLOCK_SIZE
          const blockEnd = Math.min(blockStart + BLOCK_SIZE, effectiveRowCount)

          try {
            const rows = await cacheService.getRowsHybrid(capturedDatasetId, blockStart, blockEnd)

            // GUARD 2: Verify dataset hasn't changed during fetch
            if (isStale()) {
              // Dataset switched - discard this data
              return
            }

            // If the viewport moved away while this block was loading, skip merging it.
            // This keeps memory bounded and avoids re-render churn during fast scrolls.
            if (!wantedBlocksRef.current.has(blockKey)) {
              return
            }

            // Mark block as loaded
            loadedBlocksRef.current.add(blockKey)

            rows.forEach((row, i) => {
              rowsByIndex.set(blockStart + i, row)
            })
            shouldDamageViewport = true
          } catch (error) {
            console.error(`Failed to load block ${block} for dataset ${capturedDatasetId}:`, error)
            // Block can be retried on next scroll/render
          } finally {
            // GUARD 3: Always clear pending, success or failure
            pendingBlocksRef.current.delete(blockKey)
          }
        })
      )

      if (isStale()) return
      if (rowsByIndex.size === 0) return
      if (isStale()) return

      // OPTIMIZATION: Track which model rows were loaded for targeted damage
      const loadedModelRows = new Set(rowsByIndex.keys())

      updateRowDataRef((prev) => {
        const next = new Map(prev)
        rowsByIndex.forEach((row, index) => {
          next.set(index, row)
        })
        return next
      })

      if (shouldDamageViewport) {
        // Trigger a repaint of only the loaded rows to reduce main-thread work
        scheduleViewportDamageRef.current(loadedModelRows)
      }
    },
    [currentDataset, BLOCK_SIZE, getStorageInfo, resolveDataRowCount, updateRowDataRef]
  )

  const loadBlocks = useCallback(
    async (blocksToFetch: number[], capturedDatasetId: string) => {
      if (!currentDataset || blocksToFetch.length === 0) return
      if (currentDataset.id !== capturedDatasetId) return

      const loadRevision = datasetRevisionRef.current
      const isStale = () =>
        datasetRevisionRef.current !== loadRevision || currentDatasetIdRef.current !== capturedDatasetId

      const storageInfo = await getStorageInfo(capturedDatasetId)
      if (isStale()) return
      const isLargeDataset = storageInfo?.isLarge === true
      const dataRowCount = resolveDataRowCount(currentDataset)
      const effectiveRowCount = isLargeDataset ? dataRowCount : currentDataset.rowCount

      const rowsByIndex = new Map<number, Record<string, unknown>>()
      let shouldDamageViewport = false

      await Promise.all(
        blocksToFetch.map(async (block) => {
          const blockKey = `${capturedDatasetId}:block:${block}`
          const blockStart = block * BLOCK_SIZE
          const blockEnd = Math.min(blockStart + BLOCK_SIZE, effectiveRowCount)

          try {
            const rows = await cacheService.getRowsHybrid(capturedDatasetId, blockStart, blockEnd)

            if (isStale()) {
              return
            }

            if (!wantedBlocksRef.current.has(blockKey)) {
              return
            }

            loadedBlocksRef.current.add(blockKey)

            rows.forEach((row, i) => {
              rowsByIndex.set(blockStart + i, row)
            })
            shouldDamageViewport = true
          } catch (error) {
            console.error(`Failed to load block ${block} for dataset ${capturedDatasetId}:`, error)
          } finally {
            pendingBlocksRef.current.delete(blockKey)
          }
        })
      )

      if (isStale()) return
      if (rowsByIndex.size === 0) return

      const loadedModelRows = new Set(rowsByIndex.keys())

      updateRowDataRef((prev) => {
        const next = new Map(prev)
        rowsByIndex.forEach((row, index) => {
          next.set(index, row)
        })
        return next
      })

      if (shouldDamageViewport) {
        scheduleViewportDamageRef.current(loadedModelRows)
      }
    },
    [currentDataset, BLOCK_SIZE, getStorageInfo, resolveDataRowCount, updateRowDataRef]
  )

  // Lazy grouped row loading: fetch rows per group on demand
  // For 18M rows with 100 groups, this fetches only visible rows
  const ensureLazyGroupedRangeLoaded = useCallback(
    async (startView: number, endView: number) => {
      if (!currentDataset || !isLazyGrouped || lazyGroupMeta.length === 0) return
      if (!groupByColumnId) return

      const capturedDatasetId = currentDataset.id
      const loadRevision = datasetRevisionRef.current
      const isStale = () =>
        datasetRevisionRef.current !== loadRevision || currentDatasetIdRef.current !== capturedDatasetId

      // Find which groups are visible using binary search
      const findGroupAtViewRow = (viewRow: number): number => {
        let low = 0
        let high = lazyGroupMeta.length - 1
        while (low < high) {
          const mid = Math.floor((low + high + 1) / 2)
          const midGroup = lazyGroupMeta[mid]
          if (midGroup && midGroup.startViewRow <= viewRow) {
            low = mid
          } else {
            high = mid - 1
          }
        }
        return low
      }

      const firstGroupIdx = findGroupAtViewRow(startView)
      const lastGroupIdx = findGroupAtViewRow(Math.max(0, endView - 1))

      // Fetch rows for each visible group
      for (let gIdx = firstGroupIdx; gIdx <= lastGroupIdx; gIdx++) {
        const group = lazyGroupMeta[gIdx]
        if (!group) continue

        const isCollapsed = collapsedGroups.has(group.key)

        // Calculate which rows within this group are visible
        const groupVisibleStart = Math.max(0, startView - group.startViewRow)
        const groupVisibleEnd = Math.min(
          isCollapsed ? 1 : group.size,
          endView - group.startViewRow
        )

        if (groupVisibleStart >= groupVisibleEnd) continue

        // For collapsed groups, we only need the header (first row)
        if (isCollapsed) {
          // Just need firstRowIndex - already handled by viewToModel
          continue
        }

        // Fetch rows for this group
        // Skip if already cached
        const cacheKey = `${capturedDatasetId}:lazygroup:${group.key}:${groupVisibleStart}-${groupVisibleEnd}`
        if (loadedBlocksRef.current.has(cacheKey)) continue
        if (pendingBlocksRef.current.has(cacheKey)) continue

        pendingBlocksRef.current.add(cacheKey)

        try {
          const rowIndices = await cacheService.getGroupRows(
            capturedDatasetId,
            groupByColumnId,
            group.key,
            sortColumn ?? null,
            sortDirection === 'desc',
            groupVisibleStart,
            groupVisibleEnd - groupVisibleStart
          )

          if (isStale()) return

          if (rowIndices.length === 0) {
            loadedBlocksRef.current.add(cacheKey)
            continue
          }

          // Update lazy row cache: viewRow -> modelRow
          const modelRows = rowIndices.map(Number)
          for (let i = 0; i < modelRows.length; i++) {
            const viewRow = group.startViewRow + groupVisibleStart + i
            const modelRow = modelRows[i]
            if (modelRow !== undefined) {
              lazyRowCacheRef.current.set(viewRow, modelRow)
            }
          }

          // Fetch only the contiguous ranges we need (avoid huge min/max scans).
          const sortedRows = [...modelRows].sort((a, b) => a - b)
          const ranges: Array<{ start: number; end: number }> = []
          let rangeStart = sortedRows[0]!
          let prev = sortedRows[0]!
          for (let i = 1; i < sortedRows.length; i++) {
            const value = sortedRows[i]!
            if (value === prev + 1) {
              prev = value
              continue
            }
            ranges.push({ start: rangeStart, end: prev })
            rangeStart = value
            prev = value
          }
          ranges.push({ start: rangeStart, end: prev })

          const rowsByIndex = new Map<number, Record<string, unknown>>()
          for (const range of ranges) {
            const rows = await cacheService.getRowsHybrid(
              capturedDatasetId,
              range.start,
              range.end + 1
            )
            if (isStale()) return
            rows.forEach((row, i) => {
              rowsByIndex.set(range.start + i, row)
            })
          }

          if (isStale()) return

          // Merge into rowData
          updateRowDataRef((prev) => {
            const next = new Map(prev)
            rowsByIndex.forEach((row, index) => {
              next.set(index, row)
            })
            return next
          })

          loadedBlocksRef.current.add(cacheKey)
          requestGridRefresh({ reason: 'lazy-group-load-repaint', scope: 'viewport' })
        } catch (error) {
          console.error(`Failed to load lazy group ${group.key}:`, error)
        } finally {
          pendingBlocksRef.current.delete(cacheKey)
        }
      }
    },
    [
      currentDataset,
      isLazyGrouped,
      lazyGroupMeta,
      collapsedGroups,
      groupByColumnId,
      sortColumn,
      sortDirection,
      updateRowDataRef,
      requestGridRefresh,
    ]
  )


  // =============================================================================
  // SCROLL PERFORMANCE OPTIMIZATION (Phase 1 & 2)
  // Debounced visible region work to reduce row fetch churn during fast scroll.
  // =============================================================================

  const debouncedVisibleRegionWork = useMemo(
    () =>
      debounce(
        (range: { x: number; y: number; width: number; height: number }) => {
          // Phase 2: Skip work if vertical range unchanged (horizontal scroll doesn't affect row loading)
          if (
            lastRangeRef.current &&
            range.y === lastRangeRef.current.y &&
            range.height === lastRangeRef.current.height
          ) {
            return
          }
          lastRangeRef.current = { y: range.y, height: range.height }

          if (!currentDataset) return

          const datasetId = currentDataset.id
          const rowCountModel = currentDataset.rowCount

          const startView = range.y
          const endView = range.y + range.height

          // OPTIMIZATION: Dynamic prefetch buffer scales with viewport height
          // Prefetch at least 2x viewport (min 1 block) to eliminate blank cells on tall screens
          const buffer = Math.max(BLOCK_SIZE, range.height * 2)
          const bufferedStart = Math.max(0, startView - buffer)

          // Phase 3: Lazy grouped mode - use separate loader
          // For 18M rows with 100 groups, this fetches only visible rows per group
          if (isLazyGrouped && lazyGroupMeta.length > 0) {
            // Compute view row count for lazy grouped mode
            const lazyViewRowCount = lazyGroupMeta.reduce((total, g) => {
              return total + (collapsedGroups.has(g.key) ? 1 : g.size)
            }, 0)
            const bufferedEndLazy = Math.min(lazyViewRowCount, endView + buffer)

            updateBackendEvalContext({ start: bufferedStart, end: bufferedEndLazy })

            // Fire and forget - fetch rows per group
            void ensureLazyGroupedRangeLoaded(bufferedStart, bufferedEndLazy)
            return
          }

          const currentRowOrder = rowOrderRef.current
          const bufferedEnd = Math.min(currentRowOrder.length, endView + buffer)

          updateBackendEvalContext({ start: bufferedStart, end: bufferedEnd })

          const maxBlockIndex = rowCountModel > 0 ? Math.floor((rowCountModel - 1) / BLOCK_SIZE) : 0

          if (sortColumn === null && groupByColumnId === null) {
            // Identity row order - direct mapping (no scan needed)
            const startModel = Math.max(0, bufferedStart)
            const endModel = Math.min(rowCountModel, bufferedEnd)

            const firstKeepBlock = Math.floor(startModel / BLOCK_SIZE)
            const lastKeepBlock = Math.floor((endModel - 1) / BLOCK_SIZE)
            const keepStart = Math.max(0, firstKeepBlock - CACHE_HALO_BLOCKS)
            const keepEnd = Math.min(maxBlockIndex, lastKeepBlock + CACHE_HALO_BLOCKS)
            const keep = new Set<string>()

            for (let block = keepStart; block <= keepEnd; block++) {
              keep.add(`${datasetId}:block:${block}`)
            }

            wantedBlocksRef.current = keep

            const prefix = `${datasetId}:block:`
            const evict: string[] = []
            for (const key of loadedBlocksRef.current) {
              if (key.startsWith(prefix) && !keep.has(key)) {
                evict.push(key)
              }
            }

            if (evict.length > 0) {
              updateRowDataRef((prev) => {
                const next = new Map(prev)
                for (const key of evict) {
                  const parts = key.split(':')
                  const blockIndex = Number(parts[parts.length - 1])
                  if (!Number.isFinite(blockIndex)) continue
                  const blockStart = blockIndex * BLOCK_SIZE
                  const blockEnd = Math.min(blockStart + BLOCK_SIZE, rowCountModel)
                  for (let r = blockStart; r < blockEnd; r++) {
                    next.delete(r)
                  }
                }
                return next
              })

              for (const key of evict) {
                loadedBlocksRef.current.delete(key)
              }
            }

            void ensureRangeLoaded(startModel, endModel)
            return
          }

          // Sorted/grouped: load only the blocks covering visible model rows.
          const blockIndices = new Set<number>()
          for (let v = bufferedStart; v < bufferedEnd; v++) {
            const modelRow = currentRowOrder[v]
            if (modelRow === undefined) continue
            const blockIndex = Math.floor(modelRow / BLOCK_SIZE)
            for (
              let block = blockIndex - CACHE_HALO_BLOCKS;
              block <= blockIndex + CACHE_HALO_BLOCKS;
              block++
            ) {
              if (block < 0 || block > maxBlockIndex) continue
              blockIndices.add(block)
            }
          }

          if (blockIndices.size === 0) return

          const keep = new Set<string>()
          for (const block of blockIndices) {
            keep.add(`${datasetId}:block:${block}`)
          }
          wantedBlocksRef.current = keep

          const prefix = `${datasetId}:block:`
          const evict: string[] = []
          for (const key of loadedBlocksRef.current) {
            if (key.startsWith(prefix) && !keep.has(key)) {
              evict.push(key)
            }
          }

          if (evict.length > 0) {
            updateRowDataRef((prev) => {
              const next = new Map(prev)
              for (const key of evict) {
                const parts = key.split(':')
                const blockIndex = Number(parts[parts.length - 1])
                if (!Number.isFinite(blockIndex)) continue
                const blockStart = blockIndex * BLOCK_SIZE
                const blockEnd = Math.min(blockStart + BLOCK_SIZE, rowCountModel)
                for (let r = blockStart; r < blockEnd; r++) {
                  next.delete(r)
                }
              }
              return next
            })

            for (const key of evict) {
              loadedBlocksRef.current.delete(key)
            }
          }

          const blocksToFetch: number[] = []
          for (const block of blockIndices) {
            const blockKey = `${datasetId}:block:${block}`
            if (loadedBlocksRef.current.has(blockKey)) continue
            if (pendingBlocksRef.current.has(blockKey)) continue
            pendingBlocksRef.current.add(blockKey)
            blocksToFetch.push(block)
          }

          if (blocksToFetch.length > 0) {
            void loadBlocks(blocksToFetch, datasetId)
          }
        },
        120, // 120ms debounce delay
        { maxWait: 250 } // Ensure update within 250ms during continuous scroll
      ),
    [
      currentDataset,
      BLOCK_SIZE,
      sortColumn,
      groupByColumnId,
      ensureRangeLoaded,
      loadBlocks,
      updateBackendEvalContext,
      isLazyGrouped,
      lazyGroupMeta,
      collapsedGroups,
      ensureLazyGroupedRangeLoaded,
      updateRowDataRef,
    ]
  )

  // Ref to hold the latest debounced function - avoids dependency cycle in effects
  const debouncedVisibleRegionWorkRef = useRef(debouncedVisibleRegionWork)
  useEffect(() => {
    debouncedVisibleRegionWorkRef.current = debouncedVisibleRegionWork
  }, [debouncedVisibleRegionWork])

  // Ensure a visible-region load fires when the dataset switches.
  // This avoids relying on a click to trigger onVisibleRegionChanged.
  useEffect(() => {
    if (!currentDataset) return
    if (rowOrder.length === 0) return
    if (rowDataRef.current.size > 0) return
    const range = visibleRegionRef.current
    const debouncedFn = debouncedVisibleRegionWorkRef.current
    debouncedFn.cancel()
    lastRangeRef.current = null
    debouncedFn(range)
    debouncedFn.flush()
  }, [currentDataset?.id, rowOrder.length])

  // Cleanup debounce on unmount or dependency change
  useEffect(() => {
    return () => {
      debouncedVisibleRegionWork.cancel()
    }
  }, [debouncedVisibleRegionWork])

  // Reset lastRangeRef when dataset changes to ensure fresh load
  useEffect(() => {
    lastRangeRef.current = null
    lastViewportRef.current = null
  }, [currentDataset?.id])

  const processVisibleRegion = useCallback(
    (range: { x: number; y: number; width: number; height: number }) => {
      const lastViewport = lastViewportRef.current
      if (
        lastViewport &&
        lastViewport.x === range.x &&
        lastViewport.y === range.y &&
        lastViewport.width === range.width &&
        lastViewport.height === range.height
      ) {
        return
      }
      lastViewportRef.current = {
        x: range.x,
        y: range.y,
        width: range.width,
        height: range.height,
      }

      // IMMEDIATE: Update viewport in store for virtualization (keeps grid responsive)
      updateViewport({
        visibleRows: [range.y, range.y + range.height],
        visibleColumns: [range.x, range.x + range.width],
      })

      // DEBOUNCED: Heavy work (block loading, eviction, row-order scan)
      // This reduces fetch churn during fast scroll while maxWait ensures data appears
      debouncedVisibleRegionWork(range)
    },
    [debouncedVisibleRegionWork, updateViewport]
  )

  const handleVisibleRegionChanged = useCallback(
    (range: { x: number; y: number; width: number; height: number }) => {
      // Store last visible region for viewport repaint scheduling.
      visibleRegionRef.current = range
      pendingVisibleRegionRef.current = range

      if (visibleRegionRafRef.current !== null) {
        return
      }

      visibleRegionRafRef.current = requestAnimationFrame(() => {
        visibleRegionRafRef.current = null
        const nextRange = pendingVisibleRegionRef.current
        if (!nextRange) return
        pendingVisibleRegionRef.current = null
        processVisibleRegion(nextRange)
      })
    },
    [processVisibleRegion]
  )

  useEffect(() => {
    return () => {
      if (visibleRegionRafRef.current !== null) {
        cancelAnimationFrame(visibleRegionRafRef.current)
      }
    }
  }, [])

  // Create memoized EditExecutor for unified edit pipeline
  // This ensures all edits (type, paste, cut, undo, redo, formulas) go through same path
  const editExecutor = useMemo(() => {
    if (!currentDataset) return null

    return createEditExecutor({
      datasetId: currentDataset.id,
      setRowData: updateRowDataRef,
      updateCellValue,
      invalidateColumns,
      updateActiveFamilyData: trackActiveFamilyData
        ? useAppStore.getState().updateActiveFamilyData
        : undefined,
      formulaService: formulaService ?? undefined,
      columns: currentDataset.columns,
      // Part 2: Paste Recognition - bump dataRowCount when editing beyond current row count
      bumpDataRowCount: (maxRowIndex) => {
        const current = useDataStore.getState().datasets.find((d) => d.id === currentDataset.id)
        const newCount = Math.max(current?.dataRowCount ?? 0, maxRowIndex + 1)
        useDataStore.getState().updateDataset(currentDataset.id, {
          dataRowCount: newCount,
          modifiedAt: new Date(),
        })
      },
      // Part 1: Smart Save - mark project dirty after any edit
      markProjectDirty: () => {
        useAppStore.getState().setProjectDirty(true)
      },
    })
  }, [currentDataset, updateCellValue, invalidateColumns, formulaService])

  const recalculateVolatileFormulas = useCallback(async () => {
    if (!formulaService || !editExecutor) return false

    const formulaEdits = formulaService.recalculateVolatileCells()
    if (formulaEdits.length === 0) return false

    await editExecutor.execute(
      formulaEdits.map((fe) => ({
        row: fe.row,
        columnId: fe.columnId,
        oldValue: null,
        newValue: fe.computedValue,
        computedValue: fe.error ? `#ERROR: ${fe.error.message}` : fe.computedValue,
      })),
      'formula'
    )

    return true
  }, [editExecutor, formulaService])

  // Sync formulas from FormulaService to persistence layer (Phase 7)
  // Call this after each edit to keep data-store mirror in sync
  const syncFormulasToStore = useCallback(() => {
    if (!currentDataset || !formulaService) return

    const allFormulas = formulaService.getAllFormulas()
    const { setDatasetFormulas } = useDataStore.getState()
    setDatasetFormulas(currentDataset.id, allFormulas)
  }, [currentDataset, formulaService])

  const getCellRawValueForUndo = useCallback(
    (rowIndex: number, columnId: string): unknown => {
      const cellKey = `${rowIndex}:${columnId}`
      const rawFormula = formulaService?.getFormula(cellKey)
      if (rawFormula !== undefined) {
        return rawFormula
      }

      const row = rowDataRef.current.get(rowIndex)
      return row?.[columnId] ?? null
    },
    [formulaService]
  )

  // Promote buffer rows to data rows when edited
  // Called when user edits a cell in the buffer zone (row >= dataRowCount)
  const bumpDataRowCount = useCallback(
    (maxEditedRowIndex: number) => {
      if (!currentDataset) return
      const currentDataRowCount = currentDataset.dataRowCount ?? 0
      if (maxEditedRowIndex >= currentDataRowCount) {
        // User edited into buffer - promote rows to real data
        updateDataset(currentDataset.id, {
          dataRowCount: maxEditedRowIndex + 1,
        })
      }
    },
    [currentDataset, updateDataset]
  )

  const applyFormulaEdits = useCallback(
    (formulaEdits: FormulaEdit[]) => {
      if (formulaEdits.length === 0) return

      updateRowDataRef(prev => {
        const next = new Map(prev)
        for (const edit of formulaEdits) {
          const currentRow = next.get(edit.row) ?? {}
          next.set(edit.row, { ...currentRow, [edit.columnId]: edit.computedValue })
        }
        return next
      })
    },
    [updateRowDataRef]
  )

  const resetStreamingStateForStructuralEdit = useCallback(() => {
    loadedBlocksRef.current.clear()
    pendingBlocksRef.current.clear()
    wantedBlocksRef.current.clear()
    pendingBlockLoadsRef.current.clear()
    lazyRowCacheRef.current.clear()
    lastRangeRef.current = null
  }, [])

  const handleInsertColumnAt = useCallback(
    async (requestedIndex: number) => {
      if (!currentDataset) return

      const savedScrollX = visibleRegionRef.current.x
      const savedScrollY = visibleRegionRef.current.y
      const insertAt = Math.max(0, Math.min(requestedIndex, currentDataset.columns.length))
      const newColumnId = `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const newColumnName = allocateNextAutoColumnName(currentDataset.id)
      if (!newColumnName) {
        toast.error('Failed to allocate column name')
        return
      }
      const newColumn: ColumnMetadata = {
        id: newColumnId,
        name: newColumnName,
        type: 'text',
        width: 88,
      }

      let backendApplied = false
      let frontendApplied = false
      let formulaShiftApplied = false

      try {
        await cacheService.addColumn(currentDataset.id, newColumnId, '')
        backendApplied = true
        insertColumnAtDataset(currentDataset.id, insertAt, newColumn)
        frontendApplied = true

        updateRowDataRef(prev => {
          const next = new Map<number, Record<string, unknown>>()
          for (const [rowIndex, rowData] of prev.entries()) {
            next.set(rowIndex, { ...rowData, [newColumnId]: '' })
          }
          return next
        })

        const columnsToInvalidate = new Set<string>([newColumnId])

        if (formulaService) {
          const nextColumnCount = currentDataset.columns.length + 1
          formulaService.setColumnCount(nextColumnCount)
          if (insertAt < currentDataset.columns.length) {
            const formulaEdits = formulaService.shiftReferencesForColumnInsert(insertAt)
            applyFormulaEdits(formulaEdits)
            formulaShiftApplied = true
            for (const edit of formulaEdits) {
              columnsToInvalidate.add(edit.columnId)
            }
          }
          syncFormulasToStore()
        }

        invalidateColumns(Array.from(columnsToInvalidate))

        await undoService.pushColumnInsert(
          currentDataset.id,
          insertAt,
          newColumnId,
          newColumnName
        )

        setActiveCell(prev => {
          if (!prev) return prev
          if (prev.colIndex >= insertAt) {
            return { ...prev, colIndex: prev.colIndex + 1 }
          }
          return prev
        })

        requestScrollRestore({ x: savedScrollX, y: savedScrollY })
        requestGridRefresh({ reason: 'column-insert', scope: 'remount' })
        useAppStore.getState().setProjectDirty(true)
        toast.success('Inserted column successfully')
      } catch (error) {
        if (frontendApplied) {
          try {
            const latestDataset = useDataStore.getState().currentDataset
            const latestIndex =
              latestDataset?.id === currentDataset.id
                ? latestDataset.columns.findIndex(column => column.id === newColumnId)
                : -1
            const rollbackIndex = latestIndex >= 0 ? latestIndex : insertAt
            removeColumnAtDataset(currentDataset.id, rollbackIndex)

            updateRowDataRef(prev => {
              const next = new Map<number, Record<string, unknown>>()
              for (const [rowIndex, rowData] of prev.entries()) {
                const { [newColumnId]: _removed, ...rest } = rowData
                next.set(rowIndex, rest)
              }
              return next
            })

            if (formulaService) {
              formulaService.setColumnCount(currentDataset.columns.length)
              if (formulaShiftApplied) {
                const rollbackEdits = formulaService.shiftReferencesForColumnDelete(insertAt)
                applyFormulaEdits(rollbackEdits)
              }
              syncFormulasToStore()
            }
          } catch (rollbackError) {
            console.error('Failed to rollback frontend column insert state:', rollbackError)
          }
        }

        if (backendApplied) {
          try {
            await cacheService.removeColumn(currentDataset.id, newColumnId)
          } catch (rollbackError) {
            console.error('Failed to rollback backend column insert state:', rollbackError)
          }
        }

        rollbackAutoColumnNameAllocation(currentDataset.id, newColumnName)
        console.error('Failed to insert column:', error)
        toast.error('Failed to insert column')
      }
    },
    [
      currentDataset,
      allocateNextAutoColumnName,
      rollbackAutoColumnNameAllocation,
      insertColumnAtDataset,
      updateRowDataRef,
      formulaService,
      syncFormulasToStore,
      applyFormulaEdits,
      invalidateColumns,
      requestScrollRestore,
      requestGridRefresh,
      removeColumnAtDataset,
    ]
  )

  const handleInsertRowAt = useCallback(
    async (requestedViewRow: number) => {
      if (!currentDataset) return

      if (groupByColumnId !== null || isLazyGrouped) {
        toast.info('Insert row is unavailable while grouped.')
        return
      }

      const viewRowCount = rowOrder.length
      const clampedViewRow = Math.max(0, Math.min(requestedViewRow, viewRowCount))
      const dataRowCount = resolveDataRowCount(currentDataset)
      const rawModelRow =
        clampedViewRow >= viewRowCount
          ? Math.max(0, Math.min(dataRowCount, currentDataset.rowCount))
          : viewToModel(clampedViewRow)

      if (rawModelRow < 0) {
        toast.info('Row is still loading. Try again in a moment.')
        return
      }
      const effectiveInsertModelRow = Math.max(0, Math.min(rawModelRow, dataRowCount))
      const insertedFromBufferRegion = rawModelRow >= dataRowCount

      const savedScrollX = visibleRegionRef.current.x
      const savedScrollY = visibleRegionRef.current.y
      const activeSortColumn = sortColumnRef.current
      const activeSortDirection = sortDirectionRef.current
      const previousRowOrder = [...rowOrder]
      const previousBaseSortedOrder = [...baseSortedOrderRef.current]

      let backendApplied = false
      let frontendApplied = false
      let formulaShiftApplied = false

      try {
        await cacheService.insertRowAt(currentDataset.id, effectiveInsertModelRow)
        backendApplied = true
        insertRowAtDataset(currentDataset.id, effectiveInsertModelRow)
        frontendApplied = true

        if (formulaService) {
          const formulaEdits = formulaService.shiftReferencesForRowInsert(effectiveInsertModelRow)
          applyFormulaEdits(formulaEdits)
          formulaShiftApplied = true
          syncFormulasToStore()
        }

        resetStreamingStateForStructuralEdit()

        updateRowDataRef(prev => {
          const next = new Map<number, Record<string, unknown>>()
          for (const [rowIndex, rowData] of prev.entries()) {
            const shiftedRow = rowIndex >= effectiveInsertModelRow ? rowIndex + 1 : rowIndex
            next.set(shiftedRow, rowData)
          }
          next.set(effectiveInsertModelRow, {})
          return next
        })

        const shiftedOrder = rowOrder.map(row => (row >= effectiveInsertModelRow ? row + 1 : row))
        const insertViewIndex = insertedFromBufferRegion
          ? (() => {
              const firstBufferIndex = shiftedOrder.findIndex(row => row >= dataRowCount + 1)
              return firstBufferIndex === -1 ? shiftedOrder.length : firstBufferIndex
            })()
          : clampedViewRow
        shiftedOrder.splice(insertViewIndex, 0, effectiveInsertModelRow)
        baseSortedOrderRef.current = shiftedOrder
        rowOrderRef.current = shiftedOrder
        setRowOrder(shiftedOrder)

        if (activeSortColumn && activeSortDirection) {
          setPendingInsertSortReplay({
            datasetId: currentDataset.id,
            columnId: activeSortColumn,
            direction: activeSortDirection,
            expectedRowCount: currentDataset.rowCount + 1,
          })
        }

        invalidateColumns(currentDataset.columns.map(column => column.id))

        await undoService.pushRowInsert(currentDataset.id, effectiveInsertModelRow, {})

        setActiveCell(prev => {
          if (!prev) return prev
          if (prev.rowIndex >= insertViewIndex) {
            return { ...prev, rowIndex: prev.rowIndex + 1 }
          }
          return prev
        })

        requestScrollRestore({ x: savedScrollX, y: savedScrollY })
        requestGridRefresh({ reason: 'row-insert', scope: 'remount' })
        useAppStore.getState().setProjectDirty(true)
        toast.success('Inserted row successfully')
        if (insertedFromBufferRegion) {
          toast.info('Buffer rows are virtual; inserted at end of data.')
        }
      } catch (error) {
        if (frontendApplied) {
          try {
            removeRowAtDataset(currentDataset.id, effectiveInsertModelRow)

            updateRowDataRef(prev => {
              const next = new Map<number, Record<string, unknown>>()
              for (const [rowIndex, rowData] of prev.entries()) {
                if (rowIndex === effectiveInsertModelRow) continue
                next.set(rowIndex > effectiveInsertModelRow ? rowIndex - 1 : rowIndex, rowData)
              }
              return next
            })

            if (formulaService && formulaShiftApplied) {
              const rollbackEdits = formulaService.shiftReferencesForRowDelete(
                effectiveInsertModelRow
              )
              applyFormulaEdits(rollbackEdits)
              syncFormulasToStore()
            }

            baseSortedOrderRef.current = previousBaseSortedOrder
            rowOrderRef.current = previousRowOrder
            setRowOrder(previousRowOrder)
            setPendingInsertSortReplay(null)
          } catch (rollbackError) {
            console.error('Failed to rollback frontend row insert state:', rollbackError)
          }
        }

        if (backendApplied) {
          try {
            await cacheService.removeRowAt(currentDataset.id, effectiveInsertModelRow)
          } catch (rollbackError) {
            console.error('Failed to rollback backend row insert state:', rollbackError)
          }
        }

        console.error('Failed to insert row:', error)
        toast.error('Failed to insert row')
      }
    },
    [
      currentDataset,
      groupByColumnId,
      isLazyGrouped,
      rowOrder,
      resolveDataRowCount,
      viewToModel,
      insertRowAtDataset,
      formulaService,
      applyFormulaEdits,
      syncFormulasToStore,
      invalidateColumns,
      updateRowDataRef,
      requestScrollRestore,
      requestGridRefresh,
      resetStreamingStateForStructuralEdit,
      removeRowAtDataset,
    ]
  )

  // Add a new column to the dataset (append to the right edge)
  const handleAddColumn = useCallback(async () => {
    if (!currentDataset) return
    await handleInsertColumnAt(currentDataset.columns.length)
  }, [currentDataset, handleInsertColumnAt])

  // Rebuild rowOrder with grouping applied (Phase 4 - Grouping)
  // Takes a base sorted order and clusters rows by group column
  // IMPORTANT: Must be defined before performSort and clearSort
  // Phase 5 Enhancement: Fetch group column from backend for exact grouping on large datasets
  // Buffer rows (beyond dataRowCount) are excluded from groups and appended at the end
  const rebuildGrouping = useCallback(
    async (baseOrder: number[], groupBy: string | null, collapsed: Set<string>) => {
      if (!currentDataset) return

      if (!groupBy) {
        // No grouping - use base order directly
        // Keep rowOrderRef in sync immediately so viewport loads use the new order.
        rowOrderRef.current = baseOrder
        setRowOrder(baseOrder)
        setGroupMeta([])
        // Clear lazy grouping state
        setIsLazyGrouped(false)
        setLazyGroupMeta([])
        lazyRowCacheRef.current.clear()
        return
      }

      // Ensure backend cache reflects latest edits before grouping fetches data.
      await cacheService.ensureLatestCache(currentDataset.id)

      // Capture dataset ID to guard against stale responses
      const capturedDatasetId = currentDataset.id

      // Separate data rows from buffer rows
      const dataRowCount = resolveDataRowCount(currentDataset)
      const dataRowsInOrder = baseOrder.filter((row) => row < dataRowCount)
      const bufferRowsInOrder = baseOrder.filter((row) => row >= dataRowCount)

      const storageInfo = await getStorageInfo(capturedDatasetId)
      const isLargeDataset = storageInfo?.isLarge === true

      if (isLargeDataset) {
        const groupColumnId = groupBy
        const sortColumnId = sortColumn ?? null

        try {
          // Use lazy group metadata - O(groups) not O(rows)
          // For 18M rows with 100 groups: returns 100 entries, not 18M
          const lazyResult = await cacheService.getLazyGroupMetadata(
            capturedDatasetId,
            groupColumnId,
            sortColumnId,
            sortDirection === 'desc'
          )

          if (currentDataset.id !== capturedDatasetId) return

          // Compute cumulative startViewRow for each group
          let viewRowOffset = 0
          const lazyGroups = lazyResult.groups.map((g) => {
            const isCollapsed = collapsed.has(g.key)
            const entry = {
              key: g.key,
              size: g.size,
              firstRowIndex: g.firstRowIndex,
              startViewRow: viewRowOffset,
            }
            // Collapsed groups take 1 view row (header only), expanded take full size
            viewRowOffset += isCollapsed ? 1 : g.size
            return entry
          })

          // Build groupMeta for display (same format as non-lazy)
          const displayGroupMeta = lazyGroups.map((g) => ({
            startViewRow: g.startViewRow,
            key: g.key,
            size: g.size,
            collapsed: collapsed.has(g.key),
          }))

          // Enable lazy grouping mode
          setIsLazyGrouped(true)
          setLazyGroupMeta(lazyGroups)
          lazyRowCacheRef.current.clear()

          // Set groupMeta for header display
          setGroupMeta(displayGroupMeta)

          // Don't set rowOrder - it would be 18M entries
          // The grid will use lazy lookup instead
          // Set a minimal rowOrder for compatibility (just total count marker)
          baseSortedOrderRef.current = []
          setRowOrder([])
          rowOrderRef.current = []

          // Trigger an initial load for the current viewport so rows don't appear empty
          requestAnimationFrame(() => {
            const range = visibleRegionRef.current
            if (!range) return
            const debouncedFn = debouncedVisibleRegionWorkRef.current
            debouncedFn.cancel()
            lastRangeRef.current = null
            debouncedFn(range)
            debouncedFn.flush()
          })
          return
        } catch (error) {
          console.error('Failed to fetch lazy group metadata:', error)
          toast.error('Group by failed: Could not load group metadata')
          return
        }
      }

      // Fetch the group column from backend cache for exact grouping
      // (streaming rowData may have gaps for unloaded rows)
      let columnValues: unknown[]
      try {
        columnValues = await cacheService.getColumnData(capturedDatasetId, groupBy)
      } catch (error) {
        console.error('Failed to fetch group column data:', error)
        // Fallback to rowData if backend fetch fails
        columnValues = []
      }

      // Guard: dataset changed during async fetch
      if (currentDataset.id !== capturedDatasetId) return

      // Group only data rows by group column value
      const groups = new Map<string, number[]>()

      for (const modelRow of dataRowsInOrder) {
        // Use backend column data if available, fallback to rowData
        const raw = columnValues[modelRow] ?? rowDataRef.current.get(modelRow)?.[groupBy]
        const key = raw == null || raw === '' ? '(blank)' : String(raw)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(modelRow)
      }

      const newRowOrder: number[] = []
      const meta: Array<{ startViewRow: number; key: string; size: number; collapsed: boolean }> = []
      let viewRow = 0

      for (const [key, rows] of groups) {
        const collapsedFlag = collapsed.has(key)

        meta.push({
          startViewRow: viewRow,
          key,
          size: rows.length,
          collapsed: collapsedFlag,
        })

        // First row of each group is always visible (doubles as header row)
        if (rows.length > 0) {
          newRowOrder.push(rows[0]!)
          viewRow += 1
        }

        // If expanded, include the rest of the group rows
        if (!collapsedFlag) {
          for (let i = 1; i < rows.length; i++) {
            newRowOrder.push(rows[i]!)
            viewRow += 1
          }
        }
      }

      // Append buffer rows at the end (excluded from groups)
      newRowOrder.push(...bufferRowsInOrder)

      // Keep ref in sync immediately so scroll work uses the latest order.
      rowOrderRef.current = newRowOrder
      setRowOrder(newRowOrder)
      setGroupMeta(meta)
    },
    [currentDataset, getStorageInfo, resolveDataRowCount, sortColumn, sortDirection]
  )

  // Sort functions (Phase 3 - Sorting)
  // CRITICAL: Fetch complete column from backend to avoid sparse rowData issues
  // where unloaded rows appear as "missing" and sort incorrectly
  const performSort = useCallback(
    async (
      columnId: string,
      direction: 'asc' | 'desc',
      options: { skipConfirm?: boolean } = {}
    ) => {
      if (!currentDataset) return
      const capturedDatasetId = currentDataset.id

      // Increment sort request ID for async race protection (last-call-wins)
      const requestId = ++sortRequestIdRef.current

      // Hoist column lookup outside comparator for efficiency
      const column = currentDataset.columns.find((c) => c.id === columnId)
      const columnType = column?.type

      // Use dataRowCount for actual data rows; buffer rows stay at end unsorted
      const dataRowCount = resolveDataRowCount(currentDataset)
      const totalRowCount = currentDataset.rowCount
      const storageInfo = await getStorageInfo(currentDataset.id)
      if (currentDatasetIdRef.current !== capturedDatasetId) {
        return
      }
      const isLargeDataset = storageInfo?.isLarge === true

      if (isLargeDataset) {
        // Large dataset path: use server-side sorting (DuckDB)
        // Show loading indicator for large dataset sort
        setLoadingOperation({
          type: 'sort',
          message: `Sorting ${currentDataset.name}...`,
          indeterminate: true,
        })

        try {
          await cacheService.ensureLatestCache(currentDataset.id)
        } catch (error) {
          console.error('Failed to flush overlay before sort:', error)
        }

        // Check if this request is still current (user might have sorted again)
        if (
          requestId !== sortRequestIdRef.current ||
          currentDatasetIdRef.current !== capturedDatasetId
        ) {
          setLoadingOperation(null)
          return
        }

        const sortColumnId = columnId
        let sortedIndices: number[] = []
        try {
          sortedIndices = await cacheService.getSortedRowIndices(
            currentDataset.id,
            sortColumnId,
            direction === 'desc'
          )
        } catch (error) {
          console.error('Failed to fetch sorted row indices:', error)
          toast.error('Sort failed: Could not sort large dataset')
          setLoadingOperation(null)
          return
        }

        // Final check before applying sort results
        if (
          requestId !== sortRequestIdRef.current ||
          currentDatasetIdRef.current !== capturedDatasetId
        ) {
          setLoadingOperation(null)
          return
        }

        const normalizedSorted = sortedIndices.map((idx) => Number(idx))
        const effectiveDataRowCount = Math.min(dataRowCount, normalizedSorted.length)
        const bufferRowIndices = Array.from(
          { length: totalRowCount - effectiveDataRowCount },
          (_, i) => effectiveDataRowCount + i
        )

        const sortedOrder = [...normalizedSorted.slice(0, effectiveDataRowCount), ...bufferRowIndices]
        baseSortedOrderRef.current = sortedOrder
        rebuildGrouping(sortedOrder, groupByColumnId, collapsedGroups)
        setSortColumn(columnId)
        setSortDirection(direction)
        setLoadingOperation(null)

        // Bypass debounce: immediately load visible rows with new sort order
        debouncedVisibleRegionWork.cancel()
        lastRangeRef.current = null
        if (visibleRegionRef.current) {
          debouncedVisibleRegionWork(visibleRegionRef.current)
          debouncedVisibleRegionWork.flush()
        }
        return
      }

      // Preflight check for client-side sort
      const sortPreflight = getTransformPreflight({ type: 'sort', dataRowCount })
      if (!sortPreflight.allow) {
        toast.error(sortPreflight.blockReason ?? 'Sort blocked due to dataset size')
        return
      }
      if (sortPreflight.confirm && !options.skipConfirm) {
        const shouldContinue = await confirm(
          `This dataset has ${dataRowCount.toLocaleString()} rows. Sorting large datasets may take a moment.\n\nContinue?`,
          {
            title: 'Large Sort',
            kind: 'warning',
            okLabel: 'Continue',
            cancelLabel: 'Cancel',
          }
        )
        if (!shouldContinue) return
      }

      // CRITICAL: Flush pending edits BEFORE fetching column data
      // Otherwise debounced updates (500ms delay) can cause stale sort
      await cacheService.ensureLatestCache(currentDataset.id)

      // Check if this request is still current (user might have sorted again)
      if (
        requestId !== sortRequestIdRef.current ||
        currentDatasetIdRef.current !== capturedDatasetId
      ) {
        return
      }

      // Fetch COMPLETE column data from backend cache (includes all rows, not just loaded viewport)
      // This prevents zeros/empty cells in unloaded rows from being treated as "missing"
      let columnValues: unknown[] = []
      try {
        columnValues = await cacheService.getColumnData(currentDataset.id, columnId)
      } catch (error) {
        console.error('Failed to fetch column data for sorting:', error)
        toast.error('Sort failed: Could not load column data')
        return
      }

      // Final check before applying sort results
      if (
        requestId !== sortRequestIdRef.current ||
        currentDatasetIdRef.current !== capturedDatasetId
      ) {
        return
      }

      // Show spinner for large sorts
      if (sortPreflight.showSpinner) {
        setLoadingOperation({ type: 'sort', message: sortPreflight.spinnerMessage, indeterminate: true })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      try {
      // Data row indices to sort (0 to dataRowCount-1)
      const dataRowIndices = Array.from({ length: dataRowCount }, (_, i) => i)

      // Buffer row indices stay in identity order at the end
      const bufferRowIndices = Array.from(
        { length: totalRowCount - dataRowCount },
        (_, i) => dataRowCount + i
      )

      // Stable order for ties (preserve existing view order within data rows)
      const baseIndex = new Map<number, number>()
      dataRowIndices.forEach((row, idx) => baseIndex.set(row, idx))

      // Build new rowOrder by sorting only data rows according to the selected column.
      // IMPORTANT: Missing values always sort last regardless of direction.
      // Now uses complete column data from backend, not sparse rowData Map
      const sortedDataIndices = [...dataRowIndices].sort((modelRowA, modelRowB) => {
        const valueA = normalizeSortValue(columnValues[modelRowA])
        const valueB = normalizeSortValue(columnValues[modelRowB])

        const aMissing = valueA == null
        const bMissing = valueB == null
        if (aMissing && bMissing) {
          return (baseIndex.get(modelRowA) ?? 0) - (baseIndex.get(modelRowB) ?? 0)
        }
        if (aMissing) return 1
        if (bMissing) return -1

        const cmp = compareValues(valueA, valueB, columnType)
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
        return (baseIndex.get(modelRowA) ?? 0) - (baseIndex.get(modelRowB) ?? 0)
      })

      // Final order: sorted data rows + unsorted buffer rows
      const sortedOrder = [...sortedDataIndices, ...bufferRowIndices]

      // Store base sorted order and apply grouping
      baseSortedOrderRef.current = sortedOrder
      rebuildGrouping(sortedOrder, groupByColumnId, collapsedGroups)
      setSortColumn(columnId)
      setSortDirection(direction)

      // Bypass debounce: immediately load visible rows with new sort order
      debouncedVisibleRegionWork.cancel()
      lastRangeRef.current = null
      if (visibleRegionRef.current) {
        debouncedVisibleRegionWork(visibleRegionRef.current)
        debouncedVisibleRegionWork.flush()
      }
      } finally {
        if (sortPreflight.showSpinner) setLoadingOperation(null)
      }
    },
    [currentDataset, groupByColumnId, collapsedGroups, rebuildGrouping, getStorageInfo, resolveDataRowCount, debouncedVisibleRegionWork]
  )

  useEffect(() => {
    if (!pendingInsertSortReplay || !currentDataset) return
    if (pendingInsertSortReplay.datasetId !== currentDataset.id) {
      setPendingInsertSortReplay(null)
      return
    }
    if (currentDataset.rowCount < pendingInsertSortReplay.expectedRowCount) {
      return
    }

    const { columnId, direction } = pendingInsertSortReplay
    setPendingInsertSortReplay(null)
    void performSort(columnId, direction, { skipConfirm: true })
  }, [pendingInsertSortReplay, currentDataset, performSort])

  const clearSort = useCallback(() => {
    // Reset to default identity order [0, 1, 2, ..., rowCount-1]
    // This naturally keeps data rows (0..dataRowCount-1) before buffer rows
    if (!currentDataset) return
    const defaultOrder = Array.from({ length: currentDataset.rowCount }, (_, i) => i)
    baseSortedOrderRef.current = defaultOrder
    rebuildGrouping(defaultOrder, groupByColumnId, collapsedGroups)
    setSortColumn(null)
    setSortDirection(null)

    // Bypass debounce: immediately load visible rows with new order
    debouncedVisibleRegionWork.cancel()
    lastRangeRef.current = null
    if (visibleRegionRef.current) {
      debouncedVisibleRegionWork(visibleRegionRef.current)
      debouncedVisibleRegionWork.flush()
    }
  }, [currentDataset, groupByColumnId, collapsedGroups, rebuildGrouping, debouncedVisibleRegionWork])

  useEffect(() => {
    if (!currentDataset) {
      pendingRestoreSortRef.current = null
      return
    }
    const pending = pendingRestoreSortRef.current
    if (!pending) return
    pendingRestoreSortRef.current = null
    if (pending.skipConfirm) {
      toast.info('Restored previous sort', { duration: 1500 })
    }
    void performSort(pending.columnId, pending.direction, { skipConfirm: pending.skipConfirm === true })
  }, [currentDataset?.id, groupByColumnId, collapsedGroups, performSort])

  // Effect to rebuild grouping when collapsedGroups or groupByColumnId changes
  // IMPORTANT: Use debouncedVisibleRegionWorkRef to avoid infinite loop caused by
  // debouncedVisibleRegionWork depending on lazy grouping state which is set by rebuildGrouping
  useEffect(() => {
    if (baseSortedOrderRef.current.length > 0) {
      rebuildGrouping(baseSortedOrderRef.current, groupByColumnId, collapsedGroups)

      // Bypass debounce: immediately load visible rows with new group order
      // Use ref to get latest function without adding it as a dependency (avoids infinite loop)
      const debouncedFn = debouncedVisibleRegionWorkRef.current
      debouncedFn.cancel()
      lastRangeRef.current = null
      if (visibleRegionRef.current) {
        debouncedFn(visibleRegionRef.current)
        debouncedFn.flush()
      }
    }
  }, [collapsedGroups, groupByColumnId, rebuildGrouping])

  // Effect to trigger initial data load after lazy grouping is enabled
  // This runs AFTER the lazy state is committed, so debouncedVisibleRegionWork has correct state
  useEffect(() => {
    if (!isLazyGrouped || lazyGroupMeta.length === 0) return

    // Trigger load for visible region with correct lazy state
    lastRangeRef.current = null
    if (visibleRegionRef.current) {
      debouncedVisibleRegionWork(visibleRegionRef.current)
      debouncedVisibleRegionWork.flush()
    }
  }, [isLazyGrouped, lazyGroupMeta, debouncedVisibleRegionWork])


  const commitFormulaBarEdit = useCallback(async (): Promise<boolean> => {
    if (!currentDataset || !editExecutor || !activeCell) return false

    const { rowIndex: viewRow, columnId } = activeCell
    const modelRow = viewToModel(viewRow) // Convert view → model
    if (modelRow < 0) {
      if (isLazyGrouped) {
        void ensureLazyGroupedRangeLoaded(viewRow, viewRow + 1)
      }
      toast.info('Row is still loading. Try again.')
      return false
    }
    const normalized = normalizeFormulaBeforeCommit(formulaBarText)
    if (normalized.error) {
      toast.error(normalized.error)
      return false
    }
    const newValueText = normalized.text
    if (normalized.autoClosedCount > 0) {
      setFormulaBarText(newValueText)
      updateFormulaBarSession(newValueText, newValueText.length, newValueText.length)
    }
    if (groupByColumnId !== null && (formulaService?.isFormula(newValueText) ?? false)) {
      toast.info('Formulas are disabled while grouped.')
      return false
    }

    const column = columnMetadataMap.get(columnId)
    const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow

    // Parse numeric if target column is numeric and user didn't type a formula
    let newValue: unknown = newValueText
    if (
      column?.type === 'numeric' &&
      typeof newValueText === 'string' &&
      !(formulaService?.isFormula(newValueText) ?? false)
    ) {
      const trimmed = newValueText.trim()
      if (trimmed !== '') {
        const n = Number(trimmed)
        newValue = Number.isFinite(n) ? n : newValueText
      }
    }

    if (newValue === oldValue) return true

    await editExecutor.executeSingle(
      {
        row: modelRow, // Use modelRow for edit
        columnId,
        oldValue,
        newValue,
      },
      'type'
    )

    // Sync formulas to persistence layer
    syncFormulasToStore()

    // Promote buffer row to data row if edited
    bumpDataRowCount(modelRow)
    return true
  }, [
    activeCell,
    columnMetadataMap,
    currentDataset,
    editExecutor,
    formulaBarText,
    formulaService,
    getCellRawValueForUndo,
    syncFormulasToStore,
    viewToModel,
    bumpDataRowCount,
    ensureLazyGroupedRangeLoaded,
    groupByColumnId,
    updateFormulaBarSession,
  ])

  const insertFormulaBarSuggestionAtCaret = useCallback(
    (indexOverride?: number): boolean => {
      if (!formulaBarInputRef.current) return false
      const caret = formulaBarInputRef.current.selectionStart ?? formulaBarText.length
      const result = insertFormulaBarSuggestion(formulaBarText, caret, indexOverride)
      if (!result) return false

      setFormulaBarText(result.text)
      updateFormulaBarSession(result.text, result.caretIndex, result.caretIndex)
      clearFormulaBarSuggestions()

      requestAnimationFrame(() => {
        const input = formulaBarInputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(result.caretIndex, result.caretIndex)
      })
      return true
    },
    [
      clearFormulaBarSuggestions,
      formulaBarText,
      insertFormulaBarSuggestion,
      updateFormulaBarSession,
    ]
  )

  useEffect(() => {
    if (!currentDataset || !activeCell) {
      setFormulaBarText('')
      return
    }

    const activeSession = formulaSessionRef.current
    if (activeSession?.active) {
      setFormulaBarText(activeSession.text)
      return
    }

    // Only refresh displayed text when not actively editing the formula bar.
    if (isFormulaBarFocused) return

    const { rowIndex: viewRow, columnId } = activeCell
    const modelRow = viewToModel(viewRow) // Convert view → model
    const raw = getCellRawValueForUndo(modelRow, columnId) // Use modelRow
    setFormulaBarText(raw === null || raw === undefined ? '' : String(raw))
  }, [activeCell, currentDataset, getCellRawValueForUndo, isFormulaBarFocused, viewToModel])

  // Helper to convert UndoOperation to CellEdit array
  const operationToEdits = useCallback(
    (operation: UndoOperation, isUndo: boolean): CellEdit[] => {
      if (operation.type === 'CellEdit') {
        // Single cell edit
        return [
          {
            row: operation.row,
            columnId: operation.column,
            oldValue: isUndo ? operation.new_value : operation.old_value,
            newValue: isUndo ? operation.old_value : operation.new_value,
          },
        ]
      } else if (operation.type === 'BatchCellEdit') {
        // Batch cell edit (e.g., paste, cut)
        return operation.edits.map(edit => ({
          row: edit.row,
          columnId: edit.column,
          oldValue: isUndo ? edit.new_value : edit.old_value,
          newValue: isUndo ? edit.old_value : edit.new_value,
        }))
      }
      // ColumnRename - not handled via EditExecutor
      return []
    },
    []
  )

  // Virtual column ID for the "+" add column button
  const ADD_COLUMN_ID = '__add_column__'

  // Convert dataset columns to Glide Data Grid format
  // Note: currentDataset is initialized on mount, but can be null during project loads.
  // Appends a virtual "+" column for adding new columns (Plan Part 2)
  const columns: GridColumn[] = useMemo(() => {
    if (!currentDataset) {
      return [] // Placeholder while project loads
    }

    // Map all dataset columns (all have ColumnMetadata with width persistence)
    const dataColumns = currentDataset.columns.map((col: ColumnMetadata) => {
      const rawWidth = typeof col.width === 'number' ? col.width : Number.NaN
      const width = Number.isFinite(rawWidth) && rawWidth >= 50 ? rawWidth : 88
      return {
        id: col.id,
        title: col.name,
        width,
      }
    })

    // Append virtual "+" column for adding new columns
    return [
      ...dataColumns,
      {
        id: ADD_COLUMN_ID,
        title: '+',
        width: 40,
      },
    ]
  }, [currentDataset?.id, currentDataset?.columns])

  const columnIndexById = useMemo(() => {
    const map = new Map<string, number>()
    columns.forEach((column, index) => {
      if (column.id) {
        map.set(column.id, index)
      }
    })
    return map
  }, [columns])

  const columnsRef = useRef<GridColumn[]>([])
  useEffect(() => {
    columnsRef.current = columns
  }, [columns])

  useEffect(() => {
    columnIndexByIdRef.current = columnIndexById
  }, [columnIndexById])

  const buildCellUpdates = useCallback(
    (edits: Array<{ row: number; columnId: string }>) => {
      const updates: Array<{ cell: readonly [number, number] }> = []
      const seen = new Set<string>()
      for (const edit of edits) {
        const colIndex = columnIndexById.get(edit.columnId)
        if (colIndex === undefined) continue
        const viewRow = modelToView(edit.row)
        const key = `${colIndex}:${viewRow}`
        if (seen.has(key)) continue
        seen.add(key)
        updates.push({ cell: [colIndex, viewRow] as const })
      }
      return updates
    },
    [columnIndexById, modelToView]
  )

  const applyStructuralUndoRedoOperation = useCallback(
    async (operation: UndoOperation, direction: 'undo' | 'redo') => {
      if (!currentDataset || operation.dataset_id !== currentDataset.id) return false

      const savedScrollX = visibleRegionRef.current.x
      const savedScrollY = visibleRegionRef.current.y

      if (operation.type === 'RowInsert') {
        const rowIndex = Math.max(0, operation.row_index)
        const isUndo = direction === 'undo'
        const activeGroupBy = groupByColumnId
        const shouldRebuildGrouping = activeGroupBy !== null || isLazyGrouped
        const sourceOrder =
          baseSortedOrderRef.current.length > 0
            ? [...baseSortedOrderRef.current]
            : rowOrderRef.current.length > 0
              ? [...rowOrderRef.current]
              : Array.from({ length: currentDataset.rowCount }, (_, i) => i)

        resetStreamingStateForStructuralEdit()
        if (isUndo) {
          removeRowAtDataset(currentDataset.id, rowIndex)
          updateRowDataRef(prev => {
            const next = new Map<number, Record<string, unknown>>()
            for (const [row, rowData] of prev.entries()) {
              if (row === rowIndex) continue
              next.set(row > rowIndex ? row - 1 : row, rowData)
            }
            return next
          })

          if (formulaService) {
            const formulaEdits = formulaService.shiftReferencesForRowDelete(rowIndex)
            applyFormulaEdits(formulaEdits)
            syncFormulasToStore()
          }

          const nextOrder = sourceOrder
            .filter(row => row !== rowIndex)
            .map(row => (row > rowIndex ? row - 1 : row))
          baseSortedOrderRef.current = nextOrder
          if (shouldRebuildGrouping) {
            await rebuildGrouping(nextOrder, activeGroupBy, collapsedGroups)
          } else {
            rowOrderRef.current = nextOrder
            setRowOrder(nextOrder)
          }
        } else {
          insertRowAtDataset(currentDataset.id, rowIndex)
          updateRowDataRef(prev => {
            const next = new Map<number, Record<string, unknown>>()
            for (const [row, rowData] of prev.entries()) {
              next.set(row >= rowIndex ? row + 1 : row, rowData)
            }
            next.set(rowIndex, {})
            return next
          })

          if (formulaService) {
            const formulaEdits = formulaService.shiftReferencesForRowInsert(rowIndex)
            applyFormulaEdits(formulaEdits)
            syncFormulasToStore()
          }

          const nextOrder = sourceOrder.map(row => (row >= rowIndex ? row + 1 : row))
          const insertAt = Math.max(0, Math.min(rowIndex, nextOrder.length))
          nextOrder.splice(insertAt, 0, rowIndex)
          baseSortedOrderRef.current = nextOrder
          if (shouldRebuildGrouping) {
            await rebuildGrouping(nextOrder, activeGroupBy, collapsedGroups)
          } else {
            rowOrderRef.current = nextOrder
            setRowOrder(nextOrder)
          }

          const activeSortColumn = sortColumnRef.current
          const activeSortDirection = sortDirectionRef.current
          if (activeSortColumn && activeSortDirection) {
            setPendingInsertSortReplay({
              datasetId: currentDataset.id,
              columnId: activeSortColumn,
              direction: activeSortDirection,
              expectedRowCount: currentDataset.rowCount + 1,
            })
          }
        }

        invalidateColumns(currentDataset.columns.map(column => column.id))
        requestScrollRestore({ x: savedScrollX, y: savedScrollY })
        requestGridRefresh({
          reason: `undo-redo-${operation.type}-${direction}`,
          scope: 'remount',
        })
        useAppStore.getState().setProjectDirty(true)
        return true
      }

      if (operation.type === 'ColumnInsert') {
        const columnIndex = Math.max(0, operation.column_index)
        const isUndo = direction === 'undo'

        if (isUndo) {
          const effectiveColumnIndex = currentDataset.columns.findIndex(
            column => column.id === operation.column_id
          )
          if (effectiveColumnIndex < 0) {
            console.warn(
              '[Undo/Redo] ColumnInsert undo skipped frontend remove: column id not found',
              operation.column_id
            )
            requestScrollRestore({ x: savedScrollX, y: savedScrollY })
            useAppStore.getState().setProjectDirty(true)
            return true
          }
          removeColumnAtDataset(currentDataset.id, effectiveColumnIndex)
          updateRowDataRef(prev => {
            const next = new Map<number, Record<string, unknown>>()
            for (const [row, rowData] of prev.entries()) {
              const { [operation.column_id]: _removed, ...rest } = rowData
              next.set(row, rest)
            }
            return next
          })

          const columnsToInvalidate = new Set(
            currentDataset.columns
              .filter(column => column.id !== operation.column_id)
              .map(column => column.id)
          )

          if (formulaService) {
            formulaService.setColumnCount(Math.max(0, currentDataset.columns.length - 1))
            const formulaEdits = formulaService.shiftReferencesForColumnDelete(effectiveColumnIndex)
            applyFormulaEdits(formulaEdits)
            for (const edit of formulaEdits) {
              columnsToInvalidate.add(edit.columnId)
            }
            syncFormulasToStore()
          }
          invalidateColumns(Array.from(columnsToInvalidate))
          setActiveCell(prev => {
            if (!prev) return prev
            if (prev.colIndex > effectiveColumnIndex) return { ...prev, colIndex: prev.colIndex - 1 }
            if (prev.colIndex === effectiveColumnIndex) {
              return { ...prev, colIndex: Math.max(0, prev.colIndex - 1) }
            }
            return prev
          })
        } else {
          const newColumn: ColumnMetadata = {
            id: operation.column_id,
            name: operation.column_name,
            type: 'text',
            width: 88,
          }
          insertColumnAtDataset(currentDataset.id, columnIndex, newColumn)
          updateRowDataRef(prev => {
            const next = new Map<number, Record<string, unknown>>()
            for (const [row, rowData] of prev.entries()) {
              next.set(row, { ...rowData, [operation.column_id]: '' })
            }
            return next
          })

          const columnsToInvalidate = new Set<string>([operation.column_id])
          if (formulaService) {
            formulaService.setColumnCount(currentDataset.columns.length + 1)
            const formulaEdits = formulaService.shiftReferencesForColumnInsert(columnIndex)
            applyFormulaEdits(formulaEdits)
            for (const edit of formulaEdits) {
              columnsToInvalidate.add(edit.columnId)
            }
            syncFormulasToStore()
          }
          invalidateColumns(Array.from(columnsToInvalidate))
          setActiveCell(prev => {
            if (!prev) return prev
            if (prev.colIndex >= columnIndex) return { ...prev, colIndex: prev.colIndex + 1 }
            return prev
          })
        }

        requestScrollRestore({ x: savedScrollX, y: savedScrollY })
        requestGridRefresh({
          reason: `undo-redo-${operation.type}-${direction}`,
          scope: 'remount',
        })
        useAppStore.getState().setProjectDirty(true)
        return true
      }

      return false
    },
    [
      currentDataset,
      removeRowAtDataset,
      updateRowDataRef,
      formulaService,
      applyFormulaEdits,
      syncFormulasToStore,
      insertRowAtDataset,
      rebuildGrouping,
      groupByColumnId,
      isLazyGrouped,
      collapsedGroups,
      invalidateColumns,
      requestScrollRestore,
      requestGridRefresh,
      resetStreamingStateForStructuralEdit,
      removeColumnAtDataset,
      insertColumnAtDataset,
    ]
  )

  const applyUndoRedoOperation = useCallback(
    async (operation: UndoOperation | null, direction: 'undo' | 'redo') => {
      if (!operation) return
      const handledStructural = await applyStructuralUndoRedoOperation(operation, direction)
      if (handledStructural) return
      if (
        operation.type === 'ColumnRename' &&
        currentDataset &&
        operation.dataset_id === currentDataset.id
      ) {
        const nextName = direction === 'undo' ? operation.old_name : operation.new_name
        const updatedColumns = currentDataset.columns.map(column =>
          column.id === operation.column_id ? { ...column, name: nextName } : column
        )
        updateDataset(currentDataset.id, { columns: updatedColumns })
        try {
          await tauriApi.updateDatasetMetadata(currentDataset.id, updatedColumns)
        } catch (error) {
          console.error('Failed to sync undo/redo column rename to backend:', error)
        }
        useAppStore.getState().setProjectDirty(true)
        return
      }
      if (!editExecutor) return

      const edits = operationToEdits(operation, direction === 'undo')
      if (edits.length === 0) return

      await editExecutor.execute(edits, direction)
      syncFormulasToStore()

      requestAnimationFrame(() => {
        const cellUpdates = edits
          .map((edit) => {
            const colIndex = columnIndexById.get(edit.columnId)
            if (colIndex === undefined) return null
            const viewRow = modelToView(edit.row) // Convert model  view for updateCells
            return {
              cell: [colIndex, viewRow] as readonly [number, number],
            }
          })
          .filter((update): update is { cell: readonly [number, number] } => update !== null)
        if (cellUpdates.length > 0) {
          scheduleCellUpdates(cellUpdates)
        }
      })
    },
    [
      applyStructuralUndoRedoOperation,
      currentDataset,
      columnIndexById,
      editExecutor,
      modelToView,
      operationToEdits,
      updateDataset,
      syncFormulasToStore,
      scheduleCellUpdates,
    ]
  )

  type HighlightChange = {
    cellKey: string
    oldColor: string | undefined
    newColor: string | undefined
  }
  type HighlightOperation = {
    datasetId: string
    changes: HighlightChange[]
  }

  // Highlight undo/redo stacks (frontend-only, in-memory)
  const highlightUndoStack = useRef<Map<string, HighlightOperation[]>>(new Map())
  const highlightRedoStack = useRef<Map<string, HighlightOperation[]>>(new Map())

  const buildHighlightCellUpdates = useCallback(
    (changes: HighlightChange[]) => {
      const updates: Array<{ cell: readonly [number, number] }> = []
      const seen = new Set<string>()

      for (const change of changes) {
        const separator = change.cellKey.indexOf(':')
        if (separator < 0) continue

        const rowText = change.cellKey.slice(0, separator)
        const columnId = change.cellKey.slice(separator + 1)
        if (!columnId) continue

        const modelRow = Number.parseInt(rowText, 10)
        if (Number.isNaN(modelRow)) continue

        const colIndex = columnIndexById.get(columnId)
        if (colIndex === undefined) continue

        const viewRow = modelToView(modelRow)
        if (viewRow < 0) continue

        const key = `${colIndex}:${viewRow}`
        if (seen.has(key)) continue
        seen.add(key)
        updates.push({ cell: [colIndex, viewRow] as const })
      }

      return updates
    },
    [columnIndexById, modelToView]
  )

  // Apply highlight color to selected cells
  const applyHighlight = useCallback(
    (color: string | null) => {
      if (!currentDataset || !gridSelection.current) {
        closeContextMenu()
        return
      }

      const { range } = gridSelection.current
      const { x, y, width, height } = range

      const changes: HighlightChange[] = []
      const newColor = color === null ? undefined : color

      // Iterate over selected cells and capture old values
      for (let row = y; row < y + height; row++) {
        const modelRow = viewToModel(row)
        if (modelRow < 0) continue
        for (let col = x; col < x + width; col++) {
          const gridColumn = columns[col]
          if (!gridColumn?.id) continue
          const cellKey = `${modelRow}:${gridColumn.id}`

          // Capture old highlight color
          const oldColor = currentDataset.highlights?.[cellKey]
          if (oldColor === newColor) {
            continue
          }
          changes.push({
            cellKey,
            oldColor,
            newColor,
          })
        }
      }

      if (changes.length === 0) {
        closeContextMenu()
        return
      }

      // Apply changes
      const keys = changes.map(change => change.cellKey)
      if (color === null) {
        removeHighlightsBatch(currentDataset.id, keys)
      } else {
        setHighlightsBatch(currentDataset.id, keys, color)
      }

      // Push to undo stack and clear redo for this dataset
      const datasetId = currentDataset.id
      const undoStack = highlightUndoStack.current
      const datasetUndo = undoStack.get(datasetId) ?? []
      datasetUndo.push({ datasetId, changes })
      undoStack.set(datasetId, datasetUndo)
      highlightRedoStack.current.set(datasetId, [])

      // Update current fill color (if not removing color)
      if (color !== null) {
        setCurrentFillColor(color)
      }

      // Mark project dirty after highlight change
      useAppStore.getState().setProjectDirty(true)

      // Highlight edits are visual-only; refresh the affected cells without remounting the grid.
      const cellUpdates = buildHighlightCellUpdates(changes)
      requestGridRefresh({
        reason: 'highlight-apply',
        scope: 'cells',
        cellUpdates,
        deferToAnimationFrame: true,
      })
      closeContextMenu()
    },
    [
      currentDataset,
      gridSelection,
      viewToModel,
      columns,
      setHighlightsBatch,
      removeHighlightsBatch,
      buildHighlightCellUpdates,
      requestGridRefresh,
      closeContextMenu,
    ]
  )

  // Undo highlight changes
  const undoHighlight = useCallback(() => {
    if (!currentDataset) return false
    const datasetId = currentDataset.id
    const undoStack = highlightUndoStack.current.get(datasetId)
    if (!undoStack || undoStack.length === 0) return false
    const operation = undoStack.pop()
    if (!operation) return false

    // Apply old colors
    const toRemove: string[] = []
    const toSetByColor: Map<string, string[]> = new Map()

    for (const change of operation.changes) {
      if (change.oldColor === undefined) {
        toRemove.push(change.cellKey)
      } else {
        const bucket = toSetByColor.get(change.oldColor) ?? []
        bucket.push(change.cellKey)
        toSetByColor.set(change.oldColor, bucket)
      }
    }

    if (toRemove.length > 0) {
      removeHighlightsBatch(datasetId, toRemove)
    }
    if (toSetByColor.size > 0) {
      for (const [color, keys] of toSetByColor.entries()) {
        setHighlightsBatch(datasetId, keys, color)
      }
    }

    // Push to redo stack
    const redoStack = highlightRedoStack.current
    const datasetRedo = redoStack.get(datasetId) ?? []
    datasetRedo.push(operation)
    redoStack.set(datasetId, datasetRedo)

    // Mark project dirty after highlight undo
    useAppStore.getState().setProjectDirty(true)

    const cellUpdates = buildHighlightCellUpdates(operation.changes)
    requestGridRefresh({
      reason: 'highlight-undo',
      scope: 'cells',
      cellUpdates,
      deferToAnimationFrame: true,
    })
    return true
  }, [currentDataset, removeHighlightsBatch, setHighlightsBatch, buildHighlightCellUpdates, requestGridRefresh])

  // Redo highlight changes
  const redoHighlight = useCallback(() => {
    if (!currentDataset) return false
    const datasetId = currentDataset.id
    const redoStack = highlightRedoStack.current.get(datasetId)
    if (!redoStack || redoStack.length === 0) return false
    const operation = redoStack.pop()
    if (!operation) return false

    // Apply new colors
    const toRemove: string[] = []
    const toSetByColor: Map<string, string[]> = new Map()

    for (const change of operation.changes) {
      if (change.newColor === undefined) {
        toRemove.push(change.cellKey)
      } else {
        const bucket = toSetByColor.get(change.newColor) ?? []
        bucket.push(change.cellKey)
        toSetByColor.set(change.newColor, bucket)
      }
    }

    if (toRemove.length > 0) {
      removeHighlightsBatch(datasetId, toRemove)
    }
    if (toSetByColor.size > 0) {
      for (const [color, keys] of toSetByColor.entries()) {
        setHighlightsBatch(datasetId, keys, color)
      }
    }

    // Push back to undo stack
    const undoStack = highlightUndoStack.current
    const datasetUndo = undoStack.get(datasetId) ?? []
    datasetUndo.push(operation)
    undoStack.set(datasetId, datasetUndo)

    // Mark project dirty after highlight redo
    useAppStore.getState().setProjectDirty(true)

    const cellUpdates = buildHighlightCellUpdates(operation.changes)
    requestGridRefresh({
      reason: 'highlight-redo',
      scope: 'cells',
      cellUpdates,
      deferToAnimationFrame: true,
    })
    return true
  }, [currentDataset, removeHighlightsBatch, setHighlightsBatch, buildHighlightCellUpdates, requestGridRefresh])

  const performUndo = useCallback(async () => {
    if (!currentDataset) return
    try {
      const operation = await undoService.undo(currentDataset.id)
      if (!operation) return
      await applyUndoRedoOperation(operation, 'undo')
    } catch (error) {
      console.error('Undo failed:', error)
    }
  }, [applyUndoRedoOperation, currentDataset?.id])

  const performRedo = useCallback(async () => {
    if (!currentDataset) return
    try {
      const operation = await undoService.redo(currentDataset.id)
      if (!operation) return
      await applyUndoRedoOperation(operation, 'redo')
    } catch (error) {
      console.error('Redo failed:', error)
    }
  }, [applyUndoRedoOperation, currentDataset?.id])

  // Group header lookup by start view row (hot-path optimization for getCellContent)
  const groupHeaderByViewRow = useMemo(() => {
    const map = new Map<number, { key: string; size: number; collapsed: boolean }>()
    for (const g of groupMeta) {
      map.set(g.startViewRow, { key: g.key, size: g.size, collapsed: g.collapsed })
    }
    return map
  }, [groupMeta])

  // Get cell content
  const getCellContent = useCallback(
    (cell: Item): GridCell => {
      const [colIndex, viewRow] = cell
      const modelRow = viewToModel(viewRow) // Convert view → model

      const gridColumn = columns[colIndex]
      const columnId = gridColumn?.id

      // Safety check (should never happen with initialized dataset)
      if (!columnId || !currentDataset) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: true,
          readonly: false,
        }
      }

      // Virtual "+" column: return empty non-editable cell (click header to add column)
      if (columnId === ADD_COLUMN_ID) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: false,
          readonly: true,
          themeOverride: addColumnCellTheme, // Slightly different background
        }
      }

      // Group header rendering (Phase 4 - Grouping)
      // Hot path: only the first column of the group's first row renders a header label.
      const groupHeader = groupHeaderByViewRow.get(viewRow)

      if (groupHeader && colIndex === 0) {
        // Render group header cell with expand/collapse indicator
        const prefix = groupHeader.collapsed ? '▸ ' : '▾ '
        const label = `${prefix}${groupHeader.key} (${groupHeader.size})`
        return {
          kind: GridCellKind.Text,
          data: label,
          displayData: label,
          allowOverlay: false,
          readonly: true,
          themeOverride: groupHeaderCellTheme,
        }
      }

      const column = columnMetadataMap.get(columnId)
      if (!column) {
        // Shouldn't happen - all columns should have metadata
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: true,
          readonly: false,
        }
      }

      if (modelRow < 0) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: false,
          readonly: true,
        }
      }

      const cellKey = `${modelRow}:${columnId}`
      const highlightColor = currentDataset.highlights?.[cellKey]

      // Mirror the active formula draft into the target cell for Excel-like visual parity.
      // This is display-only; we still avoid mutating dataset/formula values until commit.
      const activeFormulaSession = formulaSessionRef.current
      const activeFormulaTarget = activeFormulaSession?.active ? activeFormulaSession.targetCell : null
      const formulaDraftText = formulaBarText || activeFormulaSession?.text || ''
      if (
        activeFormulaTarget &&
        activeFormulaTarget.colIndex === colIndex &&
        activeFormulaTarget.rowIndex === viewRow &&
        formulaDraftText.length > 0
      ) {
        return {
          kind: GridCellKind.Text,
          data: formulaDraftText,
          displayData: formulaDraftText,
          allowOverlay: true,
          readonly: false,
          copyData: formulaDraftText,
          ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
        }
      }

      // Get value from rowData cache (use column.id to match data-store keys)
      const row = rowDataRef.current.get(modelRow) // Use modelRow for data access

      // Handle unloaded rows (streaming row provider)
      // If row is not in sparse cache, trigger background load
      if (!row) {
        // CRITICAL FIX: Buffer rows (beyond dataRowCount) should be editable even if not loaded
        // These are extra empty rows for manual data entry on large datasets
        const dataRowCount = resolveDataRowCount(currentDataset)
        const isBufferRow = modelRow >= dataRowCount

        if (isBufferRow) {
          // Buffer row - return editable empty cell (no need to load from DuckDB)
          if (column.type === 'numeric') {
            return {
              kind: GridCellKind.Number,
              data: undefined,
              displayData: '',
              allowOverlay: true,
              readonly: false,
              ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
            } as GridCell
          }
          return {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
            readonly: false,
            ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
          }
        }

        // Data row not yet loaded - trigger background load and show readonly loading state
        // OPTIMIZATION: Coalesce loads by block to avoid hundreds of duplicate fetches on cold paint
        if (!isLazyGrouped) {
          const blockIndex = Math.floor(modelRow / BLOCK_SIZE)
          if (!pendingBlockLoadsRef.current.has(blockIndex)) {
            pendingBlockLoadsRef.current.add(blockIndex)
            void ensureRangeLoaded(modelRow, modelRow + 1).finally(() => {
              pendingBlockLoadsRef.current.delete(blockIndex)
            })
          }
        }

        // Return empty cell while loading
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '', // Could show "..." as loading indicator
          allowOverlay: false,
          readonly: true,
          ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
        }
      }

      let value = row[columnId]

      // Fallback: handle case-insensitive column keys from imports (e.g., "Yield" vs "yield")
      if (value === undefined) {
        const columnIdLower = columnId.toLowerCase()
        const altKey = Object.keys(row).find((key) => key.toLowerCase() === columnIdLower)
        if (altKey) {
          value = row[altKey as keyof typeof row]
        }
      }

      // Fallback: handle rows keyed by display names instead of col-{idx}
      if (value === undefined) {
        const candidates = columnRowKeyFallbacks.get(columnId)
        if (candidates) {
          for (const key of candidates) {
            if (Object.prototype.hasOwnProperty.call(row, key)) {
              value = row[key as keyof typeof row]
              break
            }
          }
        }
      }

      // Handle pending calculation sentinel (async aggregate formulas - Phase 5.2)
      if (FormulaService.isPendingCalculation(value)) {
        const cellKey = `${modelRow}:${columnId}` // Use modelRow for formula key
        const hasFormula = formulaService?.hasFormula(cellKey) ?? false
        if (hasFormula) {
          const rawFormula = formulaService?.getFormula(cellKey)
          return {
            kind: GridCellKind.Text,
            data: 'Calculating...',
            displayData: 'Calculating...',
            allowOverlay: true,
            readonly: false,
            copyData: rawFormula,
            themeOverride: {
              ...pendingFormulaTheme,
              ...(highlightColor ? { bgCell: highlightColor } : {}),
            }, // Faded text
          }
        }
      }

      // Handle null/undefined values in loaded row
      if (value === null || value === undefined) {
        // Keep numeric columns as numeric cells even when blank so editing behaves consistently.
        if (column.type === 'numeric') {
          const hasFormula = formulaService?.hasFormula(cellKey) ?? false
          return {
            kind: GridCellKind.Number,
            data: undefined,
            displayData: '',
            allowOverlay: true,
            readonly: false,
            // Pass formula string for editor to display (if present)
            copyData: hasFormula ? formulaService?.getFormula(cellKey) : undefined,
            ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
          } as GridCell
        }

        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: true,
          readonly: false,
          ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
        }
      }

      // Handle date formulas (TODAY, NOW) - format as date regardless of column type
      const cellKeyForFormula = `${modelRow}:${columnId}`
      const hasDateFormula = formulaService?.hasFormula(cellKeyForFormula) ?? false
      if (hasDateFormula && typeof value === 'number') {
        const rawFormula = formulaService?.getFormula(cellKeyForFormula)
        if (rawFormula && DATE_FORMULA_PATTERN.test(rawFormula)) {
          const dateDisplay = formatExcelSerialDate(value)
          if (dateDisplay) {
            return {
              kind: GridCellKind.Text,
              data: String(value), // Keep raw serial for formulas
              displayData: dateDisplay,
              allowOverlay: true,
              readonly: false,
              copyData: rawFormula,
              ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
            }
          }
        }
      }

      // Map column type to Glide cell kind
      switch (column.type) {
        case 'numeric': {
          // CRITICAL: Preserve empty cells as blank, don't coerce to 0
          // - Empty/null/whitespace → undefined (blank cell)
          // - Real 0 → 0 (valid numeric value)
          // - Non-numeric → undefined (invalid, show as blank)
          const cellKey = `${modelRow}:${columnId}` // Use modelRow for formula key
          const hasFormula = formulaService?.hasFormula(cellKey) ?? false
          const rawFormula = hasFormula ? formulaService?.getFormula(cellKey) : undefined

          // Blank string -> blank numeric cell
          if (typeof value === 'string' && value.trim() === '') {
            return {
              kind: GridCellKind.Number,
              data: undefined,
              displayData: '',
              allowOverlay: true,
              readonly: false,
              copyData: rawFormula,
              ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
            } as GridCell
          }

          // Numbers (including 0) stay numeric
          if (typeof value === 'number') {
            const isDateFormula = rawFormula ? DATE_FORMULA_PATTERN.test(rawFormula) : false
            const dateDisplay = isDateFormula ? formatExcelSerialDate(value) : null
            if (dateDisplay) {
              return {
                kind: GridCellKind.Text,
                data: dateDisplay,
                displayData: dateDisplay,
                allowOverlay: true,
                readonly: false,
                copyData: rawFormula,
                ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
              }
            }
            return {
              kind: GridCellKind.Number,
              data: value,
              displayData: formatNumber(value),
              allowOverlay: true,
              readonly: false,
              copyData: rawFormula,
              ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
            } as GridCell
          }

          // Numeric strings stay numeric; non-numeric strings (including '#ERROR: ...') are displayed as text.
          if (typeof value === 'string') {
            const trimmed = value.trim()
            const parsed = Number(trimmed)
            if (trimmed !== '' && Number.isFinite(parsed)) {
              const isDateFormula = rawFormula ? DATE_FORMULA_PATTERN.test(rawFormula) : false
              const dateDisplay = isDateFormula ? formatExcelSerialDate(parsed) : null
              if (dateDisplay) {
                return {
                  kind: GridCellKind.Text,
                  data: dateDisplay,
                  displayData: dateDisplay,
                  allowOverlay: true,
                  readonly: false,
                  copyData: rawFormula,
                  ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
                }
              }
              return {
                kind: GridCellKind.Number,
                data: parsed,
                displayData: formatNumber(parsed),
                allowOverlay: true,
                readonly: false,
                copyData: rawFormula,
                ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
              } as GridCell
            }

            return {
              kind: GridCellKind.Text,
              data: value,
              displayData: value,
              allowOverlay: true,
              readonly: false,
              copyData: rawFormula,
              ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
            } as GridCell
          }

          // Fallback: try numeric coercion, otherwise show as text.
          const parsed = Number(value)
          if (Number.isFinite(parsed)) {
            const isDateFormula = rawFormula ? DATE_FORMULA_PATTERN.test(rawFormula) : false
            const dateDisplay = isDateFormula ? formatExcelSerialDate(parsed) : null
            if (dateDisplay) {
              return {
                kind: GridCellKind.Text,
                data: dateDisplay,
                displayData: dateDisplay,
                allowOverlay: true,
                readonly: false,
                copyData: rawFormula,
                ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
              }
            }
            return {
              kind: GridCellKind.Number,
              data: parsed,
              displayData: formatNumber(parsed),
              allowOverlay: true,
              readonly: false,
              copyData: rawFormula,
              ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
            } as GridCell
          }

          const fallbackText = String(value)
          return {
            kind: GridCellKind.Text,
            data: fallbackText,
            displayData: fallbackText,
            allowOverlay: true,
            readonly: false,
            copyData: rawFormula,
            ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
          } as GridCell
        }

        case 'categorical':
        case 'text': {
          const hasFormula = formulaService?.hasFormula(cellKey) ?? false
          const rawFormula = hasFormula ? formulaService?.getFormula(cellKey) : undefined
          if (typeof value === 'number' && rawFormula) {
            const isDateFormula = DATE_FORMULA_PATTERN.test(rawFormula)
            const dateDisplay = isDateFormula ? formatExcelSerialDate(value) : null
            if (dateDisplay) {
              return {
                kind: GridCellKind.Text,
                data: dateDisplay,
                displayData: dateDisplay,
                allowOverlay: true,
                readonly: false,
                copyData: rawFormula,
                ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
              }
            }
          }
          return {
            kind: GridCellKind.Text,
            data: String(value),
            displayData:
              typeof value === 'number' ? formatNumber(value) : String(value),
            allowOverlay: true,
            readonly: false,
            ...(rawFormula ? { copyData: rawFormula } : {}),
            ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
          }
        }

        case 'datetime': {
          // Convert Excel serial date to formatted string
          let displayValue = String(value)
          if (typeof value === 'number' && Number.isFinite(value)) {
            displayValue = formatExcelSerialDate(value) ?? displayValue
          }
          const hasFormula = formulaService?.hasFormula(cellKey) ?? false
          const rawFormula = hasFormula ? formulaService?.getFormula(cellKey) : undefined
          return {
            kind: GridCellKind.Text,
            data: String(value),
            displayData: displayValue,
            allowOverlay: true,
            readonly: false,
            ...(rawFormula ? { copyData: rawFormula } : {}),
            ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
          }
        }

        default: {
          const hasFormula = formulaService?.hasFormula(cellKey) ?? false
          const rawFormula = hasFormula ? formulaService?.getFormula(cellKey) : undefined
          return {
            kind: GridCellKind.Text,
            data: String(value),
            displayData: String(value),
            allowOverlay: true,
            readonly: false,
            ...(rawFormula ? { copyData: rawFormula } : {}),
            ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
          }
        }
      }
    },
    [
      addColumnCellTheme,
      columnMetadataMap,
      columns,
      currentDataset,
      formulaService,
      formulaBarText,
      groupHeaderCellTheme,
      pendingFormulaTheme,
      resolveDataRowCount,
      viewToModel,
      groupHeaderByViewRow,
      ensureRangeLoaded,
      isLazyGrouped,
    ]
  )

  // Handle cell edits - uses EditExecutor for unified edit pipeline
  const onCellEdited = useCallback(
    (cell: Item, newValue: EditableGridCell) => {
      const [colIndex, viewRow] = cell
      const modelRow = viewToModel(viewRow) // Convert view → model

      if (modelRow < 0) {
        if (isLazyGrouped) {
          void ensureLazyGroupedRangeLoaded(viewRow, viewRow + 1)
        }
        toast.info('Row is still loading. Try again.')
        return
      }

      const gridColumn = columns[colIndex]
      if (!gridColumn || !gridColumn.id) return
      const columnId = gridColumn.id

      // Skip virtual "+" column (should not be editable, but safety check)
      if (columnId === ADD_COLUMN_ID) return

      // Extract value based on cell kind
      const cellValue =
        newValue.kind === GridCellKind.Text
          ? newValue.data
          : newValue.kind === GridCellKind.Number
          ? newValue.data
          : ''

      if (
        groupByColumnId !== null &&
        typeof cellValue === 'string' &&
        (formulaService?.isFormula(cellValue) ?? false)
      ) {
        toast.info('Formulas are disabled while grouped.')
        return
      }

      if (!currentDataset || !editExecutor) {
        // No dataset yet - update local rowData using consistent column IDs
        updateRowDataRef(prev => {
          const updated = new Map(prev)
          const rowRecord = updated.get(modelRow) || {} // Use modelRow
          rowRecord[columnId] = cellValue
          updated.set(modelRow, rowRecord) // Use modelRow
          return updated
        })
        return
      }

      const column = columnMetadataMap.get(columnId)
      if (!column) return

      // Get old value for undo support
      const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow

      // Use EditExecutor for unified pipeline (all 7 side effects guaranteed)
      const edit: CellEdit = {
        row: modelRow, // Use modelRow for edit
        columnId,
        oldValue,
        newValue: cellValue,
      }
      editExecutor.executeSingle(edit, 'type')

      // Ensure the edited cell re-renders even when rowData updates don't trigger React renders.
      requestAnimationFrame(() => {
        scheduleCellUpdates([{ cell: [colIndex, viewRow] as const }])
      })

      // Promote buffer row to data row if edited
      bumpDataRowCount(modelRow)
    },
    [
      columnMetadataMap,
      columns,
      currentDataset,
      editExecutor,
      formulaService,
      getCellRawValueForUndo,
      viewToModel,
      bumpDataRowCount,
      ensureLazyGroupedRangeLoaded,
      isLazyGrouped,
      groupByColumnId,
      updateRowDataRef,
      scheduleCellUpdates,
    ]
  )

  const handleCellFormulaSessionChange = useCallback(
    (snapshot: FormulaSessionSnapshot) => {
      setFormulaBarText(snapshot.text)
      clearFormulaBarSuggestions()
      updateFormulaSession('cell', {
        editorSessionId: snapshot.editorSessionId,
        targetCell: snapshot.targetCell,
        text: snapshot.text,
        caretStart: snapshot.caretStart,
        caretEnd: snapshot.caretEnd,
        isRangePickMode: snapshot.isRangePickMode,
        lastInsertedRange: null,
        preserveLastInsertedRange: snapshot.preserveLastInsertedRange ?? false,
      })
    },
    [clearFormulaBarSuggestions, updateFormulaSession]
  )

  const handleCellFormulaSessionEnd = useCallback(() => {
    clearFormulaSession('cell')
    clearFormulaBarSuggestions()
  }, [clearFormulaBarSuggestions, clearFormulaSession])

  const migrateCellFormulaSessionToBar = useCallback(
    (focusInput: boolean, allowNonRangePick: boolean = false): boolean => {
      const session = formulaSessionRef.current
      if (!session || !session.active || session.source !== 'cell') {
        return false
      }
      if (!allowNonRangePick && !isRangePickFormulaMode(session.mode)) {
        return false
      }

      const nextMode = transitionFormulaEditMode(session.mode, {
        type: 'migrate_cell_to_bar',
        rangePick: isRangePickFormulaMode(session.mode),
      })
      if (!nextMode) {
        return false
      }

      const nextSession: FormulaEditSession = {
        ...session,
        version: bumpFormulaOwnerVersion(session),
        mode: nextMode,
        source: 'bar',
        editorSessionId: null,
        isRangePickMode: isRangePickFormulaMode(nextMode),
      }

      setFormulaSession(nextSession)
      setFormulaBarText(nextSession.text)
      updateFormulaBarSuggestions(nextSession.text, nextSession.caretStart)
      setIsFormulaBarFocused(true)

      if (!focusInput) return true
      requestAnimationFrame(() => {
        const input = formulaBarInputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(nextSession.caretStart, nextSession.caretEnd)
      })
      return true
    },
    [setFormulaSession, updateFormulaBarSuggestions]
  )

  const handleFormulaEditorBridgeChange = useCallback(
    (bridge: FormulaEditorBridge | null) => {
      formulaEditorBridgeRef.current = bridge
      if (!bridge) {
        migrateCellFormulaSessionToBar(true)
      }
    },
    [migrateCellFormulaSessionToBar]
  )

  // Provide custom editor for formula autocomplete
  const provideEditor = useCallback((cell: GridCell) => {
    // Only provide custom editor for text and numeric cells
    if (cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Number) {
      return {
        editor: (props: any) => (
          <FormulaCellEditor
            {...props}
            activeCell={activeCellRef.current}
            onTextChange={handleFormulaTextChange}
            onFormulaSessionChange={handleCellFormulaSessionChange}
            onFormulaSessionEnd={handleCellFormulaSessionEnd}
            onEditorBridgeChange={handleFormulaEditorBridgeChange}
            onRangePickArrow={moveFormulaRangePickSelection}
          />
        ),
        disablePadding: true,
        disableStyling: false,
      }
    }
    return undefined
  }, [
    handleFormulaEditorBridgeChange,
    handleCellFormulaSessionChange,
    handleCellFormulaSessionEnd,
    handleFormulaTextChange,
    moveFormulaRangePickSelection,
  ])

  // View row count: use rowOrder length when available so grouping/collapsing
  // can reduce visible rows while model rowCount stays stable.
  // For lazy grouped datasets, compute from lazyGroupMeta (O(groups) not O(rows))
  const rowCount = useMemo(() => {
    if (isLazyGrouped && lazyGroupMeta.length > 0) {
      // Compute total view rows from lazy group metadata
      return lazyGroupMeta.reduce((total, g) => {
        const isCollapsed = collapsedGroups.has(g.key)
        return total + (isCollapsed ? 1 : g.size)
      }, 0)
    }
    return rowOrder.length > 0 ? rowOrder.length : currentDataset?.rowCount ?? 100
  }, [isLazyGrouped, lazyGroupMeta, collapsedGroups, rowOrder.length, currentDataset?.rowCount])

  // Force the grid to redraw the currently visible viewport.
  // OPTIMIZATION: If loadedModelRows is provided, only damage those specific rows to reduce main-thread work.
  // Glide Data Grid may not repaint just because our backing cache changes, so we explicitly "damage" the viewport.
  const scheduleViewportDamage = useCallback((loadedModelRows?: Set<number>) => {
    if (pendingViewportDamageRef.current) return
    pendingViewportDamageRef.current = true

    requestAnimationFrame(() => {
      pendingViewportDamageRef.current = false
      const range = visibleRegionRef.current
      const cells: Array<{ cell: readonly [number, number] }> = []

      const maxCols = Math.max(0, columns.length)
      const frozenCols = Math.min(1, maxCols) // freezeColumns={1}
      const maxRows = Math.max(0, rowCount)
      const startCol = Math.max(0, Math.min(range.x, maxCols))
      const endCol = Math.max(startCol, Math.min(range.x + range.width, maxCols))
      const startRow = Math.max(0, Math.min(range.y, maxRows))
      const endRow = Math.max(startRow, Math.min(range.y + range.height, maxRows))
      const canUseTargetedDamage =
        loadedModelRows &&
        loadedModelRows.size > 0 &&
        (sortColumn === null && groupByColumnId === null ||
          rowOrder.length <= MODEL_TO_VIEW_CACHE_THRESHOLD)

      // OPTIMIZATION: Targeted damage - only repaint loaded rows if specified
      if (canUseTargetedDamage) {
        // Convert model rows to view rows and damage only those
        const viewRowsToUpdate = new Set<number>()
        for (const modelRow of loadedModelRows) {
          const viewRow =
            sortColumn === null && groupByColumnId === null
              ? modelRow
              : modelToView(modelRow)
          if (viewRow >= 0 && viewRow < maxRows) {
            viewRowsToUpdate.add(viewRow)
          }
        }

        // Only damage cells in loaded rows that are visible
        for (const viewRow of viewRowsToUpdate) {
          // Only damage if row is in visible range
          if (viewRow >= startRow && viewRow < endRow) {
            // Damage frozen columns first
            for (let col = 0; col < frozenCols; col++) {
              cells.push({ cell: [col, viewRow] as const })
            }

            // Damage visible non-frozen columns
            for (let col = startCol; col < endCol; col++) {
              if (col < frozenCols) continue
              cells.push({ cell: [col, viewRow] as const })
            }
          }
        }
      } else {
        // Fallback: Damage entire viewport (current behavior)
        // Always include frozen columns (e.g., first column)
        for (let col = 0; col < frozenCols; col++) {
          for (let row = startRow; row < endRow; row++) {
            cells.push({ cell: [col, row] as const })
          }
        }

        // Include the rest of the visible range (non-frozen columns)
        for (let col = startCol; col < endCol; col++) {
          if (col < frozenCols) continue
          for (let row = startRow; row < endRow; row++) {
            cells.push({ cell: [col, row] as const })
          }
        }
      }

      if (cells.length === 0) return
      requestGridRefresh({
        reason: 'viewport-damage',
        scope: 'cells',
        cellUpdates: cells,
      })
    })
  }, [columns.length, rowCount, modelToView, sortColumn, groupByColumnId, rowOrder.length, requestGridRefresh])

  useEffect(() => {
    scheduleViewportDamageRef.current = scheduleViewportDamage
  }, [scheduleViewportDamage])

  // Ensure the grid repaints after dataset/family switches.
  // DataEditor can mount before onVisibleRegionChanged fires, leaving the grid blank until user interaction.
  useEffect(() => {
    if (!currentDataset) return
    let cancelled = false
    let attempts = 0
    const maxAttempts = 8

    const repaint = () => {
      if (cancelled) return
      if (!dataEditorRef.current) {
        if (attempts < maxAttempts) {
          attempts += 1
          requestAnimationFrame(repaint)
        }
        return
      }
      requestGridRefresh({ reason: 'dataset-switch-repaint', scope: 'viewport' })
    }

    requestAnimationFrame(repaint)
    return () => {
      cancelled = true
    }
  }, [currentDataset?.id, requestGridRefresh])

  // Initial streaming load: ensure the first viewport window has data immediately on import.
  // Without this, the grid can appear empty until the user scrolls (onVisibleRegionChanged).
  useEffect(() => {
    if (!currentDataset) return
    if (currentDataset.columns.length === 0) return
    if (rowDataRef.current.size > 0) return

    const datasetId = currentDataset.id
    const resolvedRows = resolveDataRowCount(currentDataset)
    const rowCountModel = Math.max(resolvedRows, currentDataset.rowCount)
    if (rowCountModel <= 0) return
    const initialEnd = Math.min(rowCountModel, BLOCK_SIZE * 2)

    const firstKeepBlock = 0
    const lastKeepBlock = initialEnd > 0 ? Math.floor((initialEnd - 1) / BLOCK_SIZE) : 0
    const keep = new Set<string>()
    for (let block = firstKeepBlock; block <= lastKeepBlock; block++) {
      keep.add(`${datasetId}:block:${block}`)
    }

    wantedBlocksRef.current = keep

    let cancelled = false
    ;(async () => {
      await ensureRangeLoaded(0, initialEnd)
      if (!cancelled) {
        // Force a repaint once the initial rows are loaded so the first column populates immediately.
        requestGridRefresh({ reason: 'initial-streaming-repaint', scope: 'viewport' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    currentDataset?.id,
    currentDataset?.rowCount,
    currentDataset?.columns.length,
    BLOCK_SIZE,
    ensureRangeLoaded,
    requestGridRefresh,
    resolveDataRowCount,
  ])

  // Handle selection changes
  const onSelectionChanged = useCallback(
    (selection: GridSelection) => {
      if (shouldProcessFormulaSelection(gridInteractionModeRef.current)) {
        const formulaHandling = tryInsertReferenceFromSelection(selection)
        if (applyFormulaSelectionHandling(formulaHandling)) {
          return
        }
      }
      setFormulaRangePreview(null)

      // Update local controlled selection state (CRITICAL for editing)
      setGridSelection(selection)

      // Track the "active" cell for the formula bar (always use selection.current)
      if (selection.current && currentDataset) {
        const [colIndex, rowIndex] = selection.current.cell
        const col = currentDataset.columns[colIndex]
        if (col) {
          setActiveCell({ rowIndex, colIndex, columnId: col.id })
        }
      } else {
        setActiveCell(null)
      }

      syncSelectionToStore(selection, currentDataset)

    },
    [applyFormulaSelectionHandling, currentDataset, syncSelectionToStore, tryInsertReferenceFromSelection]
  )

  // Handle column resize (drag column edge to expand/shrink)
  // All columns now have ColumnMetadata, so width changes always persist
  const onColumnResize = useCallback(
    (column: GridColumn, newWidth: number) => {
      if (!currentDataset || !column.id) return

      updateDataset(currentDataset.id, {
        columns: currentDataset.columns.map(col =>
          col.id === column.id ? { ...col, width: newWidth } : col
        ),
      })
    },
    [currentDataset, updateDataset]
  )

  const estimateAutoFitWidth = useCallback(
    (colIndex: number): number => {
      if (!currentDataset) return 88
      const column = currentDataset.columns[colIndex]
      if (!column) return 88

      let maxChars = Math.max(6, column.name.length)
      const sampleLimit = Math.min(rowCount, AUTOFIT_SAMPLE_ROWS)

      for (let viewRow = 0; viewRow < sampleLimit; viewRow += 1) {
        const modelRow = viewToModel(viewRow)
        if (modelRow < 0) continue
        const rowRecord = rowDataRef.current.get(modelRow)
        if (!rowRecord) continue
        const rawValue = rowRecord[column.id]
        if (rawValue === null || rawValue === undefined) continue
        const textValue = String(rawValue)
        if (textValue.length > maxChars) {
          maxChars = textValue.length
        }
      }

      const estimated = Math.round(maxChars * 8 + 28)
      return Math.max(AUTOFIT_MIN_WIDTH, Math.min(AUTOFIT_MAX_WIDTH, estimated))
    },
    [currentDataset, rowCount, viewToModel]
  )

  // Handle cell click for group collapse/expand (Phase 4 - Grouping)
  const onCellActivated = useCallback(
    (cell: Item) => {
      if (
        formulaSessionRef.current?.active &&
        isRangePickFormulaMode(formulaSessionRef.current.mode)
      ) {
        return
      }
      const [colIndex, viewRow] = cell

      // Check if clicking on a group header cell (first column of first row of a group)
      if (colIndex !== 0 || groupMeta.length === 0) return

      const groupForRow = groupMeta.find((g) => viewRow === g.startViewRow)
      if (!groupForRow) return

      // Toggle collapse state
      setCollapsedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(groupForRow.key)) {
          next.delete(groupForRow.key)
        } else {
          next.add(groupForRow.key)
        }
        return next
      })

      // Rebuild grouping with new collapsed state (will be triggered by useEffect below)
    },
    [groupMeta]
  )

  // Handle header click for column renaming or adding new column
  const onHeaderClicked = useCallback(
    (colIndex: number, event?: HeaderClickedEventArgs) => {
      if (!currentDataset) return

      // Check if clicking the virtual "+" column (last column)
      if (colIndex === currentDataset.columns.length) {
        // Clicked the "+" column - add a new column
        handleAddColumn()
        return
      }

      if (event?.isDoubleClick && event.isEdge) {
        const column = currentDataset.columns[colIndex]
        if (!column) return
        const nextWidth = estimateAutoFitWidth(colIndex)
        updateDataset(currentDataset.id, {
          columns: currentDataset.columns.map((col, idx) =>
            idx === colIndex ? { ...col, width: nextWidth } : col
          ),
        })
        return
      }

      const column = currentDataset.columns[colIndex]
      if (!column) return

      // Open custom rename dialog (no "localhost:1420 says" text)
      setRenameDialog({
        isOpen: true,
        colIndex,
        currentName: column.name,
        newName: column.name,
      })
    },
    [currentDataset, estimateAutoFitWidth, handleAddColumn, updateDataset]
  )

  // Handle rename dialog confirm
  const handleRenameConfirm = useCallback(
    async () => {
      if (!renameDialog || !currentDataset) return

      const { colIndex, currentName, newName } = renameDialog
      const { nextName, reservedAutoName } = resolveColumnRenameTarget({
        colIndex,
        requestedName: newName,
        columns: currentDataset.columns,
        allocateAutoName: () => allocateNextAutoColumnName(currentDataset.id),
      })
      const reservedAutoNameConsumed =
        !!reservedAutoName && nextName === reservedAutoName && nextName !== currentName

      if (nextName !== currentName) {
        const updatedColumns = currentDataset.columns.map((col, idx) =>
          idx === colIndex ? { ...col, name: nextName } : col
        )

        // Update frontend data-store
        updateDataset(currentDataset.id, {
          columns: updatedColumns,
        })

        // Sync to backend (Apache Arrow integration)
        try {
          await tauriApi.updateDatasetMetadata(currentDataset.id, updatedColumns)
        } catch (error) {
          console.error('Failed to sync column rename to backend:', error)
        }

        // Mark project dirty after renaming column
        useAppStore.getState().setProjectDirty(true)
      }

      if (reservedAutoName && !reservedAutoNameConsumed) {
        rollbackAutoColumnNameAllocation(currentDataset.id, reservedAutoName)
      }

      setRenameDialog(null)
    },
    [
      renameDialog,
      currentDataset,
      updateDataset,
      allocateNextAutoColumnName,
      rollbackAutoColumnNameAllocation,
    ]
  )

  const copySelectionToClipboard = useCallback(async () => {
    if (!currentDataset || !gridSelection.current) {
      console.warn('No selection available for copy')
      return
    }

    const { x, y, width, height } = gridSelection.current.range
    if (width <= 0 || height <= 0) {
      return
    }

    const selectedColumnIds: string[] = []
    for (let colIndex = x; colIndex < x + width; colIndex++) {
      const gridColumn = columns[colIndex]
      if (gridColumn?.id) {
        selectedColumnIds.push(gridColumn.id)
      }
    }

    if (selectedColumnIds.length === 0) {
      return
    }

    const lines: string[] = []
    for (let viewRow = y; viewRow < y + height; viewRow++) {
      if (viewRow >= rowCount) {
        break
      }
      const modelRow = viewToModel(viewRow) // Convert view → model
      const rowRecord = rowDataRef.current.get(modelRow) || {} // Use modelRow for data access
      const cells = selectedColumnIds.map(columnId => {
        const value = rowRecord[columnId]
        return value === undefined || value === null ? '' : String(value)
      })
      lines.push(cells.join('\t'))
    }

    try {
      await clipboard.write(lines.join('\n'))
    } catch (error) {
      console.error('Failed to copy selection to clipboard:', error)
    }
  }, [columns, currentDataset, gridSelection, rowCount, viewToModel])

  // Expose clipboard actions to parent toolbars (ActionToolbar)
  useEffect(() => {
    onCopyRequest?.(copySelectionToClipboard)
  }, [copySelectionToClipboard, onCopyRequest])

  // Cut selection to clipboard - copy then clear using EditExecutor
  const cutToClipboard = useCallback(async () => {
    if (!currentDataset || !gridSelection.current || !editExecutor) {
      console.warn('No selection available for cut')
      return
    }

    const { x, y, width, height } = gridSelection.current.range
    if (width <= 0 || height <= 0) {
      return
    }

    // First, copy to clipboard (same logic as copy)
    const selectedColumnIds: string[] = []
    for (let colIndex = x; colIndex < x + width; colIndex++) {
      const gridColumn = columns[colIndex]
      if (gridColumn?.id) {
        selectedColumnIds.push(gridColumn.id)
      }
    }

    if (selectedColumnIds.length === 0) {
      return
    }

    const lines: string[] = []
    const edits: CellEdit[] = []

    for (let viewRow = y; viewRow < y + height; viewRow++) {
      if (viewRow >= rowCount) {
        break
      }
      const modelRow = viewToModel(viewRow) // Convert view → model
      const rowRecord = rowDataRef.current.get(modelRow) || {} // Use modelRow for data access
      const cells = selectedColumnIds.map(columnId => {
        const value = rowRecord[columnId]
        return value === undefined || value === null ? '' : String(value)
      })
      lines.push(cells.join('\t'))

      // Build edits to clear each cell
      selectedColumnIds.forEach(columnId => {
        const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow
        edits.push({
          row: modelRow, // Use modelRow for edit
          columnId,
          oldValue,
          newValue: '', // Clear the cell
        })
      })
    }

    // Copy to clipboard first
    try {
      await clipboard.write(lines.join('\n'))
    } catch (error) {
      console.error('Failed to copy selection to clipboard:', error)
      return // Don't clear if copy failed
    }

    // Clear cells using EditExecutor with 'cut' source
    if (edits.length > 0) {
      await editExecutor.execute(edits, 'cut')
      syncFormulasToStore()

      // Force grid to repaint cleared cells so UI matches state
      requestAnimationFrame(() => {
        const cellUpdates = buildCellUpdates(edits)
        if (cellUpdates.length > 0) {
          scheduleCellUpdates(cellUpdates)
        }
      })
    }
  }, [columns, currentDataset, editExecutor, getCellRawValueForUndo, gridSelection, rowCount, syncFormulasToStore, viewToModel, modelToView, buildCellUpdates, scheduleCellUpdates])

  useEffect(() => {
    onCutRequest?.(cutToClipboard)
  }, [cutToClipboard, onCutRequest])

  // Delete selection - clears cells and unregisters formulas via EditExecutor
  const deleteSelection = useCallback(async () => {
    if (!currentDataset || !gridSelection.current || !editExecutor) {
      return
    }

    const { x, y, width, height } = gridSelection.current.range
    if (width <= 0 || height <= 0) {
      return
    }

    const selectedColumnIds: string[] = []
    for (let colIndex = x; colIndex < x + width; colIndex++) {
      const gridColumn = columns[colIndex]
      if (gridColumn?.id) {
        selectedColumnIds.push(gridColumn.id)
      }
    }

    if (selectedColumnIds.length === 0) {
      return
    }

    const edits: CellEdit[] = []
    for (let viewRow = y; viewRow < y + height; viewRow++) {
      if (viewRow >= rowCount) {
        break
      }

      const modelRow = viewToModel(viewRow) // Convert view → model

      // Build edits to clear each cell
      selectedColumnIds.forEach(columnId => {
        const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow
        edits.push({
          row: modelRow, // Use modelRow for edit
          columnId,
          oldValue,
          newValue: '', // Clear the cell
        })
      })
    }

    // Clear cells using EditExecutor with 'delete' source
    // This will trigger formulaService.unregisterFormula() in Step 7
    if (edits.length > 0) {
      await editExecutor.execute(edits, 'delete')
      syncFormulasToStore()

      // Force grid to repaint cleared cells so UI matches state
      requestAnimationFrame(() => {
        const cellUpdates = buildCellUpdates(edits)
        if (cellUpdates.length > 0) {
          scheduleCellUpdates(cellUpdates)
        }
      })
    }
  }, [columns, currentDataset, editExecutor, getCellRawValueForUndo, gridSelection, rowCount, syncFormulasToStore, viewToModel, modelToView, buildCellUpdates, scheduleCellUpdates])

  /**
   * Transpose a 2D array (swap rows ↔ columns)
   * Example: [[1,2,3], [4,5,6]] → [[1,4], [2,5], [3,6]]
   */
  const transposeArray = (data: string[][]): string[][] => {
    if (data.length === 0) return []
    const rows = data.length
    const cols = data.reduce((max, row) => Math.max(max, row?.length ?? 0), 0)

    const transposed: string[][] = []
    for (let col = 0; col < cols; col++) {
      transposed[col] = []
      for (let row = 0; row < rows; row++) {
        transposed[col]![row] = data[row]?.[col] ?? ''
      }
    }
    return transposed
  }

  const normalizePastedFormulaReferences = useCallback((data: string[][]) => {
    let converted = false
    const normalized = data.map((rowValues) =>
      rowValues.map((value) => {
        const trimmed = value.trimStart()
        if (!trimmed.startsWith('=')) {
          return value
        }
        const stripped = stripSheetQualifiedReferences(value)
        if (stripped.converted) {
          converted = true
        }
        return stripped.text
      })
    )
    return { normalized, converted }
  }, [])

  // Paste anchor resolution:
  // - context-menu actions should start at the clicked context cell
  // - keyboard/toolbar actions should start at current selection origin
  const resolvePasteStart = useCallback(
    (preferContextTarget: boolean): { startCol: number; startViewRow: number } | null => {
      if (preferContextTarget && contextMenu.isOpen && contextMenu.target.kind === 'cell') {
        return {
          startCol: contextMenu.target.colIndex,
          startViewRow: contextMenu.target.rowIndex,
        }
      }

      const current = gridSelectionRef.current.current
      if (!current) return null
      const { x, y, width, height } = current.range
      if (width <= 0 || height <= 0) return null
      return { startCol: x, startViewRow: y }
    },
    [contextMenu.isOpen, contextMenu.target]
  )

  // Paste transpose from clipboard (Ctrl+T) - swaps rows ↔ columns
  const pasteTransposeFromClipboard = useCallback(async (preferContextTarget: boolean = false) => {
    if (!currentDataset || !gridSelection.current || !editExecutor) {
      console.warn('No selection available for paste transpose')
      return
    }
    const capturedDatasetId = currentDataset.id

    const pasteStart = resolvePasteStart(preferContextTarget)
    if (!pasteStart) {
      return
    }
    const { startCol, startViewRow } = pasteStart

    // Read clipboard text
    let clipboardText: string
    try {
      clipboardText = await clipboard.read()
    } catch (error) {
      console.error('Failed to read clipboard contents:', error)
      return
    }

    if (!clipboardText) {
      return
    }

    // Parse clipboard text into 2D array
    const parsedData = parseClipboardText(clipboardText)
    if (parsedData.length === 0) {
      return
    }
    if (currentDatasetIdRef.current !== capturedDatasetId) {
      return
    }

    // 🔄 TRANSPOSE: Swap rows ↔ columns
    const transposedData = transposeArray(parsedData)
    const {
      normalized: normalizedTransposedData,
      converted: convertedSheetReferences,
    } = normalizePastedFormulaReferences(transposedData)

    if (groupByColumnId !== null) {
      const hasFormula = normalizedTransposedData.some(rowValues =>
        rowValues.some(value => {
          if (typeof value !== 'string') return false
          return formulaService?.isFormula(value) ?? value.trim().startsWith('=')
        })
      )
      if (hasFormula) {
        toast.info('Formulas are disabled while grouped.')
        return
      }
    }

    // Build edits array with old values for undo support
    const edits: CellEdit[] = []
    normalizedTransposedData.forEach((rowValues, rowOffset) => {
      const viewRow = startViewRow + rowOffset
      if (viewRow >= rowCount) {
        return
      }
      const modelRow = viewToModel(viewRow)

      rowValues.forEach((value, colOffset) => {
        const gridColumn = columns[startCol + colOffset]
        if (!gridColumn?.id) {
          return
        }
        const columnId = gridColumn.id

        // Get old value for undo support
        const oldValue = getCellRawValueForUndo(modelRow, columnId)

        edits.push({
          row: modelRow,
          columnId,
          oldValue,
          newValue: value,
        })
      })
    })

    if (edits.length === 0) {
      return
    }
    if (currentDatasetIdRef.current !== capturedDatasetId) {
      return
    }

    // Use EditExecutor (scoped to datasetId) with 'paste-transpose' source
    await editExecutor.execute(edits, 'paste-transpose')
    if (currentDatasetIdRef.current !== capturedDatasetId) {
      return
    }
    syncFormulasToStore()

    // Promote buffer rows to data rows if pasted
    const maxPastedRow = Math.max(...edits.map(e => e.row))
    bumpDataRowCount(maxPastedRow)

    // Force grid repaint for pasted cells
    requestAnimationFrame(() => {
      const cellUpdates = buildCellUpdates(edits)
      if (cellUpdates.length > 0) {
        scheduleCellUpdates(cellUpdates)
      }
    })

    if (convertedSheetReferences) {
      toast.info('Converted external sheet references to active-grid references.')
    }
    toast.success('Pasted transposed data')
  }, [
    columns,
    currentDataset,
    editExecutor,
    getCellRawValueForUndo,
    gridSelection,
    rowCount,
    syncFormulasToStore,
    viewToModel,
    buildCellUpdates,
    scheduleCellUpdates,
    groupByColumnId,
    formulaService,
    bumpDataRowCount,
    resolvePasteStart,
    normalizePastedFormulaReferences,
  ])

  // Paste from clipboard - uses EditExecutor for unified edit pipeline
  const pasteFromClipboard = useCallback(async (preferContextTarget: boolean = false) => {
    if (!currentDataset || !gridSelection.current || !editExecutor) {
      console.warn('No selection available for paste')
      return
    }

    const pasteStart = resolvePasteStart(preferContextTarget)
    if (!pasteStart) {
      return
    }
    const { startCol, startViewRow } = pasteStart

    // Read clipboard text
    let clipboardText: string
    try {
      clipboardText = await clipboard.read()
    } catch (error) {
      console.error('Failed to read clipboard contents:', error)
      return
    }

    if (!clipboardText) {
      return
    }

    // Parse clipboard text into 2D array
    const parsedData = parseClipboardText(clipboardText)
    if (parsedData.length === 0) {
      return
    }
    const {
      normalized: normalizedParsedData,
      converted: convertedSheetReferences,
    } = normalizePastedFormulaReferences(parsedData)

    if (groupByColumnId !== null) {
      const hasFormula = normalizedParsedData.some(rowValues =>
        rowValues.some(value => {
          if (typeof value !== 'string') return false
          return formulaService?.isFormula(value) ?? value.trim().startsWith('=')
        })
      )
      if (hasFormula) {
        toast.info('Formulas are disabled while grouped.')
        return
      }
    }

    // Build edits array with old values for undo support
    const edits: CellEdit[] = []
    normalizedParsedData.forEach((rowValues, rowOffset) => {
      const viewRow = startViewRow + rowOffset
      if (viewRow >= rowCount) {
        return
      }
      const modelRow = viewToModel(viewRow) // Convert view → model

      rowValues.forEach((value, colOffset) => {
        const gridColumn = columns[startCol + colOffset]
        if (!gridColumn?.id) {
          return
        }
        const columnId = gridColumn.id

        // Get old value for undo support
        const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow

        edits.push({
          row: modelRow, // Use modelRow for edit
          columnId,
          oldValue,
          newValue: value,
        })
      })
    })

    if (edits.length === 0) {
      return
    }

    // Use EditExecutor for unified pipeline (all 7 side effects guaranteed)
    await editExecutor.execute(edits, 'paste')
    syncFormulasToStore()

    // Promote buffer rows to data rows if pasted
    const maxPastedRow = Math.max(...edits.map(e => e.row))
    bumpDataRowCount(maxPastedRow)

    // Force grid repaint for pasted cells
    requestAnimationFrame(() => {
      const cellUpdates = buildCellUpdates(edits)
      if (cellUpdates.length > 0) {
        scheduleCellUpdates(cellUpdates)
      }
    })
    if (convertedSheetReferences) {
      toast.info('Converted external sheet references to active-grid references.')
    }
  }, [
    columns,
    currentDataset,
    editExecutor,
    formulaService,
    getCellRawValueForUndo,
    gridSelection,
    rowCount,
    syncFormulasToStore,
    viewToModel,
    modelToView,
    bumpDataRowCount,
    groupByColumnId,
    buildCellUpdates,
    scheduleCellUpdates,
    resolvePasteStart,
    normalizePastedFormulaReferences,
  ])

  const pasteValuesOnlyFromClipboard = useCallback(async (preferContextTarget: boolean = false) => {
    if (!currentDataset || !gridSelection.current || !editExecutor) {
      console.warn('No selection available for paste values')
      return
    }

    const pasteStart = resolvePasteStart(preferContextTarget)
    if (!pasteStart) {
      return
    }
    const { startCol, startViewRow } = pasteStart

    let clipboardText: string
    try {
      clipboardText = await clipboard.read()
    } catch (error) {
      console.error('Failed to read clipboard contents:', error)
      return
    }

    if (!clipboardText) {
      return
    }

    const parsedData = parseClipboardText(clipboardText)
    if (parsedData.length === 0) {
      return
    }
    const {
      normalized: normalizedParsedData,
      converted: convertedSheetReferences,
    } = normalizePastedFormulaReferences(parsedData)

    const edits: CellEdit[] = []
    normalizedParsedData.forEach((rowValues, rowOffset) => {
      const viewRow = startViewRow + rowOffset
      if (viewRow >= rowCount) {
        return
      }
      const modelRow = viewToModel(viewRow)

      rowValues.forEach((value, colOffset) => {
        const targetCol = startCol + colOffset
        const gridColumn = columns[targetCol]
        if (!gridColumn?.id) {
          return
        }
        const columnId = gridColumn.id
        const oldValue = getCellRawValueForUndo(modelRow, columnId)

        let newValue: unknown = value
        if (typeof value === 'string' && value.trim().startsWith('=')) {
          // Values-only paste must be deterministic and destination-independent.
          // Keep plain text content instead of evaluating as a formula.
          newValue = value.trimStart().slice(1)
        }

        edits.push({
          row: modelRow,
          columnId,
          oldValue,
          newValue,
        })
      })
    })

    if (edits.length === 0) {
      return
    }

    await editExecutor.execute(edits, 'paste')
    syncFormulasToStore()

    const maxPastedRow = Math.max(...edits.map((e) => e.row))
    bumpDataRowCount(maxPastedRow)

    requestAnimationFrame(() => {
      const cellUpdates = buildCellUpdates(edits)
      if (cellUpdates.length > 0) {
        scheduleCellUpdates(cellUpdates)
      }
    })
    if (convertedSheetReferences) {
      toast.info('Converted external sheet references to active-grid references.')
    }
  }, [
    buildCellUpdates,
    bumpDataRowCount,
    columns,
    currentDataset,
    editExecutor,
    formulaService,
    getCellRawValueForUndo,
    gridSelection,
    rowCount,
    scheduleCellUpdates,
    syncFormulasToStore,
    viewToModel,
    resolvePasteStart,
    normalizePastedFormulaReferences,
  ])

  useEffect(() => {
    onPasteRequest?.(pasteFromClipboard)
  }, [onPasteRequest, pasteFromClipboard])

  useEffect(() => {
    onUndoRequest?.(performUndo)
  }, [onUndoRequest, performUndo])

  useLayoutEffect(() => {
    if (!onInsertMenuRequest) return
    const openInsertMenu = (x: number, y: number) => {
      const menuWidth = 220
      const menuHeight = 190
      const padding = 8
      const maxX = Math.max(padding, window.innerWidth - menuWidth - padding)
      const maxY = Math.max(padding, window.innerHeight - menuHeight - padding)
      const clampedX = Math.min(Math.max(x, padding), maxX)
      const clampedY = Math.min(Math.max(y, padding), maxY)
      const selectedCell = gridSelectionRef.current.current?.cell
      const anchorColumnIndex =
        activeCellRef.current?.colIndex ??
        selectedCell?.[0] ??
        (currentDataset ? currentDataset.columns.length : 0)
      const anchorRowIndex =
        activeCellRef.current?.rowIndex ??
        selectedCell?.[1] ??
        rowOrderRef.current.length
      ignoreNextInsertMenuWindowClickRef.current = true
      setInsertMenu({
        isOpen: true,
        x: clampedX,
        y: clampedY,
        columnIndex: Math.max(0, anchorColumnIndex),
        rowIndex: Math.max(0, anchorRowIndex),
      })
    }

    onInsertMenuRequest(openInsertMenu)
    return () => {
      onInsertMenuRequest(null)
    }
  }, [onInsertMenuRequest, currentDataset?.columns.length])

  // Stable keyboard shortcuts (capture phase) to avoid missed key events during re-renders
  // and to ensure Delete works even if the grid stops propagation.
  useKeyboardShortcuts(
    {
      onCopy: () => {
        if (!currentDataset || !gridSelection.current) return false
        void copySelectionToClipboard()
        return true
      },
      onPaste: () => {
        if (!currentDataset || !gridSelection.current || !editExecutor) return false
        void pasteFromClipboard()
        return true
      },
      onPasteValues: () => {
        if (!currentDataset || !gridSelection.current || !editExecutor) return false
        void pasteValuesOnlyFromClipboard()
        return true
      },
      onCut: () => {
        if (!currentDataset || !gridSelection.current || !editExecutor) return false
        void cutToClipboard()
        return true
      },
      onTranspose: () => {
        if (typeof window === 'undefined' || !('__TAURI__' in window)) {
          return false
        }
        if (!currentDataset || !gridSelection.current || !editExecutor) return false
        void pasteTransposeFromClipboard()
        return true
      },
      onDelete: () => {
        if (!currentDataset || !gridSelection.current || !editExecutor) return false
        void deleteSelection()
        return true
      },
      onFind: () => {
        if (!currentDataset) return false
        setFindReplaceMode('find')
        setFindReplaceOpen(true)
        return true
      },
      onFindReplace: () => {
        if (!currentDataset) return false
        setFindReplaceMode('replace')
        setFindReplaceOpen(true)
        return true
      },
      onFindNext: () => {
        // F3 - Navigate to next match (only if dialog is open and has matches)
        if (!findReplaceOpen || findReplaceMatches.length === 0) return false
        const nextIndex = (currentMatchIndex + 1) % findReplaceMatches.length
        setCurrentMatchIndex(nextIndex)
        const match = findReplaceMatches[nextIndex]
        if (match) navigateToCell(match.modelRow, match.columnId)
        return true
      },
      onFindPrevious: () => {
        // Shift+F3 - Navigate to previous match
        if (!findReplaceOpen || findReplaceMatches.length === 0) return false
        const prevIndex = (currentMatchIndex - 1 + findReplaceMatches.length) % findReplaceMatches.length
        setCurrentMatchIndex(prevIndex)
        const match = findReplaceMatches[prevIndex]
        if (match) navigateToCell(match.modelRow, match.columnId)
        return true
      },
      onUndo: () => {
        // Ctrl+Z - Undo last operation (try highlights first, then cell edits)
        if (!currentDataset) return false

        // Try to undo highlight first
        if (undoHighlight()) return true

        // Fall back to dataset undo (supports structural operations)
        void performUndo()
        return true
      },
      onRedo: () => {
        // Ctrl+Y - Redo last undone operation (try highlights first, then cell edits)
        if (!currentDataset) return false

        // Try to redo highlight first
        if (redoHighlight()) return true

        // Fall back to dataset redo (supports structural operations)
        void performRedo()
        return true
      },
      onRecalculate: () => {
        if (!currentDataset || !editExecutor || !formulaService) return false
        void recalculateVolatileFormulas()
        return true
      },
      onHighlight: () => {
        // Ctrl+Shift+H - Show highlight color picker
        if (!currentDataset || !gridSelection.current) return false

        const selectedCell = gridSelection.current.cell
        const [colIndex, rowIndex] = selectedCell

        let anchorPoint: { x: number; y: number } | null = null
        const cellBounds = dataEditorRef.current?.getBounds(colIndex, rowIndex)
        if (cellBounds) {
          anchorPoint = localToViewportPoint(
            cellBounds.x + cellBounds.width + CONTEXT_MENU_ANCHOR_GAP,
            cellBounds.y
          )
        } else {
          const gridRect = gridContainerRef.current?.getBoundingClientRect()
          if (gridRect) {
            anchorPoint = {
              x: Math.round(gridRect.left + CONTEXT_MENU_ANCHOR_GAP),
              y: Math.round(gridRect.top + CONTEXT_MENU_ANCHOR_GAP),
            }
          }
        }
        if (!anchorPoint) return false

        openContextMenu(anchorPoint.x, anchorPoint.y, { kind: 'cell', colIndex, rowIndex })
        setContextMenu(prev =>
          prev.isOpen
            ? {
                ...prev,
                showColorPicker: true,
                showPasteOptions: false,
                showInsertOptions: false,
              }
            : prev
        )

        return true
      },
    },
    { capture: true, containerRef: gridContainerRef }
  )

  // Fill pattern - handles drag-to-fill gesture (Excel-like)
  const handleFillPattern = useCallback(
    async (event: FillPatternEventArgs) => {
      if (!currentDataset || !editExecutor || !formulaService) {
        return
      }
      const hasActiveSessionRef = !!formulaSessionRef.current?.active
      if (shouldBlockFillPattern(hasActiveSessionRef, gridInteractionModeRef.current)) {
        event.preventDefault()
        return
      }

      // Use our own fill pipeline (EditExecutor + FormulaService)
      // and cancel Glide's built-in fill behavior to avoid double-processing.
      event.preventDefault()
      setGridInteractionMode('fill_drag')
      gridInteractionModeRef.current = 'fill_drag'

      try {
        const { patternSource, fillDestination } = event
        const edits: CellEdit[] = []

        // Determine fill direction
        const fillDown = fillDestination.y > patternSource.y
        const fillRight = fillDestination.x > patternSource.x
        const fillUp = fillDestination.y < patternSource.y
        const fillLeft = fillDestination.x < patternSource.x

        // Process each column in the fill destination
        for (let destCol = fillDestination.x; destCol < fillDestination.x + fillDestination.width; destCol++) {
          const gridColumn = columns[destCol]
          if (!gridColumn?.id) continue
          const columnId = gridColumn.id

          // Determine source column (wraps if filling is wider than source)
          const sourceColOffset = (destCol - fillDestination.x) % patternSource.width
          const sourceCol = patternSource.x + sourceColOffset

          // Gather source values from this column
          const sourceValues: unknown[] = []
          for (let sourceViewRow = patternSource.y; sourceViewRow < patternSource.y + patternSource.height; sourceViewRow++) {
            const sourceModelRow = viewToModel(sourceViewRow) // Convert view → model for data access
            const sourceValue = getCellRawValueForUndo(sourceModelRow, gridColumn.id)
            sourceValues.push(sourceValue)
          }

          // Decide fill mode for this column (copy or series)
          const fillMode = decideFillMode(sourceValues)

          // Process each row in the fill destination
          for (let destViewRow = fillDestination.y; destViewRow < fillDestination.y + fillDestination.height; destViewRow++) {
            // Skip cells that are in the source (no need to fill)
            const isInSource =
              destViewRow >= patternSource.y &&
              destViewRow < patternSource.y + patternSource.height &&
              destCol >= patternSource.x &&
              destCol < patternSource.x + patternSource.width

            if (isInSource) continue

            // Determine source cell for this target
            const sourceRowOffset = (destViewRow - fillDestination.y) % patternSource.height
            const sourceViewRow = patternSource.y + sourceRowOffset
            const sourceModelRow = viewToModel(sourceViewRow) // Convert view → model for data access
            const destModelRow = viewToModel(destViewRow) // Convert view → model for data access

            const sourceValue = getCellRawValueForUndo(sourceModelRow, columnId)
            const oldValue = getCellRawValueForUndo(destModelRow, columnId)

            let newValue: unknown

            // If source is a formula, shift references
            // CRITICAL: Use VIEW rows for formula pattern (view-relative semantics!)
            if (formulaService.isFormula(sourceValue)) {
              const fromPos = { row: sourceViewRow + 1, col: sourceCol + 1 } // VIEW row (1-based)
              const toPos = { row: destViewRow + 1, col: destCol + 1 } // VIEW row (1-based)
              newValue = formulaService.getFilledFormula(sourceValue as string, fromPos, toPos)
            } else {
              // For values, use fill mode logic
              // Calculate target index relative to end of source block
              let targetIndex: number

              if (fillDown) {
                targetIndex = destViewRow - (patternSource.y + patternSource.height)
              } else if (fillUp) {
                targetIndex = patternSource.y - destViewRow - 1
              } else if (fillRight) {
                targetIndex = destCol - (patternSource.x + patternSource.width)
              } else if (fillLeft) {
                targetIndex = patternSource.x - destCol - 1
              } else {
                targetIndex = 0
              }

              newValue = computeFilledValue(fillMode, sourceValues, targetIndex)
            }

            edits.push({
              row: destModelRow, // Use MODEL row for edit storage
              columnId,
              oldValue,
              newValue,
            })
          }
        }

        if (edits.length === 0) {
          return
        }

        // Execute all fill edits in one batch
        await editExecutor.execute(edits, 'fill')
        syncFormulasToStore()

        // Keep grid selection + store selection metadata aligned with the applied fill range.
        const currentSelection = gridSelectionRef.current
        if (currentSelection.current) {
          const nextSelection: GridSelection = {
            ...currentSelection,
            current: {
              ...currentSelection.current,
              range: fillDestination,
            },
          }
          setGridSelection(nextSelection)
          syncSelectionToStore(nextSelection, currentDataset)
        }

        // Promote buffer rows to data rows if filled
        const maxFilledRow = Math.max(...edits.map(e => e.row))
        bumpDataRowCount(maxFilledRow)

        // Force grid repaint for filled cells
        requestAnimationFrame(() => {
          const cellUpdates = buildCellUpdates(edits)
          if (cellUpdates.length > 0) {
            scheduleCellUpdates(cellUpdates)
          }
        })
      } finally {
        setGridInteractionMode(resolveModeAfterFill(formulaSessionRef.current))
        gridInteractionModeRef.current = resolveModeAfterFill(formulaSessionRef.current)
      }
    },
    [bumpDataRowCount, buildCellUpdates, columns, currentDataset, editExecutor, formulaService, getCellRawValueForUndo, scheduleCellUpdates, shouldBlockFillPattern, syncFormulasToStore, syncSelectionToStore, viewToModel]
  )

  const handleGridDoubleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!currentDataset || isLazyGrouped) return

      const currentRange = gridSelectionRef.current.current?.range
      if (!currentRange) return

      const hasActiveSessionRef = !!formulaSessionRef.current?.active
      if (shouldBlockFillPattern(hasActiveSessionRef, gridInteractionModeRef.current)) return
      if (!shouldEnableFillHandle(hasActiveFormulaSession)) return

      const fillHandleCol = currentRange.x + currentRange.width - 1
      const fillHandleRow = currentRange.y + currentRange.height - 1
      if (fillHandleCol < 0 || fillHandleRow < 0) return

      const cellBounds = dataEditorRef.current?.getBounds(fillHandleCol, fillHandleRow)
      if (!cellBounds) return

      const localPoint = {
        x: event.clientX,
        y: event.clientY,
      }
      if (!isPointInFillHandleZone(cellBounds, localPoint)) return

      const dataRowCount = resolveDataRowCount(currentDataset)
      if (dataRowCount <= 0 || rowCount <= 0) return

      let lastDataViewRow = -1
      for (let candidateViewRow = rowCount - 1; candidateViewRow >= 0; candidateViewRow--) {
        const modelRow = viewToModel(candidateViewRow)
        if (modelRow >= 0 && modelRow < dataRowCount) {
          lastDataViewRow = candidateViewRow
          break
        }
      }

      if (lastDataViewRow < 0) return

      const fillDestination = buildAutoFillDownDestination(currentRange, lastDataViewRow)
      if (!fillDestination) return

      event.preventDefault()
      event.stopPropagation()

      void handleFillPattern({
        patternSource: currentRange,
        fillDestination,
        preventDefault: () => undefined,
      })
    },
    [
      currentDataset,
      handleFillPattern,
      hasActiveFormulaSession,
      isLazyGrouped,
      resolveDataRowCount,
      rowCount,
      shouldBlockFillPattern,
      viewToModel,
    ]
  )

  // Note: Undo/redo keyboard shortcuts (Ctrl+Z / Ctrl+Y) are now handled by
  // useKeyboardShortcuts hook above (Windows/Excel standard shortcuts)

  const handleHeaderContextMenu = useCallback(
    (colIndex: number, event: HeaderClickedEventArgs) => {
      event.preventDefault()
      const point = contextEventToViewportAnchor(event)
      openContextMenu(point.x, point.y, { kind: 'header', colIndex })
    },
    [contextEventToViewportAnchor, openContextMenu]
  )

  const handleCellContextMenu = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      event.preventDefault()
      const [colIndex, rowIndex] = cell
      const currentSelection = gridSelectionRef.current
      const current = currentSelection.current
      const currentRange = current?.range
      const rangeContainsCell = (
        range: { x: number; y: number; width: number; height: number } | undefined
      ) =>
        !!range &&
        colIndex >= range.x &&
        colIndex < range.x + range.width &&
        rowIndex >= range.y &&
        rowIndex < range.y + range.height
      const insideCurrentSelection =
        rangeContainsCell(currentRange) ||
        currentSelection.rows.hasIndex(rowIndex) ||
        currentSelection.columns.hasIndex(colIndex) ||
        Boolean(current?.rangeStack?.some(range => rangeContainsCell(range)))

      // Preserve GDG selection invariants:
      // - If right-click is inside current selection, keep selection unchanged.
      // - If outside, move to a single-cell selection at the clicked cell.
      if (currentDataset && !insideCurrentSelection) {
        const nextSelection: GridSelection = {
          current: {
            cell: [colIndex, rowIndex],
            range: { x: colIndex, y: rowIndex, width: 1, height: 1 },
            rangeStack: [],
          },
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        }
        setGridSelection(nextSelection)
        syncSelectionToStore(nextSelection, currentDataset)
      }
      const point = contextEventToViewportAnchor(event)
      openContextMenu(point.x, point.y, { kind: 'cell', colIndex, rowIndex })
    },
    [contextEventToViewportAnchor, currentDataset, openContextMenu, syncSelectionToStore]
  )

  // Find & Replace: Navigation callback to scroll to and select a cell
  const navigateToCell = useCallback(
    (modelRow: number, columnId: string) => {
      if (!currentDataset) return

      // Convert model row to view row via current rowOrder
      const viewRow = rowOrder.indexOf(modelRow)
      if (viewRow === -1) {
        // Row is in a collapsed group or not currently visible
        toast.info('Match is in a collapsed group. Expand the group to see it.')
        return
      }

      // Find column index
      const colIndex = columnIndexById.get(columnId)
      if (colIndex === undefined) return

      // Update selection to highlight the cell
      setGridSelection({
        current: {
          cell: [colIndex, viewRow],
          range: { x: colIndex, y: viewRow, width: 1, height: 1 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })

        // Scroll the cell into view
        dataEditorRef.current?.scrollTo(colIndex, viewRow)
      },
      [currentDataset, rowOrder, columnIndexById]
    )

  // Find & Replace: Callback to update highlighted matches
  const handleHighlightMatches = useCallback(
    (matches: SearchMatch[], currentIndex: number) => {
      setFindReplaceMatches(matches)
      setCurrentMatchIndex(currentIndex)
    },
    []
  )

  // Find & Replace: Generate highlight regions for matches
    const findReplaceHighlightRegions = useMemo((): Highlight[] => {
      if (!findReplaceMatches.length || !currentDataset) return []

      return findReplaceMatches
        .map((match, idx) => {
          const viewRow = rowOrder.indexOf(match.modelRow)
          if (viewRow === -1) return null // Row is in collapsed group or not visible

          const colIndex = columnIndexById.get(match.columnId)
          if (colIndex === undefined) return null

          return {
            color: idx === currentMatchIndex ? '#FFEB3B80' : '#FFF59D40', // Current match is brighter
            range: { x: colIndex, y: viewRow, width: 1, height: 1 },
          }
        })
        .filter((r): r is Highlight => r !== null)
    }, [findReplaceMatches, currentMatchIndex, rowOrder, currentDataset, columnIndexById])

  // Combine formula highlighting with Find/Replace highlighting
  const combinedHighlightRegions = useMemo(() => {
    const preview = formulaRangePreview ? [formulaRangePreview] : []
    // Keep formula token highlights visible during range-pick for stable visual feedback,
    // while layering preview on top of static references.
    return [...highlightedRegions, ...preview, ...findReplaceHighlightRegions]
  }, [highlightedRegions, formulaRangePreview, findReplaceHighlightRegions])

  // Get selected column IDs for Find/Replace scope
  // Calculate from current selection range (works for both cell ranges and column header clicks)
  const selectedColumnIds = useMemo(() => {
    if (!gridSelection?.current || !currentDataset) return undefined

    const { x, width } = gridSelection.current.range
    if (width <= 0) return undefined

    const selected: string[] = []
    for (let colIndex = x; colIndex < x + width; colIndex++) {
      const col = currentDataset.columns[colIndex]
      if (col?.id) {
        selected.push(col.id)
      }
    }

    return selected.length > 0 ? selected : undefined
  }, [gridSelection, currentDataset])

  const contextColumnIndex = useMemo(() => {
    if (!currentDataset) return null
    if (contextMenu.target.kind === 'header') {
      return contextMenu.target.colIndex
    }
    if (contextMenu.target.kind === 'cell') {
      return contextMenu.target.colIndex
    }
    if (gridSelection.current) {
      return gridSelection.current.cell[0]
    }
    return null
  }, [contextMenu.target, currentDataset, gridSelection.current])

  const contextRowIndex = useMemo(() => {
    if (contextMenu.target.kind === 'cell') {
      return contextMenu.target.rowIndex
    }
    if (gridSelection.current) {
      return gridSelection.current.cell[1]
    }
    return null
  }, [contextMenu.target, gridSelection.current])

  const insertMenuColumnIndex = useMemo(() => {
    if (!currentDataset) return 0
    return Math.max(0, Math.min(insertMenu.columnIndex, currentDataset.columns.length))
  }, [insertMenu.columnIndex, currentDataset])

  const insertMenuRowIndex = useMemo(() => {
    return Math.max(0, Math.min(insertMenu.rowIndex, rowOrder.length))
  }, [insertMenu.rowIndex, rowOrder.length])

  const canInsertColumnFromContext =
    currentDataset !== null &&
    contextColumnIndex !== null &&
    contextColumnIndex >= 0 &&
    contextColumnIndex <= currentDataset.columns.length

  const canInsertRowFromContext =
    currentDataset !== null &&
    contextRowIndex !== null &&
    contextRowIndex >= 0 &&
    contextRowIndex <= rowOrder.length

  const showRowInsertItems =
    canInsertRowFromContext && contextMenu.target.kind !== 'header'

  const insertSubmenuEstimatedHeight = useMemo(() => {
    const rowCount = (canInsertColumnFromContext ? 2 : 0) + (showRowInsertItems ? 2 : 0)
    const hasDivider = canInsertColumnFromContext && showRowInsertItems
    const rowHeight = 34
    const dividerHeight = hasDivider ? 8 : 0
    return Math.max(88, rowCount * rowHeight + dividerHeight + 12)
  }, [canInsertColumnFromContext, showRowInsertItems])

  useLayoutEffect(() => {
    if (!contextMenu.isOpen) {
      return
    }
    const menuElement = contextMenuRef.current
    if (!menuElement) {
      return
    }
    const rect = menuElement.getBoundingClientRect()
    const clamped = clampMenuToViewport(contextMenu.x, contextMenu.y, rect.width, rect.height)
    if (clamped.x !== contextMenu.x || clamped.y !== contextMenu.y) {
      setContextMenu(prev =>
        prev.isOpen
          ? {
              ...prev,
              x: clamped.x,
              y: clamped.y,
            }
          : prev
      )
    }
  }, [
    clampMenuToViewport,
    contextMenu.isOpen,
    contextMenu.showColorPicker,
    contextMenu.showInsertOptions,
    contextMenu.showPasteOptions,
    contextMenu.x,
    contextMenu.y,
  ])

  useEffect(() => {
    if (!contextMenu.isOpen || !contextMenu.showInsertOptions) {
      setInsertSubmenuPlacement(null)
      return
    }
    setInsertSubmenuPlacement(
      computeSubmenuPlacement(
        insertOptionsTriggerRef.current,
        188,
        insertSubmenuEstimatedHeight
      )
    )
  }, [
    computeSubmenuPlacement,
    contextMenu.isOpen,
    contextMenu.showInsertOptions,
    contextMenu.x,
    contextMenu.y,
    insertSubmenuEstimatedHeight,
  ])

  useEffect(() => {
    if (!contextMenu.isOpen || !contextMenu.showPasteOptions) {
      setPasteSubmenuPlacement(null)
      return
    }
    setPasteSubmenuPlacement(
      computeSubmenuPlacement(
        pasteOptionsTriggerRef.current,
        186,
        132
      )
    )
  }, [
    computeSubmenuPlacement,
    contextMenu.isOpen,
    contextMenu.showPasteOptions,
    contextMenu.x,
    contextMenu.y,
  ])

  useEffect(() => {
    if (!contextMenu.isOpen || !contextMenu.showColorPicker) {
      setFillColorSubmenuPlacement(null)
      return
    }
    setFillColorSubmenuPlacement(
      computeSubmenuPlacement(
        fillColorTriggerRef.current,
        180,
        214
      )
    )
  }, [
    computeSubmenuPlacement,
    contextMenu.isOpen,
    contextMenu.showColorPicker,
    contextMenu.x,
    contextMenu.y,
  ])

  const formulaBarDisplayText = useMemo(() => {
    if (hasActiveFormulaSession && activeFormulaSessionSource === 'cell') {
      return formulaBarText
    }
    if (isFormulaBarFocused) {
      return formulaBarText
    }
    if (
      activeCell &&
      formulaService &&
      formulaService.hasFormula(`${viewToModel(activeCell.rowIndex)}:${activeCell.columnId}`)
    ) {
      return (
        formulaService.getFormattedFormula(
          `${viewToModel(activeCell.rowIndex)}:${activeCell.columnId}`,
          (columnId) => columnMetadataMap.get(columnId)?.name
        ) ?? formulaBarText
      )
    }
    return formulaBarText
  }, [
    activeFormulaSessionSource,
    activeCell,
    columnMetadataMap,
    formulaBarText,
    formulaService,
    hasActiveFormulaSession,
    isFormulaBarFocused,
    viewToModel,
  ])

  const formulaBarTokenSegments = useMemo(
    () =>
      buildFormulaBarTokenSegments(
        formulaBarDisplayText,
        spreadsheetPalette.inputText,
        getFormulaBarTokenTextColors(resolvedTheme)
      ),
    [formulaBarDisplayText, resolvedTheme, spreadsheetPalette.inputText]
  )

  const showFormulaBarTokenOverlay =
    isFormulaBarFocused &&
    formulaBarDisplayText.startsWith('=') &&
    formulaBarTokenSegments.length > 0

  return (
    <>
      {/* Loading Overlay for long operations (Phase 4) */}
      {loadingOperation && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
          }}
        >
          <LoadingOverlay operation={loadingOperation} />
        </div>
      )}

      {/* Column Rename Dialog */}
      {renameDialog && (
        <div
          data-testid="column-rename-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
          onClick={() => setRenameDialog(null)}
        >
          <div
            data-testid="column-rename-dialog"
            style={{
              backgroundColor: spreadsheetPalette.menuBg,
              padding: '24px',
              borderRadius: '8px',
              minWidth: '400px',
              border: `1px solid ${spreadsheetPalette.menuBorder}`,
              boxShadow: spreadsheetPalette.menuShadow,
              color: spreadsheetPalette.menuText,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 600, color: spreadsheetPalette.menuText }}>
              Rename Column
            </h3>
            <input
              type="text"
              value={renameDialog.newName}
              onChange={(e) =>
                setRenameDialog({ ...renameDialog, newName: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameConfirm()
                if (e.key === 'Escape') setRenameDialog(null)
              }}
              autoFocus
              style={{
                width: '100%',
                padding: '8px 12px',
                border: `1px solid ${spreadsheetPalette.inputBorder}`,
                borderRadius: '4px',
                fontSize: '14px',
                marginBottom: '16px',
                backgroundColor: spreadsheetPalette.formulaBarBg,
                color: spreadsheetPalette.inputText,
                caretColor: spreadsheetPalette.inputCaret,
              }}
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setRenameDialog(null)}
                style={{
                  padding: '8px 16px',
                  border: `1px solid ${spreadsheetPalette.menuBorder}`,
                  borderRadius: '4px',
                  backgroundColor: spreadsheetPalette.menuBg,
                  color: spreadsheetPalette.menuText,
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleRenameConfirm}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '4px',
                  backgroundColor: '#3B82F6',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sort Dialog (Phase 3) */}
      <SortDialog
        isOpen={showSortDialog}
        onClose={() => setShowSortDialog(false)}
        columns={currentDataset?.columns || []}
        currentSortColumn={sortColumn}
        currentSortDirection={sortDirection}
        onSort={performSort}
        onClearSort={clearSort}
      />

      {/* Outline Dialog (Phase 4 - Visual Grouping) */}
      <OutlineDialog
        open={showGroupDialog}
        onOpenChange={setShowGroupDialog}
        columnMetadata={currentDataset?.columns || []}
        currentOutlineColumnId={groupByColumnId}
        onApply={(columnId) => {
          setGroupByColumnId(columnId)
          if (!columnId) {
            setCollapsedGroups(new Set())
          }
        }}
      />

      <div
        className={className}
        style={{
          height,
          width,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Formula bar (Phase 7b) - Sort/Group buttons moved to ActionToolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            marginTop: '4px', // Spacing after ActionToolbar
            borderBottom: `1px solid ${spreadsheetPalette.formulaBarBorder}`,
            backgroundColor: spreadsheetPalette.formulaBarBg,
          }}
        >
          <div
            style={{
              minWidth: '110px',
              fontSize: '12px',
              color: spreadsheetPalette.formulaBarLabel,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={
              activeCell && currentDataset
                ? `${currentDataset.columns[activeCell.colIndex]?.name ?? ''}`
                : undefined
            }
          >
            {activeCell && currentDataset
              ? `${columnIndexToLetter(activeCell.colIndex)}${activeCell.rowIndex + 1} • ${
                  currentDataset.columns[activeCell.colIndex]?.name ?? ''
                }`
              : 'Formula'}
          </div>

          <div style={{ position: 'relative', flex: 1 }}>
            {showFormulaBarTokenOverlay && (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  height: '28px',
                  padding: '0 10px',
                  border: '1px solid transparent',
                  borderRadius: '6px',
                  fontSize: '13px',
                  lineHeight: '26px',
                  whiteSpace: 'pre',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {formulaBarTokenSegments.map((segment, idx) => (
                  <span key={`formula-bar-token-${idx}`} style={{ color: segment.color }}>
                    {segment.text}
                  </span>
                ))}
              </div>
            )}
            <input
              ref={formulaBarInputRef}
              type="text"
              value={formulaBarDisplayText}
            onFocus={() => {
              setIsFormulaBarFocused(true)
              const activeSession = formulaSessionRef.current
              const focusAction = getFormulaBarFocusAction(
                activeSession
                  ? { active: activeSession.active, source: activeSession.source }
                  : null,
                'focus_bar'
              )
              if (focusAction === 'restore_bar_session' && activeSession) {
                const safeStart = Math.max(0, Math.min(activeSession.caretStart, activeSession.text.length))
                const safeEnd = Math.max(0, Math.min(activeSession.caretEnd, activeSession.text.length))
                setFormulaBarText(activeSession.text)
                updateFormulaBarSuggestions(activeSession.text, safeStart)
                requestAnimationFrame(() => {
                  const input = formulaBarInputRef.current
                  if (!input) return
                  input.setSelectionRange(safeStart, safeEnd)
                })
                return
              }
              if (focusAction === 'migrate_cell_session') {
                const migrated = migrateCellFormulaSessionToBar(false, true)
                if (migrated) {
                  return
                }
              }
              if (activeCell) {
                const modelRow = viewToModel(activeCell.rowIndex) // Convert view → model
                const raw = formulaService?.getFormula(`${modelRow}:${activeCell.columnId}`) // Use modelRow
                if (raw !== undefined) {
                  setFormulaBarText(raw)
                  updateFormulaBarSuggestions(raw, raw.length)
                  updateFormulaBarSession(raw, raw.length, raw.length)
                  requestAnimationFrame(() => {
                    const input = formulaBarInputRef.current
                    if (!input) return
                    input.setSelectionRange(raw.length, raw.length)
                  })
                } else {
                  updateFormulaBarSession(formulaBarText, formulaBarText.length, formulaBarText.length)
                }
              } else {
                updateFormulaBarSession(formulaBarText, formulaBarText.length, formulaBarText.length)
              }
            }}
            onBlur={() => {
              if (formulaBarSuggestionClickRef.current) {
                formulaBarSuggestionClickRef.current = false
                return
              }
              setIsFormulaBarFocused(false)
              const session = formulaSessionRef.current
              if (session?.source === 'bar' && isRangePickFormulaMode(session.mode)) {
                const pointerTarget = lastPointerDownTargetRef.current instanceof Element
                  ? lastPointerDownTargetRef.current
                  : null
                const clickedIntoFormulaUi =
                  !!pointerTarget && (
                    pointerTarget.closest('.formula-autocomplete-dropdown') !== null ||
                    formulaBarInputRef.current?.contains(pointerTarget) === true ||
                    gridContainerRef.current?.contains(pointerTarget) === true
                  )
                clearFormulaBarSuggestions()
                if (clickedIntoFormulaUi) {
                  return
                }
                clearFormulaSession('bar')
                return
              }

              if (session?.source !== 'bar') {
                clearFormulaBarSuggestions()
                clearFormulaSession('bar')
                return
              }

              clearFormulaBarSuggestions()
              void commitFormulaBarEdit().then((committed) => {
                if (committed) {
                  clearFormulaSession('bar')
                  return
                }
                requestAnimationFrame(() => {
                  formulaBarInputRef.current?.focus()
                })
              }).catch((err) => {
                console.error('Failed to apply formula bar edit on blur:', err)
                requestAnimationFrame(() => {
                  formulaBarInputRef.current?.focus()
                })
              })
            }}
            onChange={(e) => {
              const newText = e.target.value
              const caret = e.target.selectionStart ?? newText.length
              setFormulaBarText(newText)
              updateFormulaBarSuggestions(newText, caret)
              updateFormulaBarSession(newText, caret, caret)
            }}
            onSelect={() => {
              updateFormulaBarSession(formulaBarText)
            }}
            onKeyDown={(e) => {
              // Handle autocomplete navigation
              if (formulaBarSuggestions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  navigateFormulaBarSuggestionDown()
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  navigateFormulaBarSuggestionUp()
                  return
                }
                if (e.key === 'Tab') {
                  e.preventDefault()
                  insertFormulaBarSuggestionAtCaret()
                  return
                }
              }

              if (e.key === 'F4' && !e.altKey && !e.ctrlKey && !e.metaKey) {
                const input = e.currentTarget
                const caretStart = input.selectionStart ?? formulaBarText.length
                const caretEnd = input.selectionEnd ?? caretStart
                const toggled = toggleAbsoluteReferenceAtCaret(formulaBarText, caretStart, caretEnd)
                if (toggled) {
                  e.preventDefault()
                  setFormulaBarText(toggled.text)
                  updateFormulaBarSuggestions(toggled.text, toggled.caretStart)
                  updateFormulaBarSession(toggled.text, toggled.caretStart, toggled.caretEnd)
                  requestAnimationFrame(() => {
                    const nextInput = formulaBarInputRef.current
                    if (!nextInput) return
                    nextInput.focus()
                    nextInput.setSelectionRange(toggled.caretStart, toggled.caretEnd)
                  })
                }
                return
              }

              const activeSession = formulaSessionRef.current
              const isBarRangePick =
                !!activeSession?.active &&
                activeSession.source === 'bar' &&
                isRangePickFormulaMode(activeSession.mode)
              if (
                isBarRangePick &&
                (e.key === 'ArrowUp' ||
                  e.key === 'ArrowDown' ||
                  e.key === 'ArrowLeft' ||
                  e.key === 'ArrowRight')
              ) {
                e.preventDefault()
                const movement: readonly [-1 | 0 | 1, -1 | 0 | 1] =
                  e.key === 'ArrowUp'
                    ? [0, -1]
                    : e.key === 'ArrowDown'
                      ? [0, 1]
                      : e.key === 'ArrowLeft'
                        ? [-1, 0]
                        : [1, 0]
                moveFormulaRangePickSelection(movement, e.shiftKey)
                return
              }

              if (e.key === 'Enter') {
                e.preventDefault()
                // Try autocomplete first, otherwise commit edit
                if (formulaBarSuggestions.length > 0) {
                  insertFormulaBarSuggestionAtCaret()
                } else {
                  const input = e.currentTarget
                  void commitFormulaBarEdit().then((committed) => {
                    if (!committed) {
                      return
                    }
                    clearFormulaSession('bar')
                    input.blur()
                  }).catch((err) => {
                    console.error('Failed to apply formula bar edit:', err)
                  })
                }
              }
              if (e.key === 'Escape') {
                // Hide autocomplete first, otherwise blur
                if (formulaBarSuggestions.length > 0) {
                  clearFormulaBarSuggestions()
                } else {
                  setIsFormulaBarFocused(false)
                  if (activeCell) {
                    const modelRow = viewToModel(activeCell.rowIndex) // Convert view → model
                    const raw = getCellRawValueForUndo(modelRow, activeCell.columnId) // Use modelRow
                    setFormulaBarText(raw === null || raw === undefined ? '' : String(raw))
                  }
                  clearFormulaSession('bar')
                  ;(e.target as HTMLInputElement).blur()
                }
              }
            }}
            placeholder="Type a value or formula (e.g., =A1+1)"
            style={{
              height: '28px',
              padding: '0 10px',
              border: `1px solid ${spreadsheetPalette.inputBorder}`,
              borderRadius: '6px',
              fontSize: '13px',
              outline: 'none',
              width: '100%',
              backgroundColor: 'transparent',
              color: showFormulaBarTokenOverlay ? 'transparent' : spreadsheetPalette.inputText,
              caretColor: spreadsheetPalette.inputCaret,
            }}
          />
          </div>

          {/* Autocomplete Suggestions Dropdown */}
          {isFormulaBarFocused &&
            formulaBarSuggestions.length > 0 &&
            formulaBarAutocompletePlacement && (
            <AutocompleteDropdown
              suggestions={formulaBarSuggestions}
              selectedIndex={formulaBarSuggestionIndex}
              position={{
                top: formulaBarAutocompletePlacement.top,
                left: formulaBarAutocompletePlacement.left,
              }}
              onSelect={(index) => {
                selectFormulaBarSuggestionIndex(index)
                insertFormulaBarSuggestionAtCaret(index)
                requestAnimationFrame(() => {
                  formulaBarSuggestionClickRef.current = false
                })
              }}
              onHover={(index) => selectFormulaBarSuggestionIndex(index)}
              positionMode="fixed"
              usePortal={true}
              width={formulaBarAutocompletePlacement.width}
              minWidth={formulaBarAutocompletePlacement.width}
              maxWidth={formulaBarAutocompletePlacement.width}
              maxHeight={formulaBarAutocompletePlacement.maxHeight}
              signature={formulaBarSuggestionSignature ?? undefined}
              onInteractionStart={() => {
                formulaBarSuggestionClickRef.current = true
              }}
            />
          )}
        </div>

        {/* Data Grid - centered with max width like TreeDataGrid */}
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div
            ref={gridContainerRef}
            onDoubleClickCapture={handleGridDoubleClickCapture}
            style={{
              width: '100%',
              overflow: 'hidden',
            }}
          >
          {currentDataset && currentDataset.columns.length > 0 ? (
            <DataEditor
              key={`grid-${currentDataset?.id ?? 'blank'}-${gridRevision}`}
              ref={dataEditorRef}
              columns={columns}
              rows={rowCount}
              className="min-w-full min-h-full"
              getCellContent={getCellContent}
              getCellsForSelection={true}
              gridSelection={gridSelection}
              onCellEdited={onCellEdited}
              onCellActivated={onCellActivated}
              onGridSelectionChange={onSelectionChanged}
              onColumnResize={onColumnResize}
              onHeaderClicked={onHeaderClicked}
              onHeaderContextMenu={handleHeaderContextMenu}
              onCellContextMenu={handleCellContextMenu}
              isOutsideClick={isEditorOutsideClick}
              onPaste={false}
              fillHandle={shouldEnableFillHandle(hasActiveFormulaSession)}
              onFillPattern={handleFillPattern}
              provideEditor={provideEditor}
              onVisibleRegionChanged={handleVisibleRegionChanged}
              smoothScrollX={true}
              smoothScrollY={true}
              freezeColumns={1} // Keep first column (typically ID/Sample) visible while scrolling
              rowMarkers="both"
              rowHeight={28} // Compact row height like TreeDataGrid
              // Enable column resizing (drag header edge)
              columnSelect="single"
              // Theme customization - SukiUI Blue theme
              theme={dataEditorTheme}
              // Cell reference highlighting when typing formulas
              highlightRegions={combinedHighlightRegions}
            />
          ) : (
            <div
              style={{
                height: '100%',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: spreadsheetPalette.emptyText,
                fontSize: '13px',
              }}
            >
              {loadingOperation ? 'Loading project...' : 'No dataset loaded'}
            </div>
          )}
          </div>
        </div>
      </div>

      {/* Find & Replace Dialog */}
      {currentDataset && (
        <FindReplaceDialog
          isOpen={findReplaceOpen}
          mode={findReplaceMode}
          onClose={() => setFindReplaceOpen(false)}
          onModeChange={setFindReplaceMode}
          datasetId={currentDataset.id}
          columns={currentDataset.columns}
          dataRowCount={resolveDataRowCount(currentDataset)}
          formulaService={formulaService}
          editExecutor={editExecutor}
          selectedColumnIds={selectedColumnIds}
          onNavigateToCell={navigateToCell}
          onHighlightMatches={handleHighlightMatches}
        />
      )}

      {insertMenu.isOpen && (
        <div
          style={{
            position: 'fixed',
            top: insertMenu.y,
            left: insertMenu.x,
            zIndex: 10020,
            padding: '2px 0',
            minWidth: '188px',
            ...menuSurfaceStyle,
          }}
          onClick={event => event.stopPropagation()}
        >
          <button
            onClick={() => {
              void handleInsertColumnAt(insertMenuColumnIndex)
              closeInsertMenu()
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '6px 12px',
              fontSize: '13px',
            }}
          >
            Insert Column Left
          </button>
          <button
            onClick={() => {
              void handleInsertColumnAt(insertMenuColumnIndex + 1)
              closeInsertMenu()
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '6px 12px',
              fontSize: '13px',
            }}
          >
            Insert Column Right
          </button>
          <div style={{ ...menuDividerStyle, margin: '2px 0' }} />
          <button
            onClick={() => {
              void handleInsertRowAt(insertMenuRowIndex)
              closeInsertMenu()
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '6px 12px',
              fontSize: '13px',
            }}
          >
            Insert Row Above
          </button>
          <button
            onClick={() => {
              void handleInsertRowAt(insertMenuRowIndex + 1)
              closeInsertMenu()
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '6px 12px',
              fontSize: '13px',
            }}
          >
            Insert Row Below
          </button>
        </div>
      )}

      {contextMenu.isOpen && (
        <div
          ref={contextMenuRef}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 10000,
            minWidth: '156px',
            padding: '2px 0',
            ...menuSurfaceStyle,
          }}
          onClick={event => event.stopPropagation()}
        >
          {(canInsertColumnFromContext || showRowInsertItems) && (
            <div style={{ position: 'relative' }}>
              <button
                ref={insertOptionsTriggerRef}
                onClick={() => {
                  setContextMenu(prev => ({
                    ...prev,
                    showInsertOptions: !prev.showInsertOptions,
                    showPasteOptions: false,
                  }))
                }}
                style={{
                  ...menuButtonBaseStyle,
                  padding: '6px 12px',
                  fontSize: '13px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>Insert Options</span>
                <span style={{ fontSize: '12px' }}>
                  {insertSubmenuPlacement?.direction === 'left' ? '◂' : '▸'}
                </span>
              </button>
              {contextMenu.showInsertOptions && (
                <div
                  style={{
                    position: 'fixed',
                    left: insertSubmenuPlacement?.x ?? contextMenu.x,
                    top: insertSubmenuPlacement?.y ?? contextMenu.y,
                    padding: '2px 0',
                    minWidth: '188px',
                    zIndex: 10001,
                    ...menuSurfaceStyle,
                  }}
                  onClick={e => e.stopPropagation()}
                >
                  {canInsertColumnFromContext && (
                    <>
                      <button
                        onClick={() => {
                          const target = contextColumnIndex ?? 0
                          void handleInsertColumnAt(target)
                          closeContextMenu()
                        }}
                        style={{
                          ...menuButtonBaseStyle,
                          padding: '6px 12px',
                          fontSize: '13px',
                        }}
                      >
                        Insert Column Left
                      </button>
                      <button
                        onClick={() => {
                          const target = (contextColumnIndex ?? -1) + 1
                          void handleInsertColumnAt(target)
                          closeContextMenu()
                        }}
                        style={{
                          ...menuButtonBaseStyle,
                          padding: '6px 12px',
                          fontSize: '13px',
                        }}
                      >
                        Insert Column Right
                      </button>
                    </>
                  )}
                  {canInsertColumnFromContext && showRowInsertItems && (
                    <div style={{ ...menuDividerStyle, margin: '2px 0' }} />
                  )}
                  {showRowInsertItems && (
                    <>
                      <button
                        onClick={() => {
                          const target = contextRowIndex ?? 0
                          void handleInsertRowAt(target)
                          closeContextMenu()
                        }}
                        style={{
                          ...menuButtonBaseStyle,
                          padding: '6px 12px',
                          fontSize: '13px',
                        }}
                      >
                        Insert Row Above
                      </button>
                      <button
                        onClick={() => {
                          const target = (contextRowIndex ?? -1) + 1
                          void handleInsertRowAt(target)
                          closeContextMenu()
                        }}
                        style={{
                          ...menuButtonBaseStyle,
                          padding: '6px 12px',
                          fontSize: '13px',
                        }}
                      >
                        Insert Row Below
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {(canInsertColumnFromContext || showRowInsertItems) && (
            <div style={{ ...menuDividerStyle, margin: '2px 0' }} />
          )}
          <button
            onClick={() => {
              copySelectionToClipboard().finally(closeContextMenu)
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '6px 12px',
              fontSize: '13px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>Copy</span>
            <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+C</span>
          </button>
          <button
            onClick={() => {
              cutToClipboard().finally(closeContextMenu)
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '6px 12px',
              fontSize: '13px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>Cut</span>
            <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+X</span>
          </button>
          {/* Paste Options */}
          <div style={{ position: 'relative' }}>
            <button
              ref={pasteOptionsTriggerRef}
              onClick={() => {
                setContextMenu(prev => ({
                  ...prev,
                  showPasteOptions: !prev.showPasteOptions,
                  showInsertOptions: false,
                }))
              }}
              style={{
                ...menuButtonBaseStyle,
                padding: '6px 12px',
                fontSize: '13px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>Paste Options</span>
              <span style={{ fontSize: '12px' }}>
                {pasteSubmenuPlacement?.direction === 'left' ? '◂' : '▸'}
              </span>
            </button>
            {contextMenu.showPasteOptions && (
              <div
                style={{
                  position: 'fixed',
                  left: pasteSubmenuPlacement?.x ?? contextMenu.x,
                  top: pasteSubmenuPlacement?.y ?? contextMenu.y,
                  padding: '2px 0',
                  minWidth: '186px',
                  zIndex: 10001,
                  ...menuSurfaceStyle,
                }}
                onClick={e => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    pasteFromClipboard(true).finally(closeContextMenu)
                  }}
                  style={{
                    ...menuButtonBaseStyle,
                    padding: '6px 12px',
                    fontSize: '13px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>Paste</span>
                  <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+V</span>
                </button>
                <button
                  onClick={() => {
                    pasteValuesOnlyFromClipboard(true).finally(closeContextMenu)
                  }}
                  style={{
                    ...menuButtonBaseStyle,
                    padding: '6px 12px',
                    fontSize: '13px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>Paste Values</span>
                  <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+Shift+V</span>
                </button>
                <button
                  onClick={() => {
                    pasteTransposeFromClipboard(true).finally(closeContextMenu)
                  }}
                  style={{
                    ...menuButtonBaseStyle,
                    padding: '6px 12px',
                    fontSize: '13px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>Paste Transpose</span>
                  <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+T</span>
                </button>
              </div>
            )}
          </div>
          <div style={{ ...menuDividerStyle, margin: '4px 0' }} />

          {/* Fill Color - Excel-style split button */}
          <div style={{ position: 'relative', display: 'flex' }}>
            {/* Main button - applies current fill color */}
            <button
              onClick={() => {
                applyHighlight(currentFillColor) // Apply current fill color (default yellow)
              }}
              style={{
                flex: 1,
                padding: '8px 12px',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                fontSize: '14px',
                cursor: 'pointer',
                color: spreadsheetPalette.menuText,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = spreadsheetPalette.menuHoverBg
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              {/* Paint bucket icon with current color underline */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                <PaintBucket size={16} weight="fill" style={{ color: spreadsheetPalette.menuIcon }} aria-hidden="true" focusable="false" />
                <div style={{ width: '16px', height: '3px', backgroundColor: currentFillColor, borderRadius: '1px' }} />
              </div>
              <span>Fill Color</span>
              <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+Shift+H</span>
            </button>
            {/* Dropdown arrow - opens color picker */}
            <button
              ref={fillColorTriggerRef}
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(prev => ({ ...prev, showColorPicker: !prev.showColorPicker }))
              }}
              aria-label="Open fill color picker"
              aria-haspopup="menu"
              aria-expanded={contextMenu.showColorPicker}
              style={{
                padding: '8px 12px',
                background: 'none',
                border: 'none',
                borderLeft: `1px solid ${spreadsheetPalette.menuBorder}`,
                fontSize: '12px',
                cursor: 'pointer',
                color: spreadsheetPalette.menuText,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = spreadsheetPalette.menuHoverBg
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              {fillColorSubmenuPlacement?.direction === 'left' ? '◂' : '▸'}
            </button>
            {contextMenu.showColorPicker && (
              <div
                style={{
                  position: 'fixed',
                  left: fillColorSubmenuPlacement?.x ?? contextMenu.x,
                  top: fillColorSubmenuPlacement?.y ?? contextMenu.y,
                  padding: '8px',
                  minWidth: '180px',
                  zIndex: 10001,
                  ...menuSurfaceStyle,
                }}
                onClick={e => e.stopPropagation()}
              >
                <div style={{ marginBottom: '8px', fontSize: '12px', color: spreadsheetPalette.menuMutedText, paddingLeft: '4px' }}>
                  Highlight Colors
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(5, 1fr)',
                    gap: '6px',
                    marginBottom: '8px',
                  }}
                >
                  {/* Excel-style color palette */}
                  {[
                    { name: 'Yellow', color: '#FFEB3B' },
                    { name: 'Orange', color: '#FF9800' },
                    { name: 'Red', color: '#F44336' },
                    { name: 'Pink', color: '#E91E63' },
                    { name: 'Purple', color: '#9C27B0' },
                    { name: 'Blue', color: '#2196F3' },
                    { name: 'Cyan', color: '#00BCD4' },
                    { name: 'Teal', color: '#009688' },
                    { name: 'Green', color: '#4CAF50' },
                    { name: 'Lime', color: '#CDDC39' },
                  ].map(({ name, color }) => (
                    <button
                      key={color}
                      onClick={() => applyHighlight(color)}
                      title={name}
                      style={{
                        width: '28px',
                        height: '28px',
                        backgroundColor: color,
                        border: `1px solid ${spreadsheetPalette.menuBorder}`,
                        borderRadius: '4px',
                        cursor: 'pointer',
                        transition: 'transform 0.1s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.transform = 'scale(1.1)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.transform = 'scale(1)'
                      }}
                    />
                  ))}
                </div>
                <div style={{ ...menuDividerStyle, paddingTop: '8px' }}>
                  <button
                    onClick={() => applyHighlight(null)}
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      textAlign: 'left',
                      background: 'none',
                      border: `1px solid ${spreadsheetPalette.menuBorder}`,
                      borderRadius: '4px',
                      fontSize: '13px',
                      cursor: 'pointer',
                      color: spreadsheetPalette.menuMutedText,
                    }}
                  >
                    ✕ No Fill
                  </button>
                </div>
              </div>
            )}
          </div>
          <div style={{ ...menuDividerStyle, margin: '4px 0' }} />
          <button
            onClick={() => {
              setFindReplaceMode('replace')
              setFindReplaceOpen(true)
              closeContextMenu()
            }}
            style={{
              ...menuButtonBaseStyle,
              padding: '8px 16px',
              fontSize: '14px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>Find and Replace</span>
            <span style={{ color: spreadsheetPalette.menuMutedText, fontSize: '12px' }}>Ctrl+H</span>
          </button>
        </div>
      )}
    </>
  )
}

export default SpreadsheetView
