/**
 * R Baseline Validation: RNA-seq (DESeq2)
 * Validates summary metrics, gene metrics, and plot stats against R baselines.
 */

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { By, until } from 'selenium-webdriver'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { logStep, logSuccess, assertE2EShimExists } from '../../utils/assertions.mjs'
import {
  compareToRBaseline,
  assertValidation,
  extractStatsFromUI,
  extractPlotStatsFromUI,
} from '../../utils/r-validation.mjs'
import {
  RNASEQ_RESULTS_DIR,
  ensureDir,
  loadMetricCsv,
  loadGeneCsv,
  compareGeneResults,
  assertGeneResults,
} from '../../utils/rnaseq-validation.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

const BASELINE_SUMMARY_PATH = path.join(RNASEQ_RESULTS_DIR, 'r_summary.csv')
const BASELINE_GENES_PATH = path.join(RNASEQ_RESULTS_DIR, 'r_genes.csv')
const COUNTS_CSV_PATH = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'datasets', 'RNAseq', 'counts.csv')
const METADATA_CSV_PATH = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'datasets', 'RNAseq', 'metadata.csv')

const PLOT_BASELINES = {
  volcano_padj: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_volcano_padj.csv'),
  volcano_pvalue: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_volcano_pvalue.csv'),
  ma_padj: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_ma_padj.csv'),
  ma_pvalue: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_ma_pvalue.csv'),
  deg_bar: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_deg_bar.csv'),
  // PCA ellipse geometry must be validated against the same PCA coordinate space the app plots.
  // These fixture-derived baselines are generated via:
  //   cd _test_validation/RNA_seq/r && Rscript run_pca_baselines_from_fixture.R
  pca_t: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_pca_t_fixture.csv'),
  pca_norm: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_pca_norm_fixture.csv'),
  pca_euclid: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_pca_euclid_fixture.csv'),
  heatmap_padj: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_heatmap_padj.csv'),
  heatmap_pvalue: path.join(RNASEQ_RESULTS_DIR, 'r_plot_stats_heatmap_pvalue.csv'),
}

const OUTPUT_GENES_PATH = path.join(RNASEQ_RESULTS_DIR, 'easycris_genes.csv')

function writeDataUrlToFile(dataUrl, outputPath) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('Expected image data URL export payload')
  }
  const [, payload = ''] = dataUrl.split(',', 2)
  const bytes = Buffer.from(payload, 'base64')
  fs.writeFileSync(outputPath, bytes)
}

async function exportRnaseqPlot(driver, projectId, suffix, dpi = 300) {
  const outputPath = path.join(RNASEQ_RESULTS_DIR, `easycris_plot_${suffix}.png`)
  ensureDir(RNASEQ_RESULTS_DIR)

  const exported = await driver.executeScript(
    (projectId, outputPath, dpi) => {
      if (!window.__E2E__?.exportRNAseqPlotPng) return null
      return window.__E2E__.exportRNAseqPlotPng({ projectId, outputPath, dpi })
    },
    projectId,
    outputPath,
    dpi
  )

  if (!exported) {
    throw new Error('Plot export hook unavailable (window.__E2E__.exportRNAseqPlotPng)')
  }

  if (typeof exported === 'string' && exported.startsWith('data:image/')) {
    writeDataUrlToFile(exported, outputPath)
    return outputPath
  }

  await waitForFile(outputPath, 60000)
  return outputPath
}

async function waitForRNAseqWorkspace(driver, timeout = 15000) {
  await driver.wait(async () => {
    const visible = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      return buttons.some((btn) => (btn.textContent || '').includes('Import Counts'))
    })
    return visible
  }, timeout, 'RNA-seq workspace did not render')
}

async function waitForSummaryStats(driver, timeout = 30000) {
  await driver.wait(
    until.elementLocated(By.css('[data-stat="total_genes"]')),
    timeout,
    'RNA-seq summary stats not found'
  )
}

async function waitForPlotPanel(driver, timeout = 20000) {
  await driver.wait(
    until.elementLocated(By.css('[data-testid="rnaseq-plot-type"]')),
    timeout,
    'RNA-seq plot panel did not render'
  )
}

async function ensurePlotSettingsOpen(driver) {
  const hasSettings = await driver.executeScript(() => {
    return Boolean(
      document.querySelector('[data-testid="rnaseq-use-padj-volcano"]') ||
        document.querySelector('[data-testid="rnaseq-use-padj-heatmap"]') ||
        document.querySelector('[data-testid="rnaseq-show-ellipses"]')
    )
  })
  if (hasSettings) return

  await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const target = buttons.find((btn) => (btn.textContent || '').trim() === 'Settings')
    if (target) target.click()
  })
  await driver.sleep(300)
}

async function setSwitchState(driver, testId, desired) {
  const result = await driver.executeScript((id, value) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return { found: false }
    const state = el.getAttribute('data-state')
    const checked = state === 'checked'
    if (checked !== value) {
      el.click()
    }
    return { found: true, checked: value }
  }, testId, desired)

  if (!result?.found) {
    throw new Error(`Switch not found: ${testId}`)
  }
  await driver.sleep(250)
}

async function selectPlotType(driver, plotType) {
  const opened = await driver.executeScript(() => {
    const trigger = document.querySelector('[data-testid="rnaseq-plot-type"]')
    if (!trigger) return false
    trigger.click()
    return true
  })
  if (!opened) {
    throw new Error('Plot type selector not found')
  }

  await driver.sleep(200)

  const selected = await driver.executeScript((value) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const byValue = options.find((opt) => opt.getAttribute('data-value') === value)
    const fallback = options.find((opt) =>
      (opt.textContent || '').toLowerCase().includes(value.replace('_', ' '))
    )
    const option = byValue || fallback
    if (!option) return false
    option.click()
    return true
  }, plotType)

  if (!selected) {
    throw new Error(`Plot type option not found: ${plotType}`)
  }

  await driver.sleep(300)
}

async function selectEllipseType(driver, ellipseType) {
  // Wait for dropdown to be enabled (not disabled and not pointer-events-none)
  await driver.wait(async () => {
    const ready = await driver.executeScript(() => {
      const trigger = document.querySelector('[data-testid="rnaseq-ellipse-type"]')
      if (!trigger) return false
      const isDisabled = trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true'
      const parent = trigger.parentElement
      const hasPointerEvents = !parent || !window.getComputedStyle(parent).pointerEvents.includes('none')
      return !isDisabled && hasPointerEvents
    })
    return ready
  }, 5000, 'Ellipse type dropdown did not become enabled')

  const opened = await driver.executeScript(() => {
    const trigger = document.querySelector('[data-testid="rnaseq-ellipse-type"]')
    if (!trigger) return false
    trigger.click()
    return true
  })
  if (!opened) {
    throw new Error('Ellipse type selector not found')
  }

  await driver.sleep(500)

  const textMap = {
    't': 'T distribution',
    'norm': 'Normal (chi-square)',
    'euclid': 'Euclidean circle'
  }

  const result = await driver.executeScript((value, textMap) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const targetText = textMap[value]
    const byText = options.find((opt) => (opt.textContent || '').trim() === targetText)
    if (!byText) return { success: false, found: options.map(o => o.textContent) }
    byText.click()
    return { success: true }
  }, ellipseType, textMap)

  if (!result.success) {
    throw new Error(`Ellipse type option not found: ${ellipseType}. Available: ${result.found.join(', ')}`)
  }

  await driver.sleep(300)
}

async function waitForPlotStats(driver, plotType, predicate, timeout = 60000) {
  await driver.wait(async () => {
    const stats = await driver.executeScript((type) => {
      const node = document.querySelector(`[data-plot-stats][data-plot-type="${type}"]`)
      if (!node) return null
      const attrs = {}
      for (const attr of node.attributes) {
        if (!attr.name.startsWith('data-') || attr.name === 'data-plot-stats') continue
        const key = attr.name.replace(/^data-/, '').replace(/-/g, '_')
        const num = parseFloat(attr.value)
        attrs[key] = Number.isNaN(num) ? attr.value : num
      }
      return attrs
    }, plotType)
    if (!stats) return false
    return predicate ? predicate(stats) : true
  }, timeout)
}

async function waitForFile(filePath, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`File not found: ${filePath}`)
}

async function clickButtonByText(driver, text, rootSelector = null) {
  const clicked = await driver.executeScript((buttonText, selector) => {
    const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase()
    const root = selector ? document.querySelector(selector) : document
    if (!root) return false
    const target = Array.from(root.querySelectorAll('button')).find(
      (button) =>
        normalize(button.textContent || '') === normalize(buttonText) &&
        !button.hasAttribute('disabled') &&
        button.getAttribute('aria-disabled') !== 'true'
    )
    if (!target) return false
    target.click()
    return true
  }, text, rootSelector)

  if (!clicked) {
    throw new Error(`Button not found or disabled: ${text}`)
  }
}

async function waitForConfigureButton(driver, timeout = 30000) {
  await driver.wait(async () => {
    return driver.executeScript(() => {
      const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase()
      const target = Array.from(document.querySelectorAll('button')).find(
        (button) => normalize(button.textContent || '') === 'configure'
      )
      if (!target) return false
      return !target.hasAttribute('disabled') && target.getAttribute('aria-disabled') !== 'true'
    })
  }, timeout, 'Configure button did not become enabled')
}

async function waitForConfigDialog(driver, timeout = 20000) {
  await driver.wait(async () => {
    return driver.executeScript(() => {
      return Array.from(document.querySelectorAll('[role="dialog"]')).some((dialog) =>
        (dialog.textContent || '').includes('Configure RNA-seq Model')
      )
    })
  }, timeout, 'Configure RNA-seq Model dialog did not open')
}

async function waitForConfigDialogClose(driver, timeout = 20000) {
  await driver.wait(async () => {
    return driver.executeScript(() => {
      return !Array.from(document.querySelectorAll('[role="dialog"]')).some((dialog) =>
        (dialog.textContent || '').includes('Configure RNA-seq Model')
      )
    })
  }, timeout, 'Configure RNA-seq Model dialog did not close')
}

async function waitForConfigDialogReady(driver, timeout = 30000) {
  await driver.wait(async () => {
    return driver.executeScript(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((node) =>
        normalize(node.textContent || '').includes('configure rna-seq model')
      )
      if (!dialog) return false

      const loading = normalize(dialog.textContent || '').includes('loading factor levels')
      if (loading) return false

      const factorLabel = Array.from(dialog.querySelectorAll('label')).find(
        (label) => normalize(label.textContent || '') === 'factor column'
      )
      if (!factorLabel) return false

      const trigger = factorLabel.parentElement?.querySelector(
        'button[role="combobox"], button[aria-haspopup="listbox"]'
      )
      if (!trigger) return false
      if (trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true') return false

      return true
    })
  }, timeout, 'Configure RNA-seq Model dialog did not become ready')
}

async function selectDialogOptionByLabel(driver, labelText, optionText, timeout = 20000) {
  const triggerXpath =
    `//div[@role="dialog"][.//*[contains(normalize-space(), "Configure RNA-seq Model")]]` +
    `//label[normalize-space()="${labelText}"]/following::button[@role="combobox" or @aria-haspopup="listbox"][1]`

  const attempts = 3
  const backoffMs = 350
  let lastAvailable = []

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const trigger = await driver.wait(
      until.elementLocated(By.xpath(triggerXpath)),
      timeout,
      `Select trigger not found for label: ${labelText}`
    )
    await driver.wait(until.elementIsVisible(trigger), timeout)
    await driver.executeScript((el) => {
      if (typeof el?.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' })
      }
      el.click()
    }, trigger)

    const selected = await driver.wait(async () => {
      return driver.executeScript((targetText) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
        const target = normalize(targetText)
        const openListboxes = Array.from(document.querySelectorAll('[role="listbox"]')).filter((listbox) => {
          const style = window.getComputedStyle(listbox)
          return (
            listbox.getAttribute('data-state') === 'open' ||
            (style.display !== 'none' && style.visibility !== 'hidden' && listbox.offsetParent !== null)
          )
        })

        const listbox = openListboxes.length > 0 ? openListboxes[openListboxes.length - 1] : null
        const options = Array.from(
          (listbox ?? document).querySelectorAll('[role="option"]')
        ).filter((option) => {
          const style = window.getComputedStyle(option)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })

        const available = options.map((option) =>
          String(option.textContent || '').replace(/\s+/g, ' ').trim()
        )

        const match =
          options.find((option) => normalize(option.textContent || '') === target) ||
          options.find((option) => normalize(option.getAttribute('data-value') || '') === target) ||
          options.find((option) => normalize(option.textContent || '').includes(target))

        if (!match) {
          return { found: false, available }
        }

        match.click()
        return { found: true, available }
      }, optionText)
    }, Math.max(5000, Math.floor(timeout / 2)))

    if (selected?.found) {
      await driver.sleep(200)
      return
    }

    lastAvailable = selected?.available ?? []
    // Collapse/re-open and retry after a short backoff to ride out async option hydration.
    await driver.executeScript((el) => el.click(), trigger)
    await driver.sleep(backoffMs * attempt)
  }

  throw new Error(
    `Option "${optionText}" not found for "${labelText}". Available: ${lastAvailable.join(', ')}`
  )
}

async function seedRNAseqFromCsv(driver) {
  const seed = await driver.executeScript(
    async ({ countsCsvPath, metadataCsvPath }) => {
      await window.__E2E__.clearAllData()
      const projectId = await window.__E2E__.createRNAseqProject('RNA-seq E2E Validation')
      const countsDatasetId = await window.__E2E__.importCSV(countsCsvPath)
      const metadataDatasetId = await window.__E2E__.importCSV(metadataCsvPath)
      await window.__E2E__.linkRNAseqDatasets({
        projectId,
        countsDatasetId,
        metadataDatasetId,
      })
      await window.__E2E__.setRNAseqActiveTab({ projectId, tab: 'counts' })
      return { projectId, countsDatasetId, metadataDatasetId }
    },
    { countsCsvPath: COUNTS_CSV_PATH, metadataCsvPath: METADATA_CSV_PATH }
  )

  if (!seed?.projectId) {
    throw new Error('Failed to seed RNA-seq project from CSV')
  }

  return seed
}

async function configureAndRunMainEffect(driver) {
  await waitForConfigureButton(driver)
  await clickButtonByText(driver, 'Configure')
  await waitForConfigDialog(driver)
  await waitForConfigDialogReady(driver)

  await selectDialogOptionByLabel(driver, 'Factor Column', 'Treatment')
  await selectDialogOptionByLabel(driver, 'Reference Level', 'vehicle')
  await selectDialogOptionByLabel(driver, 'Test Level', 'THC')

  await clickButtonByText(driver, 'Perform Analysis', '[role="dialog"]')
  await waitForConfigDialogClose(driver, 30000)
}

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting RNA-seq R validation...')

    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await driver.manage().setTimeouts({ script: 300000 })
    await verifyCleanState(driver)
    await assertE2EShimExists(driver)

    ensureDir(RNASEQ_RESULTS_DIR)

    logStep('Seeding RNA-seq project from CSV files...')
    const seed = await seedRNAseqFromCsv(driver)
    const { projectId } = seed
    logStep(`Seeded project ${projectId} with counts/metadata CSV`)

    await waitForRNAseqWorkspace(driver, 60000)

    logStep('Opening Configure dialog and running analysis from UI...')
    await configureAndRunMainEffect(driver)

    await waitForSummaryStats(driver, 120000)

    logStep('Validating summary metrics...')
    const summaryBaseline = loadMetricCsv(BASELINE_SUMMARY_PATH)
    const summaryActual = await extractStatsFromUI(driver, 'rnaseq')
    // pydeseq2 vs DESeq2 drift can move a non-trivial number of genes across raw p-value thresholds
    // even when gene-level metrics are within tolerance. Allow a larger relative tolerance for these
    // derived count metrics while keeping the rest of the summary strict.
    const summaryComparison = compareToRBaseline(summaryActual, summaryBaseline, {
      defaultTolerance: 0.03,
      bootstrapTolerance: 0.1,
      bootstrapMetrics: ['significant_p05', 'significant_p01', 'significant_p001'],
    })
    assertValidation(summaryComparison)
    logSuccess(`Summary metrics validated (${summaryComparison.totalMetrics})`)

    logStep('Exporting gene results CSV...')
    await driver.executeScript((projectId, outputPath) => {
      return window.__E2E__.exportRNAseqResultsCsv({ projectId, outputPath })
    }, projectId, OUTPUT_GENES_PATH)
    await waitForFile(OUTPUT_GENES_PATH)

    logStep('Validating gene metrics...')
    const genesBaseline = loadGeneCsv(BASELINE_GENES_PATH)
    const genesActual = loadGeneCsv(OUTPUT_GENES_PATH)
    // DESeq2 (R) vs PyDESeq2 drift is expected for raw p-values and sig-category cutoffs.
    // We still validate core numeric gene metrics and the full plot/stat pipelines separately.
    const geneComparison = compareGeneResults(genesActual, genesBaseline, {
      skipSigCategory: true,
    })
    assertGeneResults(geneComparison)
    logSuccess(`Gene metrics validated (${geneComparison.totalBaseline})`)

    logStep('Switching to Plots tab...')
    await driver.executeScript((projectId) => {
      return window.__E2E__.setRNAseqActiveTab({ projectId, tab: 'plots' })
    }, projectId)
    await waitForPlotPanel(driver)
    await ensurePlotSettingsOpen(driver)

    logStep('Validating volcano plot (padj)...')
    await selectPlotType(driver, 'volcano')
    await ensurePlotSettingsOpen(driver)
    await setSwitchState(driver, 'rnaseq-use-padj-volcano', true)
    await waitForPlotStats(driver, 'volcano', (stats) => stats.volcano_use_padj === 1)
    const volcanoPadj = await extractPlotStatsFromUI(driver, 'volcano')
    const volcanoPadjBaseline = loadMetricCsv(PLOT_BASELINES.volcano_padj)
    assertValidation(compareToRBaseline(volcanoPadj, volcanoPadjBaseline, 0.01))
    await exportRnaseqPlot(driver, projectId, 'volcano_padj', 300)
    logSuccess('Volcano plot (padj) validated')

    logStep('Validating volcano plot (pvalue)...')
    await setSwitchState(driver, 'rnaseq-use-padj-volcano', false)
    await waitForPlotStats(driver, 'volcano', (stats) => stats.volcano_use_padj === 0)
    const volcanoP = await extractPlotStatsFromUI(driver, 'volcano')
    const volcanoPBaseline = loadMetricCsv(PLOT_BASELINES.volcano_pvalue)
    assertValidation(compareToRBaseline(volcanoP, volcanoPBaseline, 0.01))
    await exportRnaseqPlot(driver, projectId, 'volcano_pvalue', 300)
    logSuccess('Volcano plot (pvalue) validated')

    logStep('Validating MA plot (padj)...')
    await selectPlotType(driver, 'ma_plot')
    await ensurePlotSettingsOpen(driver)
    await setSwitchState(driver, 'rnaseq-use-padj-volcano', true)
    await waitForPlotStats(driver, 'ma_plot', (stats) => stats.ma_use_padj === 1)
    const maPadj = await extractPlotStatsFromUI(driver, 'ma_plot')
    const maPadjBaseline = loadMetricCsv(PLOT_BASELINES.ma_padj)
    assertValidation(compareToRBaseline(maPadj, maPadjBaseline, 0.01))
    await exportRnaseqPlot(driver, projectId, 'ma_padj', 300)
    logSuccess('MA plot (padj) validated')

    logStep('Validating MA plot (pvalue)...')
    await setSwitchState(driver, 'rnaseq-use-padj-volcano', false)
    await waitForPlotStats(driver, 'ma_plot', (stats) => stats.ma_use_padj === 0)
    const maP = await extractPlotStatsFromUI(driver, 'ma_plot')
    const maPBaseline = loadMetricCsv(PLOT_BASELINES.ma_pvalue)
    assertValidation(compareToRBaseline(maP, maPBaseline, 0.01))
    await exportRnaseqPlot(driver, projectId, 'ma_pvalue', 300)
    logSuccess('MA plot (pvalue) validated')

    logStep('Validating DEG bar plot...')
    await selectPlotType(driver, 'deg_bar')
    await waitForPlotStats(driver, 'deg_bar')
    const degBar = await extractPlotStatsFromUI(driver, 'deg_bar')
    const degBarBaseline = loadMetricCsv(PLOT_BASELINES.deg_bar)
    assertValidation(compareToRBaseline(degBar, degBarBaseline, {
      defaultTolerance: 0.01,
      bootstrapTolerance: 0.1,
      bootstrapMetrics: ['deg_sig_p05'],
    }))
    await exportRnaseqPlot(driver, projectId, 'deg_bar', 300)
    logSuccess('DEG bar plot validated')

    logStep('Validating PCA plot (t)...')
    await selectPlotType(driver, 'pca_biplot')
    await ensurePlotSettingsOpen(driver)
    await setSwitchState(driver, 'rnaseq-show-ellipses', true)
    await driver.sleep(500) // Wait for ellipse dropdown to become enabled
    await selectEllipseType(driver, 't')
    await waitForPlotStats(driver, 'pca_biplot', (stats) => stats.pca_ellipse_type === 1)
    const pcaT = await extractPlotStatsFromUI(driver, 'pca_biplot')
    const pcaTBaseline = loadMetricCsv(PLOT_BASELINES.pca_t)
    assertValidation(compareToRBaseline(pcaT, pcaTBaseline, 0.1))
    await exportRnaseqPlot(driver, projectId, 'pca_t', 300)
    logSuccess('PCA plot (t) validated')

    logStep('Validating PCA plot (norm)...')
    await selectEllipseType(driver, 'norm')
    await waitForPlotStats(driver, 'pca_biplot', (stats) => stats.pca_ellipse_type === 2)
    const pcaNorm = await extractPlotStatsFromUI(driver, 'pca_biplot')
    const pcaNormBaseline = loadMetricCsv(PLOT_BASELINES.pca_norm)
    assertValidation(compareToRBaseline(pcaNorm, pcaNormBaseline, 0.1))
    await exportRnaseqPlot(driver, projectId, 'pca_norm', 300)
    logSuccess('PCA plot (norm) validated')

    logStep('Validating PCA plot (euclid)...')
    await selectEllipseType(driver, 'euclid')
    await waitForPlotStats(driver, 'pca_biplot', (stats) => stats.pca_ellipse_type === 3)
    const pcaEuclid = await extractPlotStatsFromUI(driver, 'pca_biplot')
    const pcaEuclidBaseline = loadMetricCsv(PLOT_BASELINES.pca_euclid)
    assertValidation(compareToRBaseline(pcaEuclid, pcaEuclidBaseline, 0.1))
    await exportRnaseqPlot(driver, projectId, 'pca_euclid', 300)
    logSuccess('PCA plot (euclid) validated')

    logStep('Validating heatmap (padj)...')
    await selectPlotType(driver, 'heatmap')
    await ensurePlotSettingsOpen(driver)
    await setSwitchState(driver, 'rnaseq-use-padj-heatmap', true)
    await waitForPlotStats(driver, 'heatmap', (stats) => stats.heatmap_ready === 1 && stats.heatmap_use_padj === 1)
    const heatmapPadj = await extractPlotStatsFromUI(driver, 'heatmap')
    const heatmapPadjBaseline = loadMetricCsv(PLOT_BASELINES.heatmap_padj)
    assertValidation(compareToRBaseline(heatmapPadj, heatmapPadjBaseline, 0.01))
    await exportRnaseqPlot(driver, projectId, 'heatmap_padj', 300)
    logSuccess('Heatmap (padj) validated')

    logStep('Validating heatmap (pvalue)...')
    await setSwitchState(driver, 'rnaseq-use-padj-heatmap', false)
    await waitForPlotStats(driver, 'heatmap', (stats) => stats.heatmap_ready === 1 && stats.heatmap_use_padj === 0)
    const heatmapP = await extractPlotStatsFromUI(driver, 'heatmap')
    const heatmapPBaseline = loadMetricCsv(PLOT_BASELINES.heatmap_pvalue)
    assertValidation(compareToRBaseline(heatmapP, heatmapPBaseline, 0.01))
    await exportRnaseqPlot(driver, projectId, 'heatmap_pvalue', 300)
    logSuccess('Heatmap (pvalue) validated')

    logSuccess('COMPLETE: RNA-seq summary, genes, and plots validated')
  } catch (error) {
    console.error(`[Test] FAILED: ${error.message}`)
    throw error
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
