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
// Maps test names for E2E fixtures to their validation directory names
const GROUP_1_TESTS = [
  { name: 'anova_two_way', dir: 'anova_two_way', metrics: 64 },
  { name: 'anova_one_way', dir: 'anova_one_way', metrics: 97 },
  { name: 't_test_two_sample', dir: 't_test_two_sample', metrics: 40 },
  { name: 't_test_paired', dir: 't_test_paired', metrics: 40 },
  { name: 't_test_one_sample', dir: 't_test_one_sample', metrics: 20 },
  { name: 'mann_whitney', dir: 'mann_whitney', metrics: 40 },
  { name: 'wilcoxon_signed_rank', dir: 'wilcoxon_signed_rank', metrics: 40 },
  { name: 'kruskal_wallis', dir: 'kruskal_wallis', metrics: 44 },
  { name: 'scheirer_ray_hare', dir: 'scheirer_ray_hare', metrics: 18 },
  { name: 'multifactorial_anova', dir: 'multifactorial_anova', metrics: 56 },
]

// Group 2 tests (Pharmacology - ~161 metrics total)
const GROUP_2_TESTS = [
  { name: 'dose_response_3pl', dir: 'dose_response_3pl', metrics: 17 },
  { name: 'dose_response_4pl', dir: 'dose_response_4pl', metrics: 20 },
  { name: 'dose_response_5pl', dir: 'dose_response_5pl', metrics: 21 },
  { name: 'dose_response_compare', dir: 'dose_response_compare', metrics: 53 },
  { name: 'synergy_bliss', dir: 'synergy_bliss', metrics: 8 },
  { name: 'synergy_hsa', dir: 'synergy_hsa', metrics: 8 },
  { name: 'synergy_loewe', dir: 'synergy_loewe', metrics: 17 },
  { name: 'synergy_zip', dir: 'synergy_zip', metrics: 8 },
  { name: 'synergy_all', dir: 'synergy_all', metrics: 18 },
]

// Group 3 tests (Regression & Correlation)
const GROUP_3_TESTS = [
  { name: 'correlation_pearson', dir: 'correlation_pearson', metrics: 14 }, // Pearson + Spearman + Kendall
  { name: 'linear_regression', dir: 'linear_regression', metrics: 13 },
  { name: 'multiple_linear_regression', dir: 'multiple_linear_regression', metrics: 32 },
  { name: 'logistic_binary', dir: 'logistic_binary', metrics: 20 },
  { name: 'logistic_multinomial', dir: 'logistic_multinomial', metrics: 60 },
]

// Group 4 tests (Categorical - 16 validated metrics)
// Note: test IDs use chi_square, R folders use chi_squared
const GROUP_4_TESTS = [
  { name: 'chi_square', dir: 'chi_squared', metrics: 4 }, // chi_squared, df, p_value, cramers_v
  { name: 'chi_square_gof', dir: 'chi_squared_gof', metrics: 3 }, // chi_squared, df, p_value
  { name: 'fishers_exact', dir: 'fisher_exact', metrics: 4 }, // odds_ratio, p_value, ci_95_lower, ci_95_upper
  { name: 'mcnemar', dir: 'mcnemar', metrics: 5 }, // chi_squared, p_value, exact_p_value, discordant_b, discordant_c
]

// Group 5 tests (Distribution & Descriptive)
const GROUP_5_TESTS = [
  { name: 'normality_all', dir: 'normality_tests', metrics: 7 },
  { name: 'descriptive_stats', dir: 'descriptive_statistics', metrics: 16 },
  { name: 'outlier_detection', dir: 'outlier_detection', metrics: 12 },
]

// Group 6 tests (Survival Analysis - 42 metrics total)
const GROUP_6_TESTS = [
  { name: 'kaplan_meier', dir: 'kaplan_meier', metrics: 13 },
  { name: 'cox_proportional_hazards', dir: 'cox_proportional_hazards', metrics: 27 },
  { name: 'nelson_aalen', dir: 'nelson_aalen', metrics: 8 },
]

// Metadata keys to exclude from baselines (per GROUP_4_E2E_VALIDATION_PLAN.md Critical Decision 3)
// These are not displayed in the UI via data-stat attributes
const METADATA_KEYS = ['success', 'test_type', 'n', 'rows', 'cols', 'categories']
const GROUP_5_METADATA_KEYS = [
  'success',
  'test_type',
  'alpha',
  'n_original',
  'n_valid',
  'rows',
  'cols',
  'categories',
  'iqr_outlier_values',
  'iqr_outlier_indices',
  'z_outlier_values',
  'mad_outlier_values',
]

// Group 6 metadata keys to exclude (boolean flags, not displayed in UI)
const GROUP_6_METADATA_KEYS = ['success', 'test_type', 'groups_differ']

/**
 * Parse R baseline CSV to JSON
 * Expected format: key,value
 */
function parseRBaseline(csvContent) {
  const lines = csvContent.trim().split('\n')
  const baseline = {}

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
function parseValue(val) {
  if (val === 'TRUE') return true
  if (val === 'FALSE') return false

  // Try to parse as number
  const num = Number(val)
  if (!isNaN(num) && val !== '') return num

  return val
}

/**
 * Convert tests from a specific group
 * @param {boolean} filterMetadata - If true, exclude METADATA_KEYS from baseline
 */
function convertGroup(groupName, tests, validationDir, baselinesDir, excludeKeys = []) {
  console.log(`\n📦 ${groupName}:`)

  let converted = 0
  let metrics = 0

  for (const test of tests) {
    const rResultPath = path.join(validationDir, test.dir, 'results', 'r_result.csv')

    if (!fs.existsSync(rResultPath)) {
      console.log(`   ⚠️  ${test.name}: r_result.csv not found`)
      continue
    }

    try {
      const csvContent = fs.readFileSync(rResultPath, 'utf-8')
      let baseline = parseRBaseline(csvContent)

      // Filter out metadata keys if provided
      if (excludeKeys.length > 0) {
        const filtered = {}
        for (const [key, value] of Object.entries(baseline)) {
          if (!excludeKeys.includes(key)) {
            filtered[key] = value
          }
        }
        baseline = filtered
      }

      const baselinePath = path.join(baselinesDir, `${test.name}_r_baseline.json`)
      fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2))

      const metricCount = Object.keys(baseline).length
      metrics += metricCount

      console.log(`   ✅ ${test.name}: ${metricCount} metrics → ${path.basename(baselinePath)}`)
      converted++
    } catch (error) {
      console.error(`   ❌ ${test.name}: Failed to convert - ${error}`)
    }
  }

  return { converted, metrics, total: tests.length }
}

/**
 * Main conversion function
 */
async function convertValidationBaselines() {
  console.log('🔄 Converting R baselines to JSON...')

  const projectRoot = path.resolve(__dirname, '..')
  const baselinesDir = path.join(projectRoot, 'e2e', 'fixtures', 'baselines')

  // Ensure baselines directory exists
  fs.mkdirSync(baselinesDir, { recursive: true })

  // Convert Group 1
  const group1Dir = path.join(projectRoot, '_test_validation', 'Group1_Hypothesis_Testing')
  const g1 = convertGroup('Group 1 (Hypothesis Testing)', GROUP_1_TESTS, group1Dir, baselinesDir)

  // Convert Group 2
  const group2Dir = path.join(projectRoot, '_test_validation', 'Group2_Pharmacology')
  const g2 = convertGroup('Group 2 (Pharmacology)', GROUP_2_TESTS, group2Dir, baselinesDir)

  // Convert Group 3
  const group3Dir = path.join(projectRoot, '_test_validation', 'Group3_Regression_Correlation')
  const g3 = convertGroup('Group 3 (Regression & Correlation)', GROUP_3_TESTS, group3Dir, baselinesDir)

  // Convert Group 4 (with metadata filtering per Critical Decision 3)
  const group4Dir = path.join(projectRoot, '_test_validation', 'Group4_Categorical')
  const g4 = convertGroup('Group 4 (Categorical)', GROUP_4_TESTS, group4Dir, baselinesDir, METADATA_KEYS)

  // Convert Group 5 (exclude metadata but keep n)
  const group5Dir = path.join(projectRoot, '_test_validation', 'Group5_Distribution_Descriptive')
  const g5 = convertGroup('Group 5 (Distribution & Descriptive)', GROUP_5_TESTS, group5Dir, baselinesDir, GROUP_5_METADATA_KEYS)

  // Convert Group 6 (Survival Analysis)
  const group6Dir = path.join(projectRoot, '_test_validation', 'Group6_Survival')
  const g6 = convertGroup('Group 6 (Survival Analysis)', GROUP_6_TESTS, group6Dir, baselinesDir, GROUP_6_METADATA_KEYS)

  const totalConverted = g1.converted + g2.converted + g3.converted + g4.converted + g5.converted + g6.converted
  const totalTests = g1.total + g2.total + g3.total + g4.total + g5.total + g6.total
  const totalMetrics = g1.metrics + g2.metrics + g3.metrics + g4.metrics + g5.metrics + g6.metrics

  console.log(`\n✅ Conversion complete!`)
  console.log(`   Group 1: ${g1.converted}/${g1.total} tests, ${g1.metrics} metrics`)
  console.log(`   Group 2: ${g2.converted}/${g2.total} tests, ${g2.metrics} metrics`)
  console.log(`   Group 3: ${g3.converted}/${g3.total} tests, ${g3.metrics} metrics`)
  console.log(`   Group 4: ${g4.converted}/${g4.total} tests, ${g4.metrics} metrics`)
  console.log(`   Group 5: ${g5.converted}/${g5.total} tests, ${g5.metrics} metrics`)
  console.log(`   Group 6: ${g6.converted}/${g6.total} tests, ${g6.metrics} metrics`)
  console.log(`   Total: ${totalConverted}/${totalTests} tests, ${totalMetrics} metrics`)
  console.log(`   Output: ${baselinesDir}`)
}

// Run conversion
convertValidationBaselines().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
