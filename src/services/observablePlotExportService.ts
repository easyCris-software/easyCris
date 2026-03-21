/**
 * Observable Plot Export Service
 *
 * Exports Observable Plot SVG to various formats via Tauri sidecar.
 * Uses sharp for raster format conversion (PNG/JPG/WebP).
 *
 * Architecture:
 * - SVG export: Direct file write (no conversion)
 * - Raster export: Tauri backend → Node.js sidecar → sharp
 *
 * Migration Note: Part of Plotly → Observable Plot migration.
 * Observable Plot used for 18 of 20 plot types (Plotly kept for scattergl + pie).
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Supported export formats
 * PDF not supported (Puppeteer too large at ~300MB)
 */
export type ObservablePlotFormat = 'png' | 'jpg' | 'jpeg' | 'webp' | 'svg'

/**
 * Export options
 */
export interface ObservablePlotExportOptions {
  /** Export format */
  format: ObservablePlotFormat

  /** Image width in pixels (default: 800) */
  width?: number

  /** Image height in pixels (default: 600) */
  height?: number

  /** DPI for raster export (default: 300) */
  dpi?: number
}

/**
 * Export result
 */
export interface ObservablePlotExportResult {
  /** Success status */
  success: boolean

  /** Output file path (if successful) */
  path?: string

  /** Export format */
  format?: string

  /** Error message (if failed) */
  error?: string
}

/**
 * Export Observable Plot SVG to various formats via Tauri sidecar
 *
 * @param svgElement - SVG DOM element or string
 * @param outputPath - Absolute path to output file
 * @param options - Export options
 * @returns Export result with success status
 *
 * @example
 * ```typescript
 * // Export to PNG
 * const svg = Plot.plot({...}).outerHTML
 * const result = await exportObservablePlot(
 *   svg,
 *   'C:/path/to/plot.png',
 *   { format: 'png', width: 1200, height: 800, dpi: 300 }
 * )
 * ```
 */
export async function exportObservablePlot(
  svgElement: SVGElement | string,
  outputPath: string,
  options: ObservablePlotExportOptions
): Promise<ObservablePlotExportResult> {
  // Convert SVG element to string
  const svgString = typeof svgElement === 'string'
    ? svgElement
    : svgElement.outerHTML

  try {
    // Call Tauri backend command
    const result = await invoke<ObservablePlotExportResult>('export_svg', {
      svgString,
      outputPath,
      format: options.format,
      width: options.width ?? 800,
      height: options.height ?? 600,
      dpi: options.dpi ?? 300,
    })

    return result
  } catch (error) {
    return {
      success: false,
      error: String(error),
    }
  }
}

/**
 * Export format display names
 */
export const FORMAT_NAMES: Record<ObservablePlotFormat, string> = {
  svg: 'SVG',
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPEG',
  webp: 'WebP',
}

/**
 * Default export options
 */
export const DEFAULT_EXPORT_OPTIONS: Required<Omit<ObservablePlotExportOptions, 'format'>> = {
  width: 800,
  height: 600,
  dpi: 300,
}
