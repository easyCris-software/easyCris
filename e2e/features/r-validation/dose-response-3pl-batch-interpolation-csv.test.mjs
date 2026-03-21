/**
 * R Baseline Validation: Dose-Response 3PL Batch Interpolation CSV
 * Compares easyCris exported batch interpolation CSV against R reference CSV.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { selectPlotFromGalleryByType } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess } from '../../utils/assertions.mjs'
import { exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { runDoseResponse3PL, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'
import {
  DEFAULT_BATCH_INTERPOLATION_INPUTS,
  compareBatchInterpolationRows,
  ensureInterpolationPanelVisible,
  exportBatchInterpolationCsv,
  loadBatchInterpolationCsv,
  runBatchInterpolation,
  runRBatchBaseline,
  setBatchInterpolationEntryMode,
  setBatchInterpolationInput,
  setInterpolationMode,
  waitForBatchInterpolationStats,
} from '../../utils/dose-interpolation-batch-validation.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const RESULTS_DIR = path.join(
  PROJECT_ROOT,
  '_test_validation',
  'Group2_Pharmacology',
  'dose_response_3pl',
  'results'
)
const R_SCRIPT_PATH = path.join(
  PROJECT_ROOT,
  '_test_validation',
  'Group2_Pharmacology',
  'dose_response_3pl',
  'r',
  'run_test.R'
)
const EASYCRIS_BATCH_CSV_PATH = path.join(RESULTS_DIR, 'easycris_batch_interpolation.csv')
const R_BATCH_CSV_PATH = path.join(RESULTS_DIR, 'r_batch_interpolation.csv')

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Dose-Response 3PL batch interpolation CSV validation...')
    logStep('Running R reference script to generate fresh batch interpolation CSV...')
    runRBatchBaseline({
      rScriptPath: R_SCRIPT_PATH,
      outputCsvPath: R_BATCH_CSV_PATH,
    })

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    await loadFixture(driver, 'dose_response_3pl')
    await runDoseResponse3PL(driver, {})
    await waitForResults(driver)
    await switchToPlotsTab(driver)
    await selectPlotFromGalleryByType(driver, 'doseresponse')
    await ensureInterpolationPanelVisible(driver)

    logStep('Running batch interpolation (Conc -> Response)...')
    await setBatchInterpolationEntryMode(driver)
    await setInterpolationMode(driver, 'Conc -> Response')
    await setBatchInterpolationInput(driver, DEFAULT_BATCH_INTERPOLATION_INPUTS)
    await runBatchInterpolation(driver)
    await waitForBatchInterpolationStats(driver, DEFAULT_BATCH_INTERPOLATION_INPUTS.length)

    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    await exportBatchInterpolationCsv(driver, EASYCRIS_BATCH_CSV_PATH)

    const easycrisRows = loadBatchInterpolationCsv(EASYCRIS_BATCH_CSV_PATH)
    const rRows = loadBatchInterpolationCsv(R_BATCH_CSV_PATH)
    compareBatchInterpolationRows(easycrisRows, rRows, {
      outputTolerance: 0.05,
      compareMessage: true,
    })

    await exportPlotScreenshot(driver, 'dose_response_3pl', 300, 'interpolation_batch')
    logSuccess('Dose-Response 3PL batch interpolation CSV validation passed')
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch((err) => {
  console.error('[Test] Execution failed:', err)
  process.exit(1)
})
