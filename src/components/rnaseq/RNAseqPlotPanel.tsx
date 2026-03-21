/**
 * RNAseqPlotPanel Component
 *
 * Displays RNA-seq visualizations using Plotly.
 *
 * Features:
 * - Plot type selector (Volcano, PCA Biplot, MA, DEG Bar Chart)
 * - Interactive Plotly charts
 * - Plot options (thresholds, labels, etc.)
 * - Export functionality
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { Data, Layout } from 'plotly.js'
import PlotlyLazy from '@/components/plotly/PlotlyLazy'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SliderWithCommit } from '@/components/ui/slider-with-commit'
import { Switch } from '@/components/ui/switch'
import { Download, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import tauriApi from '@/services/tauriApi'
import rnaseqService from '@/services/rnaseqService'
import { writeFile } from '@tauri-apps/plugin-fs'
import { toast } from 'sonner'
import type {
  DESeqResultRun,
  RNAseqPlotType,
  DESeqModel,
  HeatmapImageResult,
  EllipseType,
  RNAseqPlotSettings,
  PCAResult,
} from '@/types/rnaseq'
import { useRNAseqStore } from '@/store/rnaseq-store'
import {
  RNASEQ_PLOT_CAPS,
  DEFAULT_RNASEQ_PLOT_CAPS,
  applyAxisPolicy,
  applyRNAseqLayoutDefaults,
} from './plotCapabilities'
import {
  buildVolcanoPlot,
  buildPCABiplot,
  buildMAPlot,
  buildDEGBarChart,
  calculateEllipse,
} from './plots'
import { RNAseqPlotSidebar } from './RNAseqPlotSidebar'

// Helper to convert data URL to bytes (same as statistics plots)
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const parts = dataUrl.split(',')
  const base64 = parts[1]
  if (!base64) {
    throw new Error('Invalid data URL format')
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function sanitizePlotStatsGroupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sanitizeFilenamePart(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return cleaned || fallback
}

function getDateStamp(date: Date = new Date()): string {
  return [
    date.getFullYear().toString(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('')
}

function ellipseTypeToCode(type: EllipseType): number {
  if (type === 't') return 1
  if (type === 'norm') return 2
  return 3
}

function clampRepelForce(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 1.0
  return Math.min(2.5, Math.max(0.5, value as number))
}

function plotStatsToDataAttrs(stats: Record<string, number>): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const [key, value] of Object.entries(stats)) {
    // Keep stats numeric so the E2E extractor can parse them reliably.
    attrs[`data-${key.replace(/_/g, '-')}`] = String(value)
  }
  return attrs
}

export function getPcaGeneSelectionText(
  pcaData: PCAResult | undefined
): { summary: string; note: string | null } {
  const genesUsed = pcaData?.genesUsed ?? 0
  const selection = pcaData?.geneSelection
  if (!selection) {
    return {
      summary: `PCA genes used: ${genesUsed}`,
      note: null,
    }
  }

  let summary = `PCA genes used: ${genesUsed}`
  const effectiveMode = selection.effectiveMode ?? selection.mode
  if (effectiveMode === 'significant_only') {
    summary = `Significant genes used: ${genesUsed}`
  } else if (effectiveMode === 'significant_then_variable') {
    if (selection.paddedWithVariance) {
      summary = `Significant genes used: ${selection.significantUsed}, supplemented with high-variance genes to ${genesUsed}`
    } else {
      summary = `Significant genes used: ${selection.significantUsed} (target ${selection.targetTopGenes})`
    }
  } else if (effectiveMode === 'variable_only') {
    summary = `Top variable genes used in PCA: ${genesUsed}`
  }

  let note: string | null = null
  if (selection.autoSwitchedToSignificantThenVariable) {
    const minThreshold = selection.significantOnlyMinGenes ?? 15
    note = `${selection.significantUsed} significant gene(s) detected (< ${minThreshold}), so high-variance genes were added to stabilize PCA.`
  } else if (selection.fallbackToVarianceWhenEmpty) {
    note = 'No significant genes met threshold; transitioned to high-variance genes for PCA stability.'
  }

  return { summary, note }
}

interface RNAseqPlotPanelProps {
  /** All result runs for this project (for run selector dropdown) */
  projectResults: DESeqResultRun[]
  projectId: string
  /** Currently active result to display */
  result: DESeqResultRun
  /** Model configuration for the active result (for PCA factor mapping) */
  model?: DESeqModel | null
  /** ID of the active result (for dropdown selection) */
  activeResultId: string | null
  activePlotType: RNAseqPlotType | null
  onPlotTypeChange: (type: RNAseqPlotType) => void
  /** Called when user selects a different result run */
  onResultChange: (resultId: string) => void
  className?: string
}

const PLOT_TYPES: { id: RNAseqPlotType; label: string; description: string }[] = [
  { id: 'volcano', label: 'Volcano Plot', description: 'LFC vs -log10(p-value)' },
  { id: 'heatmap', label: 'Heatmap', description: 'Clustered expression heatmap' },
  { id: 'pca_biplot', label: 'PCA Biplot', description: 'Sample clustering with gene loadings' },
  { id: 'ma_plot', label: 'MA Plot', description: 'Expression vs fold change' },
  { id: 'deg_bar', label: 'DEG Bar Chart', description: 'Gene count summary' },
]

type PlotSettings = RNAseqPlotSettings

const DEFAULT_PLOT_SETTINGS: Record<RNAseqPlotType, PlotSettings> = {
  volcano: {
    pvalueThreshold: 0.05,
    lfcThreshold: 1.0,
    nLabels: 10,
    usePadj: true,
    showEllipses: true,
    ellipseType: 't',
    nGeneArrows: 5,
    nTopGenes: 50,
    clusterRows: true,
    clusterCols: true,
    spaceColorbar: 0,
    repelForce: 1.0,
  },
  ma_plot: {
    pvalueThreshold: 0.05,
    lfcThreshold: 1.0,
    nLabels: 10,
    usePadj: true,
    showEllipses: true,
    ellipseType: 't',
    nGeneArrows: 5,
    nTopGenes: 50,
    clusterRows: true,
    clusterCols: true,
    spaceColorbar: 0,
    repelForce: 1.0,
  },
  pca_biplot: {
    pvalueThreshold: 0.05,
    lfcThreshold: 1.0,
    nLabels: 10,
    usePadj: true,
    showEllipses: true,
    ellipseType: 't',
    nGeneArrows: 5,
    nTopGenes: 50,
    clusterRows: true,
    clusterCols: true,
    spaceColorbar: 0,
    repelForce: 1.0,
  },
  deg_bar: {
    pvalueThreshold: 0.05,
    lfcThreshold: 1.0,
    nLabels: 10,
    usePadj: true,
    showEllipses: true,
    ellipseType: 't',
    nGeneArrows: 5,
    nTopGenes: 50,
    clusterRows: true,
    clusterCols: true,
    spaceColorbar: 0,
    repelForce: 1.0,
  },
  heatmap: {
    pvalueThreshold: 0.05,
    lfcThreshold: 1.0,
    nLabels: 10,
    usePadj: true,
    showEllipses: true,
    ellipseType: 't',
    nGeneArrows: 5,
    nTopGenes: 50,
    clusterRows: true,
    clusterCols: true,
    spaceColorbar: 30,
    repelForce: 1.0,
  },
}

export function RNAseqPlotPanel({
  projectResults,
  projectId,
  result,
  model,
  activeResultId,
  activePlotType,
  onPlotTypeChange,
  onResultChange,
  className,
}: RNAseqPlotPanelProps) {
  const updateResult = useRNAseqStore((state) => state.updateResult)
  // Plot options state
  const [showSettings, setShowSettings] = useState(false)
  const lastAutoOpenRunId = useRef<string | null>(null)
  const currentPlotType = activePlotType || 'volcano'
  const plotCaps = RNASEQ_PLOT_CAPS[currentPlotType] ?? DEFAULT_RNASEQ_PLOT_CAPS
  const isHeatmap = currentPlotType === 'heatmap'
  const factorNameForExport = sanitizeFilenamePart(model?.mainFactor ?? 'rnaseq', 'rnaseq')
  const plotTypeForExport = sanitizeFilenamePart(currentPlotType, 'plot')
  const defaultPlotExportName = `${factorNameForExport}_${plotTypeForExport}_${getDateStamp()}.png`

  const plotSettings = useMemo(() => {
    const perRun = result.plotSettings
    const saved = perRun?.[currentPlotType]
    return {
      ...DEFAULT_PLOT_SETTINGS[currentPlotType],
      ...(saved ?? {}),
    }
  }, [result.plotSettings, currentPlotType])

  const updatePlotSettings = useCallback(
    (updates: Partial<PlotSettings>) => {
      const perRun = (result.plotSettings ?? {}) as Record<RNAseqPlotType, RNAseqPlotSettings>
      const current = {
        ...DEFAULT_PLOT_SETTINGS[currentPlotType],
        ...(perRun[currentPlotType] ?? {}),
      }
      const nextPlotSettings = {
        ...perRun,
        [currentPlotType]: {
          ...current,
          ...updates,
        },
      }
      if (result.id) {
        updateResult(projectId, result.id, { plotSettings: nextPlotSettings })
      }
    },
    [currentPlotType, projectId, result.id, result.plotSettings, updateResult]
  )

  const {
    pvalueThreshold,
    lfcThreshold,
    nLabels,
    usePadj,
    showEllipses,
    ellipseType,
    nGeneArrows,
    nTopGenes,
    clusterRows,
    clusterCols,
    spaceColorbar,
    repelForce,
  } = plotSettings
  const repelForceClamped = clampRepelForce(repelForce)

  const ellipseLevel = useMemo(() => {
    switch (ellipseType) {
      case 'euclid':
        return 2.0
      case 't':
      case 'norm':
      default:
        return 0.95
    }
  }, [ellipseType])
  const [heatmapImage, setHeatmapImage] = useState<HeatmapImageResult | null>(null)
  const [heatmapStatus, setHeatmapStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [heatmapError, setHeatmapError] = useState<string | null>(null)
  const heatmapRequestId = useRef(0)
  const plotContainerRef = useRef<HTMLDivElement | null>(null)
  const isNullModel = Boolean(result.parameters?.useNullModel)
  const effectiveGeneArrows = isNullModel ? 0 : nGeneArrows
  const pcaGeneSelectionText = useMemo(
    () => getPcaGeneSelectionText(result.pcaData),
    [result.pcaData]
  )

  const resolvedPcaGroupBy = useMemo(() => {
    if (!result.pcaData?.samples?.length) {
      return model?.mainFactor ?? 'treatment'
    }
    if (!isNullModel) {
      return model?.mainFactor ?? 'treatment'
    }

    const explicit = (model?.pcaGroupBy ?? '').trim()
    if (explicit) return explicit

    const orderedColumns: string[] = []
    const seen = new Set<string>()
    for (const sample of result.pcaData.samples) {
      const metadata = sample.metadata ?? {}
      for (const key of Object.keys(metadata)) {
        if (seen.has(key)) continue
        seen.add(key)
        orderedColumns.push(key)
      }
    }

    for (const col of orderedColumns) {
      const uniqueValues = new Set<string>()
      let hasNonNumeric = false
      let hasAny = false
      for (const sample of result.pcaData.samples) {
        const raw = sample.metadata?.[col]
        if (raw === null || raw === undefined) continue
        hasAny = true
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          continue
        }
        hasNonNumeric = true
        uniqueValues.add(String(raw))
      }
      if (!hasAny || !hasNonNumeric) continue
      if (uniqueValues.size >= 2) return col
    }

    if (orderedColumns.includes('__all_samples__')) return '__all_samples__'
    return '__all_samples__'
  }, [isNullModel, model?.mainFactor, model?.pcaGroupBy, result.pcaData])

  const pcaGroupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!result.pcaData?.samples?.length) return counts
    for (const sample of result.pcaData.samples) {
      const label = String(sample.metadata?.[resolvedPcaGroupBy] ?? 'Unknown')
      counts.set(label, (counts.get(label) || 0) + 1)
    }
    return counts
  }, [resolvedPcaGroupBy, result.pcaData])

  const hasMultiplePcaGroups = pcaGroupCounts.size >= 2
  const effectiveShowEllipses = showEllipses && (!isNullModel || hasMultiplePcaGroups)

  // Check if ellipses are valid (requires >= 4 samples per group for proper confidence ellipses)
  const canShowEllipses = useMemo(() => {
    if (currentPlotType !== 'pca_biplot' || !result.pcaData) return false
    if (!hasMultiplePcaGroups) return false
    // At least one group must have >= 4 samples for valid ellipse calculation
    return Array.from(pcaGroupCounts.values()).some((count) => count >= 4)
  }, [currentPlotType, result.pcaData, hasMultiplePcaGroups, pcaGroupCounts])

  const heatmapSampleIds = useMemo(() => {
    if (result.sampleIds?.length) return [...result.sampleIds]
    const fromSizeFactors = Object.keys(result.sizeFactors ?? {})
    if (fromSizeFactors.length > 0) return fromSizeFactors
    if (result.pcaData?.samples) {
      return result.pcaData.samples.map((sample) => sample.sampleId)
    }
    return []
  }, [result.sampleIds, result.sizeFactors, result.pcaData])

  useEffect(() => {
    if (!isHeatmap) return
    if (!result.normalizedCounts || result.normalizedCounts.length === 0) {
      setHeatmapImage(null)
      setHeatmapStatus('idle')
      setHeatmapError(null)
      return
    }

    const requestId = heatmapRequestId.current + 1
    heatmapRequestId.current = requestId
    setHeatmapStatus('loading')
    setHeatmapError(null)
    setHeatmapImage(null)

    const timer = setTimeout(() => {
      rnaseqService
        .renderHeatmapImage(result.genes, result.normalizedCounts ?? [], heatmapSampleIds, {
          nTopGenes,
          clusterRows,
          clusterCols,
          usePadj,
          spaceColorbar,
        })
        .then((imageResult) => {
          if (heatmapRequestId.current !== requestId) return
          setHeatmapImage(imageResult)
          setHeatmapStatus('idle')
        })
        .catch((error) => {
          if (heatmapRequestId.current !== requestId) return
          const message = error instanceof Error ? error.message : 'Heatmap render failed'
          setHeatmapImage(null)
          setHeatmapStatus('error')
          setHeatmapError(message)
        })
    }, 200)

    return () => {
      clearTimeout(timer)
    }
  }, [
    isHeatmap,
    result.id,
    result.genes,
    result.normalizedCounts,
    heatmapSampleIds,
    nTopGenes,
    clusterRows,
    clusterCols,
    usePadj,
    spaceColorbar,
  ])

  useEffect(() => {
    if (isNullModel && currentPlotType !== 'pca_biplot') {
      onPlotTypeChange('pca_biplot')
    }
  }, [isNullModel, currentPlotType, onPlotTypeChange])

  const heatmapImagePlot = useMemo(() => {
    if (!isHeatmap || !heatmapImage) return null
    const title =
      heatmapImage.title ??
      `Expression Heatmap (Top ${nTopGenes} genes by ${usePadj ? 'padj' : 'p-value'})`
    return buildHeatmapImagePlot(heatmapImage, title)
  }, [isHeatmap, heatmapImage, nTopGenes, usePadj])

  // Build plot data based on type
  const plotData = useMemo(() => {
    const plotType = currentPlotType
    if (isNullModel && plotType !== 'pca_biplot') return null

    switch (plotType) {
      case 'volcano':
        return buildVolcanoPlot(result.genes, {
          pvalueThreshold,
          lfcThreshold,
          nLabels,
          usePadj,
          repelForce: repelForceClamped,
        })

      case 'pca_biplot':
        if (!result.pcaData) return null

        const colorBy = resolvedPcaGroupBy
        const allowSecondary = !isNullModel || hasMultiplePcaGroups

        // For single group, disable secondary factors
        const shapeBy = allowSecondary
          ? pickFirstDistinct(
              [model?.interactionFactor, ...(model?.additionalFactors ?? [])],
              [colorBy]
            )
          : undefined
        const thirdBy = allowSecondary
          ? pickFirstDistinct(
              [
                model?.interactionFactor2,
                ...(model?.additionalFactors ?? []).slice(1),
                model?.covariates?.[0]?.column,
              ],
              [colorBy, shapeBy]
            )
          : undefined

        return buildPCABiplot(result.pcaData, {
          showEllipses: effectiveShowEllipses && canShowEllipses,
          ellipseType,
          ellipseLevel,
          showLabels: true,
          nGeneArrows: effectiveGeneArrows,
          colorBy,
          useContrastRoleColors: !isNullModel,
          referenceLevel: !isNullModel ? model?.mainFactorReference : undefined,
          testLevel: !isNullModel ? model?.mainFactorTest : undefined,
          shapeBy,
          thirdBy,
          repelForce: repelForceClamped,
        })

      case 'ma_plot':
        return buildMAPlot(result.genes, {
          pvalueThreshold,
          lfcThreshold,
          usePadj,
        })

      case 'deg_bar':
        return buildDEGBarChart(result.summary, {
          showByThreshold: false,
        })

      case 'heatmap': {
        return heatmapImagePlot
      }

      default:
        return null
    }
  }, [
    currentPlotType,
    result,
    heatmapImagePlot,
    model,
    pvalueThreshold,
    lfcThreshold,
    nLabels,
    usePadj,
    showEllipses,
    canShowEllipses,
    ellipseType,
    ellipseLevel,
    nGeneArrows,
    nTopGenes,
    clusterRows,
    clusterCols,
    isNullModel,
    resolvedPcaGroupBy,
    hasMultiplePcaGroups,
    repelForceClamped,
  ])
  useEffect(() => {
    if (!plotData) return
    const runId = result.id ?? activeResultId ?? null
    if (runId && lastAutoOpenRunId.current === runId) return
    setShowSettings(true)
    lastAutoOpenRunId.current = runId
  }, [plotData, result.id, activeResultId])
  const plotLayout = useMemo(() => {
    if (!plotData) return null
    const base = applyRNAseqLayoutDefaults(plotData.layout)
    return applyAxisPolicy(base, plotCaps)
  }, [plotData, plotCaps])

  const plotConfig = useMemo(
    () => ({
      responsive: true,
      displaylogo: false,
      scrollZoom: false,
      doubleClick: false,
      staticPlot: isHeatmap,
      displayModeBar: false,
    }),
    [isHeatmap]
  )

  const dataPreview = useMemo(() => {
    if (!plotCaps.allowDataTab) return null

    const formatValue = (value: number | string | null | undefined) => {
      if (value === null || value === undefined) return ''
      if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(3) : ''
      return String(value)
    }

    if (currentPlotType === 'pca_biplot') {
      if (!result.pcaData?.samples) return null
      const rows = result.pcaData.samples.slice(0, 10).map((sample) => [
        sample.sampleId,
        formatValue(sample.PC1),
        formatValue(sample.PC2),
      ])
      return {
        columns: ['Sample', 'PC1', 'PC2'],
        rows,
        totalRows: result.pcaData.samples.length,
      }
    }

    if (currentPlotType === 'deg_bar') {
      const summary = result.summary
      const rows = [
        ['Upregulated', summary.upregulated],
        ['Downregulated', summary.downregulated],
        ['Significant (padj<0.05)', summary.significantPadj05],
        ['Significant (p<0.05)', summary.significantP05],
        ['Tested Genes', summary.testedGenes],
        ['Total Genes', summary.totalGenes],
      ]
      return {
        columns: ['Metric', 'Value'],
        rows,
        totalRows: rows.length,
      }
    }

    if (currentPlotType === 'heatmap') {
      const zScores = heatmapImage?.zScores
      const rowLabels = heatmapImage?.rowLabels
      const colLabels = heatmapImage?.colLabels
      if (!zScores || !rowLabels || !colLabels) return null
      const xLabels = colLabels.slice(0, 4).map(String)
      const yLabels = rowLabels.slice(0, 8).map(String)
      const rows = yLabels.map((label, rowIndex) => {
        const row = Array.isArray(zScores[rowIndex]) ? zScores[rowIndex] : []
        const values = row.slice(0, xLabels.length).map((val) => formatValue(val))
        return [label, ...values]
      })
      return {
        columns: ['Gene', ...xLabels],
        rows,
        totalRows: rowLabels.length,
      }
    }

    const pvalKey = usePadj ? 'padj' : 'pvalue'
    const sorted = [...result.genes]
      .filter((gene) => gene[pvalKey] !== null)
      .sort((a, b) => (a[pvalKey] ?? 1) - (b[pvalKey] ?? 1))
      .slice(0, 10)

    if (currentPlotType === 'ma_plot') {
      return {
        columns: ['Gene', 'baseMean', 'log2FC', 'pvalue', 'padj'],
        rows: sorted.map((gene) => [
          gene.geneSymbol || gene.geneId,
          formatValue(gene.baseMean),
          formatValue(gene.log2FoldChange),
          formatValue(gene.pvalue),
          formatValue(gene.padj),
        ]),
        totalRows: result.genes.length,
      }
    }

    return {
      columns: ['Gene', 'log2FC', 'pvalue', 'padj'],
      rows: sorted.map((gene) => [
        gene.geneSymbol || gene.geneId,
        formatValue(gene.log2FoldChange),
        formatValue(gene.pvalue),
        formatValue(gene.padj),
      ]),
      totalRows: result.genes.length,
    }
  }, [plotCaps.allowDataTab, currentPlotType, heatmapImage, result, usePadj])

  // Handle export
  const handleExport = useCallback(async () => {
    if (isHeatmap && heatmapImage?.image) {
      const savePath = await tauriApi.saveFileDialog(defaultPlotExportName, [
        { name: 'PNG', extensions: ['png'] },
      ])
      if (!savePath) {
        return
      }

      try {
        const bytes = dataUrlToBytes(heatmapImage.image)
        await writeFile(savePath, bytes)
        toast.success('Heatmap exported')
      } catch (error) {
        console.error('Heatmap export failed:', error)
        toast.error('Heatmap export failed')
      }
      return
    }

    if (!plotData || !plotLayout) {
      toast.error('Plot is not ready for export')
      return
    }

    const savePath = await tauriApi.saveFileDialog(defaultPlotExportName, [
      { name: 'PNG', extensions: ['png'] },
    ])
    if (!savePath) return

    try {
      // Use browser-side Plotly.toImage() (same as statistics plots) - bypasses Kaleido!
      const plotElement = plotContainerRef.current?.querySelector('.js-plotly-plot') as HTMLElement
      if (!plotElement) {
        toast.error('Plot is not ready for export')
        return
      }

      // Load Plotly dynamically (same as statistics plots)
      const PlotlyModule = await import('plotly.js/dist/plotly.min.js')
      const Plotly = (PlotlyModule as { default?: any }).default ?? PlotlyModule

      if (!Plotly?.toImage) {
        toast.error('Plot export is not available')
        return
      }

      // Export at large fixed dimensions for proper repel spacing
      // (regardless of current window size)
      const exportWidth = 1400
      const exportHeight = 900

      // Build fresh layout from plotData.layout (not plotLayout which has on-screen dimensions)
      const exportLayout = {
        ...plotData.layout,
        autosize: false,
        width: exportWidth,
        height: exportHeight,
        paper_bgcolor: '#ffffff',
        plot_bgcolor: plotData.layout.plot_bgcolor ?? '#ffffff',
      }

      // Force plain objects (Plotly export is sensitive to prototypes)
      const exportObj = JSON.parse(
        JSON.stringify({
          data: plotData.data,  // Extract Data[] array from plotData
          layout: exportLayout,
        })
      )

      // Prefer exporting from the existing DOM graph div (matches statistics plot export):
      // Plotly clones and re-renders at the requested export size, which helps with
      // layout-dependent features like label repelling. Fall back to object export.
      let imageDataUrl: string
      try {
        imageDataUrl = await Plotly.toImage(plotElement, {
          format: 'png',
          width: exportWidth,
          height: exportHeight,
          scale: 2,
        })
      } catch (domError) {
        console.warn('[RNAseq Export] Plotly.toImage(dom) failed, falling back to object export', domError)
        imageDataUrl = await Plotly.toImage(exportObj, {
          format: 'png',
          width: exportWidth,
          height: exportHeight,
          scale: 2,
        })
      }

      const bytes = dataUrlToBytes(imageDataUrl)
      await writeFile(savePath, bytes)
      toast.success('Plot exported')
    } catch (error) {
      console.error('RNA-seq plot export failed:', error)
      toast.error('Plot export failed')
    }
  }, [defaultPlotExportName, plotData, plotLayout, isHeatmap, heatmapImage, plotContainerRef])

  // Build run options for selector
  const runOptions = useMemo(() => {
    return projectResults.map((run) => ({
      id: run.id,
      label: run.label,
    }))
  }, [projectResults])

  const hasMultipleRuns = runOptions.length > 1

  const degBarShowByThreshold =
    currentPlotType === 'deg_bar' &&
    plotData?.data?.some((trace) => {
      const name = (trace as { name?: unknown })?.name
      return typeof name === 'string' && name.trim().startsWith('p < ')
    })

  const pcaGroupColorLegend = useMemo(() => {
    if (currentPlotType !== 'pca_biplot' || !plotData || !('sampleLegend' in plotData)) {
      return undefined
    }
    return Array.isArray(plotData.sampleLegend)
      ? plotData.sampleLegend.map((entry) => ({
          label: entry.label,
          color: entry.color,
          role: entry.role,
        }))
      : undefined
  }, [currentPlotType, plotData])

  const plotStatsAttrs = useMemo(() => {
    const stats: Record<string, number> = {}

    if (currentPlotType === 'volcano') {
      const pvalKey = usePadj ? 'padj' : 'pvalue'
      let total = 0
      let up = 0
      let down = 0
      let notSig = 0

      for (const gene of result.genes) {
        const pval = gene[pvalKey]
        const lfc = gene.log2FoldChange
        if (pval === null || lfc === null) continue
        if (!Number.isFinite(pval) || !Number.isFinite(lfc)) continue
        total += 1
        if (pval < pvalueThreshold) {
          if (lfc > lfcThreshold) up += 1
          else if (lfc < -lfcThreshold) down += 1
          else notSig += 1
        } else {
          notSig += 1
        }
      }

      stats.volcano_total = total
      stats.volcano_up = up
      stats.volcano_down = down
      stats.volcano_not_sig = notSig
      stats.volcano_pval_threshold = pvalueThreshold
      stats.volcano_lfc_threshold = lfcThreshold
      stats.volcano_use_padj = usePadj ? 1 : 0
      stats.volcano_label_count = nLabels
    } else if (currentPlotType === 'ma_plot') {
      const pvalKey = usePadj ? 'padj' : 'pvalue'
      let total = 0
      let up = 0
      let down = 0
      let notSig = 0

      for (const gene of result.genes) {
        const pval = gene[pvalKey]
        const lfc = gene.log2FoldChange
        const baseMean = gene.baseMean
        if (pval === null || lfc === null || baseMean === null) continue
        if (!Number.isFinite(pval) || !Number.isFinite(lfc) || !Number.isFinite(baseMean)) continue
        if (baseMean <= 0) continue
        total += 1
        if (pval < pvalueThreshold) {
          if (lfc > lfcThreshold) up += 1
          else if (lfc < -lfcThreshold) down += 1
          else notSig += 1
        } else {
          notSig += 1
        }
      }

      stats.ma_total = total
      stats.ma_up = up
      stats.ma_down = down
      stats.ma_not_sig = notSig
      stats.ma_pval_threshold = pvalueThreshold
      stats.ma_lfc_threshold = lfcThreshold
      stats.ma_use_padj = usePadj ? 1 : 0
    } else if (currentPlotType === 'deg_bar') {
      stats.deg_up = result.summary.upregulated
      stats.deg_down = result.summary.downregulated
      stats.deg_sig_padj05 = result.summary.significantPadj05
      stats.deg_sig_p05 = result.summary.significantP05
      stats.deg_tested = result.summary.testedGenes
      stats.deg_total = result.summary.totalGenes
    } else if (currentPlotType === 'pca_biplot') {
      const pca = result.pcaData
      const colorBy = resolvedPcaGroupBy

      stats.pca_sample_count = pca?.samples?.length ?? 0
      stats.pca_group_count = 0
      stats.pca_pc1_variance = pca?.varianceExplained?.[0] ?? 0
      stats.pca_pc2_variance = pca?.varianceExplained?.[1] ?? 0
      stats.pca_genes_used = pca?.genesUsed ?? 0
      stats.pca_ellipse_enabled = effectiveShowEllipses && canShowEllipses ? 1 : 0
      stats.pca_ellipse_type = ellipseTypeToCode(ellipseType)
      stats.pca_ellipse_level = ellipseLevel

      if (pca?.samples?.length) {
        const groupLevels: string[] = []
        for (const sample of pca.samples) {
          const label = String(sample.metadata?.[colorBy] ?? 'Unknown')
          if (!groupLevels.includes(label)) groupLevels.push(label)
        }
        stats.pca_group_count = groupLevels.length

        let ellipseGroups = 0
        if (effectiveShowEllipses && canShowEllipses) {
          // Prefer precomputed ellipse metrics from Python backend (exact R match)
          const precomputedMetrics = pca.ellipse_metrics?.[ellipseType]

          if (precomputedMetrics && precomputedMetrics.length > 0) {
            // Use precomputed metrics from Python backend
            for (const metric of precomputedMetrics) {
              const key = sanitizePlotStatsGroupKey(metric.group)
              stats[`pca_ellipse_${key}_center_x`] = metric.centerX
              stats[`pca_ellipse_${key}_center_y`] = metric.centerY
              stats[`pca_ellipse_${key}_radius_x`] = metric.radiusX
              stats[`pca_ellipse_${key}_radius_y`] = metric.radiusY
              stats[`pca_ellipse_${key}_angle`] = metric.angle
              stats[`pca_ellipse_${key}_n`] = metric.n
              ellipseGroups += 1
            }
          } else {
            // Fallback to TypeScript calculation for backwards compatibility
            for (const groupLabel of groupLevels) {
              const groupSamples = pca.samples.filter(
                (s) => String(s.metadata?.[colorBy] ?? 'Unknown') === groupLabel
              )
              if (groupSamples.length < 4) continue
              const ellipse = calculateEllipse(
                groupSamples.map((s) => s.PC1),
                groupSamples.map((s) => s.PC2),
                ellipseType,
                ellipseLevel
              )
              if (!ellipse) continue
              ellipseGroups += 1

              const key = sanitizePlotStatsGroupKey(groupLabel)
              stats[`pca_ellipse_${key}_center_x`] = ellipse.center.x
              stats[`pca_ellipse_${key}_center_y`] = ellipse.center.y
              stats[`pca_ellipse_${key}_radius_x`] = ellipse.radiusX
              stats[`pca_ellipse_${key}_radius_y`] = ellipse.radiusY
              stats[`pca_ellipse_${key}_angle`] = ellipse.angle
              stats[`pca_ellipse_${key}_n`] = groupSamples.length
            }
          }
        }

        stats.pca_ellipse_group_count = ellipseGroups
      } else {
        stats.pca_ellipse_group_count = 0
      }
    } else if (currentPlotType === 'heatmap') {
      const pvalKey = usePadj ? 'padj' : 'pvalue'
      const genesWithPval = result.genes
        .filter((g) => {
          const pval = g[pvalKey]
          return pval !== null && Number.isFinite(pval)
        })
        .sort((a, b) => (a[pvalKey] ?? 1) - (b[pvalKey] ?? 1))

      let selected = genesWithPval.slice(0, nTopGenes)
      if (selected.length === 0) {
        selected = result.genes
          .filter((g) => g.log2FoldChange !== null && Number.isFinite(g.log2FoldChange))
          .sort((a, b) => Math.abs(b.log2FoldChange ?? 0) - Math.abs(a.log2FoldChange ?? 0))
          .slice(0, nTopGenes)
      }

      const matrixSampleCount =
        result.sampleIds?.length ??
        (result.normalizedCounts?.[0]?.length ?? 0)

      stats.heatmap_ready = heatmapImage ? 1 : 0
      stats.heatmap_n_genes = selected.length
      stats.heatmap_n_samples = matrixSampleCount
      stats.heatmap_top_genes = nTopGenes
      stats.heatmap_use_padj = usePadj ? 1 : 0
      stats.heatmap_cluster_rows = clusterRows ? 1 : 0
      stats.heatmap_cluster_cols = clusterCols ? 1 : 0
    }

    return plotStatsToDataAttrs(stats)
  }, [
    currentPlotType,
    result,
    resolvedPcaGroupBy,
    usePadj,
    pvalueThreshold,
    lfcThreshold,
    nLabels,
    showEllipses,
    canShowEllipses,
    ellipseType,
    ellipseLevel,
    nTopGenes,
    clusterRows,
    clusterCols,
    heatmapImage,
    hasMultiplePcaGroups,
  ])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Plot Controls */}
      <div className="flex items-center gap-4 p-4 border-b">
        {/* Result Run Selector - only show when multiple runs exist */}
        {hasMultipleRuns && (
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium" htmlFor="rnaseq-run-select">Run:</Label>
            <Select
              value={activeResultId ?? ''}
              onValueChange={(v) => onResultChange(v)}
            >
              <SelectTrigger id="rnaseq-run-select" className="w-56">
                <SelectValue placeholder="Select run..." />
              </SelectTrigger>
              <SelectContent>
                {runOptions.map((run) => (
                  <SelectItem key={run.id} value={run.id}>
                    <span className="truncate">{run.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium" htmlFor="rnaseq-plot-type-select">
            Plot Type:
          </Label>
          <Select value={currentPlotType} onValueChange={(v) => onPlotTypeChange(v as RNAseqPlotType)}>
            <SelectTrigger
              id="rnaseq-plot-type-select"
              className="w-48"
              data-testid="rnaseq-plot-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLOT_TYPES.map((type) => (
                <SelectItem
                  key={type.id}
                  value={type.id}
                  disabled={
                    (isNullModel && type.id !== 'pca_biplot') ||
                    (type.id === 'pca_biplot' && !result.pcaData) ||
                    (type.id === 'heatmap' && !result.normalizedCounts)
                  }
                >
                  <div>
                    <div>{type.label}</div>
                    <div className="text-xs text-muted-foreground">{type.description}</div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1" />

        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowSettings(!showSettings)}
        >
          <Settings className="h-4 w-4 mr-2" />
          Settings
        </Button>

        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-2" />
          Export
        </Button>
      </div>

      {/* Settings Panel (collapsible) */}
      {showSettings && (
        <div className="p-4 border-b bg-muted/30 grid grid-cols-4 gap-4">
          {(currentPlotType === 'volcano' || currentPlotType === 'ma_plot') && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">
                  {usePadj ? 'Adjusted P-value Threshold' : 'P-value Threshold'}
                </Label>
                <SliderWithCommit
                  value={pvalueThreshold}
                  onCommit={(v) => updatePlotSettings({ pvalueThreshold: v })}
                  min={0.001}
                  max={0.1}
                  step={0.001}
                />
                <div className="text-xs text-muted-foreground">{pvalueThreshold}</div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Switch
                    data-testid="rnaseq-use-padj-volcano"
                    checked={usePadj}
                    onCheckedChange={(value) => updatePlotSettings({ usePadj: value })}
                  />
                  <Label className="text-xs">Use adjusted p-value</Label>
                </div>
              </div>
            </>
          )}

          {currentPlotType === 'volcano' && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">LFC Threshold</Label>
                <SliderWithCommit
                  value={lfcThreshold}
                  onCommit={(v) => updatePlotSettings({ lfcThreshold: v })}
                  min={0}
                  max={3}
                  step={0.1}
                />
                <div className="text-xs text-muted-foreground">{lfcThreshold}</div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Gene Labels</Label>
                <SliderWithCommit
                  value={nLabels}
                  onCommit={(v) => updatePlotSettings({ nLabels: v })}
                  min={0}
                  max={30}
                  step={1}
                />
                <div className="text-xs text-muted-foreground">{nLabels} labels</div>
              </div>

              <div className={cn('space-y-2', nLabels === 0 && 'pointer-events-none opacity-50')}>
                <Label className="text-xs">Label Repel Strength</Label>
                <SliderWithCommit
                  value={repelForceClamped}
                  onCommit={(v) => updatePlotSettings({ repelForce: v })}
                  min={0.5}
                  max={2.5}
                  step={0.1}
                  disabled={nLabels === 0}
                />
                <div className="text-xs text-muted-foreground">
                  {nLabels === 0 ? 'Enable labels first' : repelForceClamped.toFixed(1)}
                </div>
              </div>
            </>
          )}

          {currentPlotType === 'pca_biplot' && (
            <>
              <div className="text-xs text-muted-foreground">
                {pcaGeneSelectionText.summary}
              </div>
              {pcaGeneSelectionText.note && (
                <div className="text-xs text-amber-700">{pcaGeneSelectionText.note}</div>
              )}

              <div className="flex items-start gap-4">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      data-testid="rnaseq-show-ellipses"
                      checked={effectiveShowEllipses}
                      onCheckedChange={(value) => {
                        updatePlotSettings({ showEllipses: value })
                      }}
                      disabled={!canShowEllipses}
                    />
                    <Label
                      className={cn(
                        'text-xs',
                        (!canShowEllipses) && 'opacity-50'
                      )}
                    >
                      Show confidence ellipses
                    </Label>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {!hasMultiplePcaGroups
                      ? 'Select a grouping factor with ≥2 levels'
                      : !canShowEllipses
                      ? 'Requires ≥4 samples per group'
                      : ellipseType === 'euclid'
                        ? `Radius: ${ellipseLevel.toFixed(2)} SD`
                        : `Confidence: ${Math.round(ellipseLevel * 100)}%`}
                  </div>
                </div>

                <div
                  className={cn(
                    'flex-1 space-y-2',
                    (!effectiveShowEllipses || !canShowEllipses) &&
                      'pointer-events-none opacity-50'
                  )}
                >
                  <Label className="text-xs">Ellipse type</Label>
                  <Select
                    value={ellipseType}
                    onValueChange={(v) => updatePlotSettings({ ellipseType: v as EllipseType })}
                    disabled={!canShowEllipses}
                  >
                    <SelectTrigger className="w-full" data-testid="rnaseq-ellipse-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="t">T distribution</SelectItem>
                      <SelectItem value="norm">Normal (chi-square)</SelectItem>
                      <SelectItem value="euclid">Euclidean circle</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className={cn('space-y-2', isNullModel && 'pointer-events-none opacity-50')}>
                <Label className="text-xs">Gene Loadings</Label>
                <SliderWithCommit
                  value={effectiveGeneArrows}
                  onCommit={(v) => {
                    if (!isNullModel) updatePlotSettings({ nGeneArrows: v })
                  }}
                  min={0}
                  max={20}
                  step={1}
                  disabled={isNullModel}
                />
                <div className="text-xs text-muted-foreground">
                  {isNullModel ? 'Disabled for QC null model' : `${nGeneArrows} genes`}
                </div>
              </div>

              <div className={cn('space-y-2', (isNullModel || effectiveGeneArrows === 0) && 'pointer-events-none opacity-50')}>
                <Label className="text-xs">Gene Label Repel Strength</Label>
                <SliderWithCommit
                  value={repelForceClamped}
                  onCommit={(v) => updatePlotSettings({ repelForce: v })}
                  min={0.5}
                  max={2.5}
                  step={0.1}
                  disabled={isNullModel || effectiveGeneArrows === 0}
                />
                <div className="text-xs text-muted-foreground">
                  {isNullModel ? 'Disabled for QC null model' : effectiveGeneArrows === 0 ? 'Enable gene loadings first' : repelForceClamped.toFixed(1)}
                </div>
              </div>
            </>
          )}

          {currentPlotType === 'heatmap' && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">Top Genes</Label>
                <SliderWithCommit
                  value={nTopGenes}
                  onCommit={(v) => updatePlotSettings({ nTopGenes: v })}
                  min={10}
                  max={200}
                  step={10}
                />
                <div className="text-xs text-muted-foreground">{nTopGenes} genes</div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Switch
                    data-testid="rnaseq-use-padj-heatmap"
                    checked={usePadj}
                    onCheckedChange={(value) => updatePlotSettings({ usePadj: value })}
                  />
                  <Label className="text-xs">Use adjusted p-value</Label>
                </div>
                <div className="text-xs text-muted-foreground">
                  {usePadj ? 'Using padj' : 'Using raw p-value'}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Switch checked={clusterRows} onCheckedChange={(value) => updatePlotSettings({ clusterRows: value })} />
                  <Label className="text-xs">Cluster genes</Label>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Switch checked={clusterCols} onCheckedChange={(value) => updatePlotSettings({ clusterCols: value })} />
                  <Label className="text-xs">Cluster samples</Label>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Legend spacing</Label>
                <SliderWithCommit
                  value={spaceColorbar}
                  onCommit={(v) => updatePlotSettings({ spaceColorbar: v })}
                  min={0}
                  max={100}
                  step={5}
                />
                <div className="text-xs text-muted-foreground">
                  Gap between gene labels and Z-score legend: {spaceColorbar}%
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Plot Area */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-4 overflow-auto rnaseq-plot" ref={plotContainerRef}>
          {/* E2E hook: emit plot-level stats as data-* attributes for validation baseline comparison */}
          <div
            data-plot-stats
            data-plot-type={currentPlotType}
            style={{ display: 'none' }}
            {...plotStatsAttrs}
          />
          {plotData && plotLayout ? (
            <PlotlyLazy
              data={plotData.data}
              layout={plotLayout}
              config={plotConfig}
              style={{ width: '100%', height: '100%', minHeight: 500 }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {currentPlotType === 'pca_biplot' && !result.pcaData
                ? 'PCA data not available. Re-run analysis with PCA enabled.'
                : isHeatmap && !result.normalizedCounts
                  ? 'Expression data not available. Re-run analysis with VST enabled.'
                  : isHeatmap && heatmapStatus === 'loading'
                    ? 'Rendering heatmap...'
                    : isHeatmap && heatmapStatus === 'error'
                      ? heatmapError ?? 'Heatmap render failed.'
                      : 'Select a plot type to visualize results.'}
            </div>
          )}
        </div>
        <div className="w-56 min-w-[14rem] border-l">
          <RNAseqPlotSidebar
            caps={plotCaps}
            plotType={currentPlotType}
            degBarShowByThreshold={degBarShowByThreshold}
            dataPreview={dataPreview}
            pcaGroupColorLegend={pcaGroupColorLegend}
            isNullModel={isNullModel}
          />
        </div>
      </div>
    </div>
  )
}

export default RNAseqPlotPanel

function pickFirstDistinct(
  values: Array<string | undefined | null>,
  blocked: Array<string | undefined | null>
): string | undefined {
  const blockedSet = new Set(
    blocked
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim())
  )
  for (const value of values) {
    if (!value) continue
    const trimmed = value.trim()
    if (!trimmed) continue
    if (!blockedSet.has(trimmed)) return trimmed
  }
  return undefined
}

function buildHeatmapImagePlot(
  image: HeatmapImageResult,
  title: string
): { data: Data[]; layout: Partial<Layout> } {
  const layout: Partial<Layout> = {
    title: { text: title, font: { size: 14 } },
    xaxis: { visible: false, showgrid: false, zeroline: false },
    yaxis: { visible: false, showgrid: false, zeroline: false, scaleanchor: 'x' },
    images: [
      {
        source: image.image,
        xref: 'paper',
        yref: 'paper',
        x: 0.5,
        y: 0.5,
        sizex: 1,
        sizey: 1,
        sizing: 'contain',
        xanchor: 'center',
        yanchor: 'middle',
        layer: 'below',
      },
    ],
    margin: { t: 60, b: 20, l: 20, r: 20 },
  }

  const data: Data[] = [
    {
      type: 'scatter',
      x: [0, 1],
      y: [0, 1],
      mode: 'markers',
      marker: { opacity: 0 },
      hoverinfo: 'skip',
      showlegend: false,
    },
  ]

  return { data, layout }
}
