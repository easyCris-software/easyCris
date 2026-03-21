#!/usr/bin/env node
/**
 * Create RNA-seq .ecp fixture for E2E testing
 *
 * This script:
 * 1. Launches the app in E2E mode
 * 2. Imports counts + metadata CSVs
 * 3. Creates RNA-seq project and runs DESeq2 analysis
 * 4. Saves as .ecp fixture
 *
 * Usage:
 *   node e2e/scripts/create-rnaseq-fixture.mjs
 */

import { Builder } from 'selenium-webdriver'
import chrome from 'selenium-webdriver/chrome.js'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

const COUNTS_PATH = path.join(PROJECT_ROOT, 'e2e/fixtures/datasets/RNAseq/counts.csv')
const METADATA_PATH = path.join(PROJECT_ROOT, 'e2e/fixtures/datasets/RNAseq/metadata.csv')
const OUTPUT_ECP_PATH = path.join(PROJECT_ROOT, 'e2e/fixtures/datasets/RNAseq/rnaseq_deseq2/rnaseq_deseq2.ecp')

const MODEL_CONFIG = {
  id: 'rnaseq_model_e2e',
  name: 'Treatment (THC vs vehicle)',
  designFormula: '~ Treatment',
  mainFactor: 'Treatment',
  mainFactorReference: 'vehicle',
  mainFactorTest: 'THC',
  additionalFactors: [],
  covariates: [],
  subsetFilters: null,
  contrastType: 'main',
  applyShrinkage: false,
  shrinkageMethod: 'apeglm',
  organism: 'mmusculus',
  alpha: 0.05,
  minCount: 10,
  minSamples: 3,
  usePadjForSignificance: true,
  pcaTopGenes: 500,
}

async function createFixture() {
  console.log('[Fixture] Creating RNA-seq .ecp fixture...')

  // Verify input files exist
  if (!fs.existsSync(COUNTS_PATH)) {
    throw new Error(`Counts CSV not found: ${COUNTS_PATH}`)
  }
  if (!fs.existsSync(METADATA_PATH)) {
    throw new Error(`Metadata CSV not found: ${METADATA_PATH}`)
  }

  // Setup Chrome driver
  const options = new chrome.Options()
  options.addArguments('--disable-gpu')
  options.addArguments('--no-sandbox')
  options.addArguments('--disable-dev-shm-usage')

  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build()

  try {
    // Navigate to app
    await driver.get('http://localhost:1420')
    await driver.manage().setTimeouts({ script: 300000 })

    console.log('[Fixture] Waiting for app to load...')
    await driver.sleep(3000)

    // Verify E2E shim is available
    const shimExists = await driver.executeScript(() => {
      return typeof window.__E2E__ === 'object'
    })

    if (!shimExists) {
      throw new Error('window.__E2E__ not available. Ensure app is built with VITE_E2E_ENABLED=true')
    }

    // Clear existing data
    console.log('[Fixture] Clearing existing data...')
    await driver.executeScript(() => {
      return Promise.all([
        window.__E2E__.clearAllData(),
        window.__E2E__.clearAllRNAseq(),
      ])
    })
    await driver.sleep(1000)

    // Import CSVs
    console.log('[Fixture] Importing counts CSV...')
    const countsId = await driver.executeScript((csvPath) => {
      return window.__E2E__.importCSV(csvPath)
    }, COUNTS_PATH)

    console.log('[Fixture] Importing metadata CSV...')
    const metadataId = await driver.executeScript((csvPath) => {
      return window.__E2E__.importCSV(csvPath)
    }, METADATA_PATH)

    // Create RNA-seq project
    console.log('[Fixture] Creating RNA-seq project...')
    const projectId = await driver.executeScript(() => {
      return window.__E2E__.createRNAseqProject('RNA-seq E2E Fixture')
    })

    // Link datasets
    console.log('[Fixture] Linking datasets...')
    await driver.executeScript(
      (projectId, countsId, metadataId) => {
        return window.__E2E__.linkRNAseqDatasets({
          projectId,
          countsDatasetId: countsId,
          metadataDatasetId: metadataId,
        })
      },
      projectId,
      countsId,
      metadataId
    )

    // Run DESeq2 analysis
    console.log('[Fixture] Running DESeq2 analysis (this may take 1-2 minutes)...')
    await driver.executeScript((projectId, model) => {
      return window.__E2E__.runRNAseqAnalysis({ projectId, model })
    }, projectId, MODEL_CONFIG)

    console.log('[Fixture] Analysis complete')

    // Save as .ecp fixture
    console.log('[Fixture] Saving .ecp fixture...')
    await driver.executeScript((ecpPath) => {
      return window.__E2E__.saveProject(ecpPath)
    }, OUTPUT_ECP_PATH)

    console.log(`[Fixture] SUCCESS: Created ${OUTPUT_ECP_PATH}`)
    console.log('[Fixture] Next steps:')
    console.log('  1. Add entry to e2e/fixtures/manifest.json')
    console.log('  2. Run: node e2e/features/r-validation/rnaseq.test.mjs')

  } catch (error) {
    console.error('[Fixture] FAILED:', error.message)
    throw error
  } finally {
    await driver.quit()
  }
}

createFixture().catch((err) => {
  console.error('[Fixture] Execution failed:', err)
  process.exit(1)
})
