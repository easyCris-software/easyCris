/**
 * R Baseline Validation: Dose-Response 3PL Interpolation
 * Validates forward/inverse interpolation values in plot sidebar against R checkpoints.
 */

import { By, Key, until } from 'selenium-webdriver'
import { setupTest, cleanupTest, verifyCleanState } from '../../utils/selenium-setup.mjs'
import { loadFixture } from '../../utils/fixtures.mjs'
import { loadPlotBaseline, selectPlotFromGalleryByType } from '../../utils/plot-validation.mjs'
import { logStep, logSuccess, assertCloseTo, assertEqual } from '../../utils/assertions.mjs'
import { exportPlotScreenshot } from '../../utils/r-validation.mjs'
import { runDoseResponse3PL, waitForResults, switchToPlotsTab } from '../../utils/ui-workflow.mjs'

async function ensureInterpolationPanelVisible(driver) {
  await driver.executeScript(() => {
    const appStore = window.useAppStore?.getState?.()
    appStore?.setShowPlotSidebar?.(true)
    appStore?.setPlotSidebarTab?.('axes')
  })

  let inputEls = await driver.findElements(By.css('[data-testid="dose-interpolation-input"]'))
  if (inputEls.length > 0) return

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

  inputEls = await driver.findElements(By.css('[data-testid="dose-interpolation-input"]'))
  if (inputEls.length > 0) return

  await driver.executeScript(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((el) => (el.textContent || '').trim().toLowerCase() === 'axes')
    tab?.click()
  })

  await driver.wait(until.elementLocated(By.css('[data-testid="dose-interpolation-input"]')), 10000)
}

async function setInterpolationMode(driver, modeLabel) {
  const trigger = await driver.wait(until.elementLocated(By.css('[data-testid="dose-interpolation-mode"]')), 5000)
  await trigger.click()
  const option = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='option' and normalize-space(.)='${modeLabel}']`)),
    5000
  )
  await option.click()
}

async function setInterpolationInput(driver, value) {
  const input = await driver.wait(until.elementLocated(By.css('[data-testid="dose-interpolation-input"]')), 5000)
  await input.click()
  await input.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE)
  await input.sendKeys(String(value))
  return input
}

async function readInterpolationStats(driver) {
  return driver.executeScript(() => {
    const activePlotId = window.usePlotsStore?.getState?.().activePlotId
    const byActiveId = activePlotId
      ? document.querySelector(`[data-plot-stats][data-plot-id="${activePlotId}"]`)
      : null
    const byTestType = document.querySelector('[data-plot-stats][data-test-type="dose_response_3pl"]')
    const fallbackNode = document.querySelector('[data-plot-stats]')
    const node = byActiveId ?? byTestType ?? fallbackNode
    if (!node) return null
    const parseNum = (name) => {
      const raw = node.getAttribute(name)
      if (raw === null || raw === '') return null
      const value = Number(raw)
      return Number.isFinite(value) ? value : null
    }
    return {
      mode: node.getAttribute('data-interpolation-mode'),
      input: parseNum('data-interpolation-input'),
      output: parseNum('data-interpolation-output'),
      extrapolated: node.getAttribute('data-interpolation-extrapolated'),
    }
  })
}

async function waitForInterpolation(driver, expectedMode, expectedOutput) {
  await driver.wait(async () => {
    const stats = await readInterpolationStats(driver)
    if (!stats) return false
    if (stats.mode !== expectedMode) return false
    if (stats.output === null) return false
    return Math.abs(stats.output - expectedOutput) <= 0.03
  }, 10000, `Interpolation stats did not update for ${expectedMode}`)
}

async function readInterpolationStatsOrThrow(driver) {
  const stats = await readInterpolationStats(driver)
  if (!stats) {
    throw new Error('Interpolation stats unavailable for active plot')
  }
  return stats
}

async function runTest() {
  let driver, webdriver

  try {
    logStep('Starting Dose-Response 3PL interpolation validation...')
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)

    await loadFixture(driver, 'dose_response_3pl')
    const baseline = loadPlotBaseline('dose_response_3pl_interpolation_r_baseline.json')

    await runDoseResponse3PL(driver, {})
    await waitForResults(driver)
    await switchToPlotsTab(driver)
    await selectPlotFromGalleryByType(driver, 'doseresponse')
    await ensureInterpolationPanelVisible(driver)

    // Forward mode via Compute click
    logStep('Validating forward interpolation via Compute click...')
    await setInterpolationMode(driver, 'Conc -> Response')
    await setInterpolationInput(driver, baseline.interpolation_forward_x_input)
    const computeBtn = await driver.findElement(By.css('[data-testid="dose-interpolation-compute"]'))
    await computeBtn.click()
    await waitForInterpolation(driver, 'forward', baseline.interpolation_forward_y_output)

    let stats = await readInterpolationStatsOrThrow(driver)
    assertEqual(stats.mode, 'forward', 'Forward interpolation mode was not persisted')
    assertCloseTo(
      stats.input,
      baseline.interpolation_forward_x_input,
      0.0005,
      'Forward interpolation input mismatch'
    )
    assertCloseTo(
      stats.output,
      baseline.interpolation_forward_y_output,
      0.03,
      'Forward interpolation output mismatch'
    )
    assertEqual(stats.extrapolated, 'false', 'Forward interpolation should not be extrapolated')
    await exportPlotScreenshot(driver, 'dose_response_3pl', 300, 'interpolation_forward')

    // Inverse mode via Enter key
    logStep('Validating inverse interpolation via Enter key...')
    await setInterpolationMode(driver, 'Response -> Conc')
    const inputEl = await setInterpolationInput(driver, baseline.interpolation_inverse_y_input)
    await inputEl.sendKeys(Key.ENTER)
    await waitForInterpolation(driver, 'inverse', baseline.interpolation_inverse_x_output)

    stats = await readInterpolationStatsOrThrow(driver)
    assertEqual(stats.mode, 'inverse', 'Inverse interpolation mode was not persisted')
    assertCloseTo(
      stats.input,
      baseline.interpolation_inverse_y_input,
      0.0005,
      'Inverse interpolation input mismatch'
    )
    assertCloseTo(
      stats.output,
      baseline.interpolation_inverse_x_output,
      0.03,
      'Inverse interpolation output mismatch'
    )
    assertEqual(stats.extrapolated, 'false', 'Inverse interpolation should not be extrapolated')
    await exportPlotScreenshot(driver, 'dose_response_3pl', 300, 'interpolation_inverse')

    logSuccess('Dose-Response 3PL interpolation validation passed')
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
