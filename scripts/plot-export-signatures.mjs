import { existsSync, readFileSync, statSync } from 'node:fs'

const TIFF_SIGNATURES = [
  Buffer.from([0x49, 0x49, 0x2a, 0x00]),
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
]

export function assertPlotExportArtifact(outputPath, format) {
  const normalized = String(format).toLowerCase()
  if (!existsSync(outputPath)) {
    throw new Error(`${normalized.toUpperCase()} export file is missing: ${outputPath}`)
  }
  if (statSync(outputPath).size <= 0) {
    throw new Error(`${normalized.toUpperCase()} export file is empty: ${outputPath}`)
  }
  const bytes = readFileSync(outputPath)
  if (normalized === 'pdf') {
    const header = bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1')
    if (!header.includes('%PDF-')) {
      throw new Error(`PDF signature is invalid: ${outputPath}`)
    }
    return
  }
  if (normalized === 'tiff') {
    if (!TIFF_SIGNATURES.some(signature => bytes.subarray(0, signature.length).equals(signature))) {
      throw new Error(`TIFF signature is invalid: ${outputPath}`)
    }
    return
  }
  throw new Error(`Unsupported plot export format: ${format}`)
}
