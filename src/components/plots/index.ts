/**
 * Plots Components - Phase 2 Barrel Export
 *
 * Central export point for all plot-related components.
 *
 * Layout: [Gallery] | [PlotCanvas] | [PlotSidebar]
 */

// ============================================================================
// Main Panel
// ============================================================================

export { PlotsPanel } from './PlotsPanel'
export type { PlotsPanelProps } from './PlotsPanel'

// ============================================================================
// New Components (Phase 2 Redesign)
// ============================================================================

export { PlotCanvas } from './PlotCanvas'
export type { PlotCanvasProps } from './PlotCanvas'

export { PlotSidebar } from './PlotSidebar'
export type { PlotSidebarProps } from './PlotSidebar'

// ============================================================================
// Gallery & Dialogs
// ============================================================================

export { PlotGallery } from './PlotGallery'
export type { PlotGalleryProps } from './PlotGallery'

export { PlotThumbnail } from './PlotThumbnail'
export type { PlotThumbnailProps } from './PlotThumbnail'

export { CreatePlotDialog } from './CreatePlotDialog'
export type { CreatePlotDialogProps } from './CreatePlotDialog'

export { PlotTypeSelector } from './PlotTypeSelector'
export type { PlotTypeSelectorProps } from './PlotTypeSelector'

export { ColumnRoleDropdown } from './ColumnRoleDropdown'
export type { ColumnRoleDropdownProps } from './ColumnRoleDropdown'

// ============================================================================
// Legacy Components (kept for backward compatibility)
// ============================================================================

export { ActivePlotView } from './ActivePlotView'
export type { ActivePlotViewProps } from './ActivePlotView'

export { PlotSettingsPanel } from './PlotSettingsPanel'
export type { PlotSettingsPanelProps } from './PlotSettingsPanel'

export { LinkedDataTable } from './LinkedDataTable'
export type { LinkedDataTableProps } from './LinkedDataTable'
