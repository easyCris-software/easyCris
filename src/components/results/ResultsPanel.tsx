/**
 * Results Panel - Displays statistical test results in collapsible accordions
 *
 * Features:
 * - Accordion-style collapsible panels for each result
 * - Single panel open at a time (store-driven via currentResult)
 * - Auto-expand latest result on load
 * - Integration with results-store
 *
 * No tabs/plots/export - single-purpose results display
 */

import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import { buildPlotSpecsFromResult } from '@/services/plotResultService'
import type { TestResult } from '@/store/results-store'
import { ECPTableView } from '@/components/results/ECPTableView'
import { ChevronDown, X, AlertTriangle, BarChart2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

/**
 * Props for ResultsPanel
 */
interface ResultsPanelProps {
  height?: string | number
  width?: string | number
  className?: string
}

/**
 * Format p-value with proper notation
 */
function formatPValue(p: number | null | undefined): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '-'
  if (p < 0.001) return '< 0.001'
  if (p < 0.01) return p.toFixed(3)
  return p.toFixed(4)
}

/**
 * Format number with appropriate precision
 */
function formatNumber(value: number | null | undefined, decimals = 3): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  if (Math.abs(value) < 0.001) return value.toExponential(2)
  return value.toFixed(decimals)
}

/**
 * ResultsPanel Component - Accordion display
 */
export function ResultsPanel({
  height = '100%',
  width = '100%',
  className,
}: ResultsPanelProps) {
  const { results, currentResult, setCurrentResult, removeResult } = useResultsStore(
    useShallow((state) => ({
      results: state.results,
      currentResult: state.currentResult,
      setCurrentResult: state.setCurrentResult,
      removeResult: state.removeResult,
    }))
  )
  const { addPlot, setPlotStats, getPlotsByResult, setActivePlot } = usePlotsStore(
    useShallow((state) => ({
      addPlot: state.addPlot,
      setPlotStats: state.setPlotStats,
      getPlotsByResult: state.getPlotsByResult,
      setActivePlot: state.setActivePlot,
    }))
  )

  // Auto-select latest result on initial load
  useEffect(() => {
    if (results.length > 0 && !currentResult) {
      const [latest] = results
      if (latest) {
        setCurrentResult(latest)
      }
    }
  }, [results, currentResult, setCurrentResult])

  // Toggle panel: if clicking current, collapse (null); otherwise expand
  const togglePanel = (result: TestResult) => {
    if (currentResult?.id === result.id) {
      setCurrentResult(null) // Collapse
    } else {
      setCurrentResult(result) // Expand & select
    }
  }

  const handleSavePlot = (result: TestResult) => {
    const existing = getPlotsByResult(result.id)
    if (existing.length > 0) {
      setActivePlot(existing[0]?.id ?? null)
      toast.info('Plot already saved for this result')
      return
    }

    const payloads = buildPlotSpecsFromResult(result)
    if (payloads.length === 0) {
      toast.error('No plot data available for this result')
      return
    }

    // Add all plots from recipe/builder
    for (const payload of payloads) {
      addPlot(payload.plot)
      if (Object.keys(payload.stats).length > 0) {
        setPlotStats(payload.plot.id, payload.stats)
      }
    }

    // Set first plot as active
    if (payloads[0]) {
      setActivePlot(payloads[0].plot.id)
    }

    const message = payloads.length === 1
      ? 'Plot saved to gallery'
      : `${payloads.length} plots saved to gallery`
    toast.success(message)
  }

  // Render empty state
  if (results.length === 0) {
    return (
      <div
        className={className}
        style={{
          height,
          width,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          backgroundColor: 'var(--background-secondary)',
          color: 'var(--text-muted)',
        }}
      >
        <p style={{ fontSize: '1rem' }}>No results yet</p>
        <p style={{ fontSize: '0.875rem' }}>Run a statistical test to see results here</p>
      </div>
    )
  }

  return (
    <div
      data-testid="results-panel"
      className={className}
      style={{
        height,
        width,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--background)',
      }}
    >
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
        {results.map((result) => (
          <AccordionPanel
            key={result.id}
            result={result}
            isExpanded={currentResult?.id === result.id}
            onToggle={() => togglePanel(result)}
            onRemove={() => removeResult(result.id)}
            onSavePlot={() => handleSavePlot(result)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Accordion Panel - Single collapsible result
 */
function AccordionPanel({
  result,
  isExpanded,
  onToggle,
  onRemove,
  onSavePlot,
}: {
  result: TestResult
  isExpanded: boolean
  onToggle: () => void
  onRemove: () => void
  onSavePlot: () => void
}) {
  return (
    <div
      style={{
        marginBottom: '0.5rem',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        backgroundColor: 'var(--background)',
        overflow: 'hidden',
      }}
    >
      {/* Accordion Header */}
      <div
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'stretch',
          backgroundColor: isExpanded ? 'var(--background-secondary)' : 'transparent',
          border: 'none',
          transition: 'background-color 0.2s',
        }}
      >
        <button
          onClick={onToggle}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1rem',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
              {result.testName}
            </h3>
            <p
              style={{
                margin: '0.25rem 0 0 0',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
              }}
            >
              {result.family} | {new Date(result.executedAt).toLocaleString()}
            </p>
          </div>
          <ChevronDown
            size={20}
            style={{
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              color: 'var(--text-muted)',
              marginLeft: '0.75rem',
            }}
          />
        </button>

        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation()
            onSavePlot()
          }}
          title="Save plot to gallery"
          className="self-center mr-1"
        >
          <BarChart2 className="h-4 w-4" />
        </Button>

        <button
          type="button"
          aria-label="Remove result"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            width: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
          }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Accordion Body (conditionally rendered) */}
      {isExpanded && (
        <div style={{ padding: '1rem', borderTop: '1px solid var(--border)' }}>
          <ResultContent result={result} />
        </div>
      )}
    </div>
  )
}

/**
 * Phase 7: Sampling Badge - Displayed when results are from sampled data
 */
function SamplingBadge({ metadata }: { metadata: NonNullable<TestResult['samplingMetadata']> }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.75rem',
        padding: '0.75rem 1rem',
        marginBottom: '1rem',
        borderRadius: '6px',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        border: '1px solid rgba(245, 158, 11, 0.3)',
      }}
    >
      <AlertTriangle
        size={20}
        style={{ color: '#f59e0b', flexShrink: 0, marginTop: '2px' }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: '#f59e0b', marginBottom: '0.25rem' }}>
          Sampled Analysis
        </div>
        <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          Results based on {metadata.sampleSize.toLocaleString()} of{' '}
          {metadata.totalRows.toLocaleString()} rows ({metadata.samplePercentage}% sample).
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
          {metadata.confidenceNote}
        </div>
      </div>
    </div>
  )
}

/**
 * Result Content - Detailed statistics display (from ResultsTab)
 */
function ResultContent({ result }: { result: TestResult }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Phase 7: Sampling badge for Tier 3 tests on large datasets */}
      {result.samplingMetadata?.isSampled && (
        <SamplingBadge metadata={result.samplingMetadata} />
      )}

      {/* Result header */}
      <div
        style={{
          borderBottom: '2px solid var(--border)',
          paddingBottom: '1rem',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.5rem' }}>{result.testName}</h2>
        <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          {result.family} | {new Date(result.executedAt).toLocaleString()}
        </p>
      </div>

      {/* Main statistics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        {result.statistics.statistic !== undefined && (
          <StatCard
            label="Test Statistic"
            value={formatNumber(result.statistics.statistic)}
          />
        )}
        {result.statistics.pValue !== undefined && (
          <StatCard
            label="P-Value"
            value={formatPValue(result.statistics.pValue)}
            highlight={result.statistics.pValue < 0.05}
          />
        )}
        {result.statistics.degreesOfFreedom !== undefined && (
          <StatCard label="df" value={result.statistics.degreesOfFreedom.toString()} />
        )}
        {result.statistics.effectSize !== undefined && (
          <StatCard label="Effect Size" value={formatNumber(result.statistics.effectSize)} />
        )}
        {result.statistics.confidenceInterval && (
          <StatCard
            label="95% CI"
            value={`[${formatNumber(result.statistics.confidenceInterval[0])}, ${formatNumber(result.statistics.confidenceInterval[1])}]`}
          />
        )}
      </div>

      {/* Model fit (regression/dose-response) */}
      {result.modelFit && (
        <div>
          <h3 style={{ fontSize: '1.125rem', marginBottom: '0.5rem' }}>Model Fit</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.75rem',
            }}
          >
            {result.modelFit.r2 !== undefined && (
              <StatCard label="R²" value={formatNumber(result.modelFit.r2)} dataStat="r_squared" />
            )}
            {result.modelFit.adjustedR2 !== undefined && (
              <StatCard
                label="Adj. R²"
                value={formatNumber(result.modelFit.adjustedR2)}
                dataStat="adj_r_squared"
              />
            )}
            {result.modelFit.rmse !== undefined && (
              <StatCard label="RMSE" value={formatNumber(result.modelFit.rmse)} dataStat="rmse" />
            )}
            {result.modelFit.aic !== undefined && (
              <StatCard label="AIC" value={formatNumber(result.modelFit.aic, 1)} dataStat="aic" />
            )}
          </div>
        </div>
      )}

      {/* Coefficients (regression) */}
      {(() => {
        if (result.family === 'pharmacology' || !result.coefficients || result.coefficients.length === 0) {
          return null
        }

        const meaningfulCoefficients = result.coefficients.filter((c) => {
          const name = (c.name ?? '').trim()
          if (!name || name === 'Unknown') return false
          const estimate = Number(c.estimate)
          const stdError = Number(c.stdError)
          const pValue = Number(c.pValue)
          const isAllZeros =
            (Number.isFinite(estimate) ? estimate === 0 : true) &&
            (Number.isFinite(stdError) ? stdError === 0 : true) &&
            (Number.isFinite(pValue) ? pValue === 0 : true)
          return !isAllZeros
        })

        if (meaningfulCoefficients.length === 0) return null

        return (
        <div>
          <h3 style={{ fontSize: '1.125rem', marginBottom: '0.5rem' }}>Coefficients</h3>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.875rem',
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Variable</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Estimate</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Std. Error</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>P-Value</th>
              </tr>
            </thead>
            <tbody>
              {meaningfulCoefficients.map((coef, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.5rem' }}>{coef.name}</td>
                  <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                    {formatNumber(coef.estimate)}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                    {formatNumber(coef.stdError)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      padding: '0.5rem',
                      color: coef.pValue < 0.05 ? '#10b981' : 'inherit',
                      fontWeight: coef.pValue < 0.05 ? 600 : 'normal',
                    }}
                  >
                    {formatPValue(coef.pValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )
      })()}

      {/* Assumptions */}
      {result.assumptions && result.assumptions.length > 0 && (
        <div>
          <h3 style={{ fontSize: '1.125rem', marginBottom: '0.5rem' }}>Assumptions</h3>
          {result.assumptions.map((assumption, idx) => (
            <div
              key={idx}
              style={{
                padding: '0.75rem',
                marginBottom: '0.5rem',
                borderRadius: '4px',
                border: `1px solid ${assumption.passed ? '#10b981' : '#ef4444'}`,
                backgroundColor: assumption.passed
                  ? 'rgba(16, 185, 129, 0.1)'
                  : 'rgba(239, 68, 68, 0.1)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                <strong>{assumption.name}</strong>
                <span style={{ color: assumption.passed ? '#10b981' : '#ef4444' }}>
                  {assumption.passed ? '✓ Passed' : '✗ Failed'}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {assumption.message} (p = {formatPValue(assumption.pValue)})
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Post-hoc (ANOVA) */}
      {result.postHoc && result.postHoc.length > 0 && (
        <div>
          <h3 style={{ fontSize: '1.125rem', marginBottom: '0.5rem' }}>Post-Hoc Comparisons</h3>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.875rem',
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Comparison</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Statistic</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>P-Value</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Adj. P-Value</th>
                <th style={{ textAlign: 'center', padding: '0.5rem' }}>Sig.</th>
              </tr>
            </thead>
            <tbody>
              {result.postHoc.map((ph, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.5rem' }}>{ph.comparison}</td>
                  <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                    {formatNumber(ph.statistic)}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                    {formatPValue(ph.pValue)}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                    {ph.pValueAdjusted ? formatPValue(ph.pValueAdjusted) : '-'}
                  </td>
                  <td
                    style={{
                      textAlign: 'center',
                      padding: '0.5rem',
                      color: ph.significant ? '#10b981' : 'var(--text-muted)',
                    }}
                  >
                    {ph.significant ? '✓' : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Publication-ready statistical tables */}
      {result.ecpTableCollection && result.ecpTableCollection.tables.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3 style={{ fontSize: '1.125rem', marginBottom: '0.75rem', borderBottom: '2px solid var(--border)', paddingBottom: '0.5rem' }}>
            Detailed Statistical Output
          </h3>
          <ECPTableView
            tableCollection={result.ecpTableCollection}
            showFootnotes={true}
            compact={false}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Stat Card - Single statistic display
 */
function StatCard({
  label,
  value,
  highlight = false,
  dataStat,
}: {
  label: string
  value: string
  highlight?: boolean
  dataStat?: string
}) {
  return (
    <div
      data-stat={dataStat}
      style={{
        padding: '1rem',
        borderRadius: '4px',
        border: `1px solid ${highlight ? '#10b981' : 'var(--border)'}`,
        backgroundColor: highlight ? 'rgba(16, 185, 129, 0.1)' : 'var(--background-secondary)',
      }}
    >
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '1.25rem',
          fontWeight: 600,
          color: highlight ? '#10b981' : 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  )
}

export default ResultsPanel

