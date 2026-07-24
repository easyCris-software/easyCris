/**
 * RNA-seq Components - Module exports
 *
 * Components for the RNA-seq differential expression analysis module.
 * Isolated from Statistics module to prevent cross-contamination.
 */

// Navigator section
export { RNAseqNavigatorSection } from './RNAseqNavigatorSection'

// Main workspace components
export { RNAseqWorkspace } from './RNAseqWorkspace'
export { RNAseqTabBar } from './RNAseqTabBar'
export { RNAseqPlotPanel } from './RNAseqPlotPanel'

// Dialogs
export { RNAseqDataImportDialog } from './RNAseqDataImportDialog'
export { DESeq2ConfigDialog } from './DESeq2ConfigDialog'

// Results display
export { DESeq2ResultsTable } from './DESeq2ResultsTable'

// Plot builders
export {
  buildVolcanoPlot,
  buildPCABiplot,
  buildMAPlot,
  buildDEGBarChart,
  type VolcanoPlotData,
  type PCABiplotData,
  type MAPlotData,
  type DEGBarChartData,
} from './plots'
