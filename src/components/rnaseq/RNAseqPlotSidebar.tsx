/**
 * RNAseqPlotSidebar - Lightweight sidebar for RNA-seq plots
 *
 * Adapted from statistics PlotSidebar pattern but isolated for RNA-seq.
 * Shows disabled tabs explicitly and gates features by plot capabilities.
 */

import { useEffect, useMemo, useState } from 'react'
import { Palette } from '@phosphor-icons/react'
import { Axis3d, BracesIcon, Shapes, Table2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { PlotCapabilities } from './plotCapabilities'
import type { RNAseqPlotType } from '@/types/rnaseq'

type SidebarTab = 'colors' | 'axes' | 'brackets' | 'shapes' | 'data'

interface RNAseqPlotSidebarProps {
  caps: PlotCapabilities
  plotType: RNAseqPlotType
  degBarShowByThreshold?: boolean
  isNullModel?: boolean
  pcaGroupColorLegend?: Array<{
    label: string
    color: string
    role: 'reference' | 'test' | 'group'
  }>
  dataPreview?: {
    columns: string[]
    rows: Array<Array<string | number>>
    totalRows?: number
  } | null
  className?: string
}

// RNA-seq plot color schemes (fixed, not editable)
const PLOT_COLOR_SCHEMES: Record<RNAseqPlotType, { name: string; colors: { label: string; color: string }[] }> = {
  volcano: {
    name: 'Significance',
    colors: [
      { label: 'Upregulated', color: '#EF4444' },
      { label: 'Downregulated', color: '#3B82F6' },
      { label: 'Not Significant', color: '#9CA3AF' },
    ],
  },
  ma_plot: {
    name: 'Significance',
    colors: [
      { label: 'Upregulated', color: '#EF4444' },
      { label: 'Downregulated', color: '#3B82F6' },
      { label: 'Not Significant', color: '#9CA3AF' },
    ],
  },
  pca_biplot: {
    name: 'Samples & Loadings',
    colors: [
      { label: 'Gene Arrows', color: '#000000' },
    ],
  },
  deg_bar: {
    name: 'Direction',
    colors: [
      { label: 'Upregulated', color: '#EF4444' },
      { label: 'Downregulated', color: '#3B82F6' },
    ],
  },
  heatmap: {
    name: 'Expression (RdBu)',
    colors: [
      { label: 'High Expression', color: '#B91C1C' },
      { label: 'Low Expression', color: '#1E40AF' },
    ],
  },
}

const DEG_BAR_THRESHOLD_SCHEME = {
  name: 'Thresholds',
  colors: [
    { label: 'p < 0.001', color: '#DC2626' },
    { label: 'p < 0.01', color: '#F59E0B' },
    { label: 'p < 0.05', color: '#84CC16' },
  ],
}

export function RNAseqPlotSidebar({
  caps,
  plotType,
  degBarShowByThreshold = false,
  isNullModel = false,
  pcaGroupColorLegend,
  dataPreview,
  className,
}: RNAseqPlotSidebarProps) {
  const allowColors = true
  const allowAxes = caps.axis.x !== 'none' || caps.axis.y !== 'none'
  const allowBrackets = caps.allowBrackets
  const allowShapes = caps.allowShapes
  const allowData = caps.allowDataTab

  const tabAvailability = useMemo(
    () => [
      { id: 'colors' as const, enabled: allowColors },
      { id: 'axes' as const, enabled: allowAxes },
      { id: 'brackets' as const, enabled: allowBrackets },
      { id: 'shapes' as const, enabled: allowShapes },
      { id: 'data' as const, enabled: allowData },
    ],
    [allowColors, allowAxes, allowBrackets, allowShapes, allowData]
  )

  const firstEnabledTab = tabAvailability.find((tab) => tab.enabled)?.id ?? 'colors'
  const [activeTab, setActiveTab] = useState<SidebarTab>(firstEnabledTab)

  useEffect(() => {
    const current = tabAvailability.find((tab) => tab.id === activeTab)
    if (!current?.enabled) {
      setActiveTab(firstEnabledTab)
    }
  }, [activeTab, tabAvailability, firstEnabledTab])

  const colorScheme = useMemo(() => {
    if (plotType === 'deg_bar' && degBarShowByThreshold) {
      return DEG_BAR_THRESHOLD_SCHEME
    }

    if (plotType === 'pca_biplot') {
      const entries = (pcaGroupColorLegend ?? []).map((entry) => {
        if (entry.role === 'reference') {
          return { label: `Reference (${entry.label})`, color: entry.color }
        }
        if (entry.role === 'test') {
          return { label: `Test (${entry.label})`, color: entry.color }
        }
        return { label: entry.label, color: entry.color }
      })
      return {
        name: isNullModel ? 'PCA Groups (Null Model)' : 'Samples & Loadings',
        colors: [
          ...entries,
          ...(PLOT_COLOR_SCHEMES.pca_biplot?.colors ?? []),
        ],
      }
    }

    return PLOT_COLOR_SCHEMES[plotType] ?? PLOT_COLOR_SCHEMES.volcano
  }, [plotType, degBarShowByThreshold, pcaGroupColorLegend, isNullModel])

  const colorHelpText = useMemo(() => {
    if (plotType === 'pca_biplot') {
      return isNullModel
        ? 'PCA sample colors come from the selected grouping factor. Ellipses inherit the same group colors.'
        : 'PCA sample colors use reference/test roles when available (reference = blue, test = red). Ellipses inherit group colors.'
    }
    if (plotType === 'deg_bar' && degBarShowByThreshold) {
      return 'Colors are determined by significance thresholds for each bar.'
    }
    if (plotType === 'heatmap') {
      return 'Heatmap colors represent relative expression intensity (z-score scale).'
    }
    return 'Colors are determined by significance thresholds. Adjust thresholds in the Settings panel above.'
  }, [plotType, isNullModel, degBarShowByThreshold])

  const axisSummary = useMemo(() => {
    const describe = (policy: string) => {
      if (policy === 'none') return 'Hidden'
      if (policy === 'labels') return 'Labels only'
      return 'Full (grid + labels)'
    }
    return {
      x: describe(caps.axis.x),
      y: describe(caps.axis.y),
    }
  }, [caps.axis])

  const disabledTabsLabel = tabAvailability
    .filter((tab) => !tab.enabled)
    .map((tab) => tab.id)
    .join(', ')

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header */}
      <div className="px-3 py-2 border-b">
        <h3 className="text-sm font-medium">Plot Settings</h3>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          RNA-seq plots use fixed styling
        </p>
        {disabledTabsLabel.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Disabled: {disabledTabsLabel}
          </p>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SidebarTab)}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="w-full justify-start h-9 px-2 rounded-none border-b bg-muted/30">
          <TabsTrigger
            value="colors"
            className="text-xs gap-1 h-7 px-2 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
            disabled={!allowColors}
          >
            <Palette className="h-3.5 w-3.5" weight="duotone" />
            Colors
          </TabsTrigger>
          <TabsTrigger
            value="axes"
            className="text-xs gap-1 h-7 px-2 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
            disabled={!allowAxes}
          >
            <Axis3d className="h-3.5 w-3.5" />
            Axes
          </TabsTrigger>
          <TabsTrigger
            value="brackets"
            className="text-xs gap-1 h-7 px-2 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
            disabled={!allowBrackets}
          >
            <BracesIcon className="h-3.5 w-3.5" />
            Brackets
          </TabsTrigger>
          <TabsTrigger
            value="shapes"
            className="text-xs gap-1 h-7 px-2 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
            disabled={!allowShapes}
          >
            <Shapes className="h-3.5 w-3.5" />
            Shapes
          </TabsTrigger>
          <TabsTrigger
            value="data"
            className="text-xs gap-1 h-7 px-2 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
            disabled={!allowData}
          >
            <Table2 className="h-3.5 w-3.5" />
            Data
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-auto">
          {/* Colors Tab */}
          <TabsContent value="colors" className="p-3 m-0 space-y-3">
            <div>
              <h4 className="text-xs font-medium mb-2">{colorScheme.name}</h4>
              <div className="space-y-1.5">
                {colorScheme.colors.map(({ label, color }) => (
                  <div key={label} className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded border border-border"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="pt-2 border-t">
              <p className="text-[10px] text-muted-foreground">
                {colorHelpText}
              </p>
            </div>
          </TabsContent>

          {/* Axes Tab */}
          <TabsContent value="axes" className="p-3 m-0 space-y-3">
            <div>
              <h4 className="text-xs font-medium mb-2">Axis Display</h4>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">X-Axis</span>
                  <span>{axisSummary.x}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Y-Axis</span>
                  <span>{axisSummary.y}</span>
                </div>
              </div>
            </div>
            <div className="pt-2 border-t">
              <p className="text-[10px] text-muted-foreground">
                Axis settings are optimized per plot type. Heatmaps show labels only; scatter plots show full axes with grid.
              </p>
            </div>
          </TabsContent>

          {/* Brackets Tab */}
          <TabsContent value="brackets" className="p-3 m-0">
            <p className="text-[10px] text-muted-foreground">
              Brackets are available only for statistics plots.
            </p>
          </TabsContent>

          {/* Shapes Tab */}
          <TabsContent value="shapes" className="p-3 m-0">
            <p className="text-[10px] text-muted-foreground">
              Shapes are enabled for this plot type. Shape edits are session-only.
            </p>
          </TabsContent>

          {/* Data Tab */}
          <TabsContent value="data" className="p-3 m-0">
            {dataPreview && dataPreview.rows.length > 0 ? (
              <div className="space-y-2">
                <div className="text-[11px] text-muted-foreground">
                  Previewing {dataPreview.rows.length}
                  {dataPreview.totalRows ? ` of ${dataPreview.totalRows}` : ''} rows
                </div>
                <div className="overflow-auto border rounded-md">
                  <table className="w-full text-[11px] font-mono">
                    <thead className="bg-muted/30">
                      <tr>
                        {dataPreview.columns.map((col) => (
                          <th key={col} className="text-left px-2 py-1 border-b">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataPreview.rows.map((row, idx) => (
                        <tr key={`${idx}`}>
                          {row.map((cell, cellIndex) => (
                            <td key={`${idx}-${cellIndex}`} className="px-2 py-1 border-b">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                No data preview available for this plot.
              </p>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

export default RNAseqPlotSidebar
