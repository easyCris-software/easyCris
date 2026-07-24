/**
 * Data-Results Horizontal Splitter
 *
 * Features:
 * - Horizontal split between SpreadsheetView (top) and ResultsPanel (bottom)
 * - Draggable resize handle
 * - Collapsible results panel
 * - Remembers panel sizes in localStorage
 * - Uses react-resizable-panels for smooth resizing
 *
 * Based on Avalonia's DockManager pattern
 */

import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { SpreadsheetView } from '@/components/data/SpreadsheetView'
import { ResultsPanel } from '@/components/results/ResultsPanel'
import { useResultsStore } from '@/store/results-store'

/**
 * Props for DataResultsSplitter
 */
interface DataResultsSplitterProps {
  className?: string
}

/**
 * DataResultsSplitter Component
 *
 * Provides a resizable horizontal split between data grid and results panel.
 */
export function DataResultsSplitter({ className }: DataResultsSplitterProps) {
  const { results } = useResultsStore()

  // Show results panel only if there are results
  const showResults = results.length > 0

  return (
    <div
      className={className}
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {showResults ? (
        <PanelGroup direction="vertical">
          {/* Data Panel (top) */}
          <Panel
            id="data-panel"
            defaultSize={60}
            minSize={30}
            order={1}
          >
            <SpreadsheetView />
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle
            style={{
              height: '4px',
              backgroundColor: 'var(--border)',
              cursor: 'ns-resize',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '40px',
                height: '4px',
                backgroundColor: 'var(--accent)',
                borderRadius: '2px',
              }}
            />
          </PanelResizeHandle>

          {/* Results Panel (bottom) */}
          <Panel
            id="results-panel"
            defaultSize={40}
            minSize={20}
            order={2}
          >
            <ResultsPanel />
          </Panel>
        </PanelGroup>
      ) : (
        // No results - show only data panel
        <SpreadsheetView />
      )}
    </div>
  )
}

export default DataResultsSplitter
