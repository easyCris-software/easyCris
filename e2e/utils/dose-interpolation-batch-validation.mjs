import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { By, Key, until } from 'selenium-webdriver'
import { assertCloseTo, assertEqual } from './assertions.mjs'

export const DEFAULT_BATCH_INTERPOLATION_INPUTS = [12, 5, 6, 7, 99, 1.5, 8.9, 7]

const DEFAULT_R_WINDOWS_PATH = 'C:/Program Files/R/R-4.5.1/bin/R.exe'

const parseCsvLine = (line) => {
  const cells = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }

    if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
      continue
    }

    current += ch
  }

  cells.push(current)
  return cells
}

const parseMaybeNumber = (value) => {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function loadBatchInterpolationCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Batch interpolation CSV not found: ${filePath}`)
  }

  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  if (lines.length <= 1) return []

  return lines.slice(1).map((line) => {
    const [row, input, output, status, extrapolated, message] = parseCsvLine(line)
    return {
      row: parseMaybeNumber(row),
      input: parseMaybeNumber(input),
      output: parseMaybeNumber(output),
      status: String(status ?? '').trim().toLowerCase(),
      extrapolated: String(extrapolated ?? '').trim().toLowerCase(),
      message: String(message ?? '').trim(),
    }
  })
}

export function compareBatchInterpolationRows(actualRows, expectedRows, options = {}) {
  const inputTolerance = options.inputTolerance ?? 1e-9
  const outputTolerance = options.outputTolerance ?? 0.05
  const compareMessage = options.compareMessage ?? true

  assertEqual(
    actualRows.length,
    expectedRows.length,
    `Batch interpolation row count mismatch (easyCris=${actualRows.length}, R=${expectedRows.length})`
  )

  for (let i = 0; i < expectedRows.length; i += 1) {
    const expected = expectedRows[i]
    const actual = actualRows[i]
    const rowLabel = `row ${i + 1}`

    assertCloseTo(
      Number(actual.input),
      Number(expected.input),
      inputTolerance,
      `Input mismatch at ${rowLabel}`
    )

    if (expected.output === null || actual.output === null) {
      assertEqual(actual.output, expected.output, `Output nullability mismatch at ${rowLabel}`)
    } else {
      assertCloseTo(
        Number(actual.output),
        Number(expected.output),
        outputTolerance,
        `Output mismatch at ${rowLabel}`
      )
    }

    assertEqual(
      String(actual.status ?? '').toLowerCase(),
      String(expected.status ?? '').toLowerCase(),
      `Status mismatch at ${rowLabel}`
    )
    assertEqual(
      String(actual.extrapolated ?? '').toLowerCase(),
      String(expected.extrapolated ?? '').toLowerCase(),
      `Extrapolated flag mismatch at ${rowLabel}`
    )

    if (compareMessage) {
      assertEqual(
        String(actual.message ?? ''),
        String(expected.message ?? ''),
        `Message mismatch at ${rowLabel}`
      )
    }
  }
}

export async function ensureInterpolationPanelVisible(driver) {
  await driver.executeScript(() => {
    const appStore = window.useAppStore?.getState?.()
    appStore?.setShowPlotSidebar?.(true)
    appStore?.setPlotSidebarTab?.('axes')
  })

  let modeEls = await driver.findElements(By.css('[data-testid="dose-interpolation-mode"]'))
  if (modeEls.length > 0) return

  await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const axesBtn = buttons.find((btn) => (btn.textContent || '').trim() === 'Axes')
    if (axesBtn) {
      axesBtn.click()
      return
    }
    const showSettingsBtn = buttons.find((btn) => (btn.textContent || '').includes('Show settings'))
    showSettingsBtn?.click()
  })

  modeEls = await driver.findElements(By.css('[data-testid="dose-interpolation-mode"]'))
  if (modeEls.length > 0) return

  await driver.executeScript(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((el) => (el.textContent || '').trim().toLowerCase() === 'axes')
    tab?.click()
  })

  await driver.wait(until.elementLocated(By.css('[data-testid="dose-interpolation-mode"]')), 10000)
}

export async function setInterpolationMode(driver, modeLabel) {
  const trigger = await driver.wait(until.elementLocated(By.css('[data-testid="dose-interpolation-mode"]')), 5000)
  await trigger.click()
  const option = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='option' and normalize-space(.)='${modeLabel}']`)),
    5000
  )
  await option.click()
}

export async function setBatchInterpolationEntryMode(driver) {
  let batchInput = await driver.findElements(By.css('[data-testid="dose-interpolation-batch-input"]'))
  if (batchInput.length > 0) return

  const batchButton = await driver.wait(
    until.elementLocated(By.xpath("//button[normalize-space(.)='Batch']")),
    5000
  )
  await batchButton.click()

  await driver.wait(until.elementLocated(By.css('[data-testid="dose-interpolation-batch-input"]')), 5000)
}

export async function setBatchInterpolationInput(driver, values) {
  const textarea = await driver.wait(
    until.elementLocated(By.css('[data-testid="dose-interpolation-batch-input"]')),
    5000
  )
  await textarea.click()
  await textarea.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE)
  await textarea.sendKeys(values.map((value) => String(value)).join('\n'))
}

export async function runBatchInterpolation(driver) {
  const computeBtn = await driver.wait(
    until.elementLocated(By.css('[data-testid="dose-interpolation-compute"]')),
    5000
  )
  await computeBtn.click()
}

export async function waitForBatchInterpolationStats(driver, minCount = 1) {
  await driver.wait(async () => {
    const stats = await driver.executeScript(() => {
      const activePlotId = window.usePlotsStore?.getState?.().activePlotId
      const byActiveId = activePlotId
        ? document.querySelector(`[data-plot-stats][data-plot-id="${activePlotId}"]`)
        : null
      const fallbackNode = document.querySelector('[data-plot-stats]')
      const node = byActiveId ?? fallbackNode
      if (!node) return null
      const countValue = Number(node.getAttribute('data-interpolation-count') ?? '')
      const rawJson = node.getAttribute('data-interpolation-results-json') ?? ''
      return {
        count: Number.isFinite(countValue) ? countValue : 0,
        hasJson: rawJson.trim().length > 0,
      }
    })

    if (!stats) return false
    return stats.count >= minCount && stats.hasJson
  }, 10000, 'Batch interpolation stats did not appear')
}

export async function exportBatchInterpolationCsv(driver, outputPath, plotId) {
  const exportedPath = await driver.executeScript(
    (pathArg, plotIdArg) => {
      if (!window.__E2E__?.exportDoseInterpolationResultsCsv) {
        throw new Error('window.__E2E__.exportDoseInterpolationResultsCsv is unavailable')
      }
      return window.__E2E__.exportDoseInterpolationResultsCsv({
        outputPath: pathArg,
        plotId: plotIdArg || undefined,
      })
    },
    outputPath,
    plotId ?? null
  )

  return String(exportedPath)
}

export function runRBatchBaseline({
  rScriptPath,
  outputCsvPath,
  rExecutablePath = process.env.R_TERM_WINDOWS || DEFAULT_R_WINDOWS_PATH,
}) {
  const resolvedScriptPath = path.resolve(rScriptPath)
  const resolvedOutputPath = path.resolve(outputCsvPath)

  if (!fs.existsSync(resolvedScriptPath)) {
    throw new Error(`R script not found: ${resolvedScriptPath}`)
  }

  const runResult = spawnSync(
    rExecutablePath,
    ['--vanilla', '-f', resolvedScriptPath],
    {
      cwd: path.dirname(resolvedScriptPath),
      encoding: 'utf-8',
    }
  )

  if (runResult.error) {
    throw new Error(`Failed to start R executable (${rExecutablePath}): ${runResult.error.message}`)
  }

  if (runResult.status !== 0) {
    const stderr = String(runResult.stderr ?? '').trim()
    const stdout = String(runResult.stdout ?? '').trim()
    throw new Error(
      `R script failed (${resolvedScriptPath}) with exit code ${runResult.status}\n` +
      `stdout:\n${stdout}\n` +
      `stderr:\n${stderr}`
    )
  }

  if (!fs.existsSync(resolvedOutputPath)) {
    throw new Error(`R output CSV missing after run: ${resolvedOutputPath}`)
  }
}
