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

import { useCallback, useMemo, useState, useEffect, useLayoutEffect, useReducer, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { flushSync } from 'react-dom'
import { debounce } from 'lodash'
import { toast } from 'sonner'
import {
  DataEditor,
  type DataEditorRef,
  GridCell,
  GridCellKind,
  GridColumn,
  GridColumnMenuIcon,
  Item,
  EditableGridCell,
  GridSelection,
  Theme,
  CompactSelection,
  FillPatternEventArgs,
  type CellClickedEventArgs,
  type HeaderClickedEventArgs,
  type Highlight,
  type Rectangle,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useDataStore } from '@/store/data-store'
import { useAppStore, ensureProjectId } from '@/store/app-store'
import type { ColumnMetadata, Dataset } from '@/store/data-store'
import { tauriApi } from '@/services/tauriApi'
import cacheService from '@/services/cacheService'
import type { DatasetStorageInfo } from '@/services/cacheService'
import { confirm } from '@tauri-apps/plugin-dialog'
import { makeExcelComparator } from '@/lib/grid/sortComparator'
import type { SortKey } from '@/lib/grid/sortCycle'
import { coerceEditValue } from '@/lib/grid/coerceEditValue'
import { numericSemantics } from '@/lib/grid/semantics/numeric'
import { createEditExecutor } from '@/lib/grid/editExecutor'
import { getEditRowBounds } from '@/lib/grid/editBounds'
import {
  createUndoGridTransaction,
  createGridMutationCoordinator,
  resolveGridBlockLoadState,
  shouldQueueGridBlockLoad,
} from '@/lib/grid/gridMutationCoordinator'
import type {
  GridBlockState,
  GridMutationCoordinator,
  GridMutationKind,
  GridMutationQueueState,
  GridTransactionRecord,
} from '@/lib/grid/types'
import { decideFillMode, computeFilledValue } from '@/lib/grid/fillUtils'
import { buildAutoFillDownDestination, isPointInFillHandleZone } from '@/lib/grid/fillHandleAutoFill'
import type { CellEdit } from '@/lib/grid/types'
import { clipboard, formatForClipboard, parseClipboardText } from '@/lib/grid/clipboard'
import {
  computeAffectedBlockKeys,
  computeRequiredDataRowsForPaste,
  computePastePreflight,
  resolvePasteLoopBounds,
  isViewTransformActive,
  buildNewColumnDrafts,
  applyColumnExpansion,
  decidePasteOverflow,
  resolveTransformAwareRowCap,
  planInsertedRowsForPaste,
} from '@/lib/grid/pastePreflight'
import { buildPasteEditsInChunks } from '@/lib/grid/pasteEditBuilder'
import { expandClipboardForSelection } from '@/lib/grid/pasteRangeUtils'
import { buildBackendPasteBlock } from '@/lib/grid/backendPasteBlock'
import {
  applyLargePasteUndoPolicy,
  LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD,
} from '@/lib/grid/largePasteUndoPolicy'
import { runSingleChunkPasteJob, type PasteJobLockController, type PasteJobSource } from '@/lib/grid/pasteJob'
import {
  cloneRowDataPreservingSentinel,
  createRowDataSentinel,
  isRowDataSentinel,
} from '@/lib/grid/rowDataSentinel'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'
import { undoService, type UndoOperation } from '@/services/undoService'
import { createFormulaService, columnIndexToLetter, FormulaService, type AsyncAggregateRequest, type BackendEvalRequest, type FormulaEdit } from '@/lib/grid/formulas/formulaService'
import {
  extractFormulaReferenceRegions,
  extractFormulaReferenceTokenSpans,
} from '@/lib/grid/formulas/formulaUtils'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useTheme } from '@/hooks/use-theme'
import { getViewStateCache, setViewStateCache } from '@/lib/grid/viewStateCache'
import { computeSchemaKey } from '@/lib/grid/viewStateSchema'
import { filterColumnsWithData } from '@/lib/grid/columnsWithData'
import { createFullDatasetScope, type GridViewScope } from '@/lib/grid/gridViewScope'
import {
  buildRowId as buildGridRowId,
  createGridViewModel,
  parseRowId as parseGridRowId,
  type GridViewModel,
  type OverlayCell,
} from '@/lib/grid/gridViewModel'
import { FormulaCellEditor, type FormulaEditorBridge, type FormulaSessionSnapshot } from './FormulaCellEditor'
import { AutocompleteDropdown } from './AutocompleteDropdown'
import { SortDialog } from '@/components/dialogs/SortDialog'
import { OutlineDialog } from '@/components/dialogs/OutlineDialog'
import { FindReplaceDialog } from '@/components/dialogs/FindReplaceDialog'
import { AdvancedFilterDialog } from '@/components/dialogs/AdvancedFilterDialog'
import { applyViewFilter } from '@/lib/grid/viewFilter'
import { useFilterHistory } from '@/lib/grid/useFilterHistory'
import { buildFullRowsByIndex, ViewFilterError } from '@/lib/grid/filterColumnsSnapshot'
import type { FilterConfig, FilterCondition } from '@/services/dataTransformService'
import { ColumnFilterPopoverContent } from './ColumnFilterPopover'
import { mergeColumnConditions, extractColumnConditions, deriveUniqueFilterValues, buildScopedFilterConfig } from '@/lib/grid/filterConfigHelpers'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { PaintBucket } from '@phosphor-icons/react'
import type { SearchMatch } from '@/lib/grid/findReplace'
import { LoadingOverlay } from '@/components/ui/LoadingOverlay'
import { getTransformPreflight } from '@/utils/transformPreflight'
import { computeLoweredDataRowCount } from '@/lib/datasetRows'
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
import { computeDataRowCountPromotion } from '@/lib/grid/pastePreflight'

// Temporary structured telemetry for paste/copy race diagnosis. DEV-only — silent in prod.
// Remove after one release window once the race is confirmed resolved.
const logTelemetry = import.meta.env.DEV
  ? (...args: Parameters<typeof console.log>) => console.log(...args)
  : () => {}

const PASTE_BACKEND_SYNC_CHUNK_SIZE = 5_000
const PASTE_BUILD_CHUNK_ROWS = 5_000
const BACKEND_PASTE_BLOCK_THRESHOLD = LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD + 1
const MAX_BACKEND_PASTE_BLOCK_CELLS = 500_000
const BACKEND_PASTE_UNDO_SHAPE_ERROR =
  'Backend paste undo data was invalid. Paste was applied but undo was not recorded.'

function isBackendPasteUndoShapeValid(
  rows: number[],
  columnIds: string[],
  oldValues: unknown[][]
): boolean {
  return Array.isArray(oldValues)
    && oldValues.length === rows.length
    && oldValues.every(
      (rowValues) => Array.isArray(rowValues) && rowValues.length === columnIds.length
    )
}

type PasteProgressHandle = {
  update: (updates: {
    stage?: string
    progress?: number
    indeterminate?: boolean
    operation?: string
  }) => void
}

interface GridSyncFailureNotice {
  datasetId: string
  transactionId: string
  message: string
  retrying: boolean
}

interface CurrentPasteTimingBuckets {
  datasetId: string
  source: 'paste' | 'paste-values' | 'paste-transpose' | 'e2e-paste'
  rowCount: number
  columnCount: number
  editCount: number
  oldValueLookupCount: number
  editBuildDurationMs: number
  prepareStartedAt?: number
  prepareDurationMs?: number
  executeStartedAt?: number
  executeDurationMs?: number
  flushStartedAt?: number
  overlayFlushDurationMs?: number
  hydrateStartedAt?: number
  hydrateDurationMs?: number
  hydratePendingBlockKeys?: Set<string>
  hydrateCompletedBlockCount?: number
}

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

// Virtual column ID for the "+" add column button
export const ADD_COLUMN_ID = '__add_column__'
const GRID_PLACEHOLDER_COLUMN_ID = '__grid_placeholder__'
const GRID_PLACEHOLDER_COLUMNS: GridColumn[] = [
  { id: GRID_PLACEHOLDER_COLUMN_ID, title: '', width: 88 },
]
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

type SelectionCellBlock = {
  rows: number[]
  colIndices: number[]
}

const rangeValues = (start: number, count: number): number[] =>
  Array.from({ length: count }, (_, offset) => start + offset)

const uniqueSortedNumbers = (values: number[]): number[] =>
  Array.from(new Set(values)).sort((a, b) => a - b)

const buildSelectionCellBlocks = (ranges: Rectangle[]): SelectionCellBlock[] => {
  const validRanges = ranges.filter(range => range.width > 0 && range.height > 0)
  if (validRanges.length === 0) return []

  const firstRange = validRanges[0]!
  const shareRowSpan = validRanges.every(
    range => range.y === firstRange.y && range.height === firstRange.height
  )

  if (shareRowSpan) {
    return [{
      rows: rangeValues(firstRange.y, firstRange.height),
      colIndices: uniqueSortedNumbers(validRanges.flatMap(range => rangeValues(range.x, range.width))),
    }]
  }

  return validRanges.map(range => ({
    rows: rangeValues(range.y, range.height),
    colIndices: rangeValues(range.x, range.width),
  }))
}

const waitForGridOperationLockPaint = async (): Promise<void> => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    return
  }

  await new Promise<void>(resolve => {
    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 0)
    })
  })
}

type E2EGridBridge = {
  copyRangeAsTsv: (
    startRow: number,
    startCol: number,
    rowCount: number,
    colCount: number
  ) => Promise<string>
  executePasteAt: (anchorRow: number, anchorCol: number, tsv: string) => Promise<number>
  getVisibleCell: (
    rowIndex: number,
    columnIndex: number
  ) => Promise<{ rowIndex: number; columnIndex: number; columnId: string; value: unknown; hasRow: boolean } | null>
  selectCell: (rowIndex: number, colIndex: number) => Promise<boolean>
  scrollToCell: (rowIndex: number, colIndex: number) => Promise<boolean>
  focusSurface: () => Promise<boolean>
  getActiveCell: () => Promise<{ rowIndex: number; columnIndex: number; columnId: string } | null>
  getEditSession: () => Promise<{
    active: boolean
    rowIndex: number
    columnIndex: number
    source: FormulaEditSource
  } | null>
  getCopyContext: () => Promise<{ copyOpId: string; sourceDatasetId: string; clipboardText: string } | null>
  seedCopyContext: (clipboardText: string) => Promise<{ copyOpId: string; sourceDatasetId: string; clipboardText: string } | null>
  selectAll: () => Promise<boolean>
  undo: () => Promise<boolean>
  redo: () => Promise<boolean>
}

type ClipboardCopyContext = {
  copyOpId: string
  sourceDatasetId: string
  sourceFamilyId: string | null
  clipboardText: string
  includesColumnHeaders?: boolean
  copiedColumnHeaders?: string[]
}

type WatchedCutDebugContext = {
  cutOpId: string
  datasetId: string
  modelRow: number
  columnId: string
}

type PasteOperationContext = {
  pasteOpId: string
  destDatasetId: string
  destAnchor: { row: number; col: number }
  selectionRevision: number
  copyOpId?: string
  sourceDatasetId?: string
  sourceFamilyId?: string | null
}

function clipboardContextFromPasteOperation(
  context: PasteOperationContext
): GridTransactionRecord['clipboardContext'] {
  if (!context.copyOpId) return undefined
  return {
    source: 'copy',
    copyOpId: context.copyOpId,
    sourceDatasetId: context.sourceDatasetId,
    sourceFamilyId: context.sourceFamilyId ?? undefined,
  }
}

declare global {
  interface Window {
    __E2E_GRID_BRIDGE__?: Record<string, E2EGridBridge>
  }
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
  /** Phase 2: single-key sort model (forward-compatible with multi-key). Empty array = no sort. */
  sortModel: SortKey[]
  /** @deprecated Kept for migration of ViewState written before Phase 2. */
  sortColumn?: string | null
  /** @deprecated Kept for migration of ViewState written before Phase 2. */
  sortDirection?: 'asc' | 'desc' | null
  groupByColumnId: string | null
  collapsedGroupKeys: string[]
  gridSelection: GridSelection | null
  activeCell: ActiveCellState | null
  scroll: { x: number; y: number } | null
}

type PendingActivationBundle = {
  token: number
  datasetId: string
  rowCountSnapshot: number
  previousBaseSortedOrder: number[]
  previousRowOrder: number[]
  previousGroupMeta: Array<{ startViewRow: number; key: string; size: number; collapsed: boolean }>
  visibleStartRow: number
  visibleEndRow: number
  rowOrder: number[]
  targetModelRows: number[] | null
  sortModel: SortKey[]
  restoreSortModel: SortKey[]
  groupByColumnId: string | null
  collapsedGroups: Set<string>
  gridSelection: GridSelection
  activeCell: ActiveCellState | null
  scroll: { x: number; y: number }
}

type OverlayMutationRecord = {
  revision: number
  edits: CellEdit[]
}

type DatasetOverlayScope = {
  projectId: string | null
  familyId: string | null
}

type DatasetOverlayMeta = {
  scope: DatasetOverlayScope
  latestMutationId: string | null
  persistedMutationIds: string[]
  activationPending: boolean
  nextRevision: number
  mutations: Map<string, OverlayMutationRecord>
  pendingFlushMutationIds: string[]
}

// Mutation-session state that must survive component lifecycle transitions and inactive-dataset
// activation stays in module scope. These maps are keyed by datasetId because dataset ids are
// generated as app-global unique tokens (see data-store initializeBlankDataset and imported dataset ids).
const sharedOverlayModelByDataset = new Map<string, GridViewModel>()
const sharedOverlayMetaByDataset = new Map<string, DatasetOverlayMeta>()
const sharedDatasetsNeedingReloadOnActivate = new Set<string>()
const sharedGridMutationQueueStore = new Map<string, Promise<void>>()

export function resetSpreadsheetViewSharedOverlayStateForTests() {
  sharedOverlayModelByDataset.clear()
  sharedOverlayMetaByDataset.clear()
  sharedDatasetsNeedingReloadOnActivate.clear()
  sharedGridMutationQueueStore.clear()
}

export function getSpreadsheetViewOverlayRowForTests(datasetId: string, rowIndex: number) {
  return sharedOverlayModelByDataset
    .get(datasetId)
    ?.getOverlayRow(buildDatasetScopedRowId(datasetId, rowIndex)) ?? null
}

export function getSpreadsheetViewMergedRowForTests(datasetId: string, rowIndex: number) {
  return sharedOverlayModelByDataset
    .get(datasetId)
    ?.readMergedRow(buildDatasetScopedRowId(datasetId, rowIndex)) ?? null
}

export function seedSpreadsheetViewOverlayBaseRowForTests(
  datasetId: string,
  rowIndex: number,
  row: Record<string, unknown>
) {
  getOrCreateOverlayModel(datasetId).writeBaseRow(buildDatasetScopedRowId(datasetId, rowIndex), row)
  getOrCreateOverlayMeta(datasetId)
}

function buildDatasetScopedRowId(datasetId: string, rowIndex: number) {
  const storedScope = sharedOverlayMetaByDataset.get(datasetId)?.scope
  const appState = useAppStore.getState()
  const families = Array.isArray(appState.families) ? appState.families : []
  const fallbackScope: DatasetOverlayScope = {
    projectId: appState.projectId ?? null,
    familyId:
      families.find((family) => family.datasetId === datasetId)?.id ?? appState.activeFamilyId ?? null,
  }
  const scope = storedScope ?? fallbackScope
  return buildGridRowId({
    projectId: scope.projectId,
    familyId: scope.familyId,
    datasetId,
    modelRow: rowIndex,
  })
}

function resolveDatasetOverlayScope(datasetId: string): DatasetOverlayScope {
  const appState = useAppStore.getState()
  const families = Array.isArray(appState.families) ? appState.families : []
  return {
    projectId: appState.projectId ?? null,
    familyId:
      families.find((family) => family.datasetId === datasetId)?.id ?? appState.activeFamilyId ?? null,
  }
}

function createDatasetOverlayMeta(datasetId: string): DatasetOverlayMeta {
  return {
    scope: resolveDatasetOverlayScope(datasetId),
    latestMutationId: null,
    persistedMutationIds: [],
    activationPending: false,
    nextRevision: 1,
    mutations: new Map(),
    pendingFlushMutationIds: [],
  }
}

function collectStagedOverlayRows(
  model: GridViewModel | undefined,
  datasetId: string
): Map<number, Record<string, unknown>> | null {
  if (!model) return null
  const rows = new Map<number, Record<string, unknown>>()
  for (const [rowId, overlayRow] of model.listOverlayRows().entries()) {
    const parsed = parseGridRowId(rowId)
    if (parsed.datasetId !== datasetId) continue
    const rowValues: Record<string, unknown> = {}
    for (const [columnId, cell] of Object.entries(overlayRow)) {
      rowValues[columnId] = cell.value
    }
    if (Object.keys(rowValues).length > 0) {
      rows.set(parsed.modelRow, rowValues)
    }
  }
  return rows.size > 0 ? rows : null
}

function sampleNumbers(values: Iterable<number>, limit = 8): number[] {
  const sample: number[] = []
  for (const value of values) {
    sample.push(value)
    if (sample.length >= limit) break
  }
  return sample
}

function getOrCreateOverlayModel(datasetId: string) {
  const existing = sharedOverlayModelByDataset.get(datasetId)
  if (existing) return existing
  const model = createGridViewModel()
  sharedOverlayModelByDataset.set(datasetId, model)
  return model
}

function getOrCreateOverlayMeta(datasetId: string) {
  const existing = sharedOverlayMetaByDataset.get(datasetId)
  if (existing) return existing
  const meta = createDatasetOverlayMeta(datasetId)
  sharedOverlayMetaByDataset.set(datasetId, meta)
  return meta
}

function clearDatasetOverlayState(datasetId: string) {
  sharedOverlayModelByDataset.delete(datasetId)
  sharedOverlayMetaByDataset.delete(datasetId)
}

function buildModelRowRange(startRow: number, endRow: number): number[] {
  if (endRow <= startRow) return []
  return Array.from({ length: endRow - startRow }, (_, index) => startRow + index)
}

function buildRowFetchSpans(rowIndexes: number[]): Array<{ start: number; end: number }> {
  if (rowIndexes.length === 0) return []
  const sorted = [...new Set(rowIndexes)].sort((a, b) => a - b)
  const spans: Array<{ start: number; end: number }> = []
  let spanStart = sorted[0]!
  let previous = spanStart

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!
    if (current === previous + 1) {
      previous = current
      continue
    }
    spans.push({ start: spanStart, end: previous + 1 })
    spanStart = current
    previous = current
  }

  spans.push({ start: spanStart, end: previous + 1 })
  return spans
}

function syncTouchedRowsToOverlayBase(
  datasetId: string,
  prevRows: Map<number, Record<string, unknown>>,
  nextRows: Map<number, Record<string, unknown>>
) {
  const model = sharedOverlayModelByDataset.get(datasetId)
  if (!model) return
  const touchedRowIndexes = new Set<number>()
  nextRows.forEach((row, rowIndex) => {
    if (!Object.is(prevRows.get(rowIndex), row)) {
      touchedRowIndexes.add(rowIndex)
    }
  })
  for (const rowIndex of touchedRowIndexes) {
    const row = nextRows.get(rowIndex)
    if (row) {
      model.writeBaseRow(buildDatasetScopedRowId(datasetId, rowIndex), row)
    }
  }
}

function clearConvergedOverlayRows(datasetId: string, rowIndexes: Iterable<number>) {
  const model = sharedOverlayModelByDataset.get(datasetId)
  if (!model) return
  for (const rowIndex of rowIndexes) {
    model.clearConfirmedOverlay(buildDatasetScopedRowId(datasetId, rowIndex))
  }
  if (!model.hasOverlayRows()) {
    clearDatasetOverlayState(datasetId)
  }
}

function buildColumnFallbackCandidates(columns: GridColumn[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  columns.forEach((col) => {
    if (!col.id) {
      return
    }
    const keys = new Set<string>()
    keys.add(col.id)
    if (col.title && col.title !== col.id) {
      keys.add(col.title)
    }
    const idLower = col.id.toLowerCase()
    if (idLower !== col.id) keys.add(idLower)
    if (col.title) {
      const titleLower = col.title.toLowerCase()
      if (titleLower !== col.title) keys.add(titleLower)
    }
    map.set(col.id, Array.from(keys))
  })
  return map
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

const computeDatasetSchemaKey = (dataset: Dataset | null): string | null =>
  dataset ? computeSchemaKey(dataset.columns.map((col) => col.id)) : null

/**
 * Pure helper: derives column titles with sort arrows and filter indicator.
 * Exported for unit testing.
 */
export function deriveColumnTitles(
  columns: Array<{ id: string; name: string }>,
  sortModel: Array<{ colId: string; dir: string }>,
  filterConfig: FilterConfig | null
): Array<{ id: string; title: string }> {
  const filteredColIds = new Set<string>()
  if (filterConfig) {
    for (const group of filterConfig.groups) {
      for (const cond of group.conditions) {
        if (cond.columnId && cond.columnId.trim() !== '') filteredColIds.add(cond.columnId)
      }
    }
  }

  return columns.map((col) => {
    const activeKey = sortModel[0]
    let title = col.name
    if (activeKey?.colId === col.id) {
      title += activeKey.dir === 'asc' ? ' ↑' : ' ↓'
    }
    if (filteredColIds.has(col.id)) {
      // No leading space if a sort arrow was already appended
      title += activeKey?.colId === col.id ? '▾' : ' ▾'
    }
    return { id: col.id, title }
  })
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
  onCopyRequest?: (copy: (() => void | Promise<void>) | null) => void
  /** Callback to expose cut handler to parent */
  onCutRequest?: (cut: (() => void | Promise<void>) | null) => void
  /** Callback to expose paste handler to parent */
  onPasteRequest?: (paste: (() => void | Promise<void>) | null) => void
  /** Callback to expose undo handler to parent */
  onUndoRequest?: (undo: (() => void | Promise<void>) | null) => void
  /** Callback to expose redo handler to parent */
  onRedoRequest?: (redo: (() => void | Promise<void>) | null) => void
  /** Callback to expose insert menu opener to parent toolbar */
  onInsertMenuRequest?: (open: ((x: number, y: number) => void) | null) => void
  /** Enable Excel-style per-column view filter (Phase 1) */
  enableExcelViewFilter?: boolean
  /** Callback to expose filter dialog trigger to parent */
  onFilterDialogRequest?: (open: () => void) => void
  /** Callback to expose picker-origin column filter opener to parent (Phase 3) */
  onColumnFilterRequest?: (openFn: (colId: string, bounds: { x: number; y: number; width: number; height: number }) => void) => void
  /** Called whenever viewFilterConfig changes so parent can keep picker active-indicators in sync */
  onViewFilterChange?: (config: import('@/services/dataTransformService').FilterConfig | null) => void
  /** Called whenever the active grid view scope changes so jobs can honor visible-row filters */
  onViewScopeChange?: (scope: GridViewScope) => void
  /** Callback to expose the filter-only undo fn to parent (Phase 5) */
  onFilterUndoRequest?: (fn: () => boolean) => void
  /** Callback to expose the filter-only clear fn to parent (Phase 5) */
  onFilterClearRequest?: (fn: () => void) => void
  /** Called whenever filter undo availability changes (Phase 5) */
  onFilterUndoStateChange?: (canUndo: boolean) => void
  /** Called before data-dependent grid tools open; return true to allow opening. */
  onRequireDataRows?: (toolName: string) => boolean
  /**
   * Optional async hook called before the view-filter dialog opens (Phase 5).
   * Allows the parent (AppShell) to load filtered columnMetadata and sample data
   * using the same `loadSampleRows` + `getColumnsWithData({hideEmptyColumns:true})`
   * pipeline used by the transform-path dialog.
   *
   * Explicit result kinds — do not overload with null:
   *   ready    → use the returned columns + data (empty columns hidden, levels loaded)
   *   fallback → open dialog with raw currentDataset.columns and no data
   *   abort    → do NOT open the dialog (stale dataset, blocked operation, etc.)
   *
   * If the callback throws, openViewFilterDialog catches and treats it as fallback.
   */
  onBeforeViewFilterDialogOpen?: () => Promise<
    | { kind: 'ready'; columns: ColumnMetadata[]; data: Record<string, any>[] }
    | { kind: 'fallback' }
    | { kind: 'abort' }
  >
  /** Optional staged dataset target for app-level activation without immediately swapping the live surface. */
  pendingDatasetId?: string
  /** Token paired with pendingDatasetId so stale readiness signals can be ignored. */
  pendingDatasetToken?: number
  /** Called when the staged replacement surface is ready for promotion. */
  onPendingSurfaceReady?: (args: { datasetId: string; token: number }) => void
}

/**
 * Returns only the real editable columns, filtering out the virtual "+" add-column button.
 * Use this whenever computing column count for paste preflight or building edit loops.
 */
function getEditableColumns<T extends { id?: string }>(columns: T[]): T[] {
  return columns.filter(c => c.id !== ADD_COLUMN_ID)
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
  onRedoRequest,
  onInsertMenuRequest,
  enableExcelViewFilter = false,
  onFilterDialogRequest,
  onColumnFilterRequest,
  onViewFilterChange,
  onViewScopeChange,
  onFilterUndoRequest,
  onFilterClearRequest,
  onFilterUndoStateChange,
  onRequireDataRows,
  onBeforeViewFilterDialogOpen,
  pendingDatasetId,
  pendingDatasetToken,
  onPendingSurfaceReady,
}: SpreadsheetViewProps) {
  const e2eBridgeEnabled = import.meta.env.MODE === 'e2e' || import.meta.env.VITE_E2E_ENABLED === 'true'
  const { resolvedTheme } = useTheme()
  const dataEditorRef = useRef<DataEditorRef | null>(null)
  const gridContainerRef = useRef<HTMLDivElement | null>(null)
  const failedGridSyncTransactionRef = useRef<GridTransactionRecord | null>(null)
  const currentPasteTimingByTransactionRef = useRef<Map<string, CurrentPasteTimingBuckets>>(new Map())
  const [gridSyncFailureNotice, setGridSyncFailureNotice] = useState<GridSyncFailureNotice | null>(null)
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
    updateCellsBatch,
    updateDataset,
    invalidateColumns,
    allocateNextAutoColumnName,
    rollbackAutoColumnNameAllocation,
    insertColumnAtDataset,
    insertRowAtDataset,
    insertRowsAtDataset,
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
  const pendingDataset = useMemo(() => {
    if (!pendingDatasetId) return null
    return datasetsById.get(pendingDatasetId) ?? null
  }, [datasetsById, pendingDatasetId])
  const lastRenderableGridKeyRef = useRef<string>(currentDataset?.id ?? 'placeholder')
  const lastRenderableColumnsRef = useRef<GridColumn[]>(GRID_PLACEHOLDER_COLUMNS)
  const lastRenderableRowCountRef = useRef<number>(100)
  const activeFamilyId = useAppStore(state => state.activeFamilyId)
  const projectId = useAppStore(state => state.projectId)
  const setPasteInFlight = useAppStore(state => state.setPasteInFlight ?? (() => {}))
  const setPasteFinalizing = useAppStore(state => state.setPasteFinalizing ?? (() => {}))
  const acquireAppOperationLock = useAppStore(
    state => state.acquireAppOperationLock ?? (() => 'paste-lock-fallback')
  )
  const updateAppOperationLock = useAppStore(state => state.updateAppOperationLock ?? (() => {}))
  const releaseAppOperationLock = useAppStore(state => state.releaseAppOperationLock ?? (() => false))
  const resolvedViewStateKey = useMemo(() => {
    const baseKey = viewStateKey ?? `statistics:${activeFamilyId ?? 'statistics-1'}`
    if (!projectId) return baseKey
    const prefix = `project:${projectId}:`
    return baseKey.startsWith(prefix) ? baseKey : `${prefix}${baseKey}`
  }, [viewStateKey, activeFamilyId, projectId])
  const currentSchemaKey = useMemo(
    () => computeDatasetSchemaKey(currentDataset),
    [currentDataset?.id, currentDataset?.columns]
  )
  const resolvedStateKey = useMemo(
    () => buildViewStateCacheKey(resolvedViewStateKey ?? null, currentDataset?.id ?? null, currentSchemaKey),
    [resolvedViewStateKey, currentDataset?.id, currentSchemaKey]
  )
  const pendingSurfaceReadyKeyRef = useRef<string | null>(null)

  // Local row data cache (Map<rowIndex, rowData>)
  // Now SPARSE - only contains loaded rows, not entire dataset
  const rowDataRef = useRef<Map<number, Record<string, unknown>>>(new Map())
  const [rowDataVersion, setRowDataVersion] = useState(0)
  const [datasetActivationReloadVersion, bumpDatasetActivationReloadVersion] = useReducer(
    (version: number) => version + 1,
    0
  )
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
      const prevRows = rowDataRef.current
      const nextRows = updater(prevRows)
      const datasetId = currentDatasetIdRef.current
      if (datasetId) {
        syncTouchedRowsToOverlayBase(datasetId, prevRows, nextRows)
      }
      rowDataRef.current = nextRows
      markSelectionStatsDirty()
    },
    [markSelectionStatsDirty]
  )
  // Sentinels keep blank scaffold rows editable, but copy/cut/delete must not
  // treat those placeholders as materialized row data.
  const hasMaterializedRowData = useCallback((modelRow: number) => {
    const row = rowDataRef.current.get(modelRow)
    return row !== undefined && !isRowDataSentinel(row)
  }, [])
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
  const lastRequestedScrollRestoreRef = useRef<{ x: number; y: number } | null>(null)
  const activationTokenRef = useRef(0)
  const pendingActivationBundleRef = useRef<PendingActivationBundle | null>(null)
  const pendingActivationPrefetchKeyRef = useRef<string | null>(null)
  const [pendingActivationDatasetId, setPendingActivationDatasetId] = useState<string | null>(null)
  const [scrollRestoreNonce, setScrollRestoreNonce] = useState(0)
  const pendingViewportDamageRef = useRef(false)
  const pendingGrowthRepaintRef = useRef(false) // set by row-count growth effect; cleared by post-commit repaint effect
  const pendingBlockLoadsRef = useRef<Set<number>>(new Set()) // Track pending block loads to avoid duplicate fetches
  const staleLoadedOverlayRecoveryRef = useRef<Set<string>>(new Set())
  const sparseOverlayDebugSeenRef = useRef<Set<string>>(new Set())
  const scheduleViewportDamageRef = useRef<(loadedModelRows?: Set<number>) => void>(() => {})
  const scheduleCellUpdatesRef = useRef<
    (updates: Array<{ cell: readonly [number, number] }>) => void
  >(() => {})
  const pendingCellUpdatesByKeyRef = useRef<Map<string, { cell: readonly [number, number] }>>(new Map())
  const pendingCellUpdatesRafRef = useRef<number | null>(null)
  const cellRefreshReadyRef = useRef(false)
  const pendingCellRefreshBatchesRef = useRef<Array<Array<{ cell: readonly [number, number] }>>>([])
  const selectionRevisionRef = useRef(0)
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
  const blockStatesRef = useRef<Map<string, GridBlockState>>(new Map())

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

  const getBlockState = useCallback((blockKey: string): GridBlockState | undefined => {
    return blockStatesRef.current.get(blockKey)
  }, [])

  const setBlockState = useCallback((blockKey: string, nextState?: GridBlockState) => {
    if (!nextState) {
      blockStatesRef.current.delete(blockKey)
      loadedBlocksRef.current.delete(blockKey)
      pendingBlocksRef.current.delete(blockKey)
      return
    }

    blockStatesRef.current.set(blockKey, nextState)
    if (nextState === 'loaded') {
      loadedBlocksRef.current.add(blockKey)
      pendingBlocksRef.current.delete(blockKey)
      return
    }

    loadedBlocksRef.current.delete(blockKey)
    if (nextState === 'reloading') {
      pendingBlocksRef.current.add(blockKey)
      return
    }

    pendingBlocksRef.current.delete(blockKey)
  }, [])

  const clearBlockStateTracking = useCallback(() => {
    blockStatesRef.current = new Map()
    loadedBlocksRef.current = new Set()
    pendingBlocksRef.current = new Set()
  }, [])

  // Clear storage info cache when dataset changes to avoid stale project/dataset mappings.
  useEffect(() => {
    let cancelled = false
    storageInfoRef.current = new Map()
    if (currentDataset?.id) {
      const datasetId = currentDataset.id
      void ensureProjectId()
        .then(() => {
          if (!cancelled) {
            cacheService.triggerDatasetInfrastructureWarmup(datasetId)
          }
        })
        .catch(() => {
          // Project creation/opening will surface its own errors; warmup is best-effort.
        })
    }
    return () => {
      cancelled = true
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

  // View filter state + undo stack (Phase 5).
  const { viewFilterConfig, filterHistory, applyFilter, undoFilter, clearFilter } = useFilterHistory()
  const fullRowsByIndexRef = useRef<Map<number, Record<string, unknown>>>(new Map())
  const [showFilterDialog, setShowFilterDialog] = useState(false)
  // Prepared data / columns from onBeforeViewFilterDialogOpen — loaded just before the dialog opens.
  const [filterDialogData, setFilterDialogData] = useState<Record<string, any>[]>([])
  const [filterDialogColumns, setFilterDialogColumns] = useState<ColumnMetadata[] | null>(null)
  // Column ID being escalated to the Advanced Filter dialog from the quick-filter popover.
  // When set, the dialog opens pre-scoped to that column's conditions only (Phase 3).
  // When null, the dialog opens with the full viewFilterConfig (toolbar-open path).
  const [filterDialogScopeColId, setFilterDialogScopeColId] = useState<string | null>(null)

  // Column header filter menu (Phase 2)
  const [columnFilterMenu, setColumnFilterMenu] = useState<{
    colIndex: number
    /** Stable column ID — used as source of truth instead of positional colIndex. */
    colId: string
    bounds: { x: number; y: number; width: number; height: number }
    uniqueValues: string[]
    loading: boolean
  } | null>(null)
  // Monotonic token — each onHeaderMenuClick increments this so stale async
  // fetches can detect they have been superseded and discard their results.
  const menuRequestIdRef = useRef(0)
  // Version counter bumped after cell edits so the snapshot effect re-runs even
  // when rowCount/id haven't changed (same-row value edits).
  const [filterSnapshotVersion, setFilterSnapshotVersion] = useState(0)

  /**
   * Invalidate the filter snapshot after a cell value changes.
   * Only schedules a rebuild when a filter is actually active.
   */
  const invalidateFilterSnapshot = useCallback(() => {
    if (enableExcelViewFilter && viewFilterConfig) {
      setFilterSnapshotVersion((v) => v + 1)
    }
  }, [enableExcelViewFilter, viewFilterConfig])

  /** Merge per-column conditions from the header popover into the global filter config. */
  const handleColumnFilterApply = useCallback(
    (columnId: string, conditions: FilterCondition[] | null) => {
      if (!enableExcelViewFilter) return
      applyFilter((prev) => mergeColumnConditions(prev, columnId, conditions))
    },
    [enableExcelViewFilter, applyFilter]
  )

  /**
   * Handle header menu icon click — open the per-column filter popover.
   * Loads unique values for the column asynchronously.
   */
  const onHeaderMenuClick = useCallback(
    (colIndex: number, bounds: Rectangle) => {
      if (!enableExcelViewFilter || !currentDataset) return
      const col = currentDataset.columns[colIndex]
      if (!col) return

      // Capture identifiers and bump the request token before the first await so
      // any stale in-flight fetch from a previous click can detect it is superseded.
      const requestId = ++menuRequestIdRef.current
      const capturedColId = col.id
      const capturedDatasetId = currentDataset.id

      setColumnFilterMenu({
        colIndex,
        colId: capturedColId,
        bounds,
        uniqueValues: [],
        loading: true,
      })

      // Load unique values asynchronously
      void (async () => {
        try {
          await cacheService.ensureLatestCache(capturedDatasetId)
          const data = await cacheService.getColumnsData(capturedDatasetId, [capturedColId])
          const raw = data[capturedColId] ?? []
          const unique = deriveUniqueFilterValues(raw)
          // Guard: discard if a newer request superseded this one OR dataset changed
          if (menuRequestIdRef.current !== requestId) return
          if (currentDatasetIdRef.current !== capturedDatasetId) return
          setColumnFilterMenu((prev) =>
            prev?.colId === capturedColId ? { ...prev, uniqueValues: unique, loading: false } : prev
          )
        } catch {
          if (menuRequestIdRef.current !== requestId) return
          if (currentDatasetIdRef.current !== capturedDatasetId) return
          setColumnFilterMenu((prev) =>
            prev?.colId === capturedColId ? { ...prev, loading: false } : prev
          )
        }
      })()
    },
    [enableExcelViewFilter, currentDataset]
  )

  /**
   * Open the column filter popover from the column picker (Phase 3).
   * Takes a colId directly (not a positional index) and picker-origin bounds.
   * Reuses the same columnFilterMenu state and async loading as onHeaderMenuClick.
   */
  const openColumnFilter = useCallback(
    (colId: string, bounds: { x: number; y: number; width: number; height: number }) => {
      if (!enableExcelViewFilter || !currentDataset) return

      // Bail early if colId is not present in the current dataset — avoids
      // anchoring the popover to a wrong column and avoids a stale fetch.
      const colIndex = currentDataset.columns.findIndex((c) => c.id === colId)
      if (colIndex === -1) return

      const requestId = ++menuRequestIdRef.current
      const capturedDatasetId = currentDataset.id

      setColumnFilterMenu({
        colIndex,
        colId,
        bounds,
        uniqueValues: [],
        loading: true,
      })

      void (async () => {
        try {
          await cacheService.ensureLatestCache(capturedDatasetId)
          const data = await cacheService.getColumnsData(capturedDatasetId, [colId])
          const raw = data[colId] ?? []
          const unique = deriveUniqueFilterValues(raw)
          if (menuRequestIdRef.current !== requestId) return
          if (currentDatasetIdRef.current !== capturedDatasetId) return
          setColumnFilterMenu((prev) =>
            prev?.colId === colId ? { ...prev, uniqueValues: unique, loading: false } : prev
          )
        } catch {
          if (menuRequestIdRef.current !== requestId) return
          if (currentDatasetIdRef.current !== capturedDatasetId) return
          setColumnFilterMenu((prev) =>
            prev?.colId === colId ? { ...prev, loading: false } : prev
          )
        }
      })()
    },
    [enableExcelViewFilter, currentDataset]
  )

  // Expose picker-origin column filter opener to parent (Phase 3)
  useEffect(() => {
    if (enableExcelViewFilter && onColumnFilterRequest) {
      onColumnFilterRequest(openColumnFilter)
    }
  }, [enableExcelViewFilter, onColumnFilterRequest, openColumnFilter])

  // Notify parent whenever viewFilterConfig changes (for picker active-indicators)
  useEffect(() => {
    onViewFilterChange?.(viewFilterConfig)
  }, [viewFilterConfig, onViewFilterChange])

  // Expose filter-only callbacks to parent (Phase 5).
  // undoFilter / clearFilter have stable identity (useCallback with no deps).
  useEffect(() => {
    onFilterUndoRequest?.(undoFilter)
  }, [onFilterUndoRequest, undoFilter])

  useEffect(() => {
    onFilterClearRequest?.(clearFilter)
  }, [onFilterClearRequest, clearFilter])

  // Notify parent whenever filter undo availability changes.
  useEffect(() => {
    onFilterUndoStateChange?.(filterHistory.length > 0)
  }, [filterHistory.length, onFilterUndoStateChange])

  // Close the column filter popover when the user scrolls or resizes the window
  // so the fixed-position anchor does not drift away from the column header.
  // Depend only on the open/closed boolean (not the full object) to avoid
  // tearing down and re-registering listeners on every async state update.
  const isColumnFilterMenuOpen = columnFilterMenu !== null
  useEffect(() => {
    if (!isColumnFilterMenuOpen) return
    const close = () => setColumnFilterMenu(null)
    window.addEventListener('scroll', close, { capture: true })
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [isColumnFilterMenuOpen])

  /**
   * Apply the active view filter to a row-index order array.
   * When enableExcelViewFilter is false or no filter is active, returns input unchanged.
   * Wraps applyViewFilter so every injection site is a one-liner.
   */
  const applyActiveFilter = useCallback(
    (order: number[]): number[] => {
      if (!enableExcelViewFilter || !viewFilterConfig || !currentDataset) return order
      const dataRowCount = resolveDataRowCount(currentDataset)
      return applyViewFilter(order, viewFilterConfig, fullRowsByIndexRef.current, dataRowCount)
    },
    [enableExcelViewFilter, viewFilterConfig, currentDataset, resolveDataRowCount]
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
      const MAX_TRACKED_SELECTED_ROWS = 10_000
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

      let canTrackExplicitRows = selection.rows.length <= MAX_TRACKED_SELECTED_ROWS
      if (selection.rows.length > 0 && canTrackExplicitRows) {
        for (const rowIndex of selection.rows) {
          selectedRowSet.add(rowIndex)
        }
      }

      if (
        selectionRanges.length > 0 &&
        selection.rows.length === 0 &&
        selection.columns.length === 0
      ) {
        const rangeRowEstimate = selectionRanges.reduce(
          (total, range) => total + Math.max(0, range.height),
          0
        )
        canTrackExplicitRows = rangeRowEstimate <= MAX_TRACKED_SELECTED_ROWS
        for (const range of selectionRanges) {
          const { x, y, width, height } = range
          for (let colIndex = x; colIndex < x + width; colIndex += 1) {
            const col = dataset.columns[colIndex]
            if (col) {
              selectedColSet.add(col.id)
            }
          }
          if (canTrackExplicitRows) {
            for (let rowIndex = y; rowIndex < y + height; rowIndex += 1) {
              selectedRowSet.add(rowIndex)
            }
          }
        }
      }

      setSelectedRows(canTrackExplicitRows ? Array.from(selectedRowSet) : [])
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

  const lastViewScopeDatasetIdRef = useRef<string | null>(null)
  const lastViewScopeSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    if (!currentDataset || !onViewScopeChange) return
    if (lastViewScopeDatasetIdRef.current !== currentDataset.id) {
      lastViewScopeDatasetIdRef.current = currentDataset.id
      lastViewScopeSignatureRef.current = null
    }
    if (enableExcelViewFilter && viewFilterConfig !== null) return

    const totalDataRowCount = resolveDataRowCount(currentDataset)
    const scope = createFullDatasetScope(currentDataset.id, totalDataRowCount)
    const signature = `${scope.datasetId}:full:${scope.totalDataRowCount}`
    if (lastViewScopeSignatureRef.current === signature) return
    lastViewScopeSignatureRef.current = signature
    onViewScopeChange(scope)
  }, [
    currentDataset,
    enableExcelViewFilter,
    onViewScopeChange,
    resolveDataRowCount,
    viewFilterConfig,
  ])

  useEffect(() => {
    if (!currentDataset || !onViewScopeChange || !enableExcelViewFilter || viewFilterConfig === null) return
    if (lastViewScopeDatasetIdRef.current !== currentDataset.id) {
      lastViewScopeDatasetIdRef.current = currentDataset.id
      lastViewScopeSignatureRef.current = null
    }

    const totalDataRowCount = resolveDataRowCount(currentDataset)
    const dataModelRows = rowOrder.filter((modelRow) => modelRow >= 0 && modelRow < totalDataRowCount)
    const scope: GridViewScope = {
      datasetId: currentDataset.id,
      source: 'view-filter',
      viewFilterConfig,
      displayRowOrder: [...rowOrder],
      dataModelRows,
      displayRowCount: rowOrder.length,
      dataRowCount: dataModelRows.length,
      totalDataRowCount,
    }
    const signature = [
      scope.datasetId,
      scope.source,
      scope.displayRowCount,
      scope.dataRowCount,
      scope.totalDataRowCount,
      dataModelRows.join(','),
      JSON.stringify(viewFilterConfig),
    ].join(':')
    if (lastViewScopeSignatureRef.current === signature) return
    lastViewScopeSignatureRef.current = signature
    onViewScopeChange(scope)
  }, [
    currentDataset,
    enableExcelViewFilter,
    onViewScopeChange,
    resolveDataRowCount,
    rowOrder,
    viewFilterConfig,
  ])

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

  // Sort state (Phase 2 - sortModel replaces sortColumn/sortDirection)
  const [sortModel, setSortModel] = useState<SortKey[]>([])
  // Stable string key derived from primary sort entry. Using this in dep arrays instead of the
  // sortModel array avoids spurious effect re-runs caused by array identity changes on re-render.
  const primarySortKey = sortModel[0] ? `${sortModel[0].colId}:${sortModel[0].dir}` : ''
  const [showSortDialog, setShowSortDialog] = useState(false)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  // Pre-filtered column lists passed to each dialog — populated just before opening.
  // Falls back to full dataset columns if stats are unavailable (see filterColumnsWithData).
  const [sortDialogColumns, setSortDialogColumns] = useState<ColumnMetadata[]>([])
  const [outlineDialogColumns, setOutlineDialogColumns] = useState<ColumnMetadata[]>([])

  // Ref so async dialog-open callbacks can read currentDataset without stale closure
  const currentDatasetRef = useRef<typeof currentDataset>(currentDataset)
  useEffect(() => { currentDatasetRef.current = currentDataset }, [currentDataset])
  const selectAllStatsByDatasetRef = useRef<Map<string, Map<string, number>>>(new Map())
  const selectAllPersistedColumnsByDatasetRef = useRef<Map<string, Set<string>>>(new Map())
  const selectAllStatsFetchTokenRef = useRef<Map<string, number>>(new Map())

  const refreshSelectAllStats = useCallback((datasetId: string) => {
    const nextToken = (selectAllStatsFetchTokenRef.current.get(datasetId) ?? 0) + 1
    selectAllStatsFetchTokenRef.current.set(datasetId, nextToken)
    void Promise
      .all([cacheService.getAllColumnStats(datasetId), cacheService.getPersistedColumnIds(datasetId)])
      .then(([stats, persistedColumnIds]) => {
        const latestToken = selectAllStatsFetchTokenRef.current.get(datasetId)
        if (latestToken !== nextToken) return
        const next = new Map<string, number>()
        stats.forEach((entry) => {
          next.set(entry.columnId, entry.nonNullCount)
        })
        selectAllStatsByDatasetRef.current.set(datasetId, next)
        selectAllPersistedColumnsByDatasetRef.current.set(datasetId, new Set(persistedColumnIds))
      })
      .catch(() => {
        const latestToken = selectAllStatsFetchTokenRef.current.get(datasetId)
        if (latestToken !== nextToken) return
        selectAllStatsByDatasetRef.current.delete(datasetId)
        selectAllPersistedColumnsByDatasetRef.current.delete(datasetId)
      })
  }, [])

  const invalidateSelectAllStats = useCallback((datasetId: string) => {
    selectAllStatsByDatasetRef.current.delete(datasetId)
    selectAllPersistedColumnsByDatasetRef.current.delete(datasetId)
    refreshSelectAllStats(datasetId)
  }, [refreshSelectAllStats])

  useEffect(() => {
    const liveDatasetIds = new Set(datasets.map((dataset) => dataset.id))
    for (const datasetId of selectAllStatsByDatasetRef.current.keys()) {
      if (!liveDatasetIds.has(datasetId)) {
        selectAllStatsByDatasetRef.current.delete(datasetId)
      }
    }
    for (const datasetId of selectAllPersistedColumnsByDatasetRef.current.keys()) {
      if (!liveDatasetIds.has(datasetId)) {
        selectAllPersistedColumnsByDatasetRef.current.delete(datasetId)
      }
    }
    for (const datasetId of selectAllStatsFetchTokenRef.current.keys()) {
      if (!liveDatasetIds.has(datasetId)) {
        selectAllStatsFetchTokenRef.current.delete(datasetId)
      }
    }
    for (const datasetId of sharedOverlayModelByDataset.keys()) {
      if (!liveDatasetIds.has(datasetId)) {
        clearDatasetOverlayState(datasetId)
      }
    }
    for (const datasetId of datasetsNeedingReloadOnActivateRef.current.values()) {
      if (!liveDatasetIds.has(datasetId)) {
        datasetsNeedingReloadOnActivateRef.current.delete(datasetId)
      }
    }
  }, [datasets])

  useEffect(() => {
    return () => {
      selectAllStatsByDatasetRef.current.clear()
      selectAllPersistedColumnsByDatasetRef.current.clear()
      selectAllStatsFetchTokenRef.current.clear()
    }
  }, [])

  // Preload select-all column stats so Ctrl+A can synchronously decide handled/no-op.
  useEffect(() => {
    const datasetId = currentDataset?.id
    if (!datasetId) return
    // Invalidate first so same-id dataset replacement never serves stale stats.
    selectAllStatsByDatasetRef.current.delete(datasetId)
    selectAllPersistedColumnsByDatasetRef.current.delete(datasetId)
    refreshSelectAllStats(datasetId)
  }, [currentDataset?.id, currentDataset?.modifiedAt, currentSchemaKey, refreshSelectAllStats])

  // Clear view filter when the active dataset changes so a prior dataset's filter
  // does not silently apply to the new dataset's data.
  const prevDatasetIdRef = useRef<string | undefined>(currentDataset?.id)
  useEffect(() => {
    if (prevDatasetIdRef.current !== currentDataset?.id) {
      prevDatasetIdRef.current = currentDataset?.id
      if (enableExcelViewFilter) {
        clearFilter()
        // Close any open column filter popover and invalidate in-flight fetches so
        // a stale async result from the previous dataset cannot land in the new one.
        setColumnFilterMenu(null)
        menuRequestIdRef.current += 1
        // Clear any prepared dialog data so a mounted filter dialog cannot render
        // columns/rows that belonged to the previous dataset.
        setFilterDialogColumns(null)
        setFilterDialogData([])
      }
    }
  }, [currentDataset?.id, enableExcelViewFilter])

  // Race guard: each dialog open increments its own counter; the async continuation
  // only commits state if the counter hasn't changed (i.e. no newer open was requested).
  const sortDialogRequestIdRef = useRef(0)
  const outlineDialogRequestIdRef = useRef(0)

  // Declared here (before dialog-open callbacks that read it) and kept in sync below.
  const groupByColumnIdRef = useRef<string | null>(null)

  const sortModelRef = useRef<SortKey[]>(sortModel)
  const [pendingInsertSortReplay, setPendingInsertSortReplay] = useState<{
    datasetId: string
    sortModel: SortKey[]
    expectedRowCount: number
  } | null>(null)

  useEffect(() => {
    sortModelRef.current = sortModel
  }, [sortModel])

  // Dedicated structural revision counter for the rare cases where DataEditor
  // truly needs a full remount. Ordinary mutations must use narrower refresh scopes.
  const [structuralGridRevision, setStructuralGridRevision] = useState(0)
  const [refreshDebugCounts, setRefreshDebugCounts] = useState({
    remount: 0,
    viewport: 0,
    cells: 0,
  })
  const [refreshDebugReasons, setRefreshDebugReasons] = useState<Record<string, number>>({})
  const getCurrentDatasetOverlayDebugState = useCallback(() => {
    const datasetId = currentDataset?.id ?? null
    if (!datasetId) {
      return { overlayRowCount: 0, persistedMutationCount: 0 }
    }
    const model = sharedOverlayModelByDataset.get(datasetId)
    const meta = sharedOverlayMetaByDataset.get(datasetId)
    return {
      overlayRowCount: model?.listOverlayRows().size ?? 0,
      persistedMutationCount: meta?.persistedMutationIds.length ?? 0,
    }
  }, [currentDataset?.id])

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

    if (import.meta.env.MODE === 'test') {
      setRefreshDebugCounts((prev) => ({
        ...prev,
        [request.scope]: prev[request.scope] + 1,
      }))
      setRefreshDebugReasons((prev) => ({
        ...prev,
        [request.reason]: (prev[request.reason] ?? 0) + 1,
      }))
    }

    if (request.scope === 'remount') {
      setStructuralGridRevision((prev) => prev + 1)
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
    lastRequestedScrollRestoreRef.current = target
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

  // Expose dialog triggers to parent (for ActionToolbar buttons).
  // Each callback is async: ensures cache is fresh, pre-fetches column stats where
  // needed, then opens.
  // Uses refs to avoid stale closures; request-ID refs guard against async races.
  useEffect(() => {
    if (onSortDialogRequest) {
      onSortDialogRequest(async () => {
        const requestId = ++sortDialogRequestIdRef.current
        const dataset = currentDatasetRef.current
        if (dataset) {
          try { await cacheService.ensureLatestCache(dataset.id) } catch { /* non-fatal */ }
          // Bail if a newer open request superseded this one or dataset changed
          if (requestId !== sortDialogRequestIdRef.current) return
          if (currentDatasetRef.current?.id !== dataset.id) return
          const forceIds = [sortModelRef.current[0]?.colId ?? '']
          const filtered = await filterColumnsWithData(
            dataset.id, dataset.columns, forceIds, 'sort dialog', 'missing_as_empty'
          )
          if (requestId !== sortDialogRequestIdRef.current) return
          if (currentDatasetRef.current?.id !== dataset.id) return
          setSortDialogColumns(filtered)
        }
        setShowSortDialog(true)
      })
    }
  }, [onSortDialogRequest])

  useEffect(() => {
    if (onGroupDialogRequest) {
      onGroupDialogRequest(async () => {
        const requestId = ++outlineDialogRequestIdRef.current
        const dataset = currentDatasetRef.current
        if (dataset) {
          try { await cacheService.ensureLatestCache(dataset.id) } catch { /* non-fatal */ }
          if (requestId !== outlineDialogRequestIdRef.current) return
          if (currentDatasetRef.current?.id !== dataset.id) return
          setOutlineDialogColumns(dataset.columns)
        }
        setShowGroupDialog(true)
      })
    }
  }, [onGroupDialogRequest])

  // Guard: prevents concurrent pre-load calls and detects dataset changes mid-flight.
  const isPreloadingFilterDialogRef = useRef(false)

  // Central opener for the view-filter dialog — awaits the optional data-prep callback
  // before mounting the dialog so both column list and sample data are ready.
  const openViewFilterDialog = useCallback(async () => {
    // Double-open guard: ignore a second trigger while preload is in flight.
    if (isPreloadingFilterDialogRef.current) return
    if (onBeforeViewFilterDialogOpen) {
      isPreloadingFilterDialogRef.current = true
      // Capture the dataset id at the moment the call starts so we can detect
      // a dataset switch that happened while the async prep was awaited.
      const capturedDatasetId = currentDatasetIdRef.current
      try {
        const result = await onBeforeViewFilterDialogOpen()
        // Dataset-switch guard: discard if the active dataset changed mid-flight.
        if (currentDatasetIdRef.current !== capturedDatasetId) return
        // Explicit kind dispatch — no null overloading.
        if (result.kind === 'abort') return
        if (result.kind === 'ready') {
          setFilterDialogColumns(result.columns)
          setFilterDialogData(result.data)
        } else {
          // kind === 'fallback': open with raw dataset defaults
          setFilterDialogColumns(null)
          setFilterDialogData([])
        }
      } catch {
        // Provider threw — treat as fallback (open with raw defaults, never crash)
        if (currentDatasetIdRef.current !== capturedDatasetId) return
        setFilterDialogColumns(null)
        setFilterDialogData([])
      } finally {
        isPreloadingFilterDialogRef.current = false
      }
    }
    setShowFilterDialog(true)
  }, [onBeforeViewFilterDialogOpen])

  const loadViewFilterUniqueValues = useCallback(async (columnId: string): Promise<unknown[]> => {
    if (!currentDataset) return []
    const datasetId = currentDataset.id
    await cacheService.ensureLatestCache(datasetId)
    try {
      const stats = await cacheService.getAllColumnStats(datasetId)
      const columnStats = stats.find((entry) => entry.columnId === columnId)
      if (columnStats) {
        return columnStats.distinctValues ?? []
      }
    } catch (error) {
      console.warn('Failed to load view filter distinct values from column stats:', error)
    }
    const valuesById = await cacheService.getColumnsData(datasetId, [columnId])
    return valuesById[columnId] ?? []
  }, [currentDataset])

  const loadViewFilterMatchCount = useCallback(async (config: FilterConfig): Promise<{ count: number; totalRows: number } | null> => {
    if (!currentDataset) return null
    const dataRowCount = resolveDataRowCount(currentDataset)
    if (dataRowCount > 50_000) {
      return null
    }
    const rowsByIndex = await buildFullRowsByIndex(currentDataset.id, dataRowCount, config)
    const baseOrder = Array.from({ length: dataRowCount }, (_, index) => index)
    const filteredRows = applyViewFilter(baseOrder, config, rowsByIndex, dataRowCount)
    const count = filteredRows.filter((row) => row >= 0 && row < dataRowCount).length
    return { count, totalRows: dataRowCount }
  }, [currentDataset, resolveDataRowCount])

  // Expose filter dialog trigger to parent (mirrors onSortDialogRequest pattern)
  useEffect(() => {
    if (enableExcelViewFilter && onFilterDialogRequest) {
      onFilterDialogRequest(() => { void openViewFilterDialog() })
    }
  }, [enableExcelViewFilter, onFilterDialogRequest, openViewFilterDialog])

  // Load full column snapshot when viewFilterConfig or dataset changes
  useEffect(() => {
    if (!enableExcelViewFilter || !viewFilterConfig || !currentDataset) {
      fullRowsByIndexRef.current = new Map()
      // Filter was cleared — restore unfiltered base order
      if (enableExcelViewFilter && !viewFilterConfig && currentDataset && baseSortedOrderRef.current.length > 0) {
        rebuildGrouping(baseSortedOrderRef.current, groupByColumnIdRef.current, collapsedGroupsRef.current)
      }
      return
    }
    const datasetId = currentDataset.id
    // Use resolveDataRowCount to match applyActiveFilter's buffer-row boundary
    const dataRowCount = resolveDataRowCount(currentDataset)
    buildFullRowsByIndex(datasetId, dataRowCount, viewFilterConfig)
      .then((map) => {
        // Guard: dataset may have changed while the fetch was in flight
        if (currentDatasetRef.current?.id !== datasetId) return
        fullRowsByIndexRef.current = map
        // Re-apply filter now that snapshot is ready
        if (baseSortedOrderRef.current.length > 0) {
          const effectiveOrder = applyViewFilter(
            baseSortedOrderRef.current,
            viewFilterConfig,
            fullRowsByIndexRef.current,
            dataRowCount
          )
          rebuildGrouping(effectiveOrder, groupByColumnIdRef.current, collapsedGroupsRef.current)
        }
      })
      .catch((err) => {
        if (err instanceof ViewFilterError) {
          toast.error('Filter error: could not load column data. Filter was not applied.')
        } else {
          console.error('[SpreadsheetView] Unexpected error loading filter snapshot:', err)
        }
        // Preserve prior filter state — do not setViewFilterConfig(null) here
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableExcelViewFilter, viewFilterConfig, currentDataset?.id, currentDataset?.rowCount, filterSnapshotVersion])

  // Group By state (Phase 4 - Grouping)
  const [groupByColumnId, setGroupByColumnId] = useState<string | null>(null)
  // Note: collapsedGroups is declared earlier (before viewToModel)
  const [groupMeta, setGroupMeta] = useState<
    Array<{ startViewRow: number; key: string; size: number; collapsed: boolean }>
  >([])
  const groupMetaRef = useRef(groupMeta)
  useEffect(() => {
    groupMetaRef.current = groupMeta
  }, [groupMeta])

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
    colId: string
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
    hasColumnAnchor: boolean
    hasRowAnchor: boolean
  }>({
    isOpen: false,
    x: 0,
    y: 0,
    columnIndex: 0,
    rowIndex: 0,
    hasColumnAnchor: false,
    hasRowAnchor: false,
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
      hasColumnAnchor: false,
      hasRowAnchor: false,
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
  const [pasteHighlightRegions, setPasteHighlightRegions] = useState<Highlight[]>([])
  const pasteHighlightTimeoutRef = useRef<number | null>(null)
  const [gridInteractionMode, setGridInteractionMode] = useState<GridInteractionMode>('normal')
  const [hasActiveFormulaSession, setHasActiveFormulaSession] = useState(false)
  const [activeFormulaSessionSource, setActiveFormulaSessionSource] = useState<FormulaEditSource | null>(null)
  const gridInteractionModeRef = useRef<GridInteractionMode>('normal')
  useEffect(() => {
    gridInteractionModeRef.current = gridInteractionMode
  }, [gridInteractionMode])

  useEffect(() => {
    setPasteHighlightRegions([])
    if (pasteHighlightTimeoutRef.current !== null) {
      window.clearTimeout(pasteHighlightTimeoutRef.current)
      pasteHighlightTimeoutRef.current = null
    }
    return () => {
      if (pasteHighlightTimeoutRef.current !== null) {
        window.clearTimeout(pasteHighlightTimeoutRef.current)
        pasteHighlightTimeoutRef.current = null
      }
    }
  }, [currentDataset?.id])

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
  const copyContextRef = useRef<ClipboardCopyContext | null>(null)
  const activePasteContextRef = useRef<PasteOperationContext | null>(null)
  const pasteOperationDepthRef = useRef(0)
  const pasteReadGateRef = useRef(false)
  const cutInFlightRef = useRef(false)
  const watchedCutDebugRef = useRef<WatchedCutDebugContext | null>(null)
  const postPasteFlushInFlightRef = useRef<Map<string, Promise<void>>>(new Map())
  const datasetsNeedingReloadOnActivateRef = useRef<Set<string>>(sharedDatasetsNeedingReloadOnActivate)
  const gridMutationPlanRef = useRef<
    (input: { id: string; datasetId: string; kind: GridMutationKind; transaction?: GridTransactionRecord }) => Promise<GridTransactionRecord>
  >(async (input) => input.transaction ?? { id: input.id, datasetId: input.datasetId, kind: input.kind })
  const gridMutationApplyLocalRef = useRef<(transaction: GridTransactionRecord) => Promise<void>>(async () => {})
  const gridMutationEnqueuePersistRef = useRef<(transaction: GridTransactionRecord) => Promise<void>>(async () => {})
  const gridMutationFinalizeUiRef = useRef<(transaction: GridTransactionRecord) => Promise<void>>(async () => {})
  const gridMutationCoordinatorRef = useRef<GridMutationCoordinator | null>(null)
  const currentSchemaKeyRef = useRef<string | null>(currentSchemaKey)
  const pendingLocalSchemaMutationRef = useRef<{
    datasetId: string
    previousSchemaKey: string | null
    nextSchemaKey: string
    reason: string
  } | null>(null)
  const datasetRevisionRef = useRef(0)
  const activationContinuityRef = useRef<{
    datasetId: string
    rows: Map<number, Record<string, unknown>>
  } | null>(null)
  const pendingRestoreSortRef = useRef<{
    sortModel: SortKey[]
    skipConfirm?: boolean
  } | null>(null)
  useEffect(() => {
    activeCellRef.current = activeCell
  }, [activeCell])

  useEffect(() => {
    currentSchemaKeyRef.current = currentSchemaKey
  }, [currentSchemaKey])

  const markLocalSchemaMutation = useCallback((datasetId: string, reason = 'local-schema-mutation') => {
    const latestDataset = useDataStore.getState().currentDataset
    if (!latestDataset || latestDataset.id !== datasetId) return
    const nextSchemaKey = computeDatasetSchemaKey(latestDataset)
    if (!nextSchemaKey) return
    const previousSchemaKey = currentSchemaKeyRef.current
    if (previousSchemaKey === nextSchemaKey) {
      pendingLocalSchemaMutationRef.current = null
      return
    }
    pendingLocalSchemaMutationRef.current = {
      datasetId,
      previousSchemaKey,
      nextSchemaKey,
      reason,
    }
  }, [])

  const logGridDebug = useCallback((event: string, payload?: Record<string, unknown>) => {
    logRuntimeDebug('grid', event, payload)
  }, [])
  const logPasteDebug = useCallback((event: string, payload?: Record<string, unknown>) => {
    logRuntimeDebug('paste', event, payload)
  }, [])
  const formulaDisplayDebugRef = useRef<Map<string, string>>(new Map())
  const logFormulaDisplayState = useCallback(
    (
      cellKey: string,
      state: 'draft' | 'pending' | 'raw' | 'computed',
      payload?: Record<string, unknown>
    ) => {
      const nextSignature = `${state}:${String(payload?.displayData ?? '')}:${String(payload?.copyData ?? '')}`
      const previousSignature = formulaDisplayDebugRef.current.get(cellKey)
      if (previousSignature === nextSignature) {
        return
      }
      formulaDisplayDebugRef.current.set(cellKey, nextSignature)
      logGridDebug('formula_grid_display_state', {
        cellKey,
        state,
        ...payload,
      })
    },
    [logGridDebug]
  )

  const nextGridOperationId = useCallback((prefix: 'copy' | 'paste' | 'cut' | 'delete' | 'type' | 'fill' | 'rename') => {
    return `${prefix}-${crypto.randomUUID()}`
  }, [])

  const logWatchedCutEvent = useCallback(
    (
      event: string,
      source: 'cut' | 'editExecutor' | 'ensureRangeLoaded' | 'loadBlocks' | 'lazyGroup' | 'getCellContent',
      details?: {
        datasetId?: string
        modelRow?: number
        columnId?: string
        cutOpId?: string
        valueBefore?: unknown
        valueAfter?: unknown
        loadRevision?: number | null
        extra?: Record<string, unknown>
      }
    ) => {
      const watched = watchedCutDebugRef.current
      if (!watched) return

      const datasetId = details?.datasetId ?? watched.datasetId
      const modelRow = details?.modelRow ?? watched.modelRow
      const columnId = details?.columnId ?? watched.columnId
      if (
        datasetId !== watched.datasetId ||
        modelRow !== watched.modelRow ||
        columnId !== watched.columnId
      ) {
        return
      }

      logGridDebug(event, {
        cutOpId: details?.cutOpId ?? watched.cutOpId,
        datasetId,
        modelRow,
        columnId,
        valueBefore: details?.valueBefore ?? null,
        valueAfter: details?.valueAfter ?? null,
        loadRevision: details?.loadRevision ?? null,
        currentRevision: datasetRevisionRef.current,
        source,
        ...(details?.extra ?? {}),
      })
    },
    [logGridDebug]
  )

  const logWatchedCutMapWrite = useCallback(
    (
      event: string,
      source: 'editExecutor' | 'ensureRangeLoaded' | 'loadBlocks' | 'lazyGroup',
      datasetId: string,
      prevRows: Map<number, Record<string, unknown>>,
      nextRows: Map<number, Record<string, unknown>>,
      loadRevision?: number | null
    ) => {
      const watched = watchedCutDebugRef.current
      if (!watched || watched.datasetId !== datasetId) return
      const valueBefore = prevRows.get(watched.modelRow)?.[watched.columnId] ?? null
      const valueAfter = nextRows.get(watched.modelRow)?.[watched.columnId] ?? null
      if (Object.is(valueBefore, valueAfter)) return
      logWatchedCutEvent(event, source, {
        datasetId,
        valueBefore,
        valueAfter,
        loadRevision,
      })
    },
    [logWatchedCutEvent]
  )

  const requestPostPasteOverlayFlush = useCallback(
    (
      datasetId: string,
      source: 'paste' | 'paste-values' | 'paste-transpose' | 'e2e-paste',
      mutationId: string
    ) => {
      const meta = getOrCreateOverlayMeta(datasetId)
      const pendingFlushMutationIds = meta.pendingFlushMutationIds.includes(mutationId)
        ? meta.pendingFlushMutationIds
        : [...meta.pendingFlushMutationIds, mutationId]
      sharedOverlayMetaByDataset.set(datasetId, {
        ...meta,
        pendingFlushMutationIds,
      })
      setPasteFinalizing(true)

      const inFlight = postPasteFlushInFlightRef.current.get(datasetId)
      if (inFlight) {
        logPasteDebug('paste_overlay_flush_deduped', {
          datasetId,
          source,
          mutationId,
          pendingFlushMutationIds,
        })
        return
      }

      const flushStartedAt = Date.now()
      logPasteDebug('paste_overlay_flush_start', {
        datasetId,
        source,
        mutationId,
        pendingFlushMutationIds,
        overlayHasRows: sharedOverlayModelByDataset.get(datasetId)?.hasOverlayRows() ?? false,
      })
      const currentTiming = currentPasteTimingByTransactionRef.current.get(mutationId)
      if (currentTiming) {
        currentTiming.flushStartedAt = flushStartedAt
        logPasteDebug('paste_current_flush_start', {
          datasetId,
          source,
          transactionId: mutationId,
          editCount: currentTiming.editCount,
          rowCount: currentTiming.rowCount,
          columnCount: currentTiming.columnCount,
          oldValueLookupCount: currentTiming.oldValueLookupCount,
        })
      }
      const flushPromise = cacheService
        .flushOverlay(datasetId)
        .then(() => {
          const meta = sharedOverlayMetaByDataset.get(datasetId)
          const model = sharedOverlayModelByDataset.get(datasetId)
          const mutation = meta?.mutations.get(mutationId)
          if (meta && model && mutation) {
            for (const edit of mutation.edits) {
              const rowId = buildDatasetScopedRowId(datasetId, edit.row)
              const value = edit.computedValue ?? edit.newValue
              model.acknowledgeOverlay(rowId, {
                columnId: edit.columnId,
                mutationId,
                revision: mutation.revision,
                status: currentDatasetIdRef.current === datasetId ? 'confirmed' : 'persisted',
                value,
              })
            }
            if (currentDatasetIdRef.current !== datasetId) {
              const persistedMutationIds = meta.persistedMutationIds.includes(mutationId)
                ? meta.persistedMutationIds
                : [...meta.persistedMutationIds, mutationId]
              sharedOverlayMetaByDataset.set(datasetId, {
                ...meta,
                persistedMutationIds,
              })
            } else {
              meta.mutations.delete(mutationId)
              if (!model.hasOverlayRows()) {
                clearDatasetOverlayState(datasetId)
              }
            }
          }
          logPasteDebug('paste_overlay_flush_done', {
            datasetId,
            source,
            mutationId,
            durationMs: Date.now() - flushStartedAt,
            overlayHasRows: sharedOverlayModelByDataset.get(datasetId)?.hasOverlayRows() ?? false,
          })
          const currentTiming = currentPasteTimingByTransactionRef.current.get(mutationId)
          if (currentTiming) {
            currentTiming.overlayFlushDurationMs = Date.now() - flushStartedAt
            logPasteDebug('paste_current_flush_done', {
              datasetId,
              source,
              transactionId: mutationId,
              editCount: currentTiming.editCount,
              rowCount: currentTiming.rowCount,
              columnCount: currentTiming.columnCount,
              oldValueLookupCount: currentTiming.oldValueLookupCount,
              overlayFlushDurationMs: currentTiming.overlayFlushDurationMs,
            })
          }
        })
        .catch((error) => {
          currentPasteTimingByTransactionRef.current.delete(mutationId)
          logPasteDebug('paste_overlay_flush_failed', {
            datasetId,
            source,
            mutationId,
            durationMs: Date.now() - flushStartedAt,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          if (postPasteFlushInFlightRef.current.get(datasetId) === flushPromise) {
            postPasteFlushInFlightRef.current.delete(datasetId)
          }
          const meta = sharedOverlayMetaByDataset.get(datasetId)
          const nextPendingFlushMutationIds = meta
            ? meta.pendingFlushMutationIds.filter((id) => id !== mutationId)
            : []
          if (meta) {
            sharedOverlayMetaByDataset.set(datasetId, {
              ...meta,
              pendingFlushMutationIds: nextPendingFlushMutationIds,
            })
          }
          const nextMutationId = nextPendingFlushMutationIds[0] ?? null
          if (nextMutationId) {
            requestPostPasteOverlayFlush(datasetId, source, nextMutationId)
            return
          }
          if (postPasteFlushInFlightRef.current.size === 0) {
            setPasteFinalizing(false)
          }
        })

      postPasteFlushInFlightRef.current.set(datasetId, flushPromise)
    },
    [logPasteDebug, setPasteFinalizing]
  )

  const startCurrentPasteHydrateTiming = useCallback(
    (
      transactionId: string,
      datasetId: string,
      source: CurrentPasteTimingBuckets['source'],
      hydrateBlockKeys: string[]
    ) => {
      const currentTiming = currentPasteTimingByTransactionRef.current.get(transactionId)
      if (!currentTiming || currentTiming.hydrateStartedAt !== undefined) return

      const hydrateStartedAt = Date.now()
      currentTiming.hydrateStartedAt = hydrateStartedAt
      currentTiming.hydratePendingBlockKeys = new Set(hydrateBlockKeys)
      currentTiming.hydrateCompletedBlockCount = 0
      logPasteDebug('paste_current_hydrate_start', {
        datasetId,
        source,
        transactionId,
        editCount: currentTiming.editCount,
        rowCount: currentTiming.rowCount,
        columnCount: currentTiming.columnCount,
        hydrateBlockCount: hydrateBlockKeys.length,
        hydrateBlockSample: hydrateBlockKeys.slice(0, 12),
      })

      if (hydrateBlockKeys.length === 0) {
        currentTiming.hydrateDurationMs = Date.now() - hydrateStartedAt
        logPasteDebug('paste_current_hydrate_done', {
          datasetId,
          source,
          transactionId,
          editCount: currentTiming.editCount,
          rowCount: currentTiming.rowCount,
          columnCount: currentTiming.columnCount,
          hydrateBlockCount: 0,
          hydrateCompletedBlocks: 0,
          hydrateDurationMs: currentTiming.hydrateDurationMs,
        })
        currentPasteTimingByTransactionRef.current.delete(transactionId)
      }
    },
    [logPasteDebug]
  )

  const completeCurrentPasteHydrateBlocks = useCallback(
    (datasetId: string, completedBlockKeys: Set<string>) => {
      if (completedBlockKeys.size === 0) return
      for (const [transactionId, currentTiming] of currentPasteTimingByTransactionRef.current.entries()) {
        if (currentTiming.datasetId !== datasetId || !currentTiming.hydratePendingBlockKeys) continue
        let completedNow = 0
        for (const blockKey of completedBlockKeys) {
          if (currentTiming.hydratePendingBlockKeys.delete(blockKey)) {
            completedNow += 1
          }
        }
        if (completedNow === 0) continue

        currentTiming.hydrateCompletedBlockCount =
          (currentTiming.hydrateCompletedBlockCount ?? 0) + completedNow
        if (currentTiming.hydratePendingBlockKeys.size > 0) continue

        currentTiming.hydrateDurationMs = Date.now() - (currentTiming.hydrateStartedAt ?? Date.now())
        logPasteDebug('paste_current_hydrate_done', {
          datasetId,
          source: currentTiming.source,
          transactionId,
          editCount: currentTiming.editCount,
          rowCount: currentTiming.rowCount,
          columnCount: currentTiming.columnCount,
          hydrateBlockCount: currentTiming.hydrateCompletedBlockCount,
          hydrateCompletedBlocks: currentTiming.hydrateCompletedBlockCount,
          hydrateDurationMs: currentTiming.hydrateDurationMs,
        })
        currentPasteTimingByTransactionRef.current.delete(transactionId)
      }
    },
    [logPasteDebug]
  )

  const recordCopyContext = useCallback(
    (
      sourceDatasetId: string,
      clipboardText: string,
      options?: {
        includesColumnHeaders?: boolean
        copiedColumnHeaders?: string[]
      }
    ) => {
      const nextContext: ClipboardCopyContext = {
        copyOpId: nextGridOperationId('copy'),
        sourceDatasetId,
        sourceFamilyId: activeFamilyId ?? null,
        clipboardText,
        includesColumnHeaders: options?.includesColumnHeaders,
        copiedColumnHeaders: options?.copiedColumnHeaders,
      }
      copyContextRef.current = nextContext
      logGridDebug('copy_context_recorded', {
        copyOpId: nextContext.copyOpId,
        sourceDatasetId,
        sourceFamilyId: nextContext.sourceFamilyId,
        includesColumnHeaders: nextContext.includesColumnHeaders === true,
        clipboardLength: clipboardText.length,
      })
    },
    [activeFamilyId, logGridDebug, nextGridOperationId]
  )

  const confirmOverlayMutation = useCallback((datasetId: string, mutationId: string, options?: { clearConvergedNow?: boolean }) => {
    const model = sharedOverlayModelByDataset.get(datasetId)
    const meta = sharedOverlayMetaByDataset.get(datasetId)
    const mutation = meta?.mutations.get(mutationId)
    if (!model || !meta || !mutation) return false
    const clearConvergedNow = options?.clearConvergedNow ?? true

    const touchedRows = new Set<number>()
    for (const edit of mutation.edits) {
      const rowId = buildDatasetScopedRowId(datasetId, edit.row)
      model.acknowledgeOverlay(rowId, {
        columnId: edit.columnId,
        mutationId,
        revision: mutation.revision,
        status: 'confirmed',
        value: edit.computedValue ?? edit.newValue,
      })
      touchedRows.add(edit.row)
    }

    if (clearConvergedNow) {
      for (const rowIndex of touchedRows) {
        model.clearConfirmedOverlay(buildDatasetScopedRowId(datasetId, rowIndex))
      }
    }

    if (!model.hasOverlayRows()) {
      clearDatasetOverlayState(datasetId)
    }

    return true
  }, [])

  const clearClipboardHandlers = useCallback(() => {
    onCopyRequest?.(null)
    onCutRequest?.(null)
    onPasteRequest?.(null)
    onUndoRequest?.(null)
    onRedoRequest?.(null)
  }, [onCopyRequest, onCutRequest, onPasteRequest, onUndoRequest, onRedoRequest])

  const beginPasteContext = useCallback(
    (
      destDatasetId: string,
      anchorRow: number,
      anchorCol: number,
      clipboardText: string,
      copyContextAtPasteStart: ClipboardCopyContext | null,
      selectionRevision: number
    ): PasteOperationContext => {
      const copyContext = copyContextAtPasteStart
      const hasInternalCopyContext = !!copyContext && copyContext.clipboardText === clipboardText
      const context: PasteOperationContext = {
        pasteOpId: nextGridOperationId('paste'),
        destDatasetId,
        destAnchor: { row: anchorRow, col: anchorCol },
        selectionRevision,
      }
      if (hasInternalCopyContext && copyContext) {
        context.copyOpId = copyContext.copyOpId
        context.sourceDatasetId = copyContext.sourceDatasetId
        context.sourceFamilyId = copyContext.sourceFamilyId
      }
      activePasteContextRef.current = context
      pasteOperationDepthRef.current += 1
      setPasteInFlight(true)
      logPasteDebug('paste_context_begin', {
        pasteOpId: context.pasteOpId,
        destDatasetId,
        anchorRow,
        anchorCol,
        clipboardLength: clipboardText.length,
        selectionRevision,
        hasInternalCopyContext,
        sourceDatasetId: context.sourceDatasetId ?? null,
        sourceFamilyId: context.sourceFamilyId ?? null,
      })
      return context
    },
    [logPasteDebug, nextGridOperationId, setPasteInFlight]
  )

  const tryEnterPasteReadGate = useCallback(
    (source: 'paste' | 'paste-values' | 'paste-transpose'): boolean => {
      if (pasteReadGateRef.current || useAppStore.getState().pasteInFlight) {
        logPasteDebug('paste_abort', {
          reason: 'paste_in_flight',
          source,
          datasetId: currentDataset?.id ?? null,
        })
        return false
      }
      pasteReadGateRef.current = true
      return true
    },
    [currentDataset?.id, logPasteDebug]
  )

  const releasePasteReadGate = useCallback(() => {
    pasteReadGateRef.current = false
  }, [])

  const isPasteContextActive = useCallback((context: PasteOperationContext): boolean => {
    const activePasteContext = activePasteContextRef.current
    if (activePasteContext === null) {
      logPasteDebug('paste_context_inactive', {
        reason: 'context_cleared',
        pasteOpId: context.pasteOpId,
      })
      return false
    }
    const activePasteOpId = activePasteContext.pasteOpId
    if (activePasteOpId !== context.pasteOpId) {
      logPasteDebug('paste_context_inactive', {
        reason: 'paste_op_mismatch',
        pasteOpId: context.pasteOpId,
        activePasteOpId,
      })
      return false
    }
    const activeDatasetId = useDataStore.getState().currentDataset?.id ?? currentDatasetIdRef.current
    if (activeDatasetId !== context.destDatasetId) {
      logPasteDebug('paste_context_inactive', {
        reason: 'dataset_mismatch',
        pasteOpId: context.pasteOpId,
        activeDatasetId,
        expectedDatasetId: context.destDatasetId,
      })
      return false
    }
    if (selectionRevisionRef.current !== context.selectionRevision) {
      logPasteDebug('paste_context_inactive', {
        reason: 'selection_changed',
        pasteOpId: context.pasteOpId,
        selectionRevision: context.selectionRevision,
        activeSelectionRevision: selectionRevisionRef.current,
      })
      return false
    }
    if (!context.copyOpId) {
      return true
    }
    const activeCopyOpId = copyContextRef.current?.copyOpId ?? null
    const isActive = activeCopyOpId === context.copyOpId
    if (!isActive) {
      logPasteDebug('paste_context_inactive', {
        reason: 'copy_op_mismatch',
        pasteOpId: context.pasteOpId,
        copyOpId: context.copyOpId,
        activeCopyOpId,
      })
    }
    return isActive
  }, [logPasteDebug])

  const endPasteContext = useCallback((context: PasteOperationContext) => {
    if (pasteOperationDepthRef.current > 0) {
      pasteOperationDepthRef.current -= 1
    }
    if (activePasteContextRef.current?.pasteOpId === context.pasteOpId) {
      activePasteContextRef.current = null
      logPasteDebug('paste_context_end', { pasteOpId: context.pasteOpId })
    } else {
      logPasteDebug('paste_context_end_mismatch', {
        pasteOpId: context.pasteOpId,
        activePasteOpId: activePasteContextRef.current?.pasteOpId ?? null,
      })
    }
    if (pasteOperationDepthRef.current === 0) {
      setPasteInFlight(false)
      if (postPasteFlushInFlightRef.current.size === 0) {
        setPasteFinalizing(false)
      }
    }
  }, [logPasteDebug, setPasteFinalizing, setPasteInFlight])

  useEffect(() => {
    return () => {
      pasteReadGateRef.current = false
      pasteOperationDepthRef.current = 0
      setPasteInFlight(false)
      setPasteFinalizing(false)
    }
  }, [setPasteFinalizing, setPasteInFlight])

  const pasteJobLockController = useMemo<PasteJobLockController>(
    () => ({
      acquire: acquireAppOperationLock,
      update: updateAppOperationLock,
      release: releaseAppOperationLock,
    }),
    [acquireAppOperationLock, releaseAppOperationLock, updateAppOperationLock]
  )

  const runVisualPasteJob = useCallback(
    async (
      source: Exclude<PasteJobSource, 'e2e-paste'>,
      run: (progress?: PasteProgressHandle) => Promise<void>
    ) => {
      const result = await runSingleChunkPasteJob({
        source,
        useVisualLock: true,
        lock: pasteJobLockController,
        run,
      })
      if (!result.ok) {
        toast.warning('Paste is unavailable while another operation is running.')
      }
      return result
    },
    [pasteJobLockController]
  )

  const reportPasteBuildProgress = useCallback((
    progress: PasteProgressHandle | undefined,
  ) => (chunkIndex: number, totalChunks: number) => {
    const total = Math.max(1, totalChunks)
    progress?.update({
      stage: `Preparing paste ${chunkIndex + 1}/${total}...`,
      progress: 5 + Math.floor(((chunkIndex + 1) / total) * 40),
    })
  }, [])

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
      sortModel: sortModelRef.current,
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

  const clearPendingActivationBundle = useCallback((options?: { restoreStagedRowOrder?: boolean }) => {
    const bundle = pendingActivationBundleRef.current
    if (options?.restoreStagedRowOrder && bundle) {
      baseSortedOrderRef.current = bundle.previousBaseSortedOrder
      rowOrderRef.current = bundle.previousRowOrder
      setRowOrder(bundle.previousRowOrder)
      setGroupMeta(bundle.previousGroupMeta)
    }
    pendingActivationBundleRef.current = null
    pendingActivationPrefetchKeyRef.current = null
    setPendingActivationDatasetId(null)
  }, [])

  const isPendingActivationBundleReady = useCallback((bundle: PendingActivationBundle, dataset: Dataset) => {
    const targetModelRows =
      bundle.targetModelRows ??
      buildModelRowRange(
        bundle.visibleStartRow,
        Math.min(bundle.visibleEndRow, resolveDataRowCount(dataset))
      )
    if (targetModelRows.length === 0) {
      return true
    }
    for (const modelRow of targetModelRows) {
      // Activation only needs confirmation that preload resolved this row.
      // Empty-row sentinels stay non-materialized for copy/cut/delete.
      if (!rowDataRef.current.has(modelRow)) {
        return false
      }
    }
    return true
  }, [])

  const resolveActivationBundleTargetRows = useCallback(
    async (
      bundle: PendingActivationBundle,
      dataset: Dataset
    ): Promise<{ rowOrder: number[]; targetModelRows: number[] }> => {
      if (bundle.restoreSortModel.length === 0 || bundle.groupByColumnId !== null) {
        const visibleDataEnd = Math.min(bundle.visibleEndRow, resolveDataRowCount(dataset))
        return {
          rowOrder: bundle.rowOrder,
          targetModelRows: buildModelRowRange(bundle.visibleStartRow, visibleDataEnd),
        }
      }

      const primaryKey = bundle.restoreSortModel[0]
      if (!primaryKey) {
        const visibleDataEnd = Math.min(bundle.visibleEndRow, resolveDataRowCount(dataset))
        return {
          rowOrder: bundle.rowOrder,
          targetModelRows: buildModelRowRange(bundle.visibleStartRow, visibleDataEnd),
        }
      }

      const dataRowCount = resolveDataRowCount(dataset)
      const totalRowCount = dataset.rowCount
      const storageInfo = await getStorageInfo(dataset.id)
      const isLargeDataset = storageInfo?.isLarge === true

      let sortedOrder: number[]
      if (isLargeDataset) {
        await cacheService.ensureLatestCache(dataset.id)
        const sortedIndices = await cacheService.getSortedRowIndices(
          dataset.id,
          primaryKey.colId,
          primaryKey.dir === 'desc'
        )
        const normalizedSorted = sortedIndices.map((idx) => Number(idx))
        const effectiveDataRowCount = Math.min(dataRowCount, normalizedSorted.length)
        const bufferRowIndices = Array.from(
          { length: totalRowCount - effectiveDataRowCount },
          (_, i) => effectiveDataRowCount + i
        )
        sortedOrder = [...normalizedSorted.slice(0, effectiveDataRowCount), ...bufferRowIndices]
      } else {
        await cacheService.ensureLatestCache(dataset.id)
        const columnValues = await cacheService.getColumnData(dataset.id, primaryKey.colId)
        const column = dataset.columns.find((candidate) => candidate.id === primaryKey.colId)
        const comparator = makeExcelComparator(column?.type)
        const dataRowIndices = Array.from({ length: dataRowCount }, (_, index) => index)
        const bufferRowIndices = Array.from(
          { length: totalRowCount - dataRowCount },
          (_, index) => dataRowCount + index
        )
        const baseIndex = new Map<number, number>()
        dataRowIndices.forEach((row, index) => baseIndex.set(row, index))
        const sortedDataIndices = [...dataRowIndices].sort((modelRowA, modelRowB) => {
          const comparison = comparator(columnValues[modelRowA], columnValues[modelRowB])
          if (comparison !== 0) {
            return primaryKey.dir === 'asc' ? comparison : -comparison
          }
          return (baseIndex.get(modelRowA) ?? 0) - (baseIndex.get(modelRowB) ?? 0)
        })
        sortedOrder = [...sortedDataIndices, ...bufferRowIndices]
      }

      const filteredOrder = applyActiveFilter(sortedOrder)
      const visibleEndRow = Math.min(bundle.visibleEndRow, filteredOrder.length)
      return {
        rowOrder: filteredOrder,
        targetModelRows: filteredOrder.slice(bundle.visibleStartRow, visibleEndRow),
      }
    },
    [applyActiveFilter, getStorageInfo, resolveDataRowCount]
  )

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
    const previousDatasetId = previousDatasetIdRef.current
    const previousSchemaKey = previousSchemaKeyRef.current
    const datasetChanged = previousDatasetId !== nextDatasetId
    const schemaChanged = previousSchemaKey !== nextSchemaKey
    const viewChanged = previousViewKey !== nextViewKey
    const structuralChanged = datasetChanged || schemaChanged

    logGridDebug('dataset_transition', {
      previousDatasetId,
      nextDatasetId,
      previousSchemaKey,
      nextSchemaKey,
      previousViewKey,
      nextViewKey,
      datasetChanged,
      schemaChanged,
      viewChanged,
      structuralChanged,
      currentRevision: datasetRevisionRef.current,
    })

    previousViewStateKeyRef.current = nextViewKey
    previousDatasetIdRef.current = nextDatasetId
    previousSchemaKeyRef.current = nextSchemaKey
    currentDatasetIdRef.current = nextDatasetId
    const pendingLocalSchemaMutation = pendingLocalSchemaMutationRef.current
    const shouldUseLocalSchemaMutationPath =
      schemaChanged &&
      !datasetChanged &&
      nextDatasetId !== null &&
      nextSchemaKey !== null &&
      pendingLocalSchemaMutation?.datasetId === nextDatasetId &&
      pendingLocalSchemaMutation.previousSchemaKey === previousSchemaKey &&
      pendingLocalSchemaMutation.nextSchemaKey === nextSchemaKey
    if (schemaChanged) {
      pendingLocalSchemaMutationRef.current = null
    }
    if (shouldUseLocalSchemaMutationPath) {
      datasetRevisionRef.current += 1
      clearPendingActivationBundle()
      setIsLazyGrouped(false)
      setLazyGroupMeta([])
      lazyRowCacheRef.current.clear()
      requestGridRefresh({ reason: pendingLocalSchemaMutation.reason, scope: 'viewport' })
      return
    }

    if (structuralChanged) {
      const visibleStartRow = Math.max(0, visibleRegionRef.current.y)
      const visibleEndRow = Math.max(
        visibleStartRow,
        visibleStartRow + Math.max(1, visibleRegionRef.current.height)
      )
      const priorPendingActivationBundle = pendingActivationBundleRef.current
      const continuitySourceRows =
        rowDataRef.current.size > 0 || activationContinuityRef.current?.rows
          ? (() => {
              const visibleRows = new Map<number, Record<string, unknown>>()
              activationContinuityRef.current?.rows.forEach((row, modelRow) => {
                if (modelRow >= visibleStartRow && modelRow < visibleEndRow) {
                  visibleRows.set(modelRow, row)
                }
              })
              rowDataRef.current.forEach((row, modelRow) => {
                if (modelRow >= visibleStartRow && modelRow < visibleEndRow) {
                  const hiddenByPendingActivationSurface =
                    priorPendingActivationBundle &&
                    modelRow >= priorPendingActivationBundle.visibleStartRow &&
                    modelRow < priorPendingActivationBundle.visibleEndRow
                  if (hiddenByPendingActivationSurface) {
                    return
                  }
                  visibleRows.set(modelRow, row)
                }
              })
              return visibleRows.size > 0 ? visibleRows : null
            })()
          : null
      const preserveVisibleRowsDuringActivation =
        datasetChanged &&
        nextDatasetId !== null &&
        continuitySourceRows !== null

      activationContinuityRef.current = preserveVisibleRowsDuringActivation
        ? {
            // Destination-tagged display bridge: rows belong to the next dataset
            // activation window, not the origin dataset they were copied from.
            datasetId: nextDatasetId,
            rows: continuitySourceRows,
          }
        : null

      datasetRevisionRef.current += 1
      if (datasetChanged && schemaChanged) {
        requestGridRefresh({ reason: 'schema-change-dataset-switch', scope: 'remount' })
      }

      // CRITICAL: Reset ALL streaming state on dataset/schema change
      clearBlockStateTracking()
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
      clearPendingActivationBundle()
      activationContinuityRef.current = null
      setRowOrder([])
      baseSortedOrderRef.current = []
      setGroupByColumnId(null)
      setCollapsedGroups(new Set())
      setGroupMeta([])
      setSortModel([])
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
    const columnIdSet = new Set(currentDataset.columns.map((col) => col.id))

    // Migration: new sessions write sortModel[]; old sessions wrote sortColumn/sortDirection.
    const restoredSortModel: SortKey[] = (() => {
      if (canRestoreState && savedState.sortModel && savedState.sortModel.length > 0) {
        return savedState.sortModel.filter((k) => columnIdSet.has(k.colId))
      }
      if (canRestoreState && savedState.sortColumn && columnIdSet.has(savedState.sortColumn)) {
        return [{ colId: savedState.sortColumn, dir: savedState.sortDirection ?? 'asc' }]
      }
      return []
    })()

    const restoredGroupByColumn =
      canRestoreState && savedState.groupByColumnId && columnIdSet.has(savedState.groupByColumnId)
        ? savedState.groupByColumnId
        : null
    const collapsedGroupKeys = restoredGroupByColumn && canRestoreState ? savedState.collapsedGroupKeys : []

    const emptySelection = buildEmptySelection()
    const selectionCandidate =
      canRestoreState ? savedState?.gridSelection ?? emptySelection : emptySelection
    const selectionToApply = isSelectionValid(selectionCandidate) ? selectionCandidate : emptySelection

    const activeCellCandidate = canRestoreState ? savedState?.activeCell ?? null : null
    const activeCellToApply = isActiveCellValid(activeCellCandidate) ? activeCellCandidate : null

    const restoredScroll = canRestoreState ? savedState?.scroll ?? null : null
    const scrollToApply = restoredScroll
      ? clampScrollTarget(restoredScroll, currentDataset)
      : structuralChanged || viewChanged
        ? { x: 0, y: 0 }
        : null

    const shouldStageActivationBundle =
      structuralChanged &&
      datasetChanged &&
      (
        activationContinuityRef.current?.datasetId === currentDataset.id ||
        (
          schemaChanged &&
          resolveDataRowCount(currentDataset) > 0 &&
          lastRenderableGridKeyRef.current !== 'placeholder'
        )
      )

    if (shouldStageActivationBundle) {
      const targetVisibleStartRow = Math.max(0, scrollToApply?.y ?? visibleRegionRef.current.y)
      const visibleEndRow = Math.max(
        targetVisibleStartRow,
        targetVisibleStartRow + Math.max(1, visibleRegionRef.current.height)
      )
      const token = activationTokenRef.current + 1
      activationTokenRef.current = token
      pendingActivationBundleRef.current = {
        token,
        datasetId: currentDataset.id,
        rowCountSnapshot: currentDataset.rowCount,
        previousBaseSortedOrder: [...baseSortedOrderRef.current],
        previousRowOrder: [...rowOrderRef.current],
        previousGroupMeta: [...groupMetaRef.current],
        visibleStartRow: targetVisibleStartRow,
        visibleEndRow,
        rowOrder: defaultOrder,
        targetModelRows: null,
        sortModel: restoredSortModel,
        restoreSortModel: restoredSortModel,
        groupByColumnId: restoredGroupByColumn,
        collapsedGroups: new Set(collapsedGroupKeys),
        gridSelection: selectionToApply,
        activeCell: activeCellToApply,
        scroll: scrollToApply ?? { x: 0, y: 0 },
      }
      baseSortedOrderRef.current = defaultOrder
      setRowOrder(defaultOrder)
      setGroupMeta([])
      setPendingActivationDatasetId(currentDataset.id)
      pendingRestoreSortRef.current = null
    } else {
      clearPendingActivationBundle()
      baseSortedOrderRef.current = defaultOrder
      setRowOrder(defaultOrder)
      setGroupMeta([])
      setSortModel([])
      setGroupByColumnId(restoredGroupByColumn)
      setCollapsedGroups(new Set(collapsedGroupKeys))
      setGridSelection(selectionToApply)
      syncSelectionToStore(selectionToApply, currentDataset)
      setActiveCell(activeCellToApply)

      if (restoredSortModel.length > 0) {
        pendingRestoreSortRef.current = {
          sortModel: restoredSortModel,
          skipConfirm: true,
        }
      }

      if (scrollToApply) {
        requestScrollRestore(scrollToApply)
      }
    }

    // Trigger initial load for first visible rows
    // onVisibleRegionChanged will load more as user scrolls
    // Note: ensureRangeLoaded is not available yet in this effect,
    // so we rely on onVisibleRegionChanged to trigger the initial load
  }, [
    resolvedStateKey,
    currentSchemaKey,
    clampScrollTarget,
    requestGridRefresh,
    requestScrollRestore,
    logGridDebug,
    clearPendingActivationBundle,
  ]) // Depend on view + dataset schema changes

  useEffect(() => {
    const bundle = pendingActivationBundleRef.current
    if (!bundle || !currentDataset || bundle.datasetId !== currentDataset.id) {
      return
    }
    if (bundle.token !== activationTokenRef.current) {
      if (pendingActivationBundleRef.current?.token === bundle.token) {
        clearPendingActivationBundle({ restoreStagedRowOrder: true })
      }
      return
    }
    if (!isPendingActivationBundleReady(bundle, currentDataset)) {
      return
    }

    pendingActivationBundleRef.current = null
    setPendingActivationDatasetId(null)
    activationContinuityRef.current = null

    const currentRowCount = currentDataset.rowCount
    const bundleRowOrderIsCurrent =
      bundle.rowCountSnapshot === currentRowCount &&
      bundle.rowOrder.length === currentRowCount
    const promotedRowOrder = bundleRowOrderIsCurrent
      ? bundle.rowOrder
      : Array.from({ length: currentRowCount }, (_, i) => i)
    if (!bundleRowOrderIsCurrent) {
      logGridDebug('activation_bundle_row_order_rebuilt', {
        datasetId: currentDataset.id,
        token: bundle.token,
        rowCount: currentRowCount,
        rowCountSnapshot: bundle.rowCountSnapshot,
        rowOrderLength: bundle.rowOrder.length,
      })
    }

    baseSortedOrderRef.current = promotedRowOrder
    setRowOrder(promotedRowOrder)
    setGroupMeta([])
    setSortModel([])
    setGroupByColumnId(bundle.groupByColumnId)
    setCollapsedGroups(new Set(bundle.collapsedGroups))
    setGridSelection(bundle.gridSelection)
    syncSelectionToStore(bundle.gridSelection, currentDataset)
    setActiveCell(bundle.activeCell)

    if (bundle.restoreSortModel.length > 0) {
      pendingRestoreSortRef.current = {
        sortModel: bundle.restoreSortModel,
        skipConfirm: true,
      }
    } else {
      pendingRestoreSortRef.current = null
    }

    requestScrollRestore(bundle.scroll)
    requestGridRefresh({ reason: 'activation-bundle-promote', scope: 'viewport' })
  }, [
    currentDataset,
    rowDataVersion,
    isPendingActivationBundleReady,
    requestGridRefresh,
    requestScrollRestore,
    syncSelectionToStore,
    logGridDebug,
  ])

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

  const findInvalidTypedPasteEdit = useCallback((edits: CellEdit[]) => {
    for (const edit of edits) {
      const columnMetadata = columnMetadataMap.get(edit.columnId)
      if (columnMetadata?.type !== 'numeric') {
        continue
      }
      if (typeof edit.newValue !== 'string') {
        continue
      }
      const trimmedValue = edit.newValue.trim()
      if (trimmedValue === '') {
        continue
      }
      if (trimmedValue.startsWith('=')) {
        continue
      }
      if (numericSemantics.isMissing(edit.newValue)) {
        continue
      }
      if (!numericSemantics.isValid(edit.newValue)) {
        return {
          columnId: edit.columnId,
          columnName: columnMetadata.name ?? edit.columnId,
          value: edit.newValue,
        }
      }
    }
    return null
  }, [columnMetadataMap])

  const findInvalidTypedPasteValue = useCallback((columnId: string, value: unknown) => {
    const columnMetadata = columnMetadataMap.get(columnId)
    if (columnMetadata?.type !== 'numeric') {
      return null
    }
    const coercedValue = coerceEditValue(
      value,
      columnMetadata.type,
      (s) => s.trim().startsWith('=')
    )
    if (typeof coercedValue !== 'string') {
      return null
    }
    const trimmedValue = coercedValue.trim()
    if (trimmedValue === '') {
      return null
    }
    if (trimmedValue.startsWith('=')) {
      return null
    }
    if (numericSemantics.isMissing(coercedValue)) {
      return null
    }
    if (!numericSemantics.isValid(coercedValue)) {
      return {
        columnId,
        columnName: columnMetadata.name ?? columnId,
        value: coercedValue,
      }
    }
    return null
  }, [columnMetadataMap])

  const rejectInvalidTypedPasteCells = useCallback((
    parsedData: string[][],
    startCol: number,
    targetColumns: GridColumn[],
  ): boolean => {
    for (const rowValues of parsedData) {
      for (let colOffset = 0; colOffset < rowValues.length; colOffset += 1) {
        const gridColumn = targetColumns[startCol + colOffset]
        if (!gridColumn?.id) {
          continue
        }
        const invalidValue = findInvalidTypedPasteValue(gridColumn.id, rowValues[colOffset])
        if (!invalidValue) {
          continue
        }
        toast.error(`Cannot paste text into numeric column "${invalidValue.columnName}".`)
        return true
      }
    }
    return false
  }, [findInvalidTypedPasteValue])

  const rejectInvalidTypedPasteEdits = useCallback((edits: CellEdit[]): boolean => {
    const invalidEdit = findInvalidTypedPasteEdit(edits)
    if (!invalidEdit) {
      return false
    }
    toast.error(`Cannot paste text into numeric column "${invalidEdit.columnName}".`)
    return true
  }, [findInvalidTypedPasteEdit])

  // Precompute row key fallbacks (id -> possible row keys) for datasets that
  // return rows keyed by display names instead of col-{idx} IDs.
  const liveColumnRowKeyFallbacks = useMemo(
    () => buildColumnFallbackCandidates(
      (currentDataset?.columns ?? []).map((col) => ({
        id: col.id,
        title: col.name ?? col.id,
      })) as GridColumn[]
    ),
    [currentDataset?.columns]
  )

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
          const row = cloneRowDataPreservingSentinel(newData.get(edit.row))
          row[edit.columnId] = edit.computedValue
          newData.set(edit.row, row)
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

  const schedulePendingCellUpdateFlush = useCallback(() => {
    if (pendingCellUpdatesRafRef.current !== null) return

    pendingCellUpdatesRafRef.current = requestAnimationFrame(() => {
      pendingCellUpdatesRafRef.current = null
      const editor = dataEditorRef.current
      if (!editor) return

      const pending = pendingCellUpdatesByKeyRef.current
      const chunk: Array<{ cell: readonly [number, number] }> = []
      for (const [key, update] of pending) {
        chunk.push(update)
        pending.delete(key)
        if (chunk.length >= MAX_CELLS_PER_UPDATE) break
      }

      if (chunk.length > 0) {
        editor.updateCells(chunk)
      }
      if (pending.size > 0) {
        schedulePendingCellUpdateFlush()
      }
    })
  }, [MAX_CELLS_PER_UPDATE])

  const scheduleCellUpdates = useCallback(
    (updates: Array<{ cell: readonly [number, number] }>) => {
      if (updates.length === 0) return

      const pending = pendingCellUpdatesByKeyRef.current
      if (
        updates.length <= MAX_CELLS_PER_UPDATE &&
        pending.size === 0 &&
        pendingCellUpdatesRafRef.current === null
      ) {
        dataEditorRef.current?.updateCells(updates)
        return
      }

      for (const update of updates) {
        const [col, row] = update.cell
        pending.set(`${col}:${row}`, update)
      }
      schedulePendingCellUpdateFlush()
    },
    [MAX_CELLS_PER_UPDATE, schedulePendingCellUpdateFlush]
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
      pendingCellUpdatesByKeyRef.current.clear()
      if (pendingCellUpdatesRafRef.current !== null) {
        cancelAnimationFrame(pendingCellUpdatesRafRef.current)
        pendingCellUpdatesRafRef.current = null
      }
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
    const rowRecord = cloneRowDataPreservingSentinel(updated.get(row))
    rowRecord[columnId] = value
    updated.set(row, rowRecord)
    rowDataRef.current = updated
    markSelectionStatsDirty()

    // Recalculate dependents (existing sync machinery)
    const dependentEdits = formulaService.recalculateDependents(cellKey)
    if (dependentEdits.length > 0) {
      for (const edit of dependentEdits) {
        const depRecord = cloneRowDataPreservingSentinel(updated.get(edit.row))
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

    // Refresh filter snapshot so newly edited values are re-evaluated
    invalidateFilterSnapshot()

    // Force grid repaint for the primary cell
    const colIndex = columnIndexByIdRef.current.get(columnId)
    if (colIndex !== undefined) {
      scheduleCellUpdates([{ cell: [colIndex, modelToView(row)] }])
    }
  }, [formulaService, currentDataset, modelToView, updateCellValue, invalidateColumns, scheduleCellUpdates, invalidateFilterSnapshot])

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
      const rowRecord = cloneRowDataPreservingSentinel(updated.get(update.row))
      rowRecord[update.columnId] = update.value
      updated.set(update.row, rowRecord)
    }
    rowDataRef.current = updated
    markSelectionStatsDirty()

    const dependentEdits = formulaService.recalculateDependents(cellKey)
    if (dependentEdits.length > 0) {
      for (const edit of dependentEdits) {
        const depRecord = cloneRowDataPreservingSentinel(updated.get(edit.row))
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

  // Stable wrapper so the callback registered with formulaService never changes identity
  // across sort/group/dep re-renders. Without this, the effect cleanup fires on every
  // re-render and briefly clears the callback — any IPC result arriving in the gap is lost.
  const handleBackendEvalResultRef = useRef(handleBackendEvalResult)
  // useLayoutEffect to guard against concurrent-mode interrupted renders writing a stale ref.
  useLayoutEffect(() => { handleBackendEvalResultRef.current = handleBackendEvalResult }, [handleBackendEvalResult])
  const stableHandleBackendEvalResult = useCallback(
    (cellKey: string, value: unknown, requestId: string) =>
      handleBackendEvalResultRef.current(cellKey, value, requestId),
    [] // stable — never changes identity
  )

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
            sortModelRef.current[0]?.colId ?? null,
            sortModelRef.current[0]?.dir === 'desc',
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
      primarySortKey,
    ]
  )

  // Enqueue async aggregate request
  const enqueueAggregate = useCallback(async (request: AsyncAggregateRequest) => {
    if (!currentDataset) return
    const AGGREGATE_TIMEOUT_MS = 60000
    const MAX_SCOPED_ROW_ORDER_IPC = 50_000

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
      if ((!rowIndices || rowIndices.length === 0) && request.scopedRowOrder) {
        if (request.scopedRowOrder.length > MAX_SCOPED_ROW_ORDER_IPC) {
          throw new Error('Toolbar view filter scope is too large for this full-column formula. Use the Advanced Filter dropdown option under Data to create a permanent filtered dataset, or use a bounded range.')
        }
        rowIndices = request.scopedRowOrder
      }
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
        Array.isArray(rowIndices)
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
        const isRangeTooLarge = /range too large|max_backend_range_cells|row-order IPC|filtered full-column/i.test(errorMessage)
        const errorValue = isRangeTooLarge ? '#VALUE!' : '#ERROR!'

        const updates: Array<{ row: number; columnId: string; value: unknown }> = [
          { row, columnId, value: errorValue },
        ]
        const affectedColumnIds = new Set<string>([columnId])

        const updated = new Map(rowDataRef.current)
        const rowRecord = cloneRowDataPreservingSentinel(updated.get(row))
        rowRecord[columnId] = errorValue
        updated.set(row, rowRecord)
        rowDataRef.current = updated
        markSelectionStatsDirty()

        const dependentEdits = formulaService?.recalculateDependents(request.cellKey) ?? []
        if (dependentEdits.length > 0) {
          for (const edit of dependentEdits) {
            const depRecord = cloneRowDataPreservingSentinel(updated.get(edit.row))
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

      const backendPromise = cacheService.evaluateFormulaBackend(
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

      // Mirror the aggregate timeout pattern: hard 15 s limit, deterministic #VALUE! on expiry.
      const result = await new Promise<unknown>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`Backend eval timed out after ${FormulaService.BACKEND_EVAL_TIMEOUT_MS / 1000}s`))
        }, FormulaService.BACKEND_EVAL_TIMEOUT_MS)
        backendPromise.then(resolve).catch(reject).finally(() => clearTimeout(timeoutId))
      })

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
        const isTimeout = error instanceof Error && error.message.includes('timed out')
        console.error(isTimeout ? '[BackendEval] Timeout:' : '[BackendEval] Failed:', request.cellKey, error)
        // Route through injectBackendEvalResult so ownership (cellKey + requestId) is
        // verified before writing. Both success and error settle through the same path.
        formulaService?.injectBackendEvalResult(request.cellKey, '#VALUE!', request.requestId)
      } else {
        console.warn('[enqueueBackendEval] Aborted, skipping error settlement:', request.cellKey)
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

  // B3: stable wrapper so formulaService's backendEvalContext never changes identity
  // on unrelated re-renders. The ref always points to the latest implementation.
  const enqueueBackendEvalRef = useRef(enqueueBackendEval)
  // useLayoutEffect to guard against concurrent-mode interrupted renders writing a stale ref.
  useLayoutEffect(() => { enqueueBackendEvalRef.current = enqueueBackendEval }, [enqueueBackendEval])
  const stableEnqueueBackendEval = useCallback(
    (req: BackendEvalRequest) => enqueueBackendEvalRef.current(req),
    [] // stable — never changes identity
  )

  // Set up async aggregate context on formulaService
  useEffect(() => {
    if (!formulaService || !currentDataset) return

    const setupContext = async () => {
      const storageInfo = await getStorageInfo(currentDataset.id)

      formulaService.setAsyncAggregateContext({
        isLargeDataset: storageInfo?.isLarge ?? false,
        isSorted: sortModel.length > 0,
        isGrouped: groupByColumnId !== null,
        isViewFiltered: viewFilterConfig !== null,
        scopedRowOrder: viewFilterConfig !== null
          ? rowOrderRef.current.filter((modelRow) => modelRow >= 0 && modelRow < resolveDataRowCount(currentDataset))
          : undefined,
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
    primarySortKey,
    groupByColumnId,
    enqueueAggregate,
    handleAsyncAggregateResult,
    getStorageInfo,
    isLazyGrouped,
    lazyGroupMeta.length,
    resolveDataRowCount,
    viewFilterConfig,
    rowOrder,
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
    const isViewFiltered = viewFilterConfig !== null

    formulaService.setBackendEvalContext({
      isLargeDataset: storageInfo.isLarge ?? true, // All-DuckDB: defaults to true
      isSorted: sortModel.length > 0,
      isGrouped: groupByColumnId !== null,
      isViewFiltered,
      totalRows: currentDataset.rowCount,
      loadedRowRange: range,
      columnLookup,
      // Lazy grouping resolves slices on demand. Filter-only scope needs the committed
      // row order so backend formulas evaluate the same rows the grid displays.
      rowOrder: (sortModel.length > 0 || groupByColumnId !== null || isViewFiltered) && !isLazyGroupingActive
        ? rowOrderRef.current
        : null,
      supportsRowOrderSlice: isLazyGroupingActive,
      datasetId: currentDataset.id,
      isRowLoaded: (viewRow: number) => {
        if (viewRow < 0) return false
        if (isLazyGroupingActive) {
          const modelRow = viewToModel(viewRow)
          if (modelRow < 0) return false
          return hasMaterializedRowData(modelRow)
        }
        const rowOrder = rowOrderRef.current
        const modelRow = rowOrder.length > 0 ? (rowOrder[viewRow] ?? viewRow) : viewRow
        return hasMaterializedRowData(modelRow)
      },
      enqueueBackendEval: stableEnqueueBackendEval,
    })
  }, [
    formulaService,
    currentDataset,
    primarySortKey,
    groupByColumnId,
    stableEnqueueBackendEval,
    rowOrder.length,
    viewFilterConfig,
    viewToModel,
    hasMaterializedRowData,
  ])

  // Register the backend eval callback once per formulaService instance.
  // Using stableHandleBackendEvalResult (stable identity, reads latest impl via ref)
  // means this effect never re-runs due to sort/group/dep re-renders — the callback
  // is never briefly cleared, so no IPC results are silently dropped.
  useEffect(() => {
    if (!formulaService) return
    formulaService.setBackendEvalCallback(stableHandleBackendEvalResult)
    return () => {
      formulaService.setBackendEvalCallback(undefined)
    }
  }, [formulaService, stableHandleBackendEvalResult])

  // Stable ref so the dataset-scope effect can call the latest updateBackendEvalContext
  // without putting it in the dep array. updateBackendEvalContext changes identity on every
  // sort/group re-render, so including it would cause dataset-scope cleanup to run — aborting
  // in-flight controllers — on unrelated sort/group churn.
  const updateBackendEvalContextRef = useRef(updateBackendEvalContext)
  useLayoutEffect(() => { updateBackendEvalContextRef.current = updateBackendEvalContext }, [updateBackendEvalContext])

  // Dataset-scope effect: fires ONLY when dataset identity or formulaService changes.
  // Sets up context once for this dataset and always aborts+clears pending requests on cleanup.
  // This is the only place that calls setBackendEvalContext(undefined) and aborts controllers,
  // making unmount/remount deterministic under StrictMode.
  useEffect(() => {
    if (!formulaService || !currentDataset) return

    const setupContext = async () => {
      const storageInfo = await getStorageInfo(currentDataset.id)
      if (!storageInfo) {
        console.warn('[SpreadsheetView] No storageInfo - backend context NOT set! Formulas will fail.')
        return
      }
      updateBackendEvalContextRef.current()
    }

    setupContext()

    return () => {
      formulaService.setBackendEvalContext(undefined)
      // Callback is managed by its own effect above — do not clear here.
      // Always abort pending requests on unmount/dataset change.
      for (const controller of pendingBackendEvalRequestsRef.current.values()) {
        controller.abort()
      }
      pendingBackendEvalRequestsRef.current.clear()
    }
  }, [formulaService, currentDataset?.id, getStorageInfo])

  // Refresh-scope effect: fires when sort/group configuration changes within the same dataset.
  // Only updates the context (loaded row range, row order, etc.) — never clears context or aborts.
  useEffect(() => {
    if (!formulaService || !currentDataset) return
    updateBackendEvalContext()
  }, [formulaService, currentDataset?.id, primarySortKey, groupByColumnId, updateBackendEvalContext])

  // Streaming Row Provider: Ensure rows in range are loaded
  // This function loads blocks on demand via hybrid cache (DuckDB for large datasets)
  // WHY: This is intentionally fire-and-forget from UI/render paths. Awaiting it
  // would let slow hybrid-cache reads block Glide rendering and visible-region updates.
  const ensureRangeLoaded = useCallback(
    async (startModel: number, endModel: number) => {
      if (!currentDataset) return

      // GUARD 1: Capture datasetId to detect dataset switch during fetch
      const capturedDatasetId = currentDataset.id
      const loadRevision = datasetRevisionRef.current
      const isStale = () =>
        datasetRevisionRef.current !== loadRevision || currentDatasetIdRef.current !== capturedDatasetId
      const storageInfo = await getStorageInfo(capturedDatasetId)
      if (isStale()) return
      // Re-read live dataset after async gap: the closure's currentDataset.rowCount /
      // dataRowCount may be stale if a paste expansion committed to the store while
      // getStorageInfo was in-flight. Fall back to closure values if dataset is gone.
      const liveDataset = useDataStore.getState().datasets.find((d) => d.id === capturedDatasetId)
      const rowCount = liveDataset?.rowCount ?? currentDataset.rowCount
      const isLargeDataset = storageInfo?.isLarge === true
      const dataRowCount = liveDataset ? resolveDataRowCount(liveDataset) : resolveDataRowCount(currentDataset)
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

        if (!shouldQueueGridBlockLoad(getBlockState(blockKey))) continue

        blocksToFetch.push(block)
        setBlockState(blockKey, 'reloading')
      }

      if (blocksToFetch.length === 0) return

      logPasteDebug('grid_range_load_queue', {
        datasetId: capturedDatasetId,
        requestedStart: startModel,
        requestedEnd: endModel,
        clampedStart: start,
        clampedEnd: end,
        dataRowCount,
        rowCount,
        effectiveRowCount,
        isLargeDataset,
        firstBlock,
        lastBlock,
        blocksToFetch,
        pendingBlockLoadCount: pendingBlockLoadsRef.current.size,
        rowDataSizeBefore: rowDataRef.current.size,
      })

      const rowsByIndex = new Map<number, Record<string, unknown>>()
      const completedHydrateBlockKeys = new Set<string>()
      let shouldDamageViewport = false

      // Fetch blocks in parallel (fire and forget - don't await in caller)
      await Promise.all(
        blocksToFetch.map(async (block) => {
          const blockKey = `${capturedDatasetId}:block:${block}`
          const blockStart = block * BLOCK_SIZE
          const blockEnd = Math.min(blockStart + BLOCK_SIZE, effectiveRowCount)

          try {
            const blockStartedAt = Date.now()
            logPasteDebug('grid_block_load_start', {
              datasetId: capturedDatasetId,
              block,
              blockKey,
              blockStart,
              blockEnd,
              previousBlockState: getBlockState(blockKey) ?? null,
              rowDataSizeBefore: rowDataRef.current.size,
            })
            const rows = await cacheService.getRowsHybrid(capturedDatasetId, blockStart, blockEnd)

            // GUARD 2: Verify dataset hasn't changed during fetch
            if (isStale()) {
              // Dataset switched - discard this data
              logPasteDebug('grid_block_load_discard_stale', {
                datasetId: capturedDatasetId,
                block,
                blockStart,
                blockEnd,
                returnedRows: rows.length,
                durationMs: Date.now() - blockStartedAt,
              })
              return
            }

            // If the viewport moved away while this block was loading, skip merging it.
            // This keeps memory bounded and avoids re-render churn during fast scrolls.
            if (!wantedBlocksRef.current.has(blockKey)) {
              logPasteDebug('grid_block_load_discard_unwanted', {
                datasetId: capturedDatasetId,
                block,
                blockStart,
                blockEnd,
                returnedRows: rows.length,
                durationMs: Date.now() - blockStartedAt,
              })
              setBlockState(
                blockKey,
                resolveGridBlockLoadState(getBlockState(blockKey), 'retry')
              )
              return
            }

            setBlockState(blockKey, resolveGridBlockLoadState(getBlockState(blockKey), 'loaded'))

            if (rows.length === 0) {
              const sentinelEnd = dataRowCount === 0 ? blockEnd : Math.min(blockEnd, dataRowCount)
              for (let rowIndex = blockStart; rowIndex < sentinelEnd; rowIndex++) {
                rowsByIndex.set(rowIndex, createRowDataSentinel())
              }
              logPasteDebug('grid_block_load_empty_sentinel', {
                datasetId: capturedDatasetId,
                block,
                blockStart,
                blockEnd,
                sentinelStart: blockStart,
                sentinelEnd,
                sentinelRows: Math.max(0, sentinelEnd - blockStart),
                durationMs: Date.now() - blockStartedAt,
              })
            } else {
              rows.forEach((row, i) => {
                rowsByIndex.set(blockStart + i, row)
              })
              logPasteDebug('grid_block_load_rows', {
                datasetId: capturedDatasetId,
                block,
                blockStart,
                blockEnd,
                returnedRows: rows.length,
                firstReturnedModelRow: blockStart,
                lastReturnedModelRow: blockStart + rows.length - 1,
                durationMs: Date.now() - blockStartedAt,
              })
            }
            completedHydrateBlockKeys.add(blockKey)
            shouldDamageViewport = true
          } catch (error) {
            console.error(`Failed to load block ${block} for dataset ${capturedDatasetId}:`, error)
            // Block can be retried on next scroll/render
            setBlockState(blockKey, resolveGridBlockLoadState(getBlockState(blockKey), 'retry'))
          } finally {
            if (getBlockState(blockKey) === 'reloading') {
              setBlockState(
                blockKey,
                resolveGridBlockLoadState(getBlockState(blockKey), 'retry')
              )
            }
          }
        })
      )

      if (isStale()) return
      completeCurrentPasteHydrateBlocks(capturedDatasetId, completedHydrateBlockKeys)
      if (rowsByIndex.size === 0) return
      if (isStale()) return

      // OPTIMIZATION: Track which model rows were loaded for targeted damage
      const loadedModelRows = new Set(rowsByIndex.keys())

      updateRowDataRef((prev) => {
        const next = new Map(prev)
        rowsByIndex.forEach((row, index) => {
          next.set(index, row)
        })
        logWatchedCutMapWrite(
          'cut_watch_range_load_merge',
          'ensureRangeLoaded',
          capturedDatasetId,
          prev,
          next,
          loadRevision
        )
        return next
      })
      logPasteDebug('grid_range_load_merge', {
        datasetId: capturedDatasetId,
        mergedRows: rowsByIndex.size,
        loadedModelRowSample: sampleNumbers(loadedModelRows),
        rowDataSizeAfter: rowDataRef.current.size,
        shouldDamageViewport,
      })
      clearConvergedOverlayRows(capturedDatasetId, loadedModelRows)

      if (shouldDamageViewport) {
        // Trigger a repaint of only the loaded rows to reduce main-thread work
        scheduleViewportDamageRef.current(loadedModelRows)
      }
    },
    [
      currentDataset,
      BLOCK_SIZE,
      getBlockState,
      getStorageInfo,
      logPasteDebug,
      logWatchedCutMapWrite,
      completeCurrentPasteHydrateBlocks,
      resolveDataRowCount,
      setBlockState,
      updateRowDataRef,
    ]
  )

  useEffect(() => {
    const bundle = pendingActivationBundleRef.current
    if (!bundle || !currentDataset || bundle.datasetId !== currentDataset.id) {
      return
    }

    if (bundle.targetModelRows !== null) {
      return
    }

    const capturedDatasetId = currentDataset.id
    const capturedToken = bundle.token
    let cancelled = false

    void resolveActivationBundleTargetRows(bundle, currentDataset)
      .then((resolved) => {
        if (cancelled) return
        const currentBundle = pendingActivationBundleRef.current
        if (!currentBundle) return
        if (currentBundle.datasetId !== capturedDatasetId || currentBundle.token !== capturedToken) {
          return
        }
        currentBundle.rowOrder = resolved.rowOrder
        currentBundle.targetModelRows = resolved.targetModelRows
        pendingActivationPrefetchKeyRef.current = null
        bumpDatasetActivationReloadVersion()
      })
      .catch((error) => {
        if (cancelled) return
        console.error(
          `Failed to resolve activation bundle target rows for dataset ${capturedDatasetId}:`,
          error
        )
      })

    return () => {
      cancelled = true
    }
  }, [currentDataset, pendingActivationDatasetId, resolveActivationBundleTargetRows])

  useEffect(() => {
    const bundle = pendingActivationBundleRef.current
    if (!bundle || !currentDataset || bundle.datasetId !== currentDataset.id) {
      return
    }

    if (bundle.targetModelRows === null) {
      return
    }

    const targetModelRows = bundle.targetModelRows
    if (targetModelRows.length === 0) {
      return
    }

    const spans = buildRowFetchSpans(targetModelRows)
    const prefetchKey = `${bundle.datasetId}:${bundle.token}:${spans
      .map((span) => `${span.start}-${span.end}`)
      .join('|')}`
    if (pendingActivationPrefetchKeyRef.current === prefetchKey) {
      return
    }
    pendingActivationPrefetchKeyRef.current = prefetchKey

    const capturedDatasetId = currentDataset.id
    const capturedToken = bundle.token

    void Promise
      .all(
        spans.map(async (span) => ({
          span,
          rows: await cacheService.getRowsHybrid(capturedDatasetId, span.start, span.end),
        }))
      )
      .then((results) => {
        const currentBundle = pendingActivationBundleRef.current
        if (!currentBundle) return
        if (currentBundle.datasetId !== capturedDatasetId || currentBundle.token !== capturedToken) {
          return
        }
        if (currentDatasetIdRef.current !== capturedDatasetId) {
          return
        }

        const loadedModelRows = new Set<number>()
        updateRowDataRef((prev) => {
          const next = new Map(prev)
          results.forEach(({ span, rows }) => {
            if (rows.length === 0) {
              for (let modelRow = span.start; modelRow < span.end; modelRow += 1) {
                if (!targetModelRows.includes(modelRow)) continue
                next.set(modelRow, createRowDataSentinel())
                loadedModelRows.add(modelRow)
              }
              return
            }
            rows.forEach((row, index) => {
              const modelRow = span.start + index
              if (!targetModelRows.includes(modelRow)) return
              next.set(modelRow, row)
              loadedModelRows.add(modelRow)
            })
          })
          return next
        })

        if (loadedModelRows.size > 0) {
          clearConvergedOverlayRows(capturedDatasetId, loadedModelRows)
          scheduleViewportDamageRef.current(loadedModelRows)
        }
      })
      .catch((error) => {
        if (pendingActivationPrefetchKeyRef.current === prefetchKey) {
          pendingActivationPrefetchKeyRef.current = null
        }
        console.error(
          `Failed to preload activation bundle rows for dataset ${capturedDatasetId}:`,
          error
        )
      })
  }, [currentDataset, pendingActivationDatasetId, datasetActivationReloadVersion, updateRowDataRef])

  const loadBlocks = useCallback(
    async (blocksToFetch: number[], capturedDatasetId: string) => {
      if (!currentDataset || blocksToFetch.length === 0) return
      if (currentDataset.id !== capturedDatasetId) return

      const loadRevision = datasetRevisionRef.current
      const isStale = () =>
        datasetRevisionRef.current !== loadRevision || currentDatasetIdRef.current !== capturedDatasetId

      const storageInfo = await getStorageInfo(capturedDatasetId)
      if (isStale()) return
      // Re-read live dataset after async gap — same pattern as ensureRangeLoaded.
      const liveDatasetForBlocks = useDataStore.getState().datasets.find((d) => d.id === capturedDatasetId)
      const isLargeDataset = storageInfo?.isLarge === true
      const dataRowCount = liveDatasetForBlocks ? resolveDataRowCount(liveDatasetForBlocks) : resolveDataRowCount(currentDataset)
      const effectiveRowCount = isLargeDataset ? dataRowCount : (liveDatasetForBlocks?.rowCount ?? currentDataset.rowCount)

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
              setBlockState(
                blockKey,
                resolveGridBlockLoadState(getBlockState(blockKey), 'retry')
              )
              return
            }

            setBlockState(blockKey, resolveGridBlockLoadState(getBlockState(blockKey), 'loaded'))

            if (rows.length === 0) {
              const sentinelEnd = dataRowCount === 0 ? blockEnd : Math.min(blockEnd, dataRowCount)
              for (let rowIndex = blockStart; rowIndex < sentinelEnd; rowIndex++) {
                rowsByIndex.set(rowIndex, createRowDataSentinel())
              }
            } else {
              rows.forEach((row, i) => {
                rowsByIndex.set(blockStart + i, row)
              })
            }
            shouldDamageViewport = true
          } catch (error) {
            console.error(`Failed to load block ${block} for dataset ${capturedDatasetId}:`, error)
            setBlockState(blockKey, resolveGridBlockLoadState(getBlockState(blockKey), 'retry'))
          } finally {
            if (getBlockState(blockKey) === 'reloading') {
              setBlockState(
                blockKey,
                resolveGridBlockLoadState(getBlockState(blockKey), 'retry')
              )
            }
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
        logWatchedCutMapWrite(
          'cut_watch_block_load_merge',
          'loadBlocks',
          capturedDatasetId,
          prev,
          next,
          loadRevision
        )
        return next
      })
      clearConvergedOverlayRows(capturedDatasetId, loadedModelRows)

      if (shouldDamageViewport) {
        scheduleViewportDamageRef.current(loadedModelRows)
      }
    },
    [
      currentDataset,
      BLOCK_SIZE,
      getBlockState,
      getStorageInfo,
      logWatchedCutMapWrite,
      resolveDataRowCount,
      setBlockState,
      updateRowDataRef,
    ]
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
        if (!shouldQueueGridBlockLoad(getBlockState(cacheKey))) continue

        setBlockState(cacheKey, 'reloading')

        try {
          const rowIndices = await cacheService.getGroupRows(
            capturedDatasetId,
            groupByColumnId,
            group.key,
            sortModelRef.current[0]?.colId ?? null,
            sortModelRef.current[0]?.dir === 'desc',
            groupVisibleStart,
            groupVisibleEnd - groupVisibleStart
          )

          if (isStale()) return

          if (rowIndices.length === 0) {
            setBlockState(cacheKey, resolveGridBlockLoadState(getBlockState(cacheKey), 'loaded'))
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
            logWatchedCutMapWrite(
              'cut_watch_lazy_group_merge',
              'lazyGroup',
              capturedDatasetId,
              prev,
              next,
              loadRevision
            )
            return next
          })

          setBlockState(cacheKey, resolveGridBlockLoadState(getBlockState(cacheKey), 'loaded'))
          requestGridRefresh({ reason: 'lazy-group-load-repaint', scope: 'viewport' })
        } catch (error) {
          console.error(`Failed to load lazy group ${group.key}:`, error)
          setBlockState(cacheKey, resolveGridBlockLoadState(getBlockState(cacheKey), 'retry'))
        } finally {
          if (getBlockState(cacheKey) === 'reloading') {
            setBlockState(
              cacheKey,
              resolveGridBlockLoadState(getBlockState(cacheKey), 'retry')
            )
          }
        }
      }
    },
    [
      currentDataset,
      isLazyGrouped,
      lazyGroupMeta,
      collapsedGroups,
      groupByColumnId,
      logWatchedCutMapWrite,
      primarySortKey,
      getBlockState,
      setBlockState,
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

          if (sortModel.length === 0 && groupByColumnId === null) {
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
                setBlockState(key, resolveGridBlockLoadState(getBlockState(key), 'evict'))
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
              setBlockState(key, resolveGridBlockLoadState(getBlockState(key), 'evict'))
            }
          }

          const blocksToFetch: number[] = []
          for (const block of blockIndices) {
            const blockKey = `${datasetId}:block:${block}`
            if (!shouldQueueGridBlockLoad(getBlockState(blockKey))) continue
            setBlockState(blockKey, 'reloading')
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
      primarySortKey,
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

  // If a dataset was pasted while inactive, force a fresh block reload when it becomes active.
  useEffect(() => {
    const datasetId = currentDataset?.id
    if (!datasetId) return
    const model = sharedOverlayModelByDataset.get(datasetId)
    const meta = sharedOverlayMetaByDataset.get(datasetId)
    const stagedRows = collectStagedOverlayRows(model, datasetId)
    const hasDeferredReload = datasetsNeedingReloadOnActivateRef.current.has(datasetId)
    const hasStagedRows = Boolean(stagedRows && stagedRows.size > 0 && meta?.activationPending)
    if (!hasDeferredReload && !hasStagedRows) return

    if (hasDeferredReload) {
      datasetsNeedingReloadOnActivateRef.current.delete(datasetId)
    }
    datasetRevisionRef.current += 1
    clearBlockStateTracking()
    wantedBlocksRef.current = new Set()
    pendingBlockLoadsRef.current = new Set()
    rowDataRef.current = new Map()
    lastRangeRef.current = null
    lastViewportRef.current = null
    if (stagedRows && stagedRows.size > 0) {
      updateRowDataRef((prev) => {
        const next = new Map(prev)
        for (const [rowIndex, rowPatch] of stagedRows.entries()) {
          const mergedRow = cloneRowDataPreservingSentinel(next.get(rowIndex))
          Object.assign(mergedRow, rowPatch)
          next.set(rowIndex, mergedRow)
          model?.writeBaseRow(buildDatasetScopedRowId(datasetId, rowIndex), mergedRow)
        }
        return next
      })
      if (meta) {
        if (model) {
          const clearedMutationIds = new Set<string>()
          for (const [rowId, overlayRow] of model.listOverlayRows().entries()) {
            const parsed = parseGridRowId(rowId)
            if (parsed.datasetId !== datasetId) continue
            let shouldClearRow = false
            for (const [columnId, cell] of Object.entries(overlayRow)) {
              if (cell.status !== 'persisted' && cell.status !== 'confirmed') continue
              shouldClearRow = true
              clearedMutationIds.add(cell.mutationId)
              model.acknowledgeOverlay(rowId, {
                columnId,
                mutationId: cell.mutationId,
                revision: cell.revision,
                status: 'confirmed',
                value: cell.value,
              })
            }
            if (shouldClearRow) {
              model.clearConfirmedOverlay(rowId)
            }
          }
          for (const clearedMutationId of clearedMutationIds) {
            meta.mutations.delete(clearedMutationId)
          }
          if (!model.hasOverlayRows()) {
            clearDatasetOverlayState(datasetId)
          } else {
            sharedOverlayMetaByDataset.set(datasetId, {
              ...meta,
              activationPending: false,
              persistedMutationIds: [],
            })
          }
        } else {
          sharedOverlayMetaByDataset.set(datasetId, {
            ...meta,
            activationPending: false,
            persistedMutationIds: [],
          })
        }
      }
    }

    logPasteDebug('post_paste_activate_reload', {
      datasetId,
      hasDeferredReload,
      hasStagedRows,
    })
    requestGridRefresh({ reason: 'post-paste-activate-reload', scope: 'viewport' })

    const range = visibleRegionRef.current
    const debouncedFn = debouncedVisibleRegionWorkRef.current
    debouncedFn.cancel()
    debouncedFn(range)
    debouncedFn.flush()
  }, [
    clearBlockStateTracking,
    currentDataset?.id,
    datasetActivationReloadVersion,
    logPasteDebug,
    requestGridRefresh,
    updateRowDataRef,
  ])

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
      setRowData: (updater) =>
        updateRowDataRef((prev) => {
          const next = updater(prev)
          logWatchedCutMapWrite(
            'cut_watch_rowdata_write',
            'editExecutor',
            currentDataset.id,
            prev,
            next
          )
          return next
        }),
      updateCellValue,
      updateCellsBatch: (datasetId, updates) => {
        updateCellsBatch(
          datasetId,
          updates.map((update) => ({
            rowIdx: update.row,
            columnId: update.columnId,
            value: update.value,
          }))
        )
      },
      invalidateColumns,
      updateActiveFamilyData: trackActiveFamilyData
        ? useAppStore.getState().updateActiveFamilyData
        : undefined,
      getActiveFamilyId: trackActiveFamilyData
        ? () => useAppStore.getState().activeFamilyId
        : undefined,
      formulaService: formulaService ?? undefined,
      columns: currentDataset.columns,
      // Dynamic column lookup: called at edit-execution time so overflow columns
      // added just before executeEdits runs (e.g. paste with col expansion) are
      // visible for formula position resolution — fixes stale snapshot issue.
      getColumns: () => {
        const ds = useDataStore.getState().datasets.find((d) => d.id === currentDataset.id)
        return ds?.columns ?? currentDataset.columns
      },
      // Part 2: Paste Recognition - bump dataRowCount when editing beyond current row count
      bumpDataRowCount: (maxRowIndex) => {
        const current = useDataStore.getState().datasets.find((d) => d.id === currentDataset.id)
        const newCount = computeDataRowCountPromotion(maxRowIndex, current?.dataRowCount ?? 0)
        if (newCount !== null) {
          useDataStore.getState().updateDataset(currentDataset.id, {
            dataRowCount: newCount,
            modifiedAt: new Date(),
          })
        }
      },
      // Part 1: Smart Save - mark project dirty after any edit
      markProjectDirty: () => {
        useAppStore.getState().setProjectDirty(true)
      },
    })
  }, [currentDataset, updateCellValue, updateCellsBatch, invalidateColumns, formulaService, logWatchedCutMapWrite])

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
    invalidateSelectAllStats(currentDataset.id)
  }, [currentDataset, formulaService, invalidateSelectAllStats])

  const getLocalRowRecord = useCallback((datasetId: string, rowIndex: number) => {
    const rowId = buildDatasetScopedRowId(datasetId, rowIndex)
    const model = sharedOverlayModelByDataset.get(datasetId)
    if (model?.getOverlayRow(rowId)) {
      const modelRow = model.readMergedRow(rowId)
      if (modelRow) return modelRow
    }
    return rowDataRef.current.get(rowIndex) ?? null
  }, [])

  const getCellRawValueForUndo = useCallback(
    (rowIndex: number, columnId: string): unknown => {
      const cellKey = `${rowIndex}:${columnId}`
      const rawFormula = formulaService?.getFormula(cellKey)
      if (rawFormula !== undefined) {
        return rawFormula
      }

      if (!currentDataset) return null
      const row = getLocalRowRecord(currentDataset.id, rowIndex)
      return row?.[columnId] ?? null
    },
    [currentDataset, formulaService, getLocalRowRecord]
  )

  // Promote buffer rows to data rows when edited
  // Called when user edits a cell in the buffer zone (row >= dataRowCount)
  const bumpDataRowCount = useCallback(
    (maxEditedRowIndex: number) => {
      if (!currentDataset) return
      const newCount = computeDataRowCountPromotion(maxEditedRowIndex, currentDataset.dataRowCount ?? 0)
      if (newCount !== null) {
        updateDataset(currentDataset.id, { dataRowCount: newCount })
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
    clearBlockStateTracking()
    wantedBlocksRef.current.clear()
    pendingBlockLoadsRef.current.clear()
    lazyRowCacheRef.current.clear()
    lastRangeRef.current = null
  }, [clearBlockStateTracking])

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
        const columnInsertStartedAt = Date.now()
        logGridDebug('column_insert_start', {
          datasetId: currentDataset.id,
          insertAt,
          columnCount: currentDataset.columns.length,
        })
        await cacheService.addColumn(currentDataset.id, newColumnId, '')
        backendApplied = true
        insertColumnAtDataset(currentDataset.id, insertAt, newColumn)
        markLocalSchemaMutation(currentDataset.id)
        frontendApplied = true

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
        requestGridRefresh({ reason: 'column-insert', scope: 'viewport' })
        useAppStore.getState().setProjectDirty(true)
        logGridDebug('column_insert_done', {
          datasetId: currentDataset.id,
          insertAt,
          durationMs: Date.now() - columnInsertStartedAt,
        })
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
            markLocalSchemaMutation(currentDataset.id)

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
      markLocalSchemaMutation,
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
      const activeSortModel = sortModelRef.current
      const previousBaseSortedOrder = [...baseSortedOrderRef.current]

      let backendApplied = false
      let frontendApplied = false
      let formulaShiftApplied = false

      try {
        const isAppendPath = insertedFromBufferRegion
        const insertStartedAt = Date.now()
        logGridDebug('row_insert_start', {
          datasetId: currentDataset.id,
          insertAt: effectiveInsertModelRow,
          dataRowCount,
          rowCount: currentDataset.rowCount,
          method: isAppendPath ? 'append' : 'shift',
        })

        if (isAppendPath) {
          await cacheService.appendRows(currentDataset.id, 1)
        } else {
          await cacheService.insertRowAt(currentDataset.id, effectiveInsertModelRow)
        }
        backendApplied = true
        insertRowAtDataset(currentDataset.id, effectiveInsertModelRow)
        frontendApplied = true

        if (formulaService) {
          const formulaEdits = formulaService.shiftReferencesForRowInsert(effectiveInsertModelRow)
          applyFormulaEdits(formulaEdits)
          formulaShiftApplied = true
          syncFormulasToStore()
        }

        updateRowDataRef(prev => {
          if (isAppendPath) {
            const next = new Map(prev)
            next.set(effectiveInsertModelRow, {})
            return next
          }
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
        const filteredShifted = applyActiveFilter(shiftedOrder)
        rowOrderRef.current = filteredShifted
        setRowOrder(filteredShifted)

        if (activeSortModel.length > 0) {
          setPendingInsertSortReplay({
            datasetId: currentDataset.id,
            sortModel: activeSortModel,
            expectedRowCount: currentDataset.rowCount + 1,
          })
        }

        if (!isAppendPath) {
          const firstAffectedBlock = Math.floor(effectiveInsertModelRow / BLOCK_SIZE)
          const prefix = `${currentDataset.id}:block:`
          for (const key of Array.from(blockStatesRef.current.keys())) {
            if (!key.startsWith(prefix)) continue
            const blockIndex = Number(key.slice(prefix.length))
            if (Number.isFinite(blockIndex) && blockIndex >= firstAffectedBlock) {
              setBlockState(key, 'dirty')
            }
          }
          lastRangeRef.current = null
          const debouncedFn = debouncedVisibleRegionWorkRef.current
          debouncedFn.cancel()
          debouncedFn(visibleRegionRef.current)
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
        requestGridRefresh({ reason: 'row-insert', scope: 'viewport' })
        useAppStore.getState().setProjectDirty(true)
        toast.success('Inserted row successfully')
        logGridDebug('row_insert_done', {
          datasetId: currentDataset.id,
          insertAt: effectiveInsertModelRow,
          method: isAppendPath ? 'append' : 'shift',
          durationMs: Date.now() - insertStartedAt,
          rowOrderLength: filteredShifted.length,
        })
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
            const filteredPrevious = applyActiveFilter(previousBaseSortedOrder)
            rowOrderRef.current = filteredPrevious
            setRowOrder(filteredPrevious)
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
      BLOCK_SIZE,
      resolveDataRowCount,
      viewToModel,
      insertRowAtDataset,
      formulaService,
      applyFormulaEdits,
      syncFormulasToStore,
      invalidateColumns,
      updateRowDataRef,
      setBlockState,
      requestScrollRestore,
      requestGridRefresh,
      removeRowAtDataset,
      applyActiveFilter,
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
        const sortColumnId = sortModelRef.current[0]?.colId ?? null

        try {
          // Use lazy group metadata - O(groups) not O(rows)
          // For 18M rows with 100 groups: returns 100 entries, not 18M
          const lazyResult = await cacheService.getLazyGroupMetadata(
            capturedDatasetId,
            groupColumnId,
            sortColumnId,
            sortModelRef.current[0]?.dir === 'desc'
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
    [currentDataset, getStorageInfo, resolveDataRowCount]
  )

  // Sort functions (Phase 3 - Sorting)
  // CRITICAL: Fetch complete column from backend to avoid sparse rowData issues
  // where unloaded rows appear as "missing" and sort incorrectly
  const performSort = useCallback(
    async (
      keys: SortKey[],
      options: { skipConfirm?: boolean } = {}
    ) => {
      if (!currentDataset || keys.length === 0) return
      const capturedDatasetId = currentDataset.id
      // Phase 2: single-key only. Phase 3 will add multi-key composition.
      const primaryKey = keys[0]!
      const columnId = primaryKey.colId
      const direction = primaryKey.dir

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
        rebuildGrouping(applyActiveFilter(sortedOrder), groupByColumnId, collapsedGroups)
        setSortModel(keys)
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
      const comparator = makeExcelComparator(columnType)
      const sortedDataIndices = [...dataRowIndices].sort((modelRowA, modelRowB) => {
        const cmp = comparator(columnValues[modelRowA], columnValues[modelRowB])
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
        return (baseIndex.get(modelRowA) ?? 0) - (baseIndex.get(modelRowB) ?? 0)
      })

      // Final order: sorted data rows + unsorted buffer rows
      const sortedOrder = [...sortedDataIndices, ...bufferRowIndices]

      // Store base sorted order and apply grouping
      baseSortedOrderRef.current = sortedOrder
      rebuildGrouping(applyActiveFilter(sortedOrder), groupByColumnId, collapsedGroups)
      setSortModel(keys)

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

  // Row-count growth sync
  // When paste (or any operation) expands currentDataset.rowCount AFTER the schema-init
  // effect has already run (schema key unchanged), baseSortedOrderRef stays at the old
  // length and rowOrder.length wins in the rowCount useMemo → Glide never allocates the
  // new rows. This effect appends the missing model indices without disturbing sort/group,
  // and marks a pending repaint that fires once rowOrder has committed (see post-commit
  // repaint effect below).
  //
  // Shrink: the guard `newLen <= curLen` keeps this effect out of the shrink path.
  // All shrink paths (row delete, dataset reload, clearSort) rebuild baseSortedOrderRef
  // from scratch via the schema-init effect or their own explicit setRowOrder calls.
  // If a new code path ever shrinks rowCount without going through those handlers, the
  // high model indices would persist in baseSortedOrderRef until the next schema reset.
  // Dev assertion below catches that case.
  useEffect(() => {
    if (!currentDataset) return
    const newLen = currentDataset.rowCount
    const curLen = baseSortedOrderRef.current.length

    if (newLen < curLen) {
      const resetOrder = Array.from({ length: newLen }, (_, i) => i)
      baseSortedOrderRef.current = resetOrder
      void rebuildGrouping(
        applyActiveFilter(resetOrder),
        groupByColumnIdRef.current,
        collapsedGroupsRef.current
      )
      pendingGrowthRepaintRef.current = true
      logGridDebug('row_count_order_shrink_repaired', {
        datasetId: currentDataset.id,
        rowCount: newLen,
        previousOrderLength: curLen,
      })
      return
    }
    if (newLen === curLen) return // no growth — nothing to do

    const appended = Array.from({ length: newLen - curLen }, (_, i) => curLen + i)
    baseSortedOrderRef.current = [...baseSortedOrderRef.current, ...appended]
    // applyActiveFilter wraps the base order — same contract as every other rebuildGrouping
    // call site. Note: applyViewFilter's fail-safe keeps rows absent from fullRowsByIndex
    // visible until the filter snapshot refreshes, so newly appended rows may flicker
    // briefly before being hidden if a filter is active. This is a UX timing trade-off,
    // not data loss.
    void rebuildGrouping(applyActiveFilter(baseSortedOrderRef.current), groupByColumnIdRef.current, collapsedGroupsRef.current)
    // Mark repaint pending; the post-commit effect below fires it once rowOrder.length
    // reflects the new count (i.e. after React has flushed the setRowOrder call inside
    // rebuildGrouping). Firing it here directly would use scheduleViewportDamage's stale
    // closure over the old rowCount.
    pendingGrowthRepaintRef.current = true
  }, [currentDataset?.id, currentDataset?.rowCount, rebuildGrouping, applyActiveFilter, logGridDebug])

  // Post-commit repaint: fires once rowOrder has grown to match the new rowCount.
  // scheduleViewportDamageRef.current is updated on every render, so it sees the
  // correct new rowCount by the time this effect runs.
  useEffect(() => {
    if (!pendingGrowthRepaintRef.current) return
    if (rowOrder.length < (currentDataset?.rowCount ?? 0)) return // still catching up
    pendingGrowthRepaintRef.current = false
    scheduleViewportDamageRef.current()
  }, [rowOrder.length, currentDataset?.rowCount])

  useEffect(() => {
    if (!pendingInsertSortReplay || !currentDataset) return
    if (pendingInsertSortReplay.datasetId !== currentDataset.id) {
      setPendingInsertSortReplay(null)
      return
    }
    if (currentDataset.rowCount < pendingInsertSortReplay.expectedRowCount) {
      return
    }

    const { sortModel: replaySortModel } = pendingInsertSortReplay
    setPendingInsertSortReplay(null)
    void performSort(replaySortModel, { skipConfirm: true })
  }, [pendingInsertSortReplay, currentDataset, performSort])

  const clearSort = useCallback(() => {
    // Reset to default identity order [0, 1, 2, ..., rowCount-1]
    // This naturally keeps data rows (0..dataRowCount-1) before buffer rows
    if (!currentDataset) return
    const defaultOrder = Array.from({ length: currentDataset.rowCount }, (_, i) => i)
    baseSortedOrderRef.current = defaultOrder
    rebuildGrouping(applyActiveFilter(defaultOrder), groupByColumnId, collapsedGroups)
    setSortModel([])

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
    void performSort(pending.sortModel, { skipConfirm: pending.skipConfirm === true })
  }, [currentDataset?.id, groupByColumnId, collapsedGroups, performSort])

  // Effect to rebuild grouping when collapsedGroups or groupByColumnId changes
  // IMPORTANT: Use debouncedVisibleRegionWorkRef to avoid infinite loop caused by
  // debouncedVisibleRegionWork depending on lazy grouping state which is set by rebuildGrouping
  useEffect(() => {
    if (baseSortedOrderRef.current.length > 0) {
      rebuildGrouping(applyActiveFilter(baseSortedOrderRef.current), groupByColumnId, collapsedGroups)

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

    // Coerce value through column type semantics (all types: numeric, categorical, text, datetime).
    const newValue: unknown = coerceEditValue(
      newValueText,
      column?.type,
      (s) => formulaService?.isFormula(s) ?? false
    )

    if (newValue === oldValue) return true

    const edit: CellEdit = {
      row: modelRow,
      columnId,
      oldValue,
      newValue,
    }
    const transaction: GridTransactionRecord = {
      id: nextGridOperationId('type'),
      datasetId: currentDataset.id,
      kind: 'type',
      edits: [edit],
    }
    const gridMutationCoordinator = gridMutationCoordinatorRef.current
    if (!gridMutationCoordinator) {
      return false
    }

    await gridMutationCoordinator
      .applyGridMutation({
        id: transaction.id,
        datasetId: transaction.datasetId,
        kind: transaction.kind,
        transaction,
      })
      .finally(() => {
        invalidateSelectAllStats(currentDataset.id)
      })

    const colIndex = currentDataset.columns.findIndex((column) => column.id === columnId)
    if (colIndex >= 0) {
      requestAnimationFrame(() => {
        scheduleCellUpdates([{ cell: [colIndex, viewRow] as const }])
      })
    }

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
    viewToModel,
    bumpDataRowCount,
    ensureLazyGroupedRangeLoaded,
    groupByColumnId,
    invalidateSelectAllStats,
    nextGridOperationId,
    scheduleCellUpdates,
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

  // Convert dataset columns to Glide Data Grid format
  // Note: currentDataset is initialized on mount, but can be null during project loads.
  // Appends a virtual "+" column for adding new columns (Plan Part 2)
  const columns: GridColumn[] = useMemo(() => {
    if (!currentDataset) {
      return [] // Placeholder while project loads
    }

    // Compute titles once — O(n) — then index by id for O(1) lookup per column
    const derivedTitles = deriveColumnTitles(currentDataset.columns, sortModel, viewFilterConfig)
    const titleById = new Map(derivedTitles.map(t => [t.id, t.title]))

    // Map all dataset columns (all have ColumnMetadata with width persistence)
    const dataColumns = currentDataset.columns.map((col: ColumnMetadata) => {
      const rawWidth = typeof col.width === 'number' ? col.width : Number.NaN
      const width = Number.isFinite(rawWidth) && rawWidth >= 50 ? rawWidth : 88
      return {
        id: col.id,
        title: titleById.get(col.id) ?? col.name,
        width,
        ...(enableExcelViewFilter ? { menuIcon: GridColumnMenuIcon.Dots } : {}),
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
  }, [currentDataset?.id, currentDataset?.columns, primarySortKey, sortModel, viewFilterConfig, enableExcelViewFilter])
  const visibleGridRowCount = useMemo(() => {
    if (isLazyGrouped && lazyGroupMeta.length > 0) {
      return lazyGroupMeta.reduce((total, group) => {
        const isCollapsed = collapsedGroups.has(group.key)
        return total + (isCollapsed ? 1 : group.size)
      }, 0)
    }
    return rowOrder.length > 0 ? rowOrder.length : currentDataset?.rowCount ?? 100
  }, [isLazyGrouped, lazyGroupMeta, collapsedGroups, rowOrder.length, currentDataset?.rowCount])
  const hasRenderableDataset = !!currentDataset && currentDataset.columns.length > 0
  const isDatasetActivationTransition =
    !!currentDataset &&
    previousDatasetIdRef.current !== currentDataset.id &&
    lastRenderableGridKeyRef.current !== 'placeholder'
  const shouldHoldCommittedSurface =
    !!currentDataset &&
    (pendingActivationDatasetId === currentDataset.id || isDatasetActivationTransition)
  useEffect(() => {
    if (!hasRenderableDataset || shouldHoldCommittedSurface) return
    lastRenderableGridKeyRef.current = currentDataset.id
    lastRenderableColumnsRef.current = columns
    lastRenderableRowCountRef.current = Math.max(visibleGridRowCount, 1)
  }, [columns, currentDataset?.id, hasRenderableDataset, shouldHoldCommittedSurface, visibleGridRowCount])
  const committedGridSurface = useMemo(
    () => ({
      gridKey:
        hasRenderableDataset && !shouldHoldCommittedSurface
          ? currentDataset.id
          : lastRenderableGridKeyRef.current,
      columns:
        hasRenderableDataset && !shouldHoldCommittedSurface
          ? columns
          : lastRenderableColumnsRef.current,
      rowCount: hasRenderableDataset && !shouldHoldCommittedSurface
        ? Math.max(visibleGridRowCount, 1)
        : lastRenderableRowCountRef.current,
    }),
    [
      columns,
      currentDataset?.id,
      hasRenderableDataset,
      shouldHoldCommittedSurface,
      visibleGridRowCount,
    ]
  )
  const gridRenderState: 'ready' | 'staging' | 'loading' | 'empty' = shouldHoldCommittedSurface
    ? 'staging'
    : hasRenderableDataset
    ? 'ready'
    : loadingOperation
      ? 'loading'
      : pendingDatasetId
        ? 'staging'
        : 'empty'
  const gridOverlayMessage =
    gridRenderState === 'loading'
      ? 'Loading project...'
      : gridRenderState === 'staging'
      ? 'Preparing grid...'
        : 'No dataset loaded'
  const hasNonPlaceholderCommittedSurface = committedGridSurface.gridKey !== 'placeholder'
  const shouldShowBlockingGridOverlay =
    gridRenderState !== 'ready' &&
    !(gridRenderState === 'staging' && hasNonPlaceholderCommittedSurface)
  const isSchemaChangeSurfaceStaging =
    !!currentDataset &&
    shouldHoldCommittedSurface &&
    committedGridSurface.gridKey !== currentDataset.id
  const displayedColumnRowKeyFallbacks = useMemo(
    () => buildColumnFallbackCandidates(committedGridSurface.columns),
    [committedGridSurface.columns]
  )

  // WHY: During schema swaps the committed grid surface may still show the old
  // column model. Mutating in that window can target stale column ids or row keys.
  const blockSchemaChangeStagingMutation = useCallback((action: string): boolean => {
    if (!isSchemaChangeSurfaceStaging) {
      return false
    }
    toast.info(`Grid is still preparing the new schema. ${action} will be available in a moment.`)
    return true
  }, [isSchemaChangeSurfaceStaging])
  const getColumnFallbackCandidates = useCallback((columnId: string): string[] | undefined => {
    const displayed = displayedColumnRowKeyFallbacks.get(columnId) ?? []
    const live = liveColumnRowKeyFallbacks.get(columnId) ?? []
    const merged = Array.from(new Set([...displayed, ...live]))
    return merged.length > 0 ? merged : undefined
  }, [displayedColumnRowKeyFallbacks, liveColumnRowKeyFallbacks])

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
      // WHY: Glide Data Grid can flicker when updateCells() receives duplicate
      // [col,row] pairs from formula fan-out or batch edits; dedupe before damage.
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

  const getBackendPasteBlockKeys = useCallback(
    (datasetId: string, rows: number[]) => {
      const blockIndexes = Array.from(
        new Set(rows.map((row) => Math.floor(row / BLOCK_SIZE)))
      ).sort((a, b) => a - b)
      return {
        blockIndexes,
        blockKeys: blockIndexes.map((block) => `${datasetId}:block:${block}`),
      }
    },
    [BLOCK_SIZE]
  )

  const patchMaterializedRowsForBackendPaste = useCallback(
    (rows: number[], columnIds: string[], values: unknown[][]) => {
      const updates: Array<{ cell: readonly [number, number] }> = []
      const seenCells = new Set<string>()

      updateRowDataRef((prev) => {
        let changed = false
        const next = new Map(prev)

        rows.forEach((modelRow, rowIndex) => {
          const currentRow = next.get(modelRow)
          if (!currentRow || isRowDataSentinel(currentRow)) return

          let nextRow: Record<string, unknown> | null = null
          columnIds.forEach((columnId, columnIndex) => {
            const nextValue = values[rowIndex]?.[columnIndex] ?? null
            if (currentRow[columnId] === nextValue) return

            if (!nextRow) {
              nextRow = { ...currentRow }
            }
            nextRow[columnId] = nextValue

            const colIndex = columnIndexById.get(columnId)
            if (colIndex === undefined) return
            const viewRow = modelToView(modelRow)
            const cellKey = `${colIndex}:${viewRow}`
            if (seenCells.has(cellKey)) return
            seenCells.add(cellKey)
            updates.push({ cell: [colIndex, viewRow] as const })
          })

          if (nextRow) {
            next.set(modelRow, nextRow)
            changed = true
          }
        })

        return changed ? next : prev
      })

      return updates
    },
    [columnIndexById, modelToView, updateRowDataRef]
  )

  const showBackendPasteHighlights = useCallback((rows: number[], columnIds: string[]) => {
    if (rows.length === 0 || columnIds.length === 0) return

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    columnIds.forEach((columnId) => {
      const colIndex = columnIndexById.get(columnId)
      if (colIndex === undefined || colIndex < 0) return
      minX = Math.min(minX, colIndex)
      maxX = Math.max(maxX, colIndex)
    })

    rows.forEach((modelRow) => {
      const viewRow = modelToView(modelRow)
      if (!Number.isFinite(viewRow) || viewRow < 0) return
      minY = Math.min(minY, viewRow)
      maxY = Math.max(maxY, viewRow)
    })

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxY)
    ) {
      return
    }

    setPasteHighlightRegions([
      {
        color: '#22C55E40',
        range: {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        },
        style: 'solid-outline' as const,
      },
    ])

    if (pasteHighlightTimeoutRef.current !== null) {
      window.clearTimeout(pasteHighlightTimeoutRef.current)
    }
    pasteHighlightTimeoutRef.current = window.setTimeout(() => {
      setPasteHighlightRegions([])
      pasteHighlightTimeoutRef.current = null
    }, 1200)
  }, [columnIndexById, modelToView])

  const getVisibleColdBackendPasteRows = useCallback(
    (rows: number[], rowStart: number, rowEndExclusive: number) => {
      const visible = visibleRegionRef.current
      const visibleStart = Math.floor(visible.y)
      const visibleEnd = Math.ceil(visible.y + Math.max(1, visible.height))
      if (visibleEnd <= visibleStart) return []

      const visibleRows: number[] = []
      const seenRows = new Set<number>()
      for (const row of rows) {
        if (row < rowStart || row >= rowEndExclusive) continue
        const viewRow = modelToView(row)
        if (viewRow < visibleStart || viewRow >= visibleEnd) continue
        if (hasMaterializedRowData(row)) continue
        if (seenRows.has(row)) continue
        seenRows.add(row)
        visibleRows.push(row)
      }
      return visibleRows
    },
    [hasMaterializedRowData, modelToView]
  )

  const markColdBackendPasteBlocksDirty = useCallback(
    (datasetId: string, rows: number[]) => {
      const coldRows = rows.filter((row) => !hasMaterializedRowData(row))
      const { blockIndexes, blockKeys } = getBackendPasteBlockKeys(datasetId, coldRows)
      blockIndexes.forEach((block, index) => {
        const blockKey = blockKeys[index]
        if (!blockKey) return
        pendingBlockLoadsRef.current.delete(block)
        wantedBlocksRef.current.delete(blockKey)
        setBlockState(blockKey, 'dirty')
      })
      return blockKeys
    },
    [getBackendPasteBlockKeys, hasMaterializedRowData, setBlockState]
  )

  const hydrateBackendPasteRows = useCallback(
    async (datasetId: string, rows: number[], columnIds: string[]) => {
      if (rows.length === 0) return
      if (columnIds.length === 0) {
        await ensureRangeLoaded(Math.min(...rows), Math.max(...rows) + 1)
        return
      }

      const { blockIndexes } = getBackendPasteBlockKeys(datasetId, rows)
      for (const block of blockIndexes) {
        const blockStart = block * BLOCK_SIZE
        const blockEnd = blockStart + BLOCK_SIZE
        const rowsForBlock = await cacheService.getRowsHybridColumns(
          datasetId,
          blockStart,
          blockEnd,
          columnIds
        )
        if (rowsForBlock.length === 0) continue

        updateRowDataRef((prev) => {
          let changed = false
          const next = new Map(prev)
          rowsForBlock.forEach((rowValues, offset) => {
            const modelRow = blockStart + offset
            const currentRow = next.get(modelRow)
            if (!currentRow || isRowDataSentinel(currentRow)) return
            const nextRow = { ...currentRow }
            let rowChanged = false
            columnIds.forEach((columnId) => {
              if (!(columnId in rowValues)) return
              const nextValue = rowValues[columnId] ?? null
              if (nextRow[columnId] === nextValue) return
              nextRow[columnId] = nextValue
              rowChanged = true
            })
            if (!rowChanged) return
            next.set(modelRow, nextRow)
            changed = true
          })
          return changed ? next : prev
        })
      }
    },
    [BLOCK_SIZE, ensureRangeLoaded, getBackendPasteBlockKeys, updateRowDataRef]
  )

  // WHY: Structural undo/redo must rebuild row/column state before restoring scroll
  // and damaging the viewport, otherwise Glide can repaint against stale indices.
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
            await rebuildGrouping(applyActiveFilter(nextOrder), activeGroupBy, collapsedGroups)
          } else {
            const filteredNext = applyActiveFilter(nextOrder)
            rowOrderRef.current = filteredNext
            setRowOrder(filteredNext)
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
            await rebuildGrouping(applyActiveFilter(nextOrder), activeGroupBy, collapsedGroups)
          } else {
            const filteredNext = applyActiveFilter(nextOrder)
            rowOrderRef.current = filteredNext
            setRowOrder(filteredNext)
          }

          const activeSortModel = sortModelRef.current
          if (activeSortModel.length > 0) {
            setPendingInsertSortReplay({
              datasetId: currentDataset.id,
              sortModel: activeSortModel,
              expectedRowCount: currentDataset.rowCount + 1,
            })
          }
        }

        invalidateColumns(currentDataset.columns.map(column => column.id))
        requestScrollRestore({ x: savedScrollX, y: savedScrollY })
        requestGridRefresh({
          reason: `undo-redo-${operation.type}-${direction}`,
          scope: 'viewport',
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
          markLocalSchemaMutation(currentDataset.id)
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
          markLocalSchemaMutation(currentDataset.id)
          resetStreamingStateForStructuralEdit()

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
          scope: 'viewport',
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
      markLocalSchemaMutation,
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

  const activeGridMutationQueueStateRef = useRef<GridMutationQueueState>({
    status: 'idle',
    failedQueueId: null,
    error: null,
  })

  useEffect(() => {
    if (!currentDataset?.id) {
      activeGridMutationQueueStateRef.current = {
        status: 'idle',
        failedQueueId: null,
        error: null,
      }
      return
    }

    activeGridMutationQueueStateRef.current = cacheService.getGridMutationQueueState(currentDataset.id)
    return cacheService.subscribeGridMutationQueue(currentDataset.id, (state) => {
      activeGridMutationQueueStateRef.current = state
    })
  }, [currentDataset?.id])

  useEffect(() => {
    if (!gridSyncFailureNotice || gridSyncFailureNotice.datasetId === currentDataset?.id) {
      return
    }
    if (failedGridSyncTransactionRef.current?.id === gridSyncFailureNotice.transactionId) {
      failedGridSyncTransactionRef.current = null
    }
    setGridSyncFailureNotice(null)
  }, [currentDataset?.id, gridSyncFailureNotice])

  const retryFailedGridSync = useCallback(async (options?: {
    allowQueueOnly?: boolean
    datasetId?: string
  }) => {
    const transaction = failedGridSyncTransactionRef.current
    if (
      !transaction ||
      !gridSyncFailureNotice ||
      gridSyncFailureNotice.transactionId !== transaction.id ||
      (options?.datasetId !== undefined && options.datasetId !== transaction.datasetId)
    ) {
      if (options?.allowQueueOnly && options.datasetId) {
        try {
          await cacheService.retryGridMutationQueue(options.datasetId)
          toast.success('Dataset sync retried')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error('Dataset sync retry failed', { description: message })
        }
      }
      return
    }

    setGridSyncFailureNotice((notice) =>
      notice && notice.transactionId === transaction.id
        ? { ...notice, retrying: true }
        : notice
    )

    try {
      await cacheService.retryGridMutationQueue(transaction.datasetId)
      const edits = transaction.edits ?? []
      for (let start = 0; start < edits.length; start += PASTE_BACKEND_SYNC_CHUNK_SIZE) {
        const chunk = edits.slice(start, start + PASTE_BACKEND_SYNC_CHUNK_SIZE)
        await cacheService.enqueueGridMutationBatch(
          transaction.datasetId,
          chunk.map((edit) => ({
            row: edit.row,
            column: edit.columnId,
            value: edit.computedValue ?? edit.newValue,
          }))
        )
        await cacheService.flushGridMutationQueue(transaction.datasetId)
      }
      if (
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose'
      ) {
        const rowBounds = getEditRowBounds(edits)
        if (rowBounds) {
          if (currentDatasetIdRef.current === transaction.datasetId) {
            const touched = computeAffectedBlockKeys(
              transaction.datasetId,
              rowBounds.minRow,
              rowBounds.maxRow,
              BLOCK_SIZE
            )
            for (const key of touched) {
              setBlockState(key, 'dirty')
              const blockIndex = Number(key.split(':').pop())
              if (Number.isFinite(blockIndex)) {
                pendingBlockLoadsRef.current.delete(blockIndex)
              }
            }
            datasetRevisionRef.current += 1
            await ensureRangeLoaded(rowBounds.minRow, rowBounds.maxRow + 1)
          } else {
            datasetsNeedingReloadOnActivateRef.current.add(transaction.datasetId)
            bumpDatasetActivationReloadVersion()
          }
        }
        requestPostPasteOverlayFlush(
          transaction.datasetId,
          transaction.persistSource ?? transaction.kind,
          transaction.id
        )
      }
      failedGridSyncTransactionRef.current = null
      setGridSyncFailureNotice(null)
      toast.success('Dataset sync retried')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setGridSyncFailureNotice((notice) =>
        notice && notice.transactionId === transaction.id
          ? {
              ...notice,
              retrying: false,
              message: `Retry failed: ${message}`,
            }
          : notice
      )
      toast.error('Dataset sync retry failed', { description: message })
    }
  }, [BLOCK_SIZE, bumpDatasetActivationReloadVersion, ensureRangeLoaded, gridSyncFailureNotice, requestPostPasteOverlayFlush, setBlockState])

  const blockIfGridMutationQueueFailed = useCallback((
    activityLabel: string,
    datasetId: string
  ): boolean => {
    const queueState = cacheService.getGridMutationQueueState(datasetId)
    if (queueState.status !== 'failed') {
      return false
    }

    activeGridMutationQueueStateRef.current = queueState
    toast.warning(`${activityLabel} is unavailable while dataset sync has failed.`, {
      description: queueState.error ?? 'Retry or reload the dataset before continuing.',
      action: {
        label: 'Retry sync',
        onClick: async () => {
          await retryFailedGridSync({ allowQueueOnly: true, datasetId })
        },
      },
    })
    return true
  }, [retryFailedGridSync])

  const runBackendPasteBlockUndoRedoWithLock = useCallback(async <T,>(
    transaction: GridTransactionRecord,
    action: 'undo' | 'redo',
    run: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> => {
    if (!transaction.backendPasteBlock) {
      return { ok: true, value: await run() }
    }

    const isUndo = action === 'undo'
    const token = acquireAppOperationLock({
      owner: 'grid',
      operation: isUndo ? 'Undoing large paste' : 'Redoing large paste',
      stage: isUndo ? 'Restoring previous values...' : 'Reapplying pasted values...',
      progress: 0,
      indeterminate: true,
    })
    if (!token) {
      toast.warning(`${isUndo ? 'Undo' : 'Redo'} is unavailable while another operation is running.`)
      return { ok: false }
    }

    try {
      await waitForGridOperationLockPaint()
      const value = await run()
      updateAppOperationLock(token, {
        stage: 'Refreshing grid...',
        progress: 90,
        indeterminate: true,
      })
      return { ok: true, value }
    } finally {
      releaseAppOperationLock(token)
    }
  }, [acquireAppOperationLock, releaseAppOperationLock, updateAppOperationLock])

  const performUndo = useCallback(async (): Promise<boolean> => {
    if (!currentDataset) return false
    if (blockSchemaChangeStagingMutation('Undo')) return false
    try {
      const preparedGridTransaction =
        typeof undoService.prepareUndoGridTransaction === 'function'
          ? await undoService.prepareUndoGridTransaction(currentDataset.id)
          : null
      if (preparedGridTransaction) {
        if (blockIfGridMutationQueueFailed('Undo', preparedGridTransaction.datasetId)) {
          await undoService.rollbackUndoGridTransaction?.(currentDataset.id)
          return false
        }
        const lockedResult = await runBackendPasteBlockUndoRedoWithLock(
          preparedGridTransaction,
          'undo',
          async () => await gridMutationCoordinatorRef.current?.applyGridMutation({
            id: preparedGridTransaction.id,
            datasetId: preparedGridTransaction.datasetId,
            kind: preparedGridTransaction.kind,
            transaction: preparedGridTransaction,
          })
        )
        if (!lockedResult.ok) {
          await undoService.rollbackUndoGridTransaction?.(currentDataset.id)
          return false
        }
        const result = lockedResult.value
        if (result?.transaction.persistAccepted === false) {
          await undoService.rollbackUndoGridTransaction?.(currentDataset.id)
          return false
        }
        await undoService.commitUndoGridTransaction?.(currentDataset.id)
        return true
      }
      if (undoService.hasPreparedUndoGridTransaction?.(currentDataset.id)) {
        return false
      }
      const gridTransaction =
        typeof undoService.undoGridTransaction === 'function'
          && typeof undoService.prepareUndoGridTransaction !== 'function'
          ? await undoService.undoGridTransaction(currentDataset.id)
          : null
      if (gridTransaction) {
        if (blockIfGridMutationQueueFailed('Undo', gridTransaction.datasetId)) {
          await undoService.redoGridTransaction?.(currentDataset.id)
          return false
        }
        const lockedResult = await runBackendPasteBlockUndoRedoWithLock(
          gridTransaction,
          'undo',
          async () => await gridMutationCoordinatorRef.current?.applyGridMutation({
            id: gridTransaction.id,
            datasetId: gridTransaction.datasetId,
            kind: gridTransaction.kind,
            transaction: gridTransaction,
          })
        )
        if (!lockedResult.ok) {
          await undoService.redoGridTransaction?.(currentDataset.id)
          return false
        }
        const result = lockedResult.value
        if (result?.transaction.persistAccepted === false) {
          return false
        }
        return true
      }
      if (blockIfGridMutationQueueFailed('Undo', currentDataset.id)) return false
      const operation = await undoService.undo(currentDataset.id)
      if (!operation) return false
      await applyUndoRedoOperation(operation, 'undo')
      return true
    } catch (error) {
      await undoService.rollbackUndoGridTransaction?.(currentDataset.id)
      console.error('Undo failed:', error)
      return false
    }
  }, [applyUndoRedoOperation, blockIfGridMutationQueueFailed, blockSchemaChangeStagingMutation, currentDataset?.id, runBackendPasteBlockUndoRedoWithLock])

  const performRedo = useCallback(async (): Promise<boolean> => {
    if (!currentDataset) return false
    if (blockSchemaChangeStagingMutation('Redo')) return false
    try {
      const preparedGridTransaction =
        typeof undoService.prepareRedoGridTransaction === 'function'
          ? await undoService.prepareRedoGridTransaction(currentDataset.id)
          : null
      if (preparedGridTransaction) {
        if (blockIfGridMutationQueueFailed('Redo', preparedGridTransaction.datasetId)) {
          await undoService.rollbackRedoGridTransaction?.(currentDataset.id)
          return false
        }
        const lockedResult = await runBackendPasteBlockUndoRedoWithLock(
          preparedGridTransaction,
          'redo',
          async () => await gridMutationCoordinatorRef.current?.applyGridMutation({
            id: preparedGridTransaction.id,
            datasetId: preparedGridTransaction.datasetId,
            kind: preparedGridTransaction.kind,
            transaction: preparedGridTransaction,
          })
        )
        if (!lockedResult.ok) {
          await undoService.rollbackRedoGridTransaction?.(currentDataset.id)
          return false
        }
        const result = lockedResult.value
        if (result?.transaction.persistAccepted === false) {
          await undoService.rollbackRedoGridTransaction?.(currentDataset.id)
          return false
        }
        await undoService.commitRedoGridTransaction?.(currentDataset.id)
        return true
      }
      if (undoService.hasPreparedRedoGridTransaction?.(currentDataset.id)) {
        return false
      }
      const gridTransaction =
        typeof undoService.redoGridTransaction === 'function'
          && typeof undoService.prepareRedoGridTransaction !== 'function'
          ? await undoService.redoGridTransaction(currentDataset.id)
          : null
      if (gridTransaction) {
        if (blockIfGridMutationQueueFailed('Redo', gridTransaction.datasetId)) {
          await undoService.undoGridTransaction?.(currentDataset.id)
          return false
        }
        const lockedResult = await runBackendPasteBlockUndoRedoWithLock(
          gridTransaction,
          'redo',
          async () => await gridMutationCoordinatorRef.current?.applyGridMutation({
            id: gridTransaction.id,
            datasetId: gridTransaction.datasetId,
            kind: gridTransaction.kind,
            transaction: gridTransaction,
          })
        )
        if (!lockedResult.ok) {
          await undoService.undoGridTransaction?.(currentDataset.id)
          return false
        }
        const result = lockedResult.value
        if (result?.transaction.persistAccepted === false) {
          return false
        }
        return true
      }
      if (blockIfGridMutationQueueFailed('Redo', currentDataset.id)) return false
      const operation = await undoService.redo(currentDataset.id)
      if (!operation) return false
      await applyUndoRedoOperation(operation, 'redo')
      return true
    } catch (error) {
      await undoService.rollbackRedoGridTransaction?.(currentDataset.id)
      console.error('Redo failed:', error)
      return false
    }
  }, [applyUndoRedoOperation, blockIfGridMutationQueueFailed, blockSchemaChangeStagingMutation, currentDataset?.id, runBackendPasteBlockUndoRedoWithLock])

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

      const gridColumn = committedGridSurface.columns[colIndex]
      const columnId = gridColumn?.id

      // Safety check (should never happen with initialized dataset)
      if (!columnId || !currentDataset) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: false,
          readonly: true,
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

      const pendingActivationBundle = pendingActivationBundleRef.current
      const shouldHoldPendingActivationSurface =
        pendingActivationBundle?.datasetId === currentDataset.id &&
        modelRow >= pendingActivationBundle.visibleStartRow &&
        modelRow < pendingActivationBundle.visibleEndRow

      if (modelRow >= 0) {
        // Use staged mutation rows as the authoritative local fallback for offscreen
        // pasted ranges that have not been flushed or reloaded yet.
        const row = getLocalRowRecord(currentDataset.id, modelRow)
        const continuityRow =
          (!row || shouldHoldPendingActivationSurface) &&
          activationContinuityRef.current?.datasetId === currentDataset.id &&
          modelRow < resolveDataRowCount(currentDataset)
            ? activationContinuityRef.current.rows.get(modelRow) ?? null
            : null

        if (continuityRow) {
          let continuityValue = continuityRow[columnId]
          if (continuityValue === undefined) {
            const columnIdLower = columnId.toLowerCase()
            const altKey = Object.keys(continuityRow).find((key) => key.toLowerCase() === columnIdLower)
            if (altKey) {
              continuityValue = continuityRow[altKey as keyof typeof continuityRow]
            }
          }
          if (continuityValue === undefined) {
            const candidates = getColumnFallbackCandidates(columnId)
            if (candidates) {
              for (const key of candidates) {
                if (Object.prototype.hasOwnProperty.call(continuityRow, key)) {
                  continuityValue = continuityRow[key as keyof typeof continuityRow]
                  break
                }
              }
            }
          }

          const continuityDisplay =
            continuityValue === null || continuityValue === undefined
              ? ''
              : typeof continuityValue === 'number'
                ? formatNumber(continuityValue)
                : String(continuityValue)

          return {
            kind: GridCellKind.Text,
            data: continuityDisplay,
            displayData: continuityDisplay,
            allowOverlay: false,
            readonly: true,
          }
        }
      }

      const column = columnMetadataMap.get(columnId)
      if (!column) {
        // Shouldn't happen - all columns should have metadata
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '',
          allowOverlay: false,
          readonly: true,
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
        logFormulaDisplayState(cellKey, 'draft', {
          datasetId: currentDataset.id,
          columnId,
          modelRow,
          displayData: formulaDraftText,
          copyData: formulaDraftText,
        })
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

      // Use staged mutation rows as the authoritative local fallback for offscreen
      // pasted ranges that have not been flushed or reloaded yet.
      const row = getLocalRowRecord(currentDataset.id, modelRow)

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

      const rowId = buildDatasetScopedRowId(currentDataset.id, modelRow)
      const hasOverlayRow = Boolean(sharedOverlayModelByDataset.get(currentDataset.id)?.getOverlayRow(rowId))
      const overlayBlockIndex = Math.floor(modelRow / BLOCK_SIZE)
      const overlayBlockKey = `${currentDataset.id}:block:${overlayBlockIndex}`
      const datasetDataRowCount = resolveDataRowCount(currentDataset)
      const overlayBlockState = getBlockState(overlayBlockKey)
      const needsOverlayBaseHydration =
        hasOverlayRow &&
        !isLazyGrouped &&
        modelRow < datasetDataRowCount &&
        !hasMaterializedRowData(modelRow)
      const shouldRecoverStaleLoadedOverlay =
        needsOverlayBaseHydration &&
        overlayBlockState === 'loaded' &&
        !staleLoadedOverlayRecoveryRef.current.has(overlayBlockKey)
      if (
        needsOverlayBaseHydration &&
        (overlayBlockState !== 'loaded' || shouldRecoverStaleLoadedOverlay)
      ) {
        if (shouldRecoverStaleLoadedOverlay) {
          staleLoadedOverlayRecoveryRef.current.add(overlayBlockKey)
          logPasteDebug('paste_stale_loaded_overlay_recovery', {
            datasetId: currentDataset.id,
            modelRow,
            columnId,
            blockIndex: overlayBlockIndex,
            blockState: overlayBlockState,
            dataRowCount: datasetDataRowCount,
            rowKeyCount: Object.keys(row).length,
            isSentinelRow: isRowDataSentinel(row),
            visibleY: visibleRegionRef.current.y,
            visibleHeight: visibleRegionRef.current.height,
          })
        }
        const debugKey = `${currentDataset.id}:block:${overlayBlockIndex}`
        if (!sparseOverlayDebugSeenRef.current.has(debugKey)) {
          sparseOverlayDebugSeenRef.current.add(debugKey)
          logPasteDebug('paste_sparse_overlay_row_seen', {
            datasetId: currentDataset.id,
            modelRow,
            columnId,
            blockIndex: overlayBlockIndex,
            blockState: overlayBlockState ?? null,
            dataRowCount: datasetDataRowCount,
            rowKeyCount: Object.keys(row).length,
            isSentinelRow: isRowDataSentinel(row),
            visibleY: visibleRegionRef.current.y,
            visibleHeight: visibleRegionRef.current.height,
          })
        }
        if (!pendingBlockLoadsRef.current.has(overlayBlockIndex)) {
          setBlockState(overlayBlockKey, 'dirty')
          pendingBlockLoadsRef.current.add(overlayBlockIndex)
          void ensureRangeLoaded(modelRow, modelRow + 1).finally(() => {
            pendingBlockLoadsRef.current.delete(overlayBlockIndex)
          })
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

      logWatchedCutEvent('cut_watch_cell_read', 'getCellContent', {
        datasetId: currentDataset.id,
        modelRow,
        columnId,
        valueAfter: value ?? null,
      })

      // Fallback: handle rows keyed by display names instead of col-{idx}
      if (value === undefined) {
        const candidates = getColumnFallbackCandidates(columnId)
        if (candidates) {
          for (const key of candidates) {
            if (Object.prototype.hasOwnProperty.call(row, key)) {
              value = row[key as keyof typeof row]
              break
            }
          }
        }
      }

      if (
        value === undefined &&
        hasOverlayRow &&
        modelRow < datasetDataRowCount &&
        !hasMaterializedRowData(modelRow)
      ) {
        const debugKey = `${currentDataset.id}:loading-neighbor:${overlayBlockIndex}:${columnId}`
        if (!sparseOverlayDebugSeenRef.current.has(debugKey)) {
          sparseOverlayDebugSeenRef.current.add(debugKey)
          logPasteDebug('paste_cold_overlay_neighbor_loading_cell', {
            datasetId: currentDataset.id,
            modelRow,
            columnId,
            blockIndex: overlayBlockIndex,
            blockState: getBlockState(overlayBlockKey) ?? null,
            dataRowCount: datasetDataRowCount,
            rowKeyCount: Object.keys(row).length,
            rowKeys: Object.keys(row).slice(0, 12),
            hasOverlayRow,
            hasMaterializedRow: hasMaterializedRowData(modelRow),
            visibleY: visibleRegionRef.current.y,
            visibleHeight: visibleRegionRef.current.height,
          })
        }
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: '...',
          allowOverlay: false,
          readonly: true,
          ...(highlightColor ? { themeOverride: { bgCell: highlightColor } } : {}),
        }
      }

      // Handle pending calculation sentinel (async aggregate formulas - Phase 5.2)
      if (FormulaService.isPendingCalculation(value)) {
        const cellKey = `${modelRow}:${columnId}` // Use modelRow for formula key
        const hasFormula = formulaService?.hasFormula(cellKey) ?? false
        if (hasFormula) {
          const rawFormula = formulaService?.getFormula(cellKey)
          logFormulaDisplayState(cellKey, 'pending', {
            datasetId: currentDataset.id,
            columnId,
            modelRow,
            displayData: 'Calculating...',
            copyData: rawFormula,
          })
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
            logFormulaDisplayState(cellKeyForFormula, 'computed', {
              datasetId: currentDataset.id,
              columnId,
              modelRow,
              displayData: dateDisplay,
              copyData: rawFormula,
              columnType: column.type,
            })
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
              if (rawFormula) {
                logFormulaDisplayState(cellKey, 'computed', {
                  datasetId: currentDataset.id,
                  columnId,
                  modelRow,
                  displayData: dateDisplay,
                  copyData: rawFormula,
                  columnType: column.type,
                })
              }
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
            if (rawFormula) {
              logFormulaDisplayState(cellKey, 'computed', {
                datasetId: currentDataset.id,
                columnId,
                modelRow,
                displayData: formatNumber(value),
                copyData: rawFormula,
                columnType: column.type,
              })
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
                if (rawFormula) {
                  logFormulaDisplayState(cellKey, 'computed', {
                    datasetId: currentDataset.id,
                    columnId,
                    modelRow,
                    displayData: dateDisplay,
                    copyData: rawFormula,
                    columnType: column.type,
                  })
                }
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
              if (rawFormula) {
                logFormulaDisplayState(cellKey, 'computed', {
                  datasetId: currentDataset.id,
                  columnId,
                  modelRow,
                  displayData: formatNumber(parsed),
                  copyData: rawFormula,
                  columnType: column.type,
                })
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
            if (rawFormula) {
              logFormulaDisplayState(cellKey, value === rawFormula ? 'raw' : 'computed', {
                datasetId: currentDataset.id,
                columnId,
                modelRow,
                displayData: value,
                copyData: rawFormula,
                columnType: column.type,
              })
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
          if (rawFormula) {
            logFormulaDisplayState(cellKey, fallbackText === rawFormula ? 'raw' : 'computed', {
              datasetId: currentDataset.id,
              columnId,
              modelRow,
              displayData: fallbackText,
              copyData: rawFormula,
              columnType: column.type,
            })
          }
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
              logFormulaDisplayState(cellKey, 'computed', {
                datasetId: currentDataset.id,
                columnId,
                modelRow,
                displayData: dateDisplay,
                copyData: rawFormula,
                columnType: column.type,
              })
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
          if (rawFormula) {
            const displayData = typeof value === 'number' ? formatNumber(value) : String(value)
            logFormulaDisplayState(cellKey, displayData === rawFormula ? 'raw' : 'computed', {
              datasetId: currentDataset.id,
              columnId,
              modelRow,
              displayData,
              copyData: rawFormula,
              columnType: column.type,
            })
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
          if (rawFormula) {
            logFormulaDisplayState(cellKey, displayValue === rawFormula ? 'raw' : 'computed', {
              datasetId: currentDataset.id,
              columnId,
              modelRow,
              displayData: displayValue,
              copyData: rawFormula,
              columnType: column.type,
            })
          }
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
          if (rawFormula) {
            const displayData = String(value)
            logFormulaDisplayState(cellKey, displayData === rawFormula ? 'raw' : 'computed', {
              datasetId: currentDataset.id,
              columnId,
              modelRow,
              displayData,
              copyData: rawFormula,
              columnType: column.type,
            })
          }
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
      committedGridSurface,
      currentDataset,
      formulaService,
      formulaBarText,
      groupHeaderCellTheme,
      getColumnFallbackCandidates,
      pendingFormulaTheme,
      resolveDataRowCount,
      viewToModel,
      groupHeaderByViewRow,
      getLocalRowRecord,
      hasMaterializedRowData,
      logGridDebug,
      logPasteDebug,
      logWatchedCutEvent,
      ensureRangeLoaded,
      getBlockState,
      isLazyGrouped,
      setBlockState,
    ]
  )

  // Handle cell edits - uses EditExecutor for unified edit pipeline
  const onCellEdited = useCallback(
    (cell: Item, newValue: EditableGridCell) => {
      if (blockSchemaChangeStagingMutation('Editing')) {
        return
      }

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

      // Coerce value through column type semantics (all types: numeric, categorical, text, datetime).
      const typedCellValue: unknown = coerceEditValue(
        cellValue,
        column.type,
        (s) => formulaService?.isFormula(s) ?? false
      )

      // Get old value for undo support
      const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow

      const edit: CellEdit = {
        row: modelRow, // Use modelRow for edit
        columnId,
        oldValue,
        newValue: typedCellValue,
      }

      const gridMutationCoordinator = gridMutationCoordinatorRef.current
      if (!gridMutationCoordinator) {
        return
      }
      const transaction: GridTransactionRecord = {
        id: nextGridOperationId('type'),
        datasetId: currentDataset.id,
        kind: 'type',
        edits: [edit],
      }
      void gridMutationCoordinator
        .applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })
        .finally(() => {
          invalidateSelectAllStats(currentDataset.id)
        })

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
      formulaService,
      getCellRawValueForUndo,
      viewToModel,
      bumpDataRowCount,
      ensureLazyGroupedRangeLoaded,
      blockSchemaChangeStagingMutation,
      isLazyGrouped,
      groupByColumnId,
      updateRowDataRef,
      scheduleCellUpdates,
      invalidateSelectAllStats,
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
        (sortModel.length === 0 && groupByColumnId === null ||
          rowOrder.length <= MODEL_TO_VIEW_CACHE_THRESHOLD)

      // OPTIMIZATION: Targeted damage - only repaint loaded rows if specified
      if (canUseTargetedDamage) {
        // Convert model rows to view rows and damage only those
        const viewRowsToUpdate = new Set<number>()
        for (const modelRow of loadedModelRows) {
          const viewRow =
            sortModel.length === 0 && groupByColumnId === null
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
  }, [columns.length, rowCount, modelToView, primarySortKey, groupByColumnId, rowOrder.length, requestGridRefresh])

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
      selectionRevisionRef.current += 1
      gridSelectionRef.current = selection
      const currentSelection = selection.current
      const isSingleCellSelect =
        !!currentSelection &&
        currentSelection.range.width === 1 &&
        currentSelection.range.height === 1 &&
        selection.rows.length === 0 &&
        selection.columns.length === 0

      const applySelectionState = () => {
        setFormulaRangePreview(null)
        setGridSelection(selection)

        // Track the "active" cell for the formula bar (always use selection.current)
        if (currentSelection && currentDataset) {
          const [colIndex, rowIndex] = currentSelection.cell
          const col = currentDataset.columns[colIndex]
          if (col) {
            setActiveCell({ rowIndex, colIndex, columnId: col.id })
          }
        } else {
          setActiveCell(null)
        }
      }

      if (isSingleCellSelect) {
        flushSync(applySelectionState)
      } else {
        applySelectionState()
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

  // Handle header click: single-click = selection only, double-click body = rename, double-click edge = auto-fit.
  const onHeaderClicked = useCallback(
    (colIndex: number, event?: HeaderClickedEventArgs) => {
      if (!currentDataset) return

      // Virtual "+" column: add new column
      if (colIndex === currentDataset.columns.length) {
        handleAddColumn()
        return
      }

      const selectionModifierEvent = event as HeaderClickedEventArgs & {
        ctrlKey?: boolean
        metaKey?: boolean
        shiftKey?: boolean
      }
      if (selectionModifierEvent.shiftKey || selectionModifierEvent.ctrlKey || selectionModifierEvent.metaKey) {
        return
      }

      // Double-click on column edge: auto-fit width (unchanged behavior)
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

      // Double-click on header body: open rename dialog.
      if (event?.isDoubleClick) {
        const column = currentDataset.columns[colIndex]
        if (!column?.id) return
        setRenameDialog({
          isOpen: true,
          colIndex,
          colId: String(column.id),
          currentName: column.name,
          newName: column.name,
        })
        return
      }

      // Plain header clicks are intentionally selection-only. Sorting is explicit via the toolbar.
    },
    [
      currentDataset,
      estimateAutoFitWidth,
      handleAddColumn,
      updateDataset,
    ]
  )

  // Handle rename dialog confirm
  const handleRenameConfirm = useCallback(
    async () => {
      if (!renameDialog || !currentDataset) return

      const colIndex = currentDataset.columns.findIndex((column) => String(column.id) === renameDialog.colId)
      if (colIndex < 0) {
        toast.error('Column no longer exists. Rename was not applied.')
        setRenameDialog(null)
        return
      }

      const column = currentDataset.columns[colIndex]
      if (!column) {
        toast.error('Column no longer exists. Rename was not applied.')
        setRenameDialog(null)
        return
      }

      const currentName = column.name
      const { newName } = renameDialog
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
        let metadataSynced = true
        try {
          await tauriApi.updateDatasetMetadata(currentDataset.id, updatedColumns)
        } catch (error) {
          metadataSynced = false
          console.error('Failed to sync column rename to backend:', error)
        }

        if (!metadataSynced) {
          updateDataset(currentDataset.id, {
            columns: currentDataset.columns,
          })
          if (reservedAutoName) {
            rollbackAutoColumnNameAllocation(currentDataset.id, reservedAutoName)
          }
          toast.error('Failed to rename column. Please try again.')
          setRenameDialog(null)
          return
        }

        if (column.id && metadataSynced) {
          await undoService.recordGridTransaction(currentDataset.id, {
            id: nextGridOperationId('rename'),
            datasetId: currentDataset.id,
            kind: 'rename',
            columnRenames: [
              {
                columnId: String(column.id),
                oldName: renameDialog.currentName,
                newName: nextName,
              },
            ],
          })
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
      nextGridOperationId,
      rollbackAutoColumnNameAllocation,
      tauriApi,
    ]
  )

  const resolveColumnRenamesFromHeaderPaste = useCallback(
    (datasetId: string, startColIndex: number, headerNames: string[]): GridTransactionRecord['columnRenames'] => {
      if (headerNames.length === 0) return undefined

      const datasetForRename =
        useDataStore.getState().datasets.find((dataset) => dataset.id === datasetId)
      if (!datasetForRename) return undefined
      const updatedColumns = [...datasetForRename.columns]
      const renameRecords: Array<{
        columnId: string
        oldName: string
        newName: string
      }> = []

      headerNames.forEach((headerName, offset) => {
        const colIndex = startColIndex + offset
        const column = updatedColumns[colIndex]
        if (!column || column.id === ADD_COLUMN_ID) {
          return
        }

        const currentName = column.name
        const { nextName, reservedAutoName } = resolveColumnRenameTarget({
          colIndex,
          requestedName: headerName,
          columns: updatedColumns,
        })
        const reservedAutoNameConsumed =
          !!reservedAutoName && nextName === reservedAutoName && nextName !== currentName

        if (nextName !== currentName) {
          updatedColumns[colIndex] = { ...column, name: nextName }
          renameRecords.push({
            columnId: String(column.id),
            oldName: currentName,
            newName: nextName,
          })
        }

        if (reservedAutoName && !reservedAutoNameConsumed) {
          rollbackAutoColumnNameAllocation(datasetId, reservedAutoName)
        }
      })

      return renameRecords.length > 0 ? renameRecords : undefined
    },
    [
      rollbackAutoColumnNameAllocation,
    ]
  )

  const copySelectionToClipboard = useCallback(async () => {
    if (blockSchemaChangeStagingMutation('Copy')) {
      return
    }
    const selection = gridSelectionRef.current
    const hasColumnSelection = selection.columns.length > 0
    if (!currentDataset || (!selection.current && !hasColumnSelection)) {
      console.warn('No selection available for copy')
      return
    }
    copyContextRef.current = null
    logGridDebug('copy_context_cleared', { reason: 'copy_start' })

    const dataRowCount = resolveDataRowCount(currentDataset)
    const selectionRanges = selection.current
      ? [selection.current.range, ...(selection.current.rangeStack ?? [])]
      : []
    const explicitRows = Array.from(selection.rows)
    const explicitCols = Array.from(selection.columns)
    const rangeBlocks = buildSelectionCellBlocks(selectionRanges)
    const isColumnOnlySelection = explicitCols.length > 0 && explicitRows.length === 0 && selectionRanges.length === 0
    const selectionBlocks = explicitRows.length > 0 || explicitCols.length > 0
      ? [{
          rows: explicitRows.length > 0
            ? explicitRows
            : isColumnOnlySelection
              ? rangeValues(0, dataRowCount)
              : uniqueSortedNumbers(rangeBlocks.flatMap(block => block.rows)),
          colIndices: explicitCols.length > 0
            ? explicitCols
            : uniqueSortedNumbers(rangeBlocks.flatMap(block => block.colIndices)),
        }]
      : rangeBlocks
    const clipboardBlocks = selectionBlocks
      .map(block => ({
        rows: block.rows,
        columnIds: block.colIndices
          .map(colIndex => columns[colIndex])
          .filter((gridColumn): gridColumn is GridColumn => Boolean(gridColumn?.id && gridColumn.id !== ADD_COLUMN_ID))
          .map(gridColumn => String(gridColumn.id)),
      }))
      .filter(block => block.rows.length > 0 && block.columnIds.length > 0)

    if (clipboardBlocks.length === 0) {
      return
    }
    const viewRows = uniqueSortedNumbers(clipboardBlocks.flatMap(block => block.rows))
    const selectedColumnCount = new Set(clipboardBlocks.flatMap(block => block.columnIds)).size
    const selectedColumnIdsByViewRow = new Map<number, Set<string>>()
    for (const block of clipboardBlocks) {
      for (const viewRow of block.rows) {
        let columnIds = selectedColumnIdsByViewRow.get(viewRow)
        if (!columnIds) {
          columnIds = new Set<string>()
          selectedColumnIdsByViewRow.set(viewRow, columnIds)
        }
        for (const columnId of block.columnIds) {
          columnIds.add(columnId)
        }
      }
    }

    const capturedDatasetId = currentDataset.id
    const copyOpId = Math.random().toString(36).slice(2, 8)
    logTelemetry('[copy:start]', {
      opId: copyOpId,
      capturedDatasetId,
      capturedFamilyId: useAppStore.getState().activeFamilyId,
      selectionRows: viewRows.length,
      selectionCols: selectedColumnCount,
    })

    const modelRows: number[] = []
    const rowsNeedingBackend = new Set<number>()
    const hasSelectedCellsLocally = (viewRow: number, modelRow: number): boolean => {
      const localRecord = getLocalRowRecord(capturedDatasetId, modelRow)
      if (!localRecord) return false
      const selectedColumnIds = selectedColumnIdsByViewRow.get(viewRow)
      if (!selectedColumnIds || selectedColumnIds.size === 0) return false
      for (const columnId of selectedColumnIds) {
        if (!Object.prototype.hasOwnProperty.call(localRecord, columnId)) {
          return false
        }
      }
      return true
    }
    const copyRowLimit = isColumnOnlySelection ? dataRowCount : rowCount
    for (const viewRow of viewRows) {
      if (viewRow >= copyRowLimit) break
      const modelRow = viewToModel(viewRow)
      modelRows.push(modelRow)
      if (
        modelRow >= 0 &&
        modelRow < dataRowCount &&
        !hasMaterializedRowData(modelRow) &&
        !hasSelectedCellsLocally(viewRow, modelRow)
      ) {
        rowsNeedingBackend.add(modelRow)
      }
    }

    let rowDataSource: Map<number, Record<string, unknown>>
    if (rowsNeedingBackend.size === 0) {
      rowDataSource = rowDataRef.current
    } else {
      const validModelRows = modelRows.filter(r => r >= 0)
      if (validModelRows.length === 0) return
      const minRow = Math.min(...validModelRows)
      const maxRow = Math.max(...validModelRows)
      const unloadedRowCount = rowsNeedingBackend.size
      logTelemetry('[copy:backend-start]', { opId: copyOpId, capturedDatasetId, minRow, maxRow, unloadedRowCount })
      let backendRows: Record<string, unknown>[]
      try {
        await cacheService.flushPendingUpdates()
        backendRows = await cacheService.getRowsHybrid(capturedDatasetId, minRow, maxRow + 1)
      } catch (error) {
        console.error('Failed to fetch rows for copy:', error)
        logTelemetry('[copy:abort]', { opId: copyOpId, reason: 'backend-fetch-error' })
        toast.warning('Could not load row data for copy. Please try again.')
        return
      }
      // Discard if the user switched datasets while the fetch was in flight.
      if (currentDatasetIdRef.current !== capturedDatasetId) {
        logTelemetry('[copy:abort]', { opId: copyOpId, reason: 'stale-dataset' })
        return
      }
      // Verify backend returned data for every data row in the selection.
      // If any row is missing, the fetch is incomplete — warn and abort rather than
      // writing blank strings to the clipboard.
      for (const modelRow of rowsNeedingBackend) {
        if (modelRow < dataRowCount && backendRows[modelRow - minRow] === undefined) {
          logTelemetry('[copy:abort]', { opId: copyOpId, reason: 'incomplete-backend-response', rowCount: backendRows.length, needed: rowsNeedingBackend.size })
          toast.warning('Some rows in your selection are not yet loaded. Scroll to load them, then copy again.')
          return
        }
      }
      logTelemetry('[copy:backend-end]', { opId: copyOpId, rowCount: backendRows.length, complete: true })

      // Build a local map keyed by absolute model row index.
      const backendMap = new Map<number, Record<string, unknown>>()
      for (const modelRow of validModelRows) {
        backendMap.set(modelRow, backendRows[modelRow - minRow] ?? {})
      }
      rowDataSource = backendMap
    }

    const columnNameById = new Map(currentDataset.columns.map(column => [String(column.id), column.name]))
    const copiedColumnHeaders = isColumnOnlySelection
      ? Array.from(new Set(clipboardBlocks.flatMap(block => block.columnIds)))
          .map(columnId => columnNameById.get(columnId) ?? columnId)
      : undefined
    const lines: string[] = copiedColumnHeaders ? [copiedColumnHeaders.join('\t')] : []
    for (const block of clipboardBlocks) {
      for (const viewRow of block.rows) {
        if (viewRow >= copyRowLimit) break
        const modelRow = viewToModel(viewRow)
        const baseRecord = modelRow >= 0 ? (rowDataSource.get(modelRow) ?? {}) : {}
        const localRecord = modelRow >= 0 ? getLocalRowRecord(capturedDatasetId, modelRow) : null
        const rowRecord = localRecord ? { ...baseRecord, ...localRecord } : baseRecord
        const cells = block.columnIds.map(columnId => {
          const value = rowRecord[columnId]
          return value === undefined || value === null ? '' : String(value)
        })
        lines.push(cells.join('\t'))
      }
    }

    const clipboardText = lines.join('\n')
    try {
      await clipboard.write(clipboardText)
      recordCopyContext(capturedDatasetId, clipboardText, {
        includesColumnHeaders: isColumnOnlySelection,
        copiedColumnHeaders,
      })
    } catch (error) {
      console.error('Failed to copy selection to clipboard:', error)
    }
  }, [blockSchemaChangeStagingMutation, columns, currentDataset, getLocalRowRecord, hasMaterializedRowData, logGridDebug, recordCopyContext, resolveDataRowCount, rowCount, viewToModel])

  // Expose clipboard actions to parent toolbars (ActionToolbar)
  useEffect(() => {
    onCopyRequest?.(copySelectionToClipboard)
    return () => {
      onCopyRequest?.(null)
    }
  }, [copySelectionToClipboard, onCopyRequest])

  // Cut selection to clipboard - copy then clear using EditExecutor.
  // Mirrors copySelectionToClipboard's backend-fetch path: if any selected data rows are
  // unloaded from the in-memory cache, fetch them via getRowsHybrid before writing the
  // clipboard and building clear edits. This gives cut parity with copy for unloaded rows.
  const cutToClipboard = useCallback(async () => {
    if (blockSchemaChangeStagingMutation('Cut')) {
      return
    }
    const selection = gridSelectionRef.current
    if (!currentDataset || !selection.current || !editExecutor) {
      console.warn('No selection available for cut')
      return
    }
    copyContextRef.current = null
    logGridDebug('copy_context_cleared', { reason: 'cut_start' })
    const selectionRanges = [selection.current.range, ...(selection.current.rangeStack ?? [])]
    const cutBlocks = buildSelectionCellBlocks(selectionRanges)
      .map(block => ({
        rows: block.rows,
        columnIds: block.colIndices
          .map(colIndex => columns[colIndex])
          .filter((gridColumn): gridColumn is GridColumn => Boolean(gridColumn?.id && gridColumn.id !== ADD_COLUMN_ID))
          .map(gridColumn => String(gridColumn.id)),
      }))
      .filter(block => block.rows.length > 0 && block.columnIds.length > 0)
    if (cutBlocks.length === 0) {
      return
    }
    if (cutInFlightRef.current) {
      logGridDebug('cut_abort', {
        reason: 'cut_in_flight',
        datasetId: currentDataset.id,
      })
      return
    }
    cutInFlightRef.current = true
    try {
      const capturedDatasetId = currentDataset.id
      const dataRowCount = resolveDataRowCount(currentDataset)
      const modelRows: number[] = []
      let hasUnloaded = false
      const viewRows = uniqueSortedNumbers(cutBlocks.flatMap(block => block.rows))
      for (const viewRow of viewRows) {
        if (viewRow >= rowCount) break
        const modelRow = viewToModel(viewRow)
        modelRows.push(modelRow)
        if (modelRow >= 0 && modelRow < dataRowCount && !hasMaterializedRowData(modelRow)) {
          hasUnloaded = true
        }
      }

      let rowDataSource: Map<number, Record<string, unknown>>
      if (!hasUnloaded) {
        rowDataSource = rowDataRef.current
      } else {
        const validModelRows = modelRows.filter(r => r >= 0)
        if (validModelRows.length === 0) return
        const minRow = Math.min(...validModelRows)
        const maxRow = Math.max(...validModelRows)
        let backendRows: Record<string, unknown>[]
        try {
          await cacheService.flushPendingUpdates()
          backendRows = await cacheService.getRowsHybrid(capturedDatasetId, minRow, maxRow + 1)
        } catch (error) {
          console.error('Failed to fetch rows for cut:', error)
          toast.warning('Could not load row data for cut. Please try again.')
          return
        }
        if (currentDatasetIdRef.current !== capturedDatasetId) {
          return
        }
        for (const modelRow of validModelRows) {
          if (modelRow < dataRowCount && backendRows[modelRow - minRow] === undefined) {
            toast.warning('Some rows in your selection are not yet loaded. Scroll to load them, then cut again.')
            return
          }
        }
        const backendMap = new Map<number, Record<string, unknown>>()
        for (const modelRow of validModelRows) {
          backendMap.set(modelRow, backendRows[modelRow - minRow] ?? {})
        }
        rowDataSource = backendMap
      }

      const lines: string[] = []
      const edits: CellEdit[] = []
      const editKeys = new Set<string>()
      for (const block of cutBlocks) {
        for (const viewRow of block.rows) {
          if (viewRow >= rowCount) break
          const modelRow = viewToModel(viewRow)
          const baseRecord = modelRow >= 0 ? (rowDataSource.get(modelRow) ?? {}) : {}
          const localRecord = modelRow >= 0 ? getLocalRowRecord(capturedDatasetId, modelRow) : null
          const rowRecord = localRecord ? { ...baseRecord, ...localRecord } : baseRecord
          const cells = block.columnIds.map(columnId => {
            const value = rowRecord[columnId]
            return value === undefined || value === null ? '' : String(value)
          })
          lines.push(cells.join('\t'))
          block.columnIds.forEach(columnId => {
            const editKey = `${modelRow}:${columnId}`
            if (editKeys.has(editKey)) return
            editKeys.add(editKey)
            // Prefer rowDataSource over getCellRawValueForUndo so unloaded rows have correct
            // oldValue (from backend fetch) rather than null (rowDataRef miss).
            const fromSource = rowRecord[columnId]
            const oldValue = fromSource !== undefined ? fromSource : getCellRawValueForUndo(modelRow, columnId)
            edits.push({ row: modelRow, columnId, oldValue, newValue: '' })
          })
        }
      }

      const clipboardText = lines.join('\n')
      try {
        await clipboard.write(clipboardText)
        if (currentDatasetIdRef.current !== capturedDatasetId) {
          return
        }
        recordCopyContext(capturedDatasetId, clipboardText)
      } catch (error) {
        console.error('Failed to copy selection to clipboard:', error)
        return
      }

      if (edits.length > 0) {
        const gridMutationCoordinator = gridMutationCoordinatorRef.current
        if (!gridMutationCoordinator) {
          return
        }
        const transaction: GridTransactionRecord = {
          id: nextGridOperationId('cut'),
          datasetId: capturedDatasetId,
          kind: 'cut',
          edits,
        }
        await gridMutationCoordinator.applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })
      }
    } finally {
      cutInFlightRef.current = false
    }
  }, [blockSchemaChangeStagingMutation, columns, currentDataset, editExecutor, getCellRawValueForUndo, getLocalRowRecord, hasMaterializedRowData, logGridDebug, nextGridOperationId, recordCopyContext, resolveDataRowCount, rowCount, viewToModel])

  useEffect(() => {
    onCutRequest?.(cutToClipboard)
    return () => {
      onCutRequest?.(null)
    }
  }, [cutToClipboard, onCutRequest])

  // Delete selection - clears cells and unregisters formulas via EditExecutor
  const deleteSelection = useCallback(async () => {
    if (blockSchemaChangeStagingMutation('Delete')) {
      return
    }
    if (!currentDataset || !gridSelection.current || !editExecutor) {
      return
    }

    const selectionRanges = [gridSelection.current.range, ...(gridSelection.current.rangeStack ?? [])]
    const deleteBlocks = buildSelectionCellBlocks(selectionRanges)
      .map(block => ({
        rows: block.rows,
        columnIds: block.colIndices
          .map(colIndex => columns[colIndex])
          .filter((gridColumn): gridColumn is GridColumn => Boolean(gridColumn?.id && gridColumn.id !== ADD_COLUMN_ID))
          .map(gridColumn => String(gridColumn.id)),
      }))
      .filter(block => block.rows.length > 0 && block.columnIds.length > 0)
    if (deleteBlocks.length === 0) {
      return
    }

    const dataRowCount = resolveDataRowCount(currentDataset)
    const selectedModelRows = uniqueSortedNumbers(
      deleteBlocks.flatMap(block =>
        block.rows
          .filter(viewRow => viewRow < rowCount)
          .map(viewRow => viewToModel(viewRow))
          .filter(modelRow => modelRow >= 0 && modelRow < dataRowCount)
      )
    )
    const missingModelRows = selectedModelRows.filter(modelRow => !hasMaterializedRowData(modelRow))
    if (missingModelRows.length > 0) {
      const capturedDatasetId = currentDataset.id
      const minRow = Math.min(...missingModelRows)
      const maxRow = Math.max(...missingModelRows)
      let backendRows: Record<string, unknown>[]
      try {
        await cacheService.flushPendingUpdates()
        backendRows = await cacheService.getRowsHybrid(capturedDatasetId, minRow, maxRow + 1)
      } catch (error) {
        console.error('Failed to fetch rows for delete:', error)
        toast.warning('Could not load row data for delete. Please try again.')
        return
      }
      if (currentDatasetIdRef.current !== capturedDatasetId) {
        return
      }
      for (const modelRow of missingModelRows) {
        if (backendRows[modelRow - minRow] === undefined) {
          toast.warning('Some rows in your selection are not yet loaded. Scroll to load them, then delete again.')
          return
        }
      }
      updateRowDataRef(prevRows => {
        const nextRows = new Map(prevRows)
        for (const modelRow of missingModelRows) {
          nextRows.set(modelRow, backendRows[modelRow - minRow] ?? {})
        }
        return nextRows
      })
    }

    const edits: CellEdit[] = []
    const editKeys = new Set<string>()
    for (const block of deleteBlocks) {
      for (const viewRow of block.rows) {
        if (viewRow >= rowCount) {
          break
        }

        const modelRow = viewToModel(viewRow) // Convert view → model

        // Build edits to clear each cell
        block.columnIds.forEach(columnId => {
          const editKey = `${modelRow}:${columnId}`
          if (editKeys.has(editKey)) return
          editKeys.add(editKey)
          const oldValue = getCellRawValueForUndo(modelRow, columnId) // Use modelRow
          edits.push({
            row: modelRow, // Use modelRow for edit
            columnId,
            oldValue,
            newValue: '', // Clear the cell
          })
        })
      }
    }

    const gridMutationCoordinator = gridMutationCoordinatorRef.current
    if (!gridMutationCoordinator) {
      return
    }

    if (edits.length > 0) {
      const postDeleteRows = new Map(rowDataRef.current)
      for (const edit of edits) {
        const row = { ...(postDeleteRows.get(edit.row) ?? {}) }
        row[edit.columnId] = edit.newValue
        postDeleteRows.set(edit.row, row)
      }
      const transaction = {
        id: nextGridOperationId('delete'),
        datasetId: currentDataset.id,
        edits,
        kind: 'delete' as const,
      }
      await gridMutationCoordinator.applyGridMutation({
        id: transaction.id,
        datasetId: transaction.datasetId,
        kind: transaction.kind,
        transaction,
      })

      const storageInfo = storageInfoRef.current.get(currentDataset.id)
      if (storageInfo?.isLarge !== true) {
        const currentDataRowCount = resolveDataRowCount(currentDataset)
        let hasCompleteDataRange = postDeleteRows.size >= currentDataRowCount
        for (let rowIndex = 0; hasCompleteDataRange && rowIndex < currentDataRowCount; rowIndex += 1) {
          hasCompleteDataRange = postDeleteRows.has(rowIndex)
        }
        if (hasCompleteDataRange) {
          const columnIds = currentDataset.columns
            .map(column => column.id)
            .filter(columnId => columnId !== ADD_COLUMN_ID)
          const loweredDataRowCount = computeLoweredDataRowCount(
            currentDataRowCount,
            postDeleteRows,
            columnIds
          )
          if (loweredDataRowCount < currentDataRowCount) {
            updateDataset(currentDataset.id, { dataRowCount: loweredDataRowCount })
          }
        }
      }
    }
  }, [blockSchemaChangeStagingMutation, columns, currentDataset, editExecutor, getCellRawValueForUndo, gridSelection, hasMaterializedRowData, nextGridOperationId, resolveDataRowCount, rowCount, updateDataset, updateRowDataRef, viewToModel])

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

  const resolveHeaderPasteStartCol = useCallback((preferContextTarget: boolean): number | undefined => {
    if (preferContextTarget && contextMenu.isOpen && contextMenu.target.kind === 'header') {
      return contextMenu.target.colIndex
    }

    const selection = gridSelectionRef.current
    if (selection.current) return undefined
    return selection.columns.first()
  }, [contextMenu.isOpen, contextMenu.target])

  const stageMutationRows = useCallback((datasetId: string, mutationId: string, edits: CellEdit[]) => {
    if (edits.length === 0) return

    const model = getOrCreateOverlayModel(datasetId)
    const meta = getOrCreateOverlayMeta(datasetId)
    const revision = meta.nextRevision

    const patchByRow = new Map<number, Record<string, unknown>>()
    for (const edit of edits) {
      const currentRow = patchByRow.get(edit.row) ?? {}
      patchByRow.set(edit.row, {
        ...currentRow,
        [edit.columnId]: edit.computedValue ?? edit.newValue,
      })
    }

    let loadedBaseRows = 0
    let unloadedOverlayOnlyRows = 0
    let firstLoadedRow: number | null = null
    let firstUnloadedRow: number | null = null
    const stagedRowIndices = Array.from(patchByRow.keys()).sort((a, b) => a - b)
    const loadedRowSample: number[] = []
    const unloadedRowSample: number[] = []

    for (const [rowIndex, patch] of patchByRow.entries()) {
      const rowId = buildDatasetScopedRowId(datasetId, rowIndex)
      const loadedRow = rowDataRef.current.get(rowIndex)
      if (loadedRow) {
        loadedBaseRows += 1
        firstLoadedRow ??= rowIndex
        if (loadedRowSample.length < 8) loadedRowSample.push(rowIndex)
        model.writeBaseRow(rowId, loadedRow)
      } else {
        unloadedOverlayOnlyRows += 1
        firstUnloadedRow ??= rowIndex
        if (unloadedRowSample.length < 8) unloadedRowSample.push(rowIndex)
        model.deleteBaseRow(rowId)
      }
      model.ingestLegacyRowPatch(rowId, {
        patch,
        mutationId,
        revision,
        status: 'pending',
      })
    }

    sharedOverlayMetaByDataset.set(datasetId, {
      ...meta,
      latestMutationId: mutationId,
      activationPending: true,
      nextRevision: revision + 1,
      mutations: new Map(meta.mutations).set(mutationId, {
        revision,
        edits: edits.map((edit) => ({ ...edit })),
      }),
    })
    logPasteDebug('paste_stage_rows_summary', {
      datasetId,
      mutationId,
      editCount: edits.length,
      stagedRows: patchByRow.size,
      minStagedRow: stagedRowIndices[0] ?? null,
      maxStagedRow: stagedRowIndices.at(-1) ?? null,
      loadedBaseRows,
      unloadedOverlayOnlyRows,
      firstLoadedRow,
      firstUnloadedRow,
      loadedRowSample,
      unloadedRowSample,
      rowDataSizeAtStage: rowDataRef.current.size,
      row1023HasBase: rowDataRef.current.has(1023),
      row1024HasBase: rowDataRef.current.has(1024),
    })
  }, [logPasteDebug])

  const reconcileStagedMutationRows = useCallback(
    (datasetId: string, edits?: CellEdit[], options?: { clearAll?: boolean }) => {
      const model = sharedOverlayModelByDataset.get(datasetId)
      const meta = sharedOverlayMetaByDataset.get(datasetId)
      if (!model || !meta) return false
      if (options?.clearAll) {
        clearDatasetOverlayState(datasetId)
        return true
      }
      if (!edits || edits.length === 0) return false

      const columnsByRow = new Map<number, string[]>()
      for (const edit of edits) {
        const currentColumns = columnsByRow.get(edit.row) ?? []
        currentColumns.push(edit.columnId)
        columnsByRow.set(edit.row, currentColumns)
      }

      for (const [rowIndex, columnIds] of columnsByRow.entries()) {
        model.removeOverlayColumns(buildDatasetScopedRowId(datasetId, rowIndex), columnIds)
      }

      if (!model.hasOverlayRows()) {
        clearDatasetOverlayState(datasetId)
      }
      return true
    },
    []
  )

  const refreshStagedMutationRows = useCallback(
    (datasetId: string, mutationId: string, edits: CellEdit[]) => {
      if (edits.length === 0) return false

      const model = sharedOverlayModelByDataset.get(datasetId)
      const meta = sharedOverlayMetaByDataset.get(datasetId)
      const mutation = meta?.mutations.get(mutationId)
      if (!model || !meta || !mutation) return false

      const patchByRow = new Map<number, Record<string, unknown>>()
      for (const edit of edits) {
        const currentRow = patchByRow.get(edit.row) ?? {}
        patchByRow.set(edit.row, {
          ...currentRow,
          [edit.columnId]: edit.computedValue ?? edit.newValue,
        })
      }

      for (const [rowIndex, patch] of patchByRow.entries()) {
        const rowId = buildDatasetScopedRowId(datasetId, rowIndex)
        const currentOverlay = model.getOverlayRow(rowId)
        const nextPatch: Record<string, OverlayCell> = {}
        for (const [columnId, value] of Object.entries(patch)) {
          const currentCell = currentOverlay?.[columnId]
          nextPatch[columnId] = {
            value,
            mutationId,
            revision: mutation.revision,
            status: currentCell?.status ?? 'pending',
          }
        }
        model.writeOverlayPatch(rowId, nextPatch)
      }

      mutation.edits = edits.map((edit) => ({ ...edit }))
      return true
    },
    []
  )

  const applyStagedMutationRows = useCallback(
    (datasetId: string) => {
      const model = sharedOverlayModelByDataset.get(datasetId)
      const stagedRows = collectStagedOverlayRows(model, datasetId)
      if (!stagedRows || stagedRows.size === 0) return false
      const dataset = useDataStore.getState().datasets.find((entry) => entry.id === datasetId)
      const dataRowCount = dataset ? resolveDataRowCount(dataset) : 0

      let clonedMaterializedRows = 0
      let sentinelSparseRows = 0
      let overlayOnlyExistingRows = 0
      let bufferRows = 0
      let firstSentinelSparseRow: number | null = null
      let row1024IsSentinelSparse = false
      const rowDataSizeBefore = rowDataRef.current.size
      let rowDataSizeAfter = rowDataRef.current.size
      const overlayOnlyExistingRowSample: number[] = []
      const bufferRowSample: number[] = []

      updateRowDataRef((prev) => {
        const next = new Map(prev)
        for (const [rowIndex, rowPatch] of stagedRows.entries()) {
          const currentRow = next.get(rowIndex)
          if (currentRow) {
            clonedMaterializedRows += 1
            const mergedRow = cloneRowDataPreservingSentinel(currentRow)
            Object.assign(mergedRow, rowPatch)
            next.set(rowIndex, mergedRow)
            model?.writeBaseRow(buildDatasetScopedRowId(datasetId, rowIndex), mergedRow)
            if (rowIndex === 1024) {
              row1024IsSentinelSparse = isRowDataSentinel(mergedRow)
            }
          } else if (rowIndex < dataRowCount) {
            overlayOnlyExistingRows += 1
            if (overlayOnlyExistingRowSample.length < 8) overlayOnlyExistingRowSample.push(rowIndex)
          } else {
            bufferRows += 1
            if (bufferRowSample.length < 8) bufferRowSample.push(rowIndex)
            const mergedRow = { ...rowPatch }
            next.set(rowIndex, mergedRow)
            model?.writeBaseRow(buildDatasetScopedRowId(datasetId, rowIndex), mergedRow)
          }
        }
        rowDataSizeAfter = next.size
        return next
      })
      logPasteDebug('paste_apply_staged_rows_summary', {
        datasetId,
        stagedRows: stagedRows.size,
        dataRowCount,
        rowDataSizeBefore,
        rowDataSizeAfter,
        clonedMaterializedRows,
        sentinelSparseRows,
        overlayOnlyExistingRows,
        bufferRows,
        overlayOnlyExistingRowSample,
        bufferRowSample,
        firstSentinelSparseRow,
        row1024IsSentinelSparse,
      })
      return true
    },
    [logPasteDebug, resolveDataRowCount, updateRowDataRef]
  )

  const getMutationBlockSyncContext = useCallback(
    (datasetId: string, edits: CellEdit[]) => {
      if (edits.length === 0) return null
      const datasetStillExists = useDataStore
        .getState()
        .datasets.some((dataset) => dataset.id === datasetId)
      if (!datasetStillExists) {
        return null
      }

      const rowBounds = getEditRowBounds(edits)
      if (!rowBounds) return null
      const { minRow: minModelRow, maxRow: maxModelRow } = rowBounds
      const activeDatasetId = currentDatasetIdRef.current
      const isActiveDataset = activeDatasetId === datasetId
      const touched = computeAffectedBlockKeys(datasetId, minModelRow, maxModelRow, BLOCK_SIZE)
      const touchedBlockIndices = new Set<number>()
      for (const key of touched) {
        const blockIndex = Number(key.split(':').pop())
        if (Number.isFinite(blockIndex)) {
          touchedBlockIndices.add(blockIndex)
        }
      }

      return {
        activeDatasetId,
        isActiveDataset,
        minModelRow,
        maxModelRow,
        touched,
        touchedBlockIndices,
      }
    },
    [BLOCK_SIZE]
  )

  const invalidateStaleLoadsForMutation = useCallback(
    (datasetId: string, edits: CellEdit[]) => {
      const context = getMutationBlockSyncContext(datasetId, edits)
      if (!context) {
        logGridDebug('mutation_load_invalidation_skip', {
          reason: 'dataset_missing',
          datasetId,
          edits: edits.length,
          activeDatasetId: currentDatasetIdRef.current,
        })
        return
      }

      for (const blockIndex of context.touchedBlockIndices) {
        pendingBlockLoadsRef.current.delete(blockIndex)
      }

      if (context.isActiveDataset) {
        datasetRevisionRef.current += 1
      } else {
        datasetsNeedingReloadOnActivateRef.current.add(datasetId)
        bumpDatasetActivationReloadVersion()
      }

      logGridDebug('mutation_load_invalidation', {
        datasetId,
        activeDatasetId: context.activeDatasetId,
        edits: edits.length,
        minModelRow: context.minModelRow,
        maxModelRow: context.maxModelRow,
        touchedBlocks: context.touched.length,
      })
    },
    [getMutationBlockSyncContext, logGridDebug]
  )

  const syncPostPasteBlockState = useCallback(
    (transaction: GridTransactionRecord) => {
      const datasetId = transaction.datasetId
      const edits = transaction.edits ?? []
      const context = getMutationBlockSyncContext(datasetId, edits)
      if (!context) {
        logPasteDebug('post_paste_block_sync_skip', {
          reason: 'dataset_missing',
          datasetId,
          edits: edits.length,
          activeDatasetId: currentDatasetIdRef.current,
        })
        return
      }

      let materializedEditRows = 0
      let unmaterializedEditRows = 0
      let firstUnmaterializedEditRow: number | null = null
      const unmaterializedBlockKeys = new Set<string>()
      const seenEditRows = new Set<number>()
      for (const edit of edits) {
        if (seenEditRows.has(edit.row)) continue
        seenEditRows.add(edit.row)
        if (hasMaterializedRowData(edit.row)) {
          materializedEditRows += 1
        } else {
          unmaterializedEditRows += 1
          firstUnmaterializedEditRow ??= edit.row
          unmaterializedBlockKeys.add(`${datasetId}:block:${Math.floor(edit.row / BLOCK_SIZE)}`)
        }
      }

      const dirtyKeys = context.isActiveDataset
        ? Array.from(unmaterializedBlockKeys)
        : context.touched

      for (const key of dirtyKeys) {
        staleLoadedOverlayRecoveryRef.current.delete(key)
        setBlockState(key, 'dirty')
        wantedBlocksRef.current.delete(key)
      }

      invalidateStaleLoadsForMutation(datasetId, edits)

      logPasteDebug('post_paste_block_sync', {
        datasetId,
        activeDatasetId: context.activeDatasetId,
        edits: edits.length,
        minModelRow: context.minModelRow,
        maxModelRow: context.maxModelRow,
        touchedBlocks: context.touched.length,
        dirtyBlocks: dirtyKeys.length,
        dirtyBlockSample: dirtyKeys.slice(0, 12),
        pendingBlockLoadCount: pendingBlockLoadsRef.current.size,
        materializedEditRows,
        unmaterializedEditRows,
        firstUnmaterializedEditRow,
        row1023Materialized: hasMaterializedRowData(1023),
        row1024Materialized: hasMaterializedRowData(1024),
      })
      if (context.touched.length === 0 || !context.isActiveDataset) {
        if (!context.isActiveDataset) {
          logPasteDebug('post_paste_block_sync_deferred', {
            datasetId,
            activeDatasetId: context.activeDatasetId,
            touchedBlocks: context.touched.length,
          })
        }
        return
      }
      const pasteTimingSource =
        transaction.kind === 'paste-values' || transaction.kind === 'paste-transpose'
          ? transaction.kind
          : 'paste'
      startCurrentPasteHydrateTiming(transaction.id, datasetId, pasteTimingSource, dirtyKeys)
      const cellUpdates = buildCellUpdates(edits)
      if (cellUpdates.length > 0) {
        requestGridRefresh({
          reason: 'post-paste-local-authoritative',
          scope: 'cells',
          cellUpdates,
          deferToAnimationFrame: true,
        })
        return
      }
      requestGridRefresh({
        reason: 'post-paste-local-authoritative',
        scope: 'viewport',
      })
    },
    [
      BLOCK_SIZE,
      buildCellUpdates,
      getMutationBlockSyncContext,
      hasMaterializedRowData,
      invalidateStaleLoadsForMutation,
      logPasteDebug,
      requestGridRefresh,
      setBlockState,
      startCurrentPasteHydrateTiming,
    ]
  )

  const ensurePasteDataRowCapacity = useCallback(
    async (capturedDatasetId: string, requiredDataRows: number): Promise<number> => {
      const liveDataset =
        useDataStore.getState().datasets.find((dataset) => dataset.id === capturedDatasetId) ?? null
      if (!liveDataset) {
        logPasteDebug('paste_expand_skip', {
          reason: 'dataset_missing',
          datasetId: capturedDatasetId,
          requiredDataRows,
        })
        return 0
      }

      const currentDataRows = resolveDataRowCount(liveDataset)
      const safeRequiredRows = Math.max(0, requiredDataRows)
      logPasteDebug('paste_expand_preflight', {
        datasetId: capturedDatasetId,
        currentDataRows,
        safeRequiredRows,
      })
      if (safeRequiredRows <= currentDataRows) {
        logPasteDebug('paste_expand_skip', {
          reason: 'capacity_sufficient',
          datasetId: capturedDatasetId,
          currentDataRows,
          safeRequiredRows,
        })
        return currentDataRows
      }

      const rowsToInsert = safeRequiredRows - currentDataRows
      if (rowsToInsert <= 0) {
        return currentDataRows
      }

      const insertAt = currentDataRows
      const expansionStartedAt = Date.now()
      let backendApplied = false
      let storeApplied = false
      let rowOrderApplied = false
      const previousBaseSortedOrder = [...baseSortedOrderRef.current]
      const previousRowOrder = [...rowOrderRef.current]
      try {
        logPasteDebug('paste_row_expand_start', {
          datasetId: capturedDatasetId,
          method: 'append',
          insertAt,
          rowsToInsert,
        })
        logPasteDebug('paste_expand_start', {
          datasetId: capturedDatasetId,
          insertAt,
          rowsToInsert,
        })
        await cacheService.appendRows(capturedDatasetId, rowsToInsert)
        backendApplied = true
        insertRowsAtDataset(capturedDatasetId, insertAt, rowsToInsert)
        storeApplied = true

        if (
          currentDatasetIdRef.current === capturedDatasetId &&
          groupByColumnId === null &&
          !isLazyGrouped
        ) {
          const sourceOrder =
            previousBaseSortedOrder.length > 0 ? previousBaseSortedOrder : previousRowOrder
          if (sourceOrder.length > 0) {
            const nextOrder = sourceOrder
              .filter((modelRow) => modelRow < insertAt)
            for (let offset = 0; offset < rowsToInsert; offset += 1) {
              nextOrder.push(insertAt + offset)
            }
            for (const modelRow of sourceOrder) {
              if (modelRow < insertAt) continue
              nextOrder.push(modelRow + rowsToInsert)
            }
            baseSortedOrderRef.current = nextOrder
            const filteredNext = applyActiveFilter(nextOrder)
            rowOrderRef.current = filteredNext
            setRowOrder(filteredNext)
            rowOrderApplied = true
            logPasteDebug('paste_expand_row_order_synced', {
              datasetId: capturedDatasetId,
              rowsToInsert,
              rowOrderLength: filteredNext.length,
            })
          }
        }
        if (currentDatasetIdRef.current !== capturedDatasetId) {
          datasetsNeedingReloadOnActivateRef.current.add(capturedDatasetId)
          bumpDatasetActivationReloadVersion()
        }

        logPasteDebug('paste_expand_done', {
          datasetId: capturedDatasetId,
          insertAt,
          rowsToInsert,
          finalDataRows: currentDataRows + rowsToInsert,
        })
        logPasteDebug('paste_row_expand_done', {
          datasetId: capturedDatasetId,
          method: 'append',
          insertAt,
          rowsToInsert,
          durationMs: Date.now() - expansionStartedAt,
          finalDataRows: currentDataRows + rowsToInsert,
        })
      } catch (error) {
        logPasteDebug('paste_expand_error', {
          datasetId: capturedDatasetId,
          insertAt,
          rowsToInsert,
          backendApplied,
          storeApplied,
          error: error instanceof Error ? error.message : String(error),
        })
        if (backendApplied) {
          try {
            await cacheService.removeRowsFromEnd(capturedDatasetId, rowsToInsert)
          } catch (rollbackError) {
            console.error('Failed to rollback pasted row expansion in backend:', rollbackError)
          }
        }
        if (storeApplied) {
          for (let offset = rowsToInsert - 1; offset >= 0; offset -= 1) {
            const rowIndex = insertAt + offset
            try {
              removeRowAtDataset(capturedDatasetId, rowIndex)
            } catch (rollbackError) {
              console.error('Failed to rollback pasted row expansion in store:', rollbackError)
            }
          }
        }
        if (rowOrderApplied) {
          baseSortedOrderRef.current = previousBaseSortedOrder
          rowOrderRef.current = previousRowOrder
          setRowOrder(previousRowOrder)
        }
        throw error
      }

      return currentDataRows + rowsToInsert
    },
    [
      applyActiveFilter,
      groupByColumnId,
      insertRowsAtDataset,
      isLazyGrouped,
      logPasteDebug,
      removeRowAtDataset,
      resolveDataRowCount,
    ]
  )

  const applyStructuralRowsForTransaction = useCallback(
    async (transaction: GridTransactionRecord) => {
      const insertedRows = transaction.structural?.insertedRows
      const removedRows = transaction.structural?.removedRows
      if (insertedRows && insertedRows.length > 0) {
        const liveDataset = useDataStore.getState().datasets.find((dataset) => dataset.id === transaction.datasetId)
        const liveDataRows = liveDataset ? resolveDataRowCount(liveDataset) : 0
        const editRowBounds = getEditRowBounds(transaction.edits ?? [])
        const editRequiredDataRows = editRowBounds ? editRowBounds.maxRow + 1 : 0
        const structuralRequiredDataRows = Math.max(
          liveDataRows,
          ...insertedRows.map((segment) => Math.max(0, segment.start) + Math.max(0, segment.count))
        )
        const requiredDataRows =
          editRequiredDataRows > 0
            ? Math.max(liveDataRows, editRequiredDataRows)
            : structuralRequiredDataRows
        if (requiredDataRows > 0) {
          await ensurePasteDataRowCapacity(transaction.datasetId, requiredDataRows)
        }
      }

      if (!removedRows || removedRows.length === 0) {
        return
      }

      resetStreamingStateForStructuralEdit()
      for (const segment of [...removedRows].sort((a, b) => b.start - a.start)) {
        for (let offset = segment.count - 1; offset >= 0; offset -= 1) {
          const rowIndex = segment.start + offset
          await cacheService.removeRowAt(transaction.datasetId, rowIndex)
          removeRowAtDataset(transaction.datasetId, rowIndex)
          updateRowDataRef(prev => {
            const next = new Map<number, Record<string, unknown>>()
            for (const [row, rowData] of prev.entries()) {
              if (row === rowIndex) continue
              next.set(row > rowIndex ? row - 1 : row, rowData)
            }
            return next
          })
          const nextOrder = rowOrderRef.current
            .filter(row => row !== rowIndex)
            .map(row => (row > rowIndex ? row - 1 : row))
          baseSortedOrderRef.current = nextOrder
          rowOrderRef.current = nextOrder
          setRowOrder(nextOrder)
        }
      }
    },
    [
      ensurePasteDataRowCapacity,
      removeRowAtDataset,
      resetStreamingStateForStructuralEdit,
      resolveDataRowCount,
      updateRowDataRef,
    ]
  )

  const applyColumnRenamesForTransaction = useCallback(
    async (transaction: GridTransactionRecord): Promise<boolean> => {
      const columnRenames = transaction.columnRenames ?? []
      if (columnRenames.length === 0) return true

      const dataset = useDataStore.getState().datasets.find((entry) => entry.id === transaction.datasetId)
      if (!dataset) return false

      const renameById = new Map(columnRenames.map((rename) => [rename.columnId, rename.newName]))
      let changed = false
      const updatedColumns = dataset.columns.map((column) => {
        const nextName = renameById.get(String(column.id))
        if (nextName === undefined || nextName === column.name) {
          return column
        }
        changed = true
        return { ...column, name: nextName }
      })

      if (!changed) return true

      updateDataset(transaction.datasetId, { columns: updatedColumns })
      try {
        await tauriApi.updateDatasetMetadata(transaction.datasetId, updatedColumns)
      } catch (error) {
        updateDataset(transaction.datasetId, { columns: dataset.columns })
        console.error('Failed to sync grid transaction column rename to backend:', error)
        return false
      }

      useAppStore.getState().setProjectDirty(true)
      logPasteDebug('paste_header_rename_done', {
        datasetId: transaction.datasetId,
        transactionId: transaction.id,
        renameCount: columnRenames.length,
      })
      return true
    },
    [logPasteDebug, tauriApi, updateDataset]
  )

  const rollbackRejectedGridTransaction = useCallback(
    async (
      transaction: GridTransactionRecord,
      rollbackSnapshot?: {
        dataRowCount?: number
        projectDirty: boolean
        projectDirtyRevision: number
      }
    ): Promise<boolean> => {
      const rollbackTransaction = createUndoGridTransaction(transaction)
      const rollbackEdits = rollbackTransaction.edits ?? []

      const columnRenamesRolledBack = await applyColumnRenamesForTransaction(rollbackTransaction)
      if (!columnRenamesRolledBack) {
        toast.error('Failed to roll back column renames')
        return false
      }

      if (rollbackEdits.length > 0 || rollbackTransaction.structural) {
        reconcileStagedMutationRows(transaction.datasetId, undefined, { clearAll: true })
      }

      if (rollbackTransaction.structural) {
        await applyStructuralRowsForTransaction(rollbackTransaction)
      }

      if (rollbackEdits.length > 0 && editExecutor) {
        await editExecutor.execute(rollbackEdits, 'undo', {
          skipUndoRegistration: true,
          skipBackendSync: true,
          skipProjectDirty: true,
        })
      }

      if (rollbackSnapshot) {
        useDataStore.getState().updateDataset(transaction.datasetId, {
          dataRowCount: rollbackSnapshot.dataRowCount,
        })
        const appState = useAppStore.getState()
        if (
          rollbackSnapshot.projectDirty === false &&
          appState.projectDirty === true &&
          appState.projectDirtyRevision === rollbackSnapshot.projectDirtyRevision + 1
        ) {
          appState.setProjectDirty(false)
        }
      }

      const rollbackCellUpdates = buildCellUpdates(rollbackEdits)
      if (rollbackCellUpdates.length > 0) {
        requestGridRefresh({
          reason: 'mutation-backend-sync-rollback',
          scope: 'cells',
          cellUpdates: rollbackCellUpdates,
          deferToAnimationFrame: true,
        })
      } else {
        requestGridRefresh({
          reason: 'mutation-backend-sync-rollback',
          scope: 'viewport',
        })
      }
      return true
    },
    [
      applyColumnRenamesForTransaction,
      applyStructuralRowsForTransaction,
      buildCellUpdates,
      editExecutor,
      reconcileStagedMutationRows,
      requestGridRefresh,
    ]
  )

  const executePlannedGridTransaction = useCallback(
    async (transaction: GridTransactionRecord) => {
      const edits = transaction.edits ?? []
      const activeEditExecutor = editExecutor
      if (!activeEditExecutor && edits.length > 0) return
      transaction.persistAccepted = false
      const shouldCheckPasteContext =
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose'
      const isTransactionCopyContextStale = () => {
        if (!shouldCheckPasteContext) return false
        if (
          transaction.selectionRevision !== undefined &&
          transaction.selectionRevision !== selectionRevisionRef.current
        ) {
          transaction.rejectionReason = 'stale_paste_context'
          logPasteDebug('paste_context_inactive', {
            reason: 'transaction_selection_changed',
            transactionId: transaction.id,
            selectionRevision: transaction.selectionRevision,
            activeSelectionRevision: selectionRevisionRef.current,
          })
          return true
        }
        const copyOpId = transaction.clipboardContext?.copyOpId
        if (!copyOpId) return false
        const activeCopyOpId = copyContextRef.current?.copyOpId ?? null
        if (activeCopyOpId === copyOpId) return false
        transaction.rejectionReason = 'stale_paste_context'
        logPasteDebug('paste_context_inactive', {
          reason: 'transaction_copy_op_mismatch',
          transactionId: transaction.id,
          copyOpId,
          activeCopyOpId,
        })
        return true
      }
      const rollbackSnapshot = {
        dataRowCount: useDataStore
          .getState()
          .datasets.find((entry) => entry.id === transaction.datasetId)?.dataRowCount,
        projectDirty: useAppStore.getState().projectDirty,
        projectDirtyRevision: useAppStore.getState().projectDirtyRevision,
      }

      if (isTransactionCopyContextStale()) {
        return
      }
      await applyStructuralRowsForTransaction(transaction)
      if (isTransactionCopyContextStale()) {
        await rollbackRejectedGridTransaction({ ...transaction, edits: undefined }, rollbackSnapshot)
        return
      }
      const columnRenamesApplied = await applyColumnRenamesForTransaction(transaction)
      if (!columnRenamesApplied) {
        const rolledBack = await rollbackRejectedGridTransaction({ ...transaction, edits: undefined }, rollbackSnapshot)
        if (!rolledBack) {
          logGridDebug('mutation_rollback_failed', {
            datasetId: transaction.datasetId,
            kind: transaction.kind,
            transactionId: transaction.id,
            phase: 'column-renames',
          })
        }
        return
      }
      if (isTransactionCopyContextStale()) {
        await rollbackRejectedGridTransaction({ ...transaction, edits: undefined }, rollbackSnapshot)
        return
      }

      const editSourceByKind: Partial<Record<
        GridMutationKind,
        'type' | 'fill' | 'paste' | 'cut' | 'delete' | 'undo' | 'redo' | 'paste-transpose'
      >> = {
        type: 'type',
        fill: 'fill',
        paste: 'paste',
        'paste-values': 'paste',
        'paste-transpose': 'paste-transpose',
        cut: 'cut',
        delete: 'delete',
        undo: 'undo',
        redo: 'redo',
      }
      const source = editSourceByKind[transaction.kind]
      const skipBackendUndoRegistration =
        transaction.kind === 'type' ||
        transaction.kind === 'fill' ||
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose' ||
        transaction.kind === 'cut' ||
        transaction.kind === 'delete'

      if (transaction.backendPasteBlock) {
        const backendPasteBlock = transaction.backendPasteBlock
        if (backendPasteBlock.rows.length === 0 || backendPasteBlock.columnIds.length === 0) {
          transaction.persistAccepted = true
          return
        }

        try {
          const backendResult = await cacheService.applyPasteBlock(transaction.datasetId, {
            rows: backendPasteBlock.rows,
            columnIds: backendPasteBlock.columnIds,
            values: backendPasteBlock.values,
          })

          if (backendResult.editedCells <= 0) {
            transaction.persistAccepted = false
            return
          }
          const backendUndoShapeValid = isBackendPasteUndoShapeValid(
            backendPasteBlock.rows,
            backendPasteBlock.columnIds,
            backendResult.oldValues
          )
          if (backendUndoShapeValid) {
            transaction.persistAccepted = true
            transaction.backendPasteBlock = {
              ...backendPasteBlock,
              undoValues: backendResult.oldValues.map((rowValues) => [...rowValues]),
            }
          } else {
            transaction.persistAccepted = false
            toast.error(BACKEND_PASTE_UNDO_SHAPE_ERROR, {
              description: 'Reload the dataset before relying on undo for this paste.',
            })
          }

          const cellUpdates = patchMaterializedRowsForBackendPaste(
            backendPasteBlock.rows,
            backendPasteBlock.columnIds,
            backendPasteBlock.values
          )
          if (cellUpdates.length > 0) {
            scheduleCellUpdates(cellUpdates)
          }
          showBackendPasteHighlights(backendPasteBlock.rows, backendPasteBlock.columnIds)

          markColdBackendPasteBlocksDirty(transaction.datasetId, backendPasteBlock.rows)
          const visibleColdRows = getVisibleColdBackendPasteRows(
            backendPasteBlock.rows,
            backendResult.rowStart,
            backendResult.rowEndExclusive
          )
          const { blockKeys: hydrateBlockKeys } = getBackendPasteBlockKeys(
            transaction.datasetId,
            visibleColdRows
          )
          startCurrentPasteHydrateTiming(
            transaction.id,
            transaction.datasetId,
            transaction.kind === 'paste-values' || transaction.kind === 'paste-transpose'
              ? transaction.kind
              : 'paste',
            hydrateBlockKeys
          )
          try {
            await hydrateBackendPasteRows(
              transaction.datasetId,
              visibleColdRows,
              backendPasteBlock.columnIds
            )
          } catch (error) {
            logGridDebug('backend_paste_hydrate_failed', {
              datasetId: transaction.datasetId,
              kind: transaction.kind,
              transactionId: transaction.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }

          requestGridRefresh({
            reason: `backend-paste-block-${transaction.kind}`,
            scope: 'viewport',
          })
        } catch (error) {
          transaction.persistAccepted = false
          logGridDebug('mutation_apply_failed', {
            datasetId: transaction.datasetId,
            kind: transaction.kind,
            transactionId: transaction.id,
            error: error instanceof Error ? error.message : String(error),
          })
          const rolledBack = await rollbackRejectedGridTransaction(
            { ...transaction, backendPasteBlock: undefined },
            rollbackSnapshot
          )
          if (!rolledBack) {
            logGridDebug('mutation_rollback_failed', {
              datasetId: transaction.datasetId,
              kind: transaction.kind,
              transactionId: transaction.id,
              phase: 'backend-paste-block',
            })
          }
          toast.error('Failed to apply grid edit. Please try again.')
        } finally {
          syncFormulasToStore()
        }
        return
      }

      if (edits.length > 0) {
        if (!activeEditExecutor || !source) {
          if (activeEditExecutor && !source) {
            console.error(`No edit source is mapped for grid mutation kind "${transaction.kind}"`)
            toast.error('This edit could not be applied.')
          }
          const rolledBack = await rollbackRejectedGridTransaction({ ...transaction, edits: undefined }, rollbackSnapshot)
          if (!rolledBack) {
            logGridDebug('mutation_rollback_failed', {
              datasetId: transaction.datasetId,
              kind: transaction.kind,
              transactionId: transaction.id,
              phase: !activeEditExecutor ? 'missing-edit-executor' : 'missing-edit-source',
            })
          }
          return
        }
        const shouldStageRows = true
        const isPasteTransaction =
          transaction.kind === 'paste' ||
          transaction.kind === 'paste-values' ||
          transaction.kind === 'paste-transpose'
        if (shouldStageRows) {
          stageMutationRows(transaction.datasetId, transaction.id, edits)
          if (isPasteTransaction && currentDatasetIdRef.current === transaction.datasetId) {
            const stagedCellUpdates = buildCellUpdates(edits)
            if (stagedCellUpdates.length > 0) {
              requestGridRefresh({
                reason: 'pre-execute-staged-paste',
                scope: 'cells',
                cellUpdates: stagedCellUpdates,
                deferToAnimationFrame: true,
              })
            } else {
              requestGridRefresh({
                reason: 'pre-execute-staged-paste',
                scope: 'viewport',
              })
            }
          }
        }
        let executionResult: Awaited<ReturnType<typeof activeEditExecutor.execute>>
        const shouldChunkPasteBackendSync =
          isPasteTransaction && edits.length > PASTE_BACKEND_SYNC_CHUNK_SIZE
        const pasteDataRowCount = isPasteTransaction
          ? (() => {
              const dataset = useDataStore.getState().datasets.find((entry) => entry.id === transaction.datasetId)
              return dataset ? resolveDataRowCount(dataset) : 0
            })()
          : 0
        try {
          const currentTiming = currentPasteTimingByTransactionRef.current.get(transaction.id)
          if (currentTiming) {
            currentTiming.executeStartedAt = Date.now()
            logPasteDebug('paste_current_execute_start', {
              datasetId: transaction.datasetId,
              source: transaction.kind,
              transactionId: transaction.id,
              editCount: currentTiming.editCount,
              rowCount: currentTiming.rowCount,
              columnCount: currentTiming.columnCount,
              oldValueLookupCount: currentTiming.oldValueLookupCount,
            })
          }
          executionResult = await activeEditExecutor.execute(edits, source, {
            skipUndoRegistration: skipBackendUndoRegistration,
            skipDataStoreUpdate: isPasteTransaction,
            backendSyncChunkSize: shouldChunkPasteBackendSync
              ? PASTE_BACKEND_SYNC_CHUNK_SIZE
              : undefined,
            flushBackendChunks: shouldChunkPasteBackendSync,
            shouldSkipLocalRowDataWrite: isPasteTransaction
              ? (row) => row < pasteDataRowCount && !hasMaterializedRowData(row)
              : undefined,
          })
        } catch (error) {
          transaction.persistAccepted = false
          logGridDebug('mutation_apply_failed', {
            datasetId: transaction.datasetId,
            kind: transaction.kind,
            transactionId: transaction.id,
            error: error instanceof Error ? error.message : String(error),
          })
          const rolledBack = await rollbackRejectedGridTransaction(transaction, rollbackSnapshot)
          if (!rolledBack) {
            logGridDebug('mutation_rollback_failed', {
              datasetId: transaction.datasetId,
              kind: transaction.kind,
              transactionId: transaction.id,
              phase: 'apply-local-exception',
            })
          }
          toast.error('Failed to apply grid edit. Please try again.')
          return
        }
        if (shouldStageRows) {
          refreshStagedMutationRows(transaction.datasetId, transaction.id, edits)
        }
        if (executionResult?.backendSyncSucceeded === false) {
          logGridDebug('mutation_backend_sync_failed', {
            datasetId: transaction.datasetId,
            kind: transaction.kind,
            transactionId: transaction.id,
          })
          const rolledBack = await rollbackRejectedGridTransaction(transaction, rollbackSnapshot)
          if (!rolledBack) {
            logGridDebug('mutation_rollback_failed', {
              datasetId: transaction.datasetId,
              kind: transaction.kind,
              transactionId: transaction.id,
              phase: 'backend-sync',
            })
            toast.error('Dataset sync failed and local rollback could not complete. Reload the dataset before editing.')
            return
          }
          failedGridSyncTransactionRef.current = transaction
          setGridSyncFailureNotice({
            datasetId: transaction.datasetId,
            transactionId: transaction.id,
            message: 'The grid was rolled back locally because backend sync failed.',
            retrying: false,
          })
          return
        }
        if (isPasteTransaction) {
          // Paste edit building can yield in chunks, but the data-store write must
          // stay once-per-paste; per-chunk writes reintroduce repeated dataCache
          // copies and visible partial state for one user gesture.
          activeEditExecutor.applyDataStoreUpdate(edits)
        }
        transaction.persistAccepted = true
        if (shouldStageRows && currentDatasetIdRef.current === transaction.datasetId) {
          if (isPasteTransaction) {
            applyStagedMutationRows(transaction.datasetId)
          } else {
            const shouldWaitForBackendConvergence =
              transaction.kind === 'cut' ||
              transaction.kind === 'delete' ||
              transaction.kind === 'undo' ||
              transaction.kind === 'redo'
            confirmOverlayMutation(transaction.datasetId, transaction.id, {
              clearConvergedNow: !shouldWaitForBackendConvergence,
            })
          }
        }

        const cellUpdates = buildCellUpdates(edits)
        if (cellUpdates.length > 0) {
          requestGridRefresh({
            reason: `mutation-${transaction.kind}`,
            scope: 'cells',
            cellUpdates,
            deferToAnimationFrame: true,
          })
        } else {
          requestGridRefresh({
            reason: `mutation-${transaction.kind}-fallback`,
            scope: 'viewport',
          })
        }
        const currentTiming = currentPasteTimingByTransactionRef.current.get(transaction.id)
        if (currentTiming?.executeStartedAt !== undefined) {
          currentTiming.executeDurationMs = Date.now() - currentTiming.executeStartedAt
          logPasteDebug('paste_current_execute_done', {
            datasetId: transaction.datasetId,
            source: transaction.kind,
            transactionId: transaction.id,
            editCount: currentTiming.editCount,
            rowCount: currentTiming.rowCount,
            columnCount: currentTiming.columnCount,
            oldValueLookupCount: currentTiming.oldValueLookupCount,
            executeDurationMs: currentTiming.executeDurationMs,
          })
        }
      }

      if (
        edits.length === 0 &&
        ((transaction.columnRenames?.length ?? 0) > 0 || Boolean(transaction.structural))
      ) {
        transaction.persistAccepted = true
      }

      syncFormulasToStore()

      if (
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose'
      ) {
        requestPostPasteOverlayFlush(
          transaction.datasetId,
          transaction.persistSource ?? transaction.kind,
          transaction.id
        )
      }
    },
    [
      applyStructuralRowsForTransaction,
      applyColumnRenamesForTransaction,
      rollbackRejectedGridTransaction,
      buildCellUpdates,
      editExecutor,
      ensureRangeLoaded,
      getBackendPasteBlockKeys,
      getVisibleColdBackendPasteRows,
      hydrateBackendPasteRows,
      logGridDebug,
      logPasteDebug,
      markColdBackendPasteBlocksDirty,
      patchMaterializedRowsForBackendPaste,
      showBackendPasteHighlights,
      applyStagedMutationRows,
      confirmOverlayMutation,
      requestPostPasteOverlayFlush,
      refreshStagedMutationRows,
      resolveDataRowCount,
      setBlockState,
      stageMutationRows,
      startCurrentPasteHydrateTiming,
      syncFormulasToStore,
      syncPostPasteBlockState,
      hasMaterializedRowData,
      requestGridRefresh,
    ]
  )

  // Paste transpose from clipboard (Ctrl+T) - swaps rows ↔ columns
  const pasteTransposeFromClipboard = useCallback(async (preferContextTarget: boolean = false) => {
    if (blockSchemaChangeStagingMutation('Paste')) {
      return
    }
    const currentSelection = gridSelectionRef.current.current
    if (!currentDataset || !currentSelection || !editExecutor) {
      console.warn('No selection available for paste transpose')
      return
    }
    if (!tryEnterPasteReadGate('paste-transpose')) {
      return
    }
    let readGateHeld = true
    try {
    const capturedDatasetId = currentDataset.id
    const capturedFamilyId = useAppStore.getState().activeFamilyId
    const pasteOpId = Math.random().toString(36).slice(2, 8)
    const { width: _ptw, height: _pth } = currentSelection.range
    logTelemetry('[paste:start]', {
      opId: pasteOpId,
      source: 'paste-transpose',
      capturedDatasetId,
      capturedFamilyId,
      activeFamilyId: useAppStore.getState().activeFamilyId,
      activeDatasetId: currentDataset.id,
      selectionRows: _pth,
      selectionCols: _ptw,
    })

    const pasteStart = resolvePasteStart(preferContextTarget)
    if (!pasteStart) {
      return
    }
    const { startCol, startViewRow } = pasteStart
    const copyContextAtPasteStart = copyContextRef.current
    const pasteSelectionRevision = selectionRevisionRef.current

    // Guard: virtual "+" add-column button is not a valid paste anchor.
    if (startCol >= getEditableColumns(columns).length) {
      toast.warning('Cannot paste from the "+" column. Select a data cell first.')
      return
    }

    // Read clipboard text
    let clipboardText: string
    try {
      clipboardText = await clipboard.read()
    } catch (error) {
      console.error('Failed to read clipboard contents:', error)
      return
    }
    if (currentDatasetIdRef.current !== capturedDatasetId) {
      logPasteDebug('paste_abort', {
        reason: 'stale_dataset_post_read',
        datasetId: capturedDatasetId,
      })
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
    const pasteContext = beginPasteContext(
      capturedDatasetId,
      startViewRow,
      startCol,
      clipboardText,
      copyContextAtPasteStart,
      pasteSelectionRevision
    )
    releasePasteReadGate()
    readGateHeld = false
    try {
      await runVisualPasteJob('paste-transpose', async (progress) => {
      if (!isPasteContextActive(pasteContext)) {
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

      const availableDataRows = resolveDataRowCount(currentDataset)
      if (!isPasteContextActive(pasteContext)) {
        return
      }
      const requiredDataRows = computeRequiredDataRowsForPaste(
        startViewRow,
        normalizedTransposedData.length,
        viewToModel
      )
      const insertedRows = planInsertedRowsForPaste(availableDataRows, requiredDataRows)
      const buildResult = await buildPasteEditsInChunks({
        startCol,
        startViewRow,
        parsedData: normalizedTransposedData,
        columns,
        viewToModel,
        getOldValue: getCellRawValueForUndo,
        isWritableColumn: (columnId) => columnId !== ADD_COLUMN_ID,
        chunkRows: PASTE_BUILD_CHUNK_ROWS,
        onChunkProgress: reportPasteBuildProgress(progress),
        shouldContinue: () =>
          currentDatasetIdRef.current === capturedDatasetId &&
          isPasteContextActive(pasteContext),
        coerceValue: (value, columnId) =>
          coerceEditValue(
            value,
            columnMetadataMap.get(columnId)?.type,
            (s) => formulaService?.isFormula(s) ?? false
          ),
      })
      if (buildResult.aborted) {
        return
      }
      progress?.update({
        stage: 'Applying paste...',
        indeterminate: true,
      })
      const transaction: GridTransactionRecord = {
        id: pasteContext.pasteOpId,
        datasetId: capturedDatasetId,
        kind: 'paste-transpose',
        edits: buildResult.edits,
        structural: insertedRows ? { insertedRows } : undefined,
        clipboardContext: clipboardContextFromPasteOperation(pasteContext),
      }
      transaction.selectionRevision = pasteContext.selectionRevision

      if ((transaction.edits?.length ?? 0) === 0) {
        return
      }
      if (rejectInvalidTypedPasteEdits(transaction.edits ?? [])) {
        return
      }
      if (!isPasteContextActive(pasteContext)) {
        return
      }

      logPasteDebug('paste_execute_start', {
        pasteOpId: pasteContext.pasteOpId,
        datasetId: capturedDatasetId,
        edits: transaction.edits?.length ?? 0,
        source: 'paste-transpose',
      })
      const gridMutationCoordinator = gridMutationCoordinatorRef.current
      if (!gridMutationCoordinator) {
        return
      }
      try {
        await gridMutationCoordinator.applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })
      } catch (error) {
        console.error('Failed to apply transpose paste edits:', error)
        logPasteDebug('paste_abort', {
          reason: 'execute_failed',
          pasteOpId: pasteContext.pasteOpId,
          datasetId: capturedDatasetId,
          source: 'paste-transpose',
          error: error instanceof Error ? error.message : String(error),
        })
        toast.error('Failed to paste data')
        return
      }
      logPasteDebug('paste_execute_done', {
        pasteOpId: pasteContext.pasteOpId,
        datasetId: capturedDatasetId,
        edits: transaction.edits?.length ?? 0,
        source: 'paste-transpose',
      })
      if (convertedSheetReferences) {
        toast.info('Converted external sheet references to active-grid references.')
      }
      toast.success('Pasted transposed data')
      })
    } finally {
      endPasteContext(pasteContext)
    }
    } finally {
      if (readGateHeld) {
        releasePasteReadGate()
      }
    }
  }, [
    beginPasteContext,
    blockSchemaChangeStagingMutation,
    columns,
    currentDataset,
    editExecutor,
    endPasteContext,
    getCellRawValueForUndo,
    isPasteContextActive,
    viewToModel,
    groupByColumnId,
    formulaService,
    rejectInvalidTypedPasteCells,
    resolvePasteStart,
    normalizePastedFormulaReferences,
    rejectInvalidTypedPasteEdits,
    logPasteDebug,
    reportPasteBuildProgress,
    releasePasteReadGate,
    runVisualPasteJob,
    tryEnterPasteReadGate,
    resolveDataRowCount,
  ])

  useEffect(() => {
    gridMutationPlanRef.current = async (input) =>
      input.transaction ?? {
        id: input.id,
        datasetId: input.datasetId,
        kind: input.kind,
      }
    gridMutationApplyLocalRef.current = async (transaction) => {
      await executePlannedGridTransaction(transaction)
    }
    gridMutationEnqueuePersistRef.current = async () => {}
    gridMutationFinalizeUiRef.current = async (transaction) => {
      if (transaction.persistAccepted !== true) {
        return
      }
      if (
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose'
      ) {
        logPasteDebug('paste_finalize_ui_start', {
          datasetId: transaction.datasetId,
          transactionId: transaction.id,
          source: transaction.kind,
        })
      }
      if (
        transaction.kind === 'type' ||
        transaction.kind === 'fill' ||
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose' ||
        transaction.kind === 'cut' ||
        transaction.kind === 'delete'
      ) {
        const undoTransaction = applyLargePasteUndoPolicy(transaction)
        await undoService.recordGridTransaction(transaction.datasetId, undoTransaction)
        if (undoTransaction.largePasteUndoPolicy) {
          toast.info('Large paste undo will clear the pasted range instead of restoring previous values.')
        }
      }
      if (
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose'
      ) {
        syncPostPasteBlockState(transaction)
      } else if (
        transaction.kind === 'cut' ||
        transaction.kind === 'delete' ||
        transaction.kind === 'undo' ||
        transaction.kind === 'redo'
      ) {
        invalidateStaleLoadsForMutation(transaction.datasetId, transaction.edits ?? [])
      }
      if (
        transaction.kind === 'paste' ||
        transaction.kind === 'paste-values' ||
        transaction.kind === 'paste-transpose'
      ) {
        logPasteDebug('paste_finalize_ui_done', {
          datasetId: transaction.datasetId,
          transactionId: transaction.id,
          source: transaction.kind,
        })
      }
    }
  }, [executePlannedGridTransaction, invalidateStaleLoadsForMutation, syncPostPasteBlockState])

  if (gridMutationCoordinatorRef.current === null) {
    gridMutationCoordinatorRef.current = createGridMutationCoordinator({
      plan: (input) => gridMutationPlanRef.current(input),
      applyLocal: (transaction) => gridMutationApplyLocalRef.current(transaction),
      enqueuePersist: (transaction) => gridMutationEnqueuePersistRef.current(transaction),
      finalizeUI: (transaction) => gridMutationFinalizeUiRef.current(transaction),
    }, sharedGridMutationQueueStore)
  }

  // Paste from clipboard - uses EditExecutor for unified edit pipeline
  const pasteFromClipboard = useCallback(async (preferContextTarget: boolean = false) => {
    if (blockSchemaChangeStagingMutation('Paste')) {
      return
    }
    if (!currentDataset) {
      console.warn('No selection available for paste')
      return
    }
    const headerPasteStartColAtInvocation = resolveHeaderPasteStartCol(preferContextTarget)
    const hasSelectionForPaste =
      !!gridSelectionRef.current.current ||
      headerPasteStartColAtInvocation !== undefined
    if (!hasSelectionForPaste) {
      console.warn('No selection available for paste')
      return
    }
    if (!editExecutor && headerPasteStartColAtInvocation === undefined) {
      console.warn('No selection available for paste')
      return
    }
    if (!tryEnterPasteReadGate('paste')) {
      return
    }

    let readGateHeld = true
    try {
      const capturedDatasetId = currentDataset.id
      const capturedFamilyId = useAppStore.getState().activeFamilyId
      const pasteOpId = Math.random().toString(36).slice(2, 8)
      sparseOverlayDebugSeenRef.current.clear()
      const selectedRange = gridSelectionRef.current.current?.range
      logTelemetry('[paste:start]', {
        opId: pasteOpId,
        source: 'paste',
        capturedDatasetId,
        capturedFamilyId,
        activeFamilyId: useAppStore.getState().activeFamilyId,
        activeDatasetId: currentDataset.id,
        selectionRows: selectedRange?.height ?? 0,
        selectionCols: selectedRange?.width ?? 0,
      })

      const copyContextAtPasteStart = copyContextRef.current
      const pasteSelectionRevision = selectionRevisionRef.current
      let clipboardText: string
      try {
        clipboardText = await clipboard.read()
      } catch (error) {
        console.error('Failed to read clipboard contents:', error)
        return
      }
      logPasteDebug('paste_clipboard_read_done', {
        datasetId: capturedDatasetId,
        clipboardLength: clipboardText.length,
        source: 'paste',
      })
      if (currentDatasetIdRef.current !== capturedDatasetId) {
        logTelemetry('[paste:abort]', { opId: pasteOpId, reason: 'stale-dataset-post-read' })
        return
      }

      if (!clipboardText) {
        return
      }

      const headerPasteStartCol = headerPasteStartColAtInvocation
      const copiedColumnHeadersForHeaderPaste =
        copyContextAtPasteStart?.includesColumnHeaders === true &&
        copyContextAtPasteStart.copiedColumnHeaders?.length
          ? copyContextAtPasteStart.copiedColumnHeaders
          : null
      const isInternalColumnHeaderCopy =
        copiedColumnHeadersForHeaderPaste !== null &&
        clipboardText === copyContextAtPasteStart?.clipboardText
      const shouldPasteColumnHeaders =
        isInternalColumnHeaderCopy &&
        headerPasteStartCol !== undefined
      const shouldSkipCopiedColumnHeaders = isInternalColumnHeaderCopy
      const pasteStart = shouldPasteColumnHeaders
        ? { startCol: headerPasteStartCol, startViewRow: 0 }
        : resolvePasteStart(preferContextTarget)
      if (!pasteStart) {
        return
      }
      const { startCol, startViewRow } = pasteStart

      if (startCol >= getEditableColumns(columns).length) {
        toast.warning('Cannot paste from the "+" column. Select a data cell first.')
        return
      }

      const pasteContext = beginPasteContext(
        capturedDatasetId,
        startViewRow,
        startCol,
        clipboardText,
        copyContextAtPasteStart,
        pasteSelectionRevision
      )
      releasePasteReadGate()
      readGateHeld = false

      try {
        await runVisualPasteJob('paste', async (progress) => {
        if (!isPasteContextActive(pasteContext)) {
          return
        }

        const parsedClipboardData = parseClipboardText(clipboardText)
        const rawParsedData = shouldSkipCopiedColumnHeaders
          ? parsedClipboardData.slice(1)
          : parsedClipboardData
        const parsedData = expandClipboardForSelection(
          rawParsedData,
          shouldPasteColumnHeaders ? null : selectedRange ?? null
        )
        if (isInternalColumnHeaderCopy || parsedClipboardData.length > 1000) {
          logPasteDebug('paste_header_route_context', {
            datasetId: capturedDatasetId,
            isInternalColumnHeaderCopy,
            shouldPasteColumnHeaders,
            shouldSkipCopiedColumnHeaders,
            copiedHeaderCount: copiedColumnHeadersForHeaderPaste?.length ?? 0,
            parsedClipboardRows: parsedClipboardData.length,
            parsedDataRows: parsedData.length,
            startCol,
            startViewRow,
            row1023Materialized: hasMaterializedRowData(1023),
            row1024Materialized: hasMaterializedRowData(1024),
          })
        }
        if (shouldPasteColumnHeaders && parsedData.length > 0 && isViewTransformActive({
          sortModelLength: sortModel.length,
          enableExcelViewFilter: enableExcelViewFilter ?? false,
          hasViewFilterConfig: viewFilterConfig !== null,
          groupByColumnId,
        })) {
          toast.warning('Cannot paste header-selected data while a filter, sort, or group is active. Clear them first.')
          return
        }
        if (parsedData.length === 0) {
          if (shouldPasteColumnHeaders) {
            const columnRenames = resolveColumnRenamesFromHeaderPaste(
              capturedDatasetId,
              startCol,
              copiedColumnHeadersForHeaderPaste ?? []
            )
            if (!columnRenames || columnRenames.length === 0) {
              return
            }
            const gridMutationCoordinator = gridMutationCoordinatorRef.current
            if (!gridMutationCoordinator) {
              return
            }
            const transaction: GridTransactionRecord = {
              id: nextGridOperationId('paste'),
              datasetId: capturedDatasetId,
              kind: 'paste',
              columnRenames,
              selectionRevision: pasteContext.selectionRevision,
              clipboardContext: clipboardContextFromPasteOperation(pasteContext),
            }
            await gridMutationCoordinator.applyGridMutation({
              id: transaction.id,
              datasetId: transaction.datasetId,
              kind: transaction.kind,
              transaction,
            })
          }
          return
        }
        if (!editExecutor) {
          console.warn('No edit executor available for paste')
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

        const modelCapacity = currentDataset.rowCount
        const liveDatasetForPaste =
          useDataStore.getState().datasets.find((dataset) => dataset.id === capturedDatasetId) ?? currentDataset
        const currentDataRows = resolveDataRowCount(liveDatasetForPaste)
        const requiredDataRows = computeRequiredDataRowsForPaste(
          startViewRow,
          normalizedParsedData.length,
          viewToModel
        )
        const needsDataRowExpansion = requiredDataRows > currentDataRows
        const dataRowExpansionCount = Math.max(0, requiredDataRows - currentDataRows)
        const parsedColumnCount = normalizedParsedData.reduce(
          (max, rowValues) => Math.max(max, rowValues.length),
          0
        )
        const destinationSampleRows = sampleNumbers(
          Array.from(
            { length: Math.min(8, normalizedParsedData.length) },
            (_, index) => viewToModel(startViewRow + index)
          )
        )
        const destinationTailSampleRows = normalizedParsedData.length > 8
          ? sampleNumbers(
              Array.from(
                { length: Math.min(8, normalizedParsedData.length) },
                (_, index) => viewToModel(startViewRow + normalizedParsedData.length - 1 - index)
              )
            )
          : []
        logPasteDebug('paste_large_input_snapshot', {
          datasetId: capturedDatasetId,
          source: 'paste',
          pasteOpId,
          parsedRows: normalizedParsedData.length,
          parsedColumnCount,
          startViewRow,
          startModelRow: viewToModel(startViewRow),
          endModelRow: viewToModel(startViewRow + normalizedParsedData.length - 1),
          currentDataRows,
          requiredDataRows,
          needsDataRowExpansion,
          dataRowExpansionCount,
          rowDataSizeBeforePaste: rowDataRef.current.size,
          destinationSampleRows,
          destinationSampleMaterialized: destinationSampleRows.map((row) => hasMaterializedRowData(row)),
          destinationTailSampleRows,
          destinationTailSampleMaterialized: destinationTailSampleRows.map((row) => hasMaterializedRowData(row)),
          row1023Materialized: hasMaterializedRowData(1023),
          row1024Materialized: hasMaterializedRowData(1024),
        })
        if (!isPasteContextActive(pasteContext)) {
          return
        }
        const editableColumns = getEditableColumns(columns)
        const preflight = computePastePreflight({
          startViewRow,
          startCol,
          parsedData: normalizedParsedData,
          currentRowCount: modelCapacity,
          currentColCount: editableColumns.length,
        })
        logPasteDebug('paste_preflight_done', {
          datasetId: capturedDatasetId,
          source: 'paste',
          requiredRowCount: preflight.requiredRowCount,
          requiredColCount: preflight.requiredColCount,
          rowOverflow: preflight.rowOverflow,
          colOverflow: preflight.colOverflow,
          fitsInBounds: preflight.fitsInBounds,
        })

        const pasteDecision = await decidePasteOverflow(preflight)
        if (pasteDecision === 'cancel') {
          logTelemetry('[paste:abort]', { opId: pasteOpId, reason: 'user-cancelled' })
          return
        }
        if (currentDatasetIdRef.current !== capturedDatasetId) {
          logTelemetry('[paste:abort]', { opId: pasteOpId, reason: 'stale-dataset-post-decision' })
          return
        }
        if (!isPasteContextActive(pasteContext)) {
          return
        }

        const shouldExpand = pasteDecision === 'expand'
        const shouldPhysicallyExpandRows =
          shouldExpand && preflight.rowOverflow > 0 && needsDataRowExpansion
        logPasteDebug('paste_expand_decision', {
          rowCount: modelCapacity,
          dataRowCount: currentDataRows,
          requiredRowCount: preflight.requiredRowCount,
          rowOverflow: preflight.rowOverflow,
          needsDataRowExpansion,
          shouldPhysicallyExpandRows,
        })

        if (shouldPhysicallyExpandRows && isViewTransformActive({
          sortModelLength: sortModel.length,
          enableExcelViewFilter: enableExcelViewFilter ?? false,
          hasViewFilterConfig: viewFilterConfig !== null,
          groupByColumnId,
        })) {
          logTelemetry('[paste:abort]', { opId: pasteOpId, reason: 'transform-block-row-expand' })
          toast.warning('Cannot expand rows while a filter, sort, or group is active. Clear them first.')
          return
        }

        if (rejectInvalidTypedPasteCells(normalizedParsedData, startCol, editableColumns)) {
          return
        }

        let effectiveColumns = editableColumns
        let pendingColumnExpansion: {
          drafts: Array<{ id: string; name: string; type: 'text' }>
          insertBase: number
        } | null = null
        const hasColOverflow = preflight.colOverflow > 0
        if (shouldExpand && hasColOverflow) {
          const drafts = buildNewColumnDrafts(
            preflight.colOverflow,
            () => allocateNextAutoColumnName(currentDataset.id),
            () => `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            (name) => rollbackAutoColumnNameAllocation(currentDataset.id, name),
          )
          if (!drafts) {
            toast.error('Failed to allocate column names for paste expansion.')
            return
          }
          const insertBase = editableColumns.length
          pendingColumnExpansion = { drafts, insertBase }
          effectiveColumns = [
            ...editableColumns,
            ...drafts.map(d => ({ id: d.id, title: d.name, width: 88 })),
          ] as GridColumn[]
        }

        const bounds = resolvePasteLoopBounds(preflight, pasteDecision, {
          currentRowCount: modelCapacity,
          currentColCount: effectiveColumns.length,
        })
        if (!bounds) return

        const transformAwareRowCap = resolveTransformAwareRowCap(
          bounds.effectiveRowCap,
          rowOrder.length,
          isViewTransformActive({
            sortModelLength: sortModel.length,
            enableExcelViewFilter: enableExcelViewFilter ?? false,
            hasViewFilterConfig: viewFilterConfig !== null,
            groupByColumnId,
          }),
        )

        const columnRenames = shouldPasteColumnHeaders
          ? resolveColumnRenamesFromHeaderPaste(
              capturedDatasetId,
              startCol,
              copiedColumnHeadersForHeaderPaste ?? []
            )
          : undefined

        const targetColumnIds = Array.from({ length: parsedColumnCount }, (_, colOffset) => {
          const columnId = effectiveColumns[startCol + colOffset]?.id
          return columnId && columnId !== ADD_COLUMN_ID ? columnId : null
        })
        const validTargetColumnIds = targetColumnIds.filter(
          (columnId): columnId is string => typeof columnId === 'string'
        )
        const estimatedBackendPasteCellCount = normalizedParsedData.length * parsedColumnCount
        const backendPasteTouchesFormulaDependents =
          estimatedBackendPasteCellCount >= BACKEND_PASTE_BLOCK_THRESHOLD &&
          estimatedBackendPasteCellCount <= MAX_BACKEND_PASTE_BLOCK_CELLS &&
          formulaService !== null &&
          validTargetColumnIds.length > 0
            ? formulaService.getDependentsForColumns(validTargetColumnIds).length > 0
            : false
        const canRouteHeaderBackendPaste =
          shouldPasteColumnHeaders &&
          shouldSkipCopiedColumnHeaders &&
          !shouldPhysicallyExpandRows
        const canRouteBackendPaste =
          (!shouldPasteColumnHeaders || canRouteHeaderBackendPaste) &&
          !pendingColumnExpansion &&
          !hasColOverflow &&
          !backendPasteTouchesFormulaDependents &&
          targetColumnIds.every((columnId): columnId is string => typeof columnId === 'string')
        if (canRouteBackendPaste) {
          const backendPayloadBuildStartedAt = Date.now()
          const backendPaste = buildBackendPasteBlock({
            values: normalizedParsedData,
            startViewRow,
            columnIds: targetColumnIds,
            largePasteThreshold: BACKEND_PASTE_BLOCK_THRESHOLD,
            maxBackendPasteCells: MAX_BACKEND_PASTE_BLOCK_CELLS,
            viewRowToModelRow: (viewRow) =>
              viewRow >= transformAwareRowCap ? undefined : viewToModel(viewRow),
          })

          if (backendPaste.usesBackendPaste) {
            const coercedValues = backendPaste.payload.values.map((rowValues) =>
              rowValues.map((value, colOffset) => {
                const columnId = backendPaste.payload.columnIds[colOffset]
                if (columnId === undefined) {
                  throw new Error('Backend paste payload is missing a target column.')
                }
                return coerceEditValue(
                  value,
                  columnMetadataMap.get(columnId)?.type,
                  (s) => formulaService?.isFormula(s) ?? false
                )
              })
            )
            const backendPayload = {
              ...backendPaste.payload,
              values: coercedValues,
            }
            const transactionId = nextGridOperationId('paste')
            if (canRouteHeaderBackendPaste) {
              const gridMutationCoordinator = gridMutationCoordinatorRef.current
              if (!gridMutationCoordinator) {
                return
              }
              await gridMutationCoordinator.applyGridMutation({
                id: transactionId,
                datasetId: capturedDatasetId,
                kind: 'paste',
                transaction: {
                  id: transactionId,
                  datasetId: capturedDatasetId,
                  kind: 'paste',
                  columnRenames,
                  selectionRevision: pasteContext.selectionRevision,
                  clipboardContext: clipboardContextFromPasteOperation(pasteContext),
                  backendPasteBlock: {
                    kind: 'backend-paste-block',
                    rows: [...backendPayload.rows],
                    columnIds: [...backendPayload.columnIds],
                    values: backendPayload.values.map((rowValues) => [...rowValues]),
                  },
                },
              })
              if (trackActiveFamilyData && backendPayload.values.some(rowValues =>
                rowValues.some((value) => value !== null && value !== undefined && String(value).trim() !== '')
              )) {
                useAppStore.getState().updateActiveFamilyData(capturedDatasetId, capturedFamilyId)
              }
              return
            }

            const backendCellCount = backendPayload.rows.length * backendPayload.columnIds.length
            const visibleRange = {
              x: visibleRegionRef.current.x,
              y: visibleRegionRef.current.y,
              width: visibleRegionRef.current.width,
              height: visibleRegionRef.current.height,
              rowStart: Math.max(0, visibleRegionRef.current.y),
              rowEndExclusive:
                Math.max(0, visibleRegionRef.current.y) + Math.max(1, visibleRegionRef.current.height),
              columnStart: Math.max(0, visibleRegionRef.current.x),
              columnEndExclusive:
                Math.max(0, visibleRegionRef.current.x) + Math.max(1, visibleRegionRef.current.width),
            }
            logPasteDebug('backend_paste_payload_built', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              editedCells: backendCellCount,
              durationMs: Date.now() - backendPayloadBuildStartedAt,
              visibleRange,
            })
            progress?.update({
              stage: 'Writing paste...',
              indeterminate: true,
            })
            const writeStartedAt = Date.now()
            logPasteDebug('backend_paste_write_start', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              editedCells: backendCellCount,
              durationMs: 0,
              visibleRange,
            })
            logPasteDebug('paste_backend_block_write_start', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              cellCount: backendCellCount,
            })
            let backendResult: Awaited<ReturnType<typeof cacheService.applyPasteBlock>>
            try {
              backendResult = await cacheService.applyPasteBlock(capturedDatasetId, backendPayload)
            } catch (error) {
              logPasteDebug('backend_paste_write_failed', {
                datasetId: capturedDatasetId,
                source: 'paste',
                transactionId,
                error: error instanceof Error ? error.message : String(error),
              })
              toast.error('Failed to paste data. Please try again.', {
                description: error instanceof Error ? error.message : String(error),
              })
              return
            }
            logPasteDebug('paste_backend_block_write_done', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              editedCells: backendResult.editedCells,
              rowStart: backendResult.rowStart,
              rowEndExclusive: backendResult.rowEndExclusive,
            })
            logPasteDebug('backend_paste_write_done', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              editedCells: backendResult.editedCells,
              durationMs: Date.now() - writeStartedAt,
              visibleRange,
              rowStart: backendResult.rowStart,
              rowEndExclusive: backendResult.rowEndExclusive,
            })

            if (backendResult.editedCells <= 0) {
              return
            }
            if (currentDatasetIdRef.current !== capturedDatasetId) return
            if (!isPasteContextActive(pasteContext)) {
              return
            }
            const backendUndoShapeValid = isBackendPasteUndoShapeValid(
              backendPayload.rows,
              backendPayload.columnIds,
              backendResult.oldValues
            )
            if (!backendUndoShapeValid) {
              toast.error(BACKEND_PASTE_UNDO_SHAPE_ERROR, {
                description: 'Reload the dataset before relying on undo for this paste.',
              })
            }

            const liveAfterWrite =
              useDataStore.getState().datasets.find((dataset) => dataset.id === capturedDatasetId) ??
              currentDataset
            const nextDataRowCount = Math.max(
              resolveDataRowCount(liveAfterWrite),
              backendResult.rowEndExclusive
            )
            const nextRowCount = Math.max(liveAfterWrite.rowCount, nextDataRowCount)
            if (
              nextDataRowCount !== resolveDataRowCount(liveAfterWrite) ||
              nextRowCount !== liveAfterWrite.rowCount
            ) {
              updateDataset(capturedDatasetId, {
                rowCount: nextRowCount,
                dataRowCount: nextDataRowCount,
                modifiedAt: new Date(),
              })
            }

            if (backendUndoShapeValid) {
              const undoTransaction: GridTransactionRecord = {
                id: transactionId,
                datasetId: capturedDatasetId,
                kind: 'paste',
                selectionRevision: pasteContext.selectionRevision,
                clipboardContext: clipboardContextFromPasteOperation(pasteContext),
                backendPasteBlock: {
                  kind: 'backend-paste-block',
                  rows: [...backendPayload.rows],
                  columnIds: [...backendPayload.columnIds],
                  values: backendPayload.values.map((rowValues) => [...rowValues]),
                  undoValues: backendResult.oldValues.map((rowValues) => [...rowValues]),
                },
              }
              await undoService.recordGridTransaction(capturedDatasetId, undoTransaction)
            }

            const cellUpdates = patchMaterializedRowsForBackendPaste(
              backendPayload.rows,
              backendPayload.columnIds,
              backendPayload.values
            )
            if (cellUpdates.length > 0) {
              scheduleCellUpdates(cellUpdates)
            }
            showBackendPasteHighlights(backendPayload.rows, backendPayload.columnIds)
            const dirtyBlockKeys = markColdBackendPasteBlocksDirty(capturedDatasetId, backendPayload.rows)
            const visibleColdRows = getVisibleColdBackendPasteRows(
              backendPayload.rows,
              backendResult.rowStart,
              backendResult.rowEndExclusive
            )
            const { blockKeys: hydrateBlockKeys } = getBackendPasteBlockKeys(
              capturedDatasetId,
              visibleColdRows
            )
            currentPasteTimingByTransactionRef.current.set(transactionId, {
              datasetId: capturedDatasetId,
              source: 'paste',
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              editCount: backendResult.editedCells,
              oldValueLookupCount: 0,
              editBuildDurationMs: 0,
              prepareDurationMs: 0,
            })
            progress?.update({
              stage: 'Hydrating rows...',
              indeterminate: true,
            })
            startCurrentPasteHydrateTiming(transactionId, capturedDatasetId, 'paste', hydrateBlockKeys)
            const hydrateStartedAt = Date.now()
            logPasteDebug('backend_paste_hydrate_start', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              editedCells: backendResult.editedCells,
              durationMs: 0,
              visibleRange,
              rowStart: backendResult.rowStart,
              rowEndExclusive: backendResult.rowEndExclusive,
              dirtyBlockCount: dirtyBlockKeys.length,
              hydrateBlockCount: hydrateBlockKeys.length,
            })
            await hydrateBackendPasteRows(capturedDatasetId, visibleColdRows, backendPayload.columnIds)
            logPasteDebug('backend_paste_hydrate_done', {
              datasetId: capturedDatasetId,
              source: 'paste',
              transactionId,
              rowCount: backendPayload.rows.length,
              columnCount: backendPayload.columnIds.length,
              editedCells: backendResult.editedCells,
              durationMs: Date.now() - hydrateStartedAt,
              visibleRange,
              rowStart: backendResult.rowStart,
              rowEndExclusive: backendResult.rowEndExclusive,
              dirtyBlockCount: dirtyBlockKeys.length,
              hydrateBlockCount: hydrateBlockKeys.length,
            })
            requestGridRefresh({
              reason: 'backend-paste-block-hydrate',
              scope: 'viewport',
            })

            if (trackActiveFamilyData && backendPayload.values.some(rowValues =>
              rowValues.some((value) => value !== null && value !== undefined && String(value).trim() !== '')
            )) {
              useAppStore.getState().updateActiveFamilyData(capturedDatasetId, capturedFamilyId)
            }
            if (shouldPhysicallyExpandRows) {
              toast.info(`Expanded by ${dataRowExpansionCount} row${dataRowExpansionCount === 1 ? '' : 's'} to fit pasted data.`)
            }
            if (!shouldExpand) {
              const dropped: string[] = []
              if (preflight.rowOverflow > 0) dropped.push(`${preflight.rowOverflow} row${preflight.rowOverflow === 1 ? '' : 's'}`)
              if (preflight.colOverflow > 0) dropped.push(`${preflight.colOverflow} column${preflight.colOverflow === 1 ? '' : 's'}`)
              if (dropped.length > 0) toast.info(`Pasted with clipping: dropped ${dropped.join(' and ')}.`)
            }
            if (convertedSheetReferences) {
              toast.info('Converted external sheet references to active-grid references.')
            }
            logTelemetry('[paste:execute-done]', {
              opId: pasteOpId,
              source: 'paste',
              editCount: backendResult.editedCells,
              capturedDatasetId,
              capturedFamilyId,
              transactionId,
            })
            return
          }
        }

        const pasteBuildStartedAt = Date.now()
        let oldValueLookupCount = 0
        logPasteDebug('paste_current_build_start', {
          datasetId: capturedDatasetId,
          source: 'paste',
          rowCount: normalizedParsedData.length,
          columnCount: parsedColumnCount,
        })
        const buildResult = await buildPasteEditsInChunks({
          startCol,
          startViewRow,
          parsedData: normalizedParsedData,
          columns: effectiveColumns,
          viewToModel,
          getOldValue: (modelRow, columnId) => {
            oldValueLookupCount += 1
            return getCellRawValueForUndo(modelRow, columnId)
          },
          isWritableColumn: (columnId) => columnId !== ADD_COLUMN_ID,
          effectiveRowCap: transformAwareRowCap,
          chunkRows: PASTE_BUILD_CHUNK_ROWS,
          onChunkProgress: reportPasteBuildProgress(progress),
          shouldContinue: () =>
            currentDatasetIdRef.current === capturedDatasetId &&
            isPasteContextActive(pasteContext),
          coerceValue: (value, columnId) =>
            coerceEditValue(
              value,
              columnMetadataMap.get(columnId)?.type,
              (s) => formulaService?.isFormula(s) ?? false
            ),
        })
        if (buildResult.aborted) {
          return
        }
        const pasteBuildDurationMs = Date.now() - pasteBuildStartedAt
        progress?.update({
          stage: 'Applying paste...',
          indeterminate: true,
        })
        const edits = buildResult.edits
        logPasteDebug('paste_current_build_done', {
          datasetId: capturedDatasetId,
          source: 'paste',
          rowCount: normalizedParsedData.length,
          columnCount: parsedColumnCount,
          editCount: edits.length,
          oldValueLookupCount,
          editBuildDurationMs: pasteBuildDurationMs,
        })

        if (edits.length > 0 && rejectInvalidTypedPasteEdits(edits)) {
          return
        }
        if (currentDatasetIdRef.current !== capturedDatasetId) return
        if (!isPasteContextActive(pasteContext)) {
          return
        }

        const prepareStartedAt = Date.now()
        logPasteDebug('paste_current_prepare_start', {
          datasetId: capturedDatasetId,
          source: 'paste',
          rowCount: normalizedParsedData.length,
          columnCount: parsedColumnCount,
          editCount: edits.length,
          hasColumnExpansion: pendingColumnExpansion !== null,
          shouldPhysicallyExpandRows,
          requiredDataRows,
        })

        if (pendingColumnExpansion) {
          const { drafts, insertBase } = pendingColumnExpansion
          const columnExpansionStartedAt = Date.now()
          logPasteDebug('paste_column_expand_start', {
            datasetId: capturedDatasetId,
            source: 'paste',
            insertAt: insertBase,
            columnsToInsert: drafts.length,
          })
          const expansionResult = await applyColumnExpansion(drafts, insertBase, {
            addToBackend: (id) => cacheService.addColumn(currentDataset.id, id, ''),
            addToStore: (idx, draft) => {
              insertColumnAtDataset(currentDataset.id, idx, {
                id: draft.id, name: draft.name, type: draft.type, width: 88,
              })
              markLocalSchemaMutation(currentDataset.id)
            },
            rollbackBackend: (id) => cacheService.removeColumn(currentDataset.id, id),
            rollbackStore: (idx) => {
              removeColumnAtDataset(currentDataset.id, idx)
              markLocalSchemaMutation(currentDataset.id)
            },
            rollbackName: (name) => rollbackAutoColumnNameAllocation(currentDataset.id, name),
            shouldAbort: () =>
              currentDatasetIdRef.current !== capturedDatasetId ||
              !isPasteContextActive(pasteContext),
          })
          if (!expansionResult.ok) {
            toast.error('Failed to add columns for paste expansion.')
            return
          }
          if (currentDatasetIdRef.current !== capturedDatasetId) return
          if (!isPasteContextActive(pasteContext)) {
            return
          }
          formulaService?.setColumnCount(effectiveColumns.length)
          const newColIds = drafts.map(d => d.id)
          updateRowDataRef(prev => {
            const next = new Map<number, Record<string, unknown>>()
            for (const [ri, row] of prev.entries()) {
              const extended = cloneRowDataPreservingSentinel(row)
              for (const id of newColIds) {
                extended[id] = ''
              }
              next.set(ri, extended)
            }
            return next
          })
          logPasteDebug('paste_column_expand_done', {
            datasetId: capturedDatasetId,
            source: 'paste',
            insertAt: insertBase,
            columnsToInsert: drafts.length,
            durationMs: Date.now() - columnExpansionStartedAt,
          })
        }

        if (edits.length === 0 && (!columnRenames || columnRenames.length === 0)) {
          return
        }

        if (shouldPhysicallyExpandRows) {
          try {
            await ensurePasteDataRowCapacity(capturedDatasetId, requiredDataRows)
          } catch (error) {
            console.error('Failed to expand rows for paste:', error)
            logPasteDebug('paste_abort', {
              reason: 'row_expand_failed',
              datasetId: capturedDatasetId,
              source: 'paste',
              error: error instanceof Error ? error.message : String(error),
            })
            toast.error('Failed to paste data')
            return
          }
          if (currentDatasetIdRef.current !== capturedDatasetId) return
          if (!isPasteContextActive(pasteContext)) {
            return
          }
        }

        const prepareDurationMs = Date.now() - prepareStartedAt
        logPasteDebug('paste_current_prepare_done', {
          datasetId: capturedDatasetId,
          source: 'paste',
          rowCount: normalizedParsedData.length,
          columnCount: parsedColumnCount,
          editCount: edits.length,
          hasColumnExpansion: pendingColumnExpansion !== null,
          shouldPhysicallyExpandRows,
          requiredDataRows,
          prepareDurationMs,
        })

        const gridMutationCoordinator = gridMutationCoordinatorRef.current
        if (!gridMutationCoordinator) {
          return
        }
        const transaction: GridTransactionRecord = {
          id: nextGridOperationId('paste'),
          datasetId: capturedDatasetId,
          kind: 'paste',
          edits,
          columnRenames,
          selectionRevision: pasteContext.selectionRevision,
          clipboardContext: clipboardContextFromPasteOperation(pasteContext),
        }
        currentPasteTimingByTransactionRef.current.set(transaction.id, {
          datasetId: capturedDatasetId,
          source: 'paste',
          rowCount: normalizedParsedData.length,
          columnCount: parsedColumnCount,
          editCount: edits.length,
          oldValueLookupCount,
          editBuildDurationMs: pasteBuildDurationMs,
          prepareDurationMs,
        })
        logPasteDebug('paste_transaction_build_done', {
          datasetId: capturedDatasetId,
          source: 'paste',
          transactionId: transaction.id,
          editCount: edits.length,
        })

        logPasteDebug('paste_apply_mutation_start', {
          datasetId: capturedDatasetId,
          source: 'paste',
          transactionId: transaction.id,
          editCount: edits.length,
        })
        const mutationResult = await gridMutationCoordinator.applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })
        if (mutationResult.transaction.persistAccepted === false) {
          logPasteDebug('paste_abort', {
            reason: mutationResult.transaction.rejectionReason ?? 'mutation_rejected',
            datasetId: capturedDatasetId,
            source: 'paste',
            transactionId: transaction.id,
          })
          return
        }
        logPasteDebug('paste_apply_mutation_done', {
          datasetId: capturedDatasetId,
          source: 'paste',
          transactionId: transaction.id,
          editCount: edits.length,
        })
        logPasteDebug('paste_execute_done', {
          datasetId: capturedDatasetId,
          source: 'paste',
          transactionId: transaction.id,
          edits: edits.length,
        })
        logTelemetry('[paste:execute-done]', {
          opId: pasteOpId,
          source: 'paste',
          editCount: edits.length,
          capturedDatasetId,
          capturedFamilyId,
          transactionId: transaction.id,
        })

        syncFormulasToStore()
        if (!shouldPhysicallyExpandRows) {
          // Padded buffer rows are already part of the visible grid; pasting into them only promotes dataRowCount.
          const rowBounds = getEditRowBounds(edits)
          if (rowBounds) {
            bumpDataRowCount(rowBounds.maxRow)
          }
        }
        if (trackActiveFamilyData && edits.some(e => {
          const v = e.newValue
          return v !== null && v !== undefined && String(v).trim() !== ''
        })) {
          useAppStore.getState().updateActiveFamilyData(capturedDatasetId, capturedFamilyId)
        }

        if (currentDatasetIdRef.current !== capturedDatasetId) return

        if (shouldPhysicallyExpandRows) {
          toast.info(`Expanded by ${dataRowExpansionCount} row${dataRowExpansionCount === 1 ? '' : 's'} to fit pasted data.`)
        }
        if (shouldExpand && hasColOverflow) {
          toast.info(`Added ${preflight.colOverflow} column${preflight.colOverflow === 1 ? '' : 's'} to fit pasted data.`)
        }
        if (!shouldExpand) {
          const dropped: string[] = []
          if (preflight.rowOverflow > 0) dropped.push(`${preflight.rowOverflow} row${preflight.rowOverflow === 1 ? '' : 's'}`)
          if (preflight.colOverflow > 0) dropped.push(`${preflight.colOverflow} column${preflight.colOverflow === 1 ? '' : 's'}`)
          if (dropped.length > 0) toast.info(`Pasted with clipping: dropped ${dropped.join(' and ')}.`)
        }

        requestAnimationFrame(() => {
          const cellUpdates = buildCellUpdates(edits)
          if (cellUpdates.length > 0) {
            scheduleCellUpdates(cellUpdates)
          }
        })
        if (convertedSheetReferences) {
          toast.info('Converted external sheet references to active-grid references.')
        }
        })
      } finally {
        endPasteContext(pasteContext)
      }
    } finally {
      if (readGateHeld) {
        releasePasteReadGate()
      }
    }
  }, [
    allocateNextAutoColumnName,
    beginPasteContext,
    blockSchemaChangeStagingMutation,
    buildCellUpdates,
    bumpDataRowCount,
    columns,
    currentDataset,
    editExecutor,
    enableExcelViewFilter,
    endPasteContext,
    formulaService,
    getBackendPasteBlockKeys,
    getCellRawValueForUndo,
    getVisibleColdBackendPasteRows,
    groupByColumnId,
    hasMaterializedRowData,
    hydrateBackendPasteRows,
    insertColumnAtDataset,
    isPasteContextActive,
    logPasteDebug,
    markColdBackendPasteBlocksDirty,
    markLocalSchemaMutation,
    modelToView,
    normalizePastedFormulaReferences,
    nextGridOperationId,
    patchMaterializedRowsForBackendPaste,
    showBackendPasteHighlights,
    releasePasteReadGate,
    removeColumnAtDataset,
    resolveColumnRenamesFromHeaderPaste,
    resolveHeaderPasteStartCol,
    resolvePasteStart,
    rollbackAutoColumnNameAllocation,
    rowCount,
    rejectInvalidTypedPasteEdits,
    reportPasteBuildProgress,
    runVisualPasteJob,
    scheduleCellUpdates,
    sortModel,
    syncFormulasToStore,
    trackActiveFamilyData,
    tryEnterPasteReadGate,
    updateDataset,
    updateRowDataRef,
    viewFilterConfig,
    viewToModel,
  ])
  const pasteValuesOnlyFromClipboard = useCallback(async (preferContextTarget: boolean = false) => {
    if (blockSchemaChangeStagingMutation('Paste')) {
      return
    }
    const currentSelection = gridSelectionRef.current.current
    if (!currentDataset || !currentSelection || !editExecutor) {
      console.warn('No selection available for paste values')
      return
    }
    if (!tryEnterPasteReadGate('paste-values')) {
      return
    }
    let readGateHeld = true
    try {
    const capturedDatasetId = currentDataset.id

    const pasteStart = resolvePasteStart(preferContextTarget)
    if (!pasteStart) {
      return
    }
    const { startCol, startViewRow } = pasteStart
    const copyContextAtPasteStart = copyContextRef.current
    const pasteSelectionRevision = selectionRevisionRef.current

    // Guard: virtual "+" add-column button is not a valid paste anchor.
    if (startCol >= getEditableColumns(columns).length) {
      toast.warning('Cannot paste from the "+" column. Select a data cell first.')
      return
    }

    let clipboardText: string
    try {
      clipboardText = await clipboard.read()
    } catch (error) {
      console.error('Failed to read clipboard contents:', error)
      return
    }
    if (currentDatasetIdRef.current !== capturedDatasetId) return

    if (!clipboardText) {
      return
    }
    const copiedColumnHeadersForValuesPaste =
      copyContextAtPasteStart?.includesColumnHeaders === true &&
      copyContextAtPasteStart.copiedColumnHeaders?.length
        ? copyContextAtPasteStart.copiedColumnHeaders
        : null
    const shouldSkipCopiedColumnHeaders =
      copiedColumnHeadersForValuesPaste !== null &&
      clipboardText === copyContextAtPasteStart?.clipboardText
    const pasteContext = beginPasteContext(
      capturedDatasetId,
      startViewRow,
      startCol,
      clipboardText,
      copyContextAtPasteStart,
      pasteSelectionRevision
    )
    releasePasteReadGate()
    readGateHeld = false
    try {
      await runVisualPasteJob('paste-values', async (progress) => {
      if (!isPasteContextActive(pasteContext)) {
        return
      }

      const parsedClipboardData = parseClipboardText(clipboardText)
      const rawParsedData = shouldSkipCopiedColumnHeaders
        ? parsedClipboardData.slice(1)
        : parsedClipboardData
      const parsedData = expandClipboardForSelection(rawParsedData, currentSelection.range)
      if (parsedData.length === 0) {
        return
      }
      const {
        normalized: normalizedParsedData,
        converted: convertedSheetReferences,
      } = normalizePastedFormulaReferences(parsedData)

      const availableDataRows = resolveDataRowCount(currentDataset)
      if (!isPasteContextActive(pasteContext)) {
        return
      }
      const requiredDataRows = computeRequiredDataRowsForPaste(
        startViewRow,
        normalizedParsedData.length,
        viewToModel
      )
      const insertedRows = planInsertedRowsForPaste(availableDataRows, requiredDataRows)
      const buildResult = await buildPasteEditsInChunks({
        startCol,
        startViewRow,
        parsedData: normalizedParsedData,
        columns,
        viewToModel,
        getOldValue: getCellRawValueForUndo,
        isWritableColumn: (columnId) => columnId !== ADD_COLUMN_ID,
        chunkRows: PASTE_BUILD_CHUNK_ROWS,
        onChunkProgress: reportPasteBuildProgress(progress),
        shouldContinue: () =>
          currentDatasetIdRef.current === capturedDatasetId &&
          isPasteContextActive(pasteContext),
        coerceValue: (value, columnId) => {
          let newValue: unknown = value
          if (typeof value === 'string' && value.trim().startsWith('=')) {
            newValue = value.trimStart().slice(1)
          }
          return coerceEditValue(
            newValue,
            columnMetadataMap.get(columnId)?.type,
            (s) => formulaService?.isFormula(s) ?? false
          )
        },
      })
      if (buildResult.aborted) {
        return
      }
      progress?.update({
        stage: 'Applying paste...',
        indeterminate: true,
      })
      const transaction: GridTransactionRecord = {
        id: pasteContext.pasteOpId,
        datasetId: capturedDatasetId,
        kind: 'paste-values',
        edits: buildResult.edits,
        structural: insertedRows ? { insertedRows } : undefined,
        clipboardContext: clipboardContextFromPasteOperation(pasteContext),
      }
      transaction.selectionRevision = pasteContext.selectionRevision

      if ((transaction.edits?.length ?? 0) === 0) {
        return
      }
      if (rejectInvalidTypedPasteEdits(transaction.edits ?? [])) {
        return
      }
      if (!isPasteContextActive(pasteContext)) {
        return
      }

      logPasteDebug('paste_execute_start', {
        pasteOpId: pasteContext.pasteOpId,
        datasetId: capturedDatasetId,
        edits: transaction.edits?.length ?? 0,
        source: 'paste-values',
      })
      const gridMutationCoordinator = gridMutationCoordinatorRef.current
      if (!gridMutationCoordinator) {
        return
      }
      try {
        await gridMutationCoordinator.applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })
      } catch (error) {
        console.error('Failed to apply values-only paste edits:', error)
        logPasteDebug('paste_abort', {
          reason: 'execute_failed',
          pasteOpId: pasteContext.pasteOpId,
          datasetId: capturedDatasetId,
          source: 'paste-values',
          error: error instanceof Error ? error.message : String(error),
        })
        toast.error('Failed to paste data')
        return
      }
      logPasteDebug('paste_execute_done', {
        pasteOpId: pasteContext.pasteOpId,
        datasetId: capturedDatasetId,
        edits: transaction.edits?.length ?? 0,
        source: 'paste-values',
      })
      if (convertedSheetReferences) {
        toast.info('Converted external sheet references to active-grid references.')
      }
      })
    } finally {
      endPasteContext(pasteContext)
    }
    } finally {
      if (readGateHeld) {
        releasePasteReadGate()
      }
    }
  }, [
    beginPasteContext,
    blockSchemaChangeStagingMutation,
    coerceEditValue,
    columns,
    currentDataset,
    editExecutor,
    endPasteContext,
    formulaService,
    getCellRawValueForUndo,
    isPasteContextActive,
    viewToModel,
    resolvePasteStart,
    normalizePastedFormulaReferences,
    rejectInvalidTypedPasteEdits,
    logPasteDebug,
    reportPasteBuildProgress,
    releasePasteReadGate,
    runVisualPasteJob,
    tryEnterPasteReadGate,
    resolveDataRowCount,
  ])

  const executeE2EPasteAt = useCallback(
    async (anchorRow: number, anchorCol: number, tsv: string): Promise<number> => {
      if (blockSchemaChangeStagingMutation('Paste')) return 0
      if (!currentDataset || !editExecutor) return 0
      if (!tsv) return 0
      const capturedDatasetId = currentDataset.id

      // E2E bridge uses model-row coordinates (same contract as window.__E2E__.getGridCell).
      const parsedData = parseClipboardText(tsv)
      if (parsedData.length === 0) return 0

      const {
        normalized: normalizedParsedData,
      } = normalizePastedFormulaReferences(parsedData)

      if (groupByColumnId !== null) {
        const hasFormula = normalizedParsedData.some((rowValues) =>
          rowValues.some((value) => {
            if (typeof value !== 'string') return false
            return formulaService?.isFormula(value) ?? value.trim().startsWith('=')
          })
        )
        if (hasFormula) return 0
      }
      if (currentDatasetIdRef.current !== capturedDatasetId) return 0

      const availableDataRows = resolveDataRowCount(currentDataset)
      const backendColumnCount = normalizedParsedData.reduce(
        (max, rowValues) => Math.max(max, rowValues.length),
        0
      )
      const backendColumnIds = Array.from({ length: backendColumnCount }, (_, colOffset) => {
        const columnId = columns[anchorCol + colOffset]?.id
        return columnId && columnId !== ADD_COLUMN_ID ? columnId : null
      })
      const validBackendColumnIds = backendColumnIds.filter(
        (columnId): columnId is string => typeof columnId === 'string'
      )
      const estimatedBackendPasteCellCount = normalizedParsedData.length * backendColumnCount
      const e2eBackendPasteTouchesFormulaDependents =
        estimatedBackendPasteCellCount >= BACKEND_PASTE_BLOCK_THRESHOLD &&
        estimatedBackendPasteCellCount <= MAX_BACKEND_PASTE_BLOCK_CELLS &&
        formulaService !== null &&
        validBackendColumnIds.length > 0
          ? formulaService.getDependentsForColumns(validBackendColumnIds).length > 0
          : false
      const canRouteBackendPaste =
        backendColumnCount > 0 &&
        !e2eBackendPasteTouchesFormulaDependents &&
        backendColumnIds.every((columnId): columnId is string => typeof columnId === 'string')
      if (canRouteBackendPaste) {
        const backendPaste = buildBackendPasteBlock({
          values: normalizedParsedData,
          startViewRow: anchorRow,
          columnIds: backendColumnIds,
          largePasteThreshold: BACKEND_PASTE_BLOCK_THRESHOLD,
          maxBackendPasteCells: MAX_BACKEND_PASTE_BLOCK_CELLS,
          viewRowToModelRow: (viewRow) => viewRow,
        })

        if (backendPaste.usesBackendPaste) {
          const coercedValues = backendPaste.payload.values.map((rowValues) =>
            rowValues.map((value, colOffset) => {
              const columnId = backendPaste.payload.columnIds[colOffset]
              if (columnId === undefined) {
                throw new Error('Backend E2E paste payload is missing a target column.')
              }
              return coerceEditValue(
                value,
                columnMetadataMap.get(columnId)?.type,
                (s) => formulaService?.isFormula(s) ?? false
              )
            })
          )
          const backendPayload = {
            ...backendPaste.payload,
            values: coercedValues,
          }
          const transactionId = nextGridOperationId('paste')
          let backendResult: Awaited<ReturnType<typeof cacheService.applyPasteBlock>>
          try {
            backendResult = await cacheService.applyPasteBlock(capturedDatasetId, backendPayload)
          } catch (error) {
            logPasteDebug('backend_paste_write_failed', {
              datasetId: capturedDatasetId,
              source: 'e2e-paste',
              transactionId,
              error: error instanceof Error ? error.message : String(error),
            })
            return 0
          }
          if (backendResult.editedCells <= 0) return 0
          if (currentDatasetIdRef.current !== capturedDatasetId) return 0
          const backendUndoShapeValid = isBackendPasteUndoShapeValid(
            backendPayload.rows,
            backendPayload.columnIds,
            backendResult.oldValues
          )
          if (!backendUndoShapeValid) {
            toast.error(BACKEND_PASTE_UNDO_SHAPE_ERROR, {
              description: 'Reload the dataset before relying on undo for this paste.',
            })
          }

          const liveAfterWrite =
            useDataStore.getState().datasets.find((dataset) => dataset.id === capturedDatasetId) ??
            currentDataset
          const nextDataRowCount = Math.max(
            resolveDataRowCount(liveAfterWrite),
            backendResult.rowEndExclusive
          )
          const nextRowCount = Math.max(liveAfterWrite.rowCount, nextDataRowCount)
          if (
            nextDataRowCount !== resolveDataRowCount(liveAfterWrite) ||
            nextRowCount !== liveAfterWrite.rowCount
          ) {
            updateDataset(capturedDatasetId, {
              rowCount: nextRowCount,
              dataRowCount: nextDataRowCount,
              modifiedAt: new Date(),
            })
          }

          if (backendUndoShapeValid) {
            const undoTransaction: GridTransactionRecord = {
              id: transactionId,
              datasetId: capturedDatasetId,
              kind: 'paste',
              backendPasteBlock: {
                kind: 'backend-paste-block',
                rows: [...backendPayload.rows],
                columnIds: [...backendPayload.columnIds],
                values: backendPayload.values.map((rowValues) => [...rowValues]),
                undoValues: backendResult.oldValues.map((rowValues) => [...rowValues]),
              },
            }
            await undoService.recordGridTransaction(capturedDatasetId, undoTransaction)
          }

          const cellUpdates = patchMaterializedRowsForBackendPaste(
            backendPayload.rows,
            backendPayload.columnIds,
            backendPayload.values
          )
          if (cellUpdates.length > 0) {
            scheduleCellUpdates(cellUpdates)
          }
          showBackendPasteHighlights(backendPayload.rows, backendPayload.columnIds)
          markColdBackendPasteBlocksDirty(capturedDatasetId, backendPayload.rows)
          const visibleColdRows = getVisibleColdBackendPasteRows(
            backendPayload.rows,
            backendResult.rowStart,
            backendResult.rowEndExclusive
          )
          const { blockKeys: hydrateBlockKeys } = getBackendPasteBlockKeys(
            capturedDatasetId,
            visibleColdRows
          )
          currentPasteTimingByTransactionRef.current.set(transactionId, {
            datasetId: capturedDatasetId,
            source: 'e2e-paste',
            rowCount: backendPayload.rows.length,
            columnCount: backendPayload.columnIds.length,
            editCount: backendResult.editedCells,
            oldValueLookupCount: 0,
            editBuildDurationMs: 0,
            prepareDurationMs: 0,
          })
          startCurrentPasteHydrateTiming(transactionId, capturedDatasetId, 'e2e-paste', hydrateBlockKeys)
          await hydrateBackendPasteRows(capturedDatasetId, visibleColdRows, backendPayload.columnIds)
          requestGridRefresh({
            reason: 'backend-paste-block-e2e-paste',
            scope: 'viewport',
          })
          return backendResult.editedCells
        }
      }
      if (currentDatasetIdRef.current !== capturedDatasetId) {
        return 0
      }

      const requiredDataRows = computeRequiredDataRowsForPaste(
        anchorRow,
        normalizedParsedData.length,
        (viewRow) => viewRow
      )
      const insertedRows = planInsertedRowsForPaste(availableDataRows, requiredDataRows)
      const buildResult = await buildPasteEditsInChunks({
        startCol: anchorCol,
        startViewRow: anchorRow,
        parsedData: normalizedParsedData,
        columns,
        viewToModel: (viewRow) => viewRow,
        getOldValue: getCellRawValueForUndo,
        isWritableColumn: (columnId) => columnId !== ADD_COLUMN_ID,
        chunkRows: PASTE_BUILD_CHUNK_ROWS,
        shouldContinue: () => currentDatasetIdRef.current === capturedDatasetId,
        coerceValue: (value, columnId) =>
          coerceEditValue(
            value,
            columnMetadataMap.get(columnId)?.type,
            (s) => formulaService?.isFormula(s) ?? false
          ),
      })
      if (buildResult.aborted) return 0
      const transaction: GridTransactionRecord = {
        id: nextGridOperationId('paste'),
        datasetId: capturedDatasetId,
        kind: 'paste',
        edits: buildResult.edits,
        structural: insertedRows ? { insertedRows } : undefined,
      }
      transaction.persistSource = 'e2e-paste'

      if ((transaction.edits?.length ?? 0) === 0) return 0
      if (rejectInvalidTypedPasteEdits(transaction.edits ?? [])) return 0
      if (currentDatasetIdRef.current !== capturedDatasetId) return 0

      const gridMutationCoordinator = gridMutationCoordinatorRef.current
      if (!gridMutationCoordinator) return 0

      try {
        await gridMutationCoordinator.applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })
      } catch (error) {
        console.error('Failed to apply E2E paste edits:', error)
        return 0
      }

      return transaction.edits?.length ?? 0
    },
    [
      blockSchemaChangeStagingMutation,
      coerceEditValue,
      columnMetadataMap,
      columns,
      currentDataset,
      editExecutor,
      ensureRangeLoaded,
      formulaService,
      getBackendPasteBlockKeys,
      getCellRawValueForUndo,
      getVisibleColdBackendPasteRows,
      groupByColumnId,
      hydrateBackendPasteRows,
      markColdBackendPasteBlocksDirty,
      normalizePastedFormulaReferences,
      nextGridOperationId,
      patchMaterializedRowsForBackendPaste,
      showBackendPasteHighlights,
      rejectInvalidTypedPasteEdits,
      requestGridRefresh,
      resolveDataRowCount,
      setBlockState,
      startCurrentPasteHydrateTiming,
      updateDataset,
    ]
  )

  const copyE2ERangeAsTsv = useCallback(
    async (
      startRow: number,
      startCol: number,
      selectionRowCount: number,
      selectionColCount: number
    ): Promise<string> => {
      if (!currentDataset) return ''
      if (selectionRowCount <= 0 || selectionColCount <= 0) return ''

      await cacheService.flushPendingUpdates()
      const rows = await cacheService.getRowsHybrid(
        currentDataset.id,
        startRow,
        startRow + selectionRowCount
      )

      const gridMatrix: unknown[][] = []
      for (let rowOffset = 0; rowOffset < selectionRowCount; rowOffset += 1) {
        const row = rows[rowOffset] as Record<string, unknown> | undefined
        const values: unknown[] = []
        for (let colOffset = 0; colOffset < selectionColCount; colOffset += 1) {
          const gridColumn = columns[startCol + colOffset]
          if (!gridColumn?.id || gridColumn.id === ADD_COLUMN_ID) {
            values.push('')
            continue
          }
          values.push(row?.[gridColumn.id] ?? '')
        }
        gridMatrix.push(values)
      }

      const tsv = formatForClipboard(gridMatrix)
      return tsv
    },
    [columns, currentDataset]
  )

  const getE2EVisibleCell = useCallback(
    async (
      rowIndex: number,
      columnIndex: number
    ): Promise<{ rowIndex: number; columnIndex: number; columnId: string; value: unknown; hasRow: boolean } | null> => {
      if (!currentDataset) return null
      if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)) return null
      if (rowIndex < 0 || columnIndex < 0 || columnIndex >= columns.length) return null

      const gridColumn = columns[columnIndex]
      if (!gridColumn?.id || gridColumn.id === ADD_COLUMN_ID) return null

      const modelRow = viewToModel(rowIndex)
      if (modelRow < 0) {
        return {
          rowIndex,
          columnIndex,
          columnId: gridColumn.id,
          value: null,
          hasRow: false,
        }
      }

      const rowRecord = getLocalRowRecord(currentDataset.id, modelRow)
      return {
        rowIndex,
        columnIndex,
        columnId: gridColumn.id,
        value: rowRecord?.[gridColumn.id] ?? null,
        hasRow: rowRecord !== null && !isRowDataSentinel(rowRecord),
      }
    },
    [columns, currentDataset, getLocalRowRecord, viewToModel]
  )

  const selectE2ECell = useCallback(
    async (rowIndex: number, colIndex: number): Promise<boolean> => {
      if (!currentDataset) return false
      if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) return false
      if (rowIndex < 0 || rowIndex >= rowCount) return false
      if (colIndex < 0 || colIndex >= columns.length) return false

      const gridColumn = columns[colIndex]
      if (!gridColumn?.id || gridColumn.id === ADD_COLUMN_ID) return false

      const nextSelection: GridSelection = {
        rows: CompactSelection.empty(),
        columns: CompactSelection.empty(),
        current: {
          cell: [colIndex, rowIndex],
          range: {
            x: colIndex,
            y: rowIndex,
            width: 1,
            height: 1,
          },
          rangeStack: [],
        },
      }
      // Keep ref synchronized immediately so keyboard handlers can see this selection
      // before the next React render.
      gridSelectionRef.current = nextSelection
      setGridSelection(nextSelection)
      syncSelectionToStore(nextSelection, currentDataset)
      setActiveCell({
        rowIndex,
        colIndex,
        columnId: gridColumn.id,
      })
      const container = gridContainerRef.current
      if (!container) return false

      const activeElement = document.activeElement as HTMLElement | null
      const isEditableFocused =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.isContentEditable === true
      if (isEditableFocused) {
        activeElement.blur()
      }

      if (container.tabIndex < 0) {
        container.tabIndex = 0
      }
      container.focus({ preventScroll: true })
      const canvases = container.querySelectorAll('canvas')
      const canvas = (canvases.item(canvases.length - 1) as HTMLCanvasElement | null) ?? null
      if (canvas) {
        if (canvas.tabIndex < 0) {
          canvas.tabIndex = 0
        }
        canvas.focus({ preventScroll: true })
      }

      return true
    },
    [columns, currentDataset, rowCount, syncSelectionToStore]
  )

  const scrollE2ECellIntoView = useCallback(
    async (rowIndex: number, colIndex: number): Promise<boolean> => {
      if (!currentDataset) return false
      if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) return false
      if (rowIndex < 0 || rowIndex >= rowCount) return false
      if (colIndex < 0 || colIndex >= columns.length) return false

      const gridColumn = columns[colIndex]
      if (!gridColumn?.id || gridColumn.id === ADD_COLUMN_ID) return false

      dataEditorRef.current?.scrollTo(colIndex, rowIndex, 'both', 0, 0, {
        hAlign: 'start',
        vAlign: 'center',
      })
      await selectE2ECell(rowIndex, colIndex)
      return true
    },
    [columns, currentDataset, rowCount, selectE2ECell]
  )

  const focusE2EGridSurface = useCallback(async (): Promise<boolean> => {
    const container = gridContainerRef.current
    if (!container) return false

    const activeElement = document.activeElement as HTMLElement | null
    const isEditableFocused =
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement?.isContentEditable === true
    if (isEditableFocused) {
      activeElement.blur()
    }

    if (container.tabIndex < 0) {
      container.tabIndex = 0
    }
    container.focus({ preventScroll: true })
    const canvases = container.querySelectorAll('canvas')
    const canvas = (canvases.item(canvases.length - 1) as HTMLCanvasElement | null) ?? null
    if (canvas) {
      if (canvas.tabIndex < 0) {
        canvas.tabIndex = 0
      }
      canvas.focus({ preventScroll: true })
    }
    return true
  }, [])

  const getE2EActiveCell = useCallback(async (): Promise<{ rowIndex: number; columnIndex: number; columnId: string } | null> => {
    const selectedCell = gridSelectionRef.current.current?.cell
    if (!selectedCell) return null
    const [columnIndex, rowIndex] = selectedCell
    const columnId = columns[columnIndex]?.id
    if (!columnId) return null
    return { rowIndex, columnIndex, columnId }
  }, [columns])

  const getE2EEditSession = useCallback(async (): Promise<{
    active: boolean
    rowIndex: number
    columnIndex: number
    source: FormulaEditSource
  } | null> => {
    const session = formulaSessionRef.current
    const targetCell = session?.targetCell
    if (!session?.active || !targetCell) return null
    return {
      active: session.active,
      rowIndex: targetCell.rowIndex,
      columnIndex: targetCell.colIndex,
      source: session.source,
    }
  }, [])

  const getE2ECopyContext = useCallback(
    async (): Promise<{ copyOpId: string; sourceDatasetId: string; clipboardText: string } | null> => {
      const context = copyContextRef.current
      if (!context) return null
      return {
        copyOpId: context.copyOpId,
        sourceDatasetId: context.sourceDatasetId,
        clipboardText: context.clipboardText,
      }
    },
    []
  )

  const seedE2ECopyContext = useCallback(
    async (clipboardText: string): Promise<{ copyOpId: string; sourceDatasetId: string; clipboardText: string } | null> => {
      if (!currentDataset) return null
      await clipboard.write(clipboardText)
      recordCopyContext(currentDataset.id, clipboardText)
      const context = copyContextRef.current
      if (!context) return null
      return {
        copyOpId: context.copyOpId,
        sourceDatasetId: context.sourceDatasetId,
        clipboardText: context.clipboardText,
      }
    },
    [currentDataset, recordCopyContext]
  )

  useEffect(() => {
    onPasteRequest?.(pasteFromClipboard)
    return () => {
      onPasteRequest?.(null)
    }
  }, [onPasteRequest, pasteFromClipboard])

  // Shared undo handler with filter → highlight → dataset precedence.
  // Used for both keyboard Ctrl+Z and the toolbar Undo button so both paths
  // walk the same priority chain (Phase 5).
  const performUndoWithPrecedenceResult = useCallback(async (): Promise<boolean> => {
    if (!currentDataset) return false
    if (undoFilter()) return true
    if (undoHighlight()) return true
    return await performUndo()
  }, [currentDataset, undoFilter, undoHighlight, performUndo])

  const performRedoWithPrecedenceResult = useCallback(async (): Promise<boolean> => {
    if (!currentDataset) return false
    if (redoHighlight()) return true
    return await performRedo()
  }, [currentDataset, redoHighlight, performRedo])

  const performUndoWithPrecedence = useCallback(async () => {
    await performUndoWithPrecedenceResult()
  }, [performUndoWithPrecedenceResult])

  const performRedoWithPrecedence = useCallback(async () => {
    await performRedoWithPrecedenceResult()
  }, [performRedoWithPrecedenceResult])

  const selectAllDataDomain = useCallback((): boolean => {
    if (!currentDataset) {
      logGridDebug('select_all_noop', { reason: 'missing_dataset' })
      return false
    }

    const dataRowCount = currentDataset.dataRowCount ?? 0
    if (dataRowCount <= 0) {
      logGridDebug('select_all_noop', { reason: 'no_data_rows', datasetId: currentDataset.id, dataRowCount })
      return false
    }

    const nonNullCountByColumnId = selectAllStatsByDatasetRef.current.get(currentDataset.id)
    const persistedColumnIds = selectAllPersistedColumnsByDatasetRef.current.get(currentDataset.id)
    if (!nonNullCountByColumnId || !persistedColumnIds) {
      refreshSelectAllStats(currentDataset.id)
      logGridDebug('select_all_noop', {
        reason: 'stats_not_ready',
        datasetId: currentDataset.id,
      })
      return false
    }
    if (persistedColumnIds.size === 0) {
      refreshSelectAllStats(currentDataset.id)
      logGridDebug('select_all_noop', {
        reason: 'persisted_columns_empty',
        datasetId: currentDataset.id,
      })
      return false
    }
    const hasFullCoverage = Array.from(persistedColumnIds).every((columnId) =>
      nonNullCountByColumnId.has(columnId)
    )
    if (!hasFullCoverage) {
      logGridDebug('select_all_noop', {
        reason: 'partial_stats_coverage',
        datasetId: currentDataset.id,
      })
      return false
    }

    const realColumns = currentDataset.columns.filter((column) => column.id !== ADD_COLUMN_ID)
    const dataColumns = realColumns.filter((column) => persistedColumnIds.has(column.id))
    if (dataColumns.length === 0) {
      logGridDebug('select_all_noop', {
        reason: 'no_data_columns',
        datasetId: currentDataset.id,
      })
      return false
    }
    const dataColumnIds = new Set(dataColumns.map((column) => column.id))

    let firstColumnIndex: number | null = null
    const selectedColumnIndices: number[] = []
    currentDataset.columns.forEach((column, columnIndex) => {
      if (!dataColumnIds.has(column.id)) return
      const nonNullCount = nonNullCountByColumnId.get(column.id) ?? 0
      if (nonNullCount <= 0) return
      selectedColumnIndices.push(columnIndex)
      if (firstColumnIndex === null) {
        firstColumnIndex = columnIndex
      }
    })

    if (firstColumnIndex === null) {
      logGridDebug('select_all_noop', {
        reason: 'non_null_columns_empty',
        datasetId: currentDataset.id,
      })
      return false
    }

    const selectionRanges: Array<{ x: number; y: number; width: number; height: number }> = []
    for (const columnIndex of selectedColumnIndices) {
      const last = selectionRanges[selectionRanges.length - 1]
      if (last && last.x + last.width === columnIndex) {
        last.width += 1
      } else {
        selectionRanges.push({ x: columnIndex, y: 0, width: 1, height: dataRowCount })
      }
    }

    const [primaryRange, ...rangeStack] = selectionRanges
    if (!primaryRange) {
      logGridDebug('select_all_noop', {
        reason: 'selection_ranges_empty',
        datasetId: currentDataset.id,
      })
      return false
    }

    const nextSelection: GridSelection = {
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
      current: {
        cell: [firstColumnIndex, 0],
        range: primaryRange,
        rangeStack,
      },
    }

    setGridSelection(nextSelection)
    syncSelectionToStore(nextSelection, currentDataset)
    setActiveCell({
      rowIndex: 0,
      colIndex: firstColumnIndex,
      columnId: currentDataset.columns[firstColumnIndex]?.id ?? '',
    })

    logGridDebug('select_all_applied', {
      datasetId: currentDataset.id,
      dataRowCount,
      selectedColumns: selectedColumnIndices.length,
      firstColumnIndex,
    })

    return true
  }, [currentDataset, logGridDebug, refreshSelectAllStats, syncSelectionToStore])

  useEffect(() => {
    onUndoRequest?.(performUndoWithPrecedence)
    return () => {
      onUndoRequest?.(null)
    }
  }, [onUndoRequest, performUndoWithPrecedence])

  useEffect(() => {
    onRedoRequest?.(performRedoWithPrecedence)
    return () => {
      onRedoRequest?.(null)
    }
  }, [onRedoRequest, performRedoWithPrecedence])

  useEffect(() => {
    if (!e2eBridgeEnabled || !currentDataset) return
    const bridge: E2EGridBridge = {
      copyRangeAsTsv: copyE2ERangeAsTsv,
      executePasteAt: executeE2EPasteAt,
      getVisibleCell: getE2EVisibleCell,
      selectCell: selectE2ECell,
      scrollToCell: scrollE2ECellIntoView,
      focusSurface: focusE2EGridSurface,
      getActiveCell: getE2EActiveCell,
      getEditSession: getE2EEditSession,
      getCopyContext: getE2ECopyContext,
      seedCopyContext: seedE2ECopyContext,
      selectAll: async () => selectAllDataDomain(),
      undo: async () => {
        return await performUndoWithPrecedenceResult()
      },
      redo: async () => {
        return await performRedoWithPrecedenceResult()
      },
    }
    if (!window.__E2E_GRID_BRIDGE__) {
      window.__E2E_GRID_BRIDGE__ = {}
    }
    window.__E2E_GRID_BRIDGE__[currentDataset.id] = bridge

    return () => {
      const registry = window.__E2E_GRID_BRIDGE__
      if (!registry) return
      if (registry[currentDataset.id] === bridge) {
        delete registry[currentDataset.id]
      }
      if (Object.keys(registry).length === 0) {
        delete window.__E2E_GRID_BRIDGE__
      }
    }
  }, [
    copyE2ERangeAsTsv,
    currentDataset,
    e2eBridgeEnabled,
    executeE2EPasteAt,
    getE2EVisibleCell,
    focusE2EGridSurface,
    getE2EActiveCell,
    getE2ECopyContext,
    getE2EEditSession,
    seedE2ECopyContext,
    performRedoWithPrecedenceResult,
    performUndoWithPrecedenceResult,
    scrollE2ECellIntoView,
    selectAllDataDomain,
    selectE2ECell,
  ])

  useLayoutEffect(() => {
    if (e2eBridgeEnabled) {
      ;(
        window as Window & {
          __E2E_PENDING_SURFACE_PROBE__?: {
            pendingDatasetId: string | null
            token: number | null
            gridContainerReady: boolean
            pendingColumns: number
            pendingRowCount: number | null
            callbackRegistered: boolean
            notifiedKey: string | null
          }
        }
      ).__E2E_PENDING_SURFACE_PROBE__ = {
        pendingDatasetId: pendingDataset?.id ?? null,
        token: pendingDatasetToken ?? null,
        gridContainerReady: Boolean(gridContainerRef.current),
        pendingColumns: pendingDataset?.columns.length ?? 0,
        pendingRowCount: pendingDataset?.rowCount ?? null,
        callbackRegistered: Boolean(onPendingSurfaceReady),
        notifiedKey: pendingSurfaceReadyKeyRef.current,
      }
    }
    if (!pendingDataset || pendingDatasetToken == null || !onPendingSurfaceReady) {
      pendingSurfaceReadyKeyRef.current = null
      return
    }
    if (!gridContainerRef.current) {
      return
    }
    if (pendingDataset.columns.length === 0) {
      return
    }
    const pendingRowCount = pendingDataset.rowCount ?? 0
    if (pendingRowCount <= 0) {
      return
    }
    const readyKey = `${pendingDataset.id}:${pendingDatasetToken}`
    if (pendingSurfaceReadyKeyRef.current === readyKey) {
      return
    }
    pendingSurfaceReadyKeyRef.current = readyKey
    onPendingSurfaceReady({
      datasetId: pendingDataset.id,
      token: pendingDatasetToken,
    })
  }, [onPendingSurfaceReady, pendingDataset, pendingDatasetToken])

  useEffect(() => {
    return () => {
      clearClipboardHandlers()
    }
  }, [clearClipboardHandlers])

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
      const currentSelection = gridSelectionRef.current
      const selectedCell = currentSelection.current?.cell
      const selectedColumn = currentSelection.columns.first()
      const selectedRow = currentSelection.rows.first()
      const hasColumnAnchor =
        selectedColumn !== undefined ||
        selectedCell?.[0] !== undefined ||
        activeCellRef.current?.colIndex !== undefined
      const hasRowAnchor =
        selectedRow !== undefined ||
        selectedCell?.[1] !== undefined ||
        activeCellRef.current?.rowIndex !== undefined
      const anchorColumnIndex =
        selectedColumn ??
        selectedCell?.[0] ??
        activeCellRef.current?.colIndex ??
        0
      const anchorRowIndex =
        selectedRow ??
        selectedCell?.[1] ??
        activeCellRef.current?.rowIndex ??
        0
      ignoreNextInsertMenuWindowClickRef.current = true
      setInsertMenu({
        isOpen: true,
        x: clampedX,
        y: clampedY,
        columnIndex: Math.max(0, anchorColumnIndex),
        rowIndex: Math.max(0, anchorRowIndex),
        hasColumnAnchor,
        hasRowAnchor,
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
        const selection = gridSelectionRef.current
        if (!currentDataset || (!selection.current && selection.columns.length === 0 && selection.rows.length === 0)) return false
        void copySelectionToClipboard()
        return true
      },
      onPaste: () => {
        if (!currentDataset || !editExecutor) return false
        const selection = gridSelectionRef.current
        if (!selection.current && selection.columns.length === 0) return false
        void pasteFromClipboard()
        return true
      },
      onPasteValues: () => {
        if (!currentDataset || !editExecutor) return false
        const selection = gridSelectionRef.current
        if (!selection.current && selection.columns.length === 0) return false
        if (!selection.current) return false
        void pasteValuesOnlyFromClipboard()
        return true
      },
      onCut: () => {
        if (!currentDataset || !gridSelectionRef.current.current || !editExecutor) return false
        void cutToClipboard()
        return true
      },
      onTranspose: () => {
        if (typeof window === 'undefined' || !('__TAURI__' in window)) {
          return false
        }
        if (!currentDataset || !gridSelectionRef.current.current || !editExecutor) return false
        void pasteTransposeFromClipboard()
        return true
      },
      onDelete: () => {
        if (!currentDataset || !gridSelectionRef.current.current || !editExecutor) return false
        void deleteSelection()
        return true
      },
      onFind: () => {
        if (!currentDataset) return false
        if (onRequireDataRows && !onRequireDataRows('Find')) return true
        setFindReplaceMode('find')
        setFindReplaceOpen(true)
        return true
      },
      onFindReplace: () => {
        if (!currentDataset) return false
        if (onRequireDataRows && !onRequireDataRows('Find and replace')) return true
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
        // Ctrl+Z — delegate to the shared precedence chain used by the toolbar
        // button so both entry points always run the same priority order:
        // filter undo → highlight undo → dataset undo (Phase 5).
        if (!currentDataset) return false
        void performUndoWithPrecedence()
        return true
      },
      onRedo: () => {
        // Ctrl+Y — mirror undo behavior through the shared precedence chain.
        if (!currentDataset) return false
        void performRedoWithPrecedence()
        return true
      },
      onSelectAll: () => selectAllDataDomain(),
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

              // Coerce fill result through column type semantics (all types).
              newValue = coerceEditValue(
                newValue,
                columnMetadataMap.get(columnId)?.type,
                (s) => formulaService.isFormula(s)
              )
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

        const gridMutationCoordinator = gridMutationCoordinatorRef.current
        if (!gridMutationCoordinator) {
          return
        }
        const transaction: GridTransactionRecord = {
          id: nextGridOperationId('fill'),
          datasetId: currentDataset.id,
          kind: 'fill',
          edits,
        }

        await gridMutationCoordinator.applyGridMutation({
          id: transaction.id,
          datasetId: transaction.datasetId,
          kind: transaction.kind,
          transaction,
        })

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
        const rowBounds = getEditRowBounds(edits)
        if (rowBounds) {
          bumpDataRowCount(rowBounds.maxRow)
        }
      } finally {
        setGridInteractionMode(resolveModeAfterFill(formulaSessionRef.current))
        gridInteractionModeRef.current = resolveModeAfterFill(formulaSessionRef.current)
      }
    },
    [bumpDataRowCount, columns, currentDataset, formulaService, getCellRawValueForUndo, nextGridOperationId, shouldBlockFillPattern, syncSelectionToStore, viewToModel]
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
    return [...highlightedRegions, ...preview, ...findReplaceHighlightRegions, ...pasteHighlightRegions]
  }, [highlightedRegions, formulaRangePreview, findReplaceHighlightRegions, pasteHighlightRegions])

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
                if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
                  e.stopPropagation()
                  return
                }
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
        columns={sortDialogColumns.length > 0 ? sortDialogColumns : (currentDataset?.columns || [])}
        sortModel={sortModel}
        onSort={(colId, dir) => void performSort([{ colId, dir }])}
        onClearSort={clearSort}
      />

      {/* View Filter Dialog (Phase 1 - Excel-style filter) */}
      {enableExcelViewFilter && (
        <AdvancedFilterDialog
          open={showFilterDialog}
          onOpenChange={(open) => {
            setShowFilterDialog(open)
            if (!open) {
              setFilterDialogScopeColId(null)
              setFilterDialogColumns(null)
              setFilterDialogData([])
            }
          }}
          columnMetadata={filterDialogColumns ?? currentDataset?.columns ?? []}
          data={filterDialogData}
          totalRowCount={currentDataset ? resolveDataRowCount(currentDataset) : filterDialogData.length}
          getColumnUniqueValues={currentDataset ? loadViewFilterUniqueValues : undefined}
          getFilterMatchCount={currentDataset ? loadViewFilterMatchCount : undefined}
          onApply={(config) => {
            if (filterDialogScopeColId) {
              // Scoped path (escalated from column quick-filter):
              // Merge only the scoped column's conditions back into the full config
              // so other columns' conditions are preserved.
              const conditions = config
                ? config.groups
                    .flatMap((g) => g.conditions)
                    .filter((c) => c.columnId === filterDialogScopeColId)
                : null
              applyFilter((prev) =>
                mergeColumnConditions(prev, filterDialogScopeColId, conditions && conditions.length > 0 ? conditions : null)
              )
            } else {
              // Toolbar-open path: replace full config (no active column scope)
              applyFilter(config ?? null)
            }
            setShowFilterDialog(false)
            setFilterDialogScopeColId(null)
          }}
          initialConfig={
            filterDialogScopeColId
              ? buildScopedFilterConfig(viewFilterConfig, filterDialogScopeColId)
              : viewFilterConfig
          }
        />
      )}

      {/* Column header filter popover (Phase 2) — anchor-based, no trigger button needed */}
      {enableExcelViewFilter && columnFilterMenu && (() => {
        // Use colId (stable column identity) rather than colIndex (positional) to
        // avoid mis-targeting a different column if columns are reordered/inserted.
        const colId = columnFilterMenu.colId
        return (
          <Popover
            open
            onOpenChange={(o) => { if (!o) setColumnFilterMenu(null) }}
          >
            <PopoverAnchor
              style={{
                position: 'fixed',
                left: columnFilterMenu.bounds.x,
                top: columnFilterMenu.bounds.y + columnFilterMenu.bounds.height,
                width: columnFilterMenu.bounds.width,
                height: 0,
                pointerEvents: 'none',
              }}
            />
            <PopoverContent align="start" className="w-56 p-0">
              <ColumnFilterPopoverContent
                columnId={colId}
                activeConditions={extractColumnConditions(viewFilterConfig, colId)}
                uniqueValues={columnFilterMenu.uniqueValues}
                loading={columnFilterMenu.loading}
                onApply={(conditions) => handleColumnFilterApply(colId, conditions)}
                onSort={(dir) => {
                  if (onRequireDataRows && !onRequireDataRows('Sort')) {
                    setColumnFilterMenu(null)
                    return
                  }
                  void performSort([{ colId, dir }])
                  setColumnFilterMenu(null)
                }}
                onOpenAdvancedFilter={() => {
                  // Pre-scope the dialog to the active column's conditions only
                  setFilterDialogScopeColId(colId)
                  void openViewFilterDialog()
                  setColumnFilterMenu(null)
                }}
                onClose={() => setColumnFilterMenu(null)}
              />
            </PopoverContent>
          </Popover>
        )
      })()}

      {/* Outline Dialog (Phase 4 - Visual Grouping) */}
      <OutlineDialog
        open={showGroupDialog}
        onOpenChange={setShowGroupDialog}
        columnMetadata={outlineDialogColumns.length > 0 ? outlineDialogColumns : (currentDataset?.columns || [])}
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
                // B6: If a pointer gesture is actively in progress (mousedown fired before
                // this blur, mouseup hasn't fired yet), preserve the range-pick session.
                // The DOM-containment check below can fail when the GDG canvas renders
                // outside the expected ref boundary, so isPointerDownRef is the reliable guard.
                if (isPointerDownRef.current) {
                  clearFormulaBarSuggestions()
                  return
                }
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

        {gridSyncFailureNotice && (
          <div
            data-testid="grid-sync-failure-banner"
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '8px 12px',
              borderBottom: `1px solid ${spreadsheetPalette.formulaBarBorder}`,
              backgroundColor: spreadsheetPalette.formulaBarBg,
              color: spreadsheetPalette.inputText,
              fontSize: '12px',
            }}
          >
            <span>
              Dataset sync failed. {gridSyncFailureNotice.message} Retry sync to finish backend persistence.
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => void retryFailedGridSync()}
                disabled={gridSyncFailureNotice.retrying}
                style={{
                  padding: '4px 10px',
                  borderRadius: '4px',
                  border: `1px solid ${spreadsheetPalette.inputBorder}`,
                  backgroundColor: gridSyncFailureNotice.retrying ? spreadsheetPalette.menuBg : '#2563EB',
                  color: gridSyncFailureNotice.retrying ? spreadsheetPalette.menuText : '#FFFFFF',
                  cursor: gridSyncFailureNotice.retrying ? 'default' : 'pointer',
                  fontSize: '12px',
                }}
              >
                {gridSyncFailureNotice.retrying ? 'Retrying...' : 'Retry sync'}
              </button>
              <button
                type="button"
                onClick={() => {
                  failedGridSyncTransactionRef.current = null
                  setGridSyncFailureNotice(null)
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: '4px',
                  border: `1px solid ${spreadsheetPalette.inputBorder}`,
                  backgroundColor: spreadsheetPalette.menuBg,
                  color: spreadsheetPalette.menuText,
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
              >
                Dismiss
              </button>
            </span>
          </div>
        )}

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
            data-testid="grid-container"
            onDoubleClickCapture={handleGridDoubleClickCapture}
            style={{
              width: '100%',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
              }}
            >
              <DataEditor
                key={`grid-${structuralGridRevision}`}
                ref={dataEditorRef}
                columns={committedGridSurface.columns}
                rows={committedGridSurface.rowCount}
                className="min-w-full min-h-full"
                getCellContent={getCellContent}
                getCellsForSelection={true}
                gridSelection={gridSelection}
                onCellEdited={onCellEdited}
                onCellActivated={onCellActivated}
                onGridSelectionChange={onSelectionChanged}
                onColumnResize={onColumnResize}
                onHeaderClicked={onHeaderClicked}
                onHeaderMenuClick={enableExcelViewFilter ? onHeaderMenuClick : undefined}
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
                columnSelect="multi"
                // Theme customization - SukiUI Blue theme
                theme={dataEditorTheme}
                // Cell reference highlighting when typing formulas
                highlightRegions={combinedHighlightRegions}
              />
              {gridRenderState === 'staging' && hasNonPlaceholderCommittedSurface && (
                <div
                  data-testid="grid-staging-status"
                  role="status"
                  aria-live="polite"
                  style={{
                    position: 'absolute',
                    right: 12,
                    bottom: 10,
                    padding: '4px 8px',
                    borderRadius: 999,
                    color: spreadsheetPalette.emptyText,
                    fontSize: '11px',
                    backgroundColor: spreadsheetPalette.formulaBarBg,
                    border: `1px solid ${spreadsheetPalette.formulaBarBorder}`,
                    pointerEvents: 'none',
                  }}
                >
                  {gridOverlayMessage}
                </div>
              )}
              {shouldShowBlockingGridOverlay && (
                <div
                  data-testid="grid-empty-state"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: spreadsheetPalette.emptyText,
                    fontSize: '13px',
                    backgroundColor: spreadsheetPalette.formulaBarBg,
                  }}
                >
                  {gridOverlayMessage}
                </div>
              )}
            </div>
          {import.meta.env.MODE === 'test' && (
            <>
              <div
                data-testid="grid-refresh-counters"
                data-remount-count={refreshDebugCounts.remount}
                data-viewport-count={refreshDebugCounts.viewport}
                data-cells-count={refreshDebugCounts.cells}
                data-reasons={JSON.stringify(refreshDebugReasons)}
                hidden
              />
              <div
                data-testid="grid-overlay-state"
                data-overlay-row-count={getCurrentDatasetOverlayDebugState().overlayRowCount}
                data-persisted-mutation-count={
                  getCurrentDatasetOverlayDebugState().persistedMutationCount
                }
                hidden
              />
              <div
                data-testid="grid-activation-state"
                data-pending-dataset-id={pendingActivationDatasetId ?? ''}
                data-selection-current={
                  JSON.stringify(gridSelection.current ? gridSelection.current.cell : null)
                }
                data-active-cell={
                  JSON.stringify(activeCell ? [activeCell.colIndex, activeCell.rowIndex] : null)
                }
                data-sort-model={JSON.stringify(sortModel)}
                data-scroll={JSON.stringify(lastRequestedScrollRestoreRef.current)}
                hidden
              />
            </>
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
              if (!insertMenu.hasColumnAnchor) {
                toast.info('Select a cell or column header to choose where to insert the column.')
                closeInsertMenu()
                return
              }
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
              if (!insertMenu.hasColumnAnchor) {
                toast.info('Select a cell or column header to choose where to insert the column.')
                closeInsertMenu()
                return
              }
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
              if (!insertMenu.hasRowAnchor) {
                toast.info('Select a cell or row header to choose where to insert the row.')
                closeInsertMenu()
                return
              }
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
              if (!insertMenu.hasRowAnchor) {
                toast.info('Select a cell or row header to choose where to insert the row.')
                closeInsertMenu()
                return
              }
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
              if (onRequireDataRows && !onRequireDataRows('Find and replace')) {
                closeContextMenu()
                return
              }
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

