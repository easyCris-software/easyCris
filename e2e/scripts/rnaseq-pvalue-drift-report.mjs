#!/usr/bin/env node
/**
 * RNA-seq p-value drift report (R vs easyCris)
 *
 * Reads:
 * - R baseline genes CSV: _test_validation/RNA_seq/results/r_genes.csv
 * - easyCris genes from a precomputed .ecp fixture (rnaseqResults embedded)
 *
 * Writes:
 * - _test_validation/RNA_seq/results/pvalue_drift_p05.csv
 * - _test_validation/RNA_seq/results/pvalue_drift_p01.csv
 * - _test_validation/RNA_seq/results/pvalue_drift_p001.csv
 *
 * Usage:
 *   node e2e/scripts/rnaseq-pvalue-drift-report.mjs
 *   node e2e/scripts/rnaseq-pvalue-drift-report.mjs --ecp path\to\fixture.ecp
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadGeneCsv, ensureDir, RNASEQ_RESULTS_DIR } from '../utils/rnaseq-validation.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

const DEFAULT_ECP_PATH = path.join(
  PROJECT_ROOT,
  'e2e/fixtures/datasets/RNAseq/rnaseq_deseq2/rnaseq_deseq2.ecp'
)

const R_GENES_PATH = path.join(RNASEQ_RESULTS_DIR, 'r_genes.csv')

function parseArgs(argv) {
  const args = { ecp: DEFAULT_ECP_PATH }
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--ecp') {
      args.ecp = argv[i + 1]
      i += 1
      continue
    }
    if (token === '--help' || token === '-h') {
      args.help = true
    }
  }
  return args
}

function csvEscape(value) {
  const str = String(value ?? '')
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/\"/g, '""')}"`
  }
  return str
}

function writeCsv(filePath, header, rows) {
  const lines = []
  lines.push(header.map(csvEscape).join(','))
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','))
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
}

function loadEasycrisGenesFromEcp(ecpPath) {
  if (!fs.existsSync(ecpPath)) {
    throw new Error(`ECP not found: ${ecpPath}`)
  }
  const project = JSON.parse(fs.readFileSync(ecpPath, 'utf-8'))

  const projectId =
    project?.rnaseqState?.activeProjectId ??
    project?.rnaseqState?.projects?.[0]?.id ??
    Object.keys(project?.rnaseqResults ?? {})[0]
  if (!projectId) {
    throw new Error('No rnaseqState/rnaseqResults found in .ecp')
  }

  const rnaseqProject =
    project?.rnaseqState?.projects?.find((p) => p?.id === projectId) ??
    project?.rnaseqState?.projects?.[0]
  const resultId =
    rnaseqProject?.activeResultId ??
    rnaseqProject?.resultsRef?.[0]?.resultId ??
    null

  const results = project?.rnaseqResults?.[projectId]
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`No rnaseqResults array found for projectId: ${projectId}`)
  }

  const run =
    (resultId ? results.find((r) => r?.id === resultId) : null) ??
    results[0]

  if (!run || !Array.isArray(run.genes)) {
    throw new Error('No genes array found in rnaseqResults run')
  }

  return run.genes.map((gene) => ({
    geneId: String(gene.geneId ?? gene.gene_id ?? ''),
    geneSymbol: String(gene.geneSymbol ?? gene.gene_symbol ?? gene.geneId ?? gene.gene_id ?? ''),
    pvalue: typeof gene.pvalue === 'number' ? gene.pvalue : null,
    padj: typeof gene.padj === 'number' ? gene.padj : null,
  }))
}

function computeThresholdDrift(rGenes, easyGenes, threshold) {
  const rMap = new Map(rGenes.map((g) => [g.geneId, g]))
  const easyMap = new Map(easyGenes.map((g) => [g.geneId, g]))

  const onlyInR = []
  const onlyInEasy = []
  let rSig = 0
  let easySig = 0

  for (const [geneId, rRow] of rMap.entries()) {
    const eRow = easyMap.get(geneId)
    const rP = rRow?.pvalue
    const eP = eRow?.pvalue

    const rIsSig = typeof rP === 'number' && Number.isFinite(rP) && rP < threshold
    const eIsSig = typeof eP === 'number' && Number.isFinite(eP) && eP < threshold
    if (rIsSig) rSig += 1
    if (eIsSig) easySig += 1

    if (rIsSig === eIsSig) continue

    const record = {
      geneId,
      geneSymbol: rRow?.geneSymbol || eRow?.geneSymbol || '',
      r_pvalue: rP ?? null,
      easycris_pvalue: eP ?? null,
      r_sig: rIsSig ? 1 : 0,
      easy_sig: eIsSig ? 1 : 0,
      delta: typeof rP === 'number' && typeof eP === 'number' ? eP - rP : null,
      // Sort helper: how close is either p-value to the threshold?
      proximity:
        typeof rP === 'number' && typeof eP === 'number'
          ? Math.min(Math.abs(rP - threshold), Math.abs(eP - threshold))
          : typeof rP === 'number'
            ? Math.abs(rP - threshold)
            : typeof eP === 'number'
              ? Math.abs(eP - threshold)
              : Infinity,
    }

    if (rIsSig) {
      onlyInR.push(record)
    } else {
      onlyInEasy.push(record)
    }
  }

  onlyInR.sort((a, b) => a.proximity - b.proximity)
  onlyInEasy.sort((a, b) => a.proximity - b.proximity)

  return { threshold, rSig, easySig, onlyInR, onlyInEasy }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('Usage: node e2e/scripts/rnaseq-pvalue-drift-report.mjs [--ecp path\\\\to\\\\fixture.ecp]')
    process.exit(0)
  }

  ensureDir(RNASEQ_RESULTS_DIR)

  if (!fs.existsSync(R_GENES_PATH)) {
    throw new Error(`R baseline genes CSV not found: ${R_GENES_PATH}`)
  }

  const rGenes = loadGeneCsv(R_GENES_PATH)
  const easyGenes = loadEasycrisGenesFromEcp(path.resolve(PROJECT_ROOT, args.ecp))

  const thresholds = [
    { name: 'p05', value: 0.05 },
    { name: 'p01', value: 0.01 },
    { name: 'p001', value: 0.001 },
  ]

  for (const { name, value } of thresholds) {
    const drift = computeThresholdDrift(rGenes, easyGenes, value)
    const outPath = path.join(RNASEQ_RESULTS_DIR, `pvalue_drift_${name}.csv`)

    const combined = [
      ...drift.onlyInR.map((row) => ({ ...row, direction: 'R_only' })),
      ...drift.onlyInEasy.map((row) => ({ ...row, direction: 'easycris_only' })),
    ].sort((a, b) => a.proximity - b.proximity)

    writeCsv(
      outPath,
      ['threshold', 'direction', 'geneId', 'geneSymbol', 'r_pvalue', 'easycris_pvalue', 'delta', 'proximity'],
      combined.map((row) => [
        value,
        row.direction,
        row.geneId,
        row.geneSymbol,
        row.r_pvalue ?? '',
        row.easycris_pvalue ?? '',
        row.delta ?? '',
        row.proximity ?? '',
      ])
    )

    console.log(`\n[RNA-seq drift] p < ${value}`)
    console.log(`  R significant:       ${drift.rSig}`)
    console.log(`  easyCris significant:${drift.easySig}`)
    console.log(`  R_only:              ${drift.onlyInR.length}`)
    console.log(`  easyCris_only:       ${drift.onlyInEasy.length}`)
    console.log(`  wrote: ${outPath}`)

    const preview = combined.slice(0, 15)
    if (preview.length > 0) {
      console.log('  closest crossings (top 15):')
      for (const row of preview) {
        console.log(
          `    ${row.direction.padEnd(12)} ${row.geneId} r=${row.r_pvalue} easy=${row.easycris_pvalue} prox=${row.proximity}`
        )
      }
    }
  }
}

main().catch((err) => {
  console.error('[RNA-seq drift] FAILED:', err?.message ?? err)
  process.exit(1)
})
