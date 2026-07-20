/**
 * Autocomplete Dropdown Component
 *
 * Reusable dropdown for displaying formula function suggestions.
 * Used by both formula bar and inline cell editor.
 */

import React from 'react'
import { createPortal } from 'react-dom'
import type { FunctionSuggestion } from '@/lib/grid/formulas/formulaService'
import { useTheme } from '@/hooks/use-theme'

export interface AutocompleteDropdownProps {
  suggestions: FunctionSuggestion[]
  selectedIndex: number
  position: { top: number; left: number; right?: number }
  onSelect: (index: number) => void
  onHover?: (index: number) => void
  /**
   * Positioning mode:
   * - 'fixed': Use viewport coordinates (for cell editor)
   * - 'absolute': Use relative coordinates (for formula bar)
   * @default 'fixed'
   */
  positionMode?: 'fixed' | 'absolute'
  /**
   * Use portal rendering (escapes parent overflow)
   * @default true
   */
  usePortal?: boolean
  /**
   * Optional signature/usage hint for the highlighted suggestion (legacy - kept for backwards compatibility)
   * @deprecated Use suggestions with inline signatures instead
   */
  signature?: string
  onInteractionStart?: () => void
  width?: number
  minWidth?: number
  maxWidth?: number
  maxHeight?: number
  hoverSuppressMs?: number
}

export const AutocompleteDropdown: React.FC<AutocompleteDropdownProps> = ({
  suggestions,
  selectedIndex,
  position,
  onSelect,
  onHover,
  positionMode = 'fixed',
  usePortal = true,
  signature,
  onInteractionStart,
  width,
  minWidth,
  maxWidth,
  maxHeight,
  hoverSuppressMs = 120,
}) => {
  const hoverSuppressedUntilRef = React.useRef(0)
  const { resolvedTheme } = useTheme()
  if (suggestions.length === 0) return null

  const palette =
    resolvedTheme === 'dark'
      ? {
          bg: '#0F172A',
          border: '#334155',
          rowBg: '#0F172A',
          rowBgSelected: '#1E293B',
          rowBorder: '#334155',
          text: '#E2E8F0',
          textStrong: '#F8FAFC',
          textMuted: '#94A3B8',
          separator: '#475569',
          signatureBg: '#111827',
          shadow: '0 12px 30px rgba(2, 6, 23, 0.5)',
        }
      : {
          bg: '#FFFFFF',
          border: '#CBD5E1',
          rowBg: '#FFFFFF',
          rowBgSelected: '#EFF6FF',
          rowBorder: '#E5E7EB',
          text: '#1E293B',
          textStrong: '#0F172A',
          textMuted: '#64748B',
          separator: '#CBD5E1',
          signatureBg: '#F8FAFC',
          shadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }

  const dropdown = (
    <div
      className="formula-autocomplete-dropdown click-outside-ignore"
      onWheel={() => {
        hoverSuppressedUntilRef.current = Date.now() + hoverSuppressMs
      }}
      style={{
        position: positionMode,
        top: positionMode === 'fixed' ? `${position.top}px` : position.top,
        left: positionMode === 'fixed' ? `${position.left}px` : position.left,
        right: position.right !== undefined
          ? (positionMode === 'fixed' ? `${position.right}px` : position.right)
          : undefined,
        width: width !== undefined ? `${Math.max(0, Math.round(width))}px` : undefined,
        minWidth: minWidth !== undefined ? `${Math.max(0, Math.round(minWidth))}px` : undefined,
        maxWidth: maxWidth !== undefined ? `${Math.max(0, Math.round(maxWidth))}px` : undefined,
        maxHeight: maxHeight !== undefined ? `${Math.max(0, Math.round(maxHeight))}px` : '200px',
        overflowY: 'auto',
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        boxShadow: palette.shadow,
        zIndex: 10000,
        cursor: 'default',
      }}
    >
      {suggestions.map((suggestion, index) => {
        // Check if this function has a proper signature (not just the name)
        const hasSignature = suggestion.signature !== suggestion.name

        return (
          <div
            key={suggestion.name}
            style={{
              padding: '8px 12px',
              cursor: 'default',
              backgroundColor: index === selectedIndex ? palette.rowBgSelected : palette.rowBg,
              borderBottom: index < suggestions.length - 1 ? `1px solid ${palette.rowBorder}` : 'none',
              fontSize: '13px',
              fontFamily: 'monospace',
              color: palette.text,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
            onMouseDown={(e) => {
              e.preventDefault() // Prevent blur
              e.stopPropagation()
              onInteractionStart?.()
              onSelect(index)
            }}
            onMouseEnter={() => {
              if (onHover && Date.now() >= hoverSuppressedUntilRef.current) {
                onHover(index)
              }
            }}
          >
            {hasSignature ? (
              <>
                {/* Hint (signature) shown first */}
                <span
                  style={{
                    color: palette.textMuted,
                    fontSize: '12px',
                    flexShrink: 0,
                  }}
                >
                  {suggestion.signature}
                </span>
                {/* Separator */}
                <span style={{ color: palette.separator }}>-</span>
                {/* Function name (bold) */}
                <span style={{ fontWeight: 600, color: palette.textStrong }}>
                  {suggestion.name}
                </span>
              </>
            ) : (
              /* No signature - just show function name */
              <span style={{ fontWeight: 600, color: palette.textStrong }}>
                {suggestion.name}
              </span>
            )}
          </div>
        )
      })}
      {signature && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${palette.rowBorder}`,
            backgroundColor: palette.signatureBg,
            fontSize: '12px',
            fontFamily: 'monospace',
            color: palette.textStrong,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {signature}
        </div>
      )}
    </div>
  )

  // Render in portal at document.body level to escape grid overflow clipping
  if (usePortal) {
    return createPortal(dropdown, document.body)
  }

  return dropdown
}
