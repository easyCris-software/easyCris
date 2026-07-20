/**
 * E2E Test Shim
 *
 * Shim that exposes minimal APIs for E2E tests.
 * Loaded only when the app is started/built in E2E mode.
 *
 * Available via window.__E2E__ in browser console and E2E tests.
 */

import { loadProjectFromPath } from '@/services/projectService'
import { useAppStore, ensureProjectId } from '@/store/app-store'
import { useAnalysisStore } from '@/store/analysis-store'
import {
  useDataStore,
  type ColumnMetadata,
  type Dataset,
} from '@/store/data-store'
import { usePlotsStore } from '@/store/plots-store'
import { useResultsStore } from '@/store/results-store'
import { useRNAseqStore } from '@/store/rnaseq-store'
import {
  useRemoteSessionStore,
  type RemoteSessionLimitWarning,
} from '@/store/remote-session-store'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { useUIStore } from '@/store/ui-store'
import tauriApi from '@/services/tauriApi'
import exportService from '@/services/exportService'
import rnaseqService from '@/services/rnaseqService'
import {
  getRemoteCaptureStream,
  isE2ERemoteCaptureMockEnabled,
  isNativeRemoteCaptureSupported,
  remoteWebRtcHost,
  type RemoteMediaDiagnostics,
} from '@/services/remoteWebRtcHost'
import {
  closeRemoteHostControlsWindow as closeRemoteHostControlsWindowResource,
  REMOTE_HOST_CONTROLS_COMMAND_EVENT,
} from '@/services/remoteHostControlsWindow'
import {
  isMediaVisibleState,
  remoteWebRtcClient,
} from '@/services/remoteWebRtcClient'
import type { RemoteInputMouseEventPayload } from '@/services/remoteInputEvents'
import type {
  RemoteSessionIdentity,
  RemoteSessionStatus,
} from '@/services/remoteSessionService'
import cacheService from '@/services/cacheService'
import undoService from '@/services/undoService'
import { exportPlotWithKaleido } from '@/services/plotExportService'
import {
  applyAxisDefaultsForExport,
  shouldIncludeAxisOverlay,
} from '@/utils/plotExportUtils'
import {
  clearDeviceAuthState,
  getDeviceAuthSnapshot,
  setFirstLaunchState,
  type E2EDeviceAuthSnapshot,
} from '@/utils/e2eAuthHooks'
import { exists, mkdir, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { dirname } from '@tauri-apps/api/path'
import { Channel, invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from '@tauri-apps/api/window'

const MIN_COLUMNS = 100
const MIN_ROWS = 100
const ROW_BUFFER = 50
const DEFAULT_COLUMN_WIDTH = 88

type E2ERemoteCaptureBackend = 'e2e-mock' | 'native' | 'unavailable'

interface E2ERemoteCaptureBackendSnapshot {
  e2eMockEnabled: boolean
  nativeSupported: boolean
  preferredBackend: E2ERemoteCaptureBackend
}

interface E2ENativeMicProbeResult {
  captureSampleRate: number
  outputFramesPerChunk: number | null
  packetCount: number
  packetFrameCount: number
  packetSampleRate: number
  rubatoResamplerActive: boolean
  sampleRate: number
  sourceKind: string
}

interface E2ENativeWindowScreenshotResult {
  output_path: string
  width: number
  height: number
}

interface E2ENativeCaptureRect {
  height: number
  left: number
  top: number
  width: number
}

interface E2ENativeCaptureGeometryExpectation {
  expectedCaptureRect: E2ENativeCaptureRect
  expectedCropArea: E2ENativeCaptureRect
  monitorRect: E2ENativeCaptureRect
  windowRect: E2ENativeCaptureRect
}

interface E2ENativeCaptureViewportContract {
  devicePixelRatio: number
  innerSize: {
    height: number
    width: number
  }
  matches: boolean
  viewport: {
    cssHeight: number
    cssWidth: number
    physicalHeight: number
    physicalWidth: number
  }
}

function evenAlignUp(value: number): number {
  const floored = Math.floor(value)
  return floored + (floored % 2)
}

function evenAlignDown(value: number): number {
  const floored = Math.floor(value)
  return floored - (floored % 2)
}

function right(rect: E2ENativeCaptureRect): number {
  return rect.left + rect.width
}

function bottom(rect: E2ENativeCaptureRect): number {
  return rect.top + rect.height
}

function expectedNativeCaptureGeometry(
  windowRect: E2ENativeCaptureRect,
  monitorRect: E2ENativeCaptureRect
): E2ENativeCaptureGeometryExpectation {
  const left = Math.max(windowRect.left, monitorRect.left)
  const top = Math.max(windowRect.top, monitorRect.top)
  const clippedRight = Math.min(right(windowRect), right(monitorRect))
  const clippedBottom = Math.min(bottom(windowRect), bottom(monitorRect))
  if (clippedRight <= left || clippedBottom <= top) {
    throw new Error('easyCris window does not overlap the current monitor')
  }

  const cropLeft = evenAlignUp(left - monitorRect.left)
  const cropTop = evenAlignUp(top - monitorRect.top)
  const cropWidth = Math.min(
    evenAlignUp(clippedRight - left),
    evenAlignDown(monitorRect.width - cropLeft)
  )
  const cropHeight = Math.min(
    evenAlignUp(clippedBottom - top),
    evenAlignDown(monitorRect.height - cropTop)
  )
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error('easyCris native capture crop is empty')
  }

  return {
    expectedCaptureRect: {
      left: monitorRect.left + cropLeft,
      top: monitorRect.top + cropTop,
      width: cropWidth,
      height: cropHeight,
    },
    expectedCropArea: {
      left: cropLeft,
      top: cropTop,
      width: cropWidth,
      height: cropHeight,
    },
    monitorRect,
    windowRect,
  }
}

function createCurrentRemoteLimitWarning(
  secondsRemaining: number,
  expiresAtUnixMs = Date.now() + Math.max(0, secondsRemaining) * 1000
): RemoteSessionLimitWarning | null {
  const sessionId =
    useRemoteSessionStore.getState().status?.current_session?.session_id
  if (!sessionId) {
    return null
  }
  return {
    expires_at_unix_ms: expiresAtUnixMs,
    seconds_remaining: Math.max(0, Math.ceil(secondsRemaining)),
    session_id: sessionId,
  }
}

function readRemoteAudioElementState(testId: string) {
  const element = document.querySelector(`[data-testid="${testId}"]`)
  if (!(element instanceof HTMLAudioElement)) {
    return null
  }
  const srcObject = element.srcObject
  const tracks =
    srcObject instanceof MediaStream
      ? srcObject.getTracks().map(track => ({
          enabled: track.enabled,
          kind: track.kind,
          muted: track.muted,
          readyState: track.readyState,
        }))
      : []
  return {
    hasSrcObject: srcObject instanceof MediaStream,
    paused: element.paused,
    srcObjectTrackCount: tracks.length,
    tracks,
    volume: element.volume,
  }
}

interface GridShapeSnapshot {
  datasetId: string | null
  rowCount: number
  dataRowCount: number
  columnCount: number
  columns?: Array<{
    id: string
    name: string
    type: string
    width?: number
  }>
}

interface GridCellSnapshot {
  datasetId: string
  rowIndex: number
  columnId: string
  columnIndex: number
  value: unknown
  hasRow: boolean
}

interface GridVisibleCellSnapshot {
  datasetId: string
  rowIndex: number
  columnId: string
  columnIndex: number
  value: unknown
  hasRow: boolean
}

interface GridSelectionSnapshot {
  selectedRowCount: number
  selectedColumnCount: number
  allRowsSelected: boolean
  allColumnsSelected: boolean
  includesAddColumn: boolean
  dataRowCount: number
  rowCount: number
}

interface DisplayGridSurfaceSnapshot {
  committedDatasetId: string | null
  pendingDatasetId: string | null
  pendingSurfaceStatus: 'staging' | 'committed'
  token: number | null
}

type E2EGridBridge = {
  copyRangeAsTsv: (
    startRow: number,
    startCol: number,
    rowCount: number,
    colCount: number
  ) => Promise<string>
  executePasteAt: (
    anchorRow: number,
    anchorCol: number,
    tsv: string
  ) => Promise<number>
  getVisibleCell: (
    rowIndex: number,
    columnIndex: number
  ) => Promise<{
    rowIndex: number
    columnIndex: number
    columnId: string
    value: unknown
    hasRow: boolean
  } | null>
  selectCell: (rowIndex: number, colIndex: number) => Promise<boolean>
  scrollToCell: (rowIndex: number, colIndex: number) => Promise<boolean>
  focusSurface: () => Promise<boolean>
  getActiveCell: () => Promise<{
    rowIndex: number
    columnIndex: number
    columnId: string
  } | null>
  getEditSession: () => Promise<{
    active: boolean
    rowIndex: number
    columnIndex: number
    source: 'bar' | 'cell'
  } | null>
  getCopyContext: () => Promise<{
    copyOpId: string
    sourceDatasetId: string
    clipboardText: string
  } | null>
  seedCopyContext: (clipboardText: string) => Promise<{
    copyOpId: string
    sourceDatasetId: string
    clipboardText: string
  } | null>
  selectAll: () => Promise<boolean>
  undo: () => Promise<boolean>
  redo: () => Promise<boolean>
}

const resolveDisplayDatasetId = (): string | null => {
  return (
    (window as Window & { __E2E_DISPLAY_DATASET_ID__?: string | null })
      .__E2E_DISPLAY_DATASET_ID__ ?? null
  )
}

const resolveDatasetForGrid = (datasetId?: string | null): Dataset | null => {
  const dataStore = useDataStore.getState()
  if (datasetId) {
    return dataStore.datasets.find(dataset => dataset.id === datasetId) ?? null
  }
  const displayDatasetId = resolveDisplayDatasetId()
  if (displayDatasetId) {
    const displayDataset =
      dataStore.datasets.find(dataset => dataset.id === displayDatasetId) ??
      null
    if (displayDataset) {
      return displayDataset
    }
  }
  return dataStore.currentDataset ?? null
}

const resolveGridBridge = (
  datasetId?: string | null
): { dataset: Dataset; bridge: E2EGridBridge } | null => {
  const dataset = resolveDatasetForGrid(datasetId)
  if (!dataset) return null
  const registry = (
    window as Window & { __E2E_GRID_BRIDGE__?: Record<string, E2EGridBridge> }
  ).__E2E_GRID_BRIDGE__
  const bridge = registry?.[dataset.id]
  if (!bridge) return null
  return { dataset, bridge }
}

const createDefaultE2EFamilies = () => [
  {
    id: 'statistics-1',
    name: 'Statistics',
    hasData: false,
    hasResults: false,
    createdAt: new Date(),
  },
]

const dataUrlToBytes = (dataUrl: string): Uint8Array => {
  // Plotly.toImage may return either:
  // - data:image/png;base64,...
  // - data:image/svg+xml;charset=utf-8,...
  // - raw "<svg ...>" string (depends on Plotly version/build)
  if (!dataUrl) return new Uint8Array()

  const trimmed = dataUrl.trim()
  if (!trimmed.includes(',') && trimmed.startsWith('<')) {
    return new TextEncoder().encode(trimmed)
  }

  const [meta, data] = trimmed.split(',', 2)
  if (!data) {
    return new TextEncoder().encode(meta ?? '')
  }

  if (meta?.includes(';base64')) {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  const decoded = decodeURIComponent(data)
  return new TextEncoder().encode(decoded)
}

const extendColumns = (baseColumns: ColumnMetadata[]): ColumnMetadata[] => {
  const columns = [...baseColumns]
  const usedIds = new Set(columns.map(col => col.id))
  let nextIndex = 0

  for (const col of columns) {
    const match = /^col-(\d+)$/.exec(col.id)
    if (!match) continue
    const index = Number(match[1])
    if (Number.isFinite(index)) {
      nextIndex = Math.max(nextIndex, index + 1)
    }
  }

  for (let i = columns.length; i < MIN_COLUMNS; i++) {
    while (usedIds.has(`col-${nextIndex}`)) {
      nextIndex += 1
    }
    const id = `col-${nextIndex}`
    usedIds.add(id)
    columns.push({
      id,
      name: `Column ${i + 1}`,
      type: 'text',
      width: DEFAULT_COLUMN_WIDTH,
    })
    nextIndex += 1
  }

  return columns
}

// Primary gate: explicit E2E mode.
// Backward compatibility: honor legacy VITE_E2E_ENABLED if present.
const e2eEnabled =
  import.meta.env.MODE === 'e2e' || import.meta.env.VITE_E2E_ENABLED === 'true'

// Expose E2E APIs only when enabled.
if (e2eEnabled) {
  window.__E2E__ = {
    /**
     * Load a fixture .ecp file
     * @param fixturePath - Relative path from project root (e.g., 'e2e/fixtures/datasets/anova_two_way.ecp')
     */
    async loadFixture(fixturePath: string): Promise<void> {
      console.log(`[E2E] Loading fixture: ${fixturePath}`)
      await loadProjectFromPath(fixturePath, { nonInteractive: true })
      console.log(`[E2E] Fixture loaded: ${fixturePath}`)
    },

    /**
     * Run a statistical test
     * @param testType - Test type identifier (e.g., 'anova_two_way')
     * @param config - Test configuration
     */
    async runTest(testType: string, config: any): Promise<void> {
      console.log(`[E2E] Running test: ${testType}`, config)
      // TODO: Implement test runner integration
      // This would call useStatisticalAnalysisController or similar
      throw new Error('runTest not yet implemented - use UI workflow for now')
    },

    /**
     * Get current dataset count
     */
    getDatasetCount(): number {
      const count = useDataStore.getState().datasets.length
      console.log(`[E2E] Dataset count: ${count}`)
      return count
    },

    /**
     * Clear all datasets
     */
    async clearAllData(): Promise<void> {
      console.log('[E2E] Clearing all data')
      window.__E2E_REMOTE_CAPTURE_MOCK__ = false
      window.__E2E_REMOTE_HOST_CONTROLS_SUPPRESSED__ = false
      await closeRemoteHostControlsWindowResource().catch(() => undefined)
      const appStore = useAppStore.getState()
      useDataStore.getState().clearAllDatasets()
      useResultsStore.getState().clearAllResults({ suppressDirty: true })
      usePlotsStore.getState().clearPlots({ suppressDirty: true })
      useAnalysisStore.getState().clearHistory({ suppressDirty: true })
      await useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
      appStore.restoreFamilies(createDefaultE2EFamilies(), 'statistics-1')
      appStore.setWorkspaceViewMode('data')
      console.log('[E2E] App family state reset for clean test startup')
      console.log('[E2E] All data cleared')
    },

    /**
     * Snapshot family bindings for E2E diagnostics.
     */
    getFamilyState() {
      const app = useAppStore.getState()
      return {
        activeFamilyId: app.activeFamilyId,
        families: app.families.map(family => ({
          id: family.id,
          name: family.name,
          datasetId: family.datasetId ?? null,
          hasData: family.hasData,
          hasResults: family.hasResults,
        })),
      }
    },

    getAppOperationLockState() {
      const lock = useAppStore.getState().appOperationLock
      return {
        active: lock.active,
        owner: lock.owner,
        operation: lock.operation,
        progress: lock.progress,
        indeterminate: lock.indeterminate ?? false,
        stage: lock.stage,
        startedAt: lock.startedAt,
      }
    },

    acquireE2EOperationLock(): string | null {
      return useAppStore.getState().acquireAppOperationLock({
        owner: 'e2e-lock-test',
        operation: 'E2E lock contention',
        stage: 'Holding lock for undo contention',
        progress: 0,
        indeterminate: true,
      })
    },

    releaseE2EOperationLock(token: string): boolean {
      return useAppStore.getState().releaseAppOperationLock(token)
    },

    async setActiveFamily(familyId: string): Promise<boolean> {
      const app = useAppStore.getState()
      if (!app.families.some(family => family.id === familyId)) {
        return false
      }
      try {
        await app.setActiveFamily(familyId)
        return useAppStore.getState().activeFamilyId === familyId
      } catch (error) {
        console.error('[E2E] Failed to set active family', error)
        return false
      }
    },

    getStatisticsResultsSnapshot() {
      const store = useResultsStore.getState()
      return {
        activeStatisticsFamilyId: store.activeStatisticsFamilyId,
        currentResult: store.currentResult,
        currentResultIdByFamily: store.currentResultIdByFamily,
        results: store.results,
        resultsByFamily: store.resultsByFamily,
      }
    },

    getPlotsSnapshot() {
      const store = usePlotsStore.getState()
      return {
        activePlotId: store.activePlotId,
        plots: store.plots,
      }
    },

    applyActiveBarPatternFixture() {
      const store = usePlotsStore.getState()
      const isBarPlot = (plot: { plotlyData?: unknown[] } | undefined) =>
        Array.isArray(plot?.plotlyData) &&
        plot.plotlyData.some(
          trace => (trace as { type?: unknown })?.type === 'bar'
        )
      const targetPlot =
        store.plots.find(
          plot => plot.id === store.activePlotId && isBarPlot(plot)
        ) ?? store.plots.find(isBarPlot)
      if (!targetPlot) {
        throw new Error('No bar plot is available for the OLE pattern fixture')
      }

      const nextData = targetPlot.plotlyData.map(trace => {
        const traceRecord = trace as Record<string, unknown>
        if (traceRecord.type !== 'bar') return trace

        const yValues = Array.isArray(traceRecord.y) ? traceRecord.y : []
        const count = Math.max(1, yValues.length)
        const colors = ['#004CFF', '#FF8A00', '#00A000']
        const barColors = Array.from(
          { length: count },
          (_, index) => colors[index % colors.length]
        )
        const marker = (
          traceRecord.marker && typeof traceRecord.marker === 'object'
            ? traceRecord.marker
            : {}
        ) as Record<string, unknown>
        const line = (
          marker.line && typeof marker.line === 'object' ? marker.line : {}
        ) as Record<string, unknown>

        return {
          ...traceRecord,
          marker: {
            ...marker,
            color: barColors,
            pattern: {
              shape: Array.from({ length: count }, (_, index) =>
                index === 0 ? '/' : ''
              ),
              size: Array.from({ length: count }, () => 6),
              solidity: Array.from({ length: count }, () => 0.5),
              bgcolor: barColors,
              fgcolor: Array.from({ length: count }, () => '#FFFFFF'),
            },
            line: {
              ...line,
              color: Array.from({ length: count }, () => '#111827'),
              width: Array.from({ length: count }, () => 1.5),
            },
          },
        }
      })

      store.setActivePlot(targetPlot.id)
      store.updatePlot(targetPlot.id, { plotlyData: nextData })
      return { plotId: targetPlot.id, traceCount: nextData.length }
    },

    setWorkspaceViewMode(mode: 'data' | 'results' | 'plots'): void {
      useAppStore.getState().setWorkspaceViewMode(mode)
    },

    getGridShape(datasetId?: string): GridShapeSnapshot {
      const dataset = resolveDatasetForGrid(datasetId)
      if (!dataset) {
        return {
          datasetId: null,
          rowCount: 0,
          dataRowCount: 0,
          columnCount: 0,
        }
      }

      return {
        datasetId: dataset.id,
        rowCount: dataset.rowCount,
        dataRowCount: dataset.dataRowCount ?? dataset.rowCount,
        columnCount: dataset.columnCount ?? dataset.columns.length,
        columns: dataset.columns.map(column => ({
          id: column.id,
          name: column.name,
          type: column.type,
          width: column.width,
        })),
      }
    },

    async getGridCell(args: {
      datasetId?: string
      rowIndex: number
      columnId?: string
      columnIndex?: number
    }): Promise<GridCellSnapshot> {
      const dataset = resolveDatasetForGrid(args.datasetId)
      if (!dataset) {
        throw new Error('No dataset available for getGridCell')
      }

      const rawColumnIndex = args.columnIndex ?? 0
      const columnByIndex = dataset.columns[rawColumnIndex]
      const columnId = args.columnId ?? columnByIndex?.id
      if (!columnId) {
        throw new Error(`Column not found (columnIndex=${rawColumnIndex})`)
      }

      const columnIndex = dataset.columns.findIndex(
        column => column.id === columnId
      )
      if (columnIndex < 0) {
        throw new Error(`Column not found: ${columnId}`)
      }

      await cacheService.flushPendingUpdates()
      const rows = await cacheService.getRowsHybrid(
        dataset.id,
        args.rowIndex,
        args.rowIndex + 1
      )
      const row = rows[0] as Record<string, unknown> | undefined
      const hasRow = row !== undefined
      const value = row ? (row[columnId] ?? null) : null

      return {
        datasetId: dataset.id,
        rowIndex: args.rowIndex,
        columnId,
        columnIndex,
        value,
        hasRow,
      }
    },

    async getGridVisibleCell(args: {
      datasetId?: string
      rowIndex: number
      columnId?: string
      columnIndex?: number
    }): Promise<GridVisibleCellSnapshot> {
      const bridged = resolveGridBridge(args.datasetId)
      if (!bridged) {
        throw new Error('Grid bridge unavailable for getGridVisibleCell')
      }

      const rawColumnIndex = args.columnIndex ?? 0
      let columnIndex = rawColumnIndex
      if (args.columnId) {
        const resolvedIndex = bridged.dataset.columns.findIndex(
          column => column.id === args.columnId
        )
        if (resolvedIndex < 0) {
          throw new Error(`Column not found: ${args.columnId}`)
        }
        columnIndex = resolvedIndex
      }

      const snapshot = await bridged.bridge.getVisibleCell(
        args.rowIndex,
        columnIndex
      )
      if (!snapshot) {
        throw new Error(
          `Visible cell not available (rowIndex=${args.rowIndex}, columnIndex=${columnIndex})`
        )
      }

      return {
        datasetId: bridged.dataset.id,
        rowIndex: snapshot.rowIndex,
        columnId: snapshot.columnId,
        columnIndex: snapshot.columnIndex,
        value: snapshot.value,
        hasRow: snapshot.hasRow,
      }
    },

    getColumnType(args: {
      datasetId?: string
      columnId?: string
      columnIndex?: number
    }): string | null {
      const dataset = resolveDatasetForGrid(args.datasetId)
      if (!dataset) return null

      if (args.columnId) {
        return (
          dataset.columns.find(column => column.id === args.columnId)?.type ??
          null
        )
      }

      const columnIndex = args.columnIndex ?? 0
      return dataset.columns[columnIndex]?.type ?? null
    },

    async getPersistedColumnIds(datasetId?: string): Promise<string[]> {
      const dataset = resolveDatasetForGrid(datasetId)
      if (!dataset) return []
      return await cacheService.getPersistedColumnIds(dataset.id)
    },

    getGridSelectionSnapshot(): GridSelectionSnapshot {
      const dataState = useDataStore.getState()
      const gridSelection = dataState.gridSelection
      const currentDataset = dataState.currentDataset
      return {
        selectedRowCount: gridSelection.selectedRows.length,
        selectedColumnCount: gridSelection.selectedColumns.length,
        allRowsSelected: Boolean(gridSelection.allRowsSelected),
        allColumnsSelected: Boolean(gridSelection.allColumnsSelected),
        includesAddColumn:
          gridSelection.selectedColumns.includes('__add_column__'),
        dataRowCount: currentDataset?.dataRowCount ?? 0,
        rowCount: currentDataset?.rowCount ?? 0,
      }
    },

    getDisplayGridSurfaceState(): DisplayGridSurfaceSnapshot {
      const surface =
        (
          window as Window & {
            __E2E_DISPLAY_SURFACE__?: DisplayGridSurfaceSnapshot
          }
        ).__E2E_DISPLAY_SURFACE__ ?? null
      return (
        surface ?? {
          committedDatasetId: resolveDisplayDatasetId(),
          pendingDatasetId: null,
          pendingSurfaceStatus: 'committed',
          token: null,
        }
      )
    },

    async triggerUndo(): Promise<boolean> {
      const bridged = resolveGridBridge()
      if (bridged) {
        return await bridged.bridge.undo()
      }
      const dataset = resolveDatasetForGrid()
      if (!dataset) return false
      const operation = await undoService.undo(dataset.id)
      return operation !== null
    },

    async triggerRedo(): Promise<boolean> {
      const bridged = resolveGridBridge()
      if (bridged) {
        return await bridged.bridge.redo()
      }
      const dataset = resolveDatasetForGrid()
      if (!dataset) return false
      const operation = await undoService.redo(dataset.id)
      return operation !== null
    },

    async triggerGridSelectAll(datasetId?: string): Promise<boolean> {
      const bridged = resolveGridBridge(datasetId)
      if (!bridged) {
        throw new Error('Grid bridge unavailable for triggerGridSelectAll')
      }
      return await bridged.bridge.selectAll()
    },

    async copyGridRangeAsTsv(args: {
      datasetId?: string
      startRow: number
      startCol: number
      rowCount: number
      colCount: number
    }): Promise<string> {
      const bridged = resolveGridBridge(args.datasetId)
      if (!bridged) {
        throw new Error('Grid bridge unavailable for copyGridRangeAsTsv')
      }
      return await bridged.bridge.copyRangeAsTsv(
        args.startRow,
        args.startCol,
        args.rowCount,
        args.colCount
      )
    },

    async executeGridPaste(args: {
      datasetId?: string
      anchorRow: number
      anchorCol: number
      tsv: string
    }): Promise<number> {
      const bridged = resolveGridBridge(args.datasetId)
      if (!bridged) {
        throw new Error('Grid bridge unavailable for executeGridPaste')
      }
      return await bridged.bridge.executePasteAt(
        args.anchorRow,
        args.anchorCol,
        args.tsv
      )
    },

    async selectGridCell(args: {
      datasetId?: string
      rowIndex: number
      columnIndex: number
    }): Promise<boolean> {
      const bridged = resolveGridBridge(args.datasetId)
      if (!bridged) {
        return false
      }
      return await bridged.bridge.selectCell(args.rowIndex, args.columnIndex)
    },

    async scrollGridToCell(args: {
      datasetId?: string
      rowIndex: number
      columnIndex: number
    }): Promise<boolean> {
      const bridged = resolveGridBridge(args.datasetId)
      if (!bridged) {
        return false
      }
      return await bridged.bridge.scrollToCell(args.rowIndex, args.columnIndex)
    },

    async focusGridSurface(datasetId?: string): Promise<boolean> {
      const bridged = resolveGridBridge(datasetId)
      if (!bridged) {
        return false
      }
      return await bridged.bridge.focusSurface()
    },

    async getGridActiveCell(datasetId?: string): Promise<{
      rowIndex: number
      columnIndex: number
      columnId: string
    } | null> {
      const bridged = resolveGridBridge(datasetId)
      if (!bridged) {
        return null
      }
      return await bridged.bridge.getActiveCell()
    },

    async getGridEditSession(datasetId?: string): Promise<{
      active: boolean
      rowIndex: number
      columnIndex: number
      source: 'bar' | 'cell'
    } | null> {
      const bridged = resolveGridBridge(datasetId)
      if (!bridged) {
        return null
      }
      return await bridged.bridge.getEditSession()
    },

    async getGridCopyContext(datasetId?: string): Promise<{
      copyOpId: string
      sourceDatasetId: string
      clipboardText: string
    } | null> {
      const bridged = resolveGridBridge(datasetId)
      if (!bridged) {
        return null
      }
      return await bridged.bridge.getCopyContext()
    },

    async seedGridCopyContext(args: {
      datasetId?: string
      clipboardText: string
    }): Promise<{
      copyOpId: string
      sourceDatasetId: string
      clipboardText: string
    } | null> {
      const bridged = resolveGridBridge(args.datasetId)
      if (!bridged) {
        throw new Error('Grid bridge unavailable for seedGridCopyContext')
      }
      return await bridged.bridge.seedCopyContext(args.clipboardText)
    },

    async clearDeviceAuthState(options?: {
      clearFingerprint?: boolean
      showWelcome?: boolean
    }): Promise<void> {
      await clearDeviceAuthState(options)
    },

    getDeviceAuthSnapshot(): E2EDeviceAuthSnapshot {
      return getDeviceAuthSnapshot()
    },

    setFirstLaunchState(showWelcome: boolean): void {
      setFirstLaunchState(showWelcome)
    },

    openPreferencesDialog(): void {
      useUIStore.getState().setPreferencesOpen(true)
    },

    openRemoteJoinLink(url: string): void {
      useRemoteJoinUrlStore.getState().setPendingUrl(url)
    },

    getRemoteJoinLinkSnapshot(): {
      activePreferencesPane: ReturnType<
        typeof useUIStore.getState
      >['activePreferencesPane']
      dialogOpen: boolean
      pendingUrl: string | null
      preferencesOpen: boolean
    } {
      const uiState = useUIStore.getState()
      const joinState = useRemoteJoinUrlStore.getState()
      return {
        activePreferencesPane: uiState.activePreferencesPane,
        dialogOpen: joinState.dialogOpen,
        pendingUrl: joinState.pendingUrl,
        preferencesOpen: uiState.preferencesOpen,
      }
    },

    getRemoteCaptureBackend(): E2ERemoteCaptureBackendSnapshot {
      const e2eMockEnabled = isE2ERemoteCaptureMockEnabled()
      const nativeSupported = isNativeRemoteCaptureSupported()
      return {
        e2eMockEnabled,
        nativeSupported,
        preferredBackend: e2eMockEnabled
          ? 'e2e-mock'
          : nativeSupported
            ? 'native'
            : 'unavailable',
      }
    },

    async probeNativeCapture(): Promise<{
      firstTrackKind: string | null
      trackCount: number
    }> {
      const previousMock = window.__E2E_REMOTE_CAPTURE_MOCK__
      window.__E2E_REMOTE_CAPTURE_MOCK__ = false
      let stream: MediaStream | null = null
      try {
        stream = await getRemoteCaptureStream()
        const tracks = stream.getTracks()
        return {
          firstTrackKind: tracks[0]?.kind ?? null,
          trackCount: tracks.length,
        }
      } finally {
        stream?.getTracks().forEach(track => track.stop())
        window.__E2E_REMOTE_CAPTURE_MOCK__ = previousMock
        if (stream) {
          await new Promise(resolve => window.setTimeout(resolve, 300))
        }
      }
    },

    async getNativeCaptureGeometryExpectation(): Promise<E2ENativeCaptureGeometryExpectation> {
      const appWindow = getCurrentWindow()
      const [position, size, monitor] = await Promise.all([
        appWindow.innerPosition(),
        appWindow.innerSize(),
        currentMonitor(),
      ])
      if (!monitor) {
        throw new Error('Current monitor is unavailable')
      }

      return expectedNativeCaptureGeometry(
        {
          left: Math.round(position.x),
          top: Math.round(position.y),
          width: Math.round(size.width),
          height: Math.round(size.height),
        },
        {
          left: Math.round(monitor.position.x),
          top: Math.round(monitor.position.y),
          width: Math.round(monitor.size.width),
          height: Math.round(monitor.size.height),
        }
      )
    },

    async getNativeCaptureViewportContract(): Promise<E2ENativeCaptureViewportContract> {
      const size = await getCurrentWindow().innerSize()
      const devicePixelRatio = window.devicePixelRatio || 1
      const physicalWidth = Math.round(window.innerWidth * devicePixelRatio)
      const physicalHeight = Math.round(window.innerHeight * devicePixelRatio)
      return {
        devicePixelRatio,
        innerSize: {
          height: Math.round(size.height),
          width: Math.round(size.width),
        },
        matches:
          Math.abs(physicalWidth - Math.round(size.width)) <= 1 &&
          Math.abs(physicalHeight - Math.round(size.height)) <= 1,
        viewport: {
          cssHeight: window.innerHeight,
          cssWidth: window.innerWidth,
          physicalHeight,
          physicalWidth,
        },
      }
    },

    async probeNativeMicCapture(): Promise<E2ENativeMicProbeResult> {
      const onAudio = new Channel<ArrayBuffer | Uint8Array>()
      let captureId: string | null = null
      let stopRequested = false
      let packetTimeout: number | null = null
      let packetCount = 0
      const packetPromise = new Promise<ArrayBuffer | Uint8Array>((resolve, reject) => {
        packetTimeout = window.setTimeout(
          () => reject(new Error('Timed out waiting for native mic packet')),
          5_000
        )
        onAudio.onmessage = payload => {
          packetCount += 1
          if (packetTimeout !== null) {
            window.clearTimeout(packetTimeout)
            packetTimeout = null
          }
          resolve(payload)
        }
      })
      const stopCapture = async () => {
        if (!captureId || stopRequested) return
        stopRequested = true
        await invoke('stop_native_mic_capture', { captureId }).catch(
          () => undefined
        )
      }

      try {
        const start = await invoke<{
          capture_id: string
          capture_sample_rate?: number
          output_frames_per_chunk?: number
          rubato_resampler_active?: boolean
          sample_rate: number
          source_kind: string
        }>('start_native_mic_capture', { onAudio })
        captureId = start.capture_id
        const packet = await packetPromise
        await new Promise(resolve => window.setTimeout(resolve, 300))
        const bytes =
          packet instanceof Uint8Array ? packet : new Uint8Array(packet)
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (bytes.byteLength < 16) {
          throw new Error(`Native mic packet was too small: ${bytes.byteLength}`)
        }
        return {
          captureSampleRate: start.capture_sample_rate ?? start.sample_rate,
          outputFramesPerChunk: start.output_frames_per_chunk ?? null,
          packetCount,
          packetFrameCount: view.getUint32(8, true),
          packetSampleRate: view.getUint32(0, true),
          rubatoResamplerActive: start.rubato_resampler_active === true,
          sampleRate: start.sample_rate,
          sourceKind: start.source_kind,
        }
      } finally {
        if (packetTimeout !== null) {
          window.clearTimeout(packetTimeout)
        }
        onAudio.onmessage = () => undefined
        await stopCapture()
      }
    },

    async isCurrentWindowVisible(): Promise<boolean> {
      return await getCurrentWindow().isVisible()
    },

    async captureNativeWindowScreenshot(
      outputPath: string
    ): Promise<E2ENativeWindowScreenshotResult> {
      const restoreCaptureExclusion = isMediaVisibleState(
        remoteWebRtcClient.getConnectionState()
      )
      if (restoreCaptureExclusion) {
        await invoke('set_remote_window_capture_exclusion', {
          excluded: false,
        })
      }
      try {
        return await invoke<E2ENativeWindowScreenshotResult>(
          'capture_native_window_screenshot',
          { outputPath }
        )
      } finally {
        if (restoreCaptureExclusion) {
          await invoke('set_remote_window_capture_exclusion', {
            excluded: true,
          }).catch(() => undefined)
        }
      }
    },

    async setWindowLogicalSize(width: number, height: number): Promise<void> {
      await getCurrentWindow().setSize(new LogicalSize(width, height))
      await new Promise(resolve => window.setTimeout(resolve, 250))
    },

    async setWindowLogicalPosition(x: number, y: number): Promise<void> {
      await getCurrentWindow().setPosition(new LogicalPosition(x, y))
      await new Promise(resolve => window.setTimeout(resolve, 250))
    },

    async maximizeWindow(): Promise<void> {
      await getCurrentWindow().maximize()
      await new Promise(resolve => window.setTimeout(resolve, 250))
    },

    async restoreWindow(): Promise<void> {
      const appWindow = getCurrentWindow()
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize()
      }
      await new Promise(resolve => window.setTimeout(resolve, 250))
    },

    async startRemoteSession(
      identity: RemoteSessionIdentity,
      mode?: 'lan' | 'cloud'
    ): Promise<unknown> {
      return await useRemoteSessionStore.getState().startHosting(identity, mode)
    },

    async getRemoteSessionStatus(): Promise<RemoteSessionStatus> {
      return await useRemoteSessionStore.getState().refreshStatus()
    },

    getRemoteSessionSnapshot(): {
      status: RemoteSessionStatus | null
      inviteShareUrl: string | null
      pendingGuestDeviceId: string | null
      approvedGuestDeviceId: string | null
      error: string | null
      sessionWarning: RemoteSessionLimitWarning | null
      idleWarning: RemoteSessionLimitWarning | null
      isHost: boolean
      isGuest: boolean
      hostSecurityCode: string | null
      guestSecurityCode: string | null
      guestConnectionState: ReturnType<typeof remoteWebRtcClient.getConnectionState>
      guestConnectionMessage: ReturnType<
        typeof remoteWebRtcClient.getConnectionMessage
      >
      hostInputDiagnostics: ReturnType<typeof remoteWebRtcHost.getInputDiagnostics>
      hostMediaDiagnostics: RemoteMediaDiagnostics
      hostPeerConnectionDiagnostics: ReturnType<
        typeof remoteWebRtcHost.getPeerConnectionDiagnostics
      >
      hostSignalingDiagnostics: ReturnType<
        typeof remoteWebRtcHost.getSignalingDiagnostics
      >
      guestSignalingDiagnostics: ReturnType<
        typeof remoteWebRtcClient.getSignalingDiagnostics
      >
      hostAudioDiagnostics: ReturnType<
        typeof remoteWebRtcHost.getAudioDiagnostics
      >
      guestAudioDiagnostics: ReturnType<
        typeof remoteWebRtcClient.getAudioDiagnostics
      >
      hostAudioElementState: ReturnType<typeof readRemoteAudioElementState>
      guestAudioElementState: ReturnType<typeof readRemoteAudioElementState>
    } {
      const state = useRemoteSessionStore.getState()
      return {
        status: state.status,
        inviteShareUrl: state.invite?.share_url ?? null,
        pendingGuestDeviceId: state.pendingGuest?.guest_device_id ?? null,
        approvedGuestDeviceId: state.approvedGuest?.guest_device_id ?? null,
        error: state.error,
        sessionWarning: state.sessionWarning,
        idleWarning: state.idleWarning,
        isHost: state.isHost,
        isGuest: state.isGuest,
        hostSecurityCode: remoteWebRtcHost.getSecurityCode(),
        guestSecurityCode: remoteWebRtcClient.getSecurityCode(),
        guestConnectionState: remoteWebRtcClient.getConnectionState(),
        guestConnectionMessage: remoteWebRtcClient.getConnectionMessage(),
        hostInputDiagnostics: remoteWebRtcHost.getInputDiagnostics(),
        hostMediaDiagnostics: remoteWebRtcHost.getMediaDiagnostics(),
        hostPeerConnectionDiagnostics:
          remoteWebRtcHost.getPeerConnectionDiagnostics(),
        hostSignalingDiagnostics: remoteWebRtcHost.getSignalingDiagnostics(),
        guestSignalingDiagnostics:
          remoteWebRtcClient.getSignalingDiagnostics(),
        hostAudioDiagnostics: remoteWebRtcHost.getAudioDiagnostics(),
        guestAudioDiagnostics: remoteWebRtcClient.getAudioDiagnostics(),
        hostAudioElementState: readRemoteAudioElementState(
          'remote-host-audio-output'
        ),
        guestAudioElementState: readRemoteAudioElementState(
          'remote-guest-audio-output'
        ),
      }
    },

    triggerRemoteSessionLimitWarning(secondsRemaining = 300): boolean {
      const warning = createCurrentRemoteLimitWarning(secondsRemaining)
      if (!warning) {
        return false
      }
      useRemoteSessionStore.getState().setSessionWarning(warning)
      return true
    },

    triggerRemoteSessionLimitExpired(): boolean {
      const warning = createCurrentRemoteLimitWarning(0, Date.now() - 1000)
      if (!warning) {
        return false
      }
      useRemoteSessionStore.getState().setSessionWarning(warning)
      return true
    },

    triggerRemoteIdleWarning(secondsRemaining = 60): boolean {
      const warning = createCurrentRemoteLimitWarning(secondsRemaining)
      if (!warning) {
        return false
      }
      useRemoteSessionStore.getState().setIdleWarning(warning)
      return true
    },

    triggerRemoteIdleExpired(): boolean {
      const warning = createCurrentRemoteLimitWarning(0, Date.now() - 1000)
      if (!warning) {
        return false
      }
      useRemoteSessionStore.getState().setIdleWarning(warning)
      return true
    },

    async approveRemoteSessionGuest(guestDeviceId: string) {
      return await useRemoteSessionStore.getState().approveGuest(guestDeviceId)
    },

    async rejectRemoteSessionGuest(guestDeviceId: string) {
      return await useRemoteSessionStore.getState().rejectGuest(guestDeviceId)
    },

    async revokeRemoteSession() {
      return await useRemoteSessionStore.getState().revoke()
    },

    async revokeRemoteSessionFromHost(): Promise<RemoteSessionStatus> {
      const session =
        useRemoteSessionStore.getState().status?.current_session ?? null
      if (session?.mode === 'cloud') {
        await remoteWebRtcHost.close(true).catch(() => undefined)
        return await useRemoteSessionStore.getState().revoke()
      }
      const status = await useRemoteSessionStore.getState().revoke()
      await remoteWebRtcHost.close(false).catch(() => undefined)
      return status
    },

    async revokeRemoteSessionFromHostControls(): Promise<void> {
      await emit(REMOTE_HOST_CONTROLS_COMMAND_EVENT, { type: 'revoke' })
    },

    async stopRemoteSession(): Promise<void> {
      await useRemoteSessionStore.getState().stopHosting()
    },

    async closeRemoteHostControlsWindow(): Promise<void> {
      await closeRemoteHostControlsWindowResource()
    },

    async enableHostRemoteAudio(): Promise<void> {
      const audio = document.querySelector(
        '[data-testid="remote-host-audio-output"]'
      )
      useRemoteSessionStore.getState().setAudioState({ connecting: true })
      try {
        if (audio instanceof HTMLAudioElement) {
          try {
            await audio.play()
            useRemoteSessionStore
              .getState()
              .setAudioState({ remotePlaybackEnabled: true })
          } catch {
            useRemoteSessionStore
              .getState()
              .setAudioState({ remotePlaybackEnabled: false })
          }
        }
        await remoteWebRtcHost.enableAudio()
        useRemoteSessionStore.getState().setAudioState({
          connecting: false,
          localEnabled: true,
          localMuted: false,
        })
      } catch (error) {
        useRemoteSessionStore.getState().setAudioState({
          connecting: false,
          localEnabled: false,
          remotePlaybackEnabled: false,
        })
        throw error
      }
    },

    async stopHostRemoteAudio(): Promise<void> {
      try {
        await remoteWebRtcHost.disableAudio()
      } finally {
        const audio = document.querySelector(
          '[data-testid="remote-host-audio-output"]'
        )
        if (audio instanceof HTMLAudioElement) {
          audio.pause()
        }
        useRemoteSessionStore.getState().setAudioState({
          connecting: false,
          localEnabled: false,
          localMuted: false,
          remotePlaybackEnabled: false,
        })
      }
    },

    async toggleHostRemoteAudioMute(): Promise<void> {
      const muted = !useRemoteSessionStore.getState().audioState.localMuted
      await remoteWebRtcHost.setAudioMuted(muted)
      useRemoteSessionStore.getState().setAudioState({ localMuted: muted })
    },

    setRemoteCaptureMock(enabled: boolean): void {
      window.__E2E_REMOTE_CAPTURE_MOCK__ = enabled
      window.__E2E__?.setHostControlsSuppressed(enabled)
    },

    setHostControlsSuppressed(enabled: boolean): void {
      window.__E2E_REMOTE_HOST_CONTROLS_SUPPRESSED__ = enabled
    },

    setRemoteAudioMock(enabled: boolean): void {
      window.__E2E_REMOTE_AUDIO_MOCK__ = enabled
    },

    setNativeRemoteAudioMock(enabled: boolean): void {
      window.__E2E_NATIVE_REMOTE_AUDIO_MOCK__ = enabled
    },

    setRemoteAudioMockFrequency(frequencyHz: number): void {
      window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ = frequencyHz
    },

    async waitForRemoteDataChannelOpen(timeoutMs?: number): Promise<void> {
      await remoteWebRtcHost.waitForDataChannelOpen(timeoutMs)
    },

    async getRemoteWebRtcStats(role: 'host' | 'guest' = 'host') {
      return role === 'guest'
        ? await remoteWebRtcClient.getPeerConnectionStats()
        : await remoteWebRtcHost.getPeerConnectionStats()
    },

    sendRemoteMouseInput(event: RemoteInputMouseEventPayload): void {
      remoteWebRtcClient.sendInputMessage({ type: 'mouse', event })
    },

    /**
     * Clear all RNA-seq projects
     */
    async clearAllRNAseq(): Promise<void> {
      console.log('[E2E] Clearing all RNA-seq projects')
      await useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
      console.log('[E2E] RNA-seq projects cleared')
    },

    /**
     * Import a tabular data file. Kept as importCSV for existing E2E callers.
     * @param csvPath - Absolute path to CSV/TSV/TXT file
     */
    async importCSV(csvPath: string): Promise<string> {
      const lowerPath = csvPath.toLowerCase()
      const isTsvLike = lowerPath.endsWith('.tsv') || lowerPath.endsWith('.txt')
      console.log(`[E2E] Importing ${isTsvLike ? 'TSV' : 'CSV'}: ${csvPath}`)
      await ensureProjectId()

      const result = isTsvLike
        ? await tauriApi.importTsv(csvPath)
        : await tauriApi.importCsv(csvPath)

      const sourcePath = result.sourcePath ?? csvPath
      const originalColumns = result.dataset.columns as ColumnMetadata[]
      const extendedColumns = extendColumns(originalColumns)
      const dataRowCount = result.dataset.rowCount
      const rowCount = Math.max(dataRowCount + ROW_BUFFER, MIN_ROWS)

      const dataset: Dataset = {
        ...result.dataset,
        columns: extendedColumns,
        columnCount: extendedColumns.length,
        rowCount,
        dataRowCount,
        importedAt: new Date(result.dataset.importedAt),
        modifiedAt: new Date(result.dataset.modifiedAt),
        filePath: sourcePath,
      }

      const dataStore = useDataStore.getState()
      dataStore.addDataset(dataset)
      dataStore.setCurrentDataset(dataset)

      const appStore = useAppStore.getState()
      if (appStore.activeFamilyId) {
        appStore.setActiveFamilyDataset(
          appStore.activeFamilyId,
          dataset.id,
          true
        )
      } else {
        appStore.updateActiveFamilyData(dataset.id)
      }

      console.log(`[E2E] ${isTsvLike ? 'TSV' : 'CSV'} imported: ${csvPath} (datasetId=${dataset.id})`)
      return dataset.id
    },

    /**
     * Save project as .ecp file (minimal snapshot for E2E testing)
     * @param ecpPath - Absolute path for .ecp file
     */
    async saveProject(ecpPath: string): Promise<void> {
      console.log(`[E2E] Saving project: ${ecpPath}`)

      const nowIso = new Date().toISOString()
      const { datasets } = useDataStore.getState()

      // Build minimal project snapshot with current datasets
      const project = {
        version: 1,
        name: ecpPath.split(/[\\/]/).pop()?.replace('.ecp', '') || 'E2E Test',
        createdAt: nowIso,
        modifiedAt: nowIso,
        datasets: datasets.map(ds => ({
          id: ds.id,
          name: ds.name,
          filePath: ds.filePath,
          columns: ds.columns.map(col => ({
            id: col.id,
            name: col.name,
            type: col.type,
          })),
          importedAt: ds.importedAt.toISOString(),
          modifiedAt: ds.modifiedAt.toISOString(),
        })),
        families: [],
        results: [],
      }

      const json = JSON.stringify(project, null, 2)
      await writeTextFile(ecpPath, json)
      console.log(`[E2E] Project saved: ${ecpPath}`)
    },

    /**
     * Create a new RNA-seq project with blank scaffold datasets and return its ID.
     */
    async createRNAseqProject(name: string): Promise<string> {
      const project = await useRNAseqStore
        .getState()
        .createProjectWithBootstrap(name)
      useRNAseqStore.getState().setActiveProject(project.id)
      return project.id
    },

    /**
     * Set the active RNA-seq tab for a project.
     */
    async setRNAseqActiveTab({
      projectId,
      tab,
    }: {
      projectId: string
      tab: 'counts' | 'metadata' | 'results' | 'plots'
    }): Promise<void> {
      useRNAseqStore.getState().setActiveTab(projectId, tab)
    },

    /**
     * Set the active RNA-seq plot type for a project.
     */
    async setRNAseqActivePlot({
      projectId,
      plotType,
    }: {
      projectId: string
      plotType: 'pca_biplot' | 'volcano' | 'heatmap' | 'deg_bar' | 'ma_plot'
    }): Promise<void> {
      useRNAseqStore.getState().setActivePlot(projectId, plotType)
    },

    /**
     * Link datasets to an RNA-seq project.
     */
    async linkRNAseqDatasets({
      projectId,
      countsDatasetId,
      metadataDatasetId,
    }: {
      projectId: string
      countsDatasetId: string
      metadataDatasetId: string
    }): Promise<void> {
      const store = useRNAseqStore.getState()
      await store.replaceCountsDataset(projectId, countsDatasetId)
      await store.replaceMetadataDataset(projectId, metadataDatasetId)
      store.setActiveProject(projectId)
    },

    /**
     * Run RNA-seq PyDESeq2 analysis via the service layer.
     */
    async runRNAseqAnalysis({
      projectId,
      model,
    }: {
      projectId: string
      model: Parameters<typeof rnaseqService.runDESeq2Analysis>[2]
    }): Promise<string | null> {
      const rnaseqStore = useRNAseqStore.getState()
      const project = rnaseqStore.getProject(projectId)
      if (!project) {
        throw new Error(`RNA-seq project not found: ${projectId}`)
      }

      const { datasets } = useDataStore.getState()
      const countsDataset = datasets.find(d => d.id === project.countsDatasetId)
      const metadataDataset = datasets.find(
        d => d.id === project.metadataDatasetId
      )
      if (!countsDataset || !metadataDataset) {
        throw new Error('RNA-seq datasets are not linked')
      }

      rnaseqStore.addModel(projectId, model)
      rnaseqStore.setActiveModel(projectId, model.id)
      rnaseqStore.setActiveProject(projectId)

      const result = await rnaseqService.runDESeq2Analysis(
        countsDataset,
        metadataDataset,
        model
      )

      rnaseqStore.setResult(projectId, model.id, result)
      rnaseqStore.setActiveTab(projectId, 'results')
      rnaseqStore.setActivePlot(projectId, project.activePlotType ?? 'volcano')

      return rnaseqStore.getProject(projectId)?.activeResultId ?? null
    },

    /**
     * Get RNA-seq store state (for debugging/validation)
     */
    getRNAseqStore() {
      return useRNAseqStore.getState()
    },

    /**
     * Export RNA-seq gene results to CSV without dialogs.
     */
    async exportRNAseqResultsCsv({
      projectId,
      resultId,
      outputPath,
    }: {
      projectId: string
      resultId?: string | null
      outputPath: string
    }): Promise<string> {
      const rnaseqStore = useRNAseqStore.getState()
      const run =
        (resultId ? rnaseqStore.getResult(projectId, resultId) : null) ??
        (rnaseqStore.getProject(projectId)?.activeResultId
          ? rnaseqStore.getResult(
              projectId,
              rnaseqStore.getProject(projectId)!.activeResultId!
            )
          : null)

      if (!run) {
        throw new Error('RNA-seq result not found for export')
      }

      const rows = run.genes.map(gene => ({
        geneId: gene.geneId,
        geneSymbol: gene.geneSymbol,
        baseMean: gene.baseMean,
        log2FoldChange: gene.log2FoldChange,
        lfcSE: gene.lfcSE,
        stat: gene.stat,
        pvalue: gene.pvalue,
        padj: gene.padj,
        significant: gene.significant,
        direction: gene.direction,
        sigCategory: gene.sigCategory,
      }))

      const columns = [
        'geneId',
        'geneSymbol',
        'baseMean',
        'log2FoldChange',
        'lfcSE',
        'stat',
        'pvalue',
        'padj',
        'significant',
        'direction',
        'sigCategory',
      ]

      await exportService.exportDataToCsv(rows, columns, outputPath)
      console.log(`[E2E] RNA-seq results exported: ${outputPath}`)
      return outputPath
    },

    /**
     * Export dose-response batch interpolation results to CSV without dialogs.
     */
    async exportDoseInterpolationResultsCsv({
      outputPath,
      plotId,
    }: {
      outputPath: string
      plotId?: string
    }): Promise<string> {
      const { plots, activePlotId, computedStats } = usePlotsStore.getState()
      const targetPlotId = plotId ?? activePlotId
      const plot =
        (targetPlotId
          ? plots.find(entry => entry.id === targetPlotId)
          : null) ??
        plots[0] ??
        null

      if (!plot) {
        throw new Error('No plot available for interpolation CSV export')
      }

      const stats = computedStats[plot.id]
      if (!stats) {
        throw new Error('Interpolation stats unavailable for active plot')
      }

      const rawResults = stats.interpolation_results_json
      if (typeof rawResults !== 'string' || rawResults.trim().length === 0) {
        throw new Error('Batch interpolation results are empty')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawResults)
      } catch {
        throw new Error('Batch interpolation results are malformed')
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(
          'Batch interpolation results are not available for export'
        )
      }

      const rows = parsed.map((entry: unknown, index: number) => {
        const rowData = entry as Record<string, unknown>
        const inputRaw = rowData?.input
        const outputRaw = rowData?.output
        const input =
          typeof inputRaw === 'number'
            ? inputRaw
            : typeof inputRaw === 'string' && inputRaw.trim().length > 0
              ? Number(inputRaw)
              : Number.NaN
        const output =
          typeof outputRaw === 'number'
            ? outputRaw
            : typeof outputRaw === 'string' && outputRaw.trim().length > 0
              ? Number(outputRaw)
              : Number.NaN
        const statusRaw =
          typeof rowData?.status === 'string' ? rowData.status : 'invalid_input'
        const status =
          statusRaw === 'stability_guardrail' ? 'guardrail' : statusRaw
        const extrapolatedValue =
          rowData?.extrapolated === true || rowData?.extrapolated === 'true'
        const message =
          typeof rowData?.message === 'string' &&
          rowData.message.trim().length > 0
            ? rowData.message
            : status === 'ok'
              ? 'Interpolation completed.'
              : 'Interpolation could not be computed.'

        return {
          row: index + 1,
          input: Number.isFinite(input) ? input : '',
          output: Number.isFinite(output) ? output : '',
          status,
          extrapolated: extrapolatedValue ? 'yes' : 'no',
          message,
        }
      })

      const columns = [
        'row',
        'input',
        'output',
        'status',
        'extrapolated',
        'message',
      ]
      await exportService.exportDataToCsv(rows, columns, outputPath)
      console.log(`[E2E] Dose interpolation results exported: ${outputPath}`)
      return outputPath
    },

    /**
     * Export RNA-seq plot to PNG (E2E only, with plotData fallback like component export).
     */
    async exportRNAseqPlotPng({
      projectId,
      outputPath,
      dpi = 300,
    }: {
      projectId: string
      outputPath: string
      dpi?: number
    }): Promise<string> {
      const isForbiddenPathError = (error: unknown): boolean => {
        const message =
          (error as { message?: unknown })?.message ??
          (error as { toString?: () => string })?.toString?.() ??
          ''
        return String(message).toLowerCase().includes('forbidden path')
      }

      let canWriteOutput = true
      try {
        const outputDir = await dirname(outputPath)
        const dirExists = await exists(outputDir)
        if (!dirExists) {
          await mkdir(outputDir, { recursive: true })
        }
      } catch (error) {
        if (isForbiddenPathError(error)) {
          canWriteOutput = false
        } else {
          throw error
        }
      }

      const rnaseqStore = useRNAseqStore.getState()
      const project = rnaseqStore.getProject(projectId)
      if (!project) {
        throw new Error(`RNA-seq project not found: ${projectId}`)
      }

      const result = project.activeResultId
        ? rnaseqStore.getResult(projectId, project.activeResultId)
        : null

      if (!result) {
        throw new Error('RNA-seq result not found for plot export')
      }

      const plotStatsNode =
        (document.querySelector(
          '.rnaseq-plot [data-plot-stats]'
        ) as HTMLElement | null) ??
        (document.querySelector('[data-plot-stats]') as HTMLElement | null)

      const plotTypeFromDom =
        plotStatsNode?.getAttribute('data-plot-type') ?? null
      // Fall back to store if the DOM isn't mounted yet.
      const plotType = (plotTypeFromDom ||
        project.activePlotType ||
        'volcano') as
        | 'volcano'
        | 'ma_plot'
        | 'deg_bar'
        | 'pca_biplot'
        | 'heatmap'

      const stats: Record<string, number> = {}
      if (plotStatsNode) {
        for (const attr of Array.from(plotStatsNode.attributes)) {
          if (!attr.name.startsWith('data-')) continue
          if (attr.name === 'data-plot-stats' || attr.name === 'data-plot-type')
            continue
          const key = attr.name.replace(/^data-/, '').replace(/-/g, '_')
          const value = parseFloat(attr.value)
          if (!Number.isNaN(value)) {
            stats[key] = value
          }
        }
      }

      const boolFromStat = (key: string, fallback: boolean) => {
        const v = stats[key]
        if (typeof v === 'number') return v === 1
        return fallback
      }
      const numFromStat = (key: string, fallback: number) => {
        const v = stats[key]
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback
      }

      // Match the UI defaults/controls by reading settings from the plot-stats node (if present).
      const usePadj =
        plotType === 'volcano'
          ? boolFromStat('volcano_use_padj', true)
          : plotType === 'ma_plot'
            ? boolFromStat('ma_use_padj', true)
            : plotType === 'heatmap'
              ? boolFromStat('heatmap_use_padj', true)
              : true

      const pvalueThreshold =
        plotType === 'volcano'
          ? numFromStat('volcano_pval_threshold', 0.05)
          : plotType === 'ma_plot'
            ? numFromStat('ma_pval_threshold', 0.05)
            : 0.05

      const lfcThreshold =
        plotType === 'volcano'
          ? numFromStat('volcano_lfc_threshold', 1.0)
          : plotType === 'ma_plot'
            ? numFromStat('ma_lfc_threshold', 1.0)
            : 1.0

      const nLabels = numFromStat('volcano_label_count', 10)

      const ellipseTypeCode = numFromStat('pca_ellipse_type', 1)
      const ellipseType =
        ellipseTypeCode === 2 ? 'norm' : ellipseTypeCode === 3 ? 'euclid' : 't'
      const ellipseLevel =
        plotType === 'pca_biplot'
          ? numFromStat('pca_ellipse_level', 0.95)
          : 0.95

      const nTopGenes =
        plotType === 'heatmap'
          ? Math.round(numFromStat('heatmap_top_genes', 50))
          : 50
      const clusterRows =
        plotType === 'heatmap'
          ? boolFromStat('heatmap_cluster_rows', true)
          : true
      const clusterCols =
        plotType === 'heatmap'
          ? boolFromStat('heatmap_cluster_cols', true)
          : true

      // Import the plot builders
      const {
        buildVolcanoPlot,
        buildPCABiplot,
        buildMAPlot,
        buildDEGBarChart,
      } = await import('../components/rnaseq/plots/index.js')

      // Heatmap is rendered via Python/matplotlib, not Plotly
      if (plotType === 'heatmap') {
        if (!result.normalizedCounts || result.normalizedCounts.length === 0) {
          throw new Error('Heatmap requires normalized counts (VST)')
        }

        const sampleIds = result.sampleIds?.length
          ? result.sampleIds
          : Object.keys(result.sizeFactors ?? {})

        const heatmapImage = await rnaseqService.renderHeatmapImage(
          result.genes,
          result.normalizedCounts,
          sampleIds,
          {
            nTopGenes,
            clusterRows,
            clusterCols,
            usePadj,
            spaceColorbar: 0,
          }
        )

        const bytes = dataUrlToBytes(heatmapImage.image)
        if (canWriteOutput) {
          try {
            await writeFile(outputPath, bytes)
            console.log(`[E2E] RNA-seq heatmap exported: ${outputPath}`)
            return outputPath
          } catch (error) {
            if (!isForbiddenPathError(error)) {
              throw error
            }
          }
        }

        return heatmapImage.image
      }

      // Build plotData for Plotly-based plots
      let plotData: { data: any[]; layout: any } | null = null

      switch (plotType) {
        case 'volcano':
          plotData = buildVolcanoPlot(result.genes, {
            pvalueThreshold,
            lfcThreshold,
            nLabels,
            usePadj,
          })
          break
        case 'ma_plot':
          plotData = buildMAPlot(result.genes, {
            pvalueThreshold,
            lfcThreshold,
            usePadj,
          })
          break
        case 'deg_bar':
          plotData = buildDEGBarChart(result.summary, {
            showByThreshold: false,
          })
          break
        case 'pca_biplot':
          if (result.pcaData) {
            const activeModel = project.activeModelId
              ? project.models.find(m => m.id === project.activeModelId)
              : undefined
            const colorBy = activeModel?.mainFactor ?? 'treatment'
            plotData = buildPCABiplot(result.pcaData, {
              showEllipses: true,
              ellipseType,
              ellipseLevel,
              showLabels: true,
              nGeneArrows: 5,
              colorBy,
              shapeBy: undefined,
              thirdBy: undefined,
            })
          }
          break
      }

      if (!plotData) {
        throw new Error(`Plot data not available for ${plotType}`)
      }

      // Load Plotly
      const PlotlyModule = await import('plotly.js/dist/plotly.min.js')
      const Plotly = (PlotlyModule as { default?: any }).default ?? PlotlyModule

      if (!Plotly?.toImage) {
        throw new Error('Plotly.toImage not available')
      }

      const exportWidth = 1400
      const exportHeight = 900
      const scale = dpi >= 600 ? 4 : dpi >= 300 ? 2 : 1

      // Build export layout
      const exportLayout = {
        ...plotData.layout,
        autosize: false,
        width: exportWidth,
        height: exportHeight,
        paper_bgcolor: '#ffffff',
        plot_bgcolor: plotData.layout.plot_bgcolor ?? '#ffffff',
      }

      // Export using object (not DOM) to avoid selector issues
      const exportObj = JSON.parse(
        JSON.stringify({
          data: plotData.data,
          layout: exportLayout,
        })
      )

      const imageDataUrl = await Plotly.toImage(exportObj, {
        format: 'png',
        width: exportWidth,
        height: exportHeight,
        scale,
      })

      const imageData = String(imageDataUrl ?? '')
      const bytes = dataUrlToBytes(imageData)
      if (canWriteOutput) {
        try {
          await writeFile(outputPath, bytes)
          console.log(`[E2E] RNA-seq plot exported: ${outputPath}`)
          return outputPath
        } catch (error) {
          if (!isForbiddenPathError(error)) {
            throw error
          }
        }
      }

      return imageData
    },

    /**
     * Export the active plot to a fixed PNG path (E2E only, no dialogs).
     */
    async exportPlotPng({
      outputPath,
      dpi = 300,
      plotId,
    }: {
      outputPath: string
      dpi?: number
      plotId?: string
    }): Promise<string> {
      const outputDir = await dirname(outputPath)
      const dirExists = await exists(outputDir)
      if (!dirExists) {
        await mkdir(outputDir, { recursive: true })
      }

      const { plots, activePlotId } = usePlotsStore.getState()
      const targetPlotId = plotId ?? activePlotId
      const plot =
        (targetPlotId ? plots.find(p => p.id === targetPlotId) : null) ??
        plots[0]

      const findPlotElement = (): HTMLElement | null => {
        // RNA-seq plots live outside the main plots store; prefer scoping to the RNA-seq plot panel
        // to avoid picking up hidden Plotly elements from other views.
        const rnaseqContainer = document.querySelector('.rnaseq-plot')
        if (rnaseqContainer) {
          return (
            (rnaseqContainer.querySelector(
              '.js-plotly-plot'
            ) as HTMLElement | null) ??
            (rnaseqContainer.querySelector(
              '.plotly-graph-div'
            ) as HTMLElement | null) ??
            (rnaseqContainer.querySelector('.plotly') as HTMLElement | null) ??
            (rnaseqContainer.querySelector(
              '[data-plotly]'
            ) as HTMLElement | null)
          )
        }

        return (
          (document.querySelector(
            '[data-testid="plot-container"] .js-plotly-plot'
          ) as HTMLElement | null) ??
          (document.querySelector(
            '[data-testid="plot-container"] .plotly'
          ) as HTMLElement | null) ??
          (document.querySelector('.js-plotly-plot') as HTMLElement | null) ??
          (document.querySelector('.plotly') as HTMLElement | null)
        )
      }

      // Prefer browser-side export (webview) to match in-app export behavior (RNA-seq uses Plotly.toImage too).
      // Fall back to Kaleido export when Plotly export is unavailable.
      try {
        // react-plotly.js is lazy-loaded in the UI; wait for the graph div to exist.
        const startedAt = Date.now()
        let plotElement: HTMLElement | null = null
        while (!plotElement && Date.now() - startedAt < 30000) {
          plotElement = findPlotElement()
          if (plotElement) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }

        if (!plotElement) {
          const rnaseqContainer = document.querySelector('.rnaseq-plot')
          console.error('[E2E] Plot DOM element not found. Debug info:', {
            hasRnaseqContainer: Boolean(rnaseqContainer),
            rnaseqContainerHTML: rnaseqContainer
              ? rnaseqContainer.innerHTML.substring(0, 200)
              : 'N/A',
            attemptedSelectors: [
              '.js-plotly-plot',
              '.plotly-graph-div',
              '.plotly',
              '[data-plotly]',
            ],
          })
          throw new Error('Plot DOM element not found')
        }

        const isRNAseqPlot = Boolean(document.querySelector('.rnaseq-plot'))

        let width = 1000
        let height = 700
        if (isRNAseqPlot) {
          // Match RNA-seq export defaults (larger canvas for stable label repelling).
          width = 1400
          height = 900
        } else if (plot) {
          const includeAxisOverlay = shouldIncludeAxisOverlay(plot.type)
          const normalizedLayout = applyAxisDefaultsForExport(
            (plot.plotlyLayout as any) ?? {},
            { includeAxisOverlay }
          )
          if (Array.isArray(normalizedLayout.annotations)) {
            normalizedLayout.annotations = normalizedLayout.annotations.map(
              annotation => {
                if (!annotation || typeof annotation !== 'object')
                  return annotation
                const { editable, ...rest } = annotation as Record<
                  string,
                  unknown
                >
                const entry = rest as {
                  name?: string
                  x?: number
                  xanchor?: string
                  xref?: string
                }
                if (entry.name !== '_title_') return rest
                const x =
                  typeof entry.x === 'number' && Number.isFinite(entry.x)
                    ? Math.min(1, Math.max(0, entry.x))
                    : 0.5
                const xanchor =
                  entry.xanchor && entry.xanchor !== 'auto'
                    ? entry.xanchor
                    : 'center'
                return {
                  ...rest,
                  x,
                  xanchor,
                  xref: entry.xref ?? 'paper',
                }
              }
            )
          }
          const layout = normalizedLayout as { width?: number; height?: number }
          width = typeof layout.width === 'number' ? layout.width : width
          height = typeof layout.height === 'number' ? layout.height : height
        } else {
          // If we don't have a plot definition (e.g. RNA-seq only run), use current render size.
          const rect = plotElement.getBoundingClientRect()
          if (Number.isFinite(rect.width) && rect.width > 0)
            width = Math.round(rect.width)
          if (Number.isFinite(rect.height) && rect.height > 0)
            height = Math.round(rect.height)
        }

        const PlotlyModule = await import('plotly.js/dist/plotly.min.js')
        const Plotly =
          (PlotlyModule as { default?: any }).default ?? PlotlyModule
        if (!Plotly?.toImage) {
          throw new Error('Plotly.toImage not available')
        }

        const scale = dpi >= 600 ? 4 : dpi >= 300 ? 2 : 1
        const imageDataUrl = await Plotly.toImage(plotElement, {
          format: 'png',
          width,
          height,
          scale,
        })

        const bytes = dataUrlToBytes(String(imageDataUrl ?? ''))
        await writeFile(outputPath, bytes)

        console.log(`[E2E] Plot exported (webview): ${outputPath}`)
        return outputPath
      } catch (error) {
        const errorDetails = {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Unknown',
          stack: error instanceof Error ? error.stack : undefined,
        }
        console.error('[E2E] Webview plot export failed:', errorDetails)

        // RNA-seq plots don't use usePlotsStore, so we can't fall back to Kaleido.
        // Re-throw the original DOM error with details.
        const isRNAseqPlot = Boolean(document.querySelector('.rnaseq-plot'))
        if (isRNAseqPlot) {
          throw new Error(
            `RNA-seq plot export failed: ${errorDetails.message || 'Unknown error'}`
          )
        }

        console.warn(
          '[E2E] Attempting Kaleido fallback for non-RNA-seq plot...'
        )
      }

      if (!plot) {
        throw new Error('No plot available for Kaleido export')
      }

      const includeAxisOverlay = shouldIncludeAxisOverlay(plot.type)
      const normalizedLayout = applyAxisDefaultsForExport(
        (plot.plotlyLayout as any) ?? {},
        { includeAxisOverlay }
      )
      if (Array.isArray(normalizedLayout.annotations)) {
        normalizedLayout.annotations = normalizedLayout.annotations.map(
          annotation => {
            if (!annotation || typeof annotation !== 'object') return annotation
            const { editable, ...rest } = annotation as Record<string, unknown>
            const entry = rest as {
              name?: string
              x?: number
              xanchor?: string
              xref?: string
            }
            if (entry.name !== '_title_') return rest
            const x =
              typeof entry.x === 'number' && Number.isFinite(entry.x)
                ? Math.min(1, Math.max(0, entry.x))
                : 0.5
            const xanchor =
              entry.xanchor && entry.xanchor !== 'auto'
                ? entry.xanchor
                : 'center'
            return {
              ...rest,
              x,
              xanchor,
              xref: entry.xref ?? 'paper',
            }
          }
        )
      }

      const layout = normalizedLayout as { width?: number; height?: number }
      const width = typeof layout.width === 'number' ? layout.width : 1000
      const height = typeof layout.height === 'number' ? layout.height : 700

      const result = await exportPlotWithKaleido(
        { ...plot, plotlyLayout: normalizedLayout },
        outputPath,
        {
          format: 'png',
          width,
          height,
          dpi,
          transparent: false,
        }
      )

      if (!result.success) {
        throw new Error(result.error || 'Kaleido export failed')
      }

      console.log(`[E2E] Plot exported: ${outputPath}`)
      return outputPath
    },
  }

  console.log('[E2E] Shim loaded - window.__E2E__ available')
}

// TypeScript global augmentation
declare global {
  interface Window {
    __E2E__?: {
      loadFixture(fixturePath: string): Promise<void>
      runTest(testType: string, config: any): Promise<void>
      getDatasetCount(): number
      clearAllData(): Promise<void>
      getFamilyState(): {
        activeFamilyId: string | null
        families: Array<{
          id: string
          name: string
          datasetId: string | null
          hasData: boolean
          hasResults: boolean
        }>
      }
      getAppOperationLockState(): {
        active: boolean
        owner: string | null
        operation: string | null
        progress: number
        indeterminate: boolean
        stage: string
        startedAt: string | null
      }
      acquireE2EOperationLock(): string | null
      releaseE2EOperationLock(token: string): boolean
      setActiveFamily(familyId: string): Promise<boolean>
      getStatisticsResultsSnapshot(): {
        activeStatisticsFamilyId: string | null
        currentResult: unknown
        currentResultIdByFamily: Record<string, string | null>
        results: unknown[]
        resultsByFamily: Record<string, unknown[]>
      }
      getPlotsSnapshot(): {
        activePlotId: string | null
        plots: unknown[]
      }
      applyActiveBarPatternFixture(): { plotId: string; traceCount: number }
      setWorkspaceViewMode(mode: 'data' | 'results' | 'plots'): void
      getGridShape(datasetId?: string): GridShapeSnapshot
      getGridCell(args: {
        datasetId?: string
        rowIndex: number
        columnId?: string
        columnIndex?: number
      }): Promise<GridCellSnapshot>
      getGridVisibleCell(args: {
        datasetId?: string
        rowIndex: number
        columnId?: string
        columnIndex?: number
      }): Promise<GridVisibleCellSnapshot>
      getColumnType(args: {
        datasetId?: string
        columnId?: string
        columnIndex?: number
      }): string | null
      getPersistedColumnIds(datasetId?: string): Promise<string[]>
      getGridSelectionSnapshot(): GridSelectionSnapshot
      getDisplayGridSurfaceState(): DisplayGridSurfaceSnapshot
      getGridActiveCell(datasetId?: string): Promise<{
        rowIndex: number
        columnIndex: number
        columnId: string
      } | null>
      getGridEditSession(datasetId?: string): Promise<{
        active: boolean
        rowIndex: number
        columnIndex: number
        source: 'bar' | 'cell'
      } | null>
      getGridCopyContext(datasetId?: string): Promise<{
        copyOpId: string
        sourceDatasetId: string
        clipboardText: string
      } | null>
      seedGridCopyContext(args: {
        datasetId?: string
        clipboardText: string
      }): Promise<{
        copyOpId: string
        sourceDatasetId: string
        clipboardText: string
      } | null>
      triggerUndo(): Promise<boolean>
      triggerRedo(): Promise<boolean>
      triggerGridSelectAll(datasetId?: string): Promise<boolean>
      copyGridRangeAsTsv(args: {
        datasetId?: string
        startRow: number
        startCol: number
        rowCount: number
        colCount: number
      }): Promise<string>
      executeGridPaste(args: {
        datasetId?: string
        anchorRow: number
        anchorCol: number
        tsv: string
      }): Promise<number>
      selectGridCell(args: {
        datasetId?: string
        rowIndex: number
        columnIndex: number
      }): Promise<boolean>
      scrollGridToCell(args: {
        datasetId?: string
        rowIndex: number
        columnIndex: number
      }): Promise<boolean>
      focusGridSurface(datasetId?: string): Promise<boolean>
      clearDeviceAuthState(options?: {
        clearFingerprint?: boolean
        showWelcome?: boolean
      }): Promise<void>
      getDeviceAuthSnapshot(): E2EDeviceAuthSnapshot
      setFirstLaunchState(showWelcome: boolean): void
      openPreferencesDialog(): void
      openRemoteJoinLink(url: string): void
      getRemoteJoinLinkSnapshot(): {
        activePreferencesPane: ReturnType<
          typeof useUIStore.getState
        >['activePreferencesPane']
        dialogOpen: boolean
        pendingUrl: string | null
        preferencesOpen: boolean
      }
      getRemoteCaptureBackend(): E2ERemoteCaptureBackendSnapshot
      probeNativeCapture(): Promise<{
        firstTrackKind: string | null
        trackCount: number
      }>
      probeNativeMicCapture(): Promise<E2ENativeMicProbeResult>
      getNativeCaptureGeometryExpectation(): Promise<E2ENativeCaptureGeometryExpectation>
      getNativeCaptureViewportContract(): Promise<E2ENativeCaptureViewportContract>
      isCurrentWindowVisible(): Promise<boolean>
      captureNativeWindowScreenshot(
        outputPath: string
      ): Promise<E2ENativeWindowScreenshotResult>
      setWindowLogicalSize(width: number, height: number): Promise<void>
      setWindowLogicalPosition(x: number, y: number): Promise<void>
      maximizeWindow(): Promise<void>
      restoreWindow(): Promise<void>
      startRemoteSession(
        identity: RemoteSessionIdentity,
        mode?: 'lan' | 'cloud'
      ): Promise<unknown>
      getRemoteSessionStatus(): Promise<RemoteSessionStatus>
      getRemoteSessionSnapshot(): {
        status: RemoteSessionStatus | null
        inviteShareUrl: string | null
        pendingGuestDeviceId: string | null
        approvedGuestDeviceId: string | null
        error: string | null
        sessionWarning: RemoteSessionLimitWarning | null
        idleWarning: RemoteSessionLimitWarning | null
        isHost: boolean
        isGuest: boolean
        hostSecurityCode: string | null
        guestSecurityCode: string | null
        guestConnectionState: ReturnType<
          typeof remoteWebRtcClient.getConnectionState
        >
        guestConnectionMessage: ReturnType<
          typeof remoteWebRtcClient.getConnectionMessage
        >
        hostInputDiagnostics: ReturnType<
          typeof remoteWebRtcHost.getInputDiagnostics
        >
        hostMediaDiagnostics: RemoteMediaDiagnostics
        hostPeerConnectionDiagnostics: ReturnType<
          typeof remoteWebRtcHost.getPeerConnectionDiagnostics
        >
        hostSignalingDiagnostics: ReturnType<
          typeof remoteWebRtcHost.getSignalingDiagnostics
        >
        guestSignalingDiagnostics: ReturnType<
          typeof remoteWebRtcClient.getSignalingDiagnostics
        >
        hostAudioDiagnostics: ReturnType<
          typeof remoteWebRtcHost.getAudioDiagnostics
        >
        guestAudioDiagnostics: ReturnType<
          typeof remoteWebRtcClient.getAudioDiagnostics
        >
        hostAudioElementState: ReturnType<typeof readRemoteAudioElementState>
        guestAudioElementState: ReturnType<typeof readRemoteAudioElementState>
      }
      approveRemoteSessionGuest(
        guestDeviceId: string
      ): Promise<RemoteSessionStatus>
      rejectRemoteSessionGuest(
        guestDeviceId: string
      ): Promise<RemoteSessionStatus>
      revokeRemoteSession(): Promise<RemoteSessionStatus>
      revokeRemoteSessionFromHost(): Promise<RemoteSessionStatus>
      revokeRemoteSessionFromHostControls(): Promise<void>
      stopRemoteSession(): Promise<void>
      closeRemoteHostControlsWindow(): Promise<void>
      enableHostRemoteAudio(): Promise<void>
      stopHostRemoteAudio(): Promise<void>
      toggleHostRemoteAudioMute(): Promise<void>
      triggerRemoteSessionLimitWarning(secondsRemaining?: number): boolean
      triggerRemoteSessionLimitExpired(): boolean
      triggerRemoteIdleWarning(secondsRemaining?: number): boolean
      triggerRemoteIdleExpired(): boolean
      setRemoteCaptureMock(enabled: boolean): void
      setHostControlsSuppressed(enabled: boolean): void
      setRemoteAudioMock(enabled: boolean): void
      setNativeRemoteAudioMock(enabled: boolean): void
      setRemoteAudioMockFrequency(frequencyHz: number): void
      waitForRemoteDataChannelOpen(timeoutMs?: number): Promise<void>
      getRemoteWebRtcStats(role?: 'host' | 'guest'): Promise<unknown[]>
      sendRemoteMouseInput(event: RemoteInputMouseEventPayload): void
      clearAllRNAseq(): Promise<void>
      importCSV(csvPath: string): Promise<string>
      saveProject(ecpPath: string): Promise<void>
      createRNAseqProject(name: string): Promise<string>
      setRNAseqActiveTab(args: {
        projectId: string
        tab: 'counts' | 'metadata' | 'results' | 'plots'
      }): Promise<void>
      setRNAseqActivePlot(args: {
        projectId: string
        plotType: 'pca_biplot' | 'volcano' | 'heatmap' | 'deg_bar' | 'ma_plot'
      }): Promise<void>
      linkRNAseqDatasets(args: {
        projectId: string
        countsDatasetId: string
        metadataDatasetId: string
      }): Promise<void>
      runRNAseqAnalysis(args: {
        projectId: string
        model: Parameters<typeof rnaseqService.runDESeq2Analysis>[2]
      }): Promise<string | null>
      getRNAseqStore(): any
      exportRNAseqResultsCsv(args: {
        projectId: string
        resultId?: string | null
        outputPath: string
      }): Promise<string>
      exportDoseInterpolationResultsCsv(args: {
        outputPath: string
        plotId?: string
      }): Promise<string>
      exportRNAseqPlotPng(args: {
        projectId: string
        outputPath: string
        dpi?: number
      }): Promise<string>
      exportPlotPng(options: {
        outputPath: string
        dpi?: number
        plotId?: string
      }): Promise<string>
    }
    __E2E_GRID_BRIDGE__?: Record<string, E2EGridBridge>
    __E2E_DISPLAY_DATASET_ID__?: string | null
    __E2E_DISPLAY_SURFACE__?: DisplayGridSurfaceSnapshot
    __E2E_REMOTE_CAPTURE_MOCK__?: boolean
    __E2E_REMOTE_HOST_CONTROLS_SUPPRESSED__?: boolean
    __E2E_REMOTE_AUDIO_MOCK__?: boolean
    __E2E_NATIVE_REMOTE_AUDIO_MOCK__?: boolean
    __E2E_NATIVE_REMOTE_AUDIO_STREAM_FACTORY__?: (
      frequencyHz: number
    ) => Promise<MediaStream>
    __E2E_REMOTE_AUDIO_MOCK_FREQUENCY__?: number
  }
}

export {}

