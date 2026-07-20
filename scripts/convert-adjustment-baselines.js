/**
 * Convert method-specific R baseline CSVs to JSON for E2E adjustment tests.
 *
 * Usage:
 *   node scripts/convert-adjustment-baselines.js anova_one_way bonferroni
 *
 * Expects CSV at:
 *   _test_validation/Group1_Hypothesis_Testing/<testName>/results/r_result_<method>.csv
 *
 * Writes JSON to:
 *   e2e/fixtures/baselines/<testName>_<method>_r_baseline.json
 */

import fs from 'fs'
import path from 'path'

const [testName, method] = process.argv.slice(2)

if (!testName || !method) {
  console.error('Usage: node scripts/convert-adjustment-baselines.js <testName> <method>')
  process.exit(1)
}

const projectRoot = path.resolve(process.cwd())
const validationDir = path.join(
  projectRoot,
  '_test_validation',
  'Group1_Hypothesis_Testing',
  testName
)
const isUnbalanced = method === 'unbalanced'
const resultsDir = isUnbalanced ? 'results_unbalanced' : 'results'
const inputCsv = isUnbalanced
  ? path.join(validationDir, resultsDir, 'r_result.csv')
  : path.join(validationDir, resultsDir, `r_result_${method}.csv`)
const outputJson = path.join(
  projectRoot,
  'e2e',
  'fixtures',
  'baselines',
  `${testName}_${method}_r_baseline.json`
)

if (!fs.existsSync(inputCsv)) {
  console.error(`Missing input CSV: ${inputCsv}`)
  process.exit(1)
}

const csvContent = fs.readFileSync(inputCsv, 'utf-8')
const lines = csvContent.split(/\r?\n/).filter(Boolean)
const baseline = {}

for (const line of lines.slice(1)) {
  const [key, value] = line.split(',').map(s => s.trim())
  if (!key || value === undefined) continue
  if (value === 'TRUE') {
    baseline[key] = true
    continue
  }
  if (value === 'FALSE') {
    baseline[key] = false
    continue
  }
  const numeric = Number(value)
  baseline[key] = Number.isFinite(numeric) ? numeric : value
}

fs.mkdirSync(path.dirname(outputJson), { recursive: true })
fs.writeFileSync(outputJson, JSON.stringify(baseline, null, 2))
console.log(`✅ Wrote ${outputJson} (${Object.keys(baseline).length} metrics)`)
