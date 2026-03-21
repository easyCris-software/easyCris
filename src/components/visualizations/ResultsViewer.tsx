/**
 * ResultsViewer Component
 *
 * Displays statistical test results with integrated visualizations.
 * Connects to results-store to show:
 * - Test summary table
 * - Plotly interactive charts
 * - Diagnostic plots
 * - Export options
 */

import { useMemo } from 'react'
import { toast } from 'sonner'
import { PlotlyChart } from './PlotlyChart'
import { useResultsStore } from '@/store/results-store'
import type { Data } from 'plotly.js'
import { ScrollArea } from '@/components/ui/scroll-area'
import { tauriApi } from '@/services/tauriApi'

/**
 * Props for ResultsViewer
 */
interface ResultsViewerProps {
  /** Result ID to display */
  resultId?: string

  /** CSS class name */
  className?: string

  /** Width */
  width?: string | number

  /** Height */
  height?: string | number
}

/**
 * ResultsViewer Component
 *
 * Displays test results from results-store with integrated Plotly charts.
 */
export function ResultsViewer({
  resultId,
  className,
  width = '100%',
  height = '100%',
}: ResultsViewerProps) {
  const { currentResult, getResult } = useResultsStore()

  // Get the result to display (either from resultId or currentResult)
  const result = useMemo(() => {
    if (resultId) {
      return getResult(resultId)
    }
    return currentResult
  }, [resultId, currentResult, getResult])

  // Parse Plotly JSON from result
  const plotlyData = useMemo<Data[]>(() => {
    if (!result?.visualizations?.plotlyJson) return []

    try {
      // Backend returns plotlyJson as { data: Data[], layout: Layout }
      const plotlyObj =
        typeof result.visualizations.plotlyJson === 'string'
          ? JSON.parse(result.visualizations.plotlyJson)
          : result.visualizations.plotlyJson

      return plotlyObj.data || []
    } catch (error) {
      console.error('Failed to parse Plotly JSON:', error)
      return []
    }
  }, [result])

  const plotlyLayout = useMemo(() => {
    if (!result?.visualizations?.plotlyJson) return {}

    try {
      const plotlyObj =
        typeof result.visualizations.plotlyJson === 'string'
          ? JSON.parse(result.visualizations.plotlyJson)
          : result.visualizations.plotlyJson

      return plotlyObj.layout || {}
    } catch (error) {
      console.error('Failed to parse Plotly layout:', error)
      return {}
    }
  }, [result])

  // Handle export to HTML
  const handleExportHtml = async () => {
    if (!result) return

    try {
      const filePath = await tauriApi.saveFileDialog(undefined, [
        { name: 'HTML Files', extensions: ['html'] },
      ])

      if (!filePath) return

      await tauriApi.exportResultsHtml(result.id, filePath, true)

      console.log('Exported to:', filePath)
      toast.success('Results exported to HTML', { description: filePath })
    } catch (error) {
      console.error('Export failed:', error)
      toast.error('HTML export failed', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Handle export to CSV
  const handleExportCsv = async () => {
    if (!result) return

    try {
      const filePath = await tauriApi.saveFileDialog(undefined, [
        { name: 'CSV Files', extensions: ['csv'] },
      ])

      if (!filePath) return

      await tauriApi.exportResultsCsv(result.id, filePath)

      console.log('Exported to:', filePath)
      toast.success('Results exported to CSV', { description: filePath })
    } catch (error) {
      console.error('Export failed:', error)
      toast.error('CSV export failed', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Empty state
  if (!result) {
    return (
      <div
        className={className}
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ fontSize: '1.125rem', color: 'var(--text-muted)' }}>
          No results to display
        </p>
      </div>
    )
  }

  return (
    <div
      className={className}
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header with export buttons */}
      <div
        style={{
          padding: '0.75rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>
            {result.testName}
          </h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            {new Date(result.executedAt).toLocaleString()}
          </p>
        </div>
        <button
          onClick={handleExportCsv}
          style={{
            padding: '0.375rem 0.75rem',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          Export CSV
        </button>
        <button
          onClick={handleExportHtml}
          style={{
            padding: '0.375rem 0.75rem',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          Export HTML
        </button>
      </div>

      {/* Scrollable content */}
      <ScrollArea style={{ flex: 1 }}>
        <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Summary Table */}
          {result.summary && (
            <div>
              <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                Summary
              </h4>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '0.5rem',
                  overflow: 'hidden',
                }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {Object.entries(result.summary).map(([key, value]) => (
                      <tr
                        key={key}
                        style={{
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <td
                          style={{
                            padding: '0.5rem 0.75rem',
                            fontWeight: 600,
                            backgroundColor: 'var(--background-secondary)',
                          }}
                        >
                          {key}
                        </td>
                        <td
                          style={{
                            padding: '0.5rem 0.75rem',
                          }}
                        >
                          {typeof value === 'number'
                            ? value.toFixed(4)
                            : String(value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Plotly Charts */}
          {plotlyData.length > 0 && (
            <div>
              <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                Visualization
              </h4>
              <PlotlyChart
                data={plotlyData}
                layout={plotlyLayout}
                height={500}
                responsive={true}
              />
            </div>
          )}

          {/* Full Results Table */}
          {result.tables && result.tables.length > 0 && (
            <div>
              <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                Detailed Results
              </h4>
              {result.tables.map((table, tableIndex) => (
                <div
                  key={tableIndex}
                  style={{
                    marginBottom: '1rem',
                    border: '1px solid var(--border)',
                    borderRadius: '0.5rem',
                    overflow: 'auto',
                  }}
                >
                  {table.title && (
                    <div
                      style={{
                        padding: '0.5rem 0.75rem',
                        backgroundColor: 'var(--background-secondary)',
                        borderBottom: '1px solid var(--border)',
                        fontWeight: 600,
                      }}
                    >
                      {table.title}
                    </div>
                  )}
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    {table.headers && (
                      <thead>
                        <tr>
                          {table.headers.map((header, i) => (
                            <th
                              key={i}
                              style={{
                                padding: '0.5rem 0.75rem',
                                textAlign: 'left',
                                backgroundColor: 'var(--background-secondary)',
                                borderBottom: '1px solid var(--border)',
                              }}
                            >
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {table.data.map((row, rowIndex) => (
                        <tr
                          key={rowIndex}
                          style={{
                            borderBottom: '1px solid var(--border)',
                          }}
                        >
                          {row.map((cell, cellIndex) => (
                            <td
                              key={cellIndex}
                              style={{
                                padding: '0.5rem 0.75rem',
                              }}
                            >
                              {typeof cell === 'number' ? cell.toFixed(4) : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export default ResultsViewer
