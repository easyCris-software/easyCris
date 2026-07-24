/**
 * AppShell Component
 *
 * Main application shell integrating all Phase 3B components:
 * - Native window decorations (minimize/maximize/close via OS)
 * - Toolbar (File/View/Data/Analysis/Visualization tabs)
 * - ActionToolbar (Import/Run/Clear quick actions)
 * - NavigatorPanel (Statistics families tree)
 * - Workspace (Data/Plots views)
 * - StatusBar (Live dataset/test/Python status)
 *
 * Replaces the template layout with Avalonia-style Navigator + Workspace architecture.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { resolveFamilyDataset } from './familyDatasetResolver'
import { applyAdoptExistingBootstrap, decideFamilyBootstrap } from './familyBootstrapResolver'
// WindowTitleBar removed - using native decorations instead
import { Toolbar } from './Toolbar'
import { ActionToolbar } from './ActionToolbar'
import { NavigatorPanel } from './NavigatorPanel'
import { StatusBar } from './StatusBar'
import { AppBusyOverlay } from './AppBusyOverlay'
import { shouldShowBlockingAppBusyOverlay } from './appBusyOverlayGate'
import { getDatasetQueueActionBlock } from './appShellQueueBoundary'
import { TestSelectionDialog } from '@/components/dialogs/TestSelectionDialog'
import { ColumnSelectionDialog, type SelectedColumnInfo } from '@/components/dialogs/ColumnSelectionDialog'
import { PivotWiderDialog } from '@/components/dialogs/PivotWiderDialog'
import { PivotLongerDialog } from '@/components/dialogs/PivotLongerDialog'
import { GroupAggregateDialog } from '@/components/dialogs/GroupAggregateDialog'
import { AdvancedFilterDialog } from '@/components/dialogs/AdvancedFilterDialog'
import { FilterColumnPickerPopover } from '@/components/data/FilterColumnPickerPopover'
import { TransformWarningDialog, type TransformMode } from '@/components/dialogs/TransformWarningDialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { SpreadsheetView } from '@/components/data/SpreadsheetView'
import { ResultsPanel } from '@/components/results/ResultsPanel'
import { PlotsPanel } from '@/components/plots'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { Toaster } from '@/components/ui/sonner'
import { WelcomeScreen } from '@/components/onboarding/WelcomeScreen'
import { DeviceLinkDialog } from '@/components/dialogs/DeviceLinkDialog'
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog'
import { RemoteInviteDialog } from '@/components/remote/RemoteInviteDialog'
import { RemoteGuestViewerOverlay } from '@/components/remote/RemoteGuestViewerOverlay'
import { RemoteSessionBanner } from '@/components/remote/RemoteSessionBanner'
import {
  shouldAutoCompleteFirstLaunchAfterLink,
  shouldShowWelcomeScreen,
} from '@/components/layout/firstLaunchDeviceLinking'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { useStatisticalAnalysisController } from '@/hooks/useStatisticalAnalysisController'
import { useFirstLaunch } from '@/hooks/useFirstLaunch'
import type { GridViewScope } from '@/lib/grid/gridViewScope'
import { buildFullRowsByIndex } from '@/lib/grid/filterColumnsSnapshot'
import { applyViewFilter } from '@/lib/grid/viewFilter'
import { getUsableRowCount, hasUsableRows } from '@/lib/datasetRows'
import { useAppStore, ensureProjectId, isValidProjectIdForCache } from '@/store/app-store'
import { useDataStore } from '@/store/data-store'
import { useAnalysisStore, type AnalysisHistoryEntry } from '@/store/analysis-store'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import type { TestResult } from '@/store/results-store'
import type { Dataset, ColumnMetadata, TransformSnapshot } from '@/store/data-store'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import { dirname, join, isAbsolute, basename, resolveResource } from '@tauri-apps/api/path'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import tauriApi, {
  type ProjectDataset,
  type ProjectFile,
  type ProjectFamily,
  type ProjectTestResult,
  type SampleDataset,
} from '@/services/tauriApi'
import cacheService, {
  type DatasetStorageInfo,
  type CacheCleanupSummary,
  type CacheHealthSummary,
} from '@/services/cacheService'
import { DataTransformService } from '@/services/dataTransformService'
import type {
  PivotWiderConfig,
  PivotLongerConfig,
  FilterConfig,
  GroupAggregateConfig,
} from '@/services/dataTransformService'
import { setProjectLoader } from '@/services/projectService'
import {
  getTestDefinition,
  getRequiredColumnCount as getRegistryColumnCount,
} from '@/config/testRegistry'
import { toStoreTestDefinition } from '@/utils/testDefinitionMapping'
import { normalizeTestId } from '@/services/plotResult/common/normalize'
import { isDataCleaningActionId } from '@/config/dataCleaningGuideRegistry'

// Phase 0+2: Modular validation system imports
import { classifyColumn } from '@/lib/modules/core/ColumnDataExtractor'
import {
  applyColumnTypeOverride,
  classifyColumnFromStats,
  type ColumnClassification as UiColumnClassification,
  type ColumnClassificationStats,
} from '@/services/columnDataService'
import { TYPE_CLASSIFICATION_RULES } from '@/lib/classification/typeRules'
import { mapPersistedOverrideToUi, mapUiTypeToCore } from '@/lib/classification/typeBridge'
import type { ITestModule, ColumnClassification, TestValidationResult } from '@/lib/modules/core/types'
import { ColumnDataType } from '@/lib/modules/core/types'
import { ValidationErrorDialog } from '@/components/dialogs/ValidationErrorDialog'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { moduleRegistry } from '@/lib/modules/core/ModuleRegistry'

// Phase 1A+1B: Orchestration layer imports
import { DependentVariableDialog } from '@/components/dialogs/DependentVariableDialog'
import { DependentVariableEncodingDialog } from '@/components/dialogs/DependentVariableEncodingDialog'
import { FactorEncodingDialog } from '@/components/dialogs/FactorEncodingDialog'
import { SimpleEffectsDialog } from '@/components/dialogs/SimpleEffectsDialog'
import { MultiFactorialSimpleEffectsDialog } from '@/components/dialogs/MultiFactorialSimpleEffectsDialog'
import { LmmSimpleEffectsDialog } from '@/components/dialogs/LmmSimpleEffectsDialog'
import { LmmAnovaConfigDialog } from '@/components/dialogs/LmmAnovaConfigDialog'
import { TwoWayFactorMappingDialog } from '@/components/dialogs/TwoWayFactorMappingDialog'
import { MultifactorialFactorMappingDialog } from '@/components/dialogs/MultifactorialFactorMappingDialog'
import { DoseResponseColumnMapperDialog } from '@/components/dialogs/DoseResponseColumnMapperDialog'
import { SynergyColumnMapperDialog } from '@/components/dialogs/SynergyColumnMapperDialog'
import { ChiSquareGofColumnMapperDialog } from '@/components/dialogs/ChiSquareGofColumnMapperDialog'
import { ChiSquareColumnMapperDialog } from '@/components/dialogs/ChiSquareColumnMapperDialog'
import { FisherExactColumnMapperDialog } from '@/components/dialogs/FisherExactColumnMapperDialog'
import { McNemarColumnMapperDialog } from '@/components/dialogs/McNemarColumnMapperDialog'
import { IndependentTTestColumnMapperDialog } from '@/components/dialogs/IndependentTTestColumnMapperDialog'
import { MannWhitneyColumnMapperDialog } from '@/components/dialogs/MannWhitneyColumnMapperDialog'
import { PairedTTestColumnMapperDialog } from '@/components/dialogs/PairedTTestColumnMapperDialog'
import { WilcoxonColumnMapperDialog } from '@/components/dialogs/WilcoxonColumnMapperDialog'
import { OneWayAnovaColumnMapperDialog } from '@/components/dialogs/OneWayAnovaColumnMapperDialog'
import { KruskalWallisColumnMapperDialog } from '@/components/dialogs/KruskalWallisColumnMapperDialog'
import { SurvivalAnalysisDialog } from '@/components/dialogs/SurvivalAnalysisDialog'
import { MediationAnalysisDialog } from '@/components/dialogs/MediationAnalysisDialog'
import { ModerationAnalysisDialog } from '@/components/dialogs/ModerationAnalysisDialog'
import { ModeratedMediationDialog } from '@/components/dialogs/ModeratedMediationDialog'
import { RelinkSourceDialog, type RelinkReason } from '@/components/dialogs/RelinkSourceDialog'

// RNA-seq module
import { RNAseqWorkspace } from '@/components/rnaseq'
import { useActiveRNAseqProject, useRNAseqStore } from '@/store/rnaseq-store'
import type { SerializedDESeqResult, SerializedRNAseqResults } from '@/types/rnaseq'
import { ImportProgressDialog } from '@/components/dialogs/ImportProgressDialog'
import { ExecutionModeDialog } from '@/components/dialogs/ExecutionModeDialog'
import { SampleDatasetsDialog } from '@/components/dialogs/SampleDatasetsDialog'
import { StatisticalTestsGuideDialog } from '@/components/cheatsheet/StatisticalTestsGuideDialog'
import { DataCleaningGuideDialog } from '@/components/cheatsheet/DataCleaningGuideDialog'
import { BulkRNAseqGuideDialog } from '@/components/cheatsheet/BulkRNAseqGuideDialog'
import { BottomLeftTip } from '@/components/onboarding/BottomLeftTip'
import { getTransformPreflight, type PreflightResult } from '@/utils/transformPreflight'
import { BaseDirectory, mkdir, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { getViewStateCache, setViewStateCache } from '@/lib/grid/viewStateCache'
import {
  convertColumnsToRowObjects,
  convertRowObjectsToColumns,
  type ColumnData,
} from '@/utils/dataConversion'
import {
  assessTransformColumnAvailability,
  computePivotIdColumns,
  dedupeMetadataDisplayNames,
  makeUniqueDisplayName,
  normalizeDisplayName,
} from '@/utils/transformSchema'
import {
  buildCacheHealthNotification,
  createSingleFlightRunner,
  getCacheHealthDecision,
  readCacheHealthSuppression,
  resolveCacheHealthConfig,
  writeCacheHealthSuppressionForDays,
  writeCacheHealthSuppressionForever,
} from '@/utils/cacheHealth'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'
import { evaluateTransformSchemaDecision } from '@/utils/transformSchemaPolicy'
import {
  toColumnMetadata,
  toFactorMetadata,
  getDVDialogMode,
  getDVEncodingType,
  extractLevels,
} from '@/lib/analysis/dialogHelpers'
import { isE2EEnabled } from '@/utils/e2eMode'
import { showAppErrorToast } from '@/lib/errors/errorToast'
import { prewarmKaleidoOnIdle } from '@/services/plotExportService'
import {
  extractAppError,
  extractErrorMessage,
  markErrorToastShown,
  wasErrorToastShown,
} from '@/lib/errors/tauriErrorAdapter'
import { buildPerformTestWarningKey } from './performTestWarning'
import { filterColumnsWithData } from '@/lib/grid/columnsWithData'
import { getTransformLabel } from '@/lib/grid/getTransformLabel'
import { scheduleViewportVarsRefresh } from '@/utils/viewportVarsScheduler'

interface AppShellProps {
  className?: string
}

type LoadProjectFromPathOptions = {
  nonInteractive?: boolean
}

type TransformUiState = {
  pivotWider?: PivotWiderConfig
  pivotLonger?: PivotLongerConfig
  filter?: FilterConfig
  groupAggregate?: GroupAggregateConfig
}

type TransformSchemaResolution = {
  columns: ColumnMetadata[]
  partial: boolean
  availableColumns: number
  missingColumns: number
  ignorableMissingColumns: number
  totalColumns: number
}

// Database file extension (user-facing)
// Uses .ecpdb (easyCris Project Database) instead of .duckdb to hide implementation
const DATA_FILE_EXT = '.ecpdb'
const CACHE_HEALTH_SUPPRESS_UNTIL_KEY = 'easycris-cache-health-suppress-until'

type LegalDocKey = 'eula' | 'privacy' | 'thirdParty'
type AcceptanceLegalDocKey = Exclude<LegalDocKey, 'thirdParty'>
type LegalDocHashes = {
  eula: string
  privacy: string
  thirdParty?: string
}
type LegalDocTexts = {
  eula: string
  privacy: string
  thirdParty?: string
}
type LegalDocsBundle = {
  hashes: LegalDocHashes
  texts: LegalDocTexts
}
type StoredLegalAcceptance = {
  schemaVersion: number
  policyVersion: string
  acceptedAt: string
  hashes: LegalDocHashes
}

const LEGAL_DOC_PATHS: Record<LegalDocKey, string> = {
  eula: 'legal/EULA.txt',
  privacy: 'legal/PRIVACY_POLICY.txt',
  thirdParty: 'legal/THIRD_PARTY_LICENSES.txt',
}
const LEGAL_DOC_LABELS: Record<LegalDocKey, string> = {
  eula: 'License Terms',
  privacy: 'Privacy Policy',
  thirdParty: 'Third-Party Licenses',
}
const ACCEPTANCE_LEGAL_DOC_KEYS: AcceptanceLegalDocKey[] = ['eula', 'privacy']
const LEGAL_ACCEPTANCE_STORAGE_KEY = 'easycris.legal.acceptance'
const LEGAL_ACCEPTANCE_APPDATA_PATH = 'legal/legal-acceptance.json'
const LEGAL_ACCEPTANCE_SCHEMA_VERSION = 1
const LEGAL_POLICY_VERSION = '2026-04-05'
const LEGAL_DOC_PREVIEW_LIMIT = 200_000

const getLegalResourceCandidates = (resourceName: string): string[] => {
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

const readBundledLegalText = async (resourceName: string): Promise<string> => {
  const candidates = getLegalResourceCandidates(resourceName)
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

  throw lastError ?? new Error(`Unable to read legal resource: ${resourceName}`)
}

const sha256Hex = async (value: string): Promise<string> => {
  // Normalize line endings before hashing so hashes remain stable
  // across CRLF/LF differences.
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const encoded = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const computeCurrentLegalBundle = async (): Promise<LegalDocsBundle> => {
  const [eula, privacy] = await Promise.all([
    readBundledLegalText(LEGAL_DOC_PATHS.eula),
    readBundledLegalText(LEGAL_DOC_PATHS.privacy),
  ])

  const [eulaHash, privacyHash] = await Promise.all([
    sha256Hex(eula),
    sha256Hex(privacy),
  ])

  return {
    hashes: {
      eula: eulaHash,
      privacy: privacyHash,
    },
    texts: {
      eula,
      privacy,
    },
  }
}

const parseStoredLegalAcceptance = (raw: string | null): StoredLegalAcceptance | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLegalAcceptance>
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.schemaVersion !== LEGAL_ACCEPTANCE_SCHEMA_VERSION) return null
    if (!parsed.hashes) return null
    const hashes = parsed.hashes as Partial<Record<LegalDocKey, string>>
    if (
      typeof hashes.eula !== 'string' ||
      typeof hashes.privacy !== 'string'
    ) {
      return null
    }
    return {
      schemaVersion: LEGAL_ACCEPTANCE_SCHEMA_VERSION,
      policyVersion: typeof parsed.policyVersion === 'string' ? parsed.policyVersion : '',
      acceptedAt: typeof parsed.acceptedAt === 'string' ? parsed.acceptedAt : '',
      hashes: {
        eula: hashes.eula,
        privacy: hashes.privacy,
        ...(typeof hashes.thirdParty === 'string' ? { thirdParty: hashes.thirdParty } : {}),
      },
    }
  } catch {
    return null
  }
}

const loadStoredLegalAcceptance = async (): Promise<StoredLegalAcceptance | null> => {
  try {
    const hasAppDataFile = await exists(LEGAL_ACCEPTANCE_APPDATA_PATH, {
      baseDir: BaseDirectory.AppData,
    })

    if (hasAppDataFile) {
      const raw = await readTextFile(LEGAL_ACCEPTANCE_APPDATA_PATH, {
        baseDir: BaseDirectory.AppData,
      })
      const parsed = parseStoredLegalAcceptance(raw)
      if (parsed) return parsed
    }
  } catch (error) {
    console.error('[Legal] Failed to read persisted legal acceptance state:', error)
  }

  // Legacy fallback for users upgrading from localStorage-only acceptance.
  const legacyAccepted = parseStoredLegalAcceptance(localStorage.getItem(LEGAL_ACCEPTANCE_STORAGE_KEY))
  if (legacyAccepted) {
    try {
      await persistStoredLegalAcceptance(legacyAccepted)
    } catch (error) {
      console.error('[Legal] Failed to migrate legacy legal acceptance state:', error)
    }
  }
  return legacyAccepted
}

const persistStoredLegalAcceptance = async (payload: StoredLegalAcceptance): Promise<void> => {
  const serialized = JSON.stringify(payload)
  await mkdir('legal', { baseDir: BaseDirectory.AppData, recursive: true })
  await writeTextFile(LEGAL_ACCEPTANCE_APPDATA_PATH, serialized, {
    baseDir: BaseDirectory.AppData,
  })

  // Keep temporary mirror for backward compatibility during migration.
  localStorage.setItem(LEGAL_ACCEPTANCE_STORAGE_KEY, serialized)
}

export const getChangedLegalDocs = (
  stored: StoredLegalAcceptance,
  currentHashes: LegalDocHashes
): AcceptanceLegalDocKey[] =>
  ACCEPTANCE_LEGAL_DOC_KEYS.filter((key) => stored.hashes[key] !== currentHashes[key])

const shortHash = (hash: string): string => hash.slice(0, 12)

const TESTS_REQUIRING_NUMERIC_DV = new Set([
  'two_way_anova',
  'scheirer_ray_hare',
  'one_way_anova',
])

export function AppShell({ className }: AppShellProps) {
  const e2eEnabled = isE2EEnabled()
  const deviceAuthMode = useDeviceAuthStore((state) => state.mode)
  const linkDialogOpen = useDeviceAuthStore((state) => state.linkDialogOpen)
  const setLinkDialogOpen = useDeviceAuthStore((state) => state.setLinkDialogOpen)

  const {
    showNavigator,
    setShowNavigator,
    workspaceViewMode,
    updateActiveFamilyData,
    activeFamilyId,
    families,
    projectId,
    setActiveFamilyDataset,
    createFamily,
    restoreFamilies,
    setRecentProjects,
    setOpenProjectHandler,
    setSaveProjectHandler,
    setSaveProjectAsHandler,
    appOperationLock,
    pasteInFlight,
    pasteFinalizing,
  } = useAppStore()
  const pasteInProgress = pasteInFlight || pasteFinalizing
  const {
    currentDataset,
    setCurrentDataset,
    addDataset,
    // setCacheData removed - streaming row provider now loads data on demand
    removeDataset,
    initializeBlankDataset,
    datasets,
    // dataCache removed - streaming row provider now loads data on demand
    clearAllDatasets,
    replaceAllDatasetsWith,
    setLoadingOperation,
    saveTransformSnapshot,
    getTransformSnapshot,
    clearTransformSnapshot,
    transformSnapshots,
    getColumnTypeOverride,
  } = useDataStore()

  // RNA-seq module state
  const activeRNAseqProject = useActiveRNAseqProject()
  const rnaseqProjects = useRNAseqStore((state) => state.projects)

  // First launch detection for welcome screen
  const { isFirstLaunch, isLoading: isFirstLaunchLoading, markWelcomeSeen } = useFirstLaunch()
  const legalGateEnabled = !import.meta.env.DEV && import.meta.env.MODE !== 'e2e' && !e2eEnabled

  const [testDialogOpen, setTestDialogOpen] = useState(false)
  const [columnDialogOpen, setColumnDialogOpen] = useState(false)
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
  const [dataCleaningGuideOpen, setDataCleaningGuideOpen] = useState(false)
  const [rnaseqGuideOpen, setRnaseqGuideOpen] = useState(false)
  const [viewAttentionPulseToken, setViewAttentionPulseToken] = useState(0)
  const [showPivotWiderDialog, setShowPivotWiderDialog] = useState(false)
  const [showPivotLongerDialog, setShowPivotLongerDialog] = useState(false)
  const [showGroupAggregateDialog, setShowGroupAggregateDialog] = useState(false)
  const [showAdvancedFilterDialog, setShowAdvancedFilterDialog] = useState(false)
  const [legalGateOpen, setLegalGateOpen] = useState(false)
  const [legalGateReady, setLegalGateReady] = useState(!legalGateEnabled)
  const [legalGateLoading, setLegalGateLoading] = useState(false)
  const [legalGateError, setLegalGateError] = useState<string | null>(null)
  const [legalGateRequiresReconsent, setLegalGateRequiresReconsent] = useState(false)
  const [legalDocsToReview, setLegalDocsToReview] = useState<AcceptanceLegalDocKey[]>([
    ...ACCEPTANCE_LEGAL_DOC_KEYS,
  ])
  const [legalGateHashes, setLegalGateHashes] = useState<LegalDocHashes | null>(null)
  const [legalDocTexts, setLegalDocTexts] = useState<Partial<LegalDocTexts>>({})
  const [selectedLegalDoc, setSelectedLegalDoc] = useState<AcceptanceLegalDocKey>('eula')
  const [legalPreviewExpanded, setLegalPreviewExpanded] = useState(false)
  const [showTransformWarning, setShowTransformWarning] = useState(false)
  const [transformSampleData, setTransformSampleData] = useState<Record<string, any>[]>([])
  const [transformColumns, setTransformColumns] = useState<ColumnMetadata[]>([])
  const [pendingTransform, setPendingTransform] = useState<{
    datasetId: string
    type: TransformSnapshot['transformType']
    config: PivotWiderConfig | PivotLongerConfig | FilterConfig | GroupAggregateConfig
  } | null>(null)
  const [transformUiState, setTransformUiState] = useState<TransformUiState>({})
  const [preflightConfirm, setPreflightConfirm] = useState<{
    message: string
    rowCount: number
    operationLabel: string
  } | null>(null)
  const [cacheHealthDialog, setCacheHealthDialog] = useState<{
    title: string
    description: string
  } | null>(null)
  const [lastCacheHealthSummary, setLastCacheHealthSummary] = useState<CacheHealthSummary | null>(null)
  const preflightResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const cacheHealthConfig = useMemo(() => resolveCacheHealthConfig(), [])
  const cacheHealthPromptShownThisSessionRef = useRef(false)
  const runCacheHealthCheckSingleFlightRef = useRef(createSingleFlightRunner<void>())
  const importDialogOpenRef = useRef(false)
  const legalGateBlocking = legalGateEnabled && (!legalGateReady || legalGateOpen)
  const dataRowCountForMount =
    currentDataset?.dataRowCount ?? currentDataset?.rowCount ?? 0
  const KEEP_DATA_VIEW_MOUNT_THRESHOLD = 250_000
  const keepDataViewMounted = dataRowCountForMount < KEEP_DATA_VIEW_MOUNT_THRESHOLD

  useEffect(() => {
    if (
      shouldAutoCompleteFirstLaunchAfterLink({
        isFirstLaunch,
        deviceAuthMode,
      })
    ) {
      markWelcomeSeen()
    }
  }, [deviceAuthMode, isFirstLaunch, markWelcomeSeen])
  // O(1) lookup Maps - avoid repeated O(n) find() calls
  const familiesById = useMemo(() => {
    const map = new Map<string, (typeof families)[number]>()
    for (const family of families) {
      map.set(family.id, family)
    }
    return map
  }, [families])

  const datasetsById = useMemo(() => {
    const map = new Map<string, (typeof datasets)[number]>()
    for (const dataset of datasets) {
      map.set(dataset.id, dataset)
    }
    return map
  }, [datasets])

  const activeFamily = useMemo(
    () => (activeFamilyId ? familiesById.get(activeFamilyId) ?? null : null),
    [familiesById, activeFamilyId]
  )
  const rnaseqDatasetIds = useMemo(() => {
    const ids = new Set<string>()
    for (const project of rnaseqProjects) {
      if (project.countsDatasetId) ids.add(project.countsDatasetId)
      if (project.metadataDatasetId) ids.add(project.metadataDatasetId)
    }
    return ids
  }, [rnaseqProjects])

  const activeDataset = useMemo(() => {
    if (!activeFamily?.datasetId) return null
    if (currentDataset?.id === activeFamily.datasetId) return currentDataset
    return datasetsById.get(activeFamily.datasetId) ?? null
  }, [activeFamily, currentDataset, datasetsById])
  const pendingGridSurfaceActivationTokenRef = useRef(0)
  const [pendingGridSurfaceActivation, setPendingGridSurfaceActivation] = useState<{
    familyId: string
    datasetId: string
    token: number
    status: 'staging'
    kind?: 'family-activation' | 'project-reset'
    cleanupDatasetId?: string | null
  } | null>(null)
  const pendingGridSurfaceActivationRef = useRef<{
    familyId: string
    datasetId: string
    token: number
    status: 'staging'
    kind?: 'family-activation' | 'project-reset'
    cleanupDatasetId?: string | null
  } | null>(null)
  const deferredDatasetCleanupRef = useRef<{
    nextDatasetId: string
    cleanupDatasetId: string
  } | null>(null)
  const [displayDatasetId, setDisplayDatasetId] = useState<string | undefined>(
    activeDataset?.id ?? currentDataset?.id ?? undefined
  )
  pendingGridSurfaceActivationRef.current = pendingGridSurfaceActivation
  useEffect(() => {
    if (pendingGridSurfaceActivation) return
    setDisplayDatasetId(activeDataset?.id ?? currentDataset?.id ?? undefined)
  }, [activeDataset?.id, currentDataset?.id, pendingGridSurfaceActivation])
  useEffect(() => {
    if (!e2eEnabled) return
    ;(window as Window & { __E2E_DISPLAY_DATASET_ID__?: string | null }).__E2E_DISPLAY_DATASET_ID__ =
      displayDatasetId ?? null
  }, [displayDatasetId, e2eEnabled])
  useEffect(() => {
    if (!e2eEnabled) return
    ;(
      window as Window & {
        __E2E_DISPLAY_SURFACE__?: {
          committedDatasetId: string | null
          pendingDatasetId: string | null
          pendingSurfaceStatus: 'staging' | 'committed'
          token: number | null
        }
      }
    ).__E2E_DISPLAY_SURFACE__ = {
      committedDatasetId: displayDatasetId ?? null,
      pendingDatasetId: pendingGridSurfaceActivation?.datasetId ?? null,
      pendingSurfaceStatus: pendingGridSurfaceActivation ? 'staging' : 'committed',
      token: pendingGridSurfaceActivation?.token ?? null,
    }
  }, [displayDatasetId, e2eEnabled, pendingGridSurfaceActivation])
  const transformDataset = useMemo(() => {
    if (activeRNAseqProject) {
      return currentDataset ?? null
    }
    return activeDataset ?? null
  }, [activeRNAseqProject, currentDataset, activeDataset])
  const isRNAseqDataset = useMemo(() => {
    if (!transformDataset?.id) return false
    return rnaseqDatasetIds.has(transformDataset.id)
  }, [transformDataset?.id, rnaseqDatasetIds])
  const handlePendingSurfaceReady = useCallback(
    ({ datasetId, token }: { datasetId: string; token: number }) => {
      const pending = pendingGridSurfaceActivationRef.current
      if (!pending || pending.token !== token || pending.datasetId !== datasetId) {
        return
      }
      const dataset = datasetsById.get(datasetId)
      if (!dataset) {
        return
      }
      setDisplayDatasetId(datasetId)
      if (pending.kind === 'project-reset') {
        replaceAllDatasetsWith(dataset)
      } else {
        setCurrentDataset(dataset)
      }
      if (pending.cleanupDatasetId && pending.cleanupDatasetId !== datasetId) {
        removeDataset(pending.cleanupDatasetId)
        cacheService.removeDataset(pending.cleanupDatasetId).catch((error) => {
          console.error(`Failed to remove dataset ${pending.cleanupDatasetId} from cache`, error)
        })
        if (
          deferredDatasetCleanupRef.current?.nextDatasetId === datasetId &&
          deferredDatasetCleanupRef.current?.cleanupDatasetId === pending.cleanupDatasetId
        ) {
          deferredDatasetCleanupRef.current = null
        }
      }
      setPendingGridSurfaceActivation(null)
    },
    [datasetsById, removeDataset, replaceAllDatasetsWith, setCurrentDataset]
  )
  useEffect(() => {
    const deferred = deferredDatasetCleanupRef.current
    if (!deferred) return
    const committedDatasetId = displayDatasetId ?? currentDataset?.id ?? null
    if (committedDatasetId !== deferred.nextDatasetId) {
      return
    }
    if (deferred.cleanupDatasetId !== deferred.nextDatasetId && datasetsById.has(deferred.cleanupDatasetId)) {
      removeDataset(deferred.cleanupDatasetId)
      cacheService.removeDataset(deferred.cleanupDatasetId).catch((error) => {
        console.error(`Failed to remove dataset ${deferred.cleanupDatasetId} from cache`, error)
      })
    }
    deferredDatasetCleanupRef.current = null
  }, [currentDataset?.id, datasetsById, displayDatasetId, removeDataset])
  const logAppDebug = useCallback((event: string, payload?: Record<string, unknown>) => {
    logRuntimeDebug('app', event, payload)
  }, [])
  const blockIfAppLocked = useCallback((activityLabel: string): boolean => {
    const lock = useAppStore.getState().appOperationLock
    if (!lock.active) {
      logAppDebug('app_lock_check', { activityLabel, blocked: false })
      return false
    }

    const ownerLabel = lock.owner ?? 'another operation'
    const stage = lock.stage || lock.operation || 'Processing'
    logAppDebug('app_lock_check', {
      activityLabel,
      blocked: true,
      owner: ownerLabel,
      stage,
      operation: lock.operation ?? null,
    })
    toast.warning(`${activityLabel} is unavailable while ${ownerLabel} is running.`, {
      description: stage,
    })
    return true
  }, [logAppDebug])
  const blockIfPasteInFlight = useCallback((activityLabel: string): boolean => {
    const appState = useAppStore.getState()
    if (!appState.pasteInFlight && !appState.pasteFinalizing) {
      logAppDebug('paste_in_flight_check', { activityLabel, blocked: false })
      return false
    }
    logAppDebug('paste_in_flight_check', { activityLabel, blocked: true })
    toast.warning(`${activityLabel} is unavailable while paste is in progress.`)
    return true
  }, [logAppDebug])
  const blockIfDatasetQueueNotReady = useCallback(
    (activityLabel: string, datasetId: string | null | undefined): boolean => {
      if (!datasetId) {
        logAppDebug('dataset_queue_action_check', {
          activityLabel,
          blocked: false,
          reason: 'missing_dataset',
        })
        return false
      }
      const queueState = cacheService.getGridMutationQueueState(datasetId)
      const queueBlock = getDatasetQueueActionBlock(queueState)
      if (!queueBlock.blocked) {
        logAppDebug('dataset_queue_action_check', {
          activityLabel,
          datasetId,
          blocked: false,
          queueStatus: queueState.status,
        })
        return false
      }
      logAppDebug('dataset_queue_action_check', {
        activityLabel,
        datasetId,
        blocked: true,
        queueStatus: queueState.status,
        error: queueState.error ?? null,
        description: queueBlock.description ?? null,
      })
      toast.warning(`${activityLabel} is unavailable while dataset sync is not healthy.`, {
        description: queueBlock.description,
      })
      return true
    },
    [logAppDebug]
  )
  const showBlockingAppBusyOverlay = shouldShowBlockingAppBusyOverlay(appOperationLock)

  const formatCacheBytes = useCallback((bytes: number): string => {
    if (bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
  }, [])

  const summarizeCleanup = useCallback((summary: CacheCleanupSummary): string => {
    const base = `${summary.removedFiles} file(s), ${formatCacheBytes(summary.removedBytes)} removed`
    if (summary.skippedActiveFiles > 0) {
      return `${base}, ${summary.skippedActiveFiles} active file(s) skipped`
    }
    return base
  }, [formatCacheBytes])
  const clearUnsavedAppCacheWithToasts = useCallback(async () => {
    const summary = await cacheService.clearUnsavedAppCache()
    toast.success('Unsaved/AppData cache cleaned', {
      description: summarizeCleanup(summary),
    })
  }, [summarizeCleanup])
  const suppressCacheHealthWarningForDays = useCallback(() => {
    writeCacheHealthSuppressionForDays(
      localStorage,
      CACHE_HEALTH_SUPPRESS_UNTIL_KEY,
      cacheHealthConfig.suppressDays
    )
  }, [cacheHealthConfig.suppressDays])
  const suppressCacheHealthWarningForever = useCallback(() => {
    writeCacheHealthSuppressionForever(localStorage, CACHE_HEALTH_SUPPRESS_UNTIL_KEY)
  }, [])
  const refreshCacheHealthSummary = useCallback(async (): Promise<CacheHealthSummary | null> => {
    try {
      const summary = await cacheService.getCacheHealthSummary()
      setLastCacheHealthSummary(summary)
      return summary
    } catch (error) {
      console.warn('[CacheHealth] Failed to get cache health summary:', error)
      return null
    }
  }, [])
  const maybeShowCacheHealthWarning = useCallback(
    async (_trigger: 'startup' | 'post_import') => {
      if (cacheHealthPromptShownThisSessionRef.current) return
      await runCacheHealthCheckSingleFlightRef.current(async () => {
        const summary = await refreshCacheHealthSummary()
        if (!summary) return

        const suppressState = readCacheHealthSuppression(
          localStorage,
          CACHE_HEALTH_SUPPRESS_UNTIL_KEY,
          Date.now()
        )
        if (suppressState !== null) return

        const decision = getCacheHealthDecision(summary, cacheHealthConfig)
        if (!decision.shouldWarn) return

        cacheHealthPromptShownThisSessionRef.current = true
        const notification = buildCacheHealthNotification(summary, decision, formatCacheBytes)
        setCacheHealthDialog({
          title: notification.title,
          description: notification.description,
        })
      })
    },
    [
      cacheHealthConfig,
      formatCacheBytes,
      refreshCacheHealthSummary,
      suppressCacheHealthWarningForDays,
      suppressCacheHealthWarningForever,
    ]
  )
  const handleCacheHealthDialogClear = useCallback(() => {
    setCacheHealthDialog(null)
    if (blockIfAppLocked('Clear unsaved/AppData cache')) return
    void clearUnsavedAppCacheWithToasts().catch((error) => {
      const message = extractErrorMessage(error, 'Failed to clear unsaved/AppData cache')
      toast.error('Cache cleanup failed', { description: message })
    })
  }, [blockIfAppLocked, clearUnsavedAppCacheWithToasts])
  const handleCacheHealthDialogSuppressDays = useCallback(() => {
    suppressCacheHealthWarningForDays()
    setCacheHealthDialog(null)
  }, [suppressCacheHealthWarningForDays])
  const handleCacheHealthDialogSuppressForever = useCallback(() => {
    suppressCacheHealthWarningForever()
    setCacheHealthDialog(null)
  }, [suppressCacheHealthWarningForever])
  const handleLegalDecline = useCallback(async () => {
    try {
      await invoke('allow_app_close')
      await getCurrentWindow().close()
    } catch (error) {
      const message = extractErrorMessage(error, 'Failed to close app')
      console.error('[Legal] Failed to exit app from legal gate:', message)
      toast.error('Could not exit app', { description: message })
    }
  }, [])

  const runLegalGateCheck = useCallback(async () => {
    if (!legalGateEnabled) {
      setLegalGateReady(true)
      setLegalGateOpen(false)
      return
    }

    setLegalGateLoading(true)
    setLegalGateError(null)
    setLegalPreviewExpanded(false)

    try {
      const bundle = await computeCurrentLegalBundle()
      setLegalGateHashes(bundle.hashes)
      setLegalDocTexts(bundle.texts)

      const stored = await loadStoredLegalAcceptance()
      if (!stored) {
        // Normal install path: EULA/license terms acceptance is primary.
        // Bootstrap local legal state without blocking first app launch.
        const bootstrapPayload: StoredLegalAcceptance = {
          schemaVersion: LEGAL_ACCEPTANCE_SCHEMA_VERSION,
          policyVersion: LEGAL_POLICY_VERSION,
          acceptedAt: new Date().toISOString(),
          hashes: bundle.hashes,
        }
        try {
          await persistStoredLegalAcceptance(bootstrapPayload)
          setLegalGateRequiresReconsent(false)
          setLegalDocsToReview([...ACCEPTANCE_LEGAL_DOC_KEYS])
          setLegalGateOpen(false)
        } catch (persistError) {
          const message = extractErrorMessage(
            persistError,
            'Failed to save legal acceptance'
          )
          console.warn(
            '[Legal] Failed to bootstrap legal acceptance state:',
            persistError
          )
          setLegalGateError(
            `Could not save legal acceptance state. Check app data folder permissions and retry. (${message})`
          )
          setLegalGateRequiresReconsent(true)
          setLegalDocsToReview([...ACCEPTANCE_LEGAL_DOC_KEYS])
          setSelectedLegalDoc('eula')
          setLegalGateOpen(true)
        }
      } else {
        const changedDocs = getChangedLegalDocs(stored, bundle.hashes)
        const policyChanged = stored.policyVersion !== LEGAL_POLICY_VERSION
        const requiresReconsent = policyChanged || changedDocs.length > 0
        const docsToReview: AcceptanceLegalDocKey[] = requiresReconsent
          ? changedDocs.length > 0
            ? changedDocs
            : ['eula']
          : [...ACCEPTANCE_LEGAL_DOC_KEYS]

        setLegalGateRequiresReconsent(requiresReconsent)
        setLegalDocsToReview(docsToReview)
        setSelectedLegalDoc(docsToReview[0] ?? 'eula')
        setLegalGateOpen(requiresReconsent)
      }
    } catch (error) {
      setLegalGateError('Could not verify bundled legal documents. Please retry or reinstall.')
      setLegalGateRequiresReconsent(false)
      setLegalDocsToReview([...ACCEPTANCE_LEGAL_DOC_KEYS])
      setLegalGateOpen(true)
      setLegalGateHashes(null)
      setLegalDocTexts({})
      console.error('[Legal] Failed to initialize legal acceptance gate:', error)
    } finally {
      setLegalGateLoading(false)
      setLegalGateReady(true)
    }
  }, [legalGateEnabled])

  const handleLegalAccept = useCallback(async () => {
    if (!legalGateHashes) return
    const payload: StoredLegalAcceptance = {
      schemaVersion: LEGAL_ACCEPTANCE_SCHEMA_VERSION,
      policyVersion: LEGAL_POLICY_VERSION,
      acceptedAt: new Date().toISOString(),
      hashes: legalGateHashes,
    }

    try {
      await persistStoredLegalAcceptance(payload)
      setLegalGateRequiresReconsent(false)
      setLegalGateOpen(false)
      toast.success('Legal terms accepted.')
    } catch (error) {
      const message = extractErrorMessage(error, 'Failed to persist legal acceptance')
      setLegalGateError(message)
      toast.error('Could not save legal acceptance. Please retry.')
    }
  }, [legalGateHashes])

  const handleLegalRetry = useCallback(() => {
    void runLegalGateCheck()
  }, [runLegalGateCheck])

  useEffect(() => {
    void runLegalGateCheck()
  }, [runLegalGateCheck])

  useEffect(() => {
    if (!legalGateBlocking) {
      return
    }

    const handleGateKeydownCapture = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element) {
        const insideLegalDialog = target.closest('[data-slot="alert-dialog-content"]')
        if (insideLegalDialog) {
          return
        }
      }
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', handleGateKeydownCapture, true)
    return () => {
      window.removeEventListener('keydown', handleGateKeydownCapture, true)
    }
  }, [legalGateBlocking])

  const visibleLegalDocs = legalGateRequiresReconsent
    ? legalDocsToReview
    : ACCEPTANCE_LEGAL_DOC_KEYS
  const changedDocLabels = legalDocsToReview
    .map((key) => LEGAL_DOC_LABELS[key])
    .join(', ')

  useEffect(() => {
    if (visibleLegalDocs.length === 0) return
    if (!visibleLegalDocs.includes(selectedLegalDoc)) {
      setSelectedLegalDoc(visibleLegalDocs[0] ?? 'eula')
    }
  }, [selectedLegalDoc, visibleLegalDocs])

  const selectedLegalText = legalDocTexts[selectedLegalDoc] ?? ''
  const selectedLegalDocLabel = LEGAL_DOC_LABELS[selectedLegalDoc]
  const legalDocIsLarge = selectedLegalText.length > LEGAL_DOC_PREVIEW_LIMIT
  const legalDocDisplayText =
    legalDocIsLarge && !legalPreviewExpanded
      ? selectedLegalText.slice(0, LEGAL_DOC_PREVIEW_LIMIT)
      : selectedLegalText
  const legalDocPreviewSizeKb = Math.ceil(
    Math.min(selectedLegalText.length, LEGAL_DOC_PREVIEW_LIMIT) / 1024
  )
  const legalDocTotalSizeKb = Math.ceil(selectedLegalText.length / 1024)

  const transformStateKey = useMemo(() => {
    if (!transformDataset?.id) return null
    const familyKey = activeFamilyId ?? 'statistics-1'
    const projectKey = projectId ?? 'project-unknown'
    return `transformState:${projectKey}:${familyKey}:${transformDataset.id}`
  }, [transformDataset?.id, activeFamilyId, projectId])
  useEffect(() => {
    if (!transformStateKey) {
      setTransformUiState({})
      return
    }
    const cached = getViewStateCache<TransformUiState>(transformStateKey) ?? {}
    setTransformUiState(cached)
  }, [transformStateKey])
  const persistTransformUiState = useCallback(
    (patch: Partial<TransformUiState>) => {
      if (!transformStateKey) return
      setTransformUiState((prev) => {
        const next = { ...prev, ...patch }
        setViewStateCache(transformStateKey, next)
        return next
      })
    },
    [transformStateKey]
  )
  // Memoize fallback dataset to avoid O(n) search in effect
  const fallbackDataset = useMemo(() => {
    return datasets.find((dataset) => !rnaseqDatasetIds.has(dataset.id)) ?? null
  }, [datasets, rnaseqDatasetIds])

  useEffect(() => {
    if (activeRNAseqProject) {
      logAppDebug('family_binding_skip', { reason: 'rnaseq_active' })
      return
    }
    if (!activeFamilyId) {
      logAppDebug('family_binding_no_active_family', {
        hasCurrentDataset: Boolean(currentDataset),
      })
      if (currentDataset) {
        setCurrentDataset(null)
      }
      return
    }

    // Use O(1) Map lookup instead of O(n) find()
    const family = familiesById.get(activeFamilyId)
    const isPendingGridSurfaceActivation =
      pendingGridSurfaceActivation?.familyId === activeFamilyId &&
      pendingGridSurfaceActivation?.datasetId === (family?.datasetId ?? null)
    const isCurrentRNAseq = Boolean(currentDataset && rnaseqDatasetIds.has(currentDataset.id))
    const wantsBootstrap = Boolean(family) && (isCurrentRNAseq || (!currentDataset && !fallbackDataset))
    logAppDebug('family_binding_resolve_start', {
      activeFamilyId,
      familyDatasetId: family?.datasetId ?? null,
      currentDatasetId: currentDataset?.id ?? null,
      fallbackDatasetId: fallbackDataset?.id ?? null,
      pendingGridSurfaceDatasetId: pendingGridSurfaceActivation?.datasetId ?? null,
      isPendingGridSurfaceActivation,
      isCurrentRNAseq,
      wantsBootstrap,
      e2eEnabled,
    })
    if (!family?.datasetId) {
      const bootstrapDecision = decideFamilyBootstrap({
        familyDatasetId: family?.datasetId,
        e2eEnabled,
        currentDataset,
        fallbackDataset,
        rnaseqDatasetIds,
      })
      if (e2eEnabled && bootstrapDecision.action !== 'none') {
        console.log('[E2E] Suppressed family blank-dataset bootstrap')
      }
      if (bootstrapDecision.action === 'adopt-existing' && family) {
        // adopt-existing is intentionally synchronous (Map.get + state setters),
        // so there is no await boundary requiring a cancelled guard.
        // If async work is added here later, add cancelled handling to match
        // the create-new branch below.
        applyAdoptExistingBootstrap({
          familyId: family.id,
          decision: bootstrapDecision,
          datasetsById,
          currentDatasetId: currentDataset?.id ?? null,
          setActiveFamilyDataset,
          setCurrentDataset,
        })
        return
      }
      if (bootstrapDecision.action === 'create-new' && family) {
        let cancelled = false
        const init = async () => {
          try {
            const blankDataset = await initializeBlankDataset(`${family.name} Data`)
            if (!cancelled) {
              logAppDebug('family_binding_bootstrap_blank_dataset', {
                familyId: family.id,
                blankDatasetId: blankDataset.id,
              })
              setActiveFamilyDataset(family.id, blankDataset.id, false)
            }
          } catch (error) {
            console.error('Failed to initialize blank dataset for family:', error)
            logAppDebug('family_binding_bootstrap_failed', {
              familyId: family.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        void init()
        return () => {
          cancelled = true
        }
      }
      // Family has no dataset â€” show empty grid (do not borrow an unrelated fallback dataset)
      if (currentDataset) {
        logAppDebug('family_binding_set_null', {
          reason: 'family_missing_dataset',
          currentDatasetId: currentDataset.id,
        })
        setCurrentDataset(null)
      }
      return
    }

    const dataset = resolveFamilyDataset(family, datasetsById)
    if (dataset) {
      const shouldStageGridSurfaceActivation =
        !isPendingGridSurfaceActivation &&
        currentDataset !== null &&
        currentDataset.id !== dataset.id &&
        (dataset.dataRowCount ?? dataset.rowCount ?? 0) === 0 &&
        (currentDataset.dataRowCount ?? currentDataset.rowCount ?? 0) > 0
      if (shouldStageGridSurfaceActivation) {
        const token = pendingGridSurfaceActivationTokenRef.current + 1
        pendingGridSurfaceActivationTokenRef.current = token
        logAppDebug('family_binding_stage_grid_surface_activation', {
          familyId: activeFamilyId,
          pendingDatasetId: dataset.id,
          currentDatasetId: currentDataset.id,
          token,
        })
        setDisplayDatasetId(currentDataset.id)
        setPendingGridSurfaceActivation({
          familyId: activeFamilyId,
          datasetId: dataset.id,
          token,
          status: 'staging',
        })
        return
      }
      if (isPendingGridSurfaceActivation) {
        logAppDebug('family_binding_hold_current_dataset', {
          familyId: activeFamilyId,
          pendingDatasetId: dataset.id,
          currentDatasetId: currentDataset?.id ?? null,
        })
        return
      }
      if (currentDataset?.id !== dataset.id) {
        logAppDebug('family_binding_set_dataset', {
          familyId: activeFamilyId,
          datasetId: dataset.id,
          previousDatasetId: currentDataset?.id ?? null,
        })
        setCurrentDataset(dataset)
      }
    } else {
      if (currentDataset) {
        logAppDebug('family_binding_set_null', {
          reason: 'family_dataset_missing_in_map',
          familyId: activeFamilyId,
          expectedDatasetId: family.datasetId,
          currentDatasetId: currentDataset.id,
        })
        setCurrentDataset(null)
      }
    }
  }, [
    activeFamilyId,
    familiesById,
    datasetsById,
    fallbackDataset,
    currentDataset,
    pendingGridSurfaceActivation,
    setCurrentDataset,
    initializeBlankDataset,
    setActiveFamilyDataset,
    activeRNAseqProject,
    rnaseqDatasetIds,
    e2eEnabled,
    logAppDebug,
  ])
  const canUndoTransform = useMemo(() => {
    if (!currentDataset) return false
    return transformSnapshots.has(currentDataset.id)
  }, [currentDataset, transformSnapshots])
  const activeFamilyResultCount = useResultsStore((state) => {
    if (activeFamilyId) return state.getFamilyResultCount(activeFamilyId)
    return state.results.length
  })
  const showNavigatorRef = useRef(showNavigator)
  const previousResultSignalRef = useRef<{ familyId: string | null; count: number }>({
    familyId: activeFamilyId,
    count: activeFamilyResultCount,
  })
  const toolbarHasData = useMemo(() => {
    const dataset = transformDataset ?? activeDataset ?? currentDataset
    return hasUsableRows(dataset)
  }, [transformDataset, activeDataset, currentDataset])
  const [emptyDataPromptTool, setEmptyDataPromptTool] = useState<string | null>(null)
  const blockIfNoDataRows = useCallback((toolName: string, dataset = transformDataset ?? activeDataset ?? currentDataset): boolean => {
    if (!dataset || hasUsableRows(dataset)) return false
    setEmptyDataPromptTool(toolName)
    return true
  }, [transformDataset, activeDataset, currentDataset])

  useEffect(() => {
    showNavigatorRef.current = showNavigator
  }, [showNavigator])

  useEffect(() => {
    const previous = previousResultSignalRef.current
    const switchedFamily = previous.familyId !== activeFamilyId
    const hasNewResults = activeFamilyResultCount > previous.count
    if (!switchedFamily && hasNewResults && !showNavigatorRef.current) {
      setViewAttentionPulseToken((token) => token + 1)
    }
    previousResultSignalRef.current = {
      familyId: activeFamilyId,
      count: activeFamilyResultCount,
    }
  }, [activeFamilyId, activeFamilyResultCount])

  // Keep results isolated per Statistics tab (family instance)
  useEffect(() => {
    useResultsStore.getState().setActiveStatisticsFamilyId(activeFamilyId)
    usePlotsStore.getState().setActiveStatisticsFamilyId(activeFamilyId)
    const familyId = activeFamilyId ?? 'statistics-1'
    usePlotsStore.getState().migrateLegacyPlots(familyId)
  }, [activeFamilyId])

  // Listen for import progress events
  useEffect(() => {
    const unlisten = listen<{
      datasetId: string
      percentage: number
      message: string
    }>('import-progress', (event) => {
      const { datasetId, percentage, message } = event.payload

      if (percentage === 100) {
        // Close dialog after a brief delay to show completion
        setTimeout(() => {
          setImportProgressState(null)
        }, 500)
      } else {
        setImportProgressState({
          isOpen: true,
          datasetId,
          percentage,
          message,
        })
      }
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // Listen for statistics backend progress events (e.g., Cox bootstrap iterations).
  useEffect(() => {
    const unlisten = listen<{
      type?: string
      source?: string
      stage?: string
      message?: string
      percent?: number
      current?: number
      total?: number
      elapsed_seconds?: number
      eta_seconds?: number
    }>('statistics-progress', (event) => {
      const payload = event.payload
      const appState = useAppStore.getState()
      const lock = appState.appOperationLock
      if (!lock.active || lock.owner !== 'statistics' || !lock.token) return

      const percent =
        typeof payload.percent === 'number' && Number.isFinite(payload.percent)
          ? Math.max(0, Math.min(100, payload.percent))
          : undefined

      const stageLabel = payload.message || payload.stage || 'Running statistical analysis'
      const progressSuffix =
        typeof payload.current === 'number' && typeof payload.total === 'number'
          ? ` (${payload.current}/${payload.total})`
          : ''
      const etaSuffix =
        typeof payload.eta_seconds === 'number' && payload.eta_seconds >= 0
          ? ` ETA ${Math.max(0, Math.round(payload.eta_seconds))}s`
          : ''

      appState.updateAppOperationLock(lock.token, {
        progress: percent ?? lock.progress,
        stage: `${stageLabel}${progressSuffix}${etaSuffix}`,
      })

      if (percent !== undefined) {
        const executionStatus = useAnalysisStore.getState().execution.status
        if (executionStatus === 'running' || executionStatus === 'validating') {
          useAnalysisStore.getState().setExecutionProgress(Math.round(percent))
        }
      }
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // Best-effort prewarm to reduce first-run analysis latency.
  useEffect(() => {
    if (legalGateBlocking) return
    let disposed = false
    let timer: number | null = null

    const attemptPrewarm = () => {
      if (disposed) return
      const latestState = useAppStore.getState()
      if (latestState.appOperationLock.active) {
        timer = window.setTimeout(attemptPrewarm, 1500)
        return
      }
      void tauriApi.prewarmStatisticsBackend(['survival']).catch(() => {
        // Silent by design: prewarm should never block or notify users.
      })
    }

    timer = window.setTimeout(attemptPrewarm, 1200)
    return () => {
      disposed = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [legalGateBlocking])

  useEffect(() => {
    if (legalGateBlocking) return
    let disposed = false
    let timer: number | null = null

    const runCheck = () => {
      if (disposed) return
      const latestState = useAppStore.getState()
      if (latestState.appOperationLock.active) {
        timer = window.setTimeout(runCheck, 2000)
        return
      }
      void maybeShowCacheHealthWarning('startup')
    }

    timer = window.setTimeout(runCheck, 2400)
    return () => {
      disposed = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [legalGateBlocking, maybeShowCacheHealthWarning])

  // Best-effort prewarm to reduce first PDF/TIFF export latency.
  useEffect(() => {
    if (legalGateBlocking) return
    let disposed = false
    let timer: number | null = null
    let idleTimer: number | null = null

    const attemptWarmup = () => {
      if (disposed) return
      const latestState = useAppStore.getState()
      if (latestState.appOperationLock.active) {
        timer = window.setTimeout(attemptWarmup, 2000)
        return
      }
      void prewarmKaleidoOnIdle().catch(() => {
        // Silent by design.
      })
    }

    const schedule = () => {
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: () => void) => number
        cancelIdleCallback?: (handle: number) => void
      }
      if (typeof idleWindow.requestIdleCallback === 'function') {
        idleTimer = idleWindow.requestIdleCallback(() => {
          timer = window.setTimeout(attemptWarmup, 400)
        })
        return
      }
      timer = window.setTimeout(attemptWarmup, 1800)
    }

    schedule()
    return () => {
      disposed = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      if (idleTimer !== null) {
        const idleWindow = window as Window & {
          cancelIdleCallback?: (handle: number) => void
        }
        idleWindow.cancelIdleCallback?.(idleTimer)
      }
    }
  }, [legalGateBlocking])

  // Phase 0: Validation error dialog state
  const [validationError, setValidationError] = useState<{
    result: TestValidationResult
    testName: string
  } | null>(null)

  // Phase 8 + Phase 2: Relink source dialog state for large dataset recovery
  const [relinkDialogState, setRelinkDialogState] = useState<{
    isOpen: boolean
    datasetName: string
    originalPath: string
    reason: RelinkReason
    datasetId: string
    duckdbPath?: string // Phase 2: For duckdb-missing and both-missing
    sourcePath?: string // Phase 2: For both-missing
  } | null>(null)
  const relinkResolverRef = useRef<{
    resolve: (result: {
      action: 'relink' | 'relink-duckdb' | 'use-fallback' | 'skip' | 'cancel'
      newPath?: string
      fileType?: 'source' | 'duckdb'
    }) => void
  } | null>(null)

  // Import progress state (large dataset imports)
  const [importProgressState, setImportProgressState] = useState<{
    isOpen: boolean
    datasetId: string
    percentage: number
    message: string
  } | null>(null)

  const [sampleDatasetsOpen, setSampleDatasetsOpen] = useState(false)
  const [sampleDatasetsSearch, setSampleDatasetsSearch] = useState('')
  const [pendingGuideTestId, setPendingGuideTestId] = useState<string | null>(null)
  // OLE integration dialog state (Windows only, first-launch prompt)

  // Phase 1B: Statistical analysis orchestration controller
  const {
    dialogState,
    dialogContext,
    runAnalysisWithTests,
    handleDVSelectionConfirm,
    handleDVSelectionCancel,
    handleDVEncodingConfirm,
    handleDVEncodingCancel,
    handleFactorEncodingConfirm,
    handleFactorEncodingCancel,
    handleSimpleEffectsConfirm,
    handleSimpleEffectsCancel,
    handleMultiFactorialSimpleEffectsConfirm,
    handleMultiFactorialSimpleEffectsCancel,
    handleLmmAnovaConfigConfirm,
    handleLmmAnovaConfigCancel,
    handleTwoWayFactorMapperConfirm,
    handleTwoWayFactorMapperCancel,
    handleMultifactorialFactorMapperConfirm,
    handleMultifactorialFactorMapperCancel,
    handleDoseResponseColumnMapperConfirm,
    handleDoseResponseColumnMapperCancel,
    handleSynergyColumnMapperConfirm,
    handleSynergyColumnMapperCancel,
    handleChiSquareGofColumnMapperConfirm,
    handleChiSquareGofColumnMapperCancel,
    handleChiSquareColumnMapperConfirm,
    handleChiSquareColumnMapperCancel,
    handleFisherExactColumnMapperConfirm,
    handleFisherExactColumnMapperCancel,
    handleMcNemarColumnMapperConfirm,
    handleMcNemarColumnMapperCancel,
    handleIndependentTTestColumnMapperConfirm,
    handleIndependentTTestColumnMapperCancel,
    handleMannWhitneyColumnMapperConfirm,
    handleMannWhitneyColumnMapperCancel,
    handlePairedTTestColumnMapperConfirm,
    handlePairedTTestColumnMapperCancel,
    handleWilcoxonColumnMapperConfirm,
    handleWilcoxonColumnMapperCancel,
    handleOneWayAnovaColumnMapperConfirm,
    handleOneWayAnovaColumnMapperCancel,
    handleKruskalWallisColumnMapperConfirm,
    handleKruskalWallisColumnMapperCancel,
    handleSurvivalAnalysisConfirm,
    handleSurvivalAnalysisCancel,
    handleMediationAnalysisConfirm,
    handleMediationAnalysisCancel,
    handleModerationAnalysisConfirm,
    handleModerationAnalysisCancel,
    handleModeratedMediationAnalysisConfirm,
    handleModeratedMediationAnalysisCancel,
    handleConfirmDialogConfirm,
    handleConfirmDialogCancel,
    handleExecutionModeSelect,
  } = useStatisticalAnalysisController()
  const [gridViewScope, setGridViewScope] = useState<GridViewScope | null>(null)

  useEffect(() => {
    setGridViewScope(null)
  }, [currentDataset?.id])

  // Compute dialog data from dialogContext
  const dvDialogData = useMemo(() => ({
    columns: toColumnMetadata(dialogContext.columns),
    mode: getDVDialogMode(dialogContext.selectedTests),
  }), [dialogContext])

  const dvEncodingDialogData = useMemo(() => {
    // DV is the first column in context (assumption: controller sets it up this way)
    const dvColumn = dialogContext.columns[0]
    return {
      columnName: dvColumn?.columnName ?? '',
      categories: extractLevels(dvColumn),
      testType: getDVEncodingType(dvColumn),
    }
  }, [dialogContext])

  const factorEncodingDialogData = useMemo(() => ({
    factors: toFactorMetadata(dialogContext.columns),
  }), [dialogContext])

  const factorMappingColumns = useMemo(
    () =>
      dialogContext.columns.filter(
        (col, idx) =>
          idx > 0 &&
          (col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary)
      ),
    [dialogContext]
  )

  const simpleEffectsDialogData = useMemo(() => {
    // Get categorical factors (excluding DV which is at index 0)
    const categoricalFactors = dialogContext.columns
      .filter(
        (col, idx) =>
          idx > 0 &&
          (col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary)
      )

    return {
      factor1Name: categoricalFactors[0]?.columnName ?? 'Factor 1',
      factor2Name: categoricalFactors[1]?.columnName ?? 'Factor 2',
      factor1Levels: extractLevels(categoricalFactors[0]),
      factor2Levels: extractLevels(categoricalFactors[1]),
    }
  }, [dialogContext])

  const multiFactorialSimpleEffectsDialogData = useMemo(() => {
    // Use factor names passed directly from controller (not from context)
    // This avoids async state timing issues where dialog opens before context updates
    const factorLevels: Record<string, string[]> = {}
    for (const name of dialogState.multiFactorialFactorNames) {
      const column = dialogContext.columns.find((col) => col.columnName === name)
      factorLevels[name] = extractLevels(column)
    }
    return {
      factorNames: dialogState.multiFactorialFactorNames,
      factorLevels,
    }
  }, [dialogContext.columns, dialogState.multiFactorialFactorNames])

  // Wire menu accelerators / global shortcuts
  useMainWindowEventListeners({ disabled: legalGateBlocking })

  // Get selected test from analysis store
  const selectedTest = useAnalysisStore(state => state.selectedTest)
  const selectTest = useAnalysisStore(state => state.selectTest)
  const warnedPerformTestWithUserPlotsRef = useRef<Set<string>>(new Set())
  const performTestWarningSessionIdRef = useRef(crypto.randomUUID())

  const confirmPerformTestWithUserPlotsIfNeeded = useCallback(
    async (familyId: string, testName: string, datasetId?: string | null): Promise<boolean> => {
      try {
        await ensureProjectId()
      } catch {
        // Best effort; fallback scope key handles this case.
      }
      const latestProjectId = useAppStore.getState().projectId
      const warningKey = buildPerformTestWarningKey({
        projectId: latestProjectId ?? projectId,
        familyId,
        datasetId,
        sessionId: performTestWarningSessionIdRef.current,
      })
      if (warnedPerformTestWithUserPlotsRef.current.has(warningKey)) {
        return true
      }

      const userPlots = usePlotsStore
        .getState()
        .plots.filter(
          (plot) =>
            (plot.statisticsFamilyId ?? 'statistics-1') === familyId &&
            plot.sourceType === 'user_derived'
        )
      if (userPlots.length === 0) {
        return true
      }

      const proceed = await confirm(
        `You have ${userPlots.length} user-created plot${userPlots.length === 1 ? '' : 's'} in this Statistics tab.\n\n` +
          `Running ${testName} will add generated test plots. Your user-created plots will not be deleted.\n\n` +
          'Do you want to continue?',
        {
          title: 'User Plots Detected',
          kind: 'warning',
        }
      )

      if (proceed) {
        warnedPerformTestWithUserPlotsRef.current.add(warningKey)
      }
      return proceed
    },
    [projectId]
  )

  /**
   * Handle test execution after columns are selected.
   * Maps selected columns to registry-defined data fields, validates input,
   * and invokes the generic Python dispatcher.
   */
  const handleTestExecution = useCallback(async (selectedColumns: SelectedColumnInfo[]) => {
    if (!selectedTest || !currentDataset) {
      toast.error('Select a test and dataset before running analysis')
      return
    }

    const testDef = getTestDefinition(selectedTest.id)
    if (!testDef) {
      toast.error(`Unknown test definition: ${selectedTest.id}`)
      return
    }

    // =========================================================================
    // PHASE 0+1: UNIFIED DATA PREPARATION FOR MODULAR TESTS
    // =========================================================================
    // Build rowsArray with ONLY selected columns to minimize memory footprint
    // This unified structure is reused for both validation and payload building
    let module: ITestModule | null = null
    let rowsArray: unknown[][] | null = null
    let classifications: ColumnClassification[] | null = null

    if (testDef.moduleId) {
      try {
        // Phase 2: Use ModuleRegistry for centralized module management
        module = await moduleRegistry.getModule(testDef.moduleId)

        if (module) {
          // Step 1: Capture ACTUAL dataset indices for each selected column
          // These are the real positions in currentDataset.columns (e.g., 3, 7, 15)
          // We MUST preserve these for:
          // - ColumnClassification.columnIndex contract
          // - Encoding maps in Phase 2
          // - Validator warnings that reference grid columns
          const datasetIndices = selectedColumns.map(col => {
            const actualIndex = currentDataset.columns.findIndex(c => c.id === col.id)
            if (actualIndex === -1) {
              throw new Error(`Column ${col.name} not found in dataset`)
            }
            return actualIndex
          })

          const storageInfo = await cacheService.getDatasetStorageInfo(currentDataset.id)
          const selectedColumnIds = selectedColumns.map(col => col.id)
          const activeGridScope = gridViewScope?.datasetId === currentDataset.id ? gridViewScope : null
          const scopedDataModelRows =
            activeGridScope?.source === 'view-filter' && activeGridScope.dataModelRows !== null
              ? activeGridScope.dataModelRows.filter((rowIdx) => {
                const dataRowCount = currentDataset.dataRowCount ?? currentDataset.rowCount
                return rowIdx >= 0 && rowIdx < dataRowCount
              })
              : null

          const getEffectiveOverrideType = (columnId: string, selectedInfo: SelectedColumnInfo) => {
            return (
              selectedInfo.overrideType ??
              mapPersistedOverrideToUi(getColumnTypeOverride(currentDataset.id, columnId))
            )
          }

          const toCoreClassification = (
            classification: UiColumnClassification,
            datasetIndex: number,
            columnId: string
          ): ColumnClassification => {
            const minNumeric = classification.minNumericValue
            const maxNumeric = classification.maxNumericValue
            const allIntegerValues =
              classification.numericRatio === 1 &&
              Number.isInteger(minNumeric ?? 0) &&
              Number.isInteger(maxNumeric ?? 0)

            return {
              columnIndex: datasetIndex,
              columnName: classification.columnName,
              columnId,
              dataType: mapUiTypeToCore(classification.dataType),
              totalValues: classification.totalValues,
              numericValues: classification.numericValues,
              categoricalValues: classification.categoricalValues,
              missingValues: classification.missingValues,
              uniqueValueCount: classification.uniqueValueCount,
              uniqueValues: classification.uniqueValues ?? [],
              isBinary: classification.isBinary,
              isOrdinal: classification.isOrdinal,
              isConstant: classification.isConstant,
              hasMissingData: classification.hasMissingData,
              numericRatio: classification.numericRatio,
              minNumericValue: minNumeric,
              maxNumericValue: maxNumeric,
              allIntegerValues,
              detectedType: mapUiTypeToCore(
                classification.detectedType ?? classification.dataType
              ),
              overrideType: classification.overrideType
                ? mapUiTypeToCore(classification.overrideType)
                : undefined,
              effectiveType: mapUiTypeToCore(
                classification.effectiveType ?? classification.dataType
              ),
              suggestedTests: classification.suggestedTests ?? [],
            }
          }

          if (storageInfo.isLarge) {
            const { getColumnClassification, setColumnClassification } = useDataStore.getState()
            const cachedSelections = selectedColumns.map(col =>
              getColumnClassification(col.id)?.classification as UiColumnClassification | undefined
            )
            const needsStats = cachedSelections.some(cached => !cached)
            let statsMap: Map<string, ColumnClassificationStats> | null = null

            if (needsStats) {
              await cacheService.ensureLatestCache(currentDataset.id)
              statsMap = new Map<string, ColumnClassificationStats>()
              const stats = await cacheService.getAllColumnStats(currentDataset.id)
              for (const stat of stats) {
                statsMap.set(stat.columnId, stat)
              }
            }

            classifications = selectedColumns.map((col, idx) => {
              let cached = cachedSelections[idx]

              if (!cached && statsMap) {
                const stats = statsMap.get(col.id)
                if (stats) {
                  cached = classifyColumnFromStats(col.id, col.name, stats)
                  setColumnClassification(col.id, { classification: cached })
                }
              }

              if (!cached) {
                throw new Error(`Column classification not available for ${col.name}`)
              }
              const overridden = applyColumnTypeOverride(
                cached,
                getEffectiveOverrideType(col.id, col)
              )
              return toCoreClassification(overridden, datasetIndices[idx]!, col.id)
            })
          } else {
            // Step 2: Fetch ONLY selected columns from backend cache
            // (avoids duplicating entire dataset in frontend memory)
            await cacheService.ensureLatestCache(currentDataset.id)
            const columnsData = await cacheService.getColumnsData(
              currentDataset.id,
              selectedColumnIds
            )

            // Derive row count from first selected column
            const firstColId = selectedColumnIds[0]
            const rowCount =
              firstColId && Array.isArray(columnsData[firstColId])
                ? columnsData[firstColId]!.length
                : 0
            const analysisRowIndices = scopedDataModelRows ?? Array.from({ length: rowCount }, (_row, rowIdx) => rowIdx)

            if (rowCount === 0 || analysisRowIndices.length === 0) {
              toast.error('No data available for this dataset')
              return
            }

            // Build rowsArray as row-major matrix [rowIndex][localColumnIndex]
            rowsArray = analysisRowIndices.map((rowIdx) =>
              selectedColumnIds.map(colId => columnsData[colId]?.[rowIdx])
            )

            // Step 3: Create local indices for extractAlignedData (0, 1, 2...)
            // These reference positions in the trimmed rowsArray
            const localIndices = selectedColumns.map((_, idx) => idx)

            // Step 4: Classify selected columns using LOCAL indices on trimmed data
            // Then overwrite columnIndex with ACTUAL dataset indices and store column ID
            classifications = selectedColumns.map((col, idx) => {
              const classification = classifyColumn(localIndices[idx]!, col.name, rowsArray!)
              const overrideType = getEffectiveOverrideType(col.id, col)
              if (overrideType) {
                const detectedType = classification.detectedType ?? classification.dataType
                const effectiveType = mapUiTypeToCore(overrideType)
                classification.detectedType = detectedType
                classification.overrideType = effectiveType
                classification.effectiveType = effectiveType
                classification.dataType = effectiveType
                classification.isBinary =
                  effectiveType === ColumnDataType.Binary ||
                  (effectiveType === detectedType && classification.isBinary)
                classification.isOrdinal =
                  effectiveType === ColumnDataType.Ordinal ||
                  (effectiveType === detectedType && classification.isOrdinal)
              } else {
                classification.detectedType = classification.detectedType ?? classification.dataType
                classification.effectiveType = classification.dataType
              }
              classification.dataType = classification.effectiveType ?? classification.dataType
              // CRITICAL: Restore actual dataset index for downstream consumers
              classification.columnIndex = datasetIndices[idx]!
              // Store column ID for data slicing in executeTest
              classification.columnId = col.id
              return classification
            })
          }

          const overridePreflightErrors = selectedColumns.flatMap((selectedInfo, idx) => {
            const classification = classifications?.[idx]
            if (!classification) return []

            const effectiveType = classification.effectiveType ?? classification.dataType
            const errors: string[] = []
            const isOverridden = Boolean(selectedInfo.overrideType)
            const allowConstantNumericColumn = testDef.id === 'chi_square_gof'

            if (
              !allowConstantNumericColumn &&
              (effectiveType === ColumnDataType.Numeric || effectiveType === ColumnDataType.Ordinal) &&
              classification.isConstant
            ) {
              errors.push(
                `Column "${selectedInfo.name}" is constant. Choose a column with variation for numeric analyses.`
              )
            }

            if (!isOverridden) return errors

            if (effectiveType === ColumnDataType.Numeric || effectiveType === ColumnDataType.Ordinal) {
              if (classification.numericValues === 0) {
                errors.push(
                  `Column "${selectedInfo.name}" was overridden to ${effectiveType} but has no parseable numeric values.`
                )
              } else if ((classification.numericRatio ?? 0) < TYPE_CLASSIFICATION_RULES.mixedRatioForNumericFallback) {
                errors.push(
                  `Column "${selectedInfo.name}" was overridden to ${effectiveType}, but only ${Math.round(
                    (classification.numericRatio ?? 0) * 100
                  )}% of non-missing values are numeric.`
                )
              }
            }

            if (effectiveType === ColumnDataType.Binary && classification.uniqueValueCount !== 2) {
              errors.push(
                `Column "${selectedInfo.name}" was overridden to binary but has ${classification.uniqueValueCount} unique values.`
              )
            }

            if (effectiveType === ColumnDataType.Categorical && classification.uniqueValueCount < 2) {
              errors.push(
                `Column "${selectedInfo.name}" was overridden to categorical but has fewer than 2 unique values.`
              )
            }

            return errors
          })

          if (overridePreflightErrors.length > 0) {
            toast.error('Column type override validation failed', {
              description: overridePreflightErrors[0],
            })
            return
          }

          const numericDropWarnings = selectedColumns.flatMap((selectedInfo, idx) => {
            const classification = classifications?.[idx]
            if (!classification) return []
            const effectiveType = classification.effectiveType ?? classification.dataType
            if (
              effectiveType !== ColumnDataType.Numeric &&
              effectiveType !== ColumnDataType.Ordinal
            ) {
              return []
            }

            const nonMissing = Math.max(
              0,
              ((classification.numericValues ?? 0) + (classification.categoricalValues ?? 0)) ||
                ((classification.totalValues ?? 0) - (classification.missingValues ?? 0))
            )
            const dropped = Math.max(0, nonMissing - (classification.numericValues ?? 0))
            if (dropped === 0) return []

            return [
              `${selectedInfo.name}: ${dropped} non-numeric value${dropped === 1 ? '' : 's'} will be dropped.`,
            ]
          })

          if (numericDropWarnings.length > 0) {
            const extra =
              numericDropWarnings.length > 1
                ? ` (+${numericDropWarnings.length - 1} more columns)`
                : ''
            toast.warning('Numeric coercion will drop some rows', {
              description: `${numericDropWarnings[0]}${extra}`,
            })
          }

          const isSurvivalTest = testDef.family === 'survival'

          if (isSurvivalTest) {
            const minColumns = testDef.id === 'cox_regression' ? 3 : 2
            if (classifications.length < minColumns) {
              toast.error(`Select at least ${minColumns} columns for ${testDef.displayName}.`)
              return
            }

            const hasNumeric = classifications.some(
              column => column.dataType === ColumnDataType.Numeric
            )
            const hasBinaryEvent = classifications.some(
              column => column.isBinary && column.uniqueValueCount === 2
            )

            if (!hasNumeric || !hasBinaryEvent) {
              toast.error('Select a numeric time column and a binary event column.')
              return
            }
          }

          if (!isSurvivalTest && !ensureNumericDVFirst(classifications, testDef.id)) {
            return
          }

          // =========================================================================
          // PHASE 0: MODULAR VALIDATION
          // =========================================================================
          if (!isSurvivalTest) {
            const validationResult = module.validateSelection(classifications)

            // If validation fails, show error dialog and stop
            if (!validationResult.isValid) {
              setValidationError({
                result: validationResult,
                testName: selectedTest.name,
              })
              return
            }

            // If validation passes but has warnings/suggestions, show them via toast.
            // Skip regression toasts for logistic tests until DV is chosen to avoid misleading messages.
            const suppressRegressionToasts =
              testDef.family === 'regression' &&
              (testDef.id === 'logistic_regression' || testDef.id === 'logistic_multinomial')

            if (!suppressRegressionToasts) {
              if (validationResult.warnings.length > 0) {
                validationResult.warnings.forEach(warning => {
                  toast.warning(warning)
                })
              }

              if (validationResult.suggestions.length > 0) {
                validationResult.suggestions.forEach(suggestion => {
                  toast.info(suggestion)
                })
              }
            }
          }
        }
      } catch (error) {
        console.error('Module validation error:', error)
        toast.error(`Validation failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    // =========================================================================
    // END PHASE 0 VALIDATION
    // =========================================================================

    // =========================================================================
    // NEW: CONTROLLER ORCHESTRATION
    // =========================================================================
    // After validation passes, use controller to orchestrate dialogs and execute test
    if (module && classifications) {
      try {
        const runFamilyId = activeFamilyId ?? 'statistics-1'
        const proceedWithUserPlotWarning = await confirmPerformTestWithUserPlotsIfNeeded(
          runFamilyId,
          selectedTest.name,
          currentDataset?.id ?? null
        )
        if (!proceedWithUserPlotWarning) {
          return
        }

        const activeGridScope = gridViewScope?.datasetId === currentDataset.id ? gridViewScope : null
        await runAnalysisWithTests([selectedTest.id], classifications, currentDataset, activeFamilyId, activeGridScope)
        // Controller handles everything - orchestration, dialogs, execution
        // Close dialogs and return early
        setColumnDialogOpen(false)
        setTestDialogOpen(false)
        return
      } catch (error) {
        console.error('Controller orchestration error:', error)
        if (!wasErrorToastShown(error)) {
          const structuredError = extractAppError(error)
          if (structuredError) {
            showAppErrorToast(structuredError)
            markErrorToastShown(error)
          } else {
            toast.error(`Analysis failed: ${extractErrorMessage(error, 'Analysis failed')}`)
          }
        }
        return
      }
    }
    // =========================================================================
    // END CONTROLLER ORCHESTRATION
    // =========================================================================
  }, [
    selectedTest,
    currentDataset,
    gridViewScope,
    activeFamilyId,
    confirmPerformTestWithUserPlotsIfNeeded,
    runAnalysisWithTests,
  ])

  // Ensure a blank spreadsheet is always available (re-run after clears)
  const hasInitialized = useRef(false)

  // Refs to store Sort/Group/Filter dialog openers from SpreadsheetView
  const openSortDialogRef = useRef<(() => void) | null>(null)
  const openGroupDialogRef = useRef<(() => void) | null>(null)
  // Ref to SpreadsheetView's picker-origin column filter opener (Phase 3)
  const openColumnFilterRef = useRef<((colId: string, bounds: { x: number; y: number; width: number; height: number }) => void) | null>(null)

  // Column picker popover state (Phase 3 â€” owned by AppShell)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerColumns, setPickerColumns] = useState<import('@/store/data-store').ColumnMetadata[]>([])
  // Bounds of the Filter toolbar button â€” used to anchor the picker popover
  const [pickerAnchorBounds, setPickerAnchorBounds] = useState<{ x: number; y: number; width: number; height: number } | undefined>(undefined)
  // Always reflects the CURRENT activeDataset id so in-flight picker loads can
  // detect staleness even without a second open call.
  const activeDatasetIdForPickerRef = useRef<string | undefined>(activeDataset?.id)
  useEffect(() => {
    activeDatasetIdForPickerRef.current = activeDataset?.id
  }, [activeDataset])
  // Mirror of SpreadsheetView's viewFilterConfig for picker active-indicators
  const [pickerViewFilterConfig, setPickerViewFilterConfig] = useState<import('@/services/dataTransformService').FilterConfig | null>(null)
  const copyRef = useRef<(() => void | Promise<void>) | null>(null)
  const cutRef = useRef<(() => void | Promise<void>) | null>(null)
  const pasteRef = useRef<(() => void | Promise<void>) | null>(null)
  const undoRef = useRef<(() => void | Promise<void>) | null>(null)
  const redoRef = useRef<(() => void | Promise<void>) | null>(null)
  const filterUndoRef = useRef<(() => boolean) | null>(null)
  const filterClearRef = useRef<(() => void) | null>(null)
  const [canUndoFilter, setCanUndoFilter] = useState(false)
  const openInsertMenuRef = useRef<((x: number, y: number) => void) | null>(null)
  const pendingInsertMenuRef = useRef<{ x: number; y: number } | null>(null)

  // Phase 3: open the column picker popover and load columns with data
  const handleOpenFilterPicker = useCallback(async (bounds: { x: number; y: number; width: number; height: number }) => {
    const dataset = activeDataset
    if (!dataset) return
    if (blockIfNoDataRows('Filter', dataset)) return
    const capturedId = dataset.id
    setPickerAnchorBounds(bounds)
    try {
      const columns = await filterColumnsWithData(dataset.id, dataset.columns, [], 'filter-picker', 'missing_as_empty')
      // Discard if the active dataset changed while loading.
      // activeDatasetIdForPickerRef.current is the LIVE current value (not the captured one),
      // so this fires correctly even if no second picker open occurs.
      if (activeDatasetIdForPickerRef.current !== capturedId) return
      setPickerColumns(columns)
      setPickerOpen(true)
    } catch (err) {
      console.warn('[picker] Failed to load filter columns:', err)
    }
  }, [activeDataset, blockIfNoDataRows])

  const handleToolbarInsertMenu = useCallback((x: number, y: number) => {
    const open = openInsertMenuRef.current
    if (open) {
      open(x, y)
      return
    }
    // SpreadsheetView may be remounting; queue one open request to flush on registration.
    pendingInsertMenuRef.current = { x, y }
  }, [])

  const handleInsertMenuRegistration = useCallback(
    (open: ((x: number, y: number) => void) | null) => {
      openInsertMenuRef.current = open
      if (open && pendingInsertMenuRef.current) {
        const pending = pendingInsertMenuRef.current
        pendingInsertMenuRef.current = null
        open(pending.x, pending.y)
      }
    },
    []
  )

  // Ref for programmatic Navigator panel collapse/expand
  const navigatorPanelRef = useRef<ImperativePanelHandle>(null)
  const mainContentRef = useRef<HTMLDivElement>(null)

  // Sync showNavigator toggle with Navigator panel collapse/expand
  useEffect(() => {
    if (!navigatorPanelRef.current) return
    if (showNavigator) {
      navigatorPanelRef.current.expand()
    } else {
      navigatorPanelRef.current.collapse()
    }
  }, [showNavigator])

  // Fix layout on window restore/visibility change (viewport + reflow)
  useEffect(() => {
    let cancelPendingRefresh: (() => void) | null = null
    let unlistenResize: (() => void) | null = null

    const applyViewportVars = (width: number, height: number) => {
      document.documentElement.style.setProperty('--app-width', `${width}px`)
      document.documentElement.style.setProperty('--app-height', `${height}px`)
      if (mainContentRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        mainContentRef.current.offsetHeight
      }
      cancelPendingRefresh = null
    }

    const readViewportSize = () => ({
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    })

    const applyNow = () => {
      const { width, height } = readViewportSize()
      applyViewportVars(width, height)
    }

    const scheduleRefresh = () => {
      cancelPendingRefresh?.()
      cancelPendingRefresh = scheduleViewportVarsRefresh(readViewportSize, applyViewportVars)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleRefresh()
      }
    }

    const handleResize = () => {
      scheduleRefresh()
    }

    applyNow()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)

    if (typeof window !== 'undefined' && '__TAURI__' in window) {
      const appWindow = getCurrentWindow()
      appWindow.onResized(() => {
        scheduleRefresh()
      }).then((unlisten) => {
        unlistenResize = unlisten
      }).catch(() => {
        // ignore
      })
    }

    return () => {
      cancelPendingRefresh?.()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
      if (unlistenResize) {
        unlistenResize()
      }
    }
  }, [])

  useEffect(() => {
    if (e2eEnabled) {
      console.log('[E2E] Skipping global startup blank-dataset bootstrap')
      hasInitialized.current = true
      return
    }
    // Family-scoped effects own bootstrap. Avoid creating an unowned global
    // "Spreadsheet" dataset that can race with family binding.
    if (activeFamilyId || activeRNAseqProject) {
      hasInitialized.current = true
      return
    }
    if (legalGateBlocking) return
    if (hasInitialized.current) return
    let cancelled = false
    const init = async () => {
      try {
        await initializeBlankDataset('Spreadsheet')
      } catch (error) {
        const message = extractErrorMessage(error, 'Failed to initialize blank dataset')
        console.error('Failed to initialize blank dataset:', message)
        toast.error('Failed to initialize blank dataset', { description: message })
      } finally {
        if (!cancelled) {
          hasInitialized.current = true
        }
      }
    }
    void init()
    return () => {
      cancelled = true
    }
  }, [initializeBlankDataset, legalGateBlocking, e2eEnabled, activeFamilyId, activeRNAseqProject])

  const MIN_COLUMNS = 100
  const MIN_ROWS = 100
  const ROW_BUFFER = 50 // Extra rows beyond data for manual entry
  // All-DuckDB: LARGE_DATASET_THRESHOLD removed - all datasets use DuckDB
  const DEFAULT_COLUMN_WIDTH = 88

  const extendColumns = (baseColumns: ColumnMetadata[]): ColumnMetadata[] => {
    const columns = [...baseColumns]
    const usedIds = new Set(columns.map((col) => col.id))
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

  const TRANSFORM_MAX_ROWS = 250_000
  const TRANSFORM_SAMPLE_SIZE = 100
  const FILTER_MATCH_COUNT_JS_MAX_ROWS = 50_000
  const TRANSFORM_SAMPLE_COLUMNS = 1
  const TRANSFORM_SNAPSHOT_WARN_ROWS = 100_000
  const TRANSFORM_PIVOT_STREAM_THRESHOLD = 20_000

  /** Yield to the event loop so React can paint (e.g. spinner overlay) before a blocking sync call. */
  const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  // Note: 'sort' is AppShell-only (not a dataset transform type), so it cannot
  // go into getTransformLabel. All other types delegate to the shared helper.
  const OPERATION_LABELS: Record<string, string> = {
    sort: 'Sort',
  }

  /** Show a confirmation dialog and return a promise that resolves to the user's choice. */
  const confirmPreflight = (_preflight: PreflightResult, type: string, rowCount: number): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      preflightResolverRef.current = resolve
      setPreflightConfirm({
        message: `This dataset has ${rowCount.toLocaleString()} rows. ${OPERATION_LABELS[type] ?? getTransformLabel(type)} on large datasets may take a moment.`,
        rowCount,
        operationLabel: OPERATION_LABELS[type] ?? getTransformLabel(type),
      })
    })
  }

  const handlePreflightConfirmResponse = (confirmed: boolean) => {
    preflightResolverRef.current?.(confirmed)
    preflightResolverRef.current = null
    setPreflightConfirm(null)
  }

  const buildColumnData = (
    columns: ColumnMetadata[],
    valuesById: Record<string, unknown[]>
  ): ColumnData[] =>
    columns.map((col) => ({
      id: col.id,
      values: (valuesById[col.id] ?? []) as Array<string | number | boolean | null>,
      dataType: 'text',
    }))

  const parseCandidateBindings = (error: unknown): string[] | null => {
    const message = error instanceof Error ? error.message : String(error)
    const marker = 'Candidate bindings:'
    const markerIndex = message.indexOf(marker)
    if (markerIndex === -1) return null
    const tail = message.slice(markerIndex + marker.length)
    const stopIndex = tail.search(/\nLINE\s*\d*:/)
    const candidateBlock = stopIndex === -1 ? tail : tail.slice(0, stopIndex)
    const matches = Array.from(candidateBlock.matchAll(/"([^"]+)"/g))
      .map((match) => match[1])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    return matches.length > 0 ? matches : null
  }

  const isSchemaBindingError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    return (
      message.includes('Candidate bindings:') ||
      /binder error/i.test(message) ||
      /not found/i.test(message)
    )
  }

  const probeAvailableColumnIds = async (
    columnIds: string[],
    probe: (ids: string[]) => Promise<void>,
    originalError: unknown
  ): Promise<string[]> => {
    try {
      await probe(columnIds)
      return columnIds
    } catch (error) {
      if (!isSchemaBindingError(error)) {
        throw error
      }
      if (columnIds.length === 1) {
        return []
      }
      const mid = Math.floor(columnIds.length / 2)
      const left = columnIds.slice(0, mid)
      const right = columnIds.slice(mid)
      const [leftAvailable, rightAvailable] = await Promise.all([
        probeAvailableColumnIds(left, probe, originalError),
        probeAvailableColumnIds(right, probe, originalError),
      ])
      return [...leftAvailable, ...rightAvailable]
    }
  }

  const discoverAvailableColumnsBySampling = async (
    datasetId: string,
    columnIds: string[],
    sampleSize: number,
    originalError: unknown
  ): Promise<string[]> => {
    if (!isSchemaBindingError(originalError)) {
      throw originalError
    }
    return probeAvailableColumnIds(
      columnIds,
      async (ids) => {
        await cacheService.getColumnsSampledData(datasetId, ids, sampleSize)
      },
      originalError
    )
  }

  const getNoDataColumnIds = async (dataset: Dataset): Promise<Set<string>> => {
    try {
      const stats = await cacheService.getAllColumnStats(dataset.id)
      const nonNullById = new Map(stats.map((stat) => [stat.columnId, stat.nonNullCount]))
      const noDataIds = new Set<string>()
      for (const column of dataset.columns) {
        const nonNull = nonNullById.get(column.id)
        if (nonNull === undefined || nonNull <= 0) {
          noDataIds.add(column.id)
        }
      }
      return noDataIds
    } catch (error) {
      console.warn('[Transform] Failed to load column stats for no-data filtering.', error)
      return new Set<string>()
    }
  }

  const getColumnsWithData = async (
    dataset: Dataset,
    columns: ColumnMetadata[],
    contextLabel: string,
    options: { hideEmptyColumns?: boolean } = {}
  ): Promise<ColumnMetadata[]> => {
    if (!options.hideEmptyColumns) {
      return columns
    }
    return filterColumnsWithData(dataset.id, columns, [], `[Transform] ${contextLabel}`, 'missing_as_empty')
  }

  const resolveTransformColumns = async (
    dataset: Dataset,
    options: { requireFullSchema?: boolean; contextLabel?: string } = {}
  ): Promise<TransformSchemaResolution> => {
    const requireFullSchema = options.requireFullSchema ?? false
    const contextLabel = options.contextLabel ?? 'transform'
    const columnIds = dataset.columns.map((col) => col.id)
    try {
      try {
        await cacheService.ensureLatestCache(dataset.id)
      } catch (error) {
        console.error('Failed to flush pending edits before sampling columns:', error)
      }
      await cacheService.getColumnsSampledData(dataset.id, columnIds, TRANSFORM_SAMPLE_COLUMNS)
      return {
        columns: dataset.columns,
        partial: false,
        availableColumns: dataset.columns.length,
        missingColumns: 0,
        ignorableMissingColumns: 0,
        totalColumns: dataset.columns.length,
      }
    } catch (error) {
      const discoveredIds = await discoverAvailableColumnsBySampling(
        dataset.id,
        columnIds,
        TRANSFORM_SAMPLE_COLUMNS,
        error
      )
      const discoveredSet = new Set(discoveredIds)
      const filtered = dataset.columns.filter((col) => discoveredSet.has(col.id))
      if (filtered.length === 0) {
        throw error
      }
      const noDataColumnIds = await getNoDataColumnIds(dataset)
      const availability = assessTransformColumnAvailability(
        dataset.columns,
        filtered.map((col) => col.id),
        {
          defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
          ignorableColumnIds: noDataColumnIds,
        }
      )
      const resolution: TransformSchemaResolution = {
        columns: dataset.columns,
        partial: availability.criticalMissingColumnIds.length > 0,
        availableColumns: filtered.length,
        missingColumns: availability.criticalMissingColumnIds.length,
        ignorableMissingColumns: availability.ignorableMissingColumnIds.length,
        totalColumns: dataset.columns.length,
      }
      if (requireFullSchema) {
        const decision = evaluateTransformSchemaDecision(
          'in-place',
          {
            contextLabel,
            availableColumns: resolution.availableColumns,
            missingColumns: resolution.missingColumns,
            totalColumns: resolution.totalColumns,
          },
          resolution.partial
        )
        if (!decision.allow) {
          throw new Error(decision.errorMessage ?? 'Unable to load full schema for transform.')
        }
      }
      if (resolution.partial) {
        const candidates = parseCandidateBindings(error) ?? []
        console.warn(
          `[Transform] Schema fallback detected for ${contextLabel}; preserving full column metadata and backfilling unavailable columns as null.`,
          {
            candidateHintCount: candidates.length,
            availableColumns: resolution.availableColumns,
            missingColumns: resolution.missingColumns,
            ignorableMissingColumns: resolution.ignorableMissingColumns,
            totalColumns: resolution.totalColumns,
          }
        )
      } else {
        const candidates = parseCandidateBindings(error) ?? []
        console.info(
          `[Transform] Schema fallback detected for ${contextLabel}; missing columns were treated as synthetic padding.`,
          {
            candidateHintCount: candidates.length,
            availableColumns: resolution.availableColumns,
            ignorableMissingColumns: resolution.ignorableMissingColumns,
            totalColumns: resolution.totalColumns,
          }
        )
      }
      return resolution
    }
  }

  const loadDatasetRows = async (
    dataset: Dataset,
    columns: ColumnMetadata[],
    options: { requireFullSchema?: boolean; contextLabel?: string } = {}
  ) => {
    const requireFullSchema = options.requireFullSchema ?? false
    const contextLabel = options.contextLabel ?? 'transform snapshot'
    const columnIds = columns.map((col) => col.id)
    try {
      await cacheService.ensureLatestCache(dataset.id)
    } catch (error) {
      console.error('Failed to flush pending edits before loading dataset rows:', error)
    }
    try {
      const valuesById = await cacheService.getColumnsData(dataset.id, columnIds)
      const columnData = buildColumnData(columns, valuesById)
      return convertColumnsToRowObjects(columnData, columns)
    } catch (error) {
      const candidateColumnIds = await discoverAvailableColumnsBySampling(
        dataset.id,
        columnIds,
        TRANSFORM_SAMPLE_COLUMNS,
        error
      )
      if (candidateColumnIds.length === 0) {
        throw error
      }
      const noDataColumnIds = await getNoDataColumnIds(dataset)
      const availability = assessTransformColumnAvailability(columns, candidateColumnIds, {
        defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
        ignorableColumnIds: noDataColumnIds,
      })
      if (requireFullSchema) {
        const availableColumns = candidateColumnIds.length
        const missingColumns = availability.criticalMissingColumnIds.length
        const decision = evaluateTransformSchemaDecision(
          'in-place',
          {
            contextLabel,
            availableColumns,
            missingColumns,
            totalColumns: columns.length,
          },
          missingColumns > 0
        )
        if (!decision.allow) {
          throw new Error(decision.errorMessage ?? `Unable to load full schema for ${contextLabel}.`)
        }
      }
      if (availability.criticalMissingColumnIds.length > 0) {
        console.warn('[Transform] Loading snapshot with candidate bindings; unavailable columns will be null-filled.', {
          availableColumns: candidateColumnIds.length,
          missingColumns: availability.criticalMissingColumnIds.length,
          ignorableMissingColumns: availability.ignorableMissingColumnIds.length,
        })
      }
      const valuesById = await cacheService.getColumnsData(dataset.id, candidateColumnIds)
      const columnData = buildColumnData(columns, valuesById)
      return convertColumnsToRowObjects(columnData, columns)
    }
  }

  const loadSampleRows = async (
    dataset: Dataset
  ): Promise<{ rows: Record<string, any>[]; columns: ColumnMetadata[]; resolution: TransformSchemaResolution }> => {
    const columnIds = dataset.columns.map((col) => col.id)
    try {
      try {
        await cacheService.ensureLatestCache(dataset.id)
      } catch (error) {
        console.error('Failed to flush pending edits before sampling rows:', error)
      }
      const valuesById = await cacheService.getColumnsSampledData(
        dataset.id,
        columnIds,
        TRANSFORM_SAMPLE_SIZE
      )
      const columnData = buildColumnData(dataset.columns, valuesById)
      return {
        rows: convertColumnsToRowObjects(columnData, dataset.columns),
        columns: dataset.columns,
        resolution: {
          columns: dataset.columns,
          partial: false,
          availableColumns: dataset.columns.length,
          missingColumns: 0,
          ignorableMissingColumns: 0,
          totalColumns: dataset.columns.length,
        },
      }
    } catch (error) {
      const candidateColumnIds = await discoverAvailableColumnsBySampling(
        dataset.id,
        columnIds,
        TRANSFORM_SAMPLE_SIZE,
        error
      )
      if (candidateColumnIds.length === 0) {
        throw error
      }
      const valuesById = await cacheService.getColumnsSampledData(
        dataset.id,
        candidateColumnIds,
        TRANSFORM_SAMPLE_SIZE
      )
      const noDataColumnIds = await getNoDataColumnIds(dataset)
      const availability = assessTransformColumnAvailability(
        dataset.columns,
        candidateColumnIds,
        {
          defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
          ignorableColumnIds: noDataColumnIds,
        }
      )
      const columnData = buildColumnData(dataset.columns, valuesById)
      return {
        rows: convertColumnsToRowObjects(columnData, dataset.columns),
        columns: dataset.columns,
        resolution: {
          columns: dataset.columns,
          partial: availability.criticalMissingColumnIds.length > 0,
          availableColumns: candidateColumnIds.length,
          missingColumns: availability.criticalMissingColumnIds.length,
          ignorableMissingColumns: availability.ignorableMissingColumnIds.length,
          totalColumns: dataset.columns.length,
        },
      }
    }
  }

  const loadAdvancedFilterUniqueValues = useCallback(async (dataset: Dataset, columnId: string): Promise<unknown[]> => {
    await cacheService.ensureLatestCache(dataset.id)
    try {
      const stats = await cacheService.getAllColumnStats(dataset.id)
      const columnStats = stats.find((entry) => entry.columnId === columnId)
      if (columnStats) {
        return columnStats.distinctValues ?? []
      }
    } catch (error) {
      console.warn('Failed to load advanced filter distinct values from column stats:', error)
    }
    const valuesById = await cacheService.getColumnsData(dataset.id, [columnId])
    return valuesById[columnId] ?? []
  }, [])

  const handleLoadAdvancedFilterColumnValues = useCallback((columnId: string): Promise<unknown[]> => {
    const dataset = transformDataset ?? activeDataset
    if (!dataset) return Promise.resolve([])
    return loadAdvancedFilterUniqueValues(dataset, columnId)
  }, [activeDataset, transformDataset, loadAdvancedFilterUniqueValues])

  const countAdvancedFilterMatches = useCallback(async (dataset: Dataset, config: FilterConfig): Promise<{ count: number; totalRows: number } | null> => {
    const dataRowCount = dataset.dataRowCount ?? dataset.rowCount
    if (dataRowCount > FILTER_MATCH_COUNT_JS_MAX_ROWS) {
      return null
    }
    const rowsByIndex = await buildFullRowsByIndex(dataset.id, dataRowCount, config)
    const baseOrder = Array.from({ length: dataRowCount }, (_, index) => index)
    const filteredRows = applyViewFilter(baseOrder, config, rowsByIndex, dataRowCount)
    const count = filteredRows.filter((row) => row >= 0 && row < dataRowCount).length
    return { count, totalRows: dataRowCount }
  }, [])

  const handleGetAdvancedFilterMatchCount = useCallback((config: FilterConfig): Promise<{ count: number; totalRows: number } | null> => {
    const dataset = transformDataset ?? activeDataset
    if (!dataset) return Promise.resolve(null)
    return countAdvancedFilterMatches(dataset, config)
  }, [activeDataset, transformDataset, countAdvancedFilterMatches])

  const isTransformBlocked = async (dataset: Dataset): Promise<boolean> => {
    const dataRowCount = getUsableRowCount(dataset)
    if (dataRowCount === 0) {
      return true
    }

    let storageInfo: DatasetStorageInfo | null = null
    try {
      storageInfo = await cacheService.getDatasetStorageInfo(dataset.id)
    } catch (error) {
      console.error('Failed to check dataset storage info:', error)
      toast.error('Unable to verify dataset size for transforms')
      return true
    }
    if (storageInfo?.isLarge === true || dataRowCount >= TRANSFORM_MAX_ROWS) {
      toast.error(
        `Transform disabled for datasets with ${TRANSFORM_MAX_ROWS.toLocaleString()}+ rows`
      )
      return true
    }

    return false
  }

  const buildPivotCacheKey = (dataset: Dataset, config: PivotWiderConfig): string => {
    const modifiedAt =
      dataset.modifiedAt instanceof Date
        ? dataset.modifiedAt.toISOString()
        : String(dataset.modifiedAt)
    const rowCount = dataset.dataRowCount ?? dataset.rowCount
    return [
      'pivot_wider',
      dataset.id,
      modifiedAt,
      String(rowCount),
      JSON.stringify(config),
    ].join('|')
  }

  const buildSchemaKeySet = (
    rows: Record<string, any>[],
    columns: ColumnMetadata[]
  ): Set<string> => {
    const keys = new Set<string>(columns.map((col) => col.id))
    for (const row of rows) {
      for (const key of Object.keys(row ?? {})) {
        keys.add(key)
      }
    }
    return keys
  }

  const makeUniqueTransformKey = (base: string, occupied: Set<string>): string => {
    if (!occupied.has(base)) {
      occupied.add(base)
      return base
    }
    let idx = 1
    const MAX_SUFFIX_ATTEMPTS = 10000
    while (occupied.has(`${base}_${idx}`) && idx < MAX_SUFFIX_ATTEMPTS) {
      idx += 1
    }
    const key =
      idx < MAX_SUFFIX_ATTEMPTS
        ? `${base}_${idx}`
        : `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    occupied.add(key)
    return key
  }

  const remapRowKeys = (
    rows: Record<string, any>[],
    renameMap: Map<string, string>
  ): Record<string, any>[] => {
    if (renameMap.size === 0) return rows
    return rows.map((row) => {
      const next: Record<string, any> = {}
      for (const [key, value] of Object.entries(row)) {
        next[renameMap.get(key) ?? key] = value
      }
      return next
    })
  }

  const resolvePivotLongerOutputNames = (
    baseConfig: PivotLongerConfig,
    snapshotColumns: ColumnMetadata[]
  ): { namesTo: string; valuesTo: string; renameMap: Map<string, string> } => {
    const foldedColumns = new Set(baseConfig.cols)
    const existingOutputKeys = new Set<string>(
      snapshotColumns
        .map((col) => col.id)
        .filter((id) => !foldedColumns.has(id))
    )
    const occupiedDisplayNames = new Set<string>(
      snapshotColumns
        .filter((col) => !foldedColumns.has(col.id))
        .map((col) => normalizeDisplayName(col.name))
        .filter((name) => name.length > 0)
    )

    const renameMap = new Map<string, string>()
    let namesTo = baseConfig.namesTo.trim()
    let valuesTo = baseConfig.valuesTo.trim()
    const occupiedOutputKeys = new Set<string>(existingOutputKeys)

    if (occupiedOutputKeys.has(namesTo)) {
      const nextName = makeUniqueTransformKey(`${namesTo}__pivot`, occupiedOutputKeys)
      renameMap.set(baseConfig.namesTo.trim(), nextName)
      namesTo = nextName
    } else {
      occupiedOutputKeys.add(namesTo)
    }

    if (occupiedOutputKeys.has(valuesTo) || valuesTo === namesTo) {
      const nextValue = makeUniqueTransformKey(`${valuesTo}__pivot`, occupiedOutputKeys)
      renameMap.set(baseConfig.valuesTo.trim(), nextValue)
      valuesTo = nextValue
    } else {
      occupiedOutputKeys.add(valuesTo)
    }

    const namesDisplay = makeUniqueDisplayName(namesTo, occupiedDisplayNames)
    if (namesDisplay !== namesTo) {
      renameMap.set(baseConfig.namesTo.trim(), namesDisplay)
      namesTo = namesDisplay
    }
    const valuesDisplay = makeUniqueDisplayName(valuesTo, occupiedDisplayNames)
    if (valuesDisplay !== valuesTo) {
      renameMap.set(baseConfig.valuesTo.trim(), valuesDisplay)
      valuesTo = valuesDisplay
    }

    if (valuesTo === namesTo) {
      const unique = makeUniqueDisplayName(valuesTo, occupiedDisplayNames)
      renameMap.set(baseConfig.valuesTo.trim(), unique)
      valuesTo = unique
    }

    return { namesTo, valuesTo, renameMap }
  }

  const ensureDistinctMetadataNames = (
    metadata: ColumnMetadata[],
    lockedColumnIds: Set<string>,
    reservedNames: string[] = []
  ): { metadata: ColumnMetadata[]; renamedCount: number; preview: string } => {
    const deduped = dedupeMetadataDisplayNames(metadata, {
      lockedColumnIds,
      reservedNames,
    })
    const renamedCount = deduped.renamedEntries.length
    const preview = deduped.renamedEntries
      .slice(0, 2)
      .map((entry) => `${entry.from} -> ${entry.to}`)
      .join(', ')
    return { metadata: deduped.metadata, renamedCount, preview }
  }

  const reorderGeneratedColumnsAfterDataColumns = (
    metadata: ColumnMetadata[],
    baseColumns: ColumnMetadata[],
    snapshotRows: Record<string, any>[]
  ): ColumnMetadata[] => {
    const baseIds = new Set(baseColumns.map((col) => col.id))
    const generatedColumns = metadata.filter((col) => !baseIds.has(col.id))
    if (generatedColumns.length === 0) return metadata

    const existingById = new Map(
      metadata
        .filter((col) => baseIds.has(col.id))
        .map((col) => [col.id, col] as const)
    )
    const orderedExisting = baseColumns
      .map((col) => existingById.get(col.id))
      .filter((col): col is ColumnMetadata => Boolean(col))

    const activeIds = new Set<string>()
    const remainingIds = new Set<string>(orderedExisting.map((col) => col.id))
    for (const row of snapshotRows) {
      for (const id of Array.from(remainingIds)) {
        const value = row[id]
        if (value !== null && value !== undefined && value !== '') {
          activeIds.add(id)
          remainingIds.delete(id)
        }
      }
      if (remainingIds.size === 0) break
    }

    let lastActiveIndex = -1
    for (let idx = 0; idx < orderedExisting.length; idx += 1) {
      const col = orderedExisting[idx]
      if (col && activeIds.has(col.id)) {
        lastActiveIndex = idx
      }
    }

    const insertAt = lastActiveIndex + 1
    return [
      ...orderedExisting.slice(0, insertAt),
      ...generatedColumns,
      ...orderedExisting.slice(insertAt),
    ]
  }

  type ReplaceDatasetOptions = {
    preserveGridShape?: boolean
    rowCountOverride?: number
    dataRowCountOverride?: number
  }

  const renamePivotedColumns = (
    rows: Record<string, any>[],
    config: PivotWiderConfig,
    metadata: ColumnMetadata[]
  ): Record<string, any>[] => {
    if (config.valuesFrom.length <= 1) return rows

    const nameById = new Map(metadata.map((col) => [col.id, col.name]))
    const labelCounts = new Map<string, number>()
    for (const colId of config.valuesFrom) {
      const base = nameById.get(colId) ?? colId
      labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1)
    }

    const labelById = new Map<string, string>()
    for (const colId of config.valuesFrom) {
      const base = nameById.get(colId) ?? colId
      const label = (labelCounts.get(base) ?? 0) > 1 ? `${base} (${colId})` : base
      labelById.set(colId, label)
    }

    const separator = '__'
    const valuePrefixes = config.valuesFrom
      .map((valueId) => `${valueId}${separator}`)
      .sort((a, b) => b.length - a.length)
    return rows.map((row) => {
      const next: Record<string, any> = {}
      for (const [key, value] of Object.entries(row)) {
        const matchedPrefix = valuePrefixes.find((prefix) => key.startsWith(prefix))
        if (matchedPrefix) {
          const valueColId = matchedPrefix.slice(0, -separator.length)
          const suffix = key.slice(matchedPrefix.length)
          const label = labelById.get(valueColId)
          if (label && suffix.length > 0) {
            next[`${label}${separator}${suffix}`] = value
            continue
          }
        }
        next[key] = value
      }
      return next
    })
  }

  const replaceActiveDataset = async (
    dataset: Dataset,
    rows: Record<string, any>[],
    metadata: ColumnMetadata[],
    options: ReplaceDatasetOptions = {}
  ) => {
    const datasetUseCount = useAppStore
      .getState()
      .families.filter(family => family.datasetId === dataset.id).length
    const isSharedDataset = datasetUseCount > 1

    const preserveGridShape = options.preserveGridShape ?? true
    const baseColumns = dataset.columns
    const minColumnCount = preserveGridShape
      ? Math.max(baseColumns.length, MIN_COLUMNS)
      : MIN_COLUMNS
    const usedIds = new Set<string>()
    let nextIndex = 0

    const bumpIndexFromId = (id: string) => {
      const match = /^col-(\d+)$/.exec(id)
      if (!match) return
      const index = Number(match[1])
      if (Number.isFinite(index)) {
        nextIndex = Math.max(nextIndex, index + 1)
      }
    }

    for (const col of baseColumns) {
      usedIds.add(col.id)
      bumpIndexFromId(col.id)
    }
    for (const col of metadata) {
      bumpIndexFromId(col.id)
    }

    const nextColumnId = () => {
      while (usedIds.has(`col-${nextIndex}`)) {
        nextIndex += 1
      }
      const id = `col-${nextIndex}`
      usedIds.add(id)
      nextIndex += 1
      return id
    }

    const targetColumnCount = preserveGridShape
      ? Math.max(minColumnCount, metadata.length)
      : Math.max(MIN_COLUMNS, metadata.length)
    const mergedColumns: ColumnMetadata[] = []
    const sourceIdsByIndex: Array<string | null> = []

    for (let i = 0; i < targetColumnCount; i++) {
      const base = baseColumns[i]
      const transformed = metadata[i]

      if (transformed) {
        const id = base?.id ?? (usedIds.has(transformed.id) ? nextColumnId() : transformed.id)
        usedIds.add(id)
        sourceIdsByIndex[i] = transformed.id
        mergedColumns.push({
          ...base,
          ...transformed,
          id,
          name: transformed.name ?? base?.name ?? `Column ${i + 1}`,
          type: transformed.type ?? base?.type ?? 'text',
          width: base?.width ?? transformed.width ?? DEFAULT_COLUMN_WIDTH,
        })
        continue
      }

      if (base) {
        const id = usedIds.has(base.id) ? nextColumnId() : base.id
        usedIds.add(id)
        sourceIdsByIndex[i] = null
        mergedColumns.push({ ...base, id })
        continue
      }

      const id = nextColumnId()
      sourceIdsByIndex[i] = null
      mergedColumns.push({
        id,
        name: `Column ${i + 1}`,
        type: 'text',
        width: DEFAULT_COLUMN_WIDTH,
      })
    }

    const remappedRows = rows.map((row) => {
      const next: Record<string, any> = {}
      for (let i = 0; i < mergedColumns.length; i++) {
        const columnId = mergedColumns[i]?.id
        if (!columnId) continue
        const sourceId = sourceIdsByIndex[i]
        next[columnId] = sourceId ? row[sourceId] ?? null : null
      }
      return next
    })

    const dataRowCount = options.dataRowCountOverride ?? remappedRows.length
    const rowCount = options.rowCountOverride ?? Math.max(dataset.rowCount, dataRowCount + ROW_BUFFER, MIN_ROWS)
    const now = new Date()
    const datasetId = `dataset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const newDataset: Dataset = {
      id: datasetId,
      name: dataset.name,
      rowCount,
      dataRowCount,
      columnCount: mergedColumns.length,
      columns: mergedColumns,
      importedAt: dataset.importedAt ?? now,
      modifiedAt: now,
      filePath: dataset.filePath,
      familyId: dataset.familyId ?? activeFamilyId ?? undefined,
    }

    await cacheService.setDataset(newDataset.id, remappedRows)
    addDataset(newDataset)

    if (activeFamilyId) {
      setActiveFamilyDataset(activeFamilyId, newDataset.id, true)
    } else {
      updateActiveFamilyData(newDataset.id)
    }

    if (!isSharedDataset) {
      removeDataset(dataset.id)
      cacheService.removeDataset(dataset.id).catch((error) => {
        console.error(`Failed to remove dataset ${dataset.id} from cache`, error)
      })
    }

    useAppStore.getState().setProjectDirty(true)
    return newDataset
  }

  // All-DuckDB: normalizeRows and padRows removed - no longer needed
  // All datasets use DuckDB streaming, no in-memory row processing

  const importDatasetFromPath = async (filePath: string) => {
    const toastId = `import-${Date.now()}`
    try {
      logAppDebug('import_dataset_start', { filePath })
      await ensureProjectId()
      const importFamilyId = useAppStore.getState().activeFamilyId ?? 'statistics-1'
      const proceedWithClear = await confirmClearResultsAndPlotsIfNeeded(importFamilyId)
      if (!proceedWithClear) {
        logAppDebug('import_dataset_cancelled_by_confirm', {
          filePath,
          familyId: importFamilyId,
        })
        return
      }
      useResultsStore.getState().clearFamilyResults(importFamilyId)
      usePlotsStore.getState().clearStatisticsFamilyPlots(importFamilyId)

      // Get filename for display
      const fileName = filePath.split(/[\\/]/).pop() ?? 'dataset'

      // Set loading operation for large file feedback (AFTER file is selected)
      setLoadingOperation({
        type: 'import',
        message: `Importing ${fileName}...`,
        indeterminate: true,
      })

      toast.loading('Importing datasetâ€¦', { id: toastId })

      // Determine file type and import
      const ext = filePath.split('.').pop()?.toLowerCase()

      let result
      if (ext === 'csv') {
        result = await tauriApi.importCsv(filePath)
      } else if (ext === 'tsv' || ext === 'txt') {
        // Treat .txt files as tab-delimited (most common format for text data files)
        result = await tauriApi.importTsv(filePath)
      } else if (ext === 'xlsx' || ext === 'xls') {
        result = await tauriApi.importExcel(filePath)
      } else if (ext === 'parquet') {
        // Parquet: optimal for large datasets (50M+ rows)
        result = await tauriApi.importParquet(filePath)
      } else {
        throw new Error(`Unsupported file type: ${ext}`)
      }

      // All-DuckDB: All datasets are stored in DuckDB (result.isLargeDataset always true)
      const sourcePath = result.sourcePath ?? filePath

      const originalColumns = result.dataset.columns as ColumnMetadata[]
      const extendedColumns = extendColumns(originalColumns)

      // All-DuckDB: Keep row data in DuckDB, only add buffer rows in UI
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

      // Add dataset to store using converted Date objects
      addDataset(dataset)
      setCurrentDataset(dataset)
      logAppDebug('import_dataset_store_bound', {
        datasetId: dataset.id,
        familyId: activeFamilyId ?? null,
        rowCount: dataset.rowCount,
        dataRowCount: dataset.dataRowCount ?? null,
      })

      // All-DuckDB: Backend handles all storage (no frontend cache population)
      // All datasets now use DuckDB streaming, regardless of size

      // REMOVED: Frontend Zustand cache - SpreadsheetView now uses streaming row provider
      // setCacheData(`dataset:${dataset.id}`, finalRows)

      // Associate dataset with the active family so navigator swaps correctly
      if (activeFamilyId) {
        setActiveFamilyDataset(activeFamilyId, dataset.id, true)
      } else {
        updateActiveFamilyData(dataset.id)
      }

      // Smart Save: mark project dirty after import (Part 1)
      useAppStore.getState().setProjectDirty(true)

      setLoadingOperation(null)
      const appState = useAppStore.getState()
      const importedFromNonDataView = appState.workspaceViewMode !== 'data'
      if (importedFromNonDataView && !appState.showNavigator) {
        setViewAttentionPulseToken((token) => token + 1)
      }
      toast.success(`Imported ${dataset.name}`, {
        id: toastId,
        ...(importedFromNonDataView
          ? {
              description: 'Data imported to current Statistics family > Data.',
              action: {
                label: 'Go to Data',
                onClick: () => {
                  const latestAppState = useAppStore.getState()
                  latestAppState.setWorkspaceViewMode('data')
                  if (!latestAppState.showNavigator) {
                    latestAppState.setShowNavigator(true)
                  }
                },
              },
            }
          : {}),
      })
      void maybeShowCacheHealthWarning('post_import')
    } catch (error) {
      // Clear loading state on error
      setLoadingOperation(null)

      // Normalize error so we surface useful backend messages (including TauriError objects)
      let message = 'Unknown error'
      if (error instanceof Error) {
        message = error.message
      } else if (error && typeof error === 'object' && 'message' in (error as any)) {
        const m = (error as any).message
        if (typeof m === 'string' && m.length > 0) {
          message = m
        }
      } else if (error !== undefined && error !== null) {
        message = String(error)
      }

      console.error('Import failed:', error)
      logAppDebug('import_dataset_failed', {
        filePath,
        error: message,
      })
      toast.error(`Import failed: ${message}`, { id: toastId })
    }
  }

  // Handle data import
  const handleImportData = async () => {
    logAppDebug('import_click', {
      workspaceViewMode: useAppStore.getState().workspaceViewMode,
      activeFamilyId: useAppStore.getState().activeFamilyId ?? null,
    })
    if (blockIfAppLocked('Import')) {
      logAppDebug('import_blocked_by_lock')
      return
    }
    if (blockIfPasteInFlight('Import')) {
      logAppDebug('import_blocked_by_paste_in_flight')
      return
    }
    if (importDialogOpenRef.current) {
      logAppDebug('import_dialog_reentry_blocked')
      return
    }

    // OPTIMIZATION: Open dialog first, then set loading state
    // Keeps the click â†’ dialog path minimal for instant feedback
    importDialogOpenRef.current = true
    let filePath: string | string[] | null
    try {
      filePath = await open({
        multiple: false,
        filters: [
          {
            name: 'All Data Files',
            extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xls', 'parquet'],
          },
          {
            name: 'Excel Files (Recommended: .xlsx)',
            extensions: ['xlsx', 'xls'],
          },
          {
            name: 'Text Files (CSV/TSV/TXT)',
            extensions: ['csv', 'tsv', 'txt'],
          },
          {
            name: 'Parquet Files (Best for 50M+ rows)',
            extensions: ['parquet'],
          },
        ],
      })
    } catch (error) {
      logAppDebug('import_file_dialog_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    } finally {
      importDialogOpenRef.current = false
    }

    if (!filePath) {
      logAppDebug('import_file_dialog_cancelled')
      return
    }
    if (Array.isArray(filePath)) {
      const selected = filePath[0]
      if (!selected) {
        logAppDebug('import_file_dialog_cancelled')
        return
      }
      logAppDebug('import_file_selected', { filePath: selected })
      await importDatasetFromPath(selected)
      return
    }
    logAppDebug('import_file_selected', { filePath })
    await importDatasetFromPath(filePath)
  }

  const MANIFEST_SEARCH_OVERRIDES: Record<string, string> = {
    mann_whitney: 'mann_whitney',
    chi_square_gof: 'chi_squared_gof',
    descriptive_stats: 'descriptive_statistics',
    normality_all: 'normality_tests',
  }

  const getSampleDatasetSearch = (testId: string) => {
    if (testId in MANIFEST_SEARCH_OVERRIDES) return MANIFEST_SEARCH_OVERRIDES[testId]
    return normalizeTestId(testId)
  }

  const handleOpenSampleDatasets = (search?: string) => {
    setSampleDatasetsSearch(search ?? '')
    setSampleDatasetsOpen(true)
  }

  const handleSampleDatasetsOpenChange = (open: boolean) => {
    setSampleDatasetsOpen(open)
    if (!open) {
      setSampleDatasetsSearch('')
      setPendingGuideTestId(null)
    }
  }

  const handleBrowseExamples = () => {
    handleOpenSampleDatasets()
  }

  const handleOpenCheatsheet = () => {
    setCheatsheetOpen(true)
  }

  const handleOpenDataCleaningGuide = () => {
    setDataCleaningGuideOpen(true)
  }

  const handleOpenRNAseqGuide = () => {
    setRnaseqGuideOpen(true)
  }

  const handleOpenRNAseqConfigureFromGuide = async () => {
    if (blockIfAppLocked('RNA-seq configure')) return

    const rnaseqStore = useRNAseqStore.getState()
    if (rnaseqStore.activeProjectId) {
      rnaseqStore.setActiveTab(rnaseqStore.activeProjectId, 'counts')
      return
    }

    const existingProject =
      rnaseqStore.projects.find((project) => project.countsDatasetId && project.metadataDatasetId) ??
      rnaseqStore.projects[0]

    if (existingProject) {
      rnaseqStore.setActiveProject(existingProject.id)
      rnaseqStore.setActiveTab(existingProject.id, 'counts')
      return
    }

    try {
      const newProject = await rnaseqStore.createProjectWithBootstrap('New RNA-seq Project')
      rnaseqStore.setActiveProject(newProject.id)
      rnaseqStore.setActiveTab(newProject.id, 'counts')
    } catch (err) {
      console.error('[AppShell] Failed to bootstrap RNA-seq project from guide:', err)
      toast.error('Failed to create RNA-seq project')
    }
  }

  const handleImportRNAseqSample = async () => {
    if (blockIfAppLocked('RNA-seq sample import')) return

    const toastId = `rnaseq-sample-${Date.now()}`
    try {
      toast.loading('Importing RNA-seq sample dataset\u2026', { id: toastId })
      setLoadingOperation({
        type: 'import',
        message: 'Importing RNA-seq oncology demo\u2026',
        indeterminate: true,
      })
      await ensureProjectId()

      // Resolve both bundled file paths
      let countsPath: string
      let metadataPath: string
      try {
        countsPath = await tauriApi.resolveSampleDatasetPath('RNAseq_Starter/counts.csv')
        metadataPath = await tauriApi.resolveSampleDatasetPath('RNAseq_Starter/metadata.csv')
      } catch (error) {
        throw new Error('Could not locate bundled RNA-seq sample files.')
      }

      // Import both CSVs
      const countsResult = await tauriApi.importCsv(countsPath)
      const metadataResult = await tauriApi.importCsv(metadataPath)

      // Build Dataset objects (same pattern as importDatasetFromPath)
      const buildDataset = (result: typeof countsResult, filePath: string) => {
        const originalColumns = result.dataset.columns as ColumnMetadata[]
        const extendedColumns = extendColumns(originalColumns)
        const dataRowCount = result.dataset.rowCount
        const rowCount = Math.max(dataRowCount + ROW_BUFFER, MIN_ROWS)
        return {
          ...result.dataset,
          columns: extendedColumns,
          columnCount: extendedColumns.length,
          rowCount,
          dataRowCount,
          importedAt: new Date(result.dataset.importedAt),
          modifiedAt: new Date(result.dataset.modifiedAt),
          filePath: result.sourcePath ?? filePath,
        } as Dataset
      }

      const countsDataset = buildDataset(countsResult, countsPath)
      const metadataDataset = buildDataset(metadataResult, metadataPath)

      // Add both datasets to data store
      addDataset(countsDataset)
      addDataset(metadataDataset)

      // Create RNA-seq project and link both datasets
      const rnaseqStore = useRNAseqStore.getState()
      const baseProjectName = 'Oncology Demo'
      const existingNames = new Set(rnaseqStore.projects.map((p) => p.name))
      let projectName = baseProjectName
      let suffix = 2
      while (existingNames.has(projectName)) {
        projectName = `${baseProjectName} ${suffix}`
        suffix += 1
      }

      // Bootstrap-create then replace â€” uniform create policy, scaffold cleaned up by replace*
      const project = await rnaseqStore.createProjectWithBootstrap(projectName)
      await rnaseqStore.replaceCountsDataset(project.id, countsDataset.id)
      await rnaseqStore.replaceMetadataDataset(project.id, metadataDataset.id)

      setLoadingOperation(null)
      toast.success('RNA-seq oncology demo imported (counts + metadata)', { id: toastId })
      void maybeShowCacheHealthWarning('post_import')
    } catch (error) {
      setLoadingOperation(null)
      const message = error instanceof Error ? error.message : String(error)
      console.error('RNA-seq sample import failed:', error)
      toast.error(`RNA-seq sample import failed: ${message}`, { id: toastId })
    }
  }

  const handleDataCleaningOpenTool = (actionId: string) => {
    if (blockIfAppLocked('Data cleaning tool')) return
    if (!isDataCleaningActionId(actionId)) {
      console.error('[DataCleaningGuide] Unknown tool actionId:', actionId)
      toast.error(`Unknown data cleaning tool action: ${actionId}`)
      return
    }

    switch (actionId) {
      case 'pivot_wider':
        void handlePivotWider()
        break
      case 'pivot_longer':
        void handlePivotLonger()
        break
      case 'advanced_filter':
        void handleAdvancedFilter()
        break
      case 'sort':
        handleSort()
        break
      case 'group_aggregate':
        void handleGroupAggregate()
        break
      case 'outline':
        handleOutline()
        break
    }
  }

  const handleRunTestFromGuide = (testId: string) => {
    if (blockIfAppLocked('Guide run')) return
    const testDef = getTestDefinition(testId)
    if (!testDef) {
      toast.error(`Unknown test definition: ${testId}`)
      return
    }

    selectTest(toStoreTestDefinition(testDef))

    setPendingGuideTestId(testId)
    handleOpenSampleDatasets(getSampleDatasetSearch(testId))
  }

  const handleImportSampleDataset = async (dataset: SampleDataset) => {
    if (blockIfAppLocked('Sample dataset import')) return

    // Resolve sample dataset path via backend each time to avoid stale absolute paths.
    let importPath = dataset.path
    try {
      importPath = await tauriApi.resolveSampleDatasetPath(dataset.file)
    } catch (error) {
      console.warn(
        `[SampleDatasets] Falling back to manifest path for "${dataset.file}"`,
        error
      )
    }

    await importDatasetFromPath(importPath)

    if (pendingGuideTestId) {
      const testDef = getTestDefinition(pendingGuideTestId)
      if (testDef) {
        selectTest(toStoreTestDefinition(testDef))
        setColumnDialogOpen(true)
      }
      setPendingGuideTestId(null)
    }

    setSampleDatasetsOpen(false)
  }

  const handleSort = () => {
    if (blockIfAppLocked('Sort')) return
    if (blockIfNoDataRows('Sort')) return
    openSortDialogRef.current?.()
  }

  const handleOutline = () => {
    if (blockIfAppLocked('Outline')) return
    if (blockIfNoDataRows('Outline')) return
    openGroupDialogRef.current?.()
  }

  const handlePivotWider = async () => {
    if (blockIfAppLocked('Pivot wider')) return

    if (!transformDataset) {
      toast.error('No active dataset')
      return
    }
    if (blockIfNoDataRows('Pivot wider', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    try {
      await cacheService.ensureLatestCache(transformDataset.id)
      const sample = await loadSampleRows(transformDataset)
      if (sample.resolution.partial) {
        toast.warning(
          `Pivot preview loaded with partial schema: ${sample.resolution.missingColumns.toLocaleString()} column(s) unavailable. Preview-only values may be incomplete.`
        )
      }
      setTransformSampleData(sample.rows)
      const columnsWithData = await getColumnsWithData(
        transformDataset,
        sample.resolution.columns,
        'pivot wider setup',
        { hideEmptyColumns: true }
      )
      setTransformColumns(columnsWithData)
      setShowPivotWiderDialog(true)
    } catch (error) {
      console.error('Failed to prepare pivot wider dialog:', error)
      toast.error('Failed to load data for pivot')
    }
  }

  const handleApplyPivotWider = async (config: PivotWiderConfig) => {
    if (blockIfAppLocked('Pivot wider')) return
    if (!transformDataset) return
    if (blockIfNoDataRows('Pivot wider', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    persistTransformUiState({ pivotWider: config })
    setPendingTransform({ datasetId: transformDataset.id, type: 'pivot_wider', config })
    setShowTransformWarning(true)
  }

  const handlePivotLonger = async () => {
    if (blockIfAppLocked('Pivot longer')) return

    if (!transformDataset) {
      toast.error('No active dataset')
      return
    }
    if (blockIfNoDataRows('Pivot longer', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    try {
      await cacheService.ensureLatestCache(transformDataset.id)
      const resolution = await resolveTransformColumns(transformDataset, {
        contextLabel: 'pivot longer setup',
      })
      if (resolution.partial) {
        toast.warning(
          `Pivot setup loaded with partial schema: ${resolution.missingColumns.toLocaleString()} column(s) unavailable.`
        )
      }
      const columnsWithData = await getColumnsWithData(
        transformDataset,
        resolution.columns,
        'pivot longer setup',
        { hideEmptyColumns: true }
      )
      setTransformColumns(columnsWithData)
      setShowPivotLongerDialog(true)
    } catch (error) {
      console.error('Failed to prepare pivot longer dialog:', error)
      toast.error('Failed to load data for pivot')
    }
  }

  const handleApplyPivotLonger = async (config: PivotLongerConfig) => {
    if (blockIfAppLocked('Pivot longer')) return
    if (!transformDataset) return
    if (blockIfNoDataRows('Pivot longer', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    persistTransformUiState({ pivotLonger: config })
    setPendingTransform({ datasetId: transformDataset.id, type: 'pivot_longer', config })
    setShowTransformWarning(true)
  }

  const handleAdvancedFilter = async () => {
    if (blockIfAppLocked('Advanced filter')) return

    if (!transformDataset) {
      toast.error('No active dataset')
      return
    }
    if (blockIfNoDataRows('Advanced filter', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    try {
      await cacheService.ensureLatestCache(transformDataset.id)
      const sample = await loadSampleRows(transformDataset)
      if (sample.resolution.partial) {
        toast.warning(
          `Filter preview loaded with partial schema: ${sample.resolution.missingColumns.toLocaleString()} column(s) unavailable.`
        )
      }
      setTransformSampleData(sample.rows)
        const columnsWithData = await getColumnsWithData(
          transformDataset,
          sample.resolution.columns,
          'advanced filter setup',
          { hideEmptyColumns: true }
        )
      setTransformColumns(columnsWithData)
      setShowAdvancedFilterDialog(true)
    } catch (error) {
      console.error('Failed to prepare filter dialog:', error)
      toast.error('Failed to load data for filter')
    }
  }

  const handleApplyAdvancedFilter = async (config: FilterConfig | null) => {
    if (!config) return
    if (blockIfAppLocked('Advanced filter')) return
    if (!transformDataset) return
    if (blockIfNoDataRows('Advanced filter', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    persistTransformUiState({ filter: config })
    setPendingTransform({ datasetId: transformDataset.id, type: 'filter', config })
    setShowTransformWarning(true)
  }

  const handleGroupAggregate = async () => {
    if (blockIfAppLocked('Group aggregate')) return

    if (!transformDataset) {
      toast.error('No active dataset')
      return
    }
    if (blockIfNoDataRows('Group aggregate', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    try {
      await cacheService.ensureLatestCache(transformDataset.id)
      const resolution = await resolveTransformColumns(transformDataset, {
        contextLabel: 'group aggregate setup',
      })
      if (resolution.partial) {
        toast.warning(
          `Grouping setup loaded with partial schema: ${resolution.missingColumns.toLocaleString()} column(s) unavailable.`
        )
      }
        const columnsWithData = await getColumnsWithData(
          transformDataset,
          resolution.columns,
          'group aggregate setup',
          { hideEmptyColumns: true }
        )
      setTransformColumns(columnsWithData)
      setShowGroupAggregateDialog(true)
    } catch (error) {
      console.error('Failed to prepare group aggregate dialog:', error)
      toast.error('Failed to load data for grouping')
    }
  }

  const handleApplyGroupAggregate = async (config: GroupAggregateConfig) => {
    if (blockIfAppLocked('Group aggregate')) return
    if (!transformDataset) return
    if (blockIfNoDataRows('Group aggregate', transformDataset)) return
    if (await isTransformBlocked(transformDataset)) return

    persistTransformUiState({ groupAggregate: config })
    setPendingTransform({ datasetId: transformDataset.id, type: 'group_aggregate', config })
    setShowTransformWarning(true)
  }

  const applyPendingTransform = async (mode: TransformMode) => {
    if (!pendingTransform) return

    const pendingDatasetId = pendingTransform.datasetId
    const dataset = datasets.find((candidate) => candidate.id === pendingDatasetId) ?? null
    if (!dataset) {
      setShowTransformWarning(false)
      setPendingTransform(null)
      toast.error('Transform failed: dataset no longer available')
      return
    }
    if (!transformDataset || transformDataset.id !== pendingDatasetId) {
      setShowTransformWarning(false)
      setPendingTransform(null)
      toast.warning('Dataset changed; transform cancelled')
      return
    }
    if (mode === 'new-family' && rnaseqDatasetIds.has(dataset.id)) {
      setShowTransformWarning(false)
      setPendingTransform(null)
      toast.error('Create New Family is disabled for RNA-seq datasets')
      return
    }

    const transform = pendingTransform
    setShowTransformWarning(false)
    setPendingTransform(null)

    // -- Preflight gate: check row count BEFORE expensive row loading --
    const preflightRowCount = dataset.dataRowCount ?? dataset.rowCount
    const preflightInput = {
      type: transform.type as Parameters<typeof getTransformPreflight>[0]['type'],
      dataRowCount: preflightRowCount,
      ...(transform.type === 'pivot_longer'
        ? { pivotColumnCount: (transform.config as PivotLongerConfig).cols?.length ?? 1 }
        : {}),
    }
    const preflight = getTransformPreflight(preflightInput)

    if (!preflight.allow) {
      toast.error(preflight.blockReason ?? 'Transform blocked due to dataset size')
      return
    }
    if (preflight.confirm) {
      const confirmed = await confirmPreflight(preflight, transform.type, preflightRowCount)
      if (!confirmed) return
    }

    const showPipelineSpinner =
      preflight.showSpinner ||
      (transform.type === 'pivot_wider' && preflightRowCount >= TRANSFORM_PIVOT_STREAM_THRESHOLD)

    if (showPipelineSpinner) {
      setLoadingOperation({
        type: 'query',
        message: 'Preparing transform...',
        indeterminate: true,
      })
      await yieldToMain()
    }

    try {
      await cacheService.ensureLatestCache(dataset.id)
      const contextLabel = mode === 'in-place' ? 'in-place transform' : 'transform'
      const snapshotResolution = await resolveTransformColumns(dataset, {
        requireFullSchema: mode === 'in-place',
        contextLabel: mode === 'in-place' ? 'in-place transform' : 'transform',
      })
      const schemaDecision = evaluateTransformSchemaDecision(
        mode,
        {
          contextLabel,
          availableColumns: snapshotResolution.availableColumns,
          missingColumns: snapshotResolution.missingColumns,
          totalColumns: snapshotResolution.totalColumns,
        },
        snapshotResolution.partial
      )
      if (!schemaDecision.allow) {
        throw new Error(schemaDecision.errorMessage ?? `Unable to load full schema for ${contextLabel}.`)
      }
      if (schemaDecision.warningMessage) {
        toast.warning(schemaDecision.warningMessage)
      }
      const snapshotColumns = snapshotResolution.columns
      const snapshotRows = await loadDatasetRows(dataset, snapshotColumns, {
        requireFullSchema: mode === 'in-place',
        contextLabel,
      })
      const snapshotSchemaKeys = buildSchemaKeySet(snapshotRows, snapshotColumns)

      let transformedRows: Record<string, any>[] = []
      let pivotWiderConfigUsed: PivotWiderConfig | null = null
      let pivotLongerConfigUsed: PivotLongerConfig | null = null

      if (transform.type === 'pivot_wider') {
        const baseConfig = transform.config as PivotWiderConfig
        const hasDuplicates = !baseConfig.aggregation
          ? DataTransformService.hasDuplicatePivotKeys(snapshotRows, baseConfig)
          : false
        const configForTransform = hasDuplicates
          ? { ...baseConfig, aggregation: 'list' as const }
          : baseConfig
        pivotWiderConfigUsed = configForTransform
        const pivotCacheKey = buildPivotCacheKey(dataset, configForTransform)
        const collisionKeys = DataTransformService.getPivotWiderCollisionKeys(
          snapshotRows,
          configForTransform
        )
        const nameById = new Map(snapshotColumns.map((col) => [col.id, col.name]))

        if (hasDuplicates) {
          toast.warning('Duplicate keys detected; using list values. Choose an aggregation to summarize.')
        }
        if (collisionKeys.length > 0) {
          const preview = collisionKeys
            .slice(0, 6)
            .map((key) => nameById.get(key) ?? key)
            .join(', ')
          const suffix = collisionKeys.length > 6 ? 'â€¦' : ''
          toast.warning(
            `Pivot detected ${collisionKeys.length} potential column collision(s): ${preview}${suffix}. ` +
              'Generated columns will be auto-renamed to prevent overwrite.'
          )
        }

        if (snapshotRows.length >= TRANSFORM_PIVOT_STREAM_THRESHOLD) {
          let lastProgress = -1
          let cancelRequested = false
          const abortController = new AbortController()
          const handleCancel = () => {
            if (cancelRequested) return
            cancelRequested = true
            abortController.abort()
            setLoadingOperation({
              type: 'query',
              message: 'Cancelling pivot...',
              indeterminate: true,
            })
          }
          setLoadingOperation({
            type: 'query',
            message: 'Pivoting data...',
            total: 100,
            current: 0,
            onCancel: handleCancel,
          })
          try {
            transformedRows = await DataTransformService.pivotWiderStreaming(
              snapshotRows,
              configForTransform,
              {
                cacheKey: pivotCacheKey,
                signal: abortController.signal,
                onProgress: (percent) => {
                  if (cancelRequested || percent === lastProgress) return
                  lastProgress = percent
                  setLoadingOperation({
                    type: 'query',
                    message: 'Pivoting data...',
                    total: 100,
                    current: percent,
                    onCancel: handleCancel,
                  })
                },
              }
            )
          } finally {
            if (!showPipelineSpinner) {
              setLoadingOperation(null)
            } else {
              setLoadingOperation({
                type: 'query',
                message: 'Finalizing transform...',
                indeterminate: true,
              })
            }
          }
        } else {
          transformedRows = DataTransformService.pivotWider(snapshotRows, configForTransform, {
            cacheKey: pivotCacheKey,
          })
        }
      } else if (transform.type === 'pivot_longer') {
        const baseConfig = transform.config as PivotLongerConfig
        const { namesTo, valuesTo, renameMap } = resolvePivotLongerOutputNames(
          baseConfig,
          snapshotColumns
        )
        if (renameMap.size > 0) {
          const preview = Array.from(renameMap.entries())
            .slice(0, 2)
            .map(([from, to]) => `${from} -> ${to}`)
            .join(', ')
          toast.warning(
            `Pivot longer renamed ${renameMap.size} output column(s) to prevent collisions: ${preview}.`
          )
        }

        const configForTransform: PivotLongerConfig = {
          ...baseConfig,
          namesTo,
          valuesTo,
        }
        pivotLongerConfigUsed = configForTransform
        transformedRows = DataTransformService.pivotLonger(
          snapshotRows,
          configForTransform
        )
      } else if (transform.type === 'group_aggregate') {
        transformedRows = DataTransformService.groupAggregate(
          snapshotRows,
          transform.config as GroupAggregateConfig
        )
      } else {
        transformedRows = DataTransformService.filter(
          snapshotRows,
          transform.config as FilterConfig
        )
      }

      if (transformedRows.length === 0 && transform.type !== 'filter') {
        toast.warning('Transform produced no rows')
        return
      }

      let rowsForConversion = transformedRows

      if (transform.type === 'pivot_wider') {
        const configForTransform =
          pivotWiderConfigUsed ?? (transform.config as PivotWiderConfig)
        rowsForConversion = renamePivotedColumns(
          transformedRows,
          configForTransform,
          snapshotColumns
        )

        const idCols = computePivotIdColumns(snapshotRows, configForTransform)
        const intentionallyRemoved = new Set<string>()
        if (!configForTransform.keepOriginalColumns) {
          intentionallyRemoved.add(configForTransform.namesFrom)
          configForTransform.valuesFrom.forEach((col) => intentionallyRemoved.add(col))
        }

        const protectedKeys = new Set<string>(snapshotSchemaKeys)
        intentionallyRemoved.forEach((key) => protectedKeys.delete(key))

        const preservedOutputKeys = new Set<string>(idCols)
        if (configForTransform.keepOriginalColumns) {
          preservedOutputKeys.add(configForTransform.namesFrom)
          configForTransform.valuesFrom.forEach((col) => preservedOutputKeys.add(col))
        }

        const outputKeys = buildSchemaKeySet(rowsForConversion, [])
        const generatedCollisionKeys = Array.from(outputKeys).filter(
          (key) => protectedKeys.has(key) && !preservedOutputKeys.has(key)
        )

        if (generatedCollisionKeys.length > 0) {
          const occupied = new Set<string>([...outputKeys, ...protectedKeys])
          const renameMap = new Map<string, string>()
          for (const key of generatedCollisionKeys) {
            renameMap.set(key, makeUniqueTransformKey(`${key}__pivot`, occupied))
          }
          rowsForConversion = remapRowKeys(rowsForConversion, renameMap)
          const preview = Array.from(renameMap.entries())
            .slice(0, 2)
            .map(([from, to]) => `${from} -> ${to}`)
            .join(', ')
          toast.warning(
            `Pivot wider renamed ${renameMap.size} generated column(s) to prevent collisions: ${preview}.`
          )
        }
      } else if (transform.type === 'pivot_longer') {
        const { namesTo, valuesTo, cols } =
          pivotLongerConfigUsed ?? (transform.config as PivotLongerConfig)
        const labelById = new Map(snapshotColumns.map((col) => [col.id, col.name]))
        rowsForConversion = transformedRows.map((row) => {
          const next = { ...row }
          const current = row[namesTo]
          if (typeof current === 'string') {
            const mapped = labelById.get(current)
            if (mapped) {
              next[namesTo] = mapped
            }
          }
          return next
        })
        // Keep non-folded source columns by schema (not by non-empty value) so
        // text/categorical columns are preserved in both in-place and new-family modes.
        const foldedColumns = new Set(cols)
        const keysToKeep = new Set<string>([namesTo, valuesTo])
        snapshotColumns.forEach((column) => {
          if (!foldedColumns.has(column.id)) {
            keysToKeep.add(column.id)
          }
        })
        rowsForConversion = rowsForConversion.map((row) => {
          const trimmed: Record<string, any> = {}
          for (const key of keysToKeep) {
            trimmed[key] = row[key] ?? null
          }
          return trimmed
        })
      }

      let normalizedRows: Record<string, any>[] = []
      let metadataForOutput: ColumnMetadata[] = []

      if (rowsForConversion.length === 0 && transform.type === 'filter') {
        normalizedRows = []
        metadataForOutput = snapshotColumns.map((column) => ({ ...column }))
        toast.info('Filter matched no rows. Transform applied with an empty result set.')
      } else {
        const converted = convertRowObjectsToColumns(rowsForConversion, snapshotColumns)
        normalizedRows = converted.rows
        metadataForOutput = converted.metadata
      }

      const lockedColumnIds = new Set<string>()
      if (transform.type === 'pivot_longer') {
        const { cols } = pivotLongerConfigUsed ?? (transform.config as PivotLongerConfig)
        const folded = new Set(cols)
        snapshotColumns.forEach((column) => {
          if (!folded.has(column.id)) {
            lockedColumnIds.add(column.id)
          }
        })
      } else if (transform.type === 'pivot_wider') {
        const configForTransform = pivotWiderConfigUsed ?? (transform.config as PivotWiderConfig)
        computePivotIdColumns(snapshotRows, configForTransform).forEach((colId) => {
          lockedColumnIds.add(colId)
        })
        if (configForTransform.keepOriginalColumns) {
          lockedColumnIds.add(configForTransform.namesFrom)
          configForTransform.valuesFrom.forEach((colId) => lockedColumnIds.add(colId))
        }
      } else {
        snapshotColumns.forEach((column) => {
          lockedColumnIds.add(column.id)
        })
      }
      const metadataNameResolution = ensureDistinctMetadataNames(
        metadataForOutput,
        lockedColumnIds,
        mode === 'in-place' ? dataset.columns.map((col) => col.name) : []
      )
      metadataForOutput = metadataNameResolution.metadata
      if (metadataNameResolution.renamedCount > 0) {
        toast.warning(
          `Renamed ${metadataNameResolution.renamedCount} output column name(s) to avoid display duplicates: ${metadataNameResolution.preview}.`
        )
      }
      if (mode === 'in-place' || transform.type === 'pivot_longer') {
        metadataForOutput = reorderGeneratedColumnsAfterDataColumns(
          metadataForOutput,
          dataset.columns,
          snapshotRows
        )
      }

      const actionLabel = getTransformLabel(transform.type)

      if (mode === 'new-family') {
        // NON-DESTRUCTIVE: Create new family with transformed data
        const newFamily = await createFamily()
        if (!newFamily) {
          toast.error('Failed to create new family')
          return
        }
        const placeholderDatasetId = useAppStore
          .getState()
          .families.find((family) => family.id === newFamily.id)?.datasetId

        // Create the transformed dataset
        const dataRowCount = normalizedRows.length
        const rowCount = Math.max(dataRowCount + ROW_BUFFER, MIN_ROWS)
        const now = new Date()
        const datasetId = `dataset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

        // Build columns with proper IDs
        const minColumnCount = Math.max(metadataForOutput.length, MIN_COLUMNS)
        const usedIds = new Set<string>()
        let nextIndex = 0

        const nextColumnId = () => {
          while (usedIds.has(`col-${nextIndex}`)) {
            nextIndex += 1
          }
          const id = `col-${nextIndex}`
          usedIds.add(id)
          nextIndex += 1
          return id
        }

        const newColumns: ColumnMetadata[] = []
        const sourceIdsByIndex: Array<string | null> = []

        for (let i = 0; i < minColumnCount; i++) {
          const transformed = metadataForOutput[i]
          if (transformed) {
            const id = usedIds.has(transformed.id) ? nextColumnId() : transformed.id
            usedIds.add(id)
            sourceIdsByIndex[i] = transformed.id
            newColumns.push({
              ...transformed,
              id,
              name: transformed.name ?? `Column ${i + 1}`,
              type: transformed.type ?? 'text',
              width: transformed.width ?? DEFAULT_COLUMN_WIDTH,
            })
          } else {
            const id = nextColumnId()
            sourceIdsByIndex[i] = null
            newColumns.push({
              id,
              name: `Column ${i + 1}`,
              type: 'text',
              width: DEFAULT_COLUMN_WIDTH,
            })
          }
        }

        // Remap rows to new column IDs
        const remappedRows = normalizedRows.map((row) => {
          const next: Record<string, any> = {}
          for (let i = 0; i < newColumns.length; i++) {
            const columnId = newColumns[i]?.id
            if (!columnId) continue
            const sourceId = sourceIdsByIndex[i]
            next[columnId] = sourceId ? row[sourceId] ?? null : null
          }
          return next
        })

        const transformedDataset: Dataset = {
          id: datasetId,
          name: `${dataset.name} (${actionLabel})`,
          rowCount,
          dataRowCount,
          columnCount: newColumns.length,
          columns: newColumns,
          importedAt: now,
          modifiedAt: now,
          familyId: newFamily.id,
        }

        // Write to cache and add dataset
        await cacheService.setDataset(transformedDataset.id, remappedRows)
        addDataset(transformedDataset)
        setActiveFamilyDataset(newFamily.id, transformedDataset.id, true)

        if (placeholderDatasetId && placeholderDatasetId !== transformedDataset.id) {
          removeDataset(placeholderDatasetId)
          cacheService.removeDataset(placeholderDatasetId).catch((error) => {
            console.error(
              `Failed to remove placeholder dataset ${placeholderDatasetId} from cache`,
              error
            )
          })
        }

        useAppStore.getState().setProjectDirty(true)
        toast.success(`${actionLabel} applied â†’ new family "${newFamily.name}"`)
      } else {
        // IN-PLACE: Replace data in current family (original behavior)
        const targetFamilyId = dataset.familyId ?? activeFamilyId ?? null
        const newDataset = await replaceActiveDataset(dataset, normalizedRows, metadataForOutput)
        if (targetFamilyId) {
          useResultsStore.getState().clearFamilyResults(targetFamilyId, { suppressDirty: true })
          usePlotsStore.getState().clearStatisticsFamilyPlots(targetFamilyId, { suppressDirty: true })
        }

        clearTransformSnapshot(dataset.id)
        if (snapshotRows.length > TRANSFORM_SNAPSHOT_WARN_ROWS) {
          toast.warning(
            `Undo snapshot uses significant memory (${snapshotRows.length.toLocaleString()} rows)`
          )
        }
        saveTransformSnapshot({
          datasetId: newDataset.id,
          timestamp: Date.now(),
          columns: dataset.columns,
          rowCount: dataset.rowCount,
          dataRowCount: dataset.dataRowCount,
          rows: snapshotRows,
          transformType: transform.type,
        })

        useAppStore.getState().setProjectDirty(true)
        toast.success(`${actionLabel} applied`)
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Pivot cancelled') {
        toast.warning('Pivot cancelled')
        return
      }
      console.error('Transform failed:', error)
      toast.error(error instanceof Error ? error.message : 'Transform failed')
    } finally {
      if (showPipelineSpinner) {
        setLoadingOperation(null)
      }
    }
  }

  const handleUndoTransform = async () => {
    if (blockIfAppLocked('Undo transform')) return
    if (!currentDataset) return
    const snapshot = getTransformSnapshot(currentDataset.id)
    if (!snapshot) {
      toast.error('No transform to undo')
      return
    }

    try {
      await cacheService.ensureLatestCache(currentDataset.id)
      await replaceActiveDataset(currentDataset, snapshot.rows, snapshot.columns, {
        preserveGridShape: false,
        rowCountOverride: snapshot.rowCount,
        dataRowCountOverride: snapshot.dataRowCount,
      })
      clearTransformSnapshot(currentDataset.id)
      useAppStore.getState().setProjectDirty(true)
      toast.success('Transform reverted')
    } catch (error) {
      console.error('Failed to revert transform:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to revert transform')
    }
  }

  // Handle run analysis
  const handleRunAnalysis = () => {
    if (blockIfAppLocked('Run analysis')) return
    if (blockIfNoDataRows('Run analysis')) return
    setTestDialogOpen(true)
  }

  const toSerializableJson = useCallback(function toSerializableJson(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Map) {
      const obj: Record<string, unknown> = {}
      for (const [k, v] of value.entries()) {
        obj[String(k)] = toSerializableJson(v)
      }
      return obj
    }
    if (Array.isArray(value)) return value.map(v => toSerializableJson(v))
    if (value && typeof value === 'object') {
      const obj: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        obj[k] = toSerializableJson(v)
      }
      return obj
    }
    return value
  }, [])

  const serializeDatasetForProject = useCallback(
    (dataset: Dataset, storageInfo?: DatasetStorageInfo): ProjectDataset => {
      return {
        id: dataset.id,
        name: dataset.name,
        rowCount: dataset.rowCount,
        dataRowCount: dataset.dataRowCount, // Preserve actual data row count for buffer recreation
        columnCount: dataset.columnCount,
        columns: dataset.columns.map(c => ({
          id: c.id,
          name: c.name,
          type: c.type,
          width: c.width,
        })),
        filePath: dataset.filePath,
        // All-DuckDB: Include DuckDB path (all datasets have .ecpdb files)
        duckdbPath: storageInfo?.duckdbPath ?? dataset.duckdbPath,
        familyId: dataset.familyId,
        highlights: dataset.highlights,
        importedAt: dataset.importedAt.toISOString(),
        modifiedAt: dataset.modifiedAt.toISOString(),
      }
    },
    []
  )

  const serializeResultForProject = useCallback(
    (result: TestResult): ProjectTestResult => {
      return {
        id: result.id,
        testId: result.testId,
        testName: result.testName,
        family: result.family,
        // Fix #1: Serialize statisticsFamilyId for per-family result isolation
        statisticsFamilyId: result.statisticsFamilyId,
        executedAt: result.executedAt.toISOString(),
        parameters: toSerializableJson(result.parameters ?? {}),
        statistics: toSerializableJson(result.statistics ?? {}),
        assumptions: toSerializableJson(result.assumptions),
        tables: toSerializableJson(result.tables) as unknown[] | undefined,
        summary: toSerializableJson(result.summary),
        rawResult: {
          uiResult: toSerializableJson({
            ...result,
            executedAt: result.executedAt.toISOString(),
          }),
        },
      }
    },
    [toSerializableJson]
  )

  const serializeRNAseqResults = useCallback((): SerializedRNAseqResults | undefined => {
    const { projects } = useRNAseqStore.getState()
    const results: SerializedRNAseqResults = {}

    for (const project of projects) {
      if (project.results.length === 0) continue
      results[project.id] = project.results.map((result) => ({
        ...result,
        executedAt: result.executedAt.toISOString(),
      }))
    }

    return Object.keys(results).length > 0 ? results : undefined
  }, [])

  /**
   * Deserialize RNA-seq results from project file
   * Supports both new array format and legacy object format for backward compatibility
   */
  const deserializeRNAseqResults = useCallback((results?: SerializedRNAseqResults) => {
    if (!results) return []
    const entries: Array<{
      projectId: string
      result: SerializedDESeqResult
      modelId?: string
    }> = []
    for (const [projectId, projectResults] of Object.entries(results as Record<string, unknown>)) {
      // New format: results are stored as array (newest-first)
      if (Array.isArray(projectResults)) {
        // addResultRun prepends; iterate oldest->newest to preserve stored ordering
        // after restoration (newest-first in memory).
        for (const result of [...projectResults].reverse()) {
          entries.push({ projectId, result: result as SerializedDESeqResult })
        }
        continue
      }
      // Legacy format: results stored as object { [modelId]: result }
      if (projectResults && typeof projectResults === 'object') {
        for (const [modelId, result] of Object.entries(
          projectResults as Record<string, SerializedDESeqResult>
        )) {
          entries.push({ projectId, result, modelId })
        }
      }
    }
    return entries
  }, [])

  const deserializeResultFromProject = useCallback((projectResult: ProjectTestResult) => {
    const raw = projectResult.rawResult as { uiResult?: unknown } | undefined
    const uiResult = raw?.uiResult

    const base = (uiResult && typeof uiResult === 'object'
      ? (uiResult as Record<string, unknown>)
      : {
          id: projectResult.id,
          testId: projectResult.testId,
          testName: projectResult.testName,
          family: projectResult.family,
          executedAt: projectResult.executedAt,
          parameters: projectResult.parameters,
          statistics: projectResult.statistics,
          assumptions: projectResult.assumptions,
          tables: projectResult.tables,
          summary: projectResult.summary,
        }) as Record<string, unknown>

    const executedAtRaw = base.executedAt ?? projectResult.executedAt
    const executedAt =
      executedAtRaw instanceof Date ? executedAtRaw : new Date(String(executedAtRaw))

    const encodingMappings = base.encodingMappings
    if (
      encodingMappings &&
      !(encodingMappings instanceof Map) &&
      typeof encodingMappings === 'object'
    ) {
      const outer = new Map<string, Map<string, number>>()
      for (const [variable, levels] of Object.entries(encodingMappings as Record<string, unknown>)) {
        if (levels && typeof levels === 'object') {
          outer.set(
            variable,
            new Map(
              Object.entries(levels as Record<string, unknown>).map(([k, v]) => [k, Number(v)])
            )
          )
        }
      }
      base.encodingMappings = outer as unknown
    }

    return {
      ...(base as any),
      executedAt,
    }
  }, [])

  const normalizeAnalysisHistory = useCallback((raw: unknown): AnalysisHistoryEntry[] => {
    if (!Array.isArray(raw)) {
      return []
    }

    return raw.reduce<AnalysisHistoryEntry[]>((acc, entry) => {
      if (!entry || typeof entry !== 'object') {
        return acc
      }

      const record = entry as Record<string, unknown>
      const testId = String(record.testId ?? '')
      const testName = String(record.testName ?? '')
      if (!testId || !testName) {
        return acc
      }

      const executedAtRaw = record.executedAt
      const executedAt =
        executedAtRaw instanceof Date ? executedAtRaw : new Date(String(executedAtRaw))

      const id =
        typeof record.id === 'string'
          ? record.id
          : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      const normalized: AnalysisHistoryEntry = {
        id,
        testId,
        testName,
        parameters:
          record.parameters && typeof record.parameters === 'object'
            ? (record.parameters as Record<string, unknown>)
            : {},
        executedAt,
        duration: typeof record.duration === 'number' ? record.duration : 0,
        success: Boolean(record.success),
        ...(typeof record.resultId === 'string' ? { resultId: record.resultId } : {}),
      }

      acc.push(normalized)
      return acc
    }, [])
  }, [])

  // Load recent projects list on startup (backed by Tauri)
  // Fix #5: Properly handle loading state to prevent empty flash
  useEffect(() => {
    tauriApi
      .getRecentProjects()
      .then(list => {
        setRecentProjects(
          list.map(p => ({
            id: p.path,
            name: p.name,
            path: p.path,
            lastOpened: new Date(p.modifiedAt),
          }))
        )
        // Note: setRecentProjects already sets loading to false
      })
      .catch((error) => {
        // Non-fatal; recent projects are optional
        console.warn('Failed to load recent projects:', error)
        // Fix #5: Clear loading state on error too
        useAppStore.getState().setRecentProjectsLoading(false)
      })
  }, [setRecentProjects])

  const buildProjectSnapshot = useCallback(async (overrideProjectName?: string): Promise<ProjectFile | undefined> => {
    const nowIso = new Date().toISOString()

      // Phase 1: Get or generate projectId for cache namespacing
      const { families, activeFamilyId } = useAppStore.getState()
      const projectId = await ensureProjectId()

    // Fetch storage info for all datasets (needed for duckdbPath persistence)
    const storageInfoByDatasetId = new Map<string, DatasetStorageInfo>()
    const datasetsWithoutStorage: string[] = []

    for (const dataset of datasets) {
      try {
        const storageInfo = await cacheService.getDatasetStorageInfo(dataset.id)
        storageInfoByDatasetId.set(dataset.id, storageInfo)
      } catch (error) {
        // All-DuckDB: If dataset not found in cache, this is a serious error
        // All datasets should have DuckDB storage in the all-DuckDB architecture
        console.error(`Dataset ${dataset.id} (${dataset.name}) not found in cache:`, error)
        datasetsWithoutStorage.push(dataset.name)
        storageInfoByDatasetId.set(dataset.id, {})
      }
    }

    // Warn user if any datasets are missing from cache
    if (datasetsWithoutStorage.length > 0) {
      const proceed = await confirm(
        `Warning: ${datasetsWithoutStorage.length} dataset(s) are missing from cache: ${datasetsWithoutStorage.join(', ')}.\n\nThese datasets may not be saved correctly. Continue anyway?`,
        { title: 'Missing Datasets', kind: 'warning' }
      )
      if (!proceed) {
        toast.info('Save cancelled')
        return undefined
      }
    }

    // Flush pending UI edits before persisting any dataset state
    await cacheService.flushPendingUpdates()

    // All-DuckDB: Flush overlay for ALL datasets (no size threshold)
    // All datasets are stored in DuckDB, so we must flush pending edits before save
    for (const dataset of datasets) {
      try {
        await cacheService.flushOverlay(dataset.id)
      } catch (flushError) {
        // Treat as fatal - if flush fails, data would be stale/lost
        throw new Error(
          `Cannot save project: failed to flush pending edits for dataset "${dataset.name}". ` +
            `Error: ${flushError instanceof Error ? flushError.message : String(flushError)}`
        )
      }
    }

    // Collect formulas from all datasets (Phase 7 - Formula Engine)
    const formulasByDataset: Record<string, Record<string, string>> = {}
    const { getDatasetFormulas } = useDataStore.getState()
    for (const dataset of datasets) {
      const formulas = getDatasetFormulas(dataset.id)
      if (formulas.size > 0) {
        // Convert Map to plain object for serialization
        formulasByDataset[dataset.id] = Object.fromEntries(formulas)
      }
    }

    const rnaseqStateRaw = useRNAseqStore.getState().serializeForProject()
    const rnaseqState = rnaseqStateRaw.projects.length > 0 ? rnaseqStateRaw : undefined
    const rnaseqResults = serializeRNAseqResults()

    // Get plots state for persistence (OLE Copy/Paste - Phase 1.2)
    const { plots, activePlotId, activeStatisticsFamilyId } = usePlotsStore.getState()

    // Fix #8: Use override name (from Save As filename) if provided, otherwise fall back to dataset name
    const projectName = overrideProjectName
      ?? (currentDataset?.name ? `${currentDataset.name} Project` : 'easyCris Project')

    const project: ProjectFile = {
      version: '1.0.0',
      name: projectName,
      projectId,
      datasets: datasets.map(dataset => {
        const storageInfo = storageInfoByDatasetId.get(dataset.id)
        return serializeDatasetForProject(dataset, storageInfo)
      }),
      analysisHistory: useAnalysisStore.getState().history.map(entry => ({
        ...entry,
        executedAt: entry.executedAt.toISOString(),
      })),
      savedResults: useResultsStore.getState().getAllResults().map(serializeResultForProject),
      families: families.map(family => ({
        id: family.id,
        name: family.name,
        datasetId: family.datasetId,
        hasData: family.hasData,
        hasResults: family.hasResults,
        createdAt: family.createdAt.toISOString(),
      })),
      activeFamilyId: activeFamilyId ?? undefined,
      metadata: {
        createdAt: nowIso,
        modifiedAt: nowIso,
      },
      // All-DuckDB: No dataCache - all datasets stored in .ecpdb files
      formulas: Object.keys(formulasByDataset).length > 0 ? formulasByDataset : undefined,
      // Plot persistence (OLE Copy/Paste - Phase 1.2)
      plots: plots.length > 0 ? plots : undefined,
      activePlotId: activePlotId ?? undefined,
      activeStatisticsFamilyId: activeStatisticsFamilyId ?? undefined,
      rnaseqState,
      rnaseqResults,
    }

    return project
  }, [
    currentDataset?.name,
    // dataCache removed - now using tauriApi.getRows from backend
    datasets,
    serializeDatasetForProject,
    serializeResultForProject,
    serializeRNAseqResults,
  ])

  const saveProjectToPath = useCallback(async (filePath: string) => {
    const { setProjectFilePath, setProjectDirty, projectFilePath } = useAppStore.getState()
    let toastId: string | undefined

    try {

      toastId = `save-project-${Date.now()}`
      toast.loading('Saving projectâ€¦', { id: toastId })

      // Fix #8: Extract project name from user's chosen filename
      const projectBaseName = await basename(filePath, '.ecp')
      const projectNameFromFile = projectBaseName

      const project = await buildProjectSnapshot(projectNameFromFile)
      if (!project) {
        if (toastId) {
          toast.dismiss(toastId)
        }
        return
      }

      const projectId = project.projectId

      // âœ… PHASE 3: Bundle DuckDB files with project (portable storage)
      const projectDir = await dirname(filePath)
      const dataDir = await join(projectDir, `${projectBaseName}_data`)
      const previousProjectPath = projectFilePath
      let previousDataDir: string | null = null
      if (previousProjectPath) {
        const prevDir = await dirname(previousProjectPath)
        const prevBaseName = await basename(previousProjectPath, '.ecp')
        previousDataDir = await join(prevDir, `${prevBaseName}_data`)
      }

      // Create data directory if it doesn't exist
      try {
        await mkdir(dataDir, { recursive: true })
      } catch (error) {
        // Directory may already exist - that's okay
        console.log(`Data directory already exists or created: ${dataDir}`)
      }

      // Fix #3: Set project data dir before bundling so files go to the correct location.
      // If bundling fails, we'll revert to the previous data dir (if any).
      if (projectId) {
        await cacheService.setProjectDataDir(projectId, dataDir)
      }

      // PHASE 1: Copy data files to project folder (non-destructive)
      const bundleErrors: Array<{ datasetName: string; error: unknown }> = []
      const bundledDatasetIds: string[] = [] // Track which datasets were successfully bundled

      for (const dataset of project.datasets) {
        if (projectId) {
          const fileName = `${dataset.id}${DATA_FILE_EXT}`
          try {
            // Ensure dataset has DuckDB backing before bundling (all-database project format).
            let storageInfo: DatasetStorageInfo | undefined
            try {
              storageInfo = await cacheService.getDatasetStorageInfo(dataset.id)
            } catch {
              // Proceed to conversion attempt; if it fails we'll surface the error below.
              storageInfo = undefined
            }

            if (!storageInfo?.duckdbPath) {
              const columns = dataset.columns.map(col => ({ id: col.id, name: col.name }))
              storageInfo = await cacheService.ensureDuckDbDataset(dataset.id, columns)
            }

            if (!storageInfo?.duckdbPath) {
              throw new Error(`Dataset '${dataset.id}' is not stored in DuckDB`)
            }

            await cacheService.bundleDatasetDataFile(projectId, dataset.id)
            dataset.duckdbPath = `./${projectBaseName}_data/${fileName}`
            bundledDatasetIds.push(dataset.id) // Track for Phase 2 finalization
          } catch (bundleError) {
            // Collect bundling errors - we'll fail the save if ANY dataset fails to bundle
            bundleErrors.push({ datasetName: dataset.name, error: bundleError })
          }
        }

        // Saved projects are portable; clear source file paths to avoid reliance on originals.
        dataset.filePath = undefined
      }

      // Fail the save if ANY bundling errors occurred (prevents .ecp pointing to missing .ecpdb)
      if (bundleErrors.length > 0) {
        if (projectId && previousDataDir && previousDataDir !== dataDir) {
          try {
            await cacheService.setProjectDataDir(projectId, previousDataDir)
          } catch (revertError) {
            console.warn('Failed to revert project data dir after bundling error:', revertError)
          }
        }

        const errorDetails = bundleErrors
          .map(({ datasetName, error }) => {
            const msg = error instanceof Error ? error.message : String(error)
            return `  - ${datasetName}: ${msg}`
          })
          .join('\n')

        throw new Error(
          `Failed to bundle dataset file(s):\n${errorDetails}\n\nProject NOT saved to prevent data loss.`
        )
      }

      await tauriApi.saveProject(filePath, project)

      // PHASE 2: Finalize bundled datasets (destructive, only after .ecp save succeeds)
      // This updates internal paths and deletes old files
      if (projectId && bundledDatasetIds.length > 0) {
        for (const datasetId of bundledDatasetIds) {
          try {
            await cacheService.finalizeBundledDatasetFile(projectId, datasetId)
          } catch (finalizeError) {
            // Log finalize errors but don't fail the save (data is already in project folder)
            console.warn(
              `Failed to finalize dataset ${datasetId}:`,
              finalizeError instanceof Error ? finalizeError.message : String(finalizeError)
            )
          }
        }
      }

      // Store path for subsequent saves and mark as clean
      setProjectFilePath(filePath)
      setProjectDirty(false)

      const list = await tauriApi.getRecentProjects()
      setRecentProjects(
        list.map(p => ({
          id: p.path,
          name: p.name,
          path: p.path,
          lastOpened: new Date(p.modifiedAt),
        }))
      )

      toast.success('Project saved', { id: toastId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(`Save failed: ${message}`, { id: toastId })
    }
  }, [buildProjectSnapshot, datasets, setRecentProjects])

  const handleSaveProject = useCallback(async () => {
    if (blockIfAppLocked('Save project')) return

    // Smart Save: use stored path if available, else prompt Save As (Part 1)
    const { projectFilePath } = useAppStore.getState()

    let filePath = projectFilePath

    if (!filePath) {
      // First save â†’ behave like Save As
      filePath = await save({
        title: 'Save Project',
        defaultPath: `${currentDataset?.name ?? 'easyCris'}.ecp`,
        filters: [{ name: 'easyCris Project', extensions: ['ecp'] }],
      })

      if (!filePath) return // user cancelled
    }

    await saveProjectToPath(filePath)
  }, [blockIfAppLocked, currentDataset?.name, saveProjectToPath])

  const handleSaveProjectAs = useCallback(async () => {
    if (blockIfAppLocked('Save project as')) return

    const { projectFilePath: oldProjectPath } = useAppStore.getState()

    const filePath = await save({
      title: 'Save Project As',
      defaultPath: oldProjectPath ?? `${currentDataset?.name ?? 'easyCris'}.ecp`,
      filters: [{ name: 'easyCris Project', extensions: ['ecp'] }],
    })

    if (!filePath) return

    await saveProjectToPath(filePath)

    // Remove old project from recents if Save As created a new location
    // The old .ecp now points to stale/moved data files
    if (oldProjectPath) {
      // Normalize paths for comparison (handle Windows case/slash differences)
      const isWindowsPath = (p: string) =>
        /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
      const normalizePath = (p: string) =>
        isWindowsPath(p) ? p.replace(/\//g, '\\').toLowerCase() : p
      const oldNormalized = normalizePath(oldProjectPath)
      const newNormalized = normalizePath(filePath)

      if (oldNormalized !== newNormalized) {
        try {
          await tauriApi.removeRecentProject(oldProjectPath)
          // Refresh recents (new path was already added by saveProjectToPath)
          const list = await tauriApi.getRecentProjects()
          setRecentProjects(
            list.map(p => ({
              id: p.path,
              name: p.name,
              path: p.path,
              lastOpened: new Date(p.modifiedAt),
            }))
          )
        } catch (error) {
          // Non-fatal - old entry may already be gone
          console.warn('Failed to remove old project from recents:', error)
        }
      }
    }
  }, [blockIfAppLocked, currentDataset?.name, saveProjectToPath, setRecentProjects])

  const handleClearCurrentProjectCache = useCallback(async () => {
    if (blockIfAppLocked('Clear current project cache')) return
    if (!projectId) {
      toast.warning('No active project cache to clear')
      return
    }

    try {
      const summary = await cacheService.clearCurrentProjectCache(projectId)
      toast.success('Current project cache cleared', {
        description: summarizeCleanup(summary),
      })
      void refreshCacheHealthSummary()
    } catch (error) {
      const message = extractErrorMessage(error, 'Failed to clear current project cache')
      toast.error('Cache cleanup failed', { description: message })
    }
  }, [blockIfAppLocked, projectId, refreshCacheHealthSummary, summarizeCleanup])

  const handleClearUnsavedAppCache = useCallback(async () => {
    if (blockIfAppLocked('Clear unsaved/AppData cache')) return

    try {
      await clearUnsavedAppCacheWithToasts()
      void refreshCacheHealthSummary()
    } catch (error) {
      const message = extractErrorMessage(error, 'Failed to clear unsaved/AppData cache')
      toast.error('Cache cleanup failed', { description: message })
    }
  }, [blockIfAppLocked, clearUnsavedAppCacheWithToasts, refreshCacheHealthSummary])

  const handleClearAllAppCache = useCallback(async () => {
    if (blockIfAppLocked('Clear all cache')) return

    const proceed = await confirm(
      'Clear all AppData cache files now?\n\nThis keeps active files in use, but removes all other unsaved cache files.',
      {
        title: 'Clear All Cache',
        kind: 'warning',
      }
    )
    if (!proceed) return

    try {
      const summary = await cacheService.clearAllAppCache()
      toast.success('All cache cleaned', {
        description: summarizeCleanup(summary),
      })
      void refreshCacheHealthSummary()
    } catch (error) {
      const message = extractErrorMessage(error, 'Failed to clear all cache')
      toast.error('Cache cleanup failed', { description: message })
    }
  }, [blockIfAppLocked, refreshCacheHealthSummary, summarizeCleanup])

  const confirmStartNewProject = useCallback(async () => {
    const { projectDirty, saveProject } = useAppStore.getState()
    if (!projectDirty) {
      return true
    }

    const shouldSave = await confirm(
      'You have unsaved changes. Save before creating a new project?',
      { title: 'Unsaved Changes', kind: 'warning' }
    )

    if (shouldSave) {
      await saveProject()
      if (useAppStore.getState().projectDirty) {
        return false
      }
      return true
    }

    const discardChanges = await confirm(
      'Discard unsaved changes and start a new project?',
      { title: 'Discard Changes', kind: 'warning' }
    )
    return discardChanges
  }, [])

  const confirmOpenProject = useCallback(async () => {
    const { projectDirty, saveProject } = useAppStore.getState()
    if (!projectDirty) {
      return true
    }

    const shouldSave = await confirm(
      'You have unsaved changes. Save before opening another project?',
      { title: 'Unsaved Changes', kind: 'warning' }
    )

    if (shouldSave) {
      await saveProject()
      if (useAppStore.getState().projectDirty) {
        return false
      }
      return true
    }

    const discardChanges = await confirm(
      'Discard unsaved changes and open another project?',
      { title: 'Discard Changes', kind: 'warning' }
    )
    return discardChanges
  }, [])

  // Check for user-derived plots and warn before clearing
  const confirmClearPlotsIfNeeded = useCallback(async (
    familyId?: string | null
  ): Promise<boolean> => {
    const plots = usePlotsStore.getState().plots
    const targetFamilyId = familyId ?? null
    const scopedPlots = targetFamilyId
      ? plots.filter(p => (p.statisticsFamilyId ?? 'statistics-1') === targetFamilyId)
      : plots

    if (scopedPlots.length === 0) {
      return true // No plots to remove, proceed without warning
    }

    const plotCount = scopedPlots.length
    const scopeLabel = targetFamilyId ? 'this data' : 'this project'
    const message = plotCount === 1
      ? `You have 1 plot created from ${scopeLabel}. This plot will be deleted when the data is cleared.`
      : `You have ${plotCount} plots created from ${scopeLabel}. These plots will be deleted when the data is cleared.`

    return await confirm(message + '\n\nDo you want to proceed?', {
      title: 'Plots Will Be Deleted',
      kind: 'warning',
    })
  }, [])

  const confirmClearResultsAndPlotsIfNeeded = useCallback(async (
    familyId?: string | null
  ): Promise<boolean> => {
    const targetFamilyId = familyId ?? null
    const plots = usePlotsStore.getState().plots
    const scopedPlots = targetFamilyId
      ? plots.filter(p => (p.statisticsFamilyId ?? 'statistics-1') === targetFamilyId)
      : plots
    const plotCount = scopedPlots.length
    const resultCount = targetFamilyId
      ? useResultsStore.getState().getFamilyResultCount(targetFamilyId)
      : useResultsStore.getState().results.length

    if (plotCount === 0 && resultCount === 0) {
      return true
    }

    const scopeLabel = targetFamilyId ? 'this statistics family' : 'this project'
    const resultsLabel = resultCount === 1 ? '1 result' : `${resultCount} results`
    const plotsLabel = plotCount === 1 ? '1 plot' : `${plotCount} plots`

    return await confirm(
      `Importing a new dataset will clear ${resultsLabel} and ${plotsLabel} for ${scopeLabel}.\n\nDo you want to proceed?`,
      {
        title: 'Results and Plots Will Be Cleared',
        kind: 'warning',
      }
    )
  }, [])

  // Helper to clear all data, results, and plots together
  const clearAllDataResultsAndPlots = useCallback(async () => {
    clearAllDatasets()
    useResultsStore.getState().clearAllResults({ suppressDirty: true })
    usePlotsStore.getState().clearPlots({ suppressDirty: true })
    useAnalysisStore.getState().clearHistory({ suppressDirty: true })
    await useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
  }, [clearAllDatasets])
  const clearProjectArtifactsExceptDatasets = useCallback(async () => {
    useResultsStore.getState().clearAllResults({ suppressDirty: true })
    usePlotsStore.getState().clearPlots({ suppressDirty: true })
    useAnalysisStore.getState().clearHistory({ suppressDirty: true })
    await useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
  }, [])

  const handleNewProject = useCallback(async () => {
    if (blockIfAppLocked('New project')) return
    const wasRNAseqActive = Boolean(activeRNAseqProject)
    const proceed = await confirmStartNewProject()
    if (!proceed) {
      return
    }

    // Warn user if plots will be deleted
    const proceedWithPlots = await confirmClearPlotsIfNeeded()
    if (!proceedWithPlots) {
      return
    }

    await clearProjectArtifactsExceptDatasets()

    // Phase B: Clear backend cache for old project
    await cacheService.clearAll()

    const newFamilyBase = {
      id: 'statistics-1',
      name: 'Statistics',
      hasData: false,
      hasResults: false,
      createdAt: new Date(),
    }
    useAppStore.getState().setProjectFilePath(null)
    useAppStore.getState().setProjectDirty(false)
    const newProjectId = crypto.randomUUID()
    useAppStore.getState().setProjectId(newProjectId)

    // Phase B: Set active project ID immediately after generating new project ID
    // All dataset operations will now be namespaced to this project
    await cacheService.setActiveProjectId(newProjectId)

    try {
      const blankDataset = await initializeBlankDataset('Spreadsheet', { activate: false })
      const token = pendingGridSurfaceActivationTokenRef.current + 1
      pendingGridSurfaceActivationTokenRef.current = token
      if (currentDataset?.id) {
        setDisplayDatasetId(currentDataset.id)
      }
      setPendingGridSurfaceActivation({
        familyId: newFamilyBase.id,
        datasetId: blankDataset.id,
        token,
        status: 'staging',
        kind: 'project-reset',
      })
      restoreFamilies(
        [{ ...newFamilyBase, datasetId: blankDataset.id }],
        newFamilyBase.id
      )
    } catch (error) {
      console.error('Failed to initialize blank dataset for new project:', error)
      toast.error('Failed to initialize blank dataset for new project')
    }

    if (wasRNAseqActive) {
      try {
        await useRNAseqStore.getState().createProjectWithBootstrap('RNA-seq 1')
      } catch (err) {
        console.error('[AppShell] Failed to bootstrap RNA-seq project on new project seed:', err)
        toast.error('Failed to initialize RNA-seq project')
      }
    }
  }, [
    activeRNAseqProject,
    blockIfAppLocked,
    clearProjectArtifactsExceptDatasets,
    confirmClearPlotsIfNeeded,
    confirmStartNewProject,
    currentDataset?.id,
    initializeBlankDataset,
    restoreFamilies,
  ])

  // Load project from file path (shared logic for File > Open and Recent projects)
  const loadProjectFromPath = useCallback(async (
    filePath: string,
    options?: LoadProjectFromPathOptions
  ) => {
    if (blockIfAppLocked('Open project')) return
    const nonInteractive = options?.nonInteractive === true
    const canProceed = nonInteractive ? true : await confirmOpenProject()
    if (!canProceed) {
      return
    }

    const toastId = `open-project-${Date.now()}`
    toast.loading('Opening projectâ€¦', { id: toastId })
    setLoadingOperation({
      type: 'import',
      message: 'Loading project...',
      indeterminate: true,
    })

    let previousActiveProjectId: string | null = null
    let didSetActiveProject = false
    const rollbackActiveProject = async () => {
      if (!didSetActiveProject) {
        return false
      }
      if (previousActiveProjectId) {
        await cacheService.setActiveProjectId(previousActiveProjectId)
        return true
      }
      await cacheService.clearActiveProjectId()
      return false
    }
    try {
      const project = await tauriApi.loadProject(filePath)

      const trimmedProjectId = project.projectId?.trim()
      const hasValidProjectId = isValidProjectIdForCache(trimmedProjectId)
      const resolvedProjectId = hasValidProjectId ? trimmedProjectId! : crypto.randomUUID()
      const generatedProjectId = project.projectIdGenerated === true || !hasValidProjectId

      // âœ… PHASE 5: Configure backend to use project-adjacent storage
      const projectDir = await dirname(filePath)
      const projectBaseName = await basename(filePath, '.ecp')
      const dataDir = await join(projectDir, `${projectBaseName}_data`)

      // Restore statistics families (prevents dataset bleed across families)
      const datasetIdSet = new Set((project.datasets ?? []).map(ds => ds.id))
      const savedFamilies = project.families ?? []
      const rnaseqDatasetIds = new Set<string>()
      const rnaseqDatasetOwners = new Map<string, string>()
      for (const rnaseqProject of project.rnaseqState?.projects ?? []) {
        const rnaseqFamilyId = `rnaseq:${rnaseqProject.id}`
        if (rnaseqProject.countsDatasetId) {
          rnaseqDatasetIds.add(rnaseqProject.countsDatasetId)
          const existingOwner = rnaseqDatasetOwners.get(rnaseqProject.countsDatasetId)
          if (existingOwner && existingOwner !== rnaseqFamilyId) {
            console.warn(
              `[RNAseq] Dataset '${rnaseqProject.countsDatasetId}' linked to multiple RNA-seq projects. Keeping '${existingOwner}'.`
            )
          } else {
            rnaseqDatasetOwners.set(rnaseqProject.countsDatasetId, rnaseqFamilyId)
          }
        }
        if (rnaseqProject.metadataDatasetId) {
          rnaseqDatasetIds.add(rnaseqProject.metadataDatasetId)
          const existingOwner = rnaseqDatasetOwners.get(rnaseqProject.metadataDatasetId)
          if (existingOwner && existingOwner !== rnaseqFamilyId) {
            console.warn(
              `[RNAseq] Dataset '${rnaseqProject.metadataDatasetId}' linked to multiple RNA-seq projects. Keeping '${existingOwner}'.`
            )
          } else {
            rnaseqDatasetOwners.set(rnaseqProject.metadataDatasetId, rnaseqFamilyId)
          }
        }
      }
      const fallbackDatasets = (project.datasets ?? []).filter(
        (ds) => !rnaseqDatasetIds.has(ds.id)
      )
      const fallbackFamilies: ProjectFamily[] = fallbackDatasets.map((ds, index) => ({
        id: `statistics-${index + 1}`,
        name: index === 0 ? 'Statistics' : `Statistics #${index + 1}`,
        datasetId: ds.id,
        hasData: true,
        hasResults: false,
        createdAt: new Date().toISOString(),
      }))
      const familiesFromProject: ProjectFamily[] =
        savedFamilies.length > 0
          ? savedFamilies
          : fallbackFamilies.length > 0
            ? fallbackFamilies
            : [
                {
                  id: 'statistics-1',
                  name: 'Statistics',
                  datasetId: undefined,
                  hasData: false,
                  hasResults: false,
                  createdAt: new Date().toISOString(),
                },
              ]

      const restoredFamilies = familiesFromProject.map(family => ({
        id: family.id,
        name: family.name,
        datasetId: family.datasetId && datasetIdSet.has(family.datasetId) ? family.datasetId : undefined,
        hasData: family.datasetId ? datasetIdSet.has(family.datasetId) : false,
        hasResults: family.hasResults,
        createdAt: new Date(family.createdAt),
      }))
      const targetActiveFamilyId =
        project.activeFamilyId ?? restoredFamilies[0]?.id ?? null

      // All-DuckDB: No dataCache restoration

      // Restore datasets (wire format -> store format)
      // Recreate buffer rows: dataRowCount + ROW_BUFFER = rowCount
      const restoredDatasets = (project.datasets ?? []).map(ds => {
        const columns: ColumnMetadata[] = (ds.columns ?? []).map(c => ({
          id: c.id,
          name: c.name,
          type: (c.type as ColumnMetadata['type']) ?? 'text',
          width: c.width,
        }))

        // Use saved dataRowCount or fall back to rowCount (legacy projects)
        const dataRowCount = ds.dataRowCount ?? ds.rowCount
        // Recreate buffer: add ROW_BUFFER beyond data, maintain MIN_ROWS minimum
        const rowCountWithBuffer = Math.max(dataRowCount + ROW_BUFFER, MIN_ROWS)

        const rnaseqOwner = rnaseqDatasetOwners.get(ds.id)
        let resolvedFamilyId = ds.familyId
        if (rnaseqOwner) {
          if (resolvedFamilyId && resolvedFamilyId !== rnaseqOwner) {
            console.warn(
              `[RNAseq] Overriding dataset '${ds.id}' familyId '${resolvedFamilyId}' with '${rnaseqOwner}'.`
            )
          }
          resolvedFamilyId = rnaseqOwner
        }

        return {
          id: ds.id,
          name: ds.name,
          rowCount: rowCountWithBuffer,
          dataRowCount: dataRowCount,
          columnCount: ds.columnCount,
          columns,
          filePath: ds.filePath || undefined,
          duckdbPath: ds.duckdbPath || undefined, // Phase 1: DuckDB path persistence
          importedAt: new Date(ds.importedAt),
          modifiedAt: new Date(ds.modifiedAt),
          familyId: resolvedFamilyId,
          highlights: ds.highlights ?? undefined,
        }
      })

      const existingDatasets = useDataStore.getState().datasets
      const existingDatasetIds = new Set(existingDatasets.map(ds => ds.id))
      const hasIdConflicts = restoredDatasets.some(ds => existingDatasetIds.has(ds.id))
      const previousProjectPath = useAppStore.getState().projectFilePath
      const previousProjectDir = previousProjectPath ? await dirname(previousProjectPath) : null
      const existingDatasetBackups = hasIdConflicts
        ? await Promise.all(
            existingDatasets.map(async (dataset) => {
              let duckdbPath = dataset.duckdbPath ?? null
              try {
                const storageInfo = await cacheService.getDatasetStorageInfo(dataset.id)
                if (storageInfo?.duckdbPath) {
                  duckdbPath = storageInfo.duckdbPath
                }
              } catch (error) {
                console.warn(`Failed to read storage info for ${dataset.id}`, error)
              }

              if (duckdbPath && !(await isAbsolute(duckdbPath))) {
                duckdbPath = previousProjectDir ? await join(previousProjectDir, duckdbPath) : null
              }

              return {
                id: dataset.id,
                duckdbPath,
                columns: dataset.columns.map(col => ({
                  id: col.id,
                  name: col.name,
                  dtype: col.type,
                })),
              }
            })
          )
        : []

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // PREFLIGHT PHASE: Validate project WITHOUT modifying any state
      // - Resolve relinks and determine load strategy for each dataset
      // - If user cancels or zero datasets loadable â†’ return early, state unchanged
      // - Current project remains intact if preflight fails
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const skippedDatasetIds = new Set<string>()
      const preflightPlans = new Map<
        string,
        { action: 'duckdb' | 'source' | 'skip'; duckdbPath?: string; sourcePath?: string }
      >()
      type RelinkResult = {
        action: 'relink' | 'relink-duckdb' | 'use-fallback' | 'skip' | 'cancel'
        newPath?: string
        fileType?: 'source' | 'duckdb'
      }
      const promptRelink = async (payload: {
        dataset: Dataset
        reason: RelinkReason
        originalPath: string
        duckdbPath?: string
        sourcePath?: string
      }): Promise<RelinkResult> => {
        const result = await new Promise<RelinkResult>((resolve) => {
          relinkResolverRef.current = { resolve }
          setRelinkDialogState({
            isOpen: true,
            datasetName: payload.dataset.name,
            originalPath: payload.originalPath,
            reason: payload.reason,
            datasetId: payload.dataset.id,
            duckdbPath: payload.duckdbPath,
            sourcePath: payload.sourcePath,
          })
        })

        setRelinkDialogState(null)
        relinkResolverRef.current = null
        return result
      }

      for (const dataset of restoredDatasets) {
        const fallbackDuckdbRelativePath = `./${projectBaseName}_data/${dataset.id}${DATA_FILE_EXT}`
        const fallbackDuckdbAbsolutePath = await join(
          projectDir,
          `${projectBaseName}_data`,
          `${dataset.id}${DATA_FILE_EXT}`
        )

        let resolvedDuckdbPath: string | null = null
        let missingDuckdbPath: string | null = null

        if (dataset.duckdbPath) {
          const isDuckDBAbsolute = await isAbsolute(dataset.duckdbPath)
          const absoluteDuckDBPath = isDuckDBAbsolute
            ? dataset.duckdbPath
            : await join(projectDir, dataset.duckdbPath)

          const duckdbExists = await cacheService.pathExists(absoluteDuckDBPath)
          if (duckdbExists) {
            resolvedDuckdbPath = absoluteDuckDBPath
          } else {
            missingDuckdbPath = absoluteDuckDBPath
          }
        }

        if (!resolvedDuckdbPath) {
          const fallbackExists = await cacheService.pathExists(fallbackDuckdbAbsolutePath)
          if (fallbackExists) {
            dataset.duckdbPath = fallbackDuckdbRelativePath
            resolvedDuckdbPath = fallbackDuckdbAbsolutePath
          } else if (!missingDuckdbPath) {
            missingDuckdbPath = fallbackDuckdbAbsolutePath
          }
        }

        if (resolvedDuckdbPath) {
          preflightPlans.set(dataset.id, { action: 'duckdb', duckdbPath: resolvedDuckdbPath })
          continue
        }

        let sourceAbsolutePath: string | null = null
        if (dataset.filePath) {
          const isSourceAbsolute = await isAbsolute(dataset.filePath)
          const absoluteSourcePath = isSourceAbsolute
            ? dataset.filePath
            : await join(projectDir, dataset.filePath)
          const sourceExists = await cacheService.pathExists(absoluteSourcePath)
          if (sourceExists) {
            sourceAbsolutePath = absoluteSourcePath
          }
        }

        const dialogReason: RelinkReason = sourceAbsolutePath ? 'duckdb-missing' : 'both-missing'
        if (nonInteractive) {
          skippedDatasetIds.add(dataset.id)
          preflightPlans.set(dataset.id, { action: 'skip' })
          continue
        }

        const relinkResult = await promptRelink({
          dataset,
          reason: dialogReason,
          originalPath: missingDuckdbPath ?? fallbackDuckdbAbsolutePath,
          duckdbPath: missingDuckdbPath ?? fallbackDuckdbAbsolutePath,
          sourcePath: dataset.filePath,
        })

        if (relinkResult.action === 'cancel') {
          toast.error('Project load cancelled', { id: toastId })
          return
        }

        if (relinkResult.action === 'skip') {
          skippedDatasetIds.add(dataset.id)
          preflightPlans.set(dataset.id, { action: 'skip' })
          continue
        }

        if (relinkResult.action === 'relink-duckdb' && relinkResult.newPath) {
          dataset.duckdbPath = relinkResult.newPath
          preflightPlans.set(dataset.id, { action: 'duckdb', duckdbPath: relinkResult.newPath })
          continue
        }

        if (relinkResult.action === 'relink' && relinkResult.newPath) {
          dataset.filePath = relinkResult.newPath
          dataset.duckdbPath = undefined
          sourceAbsolutePath = relinkResult.newPath
        }

        if (relinkResult.action === 'use-fallback') {
          dataset.duckdbPath = undefined
        }

        if (!sourceAbsolutePath) {
          skippedDatasetIds.add(dataset.id)
          preflightPlans.set(dataset.id, { action: 'skip' })
          continue
        }

        preflightPlans.set(dataset.id, { action: 'source', sourcePath: sourceAbsolutePath })
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // PREFLIGHT GATE: Check if at least one dataset is loadable BEFORE any state changes
      // This prevents losing the current project if the new project can't be loaded.
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const loadableDatasetCount = Array.from(preflightPlans.values()).filter(
        plan => plan.action !== 'skip'
      ).length

      if (loadableDatasetCount === 0 && restoredDatasets.length > 0) {
        // No datasets can be loaded - abort without clearing current project
        toast.error('Open failed: no datasets could be loaded. Keeping current project.', { id: toastId })
        setLoadingOperation(null)
        return
      }

      const restoreExistingBackendDatasets = async () => {
        if (existingDatasetBackups.length === 0) return
        const canRestore = await rollbackActiveProject()
        if (!canRestore) {
          console.warn('No previous project context available; skipping backend dataset restore.')
          return
        }
        const restoreResults = await Promise.allSettled(
          existingDatasetBackups.map(async (entry) => {
            if (!entry.duckdbPath) return
            await cacheService.registerExistingDuckDB(entry.id, entry.duckdbPath, entry.columns)
          })
        )
        const failed = restoreResults.filter((result) => result.status === 'rejected')
        if (failed.length > 0) {
          console.warn('Failed to restore some datasets after open failure.', failed)
        }
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // COMMIT PHASE: Project is loadable - now safe to modify state
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

      // Fix #1: Clean up old project's datasets BEFORE switching project ID
      // This ensures removeDataset targets the correct (old) project namespace,
      // preventing resource leaks (.ecpdb files locked on Windows, memory/handles)
      if (hasIdConflicts && existingDatasets.length > 0) {
        const cleanupResults = await Promise.allSettled(
          existingDatasets.map(ds => cacheService.removeDataset(ds.id))
        )
        const failedCleanup = cleanupResults.filter(result => result.status === 'rejected')
        if (failedCleanup.length > 0) {
          console.warn('Failed to clear some datasets before project load.', failedCleanup)
        }
      }

      // Step 1: Phase B - Set active project ID (atomic switch)
      // All subsequent dataset operations will use this project ID for namespacing
      // Save previous for rollback if import phase fails
      previousActiveProjectId = await cacheService.setActiveProjectId(resolvedProjectId)
      didSetActiveProject = true

      // Step 2: Configure backend to use project-adjacent storage
      await cacheService.setProjectDataDir(resolvedProjectId, dataDir)

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // IMPORT PHASE: Load datasets according to preflight plans
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const loadedDatasets: Dataset[] = []

      for (const dataset of restoredDatasets) {
        // All-DuckDB: ALL datasets must have DuckDB file (no size threshold)
        let importSucceeded = false
        const plan = preflightPlans.get(dataset.id)
        const forceSourceImport = plan?.action === 'source'

        if (plan?.action === 'skip') {
          skippedDatasetIds.add(dataset.id)
          continue
        }

        if (plan?.action === 'duckdb' && plan.duckdbPath) {
          dataset.duckdbPath = plan.duckdbPath
        }

        if (plan?.action === 'source' && plan.sourcePath) {
          dataset.filePath = plan.sourcePath
          dataset.duckdbPath = undefined
        }

        const fallbackDuckdbRelativePath = `./${projectBaseName}_data/${dataset.id}${DATA_FILE_EXT}`
        const fallbackDuckdbAbsolutePath = await join(
          projectDir,
          `${projectBaseName}_data`,
          `${dataset.id}${DATA_FILE_EXT}`
        )

        if (!dataset.duckdbPath && !forceSourceImport) {
          const fallbackExists = await cacheService.pathExists(fallbackDuckdbAbsolutePath)
          if (fallbackExists) {
            dataset.duckdbPath = fallbackDuckdbRelativePath
          }
        }

        const loadDuckdbFile = async (absoluteDuckDBPath: string) => {
          try {
            toast.loading(`Loading "${dataset.name}"...`, {
              id: `load-duckdb-${dataset.id}`,
            })

            await cacheService.registerExistingDuckDB(
              dataset.id,
              absoluteDuckDBPath,
              dataset.columns?.map(col => ({
                id: col.id,
                name: col.name,
                dtype: col.type,
              }))
            )

            toast.success(`Loaded "${dataset.name}"`, { id: `load-duckdb-${dataset.id}` })
            importSucceeded = true
          } catch (error) {
            console.error(`Failed to load data file for ${dataset.id}:`, error)
            toast.error(`Failed to load "${dataset.name}". Trying source file...`, {
              id: `load-duckdb-${dataset.id}`,
            })
          }
        }

        // âœ… PRIORITY 1: Use existing DuckDB file (has edits)
        if (dataset.duckdbPath) {
            const projectDir = await dirname(filePath)
            const isDuckDBAbsolute = await isAbsolute(dataset.duckdbPath)
            const absoluteDuckDBPath = isDuckDBAbsolute
              ? dataset.duckdbPath
              : await join(projectDir, dataset.duckdbPath)

            const duckdbExists = await cacheService.pathExists(absoluteDuckDBPath)
            if (duckdbExists) {
              await loadDuckdbFile(absoluteDuckDBPath)
            } else {
              const fallbackIsDifferent = absoluteDuckDBPath !== fallbackDuckdbAbsolutePath
              if (fallbackIsDifferent) {
                const fallbackExists = await cacheService.pathExists(fallbackDuckdbAbsolutePath)
                if (fallbackExists) {
                  dataset.duckdbPath = fallbackDuckdbRelativePath
                  await loadDuckdbFile(fallbackDuckdbAbsolutePath)
                }
              }

              if (!importSucceeded && !plan) {
                if (nonInteractive) {
                  skippedDatasetIds.add(dataset.id)
                  continue
                }

                // DuckDB file is missing - Phase 2: Offer relink dialog
                console.warn(`Data file path missing for ${dataset.id}: ${absoluteDuckDBPath}`)

                // Check if source file exists to determine dialog type (Phase 2 Fix: resolve relative paths)
                let sourceExists = false
                if (dataset.filePath) {
                  const isSourceAbsolute = await isAbsolute(dataset.filePath)
                  const absoluteSourcePath = isSourceAbsolute
                    ? dataset.filePath
                    : await join(projectDir, dataset.filePath)
                  sourceExists = await cacheService.pathExists(absoluteSourcePath)
                }
                const dialogReason: RelinkReason = sourceExists ? 'duckdb-missing' : 'both-missing'

                // Show relink dialog
                const result = await promptRelink({
                  dataset,
                  reason: dialogReason,
                  originalPath: absoluteDuckDBPath,
                  duckdbPath: absoluteDuckDBPath,
                  sourcePath: dataset.filePath,
                })

                if (result.action === 'cancel') {
                  toast.error('Project load cancelled', { id: toastId })
                  if (hasIdConflicts) {
                    await restoreExistingBackendDatasets()
                  } else {
                    await rollbackActiveProject()
                  }
                  return
                }

                if (result.action === 'skip') {
                  skippedDatasetIds.add(dataset.id)
                  continue
                }

                if (result.action === 'relink-duckdb' && result.newPath) {
                  // User chose a new data file
                  try {
                    toast.loading(`Loading "${dataset.name}"...`, {
                      id: `load-duckdb-${dataset.id}`,
                    })

                    await cacheService.registerExistingDuckDB(
                      dataset.id,
                      result.newPath,
                      dataset.columns?.map(col => ({
                        id: col.id,
                        name: col.name,
                        dtype: col.type,
                      }))
                    )

                    toast.success(`Loaded "${dataset.name}"`, { id: `load-duckdb-${dataset.id}` })
                    importSucceeded = true
                  } catch (error) {
                    console.error(`Failed to load relinked data file for ${dataset.id}:`, error)
                    toast.error(`Failed to load "${dataset.name}"`, {
                      id: `load-duckdb-${dataset.id}`,
                    })
                    skippedDatasetIds.add(dataset.id)
                    continue
                  }
                }

                // Phase 2 Fix: Handle source file relink from both-missing dialog
                if (result.action === 'relink' && result.newPath) {
                  // User chose a new source file - update dataset.filePath for fallback import
                  dataset.filePath = result.newPath
                  // Fix #3: Clear duckdbPath when relinking to new source file
                  // The old DuckDB path is stale - a new one will be created on re-import
                  dataset.duckdbPath = undefined
                  console.log(`Updated source path for ${dataset.name} to: ${result.newPath}`)
                  // Fall through to source import below
                }

                // Fix #3: Clear duckdbPath when using source file fallback
                if (result.action === 'use-fallback') {
                  // User chose to use source file instead of missing DuckDB
                  // Clear the stale duckdbPath - a new one will be created on re-import
                  dataset.duckdbPath = undefined
                  console.log(`Using source fallback for ${dataset.name}, cleared duckdbPath`)
                  // Fall through to source import below
                }
              }
            }
          }

          // âœ… PRIORITY 2: Re-import from source file (fallback)
          if (!importSucceeded && dataset.filePath) {
            const projectDir = await dirname(filePath)
            const isSourceAbsolute = await isAbsolute(dataset.filePath)
            let importPath = isSourceAbsolute
              ? dataset.filePath
              : await join(projectDir, dataset.filePath)

            // Check if source file exists
            const fileExists = await cacheService.pathExists(importPath)

            if (!fileExists) {
              if (nonInteractive) {
                skippedDatasetIds.add(dataset.id)
                continue
              }

              // Show relink dialog and wait for user response
              const result = await promptRelink({
                dataset,
                reason: 'missing',
                originalPath: importPath,
              })

              if (result.action === 'cancel') {
                toast.error('Project load cancelled', { id: toastId })
                if (hasIdConflicts) {
                  await restoreExistingBackendDatasets()
                } else {
                  await rollbackActiveProject()
                }
                return
              }

              if (result.action === 'skip') {
                skippedDatasetIds.add(dataset.id)
                continue
              }

              if (result.action === 'relink' && result.newPath) {
                importPath = result.newPath
                // Update dataset filePath for future saves
                dataset.filePath = result.newPath
                // Fix #3: Clear duckdbPath when relinking to new source file
                dataset.duckdbPath = undefined
              }
            }

          // Import the large dataset - route based on file extension
          try {
            toast.loading(`Loading large dataset "${dataset.name}"...`, {
              id: `load-large-${dataset.id}`,
            })

            // Determine the correct importer based on file extension
            // Phase 4: Use project-scoped imports to prevent cache collisions
            const fileExt = importPath.toLowerCase().split('.').pop() ?? ''
            if (fileExt === 'parquet') {
              await cacheService.importLargeParquetWithProject(
                resolvedProjectId,
                dataset.id,
                importPath
              )
            } else {
              // Default to CSV for csv, tsv, and other text formats
              await cacheService.importLargeCsvWithProject(
                resolvedProjectId,
                dataset.id,
                importPath
              )
            }

            toast.success(`Loaded "${dataset.name}"`, { id: `load-large-${dataset.id}` })
            importSucceeded = true
          } catch (error) {
            console.error(`Failed to load large dataset ${dataset.id}:`, error)
            toast.error(`Failed to load "${dataset.name}"`, { id: `load-large-${dataset.id}` })
            skippedDatasetIds.add(dataset.id)
          }
        }

        // âœ… PRIORITY 3: Skip if both DuckDB and source failed
        if (!importSucceeded) {
          console.warn(`Skipping dataset ${dataset.id} - no valid data source`)
          skippedDatasetIds.add(dataset.id)
        } else {
          loadedDatasets.push(dataset as Dataset)
        }
      }

      if (loadedDatasets.length === 0 && restoredDatasets.length > 0) {
        if (hasIdConflicts) {
          await restoreExistingBackendDatasets()
        } else {
          await rollbackActiveProject()
        }
        toast.error('Open failed: no datasets could be loaded. Keeping current project.', { id: toastId })
        return
      }

      // Clear frontend state (plots, results, history from previous project)
      await clearAllDataResultsAndPlots()

      if (!hasIdConflicts && existingDatasets.length > 0 && previousActiveProjectId) {
        const cleanupProjectId = previousActiveProjectId
        const cleanupResults = await Promise.allSettled(
          existingDatasets.map(async (ds) => {
            await cacheService.removeDatasetWithProject(cleanupProjectId, ds.id)
          })
        )
        const failedCleanup = cleanupResults.filter(result => result.status === 'rejected')
        if (failedCleanup.length > 0) {
          console.warn('Failed to clear some datasets after project load.', failedCleanup)
        }
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // RESTORE PHASE: State is committed, now restore project data
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      useAppStore.getState().setProjectId(resolvedProjectId)

      for (const dataset of loadedDatasets) {
        addDataset(dataset as Dataset)
      }

      // Set currentDataset IMMEDIATELY after adding datasets to prevent "rows only" view
      // This must happen before family normalization to ensure grid has columns during re-renders
      if (loadedDatasets.length > 0) {
        const targetFamilyDataset = restoredFamilies.find(
          f => f.id === targetActiveFamilyId
        )?.datasetId

        const initial = targetFamilyDataset
          ? loadedDatasets.find(ds => ds.id === targetFamilyDataset) ?? loadedDatasets[0]
          : loadedDatasets[0]

        setCurrentDataset(initial as Dataset)
      }

      // Normalize families after dataset load to avoid dangling datasetIds
      const loadedIds = new Set(loadedDatasets.map(ds => ds.id))
      const normalizedFamilies = restoredFamilies.map(family => {
        if (family.datasetId && !loadedIds.has(family.datasetId)) {
          return { ...family, datasetId: undefined, hasData: false }
        }
        return family
      })
      const resolvedActiveFamilyId =
        normalizedFamilies.find(f => f.id === targetActiveFamilyId)?.id ??
        normalizedFamilies[0]?.id ??
        null
      restoreFamilies(
        normalizedFamilies,
        resolvedActiveFamilyId
      )

      if (skippedDatasetIds.size > 0) {
        const skippedNames = restoredDatasets
          .filter(ds => skippedDatasetIds.has(ds.id))
          .map(ds => ds.name)
        toast.warning(
          `Skipped ${skippedNames.length} dataset(s): ${skippedNames.join(', ')}`
        )
      }

      // All-DuckDB: NO dataCache or small dataset loading. All datasets are DuckDB.

        // If no datasets were loaded, provision a blank spreadsheet
        if (loadedDatasets.length === 0) {
          try {
            const blankDataset = await initializeBlankDataset('Spreadsheet')
            const currentFamilyId = useAppStore.getState().activeFamilyId
            if (currentFamilyId) {
              setActiveFamilyDataset(currentFamilyId, blankDataset.id, false)
            }
          } catch (error) {
            console.error('Failed to initialize blank dataset after load:', error)
            toast.error('Failed to initialize blank dataset after load')
          }
        } else {
        // Update family-dataset association after currentDataset is already set
        const activeFamilyDataset = useAppStore.getState().families.find(
          f => f.id === useAppStore.getState().activeFamilyId
        )?.datasetId

        const initial = useDataStore.getState().currentDataset
        const activeFamilyIdForUpdate = useAppStore.getState().activeFamilyId
        if (activeFamilyIdForUpdate && !activeFamilyDataset) {
          setActiveFamilyDataset(activeFamilyIdForUpdate, (initial as Dataset).id, true)
        } else if (!activeFamilyIdForUpdate) {
          updateActiveFamilyData((initial as Dataset).id)
        }
      }

      // Restore results (prefer full UI result stored in rawResult.uiResult)
      const restoredResults = (project.savedResults ?? []).map(deserializeResultFromProject)
      const activeFamilyIdForResults = useAppStore.getState().activeFamilyId
      for (const r of restoredResults) {
        const withFamily = {
          ...(r as any),
          statisticsFamilyId: (r as any).statisticsFamilyId ?? activeFamilyIdForResults ?? 'statistics-1',
        }
        useResultsStore.getState().addResult(withFamily, { suppressDirty: true })
      }

      const restoredHistory = normalizeAnalysisHistory(project.analysisHistory)
      const maxHistorySize = useAnalysisStore.getState().maxHistorySize
      useAnalysisStore.setState(
        { history: restoredHistory.slice(0, maxHistorySize) },
        false,
        'restoreHistory'
      )

      // Restore plots (OLE Copy/Paste - Phase 1.3)
      if (project.plots && project.plots.length > 0) {
        const { restorePlots, setActivePlot, setActiveStatisticsFamilyId } =
          usePlotsStore.getState()
        restorePlots(project.plots)
        if (project.activeStatisticsFamilyId) {
          setActiveStatisticsFamilyId(project.activeStatisticsFamilyId)
        }
        if (project.activePlotId) {
          setActivePlot(project.activePlotId)
        }
      }

      if (project.rnaseqState) {
        useRNAseqStore.getState().restoreFromProject(project.rnaseqState)
        // Repair any dangling dataset IDs (e.g., missing scaffold after save/reopen)
        await useRNAseqStore.getState().reconcileRestoredDatasets()
      } else {
        await useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
      }

      const rnaseqResultEntries = deserializeRNAseqResults(project.rnaseqResults)
      const rnaseqStore = useRNAseqStore.getState()
      for (const entry of rnaseqResultEntries) {
        const executedAt = new Date(entry.result.executedAt)
        const projectModels = rnaseqStore.getProject(entry.projectId)?.models ?? []

        // For legacy format, prioritize modelId from object key over embedded value
        // For new format, use embedded modelId
        const modelId = entry.modelId ?? entry.result.modelId ?? null

        // Warn if legacy format has mismatched modelIds
        if (entry.modelId && entry.result.modelId && entry.modelId !== entry.result.modelId) {
          console.warn(
            `[RNAseq] Model ID mismatch for result ${entry.result.id}: ` +
            `key="${entry.modelId}", embedded="${entry.result.modelId}". Using key value.`
          )
        }

        const modelName =
          (modelId ? projectModels.find((model) => model.id === modelId)?.name : null) ??
          'RNA-seq Model'

        // Check for ID uniqueness to prevent duplicates
        const existingIds = new Set(
          rnaseqStore.getProject(entry.projectId)?.results.map((r) => r.id) ?? []
        )
        const rawId = typeof entry.result.id === 'string' ? entry.result.id.trim() : ''
        let runId = rawId || null
        if (!runId || existingIds.has(runId)) {
          runId = `rnaseq_result_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
          if (rawId && existingIds.has(rawId)) {
            console.warn(
              `[RNAseq] Duplicate result ID "${rawId}" detected. Generated new ID: ${runId}`
            )
          }
        }

        const runLabel =
          entry.result.label && entry.result.label.trim().length > 0
            ? entry.result.label
            : `${modelName} - ${executedAt.toLocaleString()}`

        rnaseqStore.addResultRun(entry.projectId, {
          ...entry.result,
          id: runId,
          label: runLabel,
          modelId: modelId ?? entry.result.modelId ?? 'unknown',
          executedAt,
        }, { suppressDirty: true })
      }

      // Add to recent projects ONLY after successful restoration
      // (Rust load_project no longer auto-adds to prevent canceled/failed opens from updating recents)
      try {
        await tauriApi.addRecentProject(filePath, project.name)
        const list = await tauriApi.getRecentProjects()
        setRecentProjects(
          list.map(p => ({
            id: p.path,
            name: p.name,
            path: p.path,
            lastOpened: new Date(p.modifiedAt),
          }))
        )
      } catch (error) {
        console.warn('Failed to refresh recent projects after open:', error)
      }

      // Smart Save: remember opened project path (Part 1)
      // Note: Mark dirty if projectId was generated (legacy file migration)
      // This encourages users to re-save legacy files with the new projectId
      useAppStore.getState().setProjectFilePath(filePath)
      useAppStore.getState().setProjectDirty(generatedProjectId)

      // Fix #2: Notify user about legacy project migration
      if (generatedProjectId) {
        toast.success('Project opened', { id: toastId })
        toast.info(
          'This project was created with an older version. Please save to update the project format.',
          { duration: 6000 }
        )
      } else {
        toast.success('Project opened', { id: toastId })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(`Open failed: ${message}`, { id: toastId })
      await rollbackActiveProject()

      // Refresh recents to filter out any stale entries
      try {
        const list = await tauriApi.getRecentProjects()
        setRecentProjects(
          list.map(p => ({
            id: p.path,
            name: p.name,
            path: p.path,
            lastOpened: new Date(p.modifiedAt),
          }))
        )
      } catch {
        // Non-fatal
      }
    } finally {
      setLoadingOperation(null)
    }
  }, [
    addDataset,
    blockIfAppLocked,
    clearAllDataResultsAndPlots,
    setActiveFamilyDataset,
    setCurrentDataset,
    setLoadingOperation,
    setRecentProjects,
    restoreFamilies,
    updateActiveFamilyData,
    initializeBlankDataset,
    confirmOpenProject,
    normalizeAnalysisHistory,
    deserializeRNAseqResults,
  ])

  const handleOpenProject = useCallback(async () => {
    if (blockIfAppLocked('Open project')) return
    const filePath = await open({
      title: 'Open Project',
      multiple: false,
      filters: [{ name: 'easyCris Project', extensions: ['ecp'] }],
    })

    if (!filePath) return
    if (Array.isArray(filePath)) return

    await loadProjectFromPath(filePath)
  }, [blockIfAppLocked, loadProjectFromPath])

  // Register project handlers for keyboard shortcuts and close confirmation.
  useEffect(() => {
    setOpenProjectHandler(handleOpenProject)
    setSaveProjectHandler(handleSaveProject)
    setSaveProjectAsHandler(handleSaveProjectAs)
    return () => {
      setOpenProjectHandler(undefined)
      setSaveProjectHandler(undefined)
      setSaveProjectAsHandler(undefined)
    }
  }, [
    handleOpenProject,
    handleSaveProject,
    handleSaveProjectAs,
    setOpenProjectHandler,
    setSaveProjectAsHandler,
    setSaveProjectHandler,
  ])

  // Phase 0: Register project loader for E2E testing
  useEffect(() => {
    setProjectLoader(loadProjectFromPath)
  }, [loadProjectFromPath])

  // Open project when launched via file association (linked OLE, etc.)
  useEffect(() => {
    const unlisten = listen<string>('open-project-file', async (event) => {
      const filePath = event.payload
      if (!filePath) return
      await loadProjectFromPath(filePath)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [e2eEnabled, loadProjectFromPath])

  // Handle pending project path captured before frontend mounted (first-launch association)
  useEffect(() => {
    const loadPending = async () => {
      try {
        const pendingPath = await invoke<string | null>('take_pending_open_project')
        if (pendingPath) {
          await loadProjectFromPath(pendingPath)
        }
      } catch (error) {
        console.warn('Failed to read pending project path:', error)
      }
    }
    void loadPending()
  }, [e2eEnabled, loadProjectFromPath])

  const ensureNumericDVFirst = useCallback(
    (classifications: ColumnClassification[], testId: string): boolean => {
      if (!TESTS_REQUIRING_NUMERIC_DV.has(testId)) {
        return true
      }

      const numericIndex = classifications.findIndex((column) => {
        if (column.dataType === ColumnDataType.Numeric || column.dataType === ColumnDataType.Ordinal) {
          return true
        }
        // Allow numeric-coded binaries (all values numeric)
        if (
          column.dataType === ColumnDataType.Binary &&
          typeof column.numericValues === 'number' &&
          column.numericValues ===
            Math.max(
              0,
              ((column.numericValues ?? 0) + (column.categoricalValues ?? 0)) ||
                ((column.totalValues ?? 0) - (column.missingValues ?? 0))
            )
        ) {
          return true
        }
        // Allow mostly-numeric mixed columns
        if (
          column.dataType === ColumnDataType.Mixed &&
          (column.numericRatio ?? 0) >= TYPE_CLASSIFICATION_RULES.mixedRatioForNumericFallback
        ) {
          return true
        }
        return false
      })

      if (numericIndex === -1) {
        const name = getTestDefinition(testId)?.displayName ?? 'Selected test'
        toast.error(`${name} requires at least one numeric dependent variable`)
        return false
      }

      if (numericIndex > 0) {
        const [numericColumn] = classifications.splice(numericIndex, 1)
        classifications.unshift(numericColumn!)
      }

      return true
    },
    []
  )

  // Handle clear data
  const handleClearData = async () => {
    if (blockIfAppLocked('Clear data')) return
    if (blockIfPasteInFlight('Clear data')) return
    if (blockIfDatasetQueueNotReady('Clear data', currentDataset?.id)) return
    const activeFamilyId = useAppStore.getState().activeFamilyId ?? 'statistics-1'
    logAppDebug('clear_data_start', {
      activeFamilyId,
      currentDatasetId: currentDataset?.id ?? null,
    })
    const proceedWithPlots = await confirmClearPlotsIfNeeded(activeFamilyId)
    if (!proceedWithPlots) {
      logAppDebug('clear_data_cancelled', { activeFamilyId })
      return
    }

    const datasetId = currentDataset?.id
    if (blockIfDatasetQueueNotReady('Clear data', datasetId)) return

    const usedByOtherFamilies = datasetId
      ? families.some((family) => family.datasetId === datasetId && family.id !== activeFamilyId)
      : false
    const usedByRNAseq = datasetId ? rnaseqDatasetIds.has(datasetId) : false
    logAppDebug('clear_data_dataset_usage', {
      datasetId: datasetId ?? null,
      usedByOtherFamilies,
      usedByRNAseq,
    })

    useResultsStore.getState().clearResults({ suppressDirty: true })
    usePlotsStore.getState().clearStatisticsFamilyPlots(activeFamilyId, { suppressDirty: true })
    toast.success('Dataset cleared')

    // Reset active family flags (remove green dots, disable Results/Plots)
    const activeFamily = useAppStore.getState().getActiveFamily()
    if (activeFamily) {
      useAppStore.getState().updateActiveFamilyResults(false)
    }

    // Smart Save: reset project path for new unsaved project (Part 1)
    useAppStore.getState().setProjectFilePath(null)
    useAppStore.getState().setProjectDirty(false)

    // Immediately provision a fresh blank spreadsheet and bind it to the active family
    try {
      const blankDataset = await initializeBlankDataset('Spreadsheet', { activate: false })
      logAppDebug('clear_data_blank_dataset_created', {
        blankDatasetId: blankDataset.id,
        activeFamilyId: activeFamily?.id ?? null,
      })
      const cleanupDatasetId =
        datasetId && !usedByOtherFamilies && !usedByRNAseq ? datasetId : null
      deferredDatasetCleanupRef.current = cleanupDatasetId
        ? {
            nextDatasetId: blankDataset.id,
            cleanupDatasetId,
          }
        : null
      const token = pendingGridSurfaceActivationTokenRef.current + 1
      pendingGridSurfaceActivationTokenRef.current = token
      if (currentDataset?.id) {
        setDisplayDatasetId(currentDataset.id)
      }
      setPendingGridSurfaceActivation({
        familyId: activeFamily?.id ?? activeFamilyId,
        datasetId: blankDataset.id,
        token,
        status: 'staging',
        kind: 'family-activation',
        cleanupDatasetId,
      })
      if (activeFamily) {
        setActiveFamilyDataset(activeFamily.id, blankDataset.id, false)
      } else {
        updateActiveFamilyData(blankDataset.id)
      }
    } catch (error) {
      console.error('Failed to initialize blank dataset after clear:', error)
      logAppDebug('clear_data_blank_dataset_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error('Failed to initialize blank dataset after clear')
    }

    // TODO: Add confirmation dialog
  }
  return (
    <>
      <Toaster position="bottom-right" />
      {legalGateEnabled && !legalGateReady && (
        <div aria-hidden="true" className="fixed inset-0 z-[9999] bg-background" />
      )}
      <div
        className="contents"
        {...(legalGateEnabled && !legalGateReady ? { inert: '' } : {})}
      >
      {!legalGateBlocking && <CommandPalette />}
        <PreferencesDialog />
        <RemoteInviteDialog />
        <DeviceLinkDialog />
        {!isFirstLaunchLoading && !legalGateBlocking && (
          <WelcomeScreen
            open={shouldShowWelcomeScreen({ isFirstLaunch, linkDialogOpen })}
            onComplete={markWelcomeSeen}
            onLinkDevice={() => setLinkDialogOpen(true)}
            onCreateProject={handleNewProject}
            onImportData={handleImportData}
            onBrowseExamples={handleBrowseExamples}
            onContinueAsGuest={() => undefined}
          />
        )}
      {legalGateEnabled && legalGateReady && (
        <AlertDialog open={legalGateOpen} onOpenChange={() => {}}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Review Legal Documents</AlertDialogTitle>
              <AlertDialogDescription>
                {legalGateRequiresReconsent
                  ? `Legal terms were updated. Please review and accept the updated document(s): ${changedDocLabels}.`
                  : 'This version requires legal acceptance before you continue. Review the License Terms and Privacy Policy below.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-3 text-xs text-muted-foreground">
              <p>Policy version: {LEGAL_POLICY_VERSION}</p>
              {legalGateHashes ? (
                <div className="space-y-1 font-mono">
                  <p>License Terms hash: {shortHash(legalGateHashes.eula)}</p>
                  <p>Privacy hash: {shortHash(legalGateHashes.privacy)}</p>
                </div>
              ) : (
                <p>{legalGateLoading ? 'Verification in progressâ€¦' : 'Legal hashes unavailable.'}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {visibleLegalDocs.map((docKey) => (
                  <button
                    key={docKey}
                    type="button"
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors',
                      selectedLegalDoc === docKey
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/40'
                    )}
                    onClick={() => {
                      setSelectedLegalDoc(docKey)
                      setLegalPreviewExpanded(false)
                    }}
                  >
                    {LEGAL_DOC_LABELS[docKey].replace(' Policy', '')}
                  </button>
                ))}
              </div>
              <div className="rounded-md border bg-muted/20 p-2">
                <p className="mb-1 text-[11px] font-medium text-foreground">{selectedLegalDocLabel}</p>
                {selectedLegalText ? (
                  <>
                    <textarea
                      readOnly
                      wrap="off"
                      spellCheck={false}
                      value={legalDocDisplayText}
                      className="h-36 w-full resize-none overflow-auto bg-transparent text-[11px] font-mono leading-relaxed outline-none"
                    />
                    {legalDocIsLarge && !legalPreviewExpanded && (
                      <p className="mt-1 text-[10px]">
                        Previewing first {legalDocPreviewSizeKb} KB of {legalDocTotalSizeKb} KB.
                        {' '}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setLegalPreviewExpanded(true)}
                        >
                          Show full text
                        </button>
                        .
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px]">{legalGateLoading ? 'Loading documentâ€¦' : 'Document unavailable.'}</p>
                )}
              </div>
              {legalGateError && <p className="text-destructive">{legalGateError}</p>}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleLegalDecline}>
                Exit App
              </AlertDialogCancel>
              {legalGateError && (
                <AlertDialogAction onClick={handleLegalRetry}>
                  Retry
                </AlertDialogAction>
              )}
              <AlertDialogAction
                onClick={handleLegalAccept}
                disabled={legalGateLoading || !legalGateHashes}
              >
                I Accept and Continue
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
        <StatisticalTestsGuideDialog
          open={cheatsheetOpen}
          onOpenChange={setCheatsheetOpen}
          onOpenSampleDatasets={handleOpenSampleDatasets}
          onRunTest={handleRunTestFromGuide}
        />
        <DataCleaningGuideDialog
          open={dataCleaningGuideOpen}
          onOpenChange={setDataCleaningGuideOpen}
          onOpenTool={handleDataCleaningOpenTool}
        />
        <BulkRNAseqGuideDialog
          open={rnaseqGuideOpen}
          onOpenChange={setRnaseqGuideOpen}
          onImportSample={handleImportRNAseqSample}
          onOpenConfigure={handleOpenRNAseqConfigureFromGuide}
        />
        <SampleDatasetsDialog
          open={sampleDatasetsOpen}
          onOpenChange={handleSampleDatasetsOpenChange}
          onImportDataset={handleImportSampleDataset}
          initialSearch={sampleDatasetsSearch}
          pendingTestName={pendingGuideTestId ? getTestDefinition(pendingGuideTestId)?.displayName : undefined}
        />
      <BottomLeftTip />
      <div data-testid="app-loaded" className={cn('flex flex-col h-[var(--app-height)] w-[var(--app-width)] bg-background', className)}>
        <RemoteSessionBanner />
        <RemoteGuestViewerOverlay />
        {/* Ribbon Toolbar */}
      <Toolbar
        onNewProject={handleNewProject}
        onOpenProject={handleOpenProject}
        onSaveProject={handleSaveProject}
        onSaveProjectAs={handleSaveProjectAs}
        onClearCurrentProjectCache={handleClearCurrentProjectCache}
        onClearUnsavedAppCache={handleClearUnsavedAppCache}
        onClearAllCache={handleClearAllAppCache}
        cacheHealthSummary={lastCacheHealthSummary}
        viewAttentionPulseToken={viewAttentionPulseToken}
        onImportData={handleImportData}
        onSort={handleSort}
        hasData={toolbarHasData}
        onPivotWider={handlePivotWider}
        onPivotLonger={handlePivotLonger}
        onGroupAggregate={handleGroupAggregate}
        onAdvancedFilter={handleAdvancedFilter}
        onUndoTransform={handleUndoTransform}
        canUndoTransform={canUndoTransform}
        onRunAnalysis={handleRunAnalysis}
      />

      {/* Main Content Area (Navigator + Workspace) */}
      <div className="flex-1 overflow-hidden" ref={mainContentRef}>
        <PanelGroup direction="horizontal">
          {/* Navigator Panel - always rendered, collapsible */}
          <Panel
            ref={navigatorPanelRef}
            defaultSize={20}
            minSize={0}
            maxSize={35}
            collapsible
            collapsedSize={0}
            className="bg-background"
            onCollapse={() => setShowNavigator(false)}
            onExpand={() => setShowNavigator(true)}
          >
            <NavigatorPanel
              onOpenRecentProject={loadProjectFromPath}
              isRNAseqActive={Boolean(activeRNAseqProject)}
              interactionLocked={appOperationLock.active}
              pasteInProgress={pasteInProgress}
            />
          </Panel>

          <PanelResizeHandle className="w-1 bg-border hover:bg-accent transition-colors" />

          {/* Workspace Panel */}
          <Panel defaultSize={80} minSize={0}>
            {/* RNA-seq Workspace - shown when RNA-seq project is active */}
            {activeRNAseqProject ? (
              <RNAseqWorkspace
                className="h-full"
                onCopyRequest={(copy) => {
                  copyRef.current = copy
                }}
                onCutRequest={(cut) => {
                  cutRef.current = cut
                }}
                onPasteRequest={(paste) => {
                  pasteRef.current = paste
                }}
                onUndoRequest={(undo) => {
                  undoRef.current = undo
                }}
                onRedoRequest={(redo) => {
                  redoRef.current = redo
                }}
              />
            ) : (
              <div className="h-full flex flex-col bg-background min-w-0">
                {/* Action Toolbar - inside workspace for proper alignment */}
                  <ActionToolbar
                    workspaceViewMode={workspaceViewMode}
                    hasDataRows={toolbarHasData}
                    onImportData={handleImportData}
                    onBrowseExamples={handleBrowseExamples}
                    onOpenCheatsheet={handleOpenCheatsheet}
                    onOpenDataCleaningGuide={handleOpenDataCleaningGuide}
                    onOpenRNAseqGuide={handleOpenRNAseqGuide}
                    onImportRNAseqSample={handleImportRNAseqSample}
                    onPerformTest={handleRunAnalysis}
                  onSort={handleSort}
                  onFilter={(bounds) => void handleOpenFilterPicker(bounds)}
                  onClearData={handleClearData}
                  onCopy={() => copyRef.current?.()}
                  onCut={() => cutRef.current?.()}
                  onPaste={() => pasteRef.current?.()}
                  onUndo={() => undoRef.current?.()}
                  onRedo={() => redoRef.current?.()}
                  onInsertMenu={handleToolbarInsertMenu}
                />

                {/* Phase 3: Column picker popover â€” controlled by AppShell, triggered by Filter button */}
                <FilterColumnPickerPopover
                  open={pickerOpen}
                  onOpenChange={setPickerOpen}
                  columns={pickerColumns}
                  viewFilterConfig={pickerViewFilterConfig}
                  anchorBounds={pickerAnchorBounds}
                  canUndoFilter={canUndoFilter}
                  onUndoFilter={() => filterUndoRef.current?.() ?? false}
                  onClearFilter={() => { filterClearRef.current?.(); setPickerOpen(false) }}
                  onSelectColumn={(colId, bounds) => {
                    openColumnFilterRef.current?.(colId, bounds)
                  }}
                />

                {/* Workspace Content based on view mode */}
                {(workspaceViewMode === 'data' || keepDataViewMounted) && (
                  <div
                    className={cn(
                      'flex-1 overflow-hidden',
                      workspaceViewMode !== 'data' && keepDataViewMounted && 'hidden'
                    )}
                  >
                    <SpreadsheetView
                      height="100%"
                      width="100%"
                      datasetId={displayDatasetId ?? activeDataset?.id}
                      pendingDatasetId={pendingGridSurfaceActivation?.datasetId}
                      pendingDatasetToken={pendingGridSurfaceActivation?.token}
                      onPendingSurfaceReady={handlePendingSurfaceReady}
                      enableExcelViewFilter
                      onSortDialogRequest={(open) => {
                        openSortDialogRef.current = open
                      }}
                      onGroupDialogRequest={(open) => {
                        openGroupDialogRef.current = open
                      }}
                      onColumnFilterRequest={(openFn) => {
                        openColumnFilterRef.current = openFn
                      }}
                      onViewFilterChange={(config) => {
                        setPickerViewFilterConfig(config)
                      }}
                      onViewScopeChange={setGridViewScope}
                      onFilterUndoRequest={(fn) => { filterUndoRef.current = fn }}
                      onFilterClearRequest={(fn) => { filterClearRef.current = fn }}
                      onFilterUndoStateChange={(canUndo) => setCanUndoFilter(canUndo)}
                      onRequireDataRows={(toolName) => !blockIfNoDataRows(toolName)}
                      onBeforeViewFilterDialogOpen={async () => {
                        const dataset = activeDataset
                        if (!dataset) return { kind: 'abort' as const }
                        if (blockIfNoDataRows('Filter', dataset)) return { kind: 'abort' as const }
                        const capturedId = dataset.id
                        try {
                          await cacheService.ensureLatestCache(dataset.id)
                          if (activeDatasetIdForPickerRef.current !== capturedId) return { kind: 'abort' as const }
                          const sample = await loadSampleRows(dataset)
                          if (activeDatasetIdForPickerRef.current !== capturedId) return { kind: 'abort' as const }
                          const columns = await getColumnsWithData(
                            dataset,
                            sample.resolution.columns,
                            'view filter dialog setup',
                            { hideEmptyColumns: true }
                          )
                          if (activeDatasetIdForPickerRef.current !== capturedId) return { kind: 'abort' as const }
                          return { kind: 'ready' as const, columns, data: sample.rows }
                        } catch (err) {
                          console.error('[AppShell] Failed to prepare view filter dialog:', err)
                          return { kind: 'fallback' as const }
                        }
                      }}
                      onCopyRequest={(copy) => {
                        copyRef.current = copy
                      }}
                      onCutRequest={(cut) => {
                        cutRef.current = cut
                      }}
                      onPasteRequest={(paste) => {
                        pasteRef.current = paste
                      }}
                      onUndoRequest={(undo) => {
                        undoRef.current = undo
                      }}
                      onRedoRequest={(redo) => {
                        redoRef.current = redo
                      }}
                      onInsertMenuRequest={handleInsertMenuRegistration}
                    />
                  </div>
                )}

                {workspaceViewMode === 'results' && (
                  <div className="flex-1 overflow-hidden">
                    <ResultsPanel className="h-full" />
                  </div>
                )}

                {workspaceViewMode === 'plots' && (
                  <div className="flex-1 overflow-hidden">
                    <PlotsPanel className="h-full" />
                  </div>
                )}
              </div>
            )}
          </Panel>
        </PanelGroup>
      </div>

      {/* Status Bar */}
      <StatusBar />
      {showBlockingAppBusyOverlay && <AppBusyOverlay lock={appOperationLock} />}

      {/* Test Selection Dialog */}
      <TestSelectionDialog
        open={testDialogOpen}
        onOpenChange={setTestDialogOpen}
        onConfirm={() => {
          // Test is set in analysis-store by StatisticalTestsNav
          // Close test selection and open column selection
          setTestDialogOpen(false)
          setColumnDialogOpen(true)
        }}
      />

        {/* Column Selection Dialog */}
        <ColumnSelectionDialog
          isOpen={columnDialogOpen}
          onClose={() => setColumnDialogOpen(false)}
          onSelect={handleTestExecution}
          viewScope={gridViewScope?.datasetId === activeDataset?.id ? gridViewScope : null}
          title={selectedTest ? `Select Columns for ${selectedTest.name}` : 'Select Columns'}
          mode={
            selectedTest &&
            getRegistryColumnCount(selectedTest.id) === 2 &&
            !(getTestDefinition(selectedTest.id)?.requiredDataFields?.some((field) => field.multiple)) &&
            getTestDefinition(selectedTest.id)?.family !== 'survival'
              ? 'paired'
              : 'multiple'
          }
        />

        <PivotWiderDialog
          open={showPivotWiderDialog}
          onOpenChange={setShowPivotWiderDialog}
          columnMetadata={transformColumns.length > 0 ? transformColumns : activeDataset?.columns ?? []}
          sampleData={transformSampleData}
          onApply={handleApplyPivotWider}
          initialConfig={transformUiState.pivotWider ?? null}
        />

        <PivotLongerDialog
          open={showPivotLongerDialog}
          onOpenChange={setShowPivotLongerDialog}
          columnMetadata={transformColumns.length > 0 ? transformColumns : activeDataset?.columns ?? []}
          onApply={handleApplyPivotLonger}
          initialConfig={transformUiState.pivotLonger ?? null}
        />

        <GroupAggregateDialog
          open={showGroupAggregateDialog}
          onOpenChange={setShowGroupAggregateDialog}
          columnMetadata={transformColumns.length > 0 ? transformColumns : activeDataset?.columns ?? []}
          onApply={handleApplyGroupAggregate}
          initialConfig={transformUiState.groupAggregate ?? null}
        />

        <AdvancedFilterDialog
          open={showAdvancedFilterDialog}
          onOpenChange={setShowAdvancedFilterDialog}
          columnMetadata={transformColumns.length > 0 ? transformColumns : activeDataset?.columns ?? []}
          data={transformSampleData}
          totalRowCount={transformDataset?.dataRowCount ?? transformDataset?.rowCount ?? activeDataset?.dataRowCount ?? activeDataset?.rowCount}
          getColumnUniqueValues={transformDataset || activeDataset ? handleLoadAdvancedFilterColumnValues : undefined}
          getFilterMatchCount={transformDataset || activeDataset ? handleGetAdvancedFilterMatchCount : undefined}
          onApply={handleApplyAdvancedFilter}
          initialConfig={transformUiState.filter ?? null}
        />

        <TransformWarningDialog
          open={showTransformWarning}
          transformType={pendingTransform?.type ?? 'pivot_wider'}
          onConfirm={(mode) => applyPendingTransform(mode)}
          onCancel={() => {
            setShowTransformWarning(false)
            setPendingTransform(null)
          }}
          disableNewFamily={isRNAseqDataset}
          disableNewFamilyReason={
            isRNAseqDataset ? 'RNA-seq datasets can only be transformed in place.' : undefined
          }
        />

        <AlertDialog
          open={emptyDataPromptTool !== null}
          onOpenChange={(open) => {
            if (!open) setEmptyDataPromptTool(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Enter or import data first</AlertDialogTitle>
              <AlertDialogDescription>
                The {emptyDataPromptTool ?? 'selected'} tool needs data rows to work. Type into the grid, paste data, or import a file first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setEmptyDataPromptTool(null)}>
                Got it
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setEmptyDataPromptTool(null)
                  handleImportData()
                }}
              >
                Import data
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={cacheHealthDialog !== null}
          onOpenChange={(open) => {
            if (!open) setCacheHealthDialog(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{cacheHealthDialog?.title ?? 'Storage check'}</AlertDialogTitle>
              <AlertDialogDescription>
                {cacheHealthDialog?.description ?? ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={handleCacheHealthDialogClear}>
                Clear Unsaved/AppData
              </Button>
              <Button variant="outline" onClick={handleCacheHealthDialogSuppressDays}>
                {`Don't show ${cacheHealthConfig.suppressDays} days`}
              </Button>
              <Button variant="ghost" onClick={handleCacheHealthDialogSuppressForever}>
                Don't show again
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Preflight Confirmation Dialog */}
        <AlertDialog open={preflightConfirm !== null} onOpenChange={(open) => { if (!open) handlePreflightConfirmResponse(false) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Large Dataset</AlertDialogTitle>
              <AlertDialogDescription>
                {preflightConfirm?.message}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => handlePreflightConfirmResponse(false)}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => handlePreflightConfirmResponse(true)}>
                Continue
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Phase 0: Validation Error Dialog */}
        <ValidationErrorDialog
          open={validationError !== null}
          validation={validationError?.result ?? null}
          testName={validationError?.testName ?? ''}
          onClose={() => setValidationError(null)}
        />

        {/* Phase 1A+1B: Orchestration Dialogs */}
        <DependentVariableDialog
          open={dialogState.showDVSelection}
          onOpenChange={(open) => { if (!open) handleDVSelectionCancel() }}
          columns={dvDialogData.columns}
          mode={dvDialogData.mode}
          onConfirm={(selectedVariable) => {
            handleDVSelectionConfirm({ selectedVariable, cancelled: false })
          }}
          onCancel={handleDVSelectionCancel}
        />

        <DependentVariableEncodingDialog
          open={dialogState.showDVEncoding}
          onOpenChange={(open) => { if (!open) handleDVEncodingCancel() }}
          columnName={dvEncodingDialogData.columnName}
          categories={dvEncodingDialogData.categories}
          testType={dvEncodingDialogData.testType}
          onConfirm={(encodingMapping) => {
            handleDVEncodingConfirm({ encodingMapping, cancelled: false })
          }}
          onCancel={handleDVEncodingCancel}
        />

        <FactorEncodingDialog
          open={dialogState.showFactorEncoding}
          onOpenChange={(open) => { if (!open) handleFactorEncodingCancel() }}
          factors={factorEncodingDialogData.factors}
          onConfirm={(result) => {
            handleFactorEncodingConfirm({ ...result, cancelled: false })
          }}
          onCancel={handleFactorEncodingCancel}
        />

        <TwoWayFactorMappingDialog
          open={dialogState.showTwoWayFactorMapper}
          columns={factorMappingColumns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
          }))}
          onConfirm={(mapping) => {
            handleTwoWayFactorMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleTwoWayFactorMapperCancel}
        />

        <MultifactorialFactorMappingDialog
          open={dialogState.showMultifactorialFactorMapper}
          columns={factorMappingColumns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
          }))}
          onConfirm={(mapping) => {
            handleMultifactorialFactorMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleMultifactorialFactorMapperCancel}
        />

        <SimpleEffectsDialog
          open={dialogState.showSimpleEffects}
          onOpenChange={(open) => { if (!open) handleSimpleEffectsCancel() }}
          factor1Name={simpleEffectsDialogData.factor1Name}
          factor2Name={simpleEffectsDialogData.factor2Name}
          factor1Levels={simpleEffectsDialogData.factor1Levels}
          factor2Levels={simpleEffectsDialogData.factor2Levels}
          onConfirm={(result) => {
            handleSimpleEffectsConfirm({ ...result, cancelled: false })
          }}
          onCancel={handleSimpleEffectsCancel}
        />

        {dialogState.multiFactorialSimpleEffectsTestIdPrefix === 'lmm' ? (
          <LmmSimpleEffectsDialog
            open={dialogState.showMultiFactorialSimpleEffects}
            onOpenChange={(open) => { if (!open) handleMultiFactorialSimpleEffectsCancel() }}
            factorNames={multiFactorialSimpleEffectsDialogData.factorNames}
            factorLevels={multiFactorialSimpleEffectsDialogData.factorLevels}
            testIdPrefix="lmm"
            onConfirm={(result) => {
              handleMultiFactorialSimpleEffectsConfirm({ ...result, cancelled: false })
            }}
            onCancel={handleMultiFactorialSimpleEffectsCancel}
          />
        ) : (
          <MultiFactorialSimpleEffectsDialog
            open={dialogState.showMultiFactorialSimpleEffects}
            onOpenChange={(open) => { if (!open) handleMultiFactorialSimpleEffectsCancel() }}
            factorNames={multiFactorialSimpleEffectsDialogData.factorNames}
            factorLevels={multiFactorialSimpleEffectsDialogData.factorLevels}
            testIdPrefix={dialogState.multiFactorialSimpleEffectsTestIdPrefix}
            showAdjustmentControls
            onConfirm={(result) => {
              handleMultiFactorialSimpleEffectsConfirm({ ...result, cancelled: false })
            }}
            onCancel={handleMultiFactorialSimpleEffectsCancel}
          />
        )}

        <LmmAnovaConfigDialog
          open={dialogState.showLmmAnovaConfig}
          columns={dialogContext.columns}
          onConfirm={handleLmmAnovaConfigConfirm}
          onCancel={handleLmmAnovaConfigCancel}
        />

        <DoseResponseColumnMapperDialog
          open={dialogState.showDoseResponseColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
          }))}
          testName={dialogState.doseResponseMapperTestName}
          onConfirm={(mapping) => {
            handleDoseResponseColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleDoseResponseColumnMapperCancel}
        />

        <SynergyColumnMapperDialog
          open={dialogState.showSynergyColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
          }))}
          testName={dialogState.synergyMapperTestName}
          onConfirm={(mapping) => {
            handleSynergyColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleSynergyColumnMapperCancel}
        />

        <ChiSquareGofColumnMapperDialog
          open={dialogState.showChiSquareGofColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
          }))}
          testName={dialogState.chiSquareGofMapperTestName}
          onConfirm={(mapping) => {
            handleChiSquareGofColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleChiSquareGofColumnMapperCancel}
        />

        <ChiSquareColumnMapperDialog
          open={dialogState.showChiSquareColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
          }))}
          testName={dialogState.chiSquareMapperTestName}
          onConfirm={(mapping) => {
            handleChiSquareColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleChiSquareColumnMapperCancel}
        />

        <FisherExactColumnMapperDialog
          open={dialogState.showFisherExactColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
          }))}
          testName={dialogState.fisherExactMapperTestName}
          onConfirm={(mapping) => {
            handleFisherExactColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleFisherExactColumnMapperCancel}
        />

        <McNemarColumnMapperDialog
          open={dialogState.showMcNemarColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
          }))}
          testName={dialogState.mcnemarMapperTestName}
          onConfirm={(mapping) => {
            handleMcNemarColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleMcNemarColumnMapperCancel}
        />

        <IndependentTTestColumnMapperDialog
          open={dialogState.showIndependentTTestColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
            uniqueValueCount: col.uniqueValueCount,
          }))}
          testName={dialogState.independentTTestMapperTestName}
          onConfirm={(mapping) => {
            handleIndependentTTestColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleIndependentTTestColumnMapperCancel}
        />

        <MannWhitneyColumnMapperDialog
          open={dialogState.showMannWhitneyColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
            uniqueValueCount: col.uniqueValueCount,
          }))}
          testName={dialogState.mannWhitneyMapperTestName}
          onConfirm={(mapping) => {
            handleMannWhitneyColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleMannWhitneyColumnMapperCancel}
        />

        <PairedTTestColumnMapperDialog
          open={dialogState.showPairedTTestColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
            uniqueValueCount: col.uniqueValueCount,
          }))}
          testName={dialogState.pairedTTestMapperTestName}
          onConfirm={(mapping) => {
            handlePairedTTestColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handlePairedTTestColumnMapperCancel}
        />

        <WilcoxonColumnMapperDialog
          open={dialogState.showWilcoxonColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
            uniqueValueCount: col.uniqueValueCount,
          }))}
          testName={dialogState.wilcoxonMapperTestName}
          onConfirm={(mapping) => {
            handleWilcoxonColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleWilcoxonColumnMapperCancel}
        />

        <OneWayAnovaColumnMapperDialog
          open={dialogState.showOneWayAnovaColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
            uniqueValueCount: col.uniqueValueCount,
            uniqueValues: col.uniqueValues,
          }))}
          testName={dialogState.oneWayAnovaMapperTestName}
          groupLevels={dialogState.oneWayAnovaGroupLevels}
          onConfirm={(mapping) => {
            handleOneWayAnovaColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleOneWayAnovaColumnMapperCancel}
        />

        <KruskalWallisColumnMapperDialog
          open={dialogState.showKruskalWallisColumnMapper}
          columns={dialogContext.columns.map((col) => ({
            columnName: col.columnName,
            columnId: col.columnId || col.columnName,
            dataType: col.dataType,
            uniqueValueCount: col.uniqueValueCount,
          }))}
          testName={dialogState.kruskalWallisMapperTestName}
          onConfirm={(mapping) => {
            handleKruskalWallisColumnMapperConfirm({ mapping, cancelled: false })
          }}
          onCancel={handleKruskalWallisColumnMapperCancel}
        />

        <SurvivalAnalysisDialog
          isOpen={dialogState.showSurvivalAnalysisDialog}
          onClose={handleSurvivalAnalysisCancel}
          onConfirm={handleSurvivalAnalysisConfirm}
          columns={dialogContext.columns}
          analysisType={dialogState.survivalAnalysisType}
        />

        <MediationAnalysisDialog
          isOpen={dialogState.showMediationAnalysisDialog}
          onClose={handleMediationAnalysisCancel}
          onConfirm={handleMediationAnalysisConfirm}
          columns={dialogContext.columns}
        />

        <ModerationAnalysisDialog
          isOpen={dialogState.showModerationAnalysisDialog}
          onClose={handleModerationAnalysisCancel}
          onConfirm={handleModerationAnalysisConfirm}
          columns={dialogContext.columns}
        />

        <ModeratedMediationDialog
          isOpen={dialogState.showModeratedMediationAnalysisDialog}
          onClose={handleModeratedMediationAnalysisCancel}
          onConfirm={handleModeratedMediationAnalysisConfirm}
          columns={dialogContext.columns}
        />

        <ConfirmDialog
          open={dialogState.showConfirmDialog}
          title={dialogState.confirmDialogTitle}
          message={dialogState.confirmDialogMessage}
          confirmLabel={dialogState.confirmDialogConfirmLabel}
          cancelLabel={dialogState.confirmDialogCancelLabel}
          onConfirm={handleConfirmDialogConfirm}
          onCancel={handleConfirmDialogCancel}
        />

        {/* Phase 2: Execution mode selection for large datasets */}
        <ExecutionModeDialog
          open={dialogState.showExecutionModeDialog}
          testName={dialogState.executionModeTestName}
          rowCount={dialogState.executionModeRowCount}
          onSelect={(mode) => {
            handleExecutionModeSelect({ mode: mode === 'cancel' ? null : mode })
          }}
        />

        {/* Phase 8 + Phase 2: Large dataset source file recovery dialog */}
        <RelinkSourceDialog
          isOpen={relinkDialogState?.isOpen ?? false}
          datasetName={relinkDialogState?.datasetName ?? ''}
          originalPath={relinkDialogState?.originalPath ?? ''}
          reason={relinkDialogState?.reason ?? 'missing'}
          duckdbPath={relinkDialogState?.duckdbPath}
          sourcePath={relinkDialogState?.sourcePath}
          onRelink={(newPath, fileType) => {
            // Handle source file relinking (Phase 2 Fix: pass fileType through)
            console.log(`Relinking ${fileType || 'source'} file to: ${newPath}`)
            const action = fileType === 'duckdb' ? 'relink-duckdb' : 'relink'
            relinkResolverRef.current?.resolve({ action, newPath, fileType })
          }}
          onRelinkDuckDB={(newPath) => {
            // Handle DuckDB file relinking (Phase 2)
            relinkResolverRef.current?.resolve({ action: 'relink-duckdb', newPath })
          }}
          onUseFallback={() => {
            // Use source file when DuckDB is missing (Phase 2)
            relinkResolverRef.current?.resolve({ action: 'use-fallback' })
          }}
          onReimport={() => {
            // Re-import uses the original path (for 'modified' reason)
            relinkResolverRef.current?.resolve({
              action: 'relink',
              newPath: relinkDialogState?.originalPath,
            })
          }}
          onSkip={() => {
            relinkResolverRef.current?.resolve({ action: 'skip' })
          }}
          onCancel={() => {
            relinkResolverRef.current?.resolve({ action: 'cancel' })
          }}
        />

        {/* Import progress dialog for large dataset imports */}
        <ImportProgressDialog
          isOpen={importProgressState?.isOpen ?? false}
          datasetId={importProgressState?.datasetId ?? ''}
          percentage={importProgressState?.percentage ?? 0}
          message={importProgressState?.message ?? ''}
        />

        {/* OLE integration first-launch prompt (Windows only) */}
      </div>
      </div>
    </>
  )
}

export default AppShell



