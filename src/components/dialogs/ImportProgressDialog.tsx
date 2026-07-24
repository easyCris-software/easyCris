/**
 * Import Progress Dialog
 *
 * Shows stage-based progress for large dataset imports (CSV/Parquet).
 * Displays progress bar with percentage and current stage message.
 */

import { Database } from 'lucide-react'

export interface ImportProgressDialogProps {
  isOpen: boolean
  datasetId: string
  percentage: number
  message: string
}

export function ImportProgressDialog({
  isOpen,
  percentage,
  message,
}: ImportProgressDialogProps) {
  if (!isOpen) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        zIndex: 9999,
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--background)',
          borderRadius: '8px',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)',
          width: '100%',
          maxWidth: '450px',
          padding: '1.5rem',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div
            style={{
              padding: '0.75rem',
              borderRadius: '50%',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
            }}
          >
            <Database size={24} style={{ color: '#3b82f6' }} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Importing Dataset</h2>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {message}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ marginBottom: '0.75rem' }}>
          <div
            style={{
              backgroundColor: 'var(--background-secondary)',
              borderRadius: '9999px',
              height: '12px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                backgroundColor: '#3b82f6',
                height: '100%',
                transition: 'width 0.3s ease-out',
                width: `${percentage}%`,
              }}
            />
          </div>
        </div>

        {/* Percentage */}
        <p
          style={{
            margin: 0,
            fontSize: '0.875rem',
            fontWeight: 500,
            textAlign: 'right',
            color: 'var(--text-muted)',
          }}
        >
          {percentage}%
        </p>
      </div>
    </div>
  )
}

export default ImportProgressDialog
