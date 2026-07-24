/**
 * Plot Icon Mapping
 *
 * Centralizes icon mapping for plot types, supporting:
 * - Lucide icons (most icons)
 * - Custom SVG icons (box, line, stacked bar, violin)
 */

import type { SVGProps } from 'react'
import {
  ScatterChart,
  TrendingUp,
  BarChart2,
  BarChart3,
  BarChart4,
  PieChart,
  GitBranchPlus,
  GitMerge,
  GitBranch,
  GitCommitHorizontal,
  Activity,
  Grid3X3,
  Grid2X2,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react'
import {
  BoxPlotIcon,
  GroupedBarIcon,
  LinePlotIcon,
  StackedBarPlotIcon,
  ViolinPlotIcon,
} from '@/components/icons'

// Union type for all icon components
export type PlotIconComponent =
  | LucideIcon
  | ((props: SVGProps<SVGSVGElement>) => React.JSX.Element)

/**
 * Map icon names (from plotRegistry) to React components
 */
export const PLOT_ICON_MAP: Record<string, PlotIconComponent> = {
  // Custom Icons
  BoxPlotIcon,
  GroupedBarIcon,
  LinePlotIcon,
  StackedBarPlotIcon,
  ViolinPlotIcon,

  // Lucide Icons
  ScatterChart,
  TrendingUp,
  BarChart2,
  BarChart3,
  BarChart4,
  PieChart,
  GitBranchPlus,
  GitMerge,
  GitBranch,
  GitCommitHorizontal,
  Activity,
  Grid3X3,
  Grid2X2,
  LayoutGrid,
}

/**
 * Get icon component by name (fallback to BarChart2 if not found)
 */
export function getPlotIcon(iconName: string | undefined): PlotIconComponent {
  if (!iconName) return BarChart2
  return PLOT_ICON_MAP[iconName] ?? BarChart2
}
