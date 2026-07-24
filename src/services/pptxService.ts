/**
 * PowerPoint Export Service
 *
 * Handles exporting plots to PowerPoint format with embedded data
 * for later recovery. Uses python-pptx via Tauri Python bridge.
 */

import { executePythonWithSetup } from './pythonBridge'
import type { PlotSpec } from '@/store/plots-store'

export interface PptxExportOptions {
  /** Embed plot data in slide notes for recovery (default: true) */
  embedData?: boolean
  /** Add easyCris branding footer (default: true) */
  addBranding?: boolean
}

export interface PptxExportResult {
  success: boolean
  message: string
  path?: string
  error?: string
}

export interface PptxRecoveryResult {
  success: boolean
  message: string
  plots: Array<{
    slide: number
    title: string
    data: PlotSpec
  }>
  count: number
  error?: string
}

// Timeout for PPTX operations (45 seconds)
const PPTX_TIMEOUT_MS = 45000

/**
 * Export a single plot to PowerPoint
 */
export async function exportPlotToPptx(
  imageBase64: string,
  plotData: PlotSpec,
  outputPath: string,
  options: PptxExportOptions = {}
): Promise<PptxExportResult> {
  const { embedData = true, addBranding = true } = options

  // Validate base64 data
  if (!imageBase64 || imageBase64.length === 0) {
    return {
      success: false,
      message: 'Invalid image data provided',
      error: 'Empty base64 string',
    }
  }

  const scriptBody = `
from pptx_exporter import export_plot_to_pptx

result = export_plot_to_pptx(
    image_base64=context["image_base64"],
    plot_data=context["plot_data"],
    output_path=context["output_path"],
    options={
        "embed_data": context["embed_data"],
        "add_branding": context["add_branding"]
    }
)
print(json.dumps(result))
`

  try {
    const response = await executePythonWithSetup(
      scriptBody,
      {
        image_base64: imageBase64,
        plot_data: plotData,
        output_path: outputPath,
        embed_data: embedData,
        add_branding: addBranding,
      },
      PPTX_TIMEOUT_MS
    )

    if (response.error) {
      return {
        success: false,
        message: response.error,
        error: response.error,
      }
    }

    const result = JSON.parse(response.output)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message: `Failed to export plot: ${message}`,
      error: message,
    }
  }
}

/**
 * Recover plot data from a PowerPoint file
 */
export async function recoverDataFromPptx(
  pptxPath: string
): Promise<PptxRecoveryResult> {
  const scriptBody = `
from pptx_exporter import recover_data_from_pptx

result = recover_data_from_pptx(context["pptx_path"])
print(json.dumps(result))
`

  try {
    const response = await executePythonWithSetup(
      scriptBody,
      { pptx_path: pptxPath },
      PPTX_TIMEOUT_MS
    )

    if (response.error) {
      return {
        success: false,
        message: response.error,
        plots: [],
        count: 0,
        error: response.error,
      }
    }

    const result = JSON.parse(response.output)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message: `Failed to recover data: ${message}`,
      plots: [],
      count: 0,
      error: message,
    }
  }
}

/**
 * Export multiple plots to a single PowerPoint presentation
 */
export async function exportMultiplePlotsToPptx(
  plots: Array<{ imageBase64: string; plotData: PlotSpec }>,
  outputPath: string,
  options: PptxExportOptions = {}
): Promise<PptxExportResult & { count?: number }> {
  const { embedData = true, addBranding = true } = options

  // Validate all base64 data
  const invalidPlots = plots.filter((p) => !p.imageBase64 || p.imageBase64.length === 0)
  if (invalidPlots.length > 0) {
    return {
      success: false,
      message: `${invalidPlots.length} plot(s) have invalid image data`,
      error: 'Invalid base64 data',
    }
  }

  const scriptBody = `
from pptx_exporter import export_multiple_plots_to_pptx

result = export_multiple_plots_to_pptx(
    plots=context["plots"],
    output_path=context["output_path"],
    options={
        "embed_data": context["embed_data"],
        "add_branding": context["add_branding"]
    }
)
print(json.dumps(result))
`

  try {
    const response = await executePythonWithSetup(
      scriptBody,
      {
        plots: plots.map((p) => ({
          image_base64: p.imageBase64,
          plot_data: p.plotData,
        })),
        output_path: outputPath,
        embed_data: embedData,
        add_branding: addBranding,
      },
      PPTX_TIMEOUT_MS + plots.length * 5000 // Extra time for multiple plots
    )

    if (response.error) {
      return {
        success: false,
        message: response.error,
        error: response.error,
      }
    }

    const result = JSON.parse(response.output)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message: `Failed to export plots: ${message}`,
      error: message,
    }
  }
}

export const pptxService = {
  exportPlotToPptx,
  recoverDataFromPptx,
  exportMultiplePlotsToPptx,
}

export default pptxService
