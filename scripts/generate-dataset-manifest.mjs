/**
 * Generate dataset manifest with row/column counts from CSV files.
 *
 * Reads the existing manifest.json, counts rows and columns for each
 * referenced CSV, and writes the manifest back with `rows` and `columns`
 * fields populated.  Run this script whenever sample datasets change.
 *
 * Usage:
 *   node scripts/generate-dataset-manifest.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const datasetsDir = join(__dirname, '..', 'src-tauri', 'resources', 'datasets')
const manifestPath = join(datasetsDir, 'manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

let updated = 0
let failed = 0

function countCsvColumns(headerLine) {
  let count = 1
  let inQuotes = false

  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i]
    if (ch === '"') {
      const next = headerLine[i + 1]
      if (inQuotes && next === '"') {
        i++
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) {
      count++
    }
  }

  return count
}

for (const entry of manifest.datasets) {
  const csvPath = join(datasetsDir, entry.file)
  let content
  try {
    content = readFileSync(csvPath, 'utf-8')
  } catch (err) {
    console.error(`  SKIP  ${entry.file} — file not found`)
    failed++
    continue
  }

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)

  if (lines.length === 0) {
    console.error(`  SKIP  ${entry.file} — empty file`)
    failed++
    continue
  }

  const columns = countCsvColumns(lines[0])
  const rows = lines.length - 1 // exclude header

  entry.rows = rows
  entry.columns = columns
  updated++
  console.log(`  OK    ${entry.file}  →  ${rows} rows, ${columns} columns`)
}

if (failed > 0) {
  console.error(`\nFailed: ${failed} dataset(s) missing or empty. Manifest not written.`)
  process.exit(1)
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
console.log(`\nDone — ${updated}/${manifest.datasets.length} datasets updated in manifest.json`)
