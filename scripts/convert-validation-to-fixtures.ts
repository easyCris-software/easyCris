/**
 * Convert R Validation Baselines to E2E Fixture JSON
 *
 * This script reads R baseline CSVs from _test_validation/ and converts them
 * to JSON files for use in E2E tests.
 *
 * Run: npm run convert:validation-fixtures
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Group 1 tests (271 metrics total)
const GROUP_1_TESTS = [
  { name: 'anova_two_way', metrics: 64 },
  { name: 'anova_one_way', metrics: 44 },
  { name: 'independent_t_test', metrics: 40 },
  { name: 'paired_t_test', metrics: 40 },
  { name: 'one_sample_t_test', metrics: 20 },
  { name: 'mann_whitney_u', metrics: 40 },
  { name: 'wilcoxon_signed_rank', metrics: 40 },
  { name: 'kruskal_wallis', metrics: 44 },
  { name: 'scheirer_ray_hare', metrics: 18 },
  { name: 'multifactorial_anova', metrics: 56 },
]

interface RBaseline {
  [key: string]: string | number | boolean
}

/**
 * Parse R baseline CSV to JSON
 * Expected format: key,value
 */
function parseRBaseline(csvContent: string): RBaseline {
  const lines = csvContent.trim().split('\n')
  const baseline: RBaseline = {}

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Split on first comma only (values may contain commas)
    const commaIndex = line.indexOf(',')
    if (commaIndex === -1) continue

    const key = line.substring(0, commaIndex).trim()
    const value = line.substring(commaIndex + 1).trim()

    baseline[key] = parseValue(value)
  }

  return baseline
}

/**
 * Parse string value to appropriate type
 */
function parseValue(val: string): string | number | boolean {
  if (val === 'TRUE') return true
  if (val === 'FALSE') return false

  // Try to parse as number
  const num = Number(val)
  if (!isNaN(num) && val !== '') return num

  return val
}

/**
 * Main conversion function
 */
async function convertValidationBaselines(): Promise<void> {
  console.log('🔄 Converting R baselines to JSON...\n')

  const projectRoot = path.resolve(__dirname, '..')
  const validationDir = path.join(projectRoot, '_test_validation', 'Group1_Hypothesis_Testing')
  const baselinesDir = path.join(projectRoot, 'e2e', 'fixtures', 'baselines')

  // Ensure baselines directory exists
  fs.mkdirSync(baselinesDir, { recursive: true })

  let totalConverted = 0
  let totalMetrics = 0

  for (const test of GROUP_1_TESTS) {
    const rResultPath = path.join(validationDir, test.name, 'results', 'r_result.csv')

    if (!fs.existsSync(rResultPath)) {
      console.log(`⚠️  ${test.name}: r_result.csv not found at ${rResultPath}`)
      continue
    }

    try {
      const csvContent = fs.readFileSync(rResultPath, 'utf-8')
      const baseline = parseRBaseline(csvContent)

      const baselinePath = path.join(baselinesDir, `${test.name}_r_baseline.json`)
      fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2))

      const metricCount = Object.keys(baseline).length
      totalMetrics += metricCount

      console.log(`✅ ${test.name}: ${metricCount} metrics → ${path.basename(baselinePath)}`)
      totalConverted++
    } catch (error) {
      console.error(`❌ ${test.name}: Failed to convert - ${error}`)
    }
  }

  console.log(`\n✅ Conversion complete!`)
  console.log(`   Converted: ${totalConverted}/${GROUP_1_TESTS.length} tests`)
  console.log(`   Total metrics: ${totalMetrics}`)
  console.log(`   Output: ${baselinesDir}`)
  console.log('\n📝 Next steps:')
  console.log('   1. Create .ecp fixtures manually using easyCris UI')
  console.log('   2. Copy .ecp + .ecpdb + _data/ to e2e/fixtures/datasets/')
  console.log('   3. Create large_10k_rows.ecp for memory tests')
  console.log('   4. Run: npm run create:fixture-manifest')
}

// Run conversion
convertValidationBaselines().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
