/**
 * ResultsPanel Component
 *
 * Displays statistical test results in a structured format.
 * Phase 4 Fix: Wires results-store to actual UI display.
 *
 * Features:
 * - Shows list of completed test results
 * - Displays detailed statistics for each test
 * - Expandable result cards
 * - Export functionality (future)
 */

import { useState } from 'react'
import { useResultsStore, type TestResult, type ParameterValue } from '@/store/results-store'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, FileText, Check, X } from 'lucide-react'

interface ResultsPanelProps {
  className?: string
}

export function ResultsPanel({ className }: ResultsPanelProps) {
  const results = useResultsStore(state => state.results) as TestResult[]
  const clearResults = useResultsStore(state => state.clearResults)
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())

  const toggleExpanded = (resultId: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev)
      if (next.has(resultId)) {
        next.delete(resultId)
      } else {
        next.add(resultId)
      }
      return next
    })
  }

  if (results.length === 0) {
    return (
      <div className={cn('flex flex-col h-full items-center justify-center', className)}>
        <FileText className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium text-foreground">No Results Yet</h3>
        <p className="text-sm text-muted-foreground mt-2 text-center max-w-md">
          Run a statistical test to see results here.
          Select a test from the Analysis menu and choose your data columns.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h2 className="text-lg font-semibold">Test Results</h2>
        <button
          onClick={() => clearResults()}
          className="text-sm text-muted-foreground hover:text-destructive transition-colors"
        >
          Clear All
        </button>
      </div>

      {/* Results List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {results.map((result: TestResult) => {
          const isExpanded = expandedResults.has(result.id)
          const isSignificant = result.statistics.pValue !== undefined && result.statistics.pValue < 0.05
          const hasParameters = Boolean(result.parameters && Object.keys(result.parameters).length > 0)
          const hasSummary = Boolean(result.summary && Object.keys(result.summary).length > 0)
          const hasRawOutput = result.rawOutput !== undefined && result.rawOutput !== null

          return (
            <div
              key={result.id}
              className="border rounded-lg bg-card shadow-sm"
            >
              {/* Result Header */}
              <button
                onClick={() => toggleExpanded(result.id)}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent/50 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{result.testName}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
                      {result.family}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(result.executedAt).toLocaleString()}
                  </div>
                </div>

                {/* Significance Indicator */}
                <div className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium',
                  isSignificant
                    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                )}>
                  {isSignificant ? (
                    <>
                      <Check className="h-3 w-3" />
                      Significant
                    </>
                  ) : (
                    <>
                      <X className="h-3 w-3" />
                      Not Significant
                    </>
                  )}
                </div>
              </button>

              {/* Expanded Content */}
              {isExpanded && (
                <div className="border-t px-4 py-3 space-y-4">
                  {/* Key Statistics */}
                  <div>
                    <h4 className="text-sm font-medium mb-2">Statistics</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {result.statistics.statistic !== undefined && (
                        <StatBox
                          label="Test Statistic"
                          value={result.statistics.statistic.toFixed(4)}
                        />
                      )}
                      {result.statistics.pValue !== undefined && (
                        <StatBox
                          label="p-value"
                          value={result.statistics.pValue < 0.001 ? '< 0.001' : result.statistics.pValue.toFixed(4)}
                          highlight={result.statistics.pValue < 0.05}
                        />
                      )}
                      {result.statistics.degreesOfFreedom !== undefined && (
                        <StatBox
                          label="df"
                          value={result.statistics.degreesOfFreedom.toString()}
                        />
                      )}
                      {result.statistics.effectSize !== undefined && (
                        <StatBox
                          label="Effect Size"
                          value={result.statistics.effectSize.toFixed(4)}
                        />
                      )}
                    </div>
                  </div>

                  {/* Parameters Used */}
                  {hasParameters ? (
                    <ParametersDisplay parameters={result.parameters!} />
                  ) : null}

                  {/* Summary */}
                  {hasSummary ? (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Summary</h4>
                      <div className="text-sm space-y-1">
                        {Object.entries(result.summary!).map(([key, value]) => (
                          <div key={key} className="flex justify-between">
                            <span className="text-muted-foreground">{key}</span>
                            <span className="font-medium">{String(value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Raw Output (collapsible) */}
                  {hasRawOutput ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        View Raw Output
                      </summary>
                      <pre className="mt-2 p-2 bg-muted rounded-md overflow-x-auto">
                        {JSON.stringify(result.rawOutput, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Format a parameter value to a string for display
 * Handles recursive array formatting
 */
const formatParamValue = (value: ParameterValue): string => {
  if (Array.isArray(value)) return value.map(formatParamValue).join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

interface ParametersDisplayProps {
  parameters: Record<string, ParameterValue>
}

function ParametersDisplay({ parameters }: ParametersDisplayProps) {
  const entries = Object.entries(parameters)
  if (entries.length === 0) return null

  return (
    <div>
      <h4 className="text-sm font-medium mb-2">Parameters</h4>
      <div className="text-sm text-muted-foreground">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <span className="font-mono">{key}:</span>
            <span>{formatParamValue(value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface StatBoxProps {
  label: string
  value: string
  highlight?: boolean
}

function StatBox({ label, value, highlight }: StatBoxProps) {
  return (
    <div className={cn(
      'p-2 rounded-md text-center',
      highlight
        ? 'bg-green-50 dark:bg-green-900/20'
        : 'bg-muted'
    )}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        'text-lg font-mono font-medium',
        highlight && 'text-green-600 dark:text-green-400'
      )}>
        {value}
      </div>
    </div>
  )
}

export default ResultsPanel
