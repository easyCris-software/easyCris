/**
 * PlotSettingsPanel Component
 *
 * Tabbed settings for customizing plots.
 */

import { useMemo, useState } from 'react'
import type { Layout, Data } from 'plotly.js'
import {
  Palette,
  BarChart3,
  LayoutGrid,
  Database,
  Settings2,
  ChevronDown,
  ChevronUp,
  Type,
  SlidersHorizontal,
  TextCursorInput,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePlotsStore } from '@/store/plots-store'
import { getPlotTemplate } from '@/config/plotRegistry'
import { normalizeTestId } from '@/services/plotResult/common/normalize'
import { getEffectiveShowLegend } from '@/utils/plotDisplayDefaults'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface PlotSettingsPanelProps {
  className?: string
  defaultCollapsed?: boolean
  height?: number
}

/**
 * Strip HTML tags from text (handles weight wrapping spans)
 */
function stripHtmlTags(text: string): string {
  if (!text) return ''
  return text.replace(/<[^>]*>/g, '')
}

export function PlotSettingsPanel({
  className,
  defaultCollapsed = false,
  height = 220,
}: PlotSettingsPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const [activeTab, setActiveTab] = useState('appearance')

  const activePlot = usePlotsStore((state) => state.getActivePlot())
  const updatePlot = usePlotsStore((state) => state.updatePlot)
  const template = activePlot ? getPlotTemplate(activePlot.type) : null

  const layout = useMemo<Partial<Layout>>(() => {
    return (activePlot?.plotlyLayout as Partial<Layout>) ?? {}
  }, [activePlot])

  const plotData = useMemo<Data[]>(() => {
    return (activePlot?.plotlyData as Data[]) ?? []
  }, [activePlot])

  const gridUserSet = Boolean(
    (layout as { meta?: { gridUserSet?: boolean } }).meta?.gridUserSet
  )
  const meansType =
    (layout as { meta?: { meansType?: string; means_type?: string } }).meta?.meansType ??
    (layout as { meta?: { meansType?: string; means_type?: string } }).meta?.means_type
  const isEstimatedMeans = meansType === 'lsmean'

  // Error bar type restrictions per test type
  const isKruskalBar =
    activePlot?.sourceType === 'test_result' &&
    normalizeTestId(activePlot.testType ?? '') === 'kruskal_wallis' &&
    activePlot.type === 'bar'

  const isSRHBar =
    activePlot?.sourceType === 'test_result' &&
    normalizeTestId(activePlot.testType ?? '') === 'scheirer_ray_hare' &&
    activePlot.type === 'grouped_bar'

  const normalizedTestType = activePlot?.testType
    ? normalizeTestId(activePlot.testType)
    : undefined

  const isOneWayBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'anova_one_way' &&
    (activePlot.type === 'bar' || activePlot.type === 'grouped_bar')

  // T-tests: parametric tests showing means - IQR not valid
  const isTTestBar =
    activePlot?.sourceType === 'test_result' &&
    (normalizedTestType === 't_test_two_sample' ||
      normalizedTestType === 't_test_paired' ||
      normalizedTestType === 't_test_one_sample') &&
    activePlot.type === 'bar'

  const isTwoWayBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'anova_two_way' &&
    (activePlot.type === 'bar' || activePlot.type === 'grouped_bar')

  const isMultifactorialBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'multifactorial_anova' &&
    (activePlot.type === 'bar' || activePlot.type === 'grouped_bar')

  // Mann-Whitney: non-parametric test showing medians - IQR only
  const isMannWhitneyBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'mann_whitney_u' &&
    activePlot.type === 'bar'

  const isMannWhitneyColumnScatter =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'mann_whitney_u' &&
    activePlot.type === 'column_scatter'

  const isTTestColumnScatter =
    activePlot?.sourceType === 'test_result' &&
    (normalizedTestType === 't_test_two_sample' ||
      normalizedTestType === 't_test_paired' ||
      normalizedTestType === 't_test_one_sample') &&
    activePlot.type === 'column_scatter'

  const isColumnScatter = activePlot?.type === 'column_scatter'

  // Policy: Lock error bar options based on statistical validity
  // - Kruskal-Wallis/SRH/Mann-Whitney: IQR only (non-parametric, shows medians)
  // - T-tests: SE, SD, CI (parametric, shows means - IQR not valid)
  // - One-Way ANOVA: SE only (pooled error; lock out SD/CI)
  // - Two-Way ANOVA: SE only (pooled error; lock out SD/CI)
  // - Multifactorial: SE only (pooled error; lock out SD/CI)
  // - T-test Column Scatter: SE, SD, CI (parametric, shows means)
  // - Mann-Whitney Column Scatter: IQR only (non-parametric, shows medians)
  // - Default: all options
  const allowedErrorBarTypes: Array<'se' | 'sd' | 'ci' | 'iqr' | 'none'> = (isKruskalBar || isSRHBar || isMannWhitneyBar || isMannWhitneyColumnScatter)
    ? ['iqr', 'none']
    : (isOneWayBar || isTwoWayBar || isMultifactorialBar)
      ? ['se', 'none']
      : isEstimatedMeans
        ? ['se', 'ci', 'none']
        : isTTestBar || isTTestColumnScatter || isColumnScatter
          ? ['se', 'sd', 'ci', 'none']
          : ['se', 'sd', 'ci', 'iqr', 'none']
  const defaultErrorBarType: 'se' | 'sd' | 'ci' | 'iqr' = (isKruskalBar || isSRHBar || isMannWhitneyBar || isMannWhitneyColumnScatter) ? 'iqr' : 'se'
  const rawErrorBarType =
    ((layout as any).meta?.errorBarType as 'se' | 'sd' | 'ci' | 'iqr' | 'none' | undefined) ??
    defaultErrorBarType
  const currentErrorBarType = allowedErrorBarTypes.includes(rawErrorBarType)
    ? rawErrorBarType
    : defaultErrorBarType
  const selectableErrorBarTypes = allowedErrorBarTypes.filter(
    (type): type is 'se' | 'sd' | 'ci' | 'iqr' => type !== 'none'
  )
  const displayedErrorBarType: 'se' | 'sd' | 'ci' | 'iqr' =
    currentErrorBarType === 'none'
      ? selectableErrorBarTypes[0] ?? defaultErrorBarType
      : currentErrorBarType
  const errorBarTypeLabels: Record<'se' | 'sd' | 'ci' | 'iqr', string> = {
    se: 'Standard Error (SE)',
    sd: 'Standard Deviation (SD)',
    ci: '95% Confidence Interval',
    iqr: 'Interquartile Range (IQR)',
  }

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed)
  }

  const updateLayout = (updates: Partial<Layout>) => {
    if (!activePlot) return
    updatePlot(activePlot.id, {
      plotlyLayout: {
        ...layout,
        ...updates,
      },
    })
  }

  const updateAxisTitle = (axis: 'xaxis' | 'yaxis', title: string) => {
    if (!activePlot) return
    const currentAxis = (layout[axis] as Partial<Layout['xaxis']>) ?? {}
    // Strip HTML tags to store clean text only
    const cleanTitle = stripHtmlTags(title)
    updateLayout({
      [axis]: {
        ...currentAxis,
        title: {
          ...(typeof currentAxis.title === 'object' ? currentAxis.title : {}),
          text: cleanTitle,
        },
      },
    })
  }

  const updateGrid = (axis: 'xaxis' | 'yaxis', showGrid: boolean) => {
    if (!activePlot) return
    const currentAxis = (layout[axis] as Partial<Layout['xaxis']>) ?? {}
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    updateLayout({
      [axis]: {
        ...currentAxis,
        showgrid: showGrid,
      },
      meta: { ...currentMeta, gridUserSet: true },
    })
  }

  const updateLegend = (show: boolean) => {
    if (!activePlot) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    updateLayout({
      showlegend: show,
      meta: { ...currentMeta, legendUserSet: true },
    })
  }

  const updateTitle = (title: string) => {
    if (!activePlot) return
    // Strip HTML tags to store clean text only
    const cleanTitle = stripHtmlTags(title)
    updatePlot(activePlot.id, { title: cleanTitle })
    const currentTitle = layout.title
    updateLayout({
      title: {
        ...(typeof currentTitle === 'object' ? currentTitle : {}),
        text: cleanTitle,
      },
    })
  }

  const updateTitleFontWeight = (weight: number) => {
    if (!activePlot) return
    const currentTitle = layout.title
    updateLayout({
      title: {
        ...(typeof currentTitle === 'object'
          ? currentTitle
          : currentTitle
            ? { text: currentTitle }
            : {}),
        font: {
          ...(typeof currentTitle === 'object' && typeof currentTitle.font === 'object'
            ? currentTitle.font
            : {}),
          weight,
        },
      },
    })
  }

  const updateAxisFontWeight = (axis: 'xaxis' | 'yaxis', weight: number) => {
    if (!activePlot) return
    const currentAxis = (layout[axis] as Partial<Layout['xaxis']>) ?? {}
    const currentTitle = currentAxis.title
    updateLayout({
      [axis]: {
        ...currentAxis,
        title: {
          ...(typeof currentTitle === 'object'
            ? currentTitle
            : currentTitle
              ? { text: currentTitle }
              : {}),
          font: {
            ...(typeof currentTitle === 'object' && typeof currentTitle.font === 'object'
              ? currentTitle.font
              : {}),
            weight,
          },
        },
      },
    })
  }

  const updateTickFontWeight = (axis: 'xaxis' | 'yaxis', weight: number) => {
    if (!activePlot) return
    const currentAxis = (layout[axis] as Partial<Layout['xaxis']>) ?? {}
    updateLayout({
      [axis]: {
        ...currentAxis,
        tickfont: {
          ...(typeof currentAxis.tickfont === 'object' ? currentAxis.tickfont : {}),
          weight,
        },
      },
    })
  }

  const updateAnnotation = (name: string, text: string) => {
    if (!activePlot) return
    const annotations = Array.isArray(layout.annotations) ? [...layout.annotations] : []
    const index = annotations.findIndex((a) => typeof a === 'object' && (a as any).name === name)

    if (text.trim().length === 0) {
      if (index >= 0) annotations.splice(index, 1)
    } else if (index >= 0) {
      annotations[index] = { ...(annotations[index] as object), text }
    } else {
      const base = name === 'figure_label'
        ? { x: 0, y: 1.12, xanchor: 'left', yanchor: 'bottom', font: { size: 12, color: '#000' } }
        : { x: -0.06, y: 1.02, xanchor: 'left', yanchor: 'top', font: { size: 16, color: '#000' } }

      annotations.push({
        name,
        text,
        xref: 'paper',
        yref: 'paper',
        showarrow: false,
        ...base,
      })
    }

    updateLayout({
      annotations,
      margin: {
        t: 60,
        r: 40,
        b: 50,
        l: 60,
        ...(layout.margin ?? {}),
      },
    })
  }

  const toggleErrorBars = (visible: boolean) => {
    if (!activePlot) return
    const updated = plotData.map((trace) => {
      const next = { ...trace } as Data & { error_y?: any; error_x?: any }
      if (next.error_y) next.error_y = { ...next.error_y, visible }
      if (next.error_x) next.error_x = { ...next.error_x, visible }
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  const figureLabel = useMemo(() => {
    const annotations = Array.isArray(layout.annotations) ? layout.annotations : []
    const match = annotations.find((a) => typeof a === 'object' && (a as any).name === 'figure_label')
    return typeof match === 'object' && (match as any).text ? String((match as any).text) : ''
  }, [layout])

  const panelLabel = useMemo(() => {
    const annotations = Array.isArray(layout.annotations) ? layout.annotations : []
    const match = annotations.find((a) => typeof a === 'object' && (a as any).name === 'panel_label')
    return typeof match === 'object' && (match as any).text ? String((match as any).text) : ''
  }, [layout])

  if (!activePlot) {
    return (
      <div
        className={cn('border-t bg-card/50', className)}
        style={{ height: isCollapsed ? 36 : height }}
      >
        <div
          className="flex items-center justify-between px-3 py-1.5 border-b cursor-pointer hover:bg-muted/30"
          onClick={toggleCollapse}
          role="button"
          tabIndex={0}
        >
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Plot Settings</span>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6">
            {isCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
        {!isCollapsed && (
          <div className="p-3 text-center text-sm text-muted-foreground">
            Select a plot to configure settings
          </div>
        )}
      </div>
    )
  }

  const legendState = useMemo(
    () => getEffectiveShowLegend(layout, plotData),
    [layout, plotData]
  )

  return (
    <div
      className={cn('border-t bg-card transition-all duration-200 overflow-hidden', className)}
      style={{ height: isCollapsed ? 36 : height }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b cursor-pointer hover:bg-muted/30"
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleCollapse()
          }
        }}
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand settings' : 'Collapse settings'}
      >
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Plot Settings</span>
          <span className="text-xs text-muted-foreground">
            ({template?.displayName || activePlot.type})
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6">
          {isCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {!isCollapsed && (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-[calc(100%-36px)]">
          <TabsList className="w-full justify-start h-9 px-2 rounded-none border-b bg-transparent">
            <TabsTrigger value="appearance" className="text-xs data-[state=active]:bg-muted">
              <Palette className="h-3.5 w-3.5 mr-1.5" />
              Appearance
            </TabsTrigger>
            <TabsTrigger value="axes" className="text-xs data-[state=active]:bg-muted">
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Axes
            </TabsTrigger>
            <TabsTrigger value="legend" className="text-xs data-[state=active]:bg-muted">
              <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />
              Legend
            </TabsTrigger>
            <TabsTrigger value="annotations" className="text-xs data-[state=active]:bg-muted">
              <TextCursorInput className="h-3.5 w-3.5 mr-1.5" />
              Labels
            </TabsTrigger>
            <TabsTrigger value="data" className="text-xs data-[state=active]:bg-muted">
              <Database className="h-3.5 w-3.5 mr-1.5" />
              Data
            </TabsTrigger>
          </TabsList>

          <ScrollArea className="h-[calc(100%-36px)]">
            <TabsContent value="appearance" className="p-3 m-0">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Type className="h-4 w-4 text-muted-foreground" />
                  <Label className="text-sm">Title</Label>
                </div>
                <Input
                  value={stripHtmlTags(activePlot.title)}
                  onChange={(e) => updateTitle(e.target.value)}
                  placeholder="Plot title"
                />
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Title Font Weight</Label>
                  <Select
                    value={String(
                      (typeof layout.title === 'object' &&
                      typeof layout.title.font === 'object'
                        ? (layout.title.font as any).weight
                        : undefined) ?? 700
                    )}
                    onValueChange={(value) => updateTitleFontWeight(Number(value))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Bold" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="300">Light (300)</SelectItem>
                      <SelectItem value="400">Normal (400)</SelectItem>
                      <SelectItem value="500">Medium (500)</SelectItem>
                      <SelectItem value="600">Semi Bold (600)</SelectItem>
                      <SelectItem value="700">Bold (700)</SelectItem>
                      <SelectItem value="800">Extra Bold (800)</SelectItem>
                      <SelectItem value="900">Black (900)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Paper Background</Label>
                    <Input
                      type="color"
                      value={String(layout.paper_bgcolor ?? '#ffffff')}
                      onChange={(e) => updateLayout({ paper_bgcolor: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Plot Background</Label>
                    <Input
                      type="color"
                      value={String(layout.plot_bgcolor ?? '#ffffff')}
                      onChange={(e) => updateLayout({ plot_bgcolor: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="axes" className="p-3 m-0">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">X Axis Title</Label>
                  <Input
                    value={stripHtmlTags(String((layout.xaxis as any)?.title?.text ?? ''))}
                    onChange={(e) => updateAxisTitle('xaxis', e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Title Weight</Label>
                      <Select
                        value={String(
                          (typeof (layout.xaxis as any)?.title === 'object' &&
                          typeof (layout.xaxis as any)?.title?.font === 'object'
                            ? (layout.xaxis as any).title.font.weight
                            : undefined) ?? 700
                        )}
                        onValueChange={(value) =>
                          updateAxisFontWeight('xaxis', Number(value))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="300">Light</SelectItem>
                          <SelectItem value="400">Normal</SelectItem>
                          <SelectItem value="500">Medium</SelectItem>
                          <SelectItem value="600">Semi Bold</SelectItem>
                          <SelectItem value="700">Bold</SelectItem>
                          <SelectItem value="800">Extra Bold</SelectItem>
                          <SelectItem value="900">Black</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Tick Weight</Label>
                      <Select
                        value={String(
                          (typeof (layout.xaxis as any)?.tickfont === 'object'
                            ? (layout.xaxis as any).tickfont.weight
                            : undefined) ?? 700
                        )}
                        onValueChange={(value) =>
                          updateTickFontWeight('xaxis', Number(value))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="300">Light</SelectItem>
                          <SelectItem value="400">Normal</SelectItem>
                          <SelectItem value="500">Medium</SelectItem>
                          <SelectItem value="600">Semi Bold</SelectItem>
                          <SelectItem value="700">Bold</SelectItem>
                          <SelectItem value="800">Extra Bold</SelectItem>
                          <SelectItem value="900">Black</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={
                        gridUserSet ? ((layout.xaxis as any)?.showgrid ?? false) : false
                      }
                      onCheckedChange={(checked) => updateGrid('xaxis', checked)}
                    />
                    <span className="text-xs text-muted-foreground">Show grid</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Y Axis Title</Label>
                  <Input
                    value={stripHtmlTags(String((layout.yaxis as any)?.title?.text ?? ''))}
                    onChange={(e) => updateAxisTitle('yaxis', e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Title Weight</Label>
                      <Select
                        value={String(
                          (typeof (layout.yaxis as any)?.title === 'object' &&
                          typeof (layout.yaxis as any)?.title?.font === 'object'
                            ? (layout.yaxis as any).title.font.weight
                            : undefined) ?? 700
                        )}
                        onValueChange={(value) =>
                          updateAxisFontWeight('yaxis', Number(value))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="300">Light</SelectItem>
                          <SelectItem value="400">Normal</SelectItem>
                          <SelectItem value="500">Medium</SelectItem>
                          <SelectItem value="600">Semi Bold</SelectItem>
                          <SelectItem value="700">Bold</SelectItem>
                          <SelectItem value="800">Extra Bold</SelectItem>
                          <SelectItem value="900">Black</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Tick Weight</Label>
                      <Select
                        value={String(
                          (typeof (layout.yaxis as any)?.tickfont === 'object'
                            ? (layout.yaxis as any).tickfont.weight
                            : undefined) ?? 700
                        )}
                        onValueChange={(value) =>
                          updateTickFontWeight('yaxis', Number(value))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="300">Light</SelectItem>
                          <SelectItem value="400">Normal</SelectItem>
                          <SelectItem value="500">Medium</SelectItem>
                          <SelectItem value="600">Semi Bold</SelectItem>
                          <SelectItem value="700">Bold</SelectItem>
                          <SelectItem value="800">Extra Bold</SelectItem>
                          <SelectItem value="900">Black</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={
                        gridUserSet ? ((layout.yaxis as any)?.showgrid ?? false) : false
                      }
                      onCheckedChange={(checked) => updateGrid('yaxis', checked)}
                    />
                    <span className="text-xs text-muted-foreground">Show grid</span>
                  </div>
                </div>

                {/* Error Bar Type */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Error Bar Type</Label>
                  <Select
                    value={displayedErrorBarType}
                    onValueChange={(value) => {
                      const currentMeta = (layout as any).meta ?? {}
                      const nextType = allowedErrorBarTypes.includes(value as any)
                        ? value
                        : defaultErrorBarType
                      updateLayout({
                        ...layout,
                        meta: {
                          ...currentMeta,
                          errorBarType: nextType,
                        },
                      })
                    }}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {selectableErrorBarTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {errorBarTypeLabels[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="legend" className="p-3 m-0">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={legendState.showLegend}
                    onCheckedChange={(checked) => updateLegend(checked)}
                  />
                  <span className="text-sm">Show legend</span>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="annotations" className="p-3 m-0">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <TextCursorInput className="h-4 w-4 text-muted-foreground" />
                  <Label className="text-sm">Figure and panel labels</Label>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Figure label (e.g., Fig. 8)</Label>
                  <Input
                    value={figureLabel}
                    onChange={(e) => updateAnnotation('figure_label', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Panel label (e.g., A)</Label>
                  <Input
                    value={panelLabel}
                    onChange={(e) => updateAnnotation('panel_label', e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Error bars</span>
                  <Switch
                    checked={plotData.some((trace) => {
                      const t = trace as any
                      const ey = t.error_y
                      const ex = t.error_x
                      // Default to on when error bars exist unless explicitly hidden
                      const eyOn = ey && ey.visible !== false
                      const exOn = ex && ex.visible !== false
                      return Boolean(eyOn || exOn)
                    })}
                    onCheckedChange={toggleErrorBars}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="data" className="p-3 m-0">
              <div className="space-y-2 text-xs text-muted-foreground">
                <div>Data policy: {activePlot.dataPolicy}</div>
                {activePlot.samplingConfig && (
                  <div>
                    Sampled: {activePlot.samplingConfig.sampleSize.toLocaleString()} rows
                  </div>
                )}
                {activePlot.aggregationConfig && (
                  <div>Aggregated by: {activePlot.aggregationConfig.groupBy.join(', ')}</div>
                )}
                {!activePlot.samplingConfig && !activePlot.aggregationConfig && (
                  <div>Sampling: none</div>
                )}
              </div>
            </TabsContent>
          </ScrollArea>
        </Tabs>
      )}
    </div>
  )
}

export default PlotSettingsPanel
