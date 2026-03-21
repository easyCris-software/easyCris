/**
 * Re-Link Source Dialog - Phase 8 + Phase 2 Enhancement
 *
 * Displayed when loading a project with large datasets and:
 * 1. Source file is missing (SourceFileMissing)
 * 2. Source file was modified (SourceFileModified)
 * 3. DuckDB cache file is missing (Phase 2)
 * 4. Both DuckDB and source files are missing (Phase 2)
 *
 * Allows user to:
 * - Browse for new file location (source or DuckDB)
 * - Re-import modified file (applies overlay edits)
 * - Use source file fallback (when DuckDB missing - loses edits)
 * - Skip dataset (load project without it)
 * - Cancel (abort project load)
 */

import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { AlertTriangle, FileQuestion, RefreshCw, FolderOpen, SkipForward, XCircle, Database } from 'lucide-react'

export type RelinkReason = 'missing' | 'modified' | 'duckdb-missing' | 'both-missing'

export interface RelinkSourceDialogProps {
  isOpen: boolean
  datasetName: string
  originalPath: string
  reason: RelinkReason
  expectedHash?: string
  actualHash?: string
  // Phase 2: DuckDB support
  duckdbPath?: string // Original DuckDB path (for duckdb-missing reason)
  sourcePath?: string // Original source path (for both-missing reason)
  onRelink: (newPath: string, fileType?: 'source' | 'duckdb') => void
  onRelinkDuckDB?: (newPath: string) => void // Browse for DuckDB file
  onUseFallback?: () => void // Use source file when DuckDB missing (loses edits)
  onReimport: () => void
  onSkip: () => void
  onCancel: () => void
}

export function RelinkSourceDialog({
  isOpen,
  datasetName,
  originalPath,
  reason,
  duckdbPath,
  sourcePath,
  onRelink,
  onRelinkDuckDB,
  onUseFallback,
  onReimport,
  onSkip,
  onCancel,
}: RelinkSourceDialogProps) {
  const [browsing, setBrowsing] = useState(false)

  if (!isOpen) return null

  const isDuckDBMissing = reason === 'duckdb-missing'
  const isBothMissing = reason === 'both-missing'
  const isSourceMissing = reason === 'missing'
  const isModified = reason === 'modified'

  const handleBrowse = async (fileType: 'source' | 'duckdb' = 'source') => {
    setBrowsing(true)
    try {
      const filters =
        fileType === 'duckdb'
          ? [
              { name: 'easyCris Data Files', extensions: ['ecpdb'] },
              { name: 'All Files', extensions: ['*'] },
            ]
          : [
              { name: 'Data Files', extensions: ['csv', 'tsv', 'parquet'] },
              { name: 'CSV Files', extensions: ['csv'] },
              { name: 'Parquet Files', extensions: ['parquet'] },
              { name: 'All Files', extensions: ['*'] },
            ]

      const selected = await open({
        multiple: false,
        filters,
        title:
          fileType === 'duckdb'
            ? `Select data file for "${datasetName}"`
            : `Select source file for "${datasetName}"`,
      })

      if (selected && typeof selected === 'string') {
        if (fileType === 'duckdb' && onRelinkDuckDB) {
          onRelinkDuckDB(selected)
        } else {
          onRelink(selected, fileType)
        }
      }
    } catch (error) {
      console.error('Error browsing for file:', error)
    } finally {
      setBrowsing(false)
    }
  }

  // Title and description based on reason
  let title: string
  let description: string
  let icon: typeof FileQuestion

  if (isDuckDBMissing) {
    title = 'Data File Not Found'
    description = `The data file for dataset "${datasetName}" was not found. Your edits may be in this file.`
    icon = Database
  } else if (isBothMissing) {
    title = 'Data and Source Files Not Found'
    description = `Neither the data file nor the source file for dataset "${datasetName}" could be found.`
    icon = FileQuestion
  } else if (isSourceMissing) {
    title = 'Source File Not Found'
    description = `The source file for dataset "${datasetName}" was not found at its original location.`
    icon = FileQuestion
  } else {
    title = 'Source File Modified'
    description = `The source file for dataset "${datasetName}" has been modified since it was imported.`
    icon = AlertTriangle
  }

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
          maxWidth: '500px',
          padding: '1.5rem',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', marginBottom: '1.5rem' }}>
          <div
            style={{
              padding: '0.75rem',
              borderRadius: '50%',
              backgroundColor:
                isDuckDBMissing || isBothMissing
                  ? 'rgba(59, 130, 246, 0.1)'
                  : isSourceMissing
                    ? 'rgba(239, 68, 68, 0.1)'
                    : 'rgba(245, 158, 11, 0.1)',
            }}
          >
            {icon === Database ? (
              <Database
                size={24}
                style={{ color: isDuckDBMissing || isBothMissing ? '#3b82f6' : '#ef4444' }}
              />
            ) : icon === AlertTriangle ? (
              <AlertTriangle size={24} style={{ color: '#f59e0b' }} />
            ) : (
              <FileQuestion size={24} style={{ color: '#ef4444' }} />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{title}</h2>
            <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {description}
            </p>
          </div>
        </div>

        {/* Original Path(s) */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: 'var(--background-secondary)',
            borderRadius: '6px',
            marginBottom: '1.5rem',
          }}
        >
          {/* Data file path (for duckdb-missing and both-missing) */}
          {(isDuckDBMissing || isBothMissing) && duckdbPath && (
            <div style={{ marginBottom: isBothMissing ? '0.75rem' : 0 }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                Data File Location:
              </div>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                }}
              >
                {duckdbPath}
              </div>
            </div>
          )}

          {/* Source Path (for both-missing) */}
          {isBothMissing && sourcePath && (
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                Source File Location:
              </div>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                }}
              >
                {sourcePath}
              </div>
            </div>
          )}

          {/* Default path (for missing and modified) */}
          {!isDuckDBMissing && !isBothMissing && (
            <>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                Original Location:
              </div>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                }}
              >
                {originalPath}
              </div>
            </>
          )}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {/* Re-import (only for modified files) */}
          {isModified && (
            <button
              onClick={onReimport}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1rem',
                backgroundColor: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={18} />
              Re-import Current File
            </button>
          )}

          {/* Browse for data file (for duckdb-missing and both-missing) */}
          {(isDuckDBMissing || isBothMissing) && (
            <button
              onClick={() => handleBrowse('duckdb')}
              disabled={browsing}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1rem',
                backgroundColor: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: browsing ? 'wait' : 'pointer',
                opacity: browsing ? 0.7 : 1,
              }}
            >
              <Database size={18} />
              {browsing ? 'Browsing...' : 'Browse for Data File...'}
            </button>
          )}

          {/* Browse for source file */}
          {(isSourceMissing || isBothMissing) && (
            <button
              onClick={() => handleBrowse('source')}
              disabled={browsing}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1rem',
                backgroundColor: isBothMissing ? 'var(--background-secondary)' : '#3b82f6',
                color: isBothMissing ? 'var(--text)' : 'white',
                border: isBothMissing ? '1px solid var(--border)' : 'none',
                borderRadius: '6px',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: browsing ? 'wait' : 'pointer',
                opacity: browsing ? 0.7 : 1,
              }}
            >
              <FolderOpen size={18} />
              {browsing ? 'Browsing...' : 'Browse for Source File...'}
            </button>
          )}

          {/* Modified - browse for new source location */}
          {isModified && (
            <button
              onClick={() => handleBrowse('source')}
              disabled={browsing}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--background-secondary)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: browsing ? 'wait' : 'pointer',
                opacity: browsing ? 0.7 : 1,
              }}
            >
              <FolderOpen size={18} />
              {browsing ? 'Browsing...' : 'Browse for File...'}
            </button>
          )}

          {/* Use source fallback (for duckdb-missing only) - WARNING about edit loss */}
          {isDuckDBMissing && onUseFallback && (
            <button
              onClick={onUseFallback}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1rem',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                color: '#f59e0b',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                borderRadius: '6px',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <AlertTriangle size={18} />
              Use Source File (Lose Edits)
            </button>
          )}

          {/* Skip dataset */}
          <button
            onClick={onSkip}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1rem',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <SkipForward size={18} />
            Skip This Dataset
          </button>

          {/* Cancel */}
          <button
            onClick={onCancel}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1rem',
              backgroundColor: 'transparent',
              color: '#ef4444',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '6px',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <XCircle size={18} />
            Cancel Project Load
          </button>
        </div>

        {/* Help Text */}
        <p
          style={{
            margin: '1rem 0 0 0',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            textAlign: 'center',
          }}
        >
          {isDuckDBMissing
            ? 'The data file contains your edits. Using the source file will lose these changes.'
            : isBothMissing
              ? 'Try to locate either the data file (preferred) or the original source file.'
              : isModified
                ? 'Re-importing will apply your saved edits to the current file contents.'
                : 'You can browse for the file in its new location, or skip to continue without this dataset.'}
        </p>
      </div>
    </div>
  )
}

export default RelinkSourceDialog
