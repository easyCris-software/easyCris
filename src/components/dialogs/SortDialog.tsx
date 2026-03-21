/**
 * Sort Dialog - Simple dialog for sorting data by column
 *
 * Features:
 * - Column selector dropdown
 * - Ascending/Descending direction radio buttons
 * - Clear sort button
 */

import { useState, useEffect } from 'react'
import type { ColumnMetadata } from '@/store/data-store'

interface SortDialogProps {
  isOpen: boolean
  onClose: () => void
  columns: ColumnMetadata[]
  currentSortColumn: string | null
  currentSortDirection: 'asc' | 'desc' | null
  onSort: (columnId: string, direction: 'asc' | 'desc') => void | Promise<void>
  onClearSort: () => void
}

export function SortDialog({
  isOpen,
  onClose,
  columns,
  currentSortColumn,
  currentSortDirection,
  onSort,
  onClearSort,
}: SortDialogProps) {
  const [selectedColumn, setSelectedColumn] = useState<string>(currentSortColumn || '')
  const [direction, setDirection] = useState<'asc' | 'desc'>(currentSortDirection || 'asc')

  // Update local state when props change
  useEffect(() => {
    if (currentSortColumn) {
      setSelectedColumn(currentSortColumn)
    }
    if (currentSortDirection) {
      setDirection(currentSortDirection)
    }
  }, [currentSortColumn, currentSortDirection])

  if (!isOpen) return null

  const handleApply = () => {
    if (selectedColumn) {
      onSort(selectedColumn, direction)
      onClose()
    }
  }

  const handleClear = () => {
    onClearSort()
    setSelectedColumn('')
    onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          padding: '24px',
          minWidth: '400px',
          maxWidth: '500px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 20px 0', fontSize: '18px', fontWeight: 600 }}>
          Sort Data
        </h2>

        <div style={{ marginBottom: '20px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            Sort by Column:
          </label>
          <select
            value={selectedColumn}
            onChange={(e) => setSelectedColumn(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: '14px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
            }}
          >
            <option value="">Select a column...</option>
            {columns.map((col) => (
              <option key={col.id} value={col.id}>
                {col.name} ({col.type})
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '24px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            Direction:
          </label>
          <div style={{ display: 'flex', gap: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="direction"
                value="asc"
                checked={direction === 'asc'}
                onChange={() => setDirection('asc')}
              />
              <span style={{ fontSize: '14px' }}>Ascending (A→Z, 0→9)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="direction"
                value="desc"
                checked={direction === 'desc'}
                onChange={() => setDirection('desc')}
              />
              <span style={{ fontSize: '14px' }}>Descending (Z→A, 9→0)</span>
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          {currentSortColumn && (
            <button
              onClick={handleClear}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                backgroundColor: 'white',
                cursor: 'pointer',
              }}
            >
              Clear Sort
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              backgroundColor: 'white',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!selectedColumn}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: selectedColumn ? '#3B82F6' : '#9CA3AF',
              color: 'white',
              cursor: selectedColumn ? 'pointer' : 'not-allowed',
            }}
          >
            Apply Sort
          </button>
        </div>
      </div>
    </div>
  )
}
