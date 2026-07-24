#!/usr/bin/env node
/**
 * Sharp SVG Exporter Sidecar
 *
 * Node.js sidecar for converting Observable Plot SVG to raster formats.
 * Called by Tauri export_svg command for PNG/JPG/WebP export.
 *
 * Usage:
 *   node sharp-exporter.js \
 *     --svg "<svg>...</svg>" \
 *     --output "path/to/output.png" \
 *     --format png \
 *     --width 800 \
 *     --height 600 \
 *     --dpi 300
 */

import sharp from 'sharp'
import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'

// Parse command line arguments
const { values } = parseArgs({
  options: {
    svg: { type: 'string' },
    output: { type: 'string' },
    format: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    dpi: { type: 'string' },
  }
})

// Validate required arguments
if (!values.svg) {
  console.error('Error: --svg argument is required')
  process.exit(1)
}

if (!values.output) {
  console.error('Error: --output argument is required')
  process.exit(1)
}

if (!values.format) {
  console.error('Error: --format argument is required')
  process.exit(1)
}

// Parse numeric arguments
const width = parseInt(values.width) || 800
const height = parseInt(values.height) || 600
const dpi = parseInt(values.dpi) || 300

// Calculate DPI scaling
// Base DPI for web is 96
const scale = dpi / 96
const scaledWidth = Math.round(width * scale)
const scaledHeight = Math.round(height * scale)

// Convert SVG string to buffer
const svgBuffer = Buffer.from(values.svg, 'utf-8')

// Create sharp instance
let sharpInstance = sharp(svgBuffer)
  .resize(scaledWidth, scaledHeight)

// Apply format-specific encoding
let buffer
try {
  switch (values.format) {
    case 'png':
      buffer = await sharpInstance
        .png({ compressionLevel: 9 })
        .withMetadata({ density: dpi })
        .toBuffer()
      break

    case 'jpg':
    case 'jpeg':
      buffer = await sharpInstance
        .jpeg({ quality: 90 })
        .withMetadata({ density: dpi })
        .toBuffer()
      break

    case 'webp':
      buffer = await sharpInstance
        .webp({ quality: 90 })
        .withMetadata({ density: dpi })
        .toBuffer()
      break

    default:
      console.error(`Error: Unsupported format '${values.format}'`)
      console.error('Supported formats: png, jpg, jpeg, webp')
      process.exit(1)
  }

  // Write to output file
  await writeFile(values.output, buffer)

  // Success
  console.log(`Export complete: ${values.output}`)
  console.log(`Format: ${values.format}`)
  console.log(`Size: ${scaledWidth}x${scaledHeight}`)
  console.log(`DPI: ${dpi}`)

} catch (error) {
  console.error('Export failed:', error.message)
  process.exit(1)
}
