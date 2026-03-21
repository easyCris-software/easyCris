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
import { useDataStore, type ColumnMetadata, type Dataset } from '@/store/data-store'
import { usePlotsStore } from '@/store/plots-store'
import { useResultsStore } from '@/store/results-store'
import { useRNAseqStore } from '@/store/rnaseq-store'
import { useUIStore } from '@/store/ui-store'
import tauriApi from '@/services/tauriApi'
import exportService from '@/services/exportService'
import rnaseqService from '@/services/rnaseqService'
import { exportPlotWithKaleido } from '@/services/plotExportService'
import { applyAxisDefaultsForExport, shouldIncludeAxisOverlay } from '@/utils/plotExportUtils'
import {
  clearDeviceAuthState,
  getDeviceAuthSnapshot,
  setFirstLaunchState,
  type E2EDeviceAuthSnapshot,
} from '@/utils/e2eAuthHooks'
import { exists, mkdir, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { dirname } from '@tauri-apps/api/path'

const MIN_COLUMNS = 100
const MIN_ROWS = 100
const ROW_BUFFER = 50
const DEFAULT_COLUMN_WIDTH = 88

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

// Primary gate: explicit E2E mode.
// Backward compatibility: honor legacy VITE_E2E_ENABLED if present.
const e2eEnabled = import.meta.env.MODE === 'e2e' || import.meta.env.VITE_E2E_ENABLED === 'true'

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
      const appStore = useAppStore.getState()
      useDataStore.getState().clearAllDatasets()
      useResultsStore.getState().clearAllResults({ suppressDirty: true })
      usePlotsStore.getState().clearPlots({ suppressDirty: true })
      useAnalysisStore.getState().clearHistory({ suppressDirty: true })
      useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
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
        families: app.families.map((family) => ({
          id: family.id,
          name: family.name,
          datasetId: family.datasetId ?? null,
          hasData: family.hasData,
          hasResults: family.hasResults,
        })),
      }
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

    /**
     * Clear all RNA-seq projects
     */
    async clearAllRNAseq(): Promise<void> {
      console.log('[E2E] Clearing all RNA-seq projects')
      useRNAseqStore.getState().clearAllProjects({ suppressDirty: true })
      console.log('[E2E] RNA-seq projects cleared')
    },

    /**
     * Import CSV file
     * @param csvPath - Absolute path to CSV file
     */
    async importCSV(csvPath: string): Promise<string> {
      console.log(`[E2E] Importing CSV: ${csvPath}`)
      await ensureProjectId()

      const result = await tauriApi.importCsv(csvPath)

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
        appStore.setActiveFamilyDataset(appStore.activeFamilyId, dataset.id, true)
      } else {
        appStore.updateActiveFamilyData(dataset.id)
      }

      console.log(`[E2E] CSV imported: ${csvPath} (datasetId=${dataset.id})`)
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
     * Create a new RNA-seq project and return its ID.
     */
    async createRNAseqProject(name: string): Promise<string> {
      const project = useRNAseqStore.getState().createProject(name)
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
      store.setCountsDataset(projectId, countsDatasetId)
      store.setMetadataDataset(projectId, metadataDatasetId)
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
      const countsDataset = datasets.find((d) => d.id === project.countsDatasetId)
      const metadataDataset = datasets.find((d) => d.id === project.metadataDatasetId)
      if (!countsDataset || !metadataDataset) {
        throw new Error('RNA-seq datasets are not linked')
      }

      rnaseqStore.addModel(projectId, model)
      rnaseqStore.setActiveModel(projectId, model.id)
      rnaseqStore.setActiveProject(projectId)

      const result = await rnaseqService.runDESeq2Analysis(countsDataset, metadataDataset, model)

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
          ? rnaseqStore.getResult(projectId, rnaseqStore.getProject(projectId)!.activeResultId!)
          : null)

      if (!run) {
        throw new Error('RNA-seq result not found for export')
      }

      const rows = run.genes.map((gene) => ({
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
        (targetPlotId ? plots.find((entry) => entry.id === targetPlotId) : null) ??
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
        throw new Error('Batch interpolation results are not available for export')
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
        const statusRaw = typeof rowData?.status === 'string' ? rowData.status : 'invalid_input'
        const status = statusRaw === 'stability_guardrail' ? 'guardrail' : statusRaw
        const extrapolatedValue =
          rowData?.extrapolated === true || rowData?.extrapolated === 'true'
        const message =
          typeof rowData?.message === 'string' && rowData.message.trim().length > 0
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

      const columns = ['row', 'input', 'output', 'status', 'extrapolated', 'message']
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
        (document.querySelector('.rnaseq-plot [data-plot-stats]') as HTMLElement | null) ??
        (document.querySelector('[data-plot-stats]') as HTMLElement | null)

      const plotTypeFromDom = plotStatsNode?.getAttribute('data-plot-type') ?? null
      // Fall back to store if the DOM isn't mounted yet.
      const plotType = (plotTypeFromDom || project.activePlotType || 'volcano') as
        | 'volcano'
        | 'ma_plot'
        | 'deg_bar'
        | 'pca_biplot'
        | 'heatmap'

      const stats: Record<string, number> = {}
      if (plotStatsNode) {
        for (const attr of Array.from(plotStatsNode.attributes)) {
          if (!attr.name.startsWith('data-')) continue
          if (attr.name === 'data-plot-stats' || attr.name === 'data-plot-type') continue
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
        plotType === 'pca_biplot' ? numFromStat('pca_ellipse_level', 0.95) : 0.95

      const nTopGenes =
        plotType === 'heatmap' ? Math.round(numFromStat('heatmap_top_genes', 50)) : 50
      const clusterRows =
        plotType === 'heatmap' ? boolFromStat('heatmap_cluster_rows', true) : true
      const clusterCols =
        plotType === 'heatmap' ? boolFromStat('heatmap_cluster_cols', true) : true

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
              ? project.models.find((m) => m.id === project.activeModelId)
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
        (targetPlotId ? plots.find((p) => p.id === targetPlotId) : null) ??
        plots[0]

      const findPlotElement = (): HTMLElement | null => {
        // RNA-seq plots live outside the main plots store; prefer scoping to the RNA-seq plot panel
        // to avoid picking up hidden Plotly elements from other views.
        const rnaseqContainer = document.querySelector('.rnaseq-plot')
        if (rnaseqContainer) {
          return (
            (rnaseqContainer.querySelector('.js-plotly-plot') as HTMLElement | null) ??
            (rnaseqContainer.querySelector('.plotly-graph-div') as HTMLElement | null) ??
            (rnaseqContainer.querySelector('.plotly') as HTMLElement | null) ??
            (rnaseqContainer.querySelector('[data-plotly]') as HTMLElement | null)
          )
        }

        return (
          (document.querySelector('[data-testid="plot-container"] .js-plotly-plot') as HTMLElement | null) ??
          (document.querySelector('[data-testid="plot-container"] .plotly') as HTMLElement | null) ??
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
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        if (!plotElement) {
          const rnaseqContainer = document.querySelector('.rnaseq-plot')
          console.error('[E2E] Plot DOM element not found. Debug info:', {
            hasRnaseqContainer: Boolean(rnaseqContainer),
            rnaseqContainerHTML: rnaseqContainer ? rnaseqContainer.innerHTML.substring(0, 200) : 'N/A',
            attemptedSelectors: ['.js-plotly-plot', '.plotly-graph-div', '.plotly', '[data-plotly]'],
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
            normalizedLayout.annotations = normalizedLayout.annotations.map((annotation) => {
              if (!annotation || typeof annotation !== 'object') return annotation
              const { editable, ...rest } = annotation as Record<string, unknown>
              const entry = rest as { name?: string; x?: number; xanchor?: string; xref?: string }
              if (entry.name !== '_title_') return rest
              const x =
                typeof entry.x === 'number' && Number.isFinite(entry.x)
                  ? Math.min(1, Math.max(0, entry.x))
                  : 0.5
              const xanchor =
                entry.xanchor && entry.xanchor !== 'auto' ? entry.xanchor : 'center'
              return {
                ...rest,
                x,
                xanchor,
                xref: entry.xref ?? 'paper',
              }
            })
          }
          const layout = normalizedLayout as { width?: number; height?: number }
          width = typeof layout.width === 'number' ? layout.width : width
          height = typeof layout.height === 'number' ? layout.height : height
        } else {
          // If we don't have a plot definition (e.g. RNA-seq only run), use current render size.
          const rect = plotElement.getBoundingClientRect()
          if (Number.isFinite(rect.width) && rect.width > 0) width = Math.round(rect.width)
          if (Number.isFinite(rect.height) && rect.height > 0) height = Math.round(rect.height)
        }

        const PlotlyModule = await import('plotly.js/dist/plotly.min.js')
        const Plotly = (PlotlyModule as { default?: any }).default ?? PlotlyModule
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
          throw new Error(`RNA-seq plot export failed: ${errorDetails.message || 'Unknown error'}`)
        }

        console.warn('[E2E] Attempting Kaleido fallback for non-RNA-seq plot...')
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
        normalizedLayout.annotations = normalizedLayout.annotations.map((annotation) => {
          if (!annotation || typeof annotation !== 'object') return annotation
          const { editable, ...rest } = annotation as Record<string, unknown>
          const entry = rest as { name?: string; x?: number; xanchor?: string; xref?: string }
          if (entry.name !== '_title_') return rest
          const x =
            typeof entry.x === 'number' && Number.isFinite(entry.x)
              ? Math.min(1, Math.max(0, entry.x))
              : 0.5
          const xanchor = entry.xanchor && entry.xanchor !== 'auto' ? entry.xanchor : 'center'
          return {
            ...rest,
            x,
            xanchor,
            xref: entry.xref ?? 'paper',
          }
        })
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
      clearDeviceAuthState(options?: {
        clearFingerprint?: boolean
        showWelcome?: boolean
      }): Promise<void>
      getDeviceAuthSnapshot(): E2EDeviceAuthSnapshot
      setFirstLaunchState(showWelcome: boolean): void
      openPreferencesDialog(): void
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
  }
}

export {}
