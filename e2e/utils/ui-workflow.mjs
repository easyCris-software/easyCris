/**
 * UI Workflow Helpers
 * Automates common UI interactions for running statistical tests
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation infrastructure (655 metrics).
 * Contains UI automation workflows for all 10 Group 1 hypothesis tests.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import { until, By } from 'selenium-webdriver'
import { logStep } from './assertions.mjs'

async function getResultsSnapshot(driver) {
  return driver.executeScript(() => {
    const store = window.useResultsStore?.getState?.()
    if (!store) return null

    const activeFamilyId = store.activeStatisticsFamilyId
    const current = store.currentResult
    const currentId = current?.id ?? (activeFamilyId ? store.currentResultIdByFamily?.[activeFamilyId] : null)
    const executedAt = current?.executedAt

    let executedAtMs = null
    if (executedAt) {
      if (executedAt instanceof Date) {
        executedAtMs = executedAt.getTime()
      } else if (typeof executedAt === 'number') {
        executedAtMs = executedAt
      } else if (typeof executedAt === 'string') {
        const parsed = Date.parse(executedAt)
        executedAtMs = Number.isNaN(parsed) ? null : parsed
      }
    }

    return {
      currentId,
      executedAtMs,
      resultsCount: Array.isArray(store.results) ? store.results.length : 0,
    }
  })
}

async function selectRadixOption(driver, testId, value, options = {}) {
  if (!value) return false
  let triggerEls = []
  const dialogRoots = await driver.findElements(By.css('[data-slot="dialog-content"], [data-radix-dialog-content], [role="dialog"]'))
  if (dialogRoots.length > 0) {
    const dialogRoot = dialogRoots[dialogRoots.length - 1]
    triggerEls = await dialogRoot.findElements(By.css(`[data-testid="${testId}"]`))
  }
  if (triggerEls.length === 0) {
    triggerEls = await driver.findElements(By.css(`[data-testid="${testId}"]`))
  }
  if (triggerEls.length === 0) {
    if (options.required) {
      throw new Error(`Missing select trigger: ${testId}`)
    }
    return false
  }

  const target = String(value).trim().toLowerCase()
  const matchAttr = options.matchAttribute || null

  const waitForOverlayClear = async () => {
    try {
      await driver.wait(async () => {
        return driver.executeScript(() => {
          const overlays = Array.from(document.querySelectorAll('[data-slot="dialog-overlay"]'))
          if (overlays.length === 0) return true
          return overlays.every((overlay) => overlay.getAttribute('data-state') !== 'open')
        })
      }, 1500)
    } catch {
      // Ignore timeout: we'll fall back to JS click if overlay is still open.
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForOverlayClear()
    const overlayOpen = await driver.executeScript(() => {
      const overlays = Array.from(document.querySelectorAll('[data-slot="dialog-overlay"]'))
      return overlays.some((overlay) => overlay.getAttribute('data-state') === 'open')
    })

    const selected = await driver.executeScript((trigger, targetValue, attrName) => {
      if (!trigger) return false

      if (typeof trigger.scrollIntoView === 'function') {
        trigger.scrollIntoView({ block: 'center', inline: 'center' })
      }
      trigger.click()

      const optionEls = Array.from(document.querySelectorAll('[role="option"]'))
      if (optionEls.length === 0) return false

      const target = String(targetValue || '').trim().toLowerCase()
      const matchAttr = attrName ? String(attrName) : ''

      for (const opt of optionEls) {
        if (matchAttr) {
          const attr = opt.getAttribute(matchAttr)
          if (attr && attr.trim().toLowerCase() === target) {
            opt.click()
            return true
          }
        }
        const dataValue = opt.getAttribute('data-value')
        if (dataValue && dataValue.trim().toLowerCase() === target) {
          opt.click()
          return true
        }
        const text = (opt.textContent || '').trim().toLowerCase()
        if (text === target) {
          opt.click()
          return true
        }
      }

      return false
    }, triggerEls[0], target, matchAttr)
    if (selected) {
      await driver.sleep(200)
      return true
    }

    if (overlayOpen) {
      await driver.sleep(200)
      continue
    }

    await triggerEls[0].click()
    await driver.sleep(200)

    let optionEls = await driver.findElements(By.css('[role="option"]'))
    if (optionEls.length === 0) {
      await driver.sleep(200)
      optionEls = await driver.findElements(By.css('[role="option"]'))
    }

    for (const opt of optionEls) {
      if (matchAttr) {
        const attr = await opt.getAttribute(matchAttr)
        if (attr && attr.trim().toLowerCase() === target) {
          await opt.click()
          await driver.sleep(200)
          return true
        }
      }

      const dataValue = await opt.getAttribute('data-value')
      if (dataValue && dataValue.trim().toLowerCase() === target) {
        await opt.click()
        await driver.sleep(200)
        return true
      }

      const text = (await opt.getText()).trim().toLowerCase()
      if (text === target) {
        await opt.click()
        await driver.sleep(200)
        return true
      }
    }

    await driver.sleep(200)
  }

  if (options.required) {
    throw new Error(`Failed to select option "${value}" for ${testId}`)
  }

  return false
}

async function getRadixTriggerText(driver, testId) {
  try {
    return await driver.executeScript((id) => {
      const trigger = document.querySelector(`[data-testid="${id}"]`)
      return trigger?.textContent?.trim() || ''
    }, testId)
  } catch (error) {
    return ''
  }
}

function matchesAdjustmentValue(method, triggerText) {
  const text = (triggerText || '').toLowerCase()
  const value = String(method || '').toLowerCase()

  if (!text || !value) return false

  // Special-case Holm/Sidak ambiguity
  if (value === 'holm') {
    return text.includes('holm') && !text.includes('sidak')
  }
  if (value === 'sidak') {
    return text.includes('sidak') && !text.includes('holm')
  }
  if (value === 'holm-sidak') {
    return text.includes('holm') && text.includes('sidak')
  }

  return text.includes(value)
}

async function performColumnCardAction(driver, action, payload = {}) {
  return driver.executeScript(({ requestedAction, actionPayload }) => {
    const getActiveDialog = () => {
      const dialogs = Array.from(
        document.querySelectorAll('[data-slot="dialog-content"], [data-radix-dialog-content], [role="dialog"]')
      )
      return dialogs.length > 0 ? dialogs[dialogs.length - 1] : document.body
    }

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()

    const getCardName = (el) => {
      const text = String(el?.innerText || el?.textContent || '')
      const firstLine = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      return normalize(firstLine || text)
    }

    const getCardType = (el) => {
      const text = normalize(el?.innerText || el?.textContent || '').toLowerCase()
      const match = text.match(/\b(numeric|binary|categorical|ordinal)\b/)
      return match ? match[1] : null
    }

    const isSelected = (el) => {
      const ariaPressed = el?.getAttribute?.('aria-pressed')
      if (ariaPressed === 'true') return true
      if (ariaPressed === 'false') return false
      const className = String(el?.className || '')
      return /\bselected\b/i.test(className)
    }

    const isTypedColumnCard = (el, opts = {}) => {
      const { requireLegacyOnClick = false } = opts
      if (!el) return false
      const text = normalize(el.innerText || el.textContent || '')
      if (!text || text.length > 700) return false
      const style = window.getComputedStyle(el)
      const hasPointer = style.cursor === 'pointer' || String(el.tagName || '').toLowerCase() === 'button'
      if (!hasPointer) return false
      if (requireLegacyOnClick && !el.onclick) return false
      const hasTypeBadge = /\b(numeric|binary|categorical|ordinal)\b/i.test(text)
      const hasMetadata = /unique values|range:/i.test(text)
      return hasTypeBadge && hasMetadata
    }

    const isFallbackCandidate = (el) => {
      if (!el) return false
      const tag = String(el.tagName || '').toLowerCase()
      if (tag !== 'button' && tag !== 'div') return false
      const style = window.getComputedStyle(el)
      if (style.cursor !== 'pointer' && tag !== 'button') return false
      const text = normalize(el.innerText || el.textContent || '')
      if (!text || text.length > 700) return false
      const lower = text.toLowerCase()
      if (
        lower.includes('run analysis') ||
        lower.includes('run test') ||
        lower.includes('cancel') ||
        lower.includes('select a test')
      ) {
        return false
      }
      return true
    }

    const collectCards = () => {
      const dialog = getActiveDialog()
      const buttonCards = Array.from(
        dialog.querySelectorAll('button[aria-pressed], button[type="button"]')
      ).filter((el) => isTypedColumnCard(el))

      const legacyDivCardsStrict = Array.from(dialog.querySelectorAll('div')).filter((el) =>
        isTypedColumnCard(el, { requireLegacyOnClick: true })
      )
      const legacyDivCardsLoose = Array.from(dialog.querySelectorAll('div')).filter((el) =>
        isTypedColumnCard(el)
      )

      let cards = buttonCards
      let source = 'button'
      if (cards.length === 0) {
        cards = legacyDivCardsStrict.length > 0 ? legacyDivCardsStrict : legacyDivCardsLoose
        source = legacyDivCardsStrict.length > 0 ? 'legacy-div-onclick' : 'legacy-div'
      }

      const fallbackCandidates = Array.from(dialog.querySelectorAll('button, div')).filter((el) =>
        isFallbackCandidate(el)
      )

      const describe = (el, index) => ({
        index,
        name: getCardName(el),
        type: getCardType(el),
        selected: isSelected(el),
      })

      return {
        cards,
        source,
        fallbackCandidates,
        descriptors: cards.map((el, index) => describe(el, index)),
      }
    }

    const clickIfNeeded = (el) => {
      if (!el) return false
      if (isSelected(el)) return false
      el.click()
      return true
    }

    const selectionSnapshot = (cards) =>
      cards
        .filter((card) => isSelected(card))
        .map((card) => getCardName(card))
        .filter(Boolean)

    const { cards, source, fallbackCandidates, descriptors } = collectCards()

    if (requestedAction === 'snapshot') {
      return {
        source,
        cardCount: cards.length,
        fallbackCandidatesCount: fallbackCandidates.length,
        cards: descriptors,
      }
    }

    if (requestedAction === 'selectByNames') {
      const requestedNames = Array.isArray(actionPayload?.names) ? actionPayload.names : []
      const availableColumns = descriptors.map((d) => d.name)
      const missing = []
      const clickedNames = []

      for (const rawName of requestedNames) {
        const target = normalize(rawName)
        if (!target) continue

        let index = descriptors.findIndex((d) => d.name === target)
        if (index === -1) {
          index = descriptors.findIndex((d) => d.name.toLowerCase() === target.toLowerCase())
        }

        if (index === -1) {
          missing.push(rawName)
          continue
        }

        if (clickIfNeeded(cards[index])) {
          clickedNames.push(descriptors[index]?.name || target)
        }
      }

      return {
        source,
        cardCount: cards.length,
        fallbackCandidatesCount: fallbackCandidates.length,
        availableColumns,
        clicked: clickedNames.length,
        clickedNames,
        missing,
        selectedAfter: selectionSnapshot(cards),
      }
    }

    if (requestedAction === 'autoSelect') {
      const categoricalCards = descriptors
        .filter((d) => d.type === 'binary' || d.type === 'categorical')
        .map((d) => ({ index: d.index, name: d.name }))
      const numericCards = descriptors
        .filter((d) => d.type === 'numeric')
        .map((d) => ({ index: d.index, name: d.name }))

      const clickedNames = []
      let clickedCount = 0
      let usedHardFallback = false

      const clickByIndex = (index) => {
        const card = cards[index]
        if (!card) return
        if (clickIfNeeded(card)) {
          clickedCount += 1
          clickedNames.push(getCardName(card))
        }
      }

      if (categoricalCards.length >= 2 && numericCards.length >= 1) {
        categoricalCards.forEach((card) => clickByIndex(card.index))
        const valueCard = numericCards.find((card) => {
          const text = String(card.name || '').toLowerCase()
          return text.includes('value')
        })
        clickByIndex(valueCard ? valueCard.index : numericCards[numericCards.length - 1].index)
      } else if (categoricalCards.length === 1 && numericCards.length >= 1) {
        clickByIndex(categoricalCards[0].index)
        clickByIndex(numericCards[0].index)
      } else if (numericCards.length >= 2) {
        numericCards.forEach((card) => clickByIndex(card.index))
      } else if (numericCards.length === 1) {
        clickByIndex(numericCards[0].index)
      } else if (categoricalCards.length > 0) {
        clickByIndex(categoricalCards[0].index)
      }

      if (clickedCount === 0 && cards.length > 0) {
        cards.slice(0, Math.min(2, cards.length)).forEach((card) => {
          if (clickIfNeeded(card)) {
            clickedCount += 1
            clickedNames.push(getCardName(card))
          }
        })
      }

      if (clickedCount === 0 && cards.length === 0 && fallbackCandidates.length > 0) {
        usedHardFallback = true
        fallbackCandidates.slice(0, Math.min(2, fallbackCandidates.length)).forEach((candidate) => {
          candidate.click()
          clickedCount += 1
          clickedNames.push(getCardName(candidate))
        })
      }

      return {
        source,
        cardCount: cards.length,
        fallbackCandidatesCount: fallbackCandidates.length,
        availableColumns: descriptors.map((d) => d.name),
        clickedCount,
        clickedNames,
        usedHardFallback,
        selectedAfter: selectionSnapshot(cards),
      }
    }

    return {
      source,
      cardCount: cards.length,
      fallbackCandidatesCount: fallbackCandidates.length,
      cards: descriptors,
    }
  }, { requestedAction: action, actionPayload: payload })
}

/**
 * Wait for dataset to be active and visible in the grid
 */
async function waitForDatasetActive(driver) {
  logStep('[UI] Waiting for dataset to be active...')

  // Glide Data Grid uses canvas rendering, not HTML cells
  // Wait for:
  // 1. Dataset count > 0 (data is loaded)
  // 2. Canvas elements exist (grid is rendered)
  // 3. Status text shows row/column count (UI is aware of data)
  await driver.wait(async () => {
    const state = await driver.executeScript(() => {
      const datasetCount = window.__E2E__?.getDatasetCount?.() || 0
      const canvasCount = document.querySelectorAll('canvas').length
      const bodyText = document.body.innerText
      const hasRowColInfo = bodyText.includes('rows') && bodyText.includes('columns')

      return {
        hasDatasets: datasetCount > 0,
        hasCanvas: canvasCount > 0,
        hasStatusInfo: hasRowColInfo,
        ready: datasetCount > 0 && canvasCount > 0 && hasRowColInfo
      }
    })

    if (state.ready) {
      logStep(`[UI] Dataset active - ${state.hasDatasets ? 'data loaded' : 'no data'}, ${state.hasCanvas ? 'grid rendered' : 'no grid'}, ${state.hasStatusInfo ? 'status ok' : 'no status'}`)
    }

    return state.ready
  }, 15000)

  logStep('[UI] Dataset is active and grid is rendered')

  // Additional wait for React state to settle
  await driver.sleep(1000)
}

/**
 * Generic helper: Open test selection dialog
 */
async function openTestSelectionDialog(driver) {
  // CRITICAL: Wait for dataset to be active first
  await waitForDatasetActive(driver)

  // Wait for any modal overlay to disappear (loading dialogs, etc.)
  await driver.wait(async () => {
    const hasOverlay = await driver.executeScript(() => {
      // Check for blocking overlay with z-index 9999
      const overlays = document.querySelectorAll('div[style*="z-index: 9999"]')
      for (const overlay of overlays) {
        const style = overlay.getAttribute('style') || ''
        if (style.includes('position: fixed') && style.includes('background-color: rgba')) {
          return true // overlay is present
        }
      }
      return false // no blocking overlay
    })
    return !hasOverlay // wait until overlay is gone
  }, 15000)

  logStep('[UI] No blocking overlay present')

  const button = await driver.wait(
    until.elementLocated({ css: '[data-testid="run-analysis-button"]' }),
    10000
  )

  // Wait for button to be enabled (it's disabled when !hasData)
  await driver.wait(async () => {
    const isDisabled = await button.getAttribute('disabled')
    return isDisabled === null || isDisabled === 'false'
  }, 10000)

  logStep('[UI] Run Analysis button is enabled')

  await button.click()
  logStep('[UI] Clicked "Perform Test" button')

  // Wait for dialog to open - check for dialog role first, then the button
  // Radix UI may render in a portal, so check multiple ways
  await driver.wait(async () => {
    const found = await driver.executeScript(() => {
      // Check for dialog with role
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs.length === 0) return false

      // Check for the confirm button by data-testid
      let confirmButton = document.querySelector('[data-testid="confirm-test-selection"]')
      if (confirmButton) return true

      // Fallback: Look for button with text "Select a Test" or "Select Test"
      const buttons = Array.from(document.querySelectorAll('button'))
      confirmButton = buttons.find(btn =>
        btn.textContent.includes('Select a Test') ||
        btn.textContent.includes('Select Test')
      )

      return !!confirmButton
    })
    return found
  }, 10000)

  logStep('[UI] Test selection dialog opened')
}

/**
 * Generic helper: Expand test group (e.g., 'hypothesis_testing')
 */
async function expandTestGroup(driver, groupId) {
  logStep(`[UI] Looking for test group: ${groupId}`)

  // Wait for the dialog to be fully rendered first
  await driver.sleep(500)

  // Find the group button by data-testid
  const groupButton = await driver.wait(
    until.elementLocated({ css: `[data-testid="test-group-${groupId}"]` }),
    10000
  )

  logStep(`[UI] Found test group button for: ${groupId}`)

  // Check if already expanded by looking for visible test items
  const groupExpanded = await driver.executeScript((button) => {
    const parent = button.closest('[class*="rounded-lg"]')
    if (!parent) return false

    // Look for the test list (has border-t class)
    const testList = parent.querySelector('[class*="border-t"]')
    if (!testList) return false

    // Check if it's visible (offsetParent !== null means it's displayed)
    return testList.offsetParent !== null
  }, groupButton)

  if (!groupExpanded) {
    logStep(`[UI] Expanding test group: ${groupId}`)
    await groupButton.click()
    await driver.sleep(500) // Wait for expansion animation
    logStep(`[UI] Test group expanded: ${groupId}`)
  } else {
    logStep(`[UI] Test group already expanded: ${groupId}`)
  }
}

/**
 * Generic helper: Select specific test by ID
 */
async function selectTest(driver, testId) {
  logStep(`[UI] Looking for test: ${testId}`)

  const testButton = await driver.wait(
    until.elementLocated({ css: `[data-testid="test-${testId}"]` }),
    10000
  )

  logStep(`[UI] Found test button: ${testId}`)

  await testButton.click()
  logStep(`[UI] Clicked test: ${testId}`)

  await driver.sleep(300) // Wait for selection state update
}

/**
 * Generic helper: Confirm test selection
 */
async function confirmTestSelection(driver) {
  logStep('[UI] Looking for confirm button...')

  // Find the confirm button (try data-testid first, then fallback to text)
  const confirmButton = await driver.wait(async () => {
    let button = await driver.findElements({ css: '[data-testid="confirm-test-selection"]' })
    if (button.length > 0) return button[0]

    // Fallback: find button with text "Select a Test" or similar
    const buttons = await driver.findElements({ css: 'button' })
    for (const btn of buttons) {
      const text = await btn.getText()
      if (text.includes('Select a Test') || text.includes('Select Test')) {
        return btn
      }
    }
    return null
  }, 10000)

  if (!confirmButton) {
    throw new Error('Cannot find confirm button')
  }

  logStep('[UI] Found confirm button')

  // Check if button is enabled
  const isDisabled = await confirmButton.getAttribute('disabled')
  if (isDisabled === 'true' || isDisabled === true) {
    throw new Error('Cannot confirm test selection: button is disabled (no test selected or incompatible data)')
  }

  logStep('[UI] Confirm button is enabled')

  await confirmButton.click()
  logStep('[UI] Clicked confirm button')

  // Wait a bit for the dialog to start closing
  await driver.sleep(500)

  logStep('[UI] Test selection confirmed, dialog should close')
}

/**
 * Select specific columns by name in the column selection dialog.
 * Expects the column selection dialog to be visible.
 *
 * @param {object} driver - Selenium WebDriver instance
 * @param {string[]} columnNames - Column headers to select
 */
export async function selectColumnsByName(driver, columnNames) {
  logStep(`[UI] Selecting columns by name: ${columnNames.join(', ')}`)

  await driver.sleep(500)

  const result = await performColumnCardAction(driver, 'selectByNames', { names: columnNames })
  logStep(
    `[UI] Column card source=${result.source}, found=${result.cardCount}, fallbackCandidates=${result.fallbackCandidatesCount}`
  )
  if (result.clickedNames?.length > 0) {
    logStep(`[UI] Selected columns by name: ${result.clickedNames.join(', ')}`)
  }

  if (result.missing.length > 0) {
    console.error(`[UI] Available columns: ${result.availableColumns.join(', ')}`)
    throw new Error(`Column(s) not found in selection dialog: ${result.missing.join(', ')}. Available: ${result.availableColumns.join(', ')}`)
  }

  logStep(`[UI] Selected ${result.clicked} columns`)
  await driver.sleep(500)
}

async function setNativeSelectByText(driver, testId, value, options = {}) {
  if (value === undefined || value === null || value === '') {
    return false
  }

  const result = await driver.executeScript(({ id, desiredValue }) => {
    const select = document.querySelector(`[data-testid="${id}"]`)
    if (!select) {
      return { found: false, selected: false, available: [] }
    }

    const target = String(desiredValue).trim().toLowerCase()
    const options = Array.from(select.options).map((option) => ({
      value: option.value,
      text: (option.textContent || '').trim(),
    }))

    const match = options.find((option) => option.text.toLowerCase() === target)
      || options.find((option) => option.value.toLowerCase() === target)
      || options.find((option) => option.text.toLowerCase().includes(target))

    if (!match) {
      return { found: true, selected: false, available: options.map((option) => option.text) }
    }

    select.value = match.value
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))

    return { found: true, selected: true, available: options.map((option) => option.text) }
  }, { id: testId, desiredValue: value })

  if (!result.found && options.required) {
    throw new Error(`Missing native select: ${testId}`)
  }

  if (!result.selected && options.required) {
    throw new Error(`Failed to select "${value}" for ${testId}. Available: ${result.available.join(', ')}`)
  }

  await driver.sleep(150)
  return result.selected
}

async function handleLmmAnovaDialog(driver) {
  const config = driver.__lmmAnovaConfig || null
  const dialogs = await driver.findElements(By.css('[data-testid="lmm-anova-dialog"]'))
  if (dialogs.length === 0) {
    return false
  }

  logStep('[UI] LMM ANOVA dialog detected')

  await driver.sleep(400)

  if (config?.valueColumn || config?.dependentColumn) {
    await setNativeSelectByText(driver, 'lmm-dv-select', config.valueColumn ?? config.dependentColumn, { required: true })
  }

  if (config?.subjectColumn || config?.groupColumn) {
    await setNativeSelectByText(driver, 'lmm-group-select', config.subjectColumn ?? config.groupColumn, { required: true })
  }

  const predictors = Array.isArray(config?.predictorColumns) ? config.predictorColumns : []
  const predictorTypes = config?.predictorTypes || {}
  const stratifyColumns = Array.isArray(config?.stratifyColumns) ? config.stratifyColumns : []
  const simpleEffects = Array.isArray(config?.simpleEffects) ? config.simpleEffects : []

  if (
    predictors.length > 0 ||
    Object.keys(predictorTypes).length > 0 ||
    stratifyColumns.length > 0 ||
    simpleEffects.length > 0
  ) {
    const predictorResult = await driver.executeScript(({ desiredPredictors, desiredTypes }) => {
      const dialog = document.querySelector('[data-testid="lmm-anova-dialog"]')
      if (!dialog) return { ok: false, reason: 'Dialog not found', available: [] }

      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const predictorInputs = Array.from(
        dialog.querySelectorAll('input[type="checkbox"][data-testid^="lmm-predictor-toggle-"]')
      )
      const predictorRows = predictorInputs.map((input) => {
        const key = (input.getAttribute('data-testid') || '').replace(/^lmm-predictor-toggle-/, '')
        const labelEl =
          dialog.querySelector(`[data-testid="lmm-predictor-label-${key}"]`) ||
          input.closest('label')?.querySelector('span:last-child')
        const label = (labelEl?.textContent || '').trim()
        return { key, label, normalizedKey: normalize(key), normalizedLabel: normalize(label) }
      })
      const available = predictorRows.map((row) => `${row.label} [${row.key}]`)
      const resolveToken = (token) => {
        const target = normalize(token)
        if (!target) return null
        const byKey = predictorRows.find((row) => row.normalizedKey === target)
        if (byKey) return byKey.key
        const byLabel = predictorRows.find((row) => row.normalizedLabel === target)
        if (byLabel) return byLabel.key
        return null
      }

      const unresolvedPredictors = []
      const resolvedPredictorKeys = []
      for (const token of desiredPredictors || []) {
        const key = resolveToken(token)
        if (!key) {
          unresolvedPredictors.push(String(token))
          continue
        }
        resolvedPredictorKeys.push(key)
      }
      if (unresolvedPredictors.length > 0) {
        return {
          ok: false,
          reason: `Unresolved predictor target(s): ${unresolvedPredictors.join(', ')}`,
          available,
        }
      }

      const targetSet = new Set(resolvedPredictorKeys)
      for (const input of predictorInputs) {
        const key = (input.getAttribute('data-testid') || '').replace(/^lmm-predictor-toggle-/, '')
        const shouldSelect = targetSet.has(key)
        if (input.checked !== shouldSelect) input.click()
      }

      const unresolvedTypeTargets = []
      const invalidTypeValues = []
      for (const [token, rawType] of Object.entries(desiredTypes || {})) {
        const key = resolveToken(token)
        if (!key) {
          unresolvedTypeTargets.push(token)
          continue
        }
        const select = dialog.querySelector(`select[data-testid="lmm-predictor-type-${key}"]`)
        if (!select) {
          unresolvedTypeTargets.push(token)
          continue
        }
        const desiredType = normalize(rawType)
        const options = Array.from(select.options)
        const match = options.find((option) => normalize(option.value) === desiredType)
        if (!match) {
          invalidTypeValues.push(`${token}:${rawType}`)
          continue
        }
        if (select.value !== match.value) {
          select.value = match.value
          select.dispatchEvent(new Event('input', { bubbles: true }))
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }

      if (unresolvedTypeTargets.length > 0 || invalidTypeValues.length > 0) {
        return {
          ok: false,
          reason: `Unresolved predictor type target(s): ${unresolvedTypeTargets.join(', ') || 'none'}; invalid type value(s): ${invalidTypeValues.join(', ') || 'none'}`,
          available,
        }
      }

      return { ok: true, available }
    }, { desiredPredictors: predictors, desiredTypes: predictorTypes })

    if (!predictorResult.ok) {
      throw new Error(`Failed to configure LMM predictor selection: ${predictorResult.reason}. Available: ${predictorResult.available.join(', ')}`)
    }

    const stratifyResult = await driver.executeScript(({ desiredStratify }) => {
      const dialog = document.querySelector('[data-testid="lmm-anova-dialog"]')
      if (!dialog) return { ok: false, reason: 'Dialog not found', available: [] }

      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const stratifyInputs = Array.from(
        dialog.querySelectorAll('input[type="checkbox"][data-testid^="lmm-stratify-factor-"]')
      )
      const rows = stratifyInputs.map((input) => {
        const key = (input.getAttribute('data-testid') || '').replace(/^lmm-stratify-factor-/, '')
        const label = (input.closest('label')?.querySelector('span')?.textContent || '').trim()
        return { key, label, normalizedKey: normalize(key), normalizedLabel: normalize(label) }
      })
      const available = rows.map((row) => `${row.label} [${row.key}]`)
      const resolveToken = (token) => {
        const target = normalize(token)
        if (!target) return null
        const byKey = rows.find((row) => row.normalizedKey === target)
        if (byKey) return byKey.key
        const byLabel = rows.find((row) => row.normalizedLabel === target)
        if (byLabel) return byLabel.key
        return null
      }

      const unresolved = []
      const resolved = []
      for (const token of desiredStratify || []) {
        const key = resolveToken(token)
        if (!key) {
          unresolved.push(String(token))
          continue
        }
        resolved.push(key)
      }
      if (unresolved.length > 0) {
        return { ok: false, reason: `Unresolved stratification target(s): ${unresolved.join(', ')}`, available }
      }

      const targetSet = new Set(resolved)
      for (const input of stratifyInputs) {
        const key = (input.getAttribute('data-testid') || '').replace(/^lmm-stratify-factor-/, '')
        const shouldSelect = targetSet.has(key)
        if (input.checked !== shouldSelect) input.click()
      }
      return { ok: true, available }
    }, { desiredStratify: stratifyColumns })

    if (!stratifyResult.ok) {
      throw new Error(`Failed to configure LMM stratification: ${stratifyResult.reason}. Available: ${stratifyResult.available.join(', ')}`)
    }

    const simpleResult = await driver.executeScript(({ desiredPairs }) => {
      const dialog = document.querySelector('[data-testid="lmm-anova-dialog"]')
      if (!dialog) return { ok: false, reason: 'Dialog not found', available: [] }

      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const predictorInputs = Array.from(
        dialog.querySelectorAll('input[type="checkbox"][data-testid^="lmm-predictor-toggle-"]')
      )
      const predictorRows = predictorInputs.map((input) => {
        const key = (input.getAttribute('data-testid') || '').replace(/^lmm-predictor-toggle-/, '')
        const labelEl =
          dialog.querySelector(`[data-testid="lmm-predictor-label-${key}"]`) ||
          input.closest('label')?.querySelector('span:last-child')
        const label = (labelEl?.textContent || '').trim()
        return { key, label, normalizedKey: normalize(key), normalizedLabel: normalize(label) }
      })
      const resolveToken = (token) => {
        const target = normalize(token)
        if (!target) return null
        const byKey = predictorRows.find((row) => row.normalizedKey === target)
        if (byKey) return byKey.key
        const byLabel = predictorRows.find((row) => row.normalizedLabel === target)
        if (byLabel) return byLabel.key
        return null
      }

      const simpleInputs = Array.from(
        dialog.querySelectorAll('input[type="checkbox"][data-testid^="lmm-simple-effect-toggle-"]')
      )
      const available = simpleInputs
        .map((input) => input.getAttribute('data-testid') || '')
        .map((id) => id.replace(/^lmm-simple-effect-toggle-/, ''))

      if ((desiredPairs || []).length > 0 && simpleInputs.length === 0) {
        return { ok: false, reason: 'Simple-effects toggles not available in dialog', available }
      }

      const unresolvedPairs = []
      const desiredIds = []
      for (const pair of desiredPairs || []) {
        const factor = resolveToken(pair?.factor)
        const within = resolveToken(pair?.within)
        if (!factor || !within) {
          unresolvedPairs.push(`${pair?.factor ?? ''}|${pair?.within ?? ''}`)
          continue
        }
        desiredIds.push(`lmm-simple-effect-toggle-${factor}-within-${within}`)
      }

      if (unresolvedPairs.length > 0) {
        return { ok: false, reason: `Unresolved simple-effect pair(s): ${unresolvedPairs.join(', ')}`, available }
      }

      const availableIds = new Set(simpleInputs.map((input) => input.getAttribute('data-testid') || ''))
      const missingIds = desiredIds.filter((id) => !availableIds.has(id))
      if (missingIds.length > 0) {
        return { ok: false, reason: `Simple-effect toggle(s) missing: ${missingIds.join(', ')}`, available }
      }

      const targetSet = new Set(desiredIds)
      for (const input of simpleInputs) {
        const id = input.getAttribute('data-testid') || ''
        const shouldSelect = targetSet.has(id)
        if (input.checked !== shouldSelect) input.click()
      }
      return { ok: true, available }
    }, { desiredPairs: simpleEffects })

    if (!simpleResult.ok) {
      throw new Error(`Failed to configure LMM simple effects: ${simpleResult.reason}. Available: ${simpleResult.available.join(', ')}`)
    }
  }

  if (config?.interactionDepth !== undefined) {
    await driver.executeScript((value) => {
      const input = document.querySelector('[data-testid="lmm-interaction-depth"]')
      if (!input) return false
      input.value = String(value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, config.interactionDepth)
    await driver.sleep(150)
  }

  if (config?.dfMethod) {
    await setNativeSelectByText(driver, 'lmm-df-method', config.dfMethod, { required: true })
  }

  if (typeof config?.reml === 'boolean') {
    await driver.executeScript((checked) => {
      const toggle = document.querySelector('[data-testid="lmm-reml-toggle"]')
      if (!toggle) return false
      if (toggle.checked !== checked) {
        toggle.click()
      }
      return true
    }, config.reml)
  }

  const wantsSlope = config?.randomEffectsMode === 'random_slope'
  const randomTestId = wantsSlope ? 'lmm-random-structure-slope' : 'lmm-random-structure-intercept'
  await driver.executeScript((testId) => {
    const input = document.querySelector(`[data-testid="${testId}"]`)
    if (!input) return false
    if (!input.checked) {
      input.click()
    }
    return true
  }, randomTestId)
  await driver.sleep(200)

  if (wantsSlope && config?.randomSlopeTarget) {
    await setNativeSelectByText(driver, 'lmm-random-slope-select', config.randomSlopeTarget, { required: true })
  }

  if (config?.adjustmentMethod) {
    await setNativeSelectByText(driver, 'lmm-adjustment-method', config.adjustmentMethod, { required: true })
  }

  if (config?.adjustmentMethod === 'dunnett') {
    const controlLevels = config?.controlLevels && typeof config.controlLevels === 'object'
      ? config.controlLevels
      : {}
    const dunnettResult = await driver.executeScript(({ controls }) => {
      const dialog = document.querySelector('[data-testid="lmm-anova-dialog"]')
      if (!dialog) return { ok: false, reason: 'Dialog not found', available: [] }

      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const predictorInputs = Array.from(
        dialog.querySelectorAll('input[type="checkbox"][data-testid^="lmm-predictor-toggle-"]')
      )
      const predictorRows = predictorInputs.map((input) => {
        const key = (input.getAttribute('data-testid') || '').replace(/^lmm-predictor-toggle-/, '')
        const labelEl =
          dialog.querySelector(`[data-testid="lmm-predictor-label-${key}"]`) ||
          input.closest('label')?.querySelector('span:last-child')
        const label = (labelEl?.textContent || '').trim()
        return { key, label, normalizedKey: normalize(key), normalizedLabel: normalize(label) }
      })
      const resolveToken = (token) => {
        const target = normalize(token)
        if (!target) return null
        const byKey = predictorRows.find((row) => row.normalizedKey === target)
        if (byKey) return byKey.key
        const byLabel = predictorRows.find((row) => row.normalizedLabel === target)
        if (byLabel) return byLabel.key
        return null
      }

      const controlSelects = Array.from(
        dialog.querySelectorAll('select[data-testid^="lmm-dunnett-control-"]')
      )
      const available = controlSelects.map((select) => (select.getAttribute('data-testid') || '').replace(/^lmm-dunnett-control-/, ''))
      const unresolved = []
      const invalidLevels = []

      for (const [token, level] of Object.entries(controls || {})) {
        const key = resolveToken(token)
        if (!key) {
          unresolved.push(String(token))
          continue
        }
        const select = dialog.querySelector(`select[data-testid="lmm-dunnett-control-${key}"]`)
        if (!select) {
          unresolved.push(String(token))
          continue
        }

        const desired = normalize(level)
        const options = Array.from(select.options)
        const match = options.find((option) => normalize(option.value) === desired || normalize(option.textContent) === desired)
        if (!match) {
          invalidLevels.push(`${token}:${level}`)
          continue
        }

        if (select.value !== match.value) {
          select.value = match.value
          select.dispatchEvent(new Event('input', { bubbles: true }))
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }

      if (unresolved.length > 0 || invalidLevels.length > 0) {
        return {
          ok: false,
          reason: `Unresolved Dunnett control target(s): ${unresolved.join(', ') || 'none'}; invalid level(s): ${invalidLevels.join(', ') || 'none'}`,
          available,
        }
      }

      return { ok: true, available }
    }, { controls: controlLevels })

    if (!dunnettResult.ok) {
      throw new Error(`Failed to configure LMM Dunnett controls: ${dunnettResult.reason}. Available: ${dunnettResult.available.join(', ')}`)
    }
  }

  if (config?.posthocQ !== undefined && config?.posthocQ !== null && config?.posthocQ !== '') {
    const posthocOk = await driver.executeScript((value) => {
      const input = document.querySelector('[data-testid="lmm-posthoc-q"]')
      if (!input) return false
      input.value = String(value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, config.posthocQ)
    if (!posthocOk) {
      throw new Error('Failed to set lmm-posthoc-q: input not found')
    }
    await driver.sleep(120)
  }

  const nextButtons = await driver.findElements(By.css('[data-testid="lmm-next-button"]'))
  if (nextButtons.length === 0) {
    throw new Error('Missing LMM Continue button')
  }

  const disabled = await nextButtons[0].getAttribute('disabled')
  if (disabled === 'true') {
    throw new Error('LMM Continue button is disabled after configuration')
  }

  await nextButtons[0].click()
  logStep('[UI] Submitted LMM configuration dialog')
  await driver.sleep(1200)

  return true
}

/**
 * Select dependent variable in the DV dialog.
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} variableName - Column name to select as DV
 */
export async function selectDependentVariable(driver, variableName) {
  logStep(`[UI] Selecting dependent variable: ${variableName}`)
  await driver.sleep(500)

  const selected = await driver.executeScript((name) => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    const dialog = dialogs.find(d =>
      d.textContent.includes('Select Dependent Variable') ||
      d.textContent.includes('Select Outcome Variable') ||
      d.textContent.includes('Select Outcome') ||
      d.textContent.includes('Select Continuous Variable')
    )
    const scope = dialog || document

    const labels = Array.from(scope.querySelectorAll('label'))
    // Try exact match first
    let label = labels.find(l => l.textContent.trim() === name)
    // If not found, try matching first word (for labels like "y (NUMERIC)")
    if (!label) {
      label = labels.find(l => l.textContent.trim().split(/\s+/)[0] === name)
    }
    // If still not found, try contains match
    if (!label) {
      label = labels.find(l => l.textContent.includes(name))
    }

    if (label) {
      label.click()
      return { success: true, availableLabels: labels.map(l => l.textContent.trim()) }
    }

    const radios = Array.from(scope.querySelectorAll('input[type="radio"]'))
    const radio = radios.find(r => r.value === name || r.id === name)
    if (radio) {
      radio.click()
      return { success: true, availableLabels: labels.map(l => l.textContent.trim()) }
    }

    return { success: false, availableLabels: labels.map(l => l.textContent.trim()) }
  }, variableName)

  if (!selected.success) {
    console.error(`[UI] Available DV options: ${selected.availableLabels.join(', ')}`)
    throw new Error(`Dependent variable not found in dialog: ${variableName}. Available: ${selected.availableLabels.join(', ')}`)
  }

  logStep(`[UI] Selected DV: ${variableName} (from options: ${selected.availableLabels.join(', ')})`)
  await driver.sleep(500)

  const confirmed = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const okButton = buttons.find(b => ['OK', 'Continue', 'Run Analysis', 'Run Test'].includes(b.textContent.trim()))
    if (okButton && !okButton.disabled) {
      okButton.click()
      return true
    }
    return false
  })

  if (!confirmed) {
    logStep('[UI] WARNING: Could not confirm DV selection (OK button not found/enabled)')
  }

  await driver.sleep(1000)
}

/**
 * Select outcome encoding for logistic regression.
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} encoding - { eventLevel } for binary or { referenceClass } for multinomial
 */
export async function selectOutcomeEncoding(driver, encoding) {
  const target = encoding?.eventLevel ?? encoding?.referenceClass
  if (!target) {
    throw new Error('Outcome encoding requires eventLevel or referenceClass')
  }

  logStep(`[UI] Selecting outcome encoding: ${target}`)
  await driver.sleep(500)

  const selected = await driver.executeScript((value) => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    const dialog = dialogs.find(d =>
      d.textContent.includes('Encode Dependent Variable') ||
      d.textContent.includes('Select Success Category') ||
      d.textContent.includes('Select Baseline Category')
    )
    const scope = dialog || document

    const trigger = scope.querySelector('button[role="combobox"]')
    if (!trigger) return false

    trigger.click()

    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const option = options.find(opt => opt.textContent.trim() === value)
    if (!option) return false

    option.click()
    return true
  }, target)

  if (!selected) {
    throw new Error(`Outcome encoding option not found: ${target}`)
  }

  await driver.sleep(500)

  const confirmed = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const okButton = buttons.find(b => b.textContent.trim() === 'OK')
    if (okButton && !okButton.disabled) {
      okButton.click()
      return true
    }
    return false
  })

  if (!confirmed) {
    logStep('[UI] WARNING: Could not confirm outcome encoding (OK button not found/enabled)')
  }

  await driver.sleep(1000)
}

/**
 * Dismiss any encoding dialog by clicking OK without changing selection.
 * Used when default encoding is acceptable.
 * @param {object} driver - Selenium WebDriver instance
 */
export async function dismissEncodingDialog(driver) {
  const dismissed = await driver.executeScript(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    const dialog = dialogs.find(d =>
      d.textContent.includes('Encode Dependent Variable') ||
      d.textContent.includes('Select Success Category') ||
      d.textContent.includes('Select Baseline Category') ||
      d.textContent.includes('Event Level') ||
      d.textContent.includes('Reference Category')
    )
    if (!dialog) return false

    const buttons = Array.from(dialog.querySelectorAll('button'))
    const okButton = buttons.find(b => b.textContent.trim() === 'OK' || b.textContent.trim() === 'Confirm')
    if (okButton && !okButton.disabled) {
      okButton.click()
      return true
    }
    return false
  })

  if (dismissed) {
    logStep('[UI] Dismissed encoding dialog with default selection')
    await driver.sleep(500)
  }
}

/**
 * Select factor encoding baselines for categorical predictors.
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} encodings - { factorName: baselineLevel }
 */
export async function selectFactorEncoding(driver, encodings = {}) {
  const entries = Object.entries(encodings)
  if (entries.length === 0) return

  logStep(`[UI] Selecting factor encodings: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  await driver.sleep(500)

  const selected = await driver.executeScript((pairs) => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    const dialog = dialogs.find(d => d.textContent.includes('Encode Predictors') || d.textContent.includes('Factor Encoding'))
    const scope = dialog || document

    let changed = 0
    for (const [factor, baseline] of pairs) {
      const label = Array.from(scope.querySelectorAll('label')).find(l => l.textContent.trim() === factor)
      const container = label?.closest('div') || scope
      const trigger = container.querySelector('button[role="combobox"]') || scope.querySelector('button[role="combobox"]')
      if (!trigger) continue

      trigger.click()
      const options = Array.from(document.querySelectorAll('[role="option"]'))
      const option = options.find(opt => opt.textContent.trim() === baseline)
      if (!option) continue
      option.click()
      changed += 1
    }

    return changed
  }, entries)

  if (selected === 0) {
    logStep('[UI] WARNING: No factor encodings were applied')
  }

  await driver.sleep(500)

  const confirmed = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const okButton = buttons.find(b => b.textContent.trim() === 'OK')
    if (okButton && !okButton.disabled) {
      okButton.click()
      return true
    }
    return false
  })

  if (!confirmed) {
    logStep('[UI] WARNING: Could not confirm factor encoding (OK button not found/enabled)')
  }

  await driver.sleep(1000)
}

/**
 * Generic helper: Run a test by ID (opens dialog, selects test, confirms)
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testId - Test ID from testRegistry (e.g., 'two_way_anova')
 * @param {string} groupId - Test group ID (e.g., 'hypothesis_testing')
 */
async function runTestById(driver, testId, groupId = 'hypothesis_testing') {
  driver.__resultsBaseline = await getResultsSnapshot(driver)
  driver.__resultsBaselineAt = Date.now()
  await openTestSelectionDialog(driver)
  await expandTestGroup(driver, groupId)
  await selectTest(driver, testId)
  await confirmTestSelection(driver)

  // Wait briefly for orchestration to start
  await driver.sleep(500)

  logStep(`[UI] Test orchestration started: ${testId}`)
}

/**
 * Run a correlation test with explicit column selection.
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testId - Test ID from testRegistry (e.g., 'correlation_pearson')
 * @param {string[]} columnNames - Column headers to select
 */
export async function runCorrelationTest(driver, testId, columnNames) {
  logStep(`[UI] Starting correlation workflow: ${testId}`)
  driver.__columnSelectionOverride = columnNames
  await runTestById(driver, testId, 'regression_correlation')
}

/**
 * Run a regression test with explicit column selection.
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testId - Test ID from testRegistry (e.g., 'linear_regression', 'logistic_regression')
 * @param {string[]} columnNames - Column headers to select (DV + predictors)
 */
export async function runRegressionTest(driver, testId, columnNames) {
  logStep(`[UI] Starting regression workflow: ${testId}`)
  driver.__columnSelectionOverride = columnNames
  await runTestById(driver, testId, 'regression_correlation')
}

/**
 * Run a Two-Way ANOVA test via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Test configuration { valueColumn, factor1Column, factor2Column }
 */
export async function runTwoWayANOVA(driver, config = {}) {
  logStep('[UI] Starting Two-Way ANOVA workflow...')
  driver.__twoWayAnovaConfig = config
  await runTestById(driver, 'two_way_anova', 'hypothesis_testing')

  // Two-Way ANOVA has a 4-dialog workflow:
  // 1. Column selection (already handled by handleColumnSelection)
  // 2. Continuous variable (DV) selection
  // 3. Factor role mapping (Factor A vs Factor B assignment)
  // 4. Simple effects selection
  // These are handled in waitForResults -> handleColumnSelection
}

/**
 * Run a One-Way ANOVA test via UI
 */
export async function runOneWayANOVA(driver, config = {}) {
  logStep('[UI] Starting One-Way ANOVA workflow...')
  driver.__oneWayAnovaConfig = config
  await runTestById(driver, 'one_way_anova', 'hypothesis_testing')
}

/**
 * Run an Independent Samples T-Test via UI
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {Object} config - Configuration options
 * @param {Object} config.mapping - Optional column mapping override
 * @param {string} config.mapping.group - Group variable column name
 * @param {string} config.mapping.outcome - Outcome variable column name
 */
export async function runIndependentTTest(driver, config = {}) {
  logStep('[UI] Starting Independent T-Test workflow...')

  // Accept both { mapping: { group, outcome } } and direct { groupColumn, valueColumn } config.
  const mappingOverride = config.mapping || {}
  if (config.groupColumn && !mappingOverride.group) mappingOverride.group = config.groupColumn
  if ((config.valueColumn || config.outcomeColumn) && !mappingOverride.outcome) {
    mappingOverride.outcome = config.valueColumn || config.outcomeColumn
  }

  if (Object.keys(mappingOverride).length > 0) {
    driver.__independentTTestMappingOverride = mappingOverride
  } else {
    driver.__independentTTestMappingOverride = null
  }

  await runTestById(driver, 'independent_ttest', 'hypothesis_testing')
}

/**
 * Run a Paired Samples T-Test via UI
 */
export async function runPairedTTest(driver, config = {}) {
  logStep('[UI] Starting Paired T-Test workflow...')
  await runTestById(driver, 'paired_ttest', 'hypothesis_testing')
}

/**
 * Run a One-Sample T-Test via UI
 */
export async function runOneSampleTTest(driver, config = {}) {
  logStep('[UI] Starting One-Sample T-Test workflow...')
  await runTestById(driver, 'one_sample_ttest', 'hypothesis_testing')
}

/**
 * Run a Mann-Whitney U Test via UI
 */
export async function runMannWhitneyTest(driver, config = {}) {
  logStep('[UI] Starting Mann-Whitney U Test workflow...')

  // Set mapping override if provided
  if (config.mapping) {
    driver.__mannWhitneyMappingOverride = config.mapping
  } else {
    driver.__mannWhitneyMappingOverride = null
  }

  await runTestById(driver, 'mann_whitney', 'hypothesis_testing')
}

/**
 * Run a Wilcoxon Signed-Rank Test via UI
 */
export async function runWilcoxonTest(driver, config = {}) {
  logStep('[UI] Starting Wilcoxon Signed-Rank Test workflow...')
  await runTestById(driver, 'wilcoxon', 'hypothesis_testing')
}

/**
 * Run a Kruskal-Wallis Test via UI
 */
export async function runKruskalWallisTest(driver, config = {}) {
  logStep('[UI] Starting Kruskal-Wallis H Test workflow...')
  driver.__kruskalWallisConfig = config
  const mappingOverride = {}
  if (config.groupColumn) mappingOverride.group = config.groupColumn
  if (config.valueColumn || config.outcomeColumn) {
    mappingOverride.outcome = config.valueColumn || config.outcomeColumn
  }
  if (Object.keys(mappingOverride).length > 0) {
    driver.__kruskalWallisMappingOverride = mappingOverride
  }
  await runTestById(driver, 'kruskal_wallis', 'hypothesis_testing')
}

/**
 * Run a Scheirer-Ray-Hare Test via UI
 */
export async function runScheirerRayHareTest(driver, config = {}) {
  logStep('[UI] Starting Scheirer-Ray-Hare Test workflow...')
  await runTestById(driver, 'scheirer_ray_hare', 'hypothesis_testing')

  // Scheirer-Ray-Hare has a 3-dialog workflow:
  // 1. Column selection (already handled by handleColumnSelection)
  // 2. Continuous variable (DV) selection
  // 3. Factor role mapping (Primary vs Secondary assignment, with optional Facets for 3+ factors)
  // NOTE: No simple effects dialog (removed - not meaningful for rank-based tests)
  // These are handled in waitForResults -> handleColumnSelection
}

/**
 * Run a Multifactorial ANOVA test via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Test configuration with simple effects to select
 *   - simpleEffects: Array of { mainFactor, withinFactor } to select
 *     e.g., [{ mainFactor: 'factor1', withinFactor: 'factor2' }, ...]
 */
export async function runMultifactorialANOVA(driver, config = {}) {
  logStep('[UI] Starting Multifactorial ANOVA workflow...')

  // Store config for handleColumnSelection to use
  driver.__multifactorialConfig = config

  await runTestById(driver, 'multifactorial_anova', 'hypothesis_testing')

  // Multifactorial ANOVA has a 4-dialog workflow:
  // 1. Column selection (already handled by handleColumnSelection)
  // 2. Continuous variable (DV) selection
  // 3. Factor role mapping (Primary, Secondary, and Facets assignment)
  // 4. Simple effects selection
  // These are handled in waitForResults -> handleColumnSelection
}

/**
 * Run a Linear Mixed Model ANOVA test via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - LMM configuration
 */
export async function runLmmAnova(driver, config = {}) {
  logStep('[UI] Starting LMM ANOVA workflow...')
  driver.__lmmAnovaConfig = config
  await runTestById(driver, 'lmm_anova', 'hypothesis_testing')
}

/**
 * Generic helper: Click "Run Analysis" button (kept for backward compatibility)
 */
export async function clickRunAnalysisButton(driver) {
  const button = await driver.wait(
    until.elementLocated({ css: '[data-testid="run-analysis-button"]' }),
    10000
  )
  await button.click()
  logStep('[UI] Clicked "Run Analysis" button')
}

/**
 * Handle column selection dialog (appears after test selection)
 * Auto-selects appropriate columns based on test requirements
 */
async function handleColumnSelection(driver) {
  logStep('[UI] Checking for column selection dialog...')

  // Wait a bit for column dialog to appear
  await driver.sleep(1000)

  const handledLmmDialog = await handleLmmAnovaDialog(driver)
  if (handledLmmDialog) {
    logStep('[UI] LMM dialog handled, checking for follow-up dialogs...')
  }

  // Check if column selection dialog is present
  const hasColumnDialog = await driver.executeScript(() => {
    const dialog =
      document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
      document.querySelector('[role="dialog"]')
    const scope = dialog || document.body
    const text = scope?.innerText || ''
    return text.includes('Select Columns') || text.includes('Pick a categorical') || text.includes('Pick a numeric')
  })

  if (!hasColumnDialog) {
    if (!handledLmmDialog) {
      logStep('[UI] No column selection dialog - test may auto-run or use different flow')
      return
    }
  }

  if (!handledLmmDialog) {
    logStep('[UI] Column selection dialog detected')
  }

  const overrideColumns = Array.isArray(driver.__columnSelectionOverride)
    ? driver.__columnSelectionOverride
    : null

  // Auto-select columns by clicking on column cards
  // Column cards are button cards in the current UI, with legacy div fallback.
  const selectedCount = handledLmmDialog
    ? 0
    : overrideColumns
    ? await (async () => {
        await selectColumnsByName(driver, overrideColumns)
        return overrideColumns.length
      })()
    : await (async () => {
        const selection = await performColumnCardAction(driver, 'autoSelect')
        logStep(
          `[UI] Column card source=${selection.source}, found=${selection.cardCount}, fallbackCandidates=${selection.fallbackCandidatesCount}`
        )
        if (selection.usedHardFallback) {
          logStep('[UI] WARNING: Used hard fallback candidate click path')
        }
        if (selection.clickedNames?.length > 0) {
          logStep(`[UI] Auto-selected columns: ${selection.clickedNames.join(', ')}`)
        }
        return selection.clickedCount
      })()

  if (overrideColumns) {
    driver.__columnSelectionOverride = null
  }

  logStep(`[UI] Selected ${selectedCount} columns`)

  // Debug: Check what columns were actually selected
  const selectedColumnsSnapshot = handledLmmDialog
    ? { cards: [] }
    : await performColumnCardAction(driver, 'snapshot')
  const selectedColumns = selectedColumnsSnapshot.cards || []

  logStep(`[UI] Column details: ${JSON.stringify(selectedColumns)}`)

  await driver.sleep(handledLmmDialog ? 600 : 2500) // Wait for selection state to update (longer for multi-factor tests)

  if (!handledLmmDialog) {
    // Find and click "Run Analysis" button
    const runButton = await driver.wait(async () => {
      const buttons = await driver.findElements({ css: 'button' })
      for (const btn of buttons) {
        const text = await btn.getText()
        if (text.includes('Run Analysis') || text.includes('Run Test')) {
          return btn
        }
      }
      return null
    }, 5000)

    if (!runButton) {
      throw new Error('Cannot find Run Analysis button in column selection dialog')
    }

    // Wait for button to be enabled (selection state takes time to update)
    let buttonEnabled = false
    try {
      await driver.wait(async () => {
        const isDisabled = await runButton.getAttribute('disabled')
        const className = await runButton.getAttribute('class')
        const enabled = isDisabled === null || isDisabled === 'false'

        // Debug logging
        if (!enabled) {
          logStep(`[UI] DEBUG: Button still disabled - class: ${className}`)
        }

        if (enabled) {
          buttonEnabled = true
        }
        return enabled
      }, 10000) // Increased timeout for complex tests
      logStep('[UI] Run Analysis button is enabled')
    } catch (timeoutError) {
      // Get final button state for debugging
      const finalDisabled = await runButton.getAttribute('disabled')
      const finalClass = await runButton.getAttribute('class')
      logStep(`[UI] WARNING: Button timeout - disabled=${finalDisabled}, class contains opacity-50: ${(finalClass || '').includes('opacity-50')}`)
      logStep('[UI] Attempting click anyway...')
      // Sometimes the disabled attribute lags behind actual clickability
      // Try clicking anyway
    }

    try {
      await runButton.click()
      logStep('[UI] Clicked Run Analysis in column dialog')
    } catch (clickError) {
      logStep(`[UI] ERROR: Could not click button: ${clickError.message}`)
      // Try finding button again and clicking via JavaScript
      await driver.executeScript(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const runBtn = buttons.find(btn =>
          btn.textContent.includes('Run Analysis') || btn.textContent.includes('Run Test')
        )
        if (runBtn) {
          runBtn.click()
        }
      })
      logStep('[UI] Clicked button via JavaScript')
    }

    // Wait for possible follow-up dialogs (e.g., continuous variable selection, factor mapping, simple effects)
    await driver.sleep(2000)

    // LMM flow: column selection dialog is followed by the full LMM config dialog.
    // Re-check and handle it here to avoid stalling on an open dialog while waiting for results.
    const handledPostColumnLmmDialog = await handleLmmAnovaDialog(driver)
    if (handledPostColumnLmmDialog) {
      logStep('[UI] LMM dialog handled after column selection')
      await driver.sleep(1200)
      return
    }
  }

  // Check for One-Way ANOVA column mapper dialog
  const oneWayConfig = driver.__oneWayAnovaConfig || {}
  const oneWayDialogs = await driver.findElements(By.css('[data-testid="one-way-anova-dialog"]'))
  const handledOneWay = oneWayDialogs.length > 0

  if (handledOneWay) {
    await selectRadixOption(driver, 'one-way-group-select', oneWayConfig.groupColumn, { matchAttribute: 'data-label', required: true })
    await selectRadixOption(driver, 'one-way-outcome-select', oneWayConfig.valueColumn ?? oneWayConfig.outcomeColumn, { matchAttribute: 'data-label', required: true })

    if (oneWayConfig.adjustmentMethod) {
      await selectRadixOption(driver, 'one-way-adjustment-select', oneWayConfig.adjustmentMethod, { matchAttribute: 'data-value', required: true })
    }

    if (oneWayConfig.adjustmentMethod === 'dunnett' && oneWayConfig.controlLevel) {
      await selectRadixOption(driver, 'one-way-control-select', oneWayConfig.controlLevel, { matchAttribute: 'data-value', required: true })
    }

    const runBtns = await driver.findElements(By.css('[data-testid="one-way-anova-run"]'))
    if (runBtns.length > 0) {
      const disabled = await runBtns[0].getAttribute('disabled')
      if (disabled !== 'true') {
        await runBtns[0].click()
      }
    }
  }

  if (handledOneWay) {
    logStep('[UI] One-Way ANOVA mapper handled')
    await driver.sleep(2500)
    driver.__oneWayAnovaConfig = null
    return
  }

  // Check for continuous variable selection dialog (Two-Way ANOVA, Multifactorial ANOVA, Scheirer-Ray-Hare)
  const hasContinuousDialog = await driver.executeScript(() => {
    const dialog =
      document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
      document.querySelector('[role="dialog"]')
    const scope = dialog || document.body
    const text = scope?.innerText || ''
    return text.includes('Select Dependent Variable') || text.includes('Select Continuous Variable') || text.includes('numeric outcome variable')
  })

  if (hasContinuousDialog) {
    logStep('[UI] Dependent variable selection dialog detected')

    // Click the label for "value" column (this selects the radio button)
    const labelClicked = await driver.executeScript(() => {
      // Find all labels
      const labels = Array.from(document.querySelectorAll('label'))

      // Find label with "value" text
      const valueLabel = labels.find(label => label.textContent.trim() === 'value')

      if (valueLabel) {
        valueLabel.click()
        return true
      }

      // Fallback: click the radio button directly
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
      const valueRadio = radios.find(r => r.id === 'value' || r.value === 'value')

      if (valueRadio) {
        valueRadio.click()
        return true
      }

      return false
    })

    if (labelClicked) {
      logStep('[UI] Selected dependent variable (clicked label)')
    } else {
      logStep('[UI] WARNING: Could not find label or radio for dependent variable')
    }
    await driver.sleep(1500)

    // Click OK button
    const okClicked = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const okBtn = buttons.find(b => b.textContent.trim() === 'OK')
      if (okBtn && !okBtn.disabled) {
        okBtn.click()
        return true
      }
      return false
    })

    if (okClicked) {
      logStep('[UI] Clicked OK on dependent variable dialog')
    } else {
      logStep('[UI] WARNING: Could not find OK button')
    }
    await driver.sleep(2000)
  }

  // Check for factor role mapping dialog (Two-Way ANOVA, Multifactorial ANOVA, Scheirer-Ray-Hare)
  const hasFactorMappingDialog = await driver.executeScript(() => {
    const dialog =
      document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
      document.querySelector('[role="dialog"]')
    const scope = dialog || document.body
    const text = scope?.innerText || ''
    return text.includes('Assign Factor Roles') ||
           (text.includes('Factor A') && text.includes('Factor B') && text.includes('Primary')) ||
           (text.includes('Primary Factor') && text.includes('Secondary Factor'))
  })

  if (hasFactorMappingDialog) {
    logStep('[UI] Factor role mapping dialog detected')

    // Detect dialog type (Two-Way or Multifactorial)
    const factorMappingType = await driver.executeScript(() => {
      const dialog =
        document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
        document.querySelector('[role="dialog"]')
      const scope = dialog || document.body
      const text = scope?.innerText || ''
      if (text.includes('Facet Factors') || text.includes('Panels')) {
        return 'multifactorial'
      }
      return 'two_way'
    })

    logStep(`[UI] Factor mapping type: ${factorMappingType}`)

    // For E2E validation, we'll accept the default factor assignments
    // The dialogs auto-assign factors based on column order, which is sufficient for testing
    // In real usage, users can change these assignments via the dropdowns

    await driver.sleep(1500)

    // Click Continue button
    const continueClicked = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const continueBtn = buttons.find(b => b.textContent.trim() === 'Continue' && !b.disabled)
      if (continueBtn) {
        continueBtn.click()
        return true
      }
      return false
    })

    if (continueClicked) {
      logStep('[UI] Clicked Continue on factor mapping dialog')
    } else {
      logStep('[UI] WARNING: Could not find Continue button on factor mapping dialog')
    }
    await driver.sleep(2000)
  }

  // Check for simple effects selection dialog (Two-Way ANOVA or Multifactorial ANOVA ONLY - not Scheirer-Ray-Hare)
  let simpleEffectsDialogType = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    simpleEffectsDialogType = await driver.executeScript(() => {
      const dialog =
        document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
        null
      if (!dialog) return null

      if (dialog.querySelector('[data-testid="multi-adjustment-select"]')) {
        return 'multifactorial'
      }
      if (dialog.querySelector('[data-testid="two-way-adjustment-select"]')) {
        return 'two_way'
      }

      return null
    })

    if (simpleEffectsDialogType) break
    await driver.sleep(250)
  }

  if (simpleEffectsDialogType) {
    logStep(`[UI] Simple effects selection dialog detected (type: ${simpleEffectsDialogType})`)

    if (simpleEffectsDialogType === 'multifactorial') {
      // Multifactorial ANOVA: Select specific simple effects based on config
      // The dialog shows a table with Main Factor, Within Factor, and Enable checkbox
      const lmmConfig = driver.__lmmAnovaConfig || null
      const multifactorialConfig = driver.__multifactorialConfig || {}
      const desiredEffects = lmmConfig?.simpleEffects || multifactorialConfig.simpleEffects || []
      const selectAllWhenEmpty = !lmmConfig

      const selectedEffects = await driver.executeScript((effects, selectAllWhenEmpty) => {
        const root =
          document.querySelector('[data-testid="multi-adjustment-select"]')?.closest('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
          document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]')
        if (!root) {
          throw new Error('Multifactorial simple effects dialog root not found')
        }
        // Find all rows in the simple effects table
        // Each row has: Main Factor (blue), Within Factor (purple), Checkbox
        const rows = Array.from(root.querySelectorAll('.grid.grid-cols-3.items-center'))

        let selectedCount = 0

        for (const row of rows) {
          const cells = row.querySelectorAll('div')
          if (cells.length < 3) continue

          // Extract factor names from cells (first two cells)
          const mainFactor = cells[0]?.textContent?.trim()
          const withinFactor = cells[1]?.textContent?.trim()

          if (!mainFactor || !withinFactor) continue

          // Check if this row matches any desired effect
          const shouldSelect = effects.length === 0
            ? Boolean(selectAllWhenEmpty)
            : effects.some(e => e.mainFactor === mainFactor && e.withinFactor === withinFactor)

          if (shouldSelect) {
            // Find the checkbox in this row
            const checkbox = row.querySelector('button[role="checkbox"]')
            if (checkbox) {
              const isChecked = checkbox.getAttribute('data-state') === 'checked' || checkbox.getAttribute('aria-checked') === 'true'
              if (!isChecked) {
                checkbox.click()
                selectedCount++
              }
            }
          }
        }

        return selectedCount
      }, desiredEffects, selectAllWhenEmpty)

      logStep(`[UI] Selected ${selectedEffects} multifactorial simple effects`)
    } else {
      // Two-Way ANOVA: Select both checkboxes (Factor A within B and Factor B within A)
      const selectedEffects = await driver.executeScript(() => {
        const root =
          document.querySelector('[data-testid="two-way-adjustment-select"]')?.closest('[data-slot="dialog-content"], [data-radix-dialog-content]') ||
          document.querySelector('[data-slot="dialog-content"], [data-radix-dialog-content]')
        if (!root) {
          throw new Error('Two-way simple effects dialog root not found')
        }

        const checkboxIds = ['factorAWithinB', 'factorBWithinA']
        let selectedCount = 0

        for (const id of checkboxIds) {
          const checkbox = root.querySelector(`#${id}`) || root.querySelector(`[role="checkbox"][id="${id}"]`)
          if (!checkbox) {
            throw new Error(`Missing simple effects checkbox: ${id}`)
          }
          const isChecked = checkbox.getAttribute('data-state') === 'checked' || checkbox.getAttribute('aria-checked') === 'true'
          if (!isChecked) {
            checkbox.click()
            selectedCount += 1
          }
        }

        return selectedCount
      })

      logStep(`[UI] Selected ${selectedEffects} simple effects checkboxes`)
    }

    await driver.sleep(1500)

    // Apply adjustment method + control levels if provided
    const adjustmentConfig =
      simpleEffectsDialogType === 'multifactorial'
        ? (driver.__lmmAnovaConfig || driver.__multifactorialConfig)
        : driver.__twoWayAnovaConfig

    if (adjustmentConfig && adjustmentConfig.adjustmentMethod) {
      if (simpleEffectsDialogType === 'two_way') {
        const selected = await selectRadixOption(driver, 'two-way-adjustment-select', adjustmentConfig.adjustmentMethod, { matchAttribute: 'data-value', required: true })
        if (!selected) {
          const currentText = await getRadixTriggerText(driver, 'two-way-adjustment-select')
          if (!matchesAdjustmentValue(adjustmentConfig.adjustmentMethod, currentText)) {
            throw new Error(`Failed to select two-way adjustment method: ${adjustmentConfig.adjustmentMethod}`)
          }
        }
        if (adjustmentConfig.adjustmentMethod === 'dunnett') {
          const controlLevels = adjustmentConfig.controlLevels || {}
          const factor1Level = controlLevels.factor1 || adjustmentConfig.controlFactor1
          const factor2Level = controlLevels.factor2 || adjustmentConfig.controlFactor2
          if (factor1Level) {
            const selectedFactor1 = await selectRadixOption(driver, 'two-way-control-factor1-select', factor1Level, { matchAttribute: 'data-value', required: true })
            if (!selectedFactor1) {
              throw new Error(`Failed to select two-way control level for factor1: ${factor1Level}`)
            }
          }
          if (factor2Level) {
            const selectedFactor2 = await selectRadixOption(driver, 'two-way-control-factor2-select', factor2Level, { matchAttribute: 'data-value', required: true })
            if (!selectedFactor2) {
              throw new Error(`Failed to select two-way control level for factor2: ${factor2Level}`)
            }
          }
        }
      }

      if (simpleEffectsDialogType === 'multifactorial') {
        const selected = await selectRadixOption(driver, 'multi-adjustment-select', adjustmentConfig.adjustmentMethod, { matchAttribute: 'data-value', required: true })
        if (!selected) {
          const currentText = await getRadixTriggerText(driver, 'multi-adjustment-select')
          if (!matchesAdjustmentValue(adjustmentConfig.adjustmentMethod, currentText)) {
            throw new Error(`Failed to select multifactorial adjustment method: ${adjustmentConfig.adjustmentMethod}`)
          }
        }
        if (adjustmentConfig.adjustmentMethod === 'dunnett') {
          const controlLevels = adjustmentConfig.controlLevels || {}
          for (const [factor, level] of Object.entries(controlLevels)) {
            if (!level) continue
            const testId = `multi-control-select-${String(factor).toLowerCase().replace(/\s+/g, '-')}`
            const selectedLevel = await selectRadixOption(driver, testId, level, { matchAttribute: 'data-value', required: true })
            if (!selectedLevel) {
              throw new Error(`Failed to select multifactorial control level for ${factor}: ${level}`)
            }
          }
        }
      }
    }

    // Click Run/OK/Continue button
    const runClicked = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button'))

      // Try to find Run, Run Test, OK, Continue, or "Continue with X Simple Effects" button
      const runBtn = buttons.find(b => {
        const text = b.textContent.trim()
        return (text.includes('Run') || text === 'OK' || text.includes('Continue') || text.includes('Skip')) && !b.disabled
      })

      if (runBtn) {
        runBtn.click()
        return true
      }

      // Fallback: look for primary action button (usually colored)
      const primaryBtn = buttons.find(b => {
        const className = b.className || ''
        return (className.includes('bg-') || className.includes('primary')) && !b.disabled
      })

      if (primaryBtn) {
        primaryBtn.click()
        return true
      }

      return false
    })

    if (runClicked) {
      logStep('[UI] Clicked Run on simple effects dialog')
    } else {
      logStep('[UI] WARNING: Could not find Run button on simple effects dialog')
    }
    await driver.sleep(3000) // Wait for test to execute

    if (simpleEffectsDialogType === 'two_way') {
      driver.__twoWayAnovaConfig = null
    }
    if (simpleEffectsDialogType === 'multifactorial') {
      driver.__multifactorialConfig = null
    }
    if (simpleEffectsDialogType === 'multifactorial') {
      driver.__lmmAnovaConfig = null
    }
  }

  // Verify dialog closed
  const dialogClosed = await driver.executeScript(() => {
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"], [data-radix-dialog-overlay]')
    return overlays.length === 0
  })

  if (dialogClosed) {
    logStep('[UI] All dialogs closed, test should be running')
  } else {
    logStep('[UI] WARNING: Dialog may still be open, waiting longer...')
    try {
      await driver.wait(async () => {
        const overlays = await driver.executeScript(() => {
          return document.querySelectorAll('[data-slot="dialog-overlay"], [data-radix-dialog-overlay]').length
        })
        return overlays === 0
      }, 10000)
    } catch (error) {
      logStep('[UI] WARNING: Dialog still open after wait, continuing to handle follow-up dialogs...')
    }
  }
}

/**
 * Switch to Results tab
 */
async function switchToResultsTab(driver, timeout = 10000) {
  logStep('[UI] Switching to Results tab...')

  // Look for Results tab/button
  const resultsTab = await driver.wait(async () => {
    const elements = await driver.findElements({ css: 'button, [role="tab"]' })
    for (const el of elements) {
      const text = await el.getText()
      if (text.trim() !== 'Results') continue

      const disabledAttr = await el.getAttribute('disabled')
      const ariaDisabled = await el.getAttribute('aria-disabled')
      if (disabledAttr !== null || ariaDisabled === 'true') continue

      const isDisplayed = await el.isDisplayed().catch(() => false)
      if (!isDisplayed) continue

      return el
    }
    return null
  }, timeout)

  if (!resultsTab) {
    logStep('[UI] WARNING: Could not find enabled Results tab - may already be on Results view')
    return
  }

  await resultsTab.click()
  logStep('[UI] Switched to Results tab')
  await driver.sleep(1000)
}

/**
 * Switch to Plots tab
 */
async function switchToPlotsTab(driver) {
  logStep('[UI] Switching to Plots tab...')

  // Look for Plots tab/button
  const plotsTab = await driver.wait(async () => {
    const elements = await driver.findElements({ css: 'button, [role="tab"]' })
    for (const el of elements) {
      const text = await el.getText()
      if (text.trim() === 'Plots') {
        return el
      }
    }
    return null
  }, 5000)

  if (!plotsTab) {
    logStep('[UI] WARNING: Could not find Plots tab')
    throw new Error('Plots tab not found')
  }

  await plotsTab.click()
  logStep('[UI] Switched to Plots tab')
  await driver.sleep(2000) // Wait for plots to render
}

// Export the function for use in tests
export { switchToPlotsTab }

// =============================================================================
// SURVIVAL ANALYSIS TESTS (Kaplan-Meier, Cox PH, Nelson-Aalen)
// =============================================================================

/**
 * Run a Kaplan-Meier survival analysis test via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Optional column mapping { time, event, group }
 */
export async function runKaplanMeierTest(driver, config = {}) {
  logStep('[UI] Starting Kaplan-Meier survival workflow...')
  if (config.mapping) {
    driver.__survivalMappingOverride = config.mapping
  }
  await runTestById(driver, 'kaplan_meier', 'survival')
}

/**
 * Run a Cox Proportional Hazards model via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Optional column mapping { time, event, covariates[] }
 */
export async function runCoxRegressionTest(driver, config = {}) {
  logStep('[UI] Starting Cox Proportional Hazards workflow...')
  if (config.mapping) {
    driver.__survivalMappingOverride = config.mapping
    // Cox regression needs ALL columns selected (time, event, and all covariates)
    const allCols = [config.mapping.time, config.mapping.event, ...(config.mapping.covariates || [])]
    driver.__columnSelectionOverride = allCols
  }
  await runTestById(driver, 'cox_regression', 'survival')
}

/**
 * Run a Nelson-Aalen cumulative hazard estimator via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Optional column mapping { time, event }
 */
export async function runNelsonAalenTest(driver, config = {}) {
  logStep('[UI] Starting Nelson-Aalen workflow...')
  if (config.mapping) {
    driver.__survivalMappingOverride = config.mapping
  }
  await runTestById(driver, 'nelson_aalen', 'survival')
}

/**
 * Handle Survival Analysis column mapper dialog
 * Maps time, event, and optional group/covariate columns
 * @param {object} driver - Selenium WebDriver instance
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleSurvivalColumnMapper(driver) {
  logStep('[UI] Checking for Survival column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      (text.includes('Time Variable') && text.includes('Event Indicator')) ||
      text.includes('Configure Kaplan-Meier') ||
      text.includes('Configure Cox Proportional') ||
      text.includes('Configure Nelson-Aalen')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No Survival column mapper dialog detected')
    driver.__survivalMappingOverride = null
    return false
  }

  logStep('[UI] Survival column mapper dialog detected')

  const mappingOverride = driver.__survivalMappingOverride || { time: 'time', event: 'event', group: 'group' }

  // Select Time Variable
  logStep('[UI] Selecting Time Variable...')
  await driver.executeScript((timeCol) => {
    const trigger = document.querySelector('#time-variable')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((timeCol) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(timeCol.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.time || 'time')
  await driver.sleep(400)

  // Select Event Indicator
  logStep('[UI] Selecting Event Indicator...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#event-variable')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((eventCol) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(eventCol.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.event || 'event')
  await driver.sleep(500)

  // Select Group Variable (if available and needed - for Kaplan-Meier/Nelson-Aalen)
  const hasGroupField = await driver.executeScript(() => {
    return document.querySelector('#group-variable') !== null
  })

  if (hasGroupField && mappingOverride.group) {
    logStep('[UI] Selecting Group Variable...')
    await driver.executeScript(() => {
      const trigger = document.querySelector('#group-variable')
      if (trigger) trigger.click()
    })
    await driver.sleep(400)

    await driver.executeScript((groupCol) => {
      const options = Array.from(document.querySelectorAll('[role="option"]'))
      const opt = options.find(o => o.textContent.toLowerCase().includes(groupCol.toLowerCase()))
      if (opt) opt.click()
    }, mappingOverride.group)
    await driver.sleep(400)
  }

  // Select Covariates (for Cox regression - uses checkboxes)
  if (mappingOverride.covariates && mappingOverride.covariates.length > 0) {
    logStep(`[UI] Selecting ${mappingOverride.covariates.length} covariates...`)

    await driver.executeScript((covariateNames) => {
      // Find all checkbox containers in the covariates section
      const checkboxes = Array.from(document.querySelectorAll('button[role="checkbox"]'))

      for (const covName of covariateNames) {
        // Find the checkbox label that contains this covariate name
        const checkbox = checkboxes.find(cb => {
          const label = cb.closest('div')?.querySelector('label')
          return label && label.textContent.toLowerCase().includes(covName.toLowerCase())
        })

        if (checkbox && checkbox.getAttribute('data-state') !== 'checked') {
          checkbox.click()
        }
      }
    }, mappingOverride.covariates)
    await driver.sleep(500)
  }

  // Wait for form to validate and button to enable
  await driver.sleep(500)

  // Click Perform Test button INSIDE the dialog (not the toolbar button)
  const clicked = await driver.executeScript(() => {
    // Find the dialog content first
    const dialog = document.querySelector('[data-slot="dialog-content"]') ||
                   document.querySelector('[role="dialog"]')
    if (!dialog) return false

    // Find Perform Test button within the dialog
    const buttons = Array.from(dialog.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Perform Test')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Perform Test on Survival mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Perform Test button in Survival mapper')
  }

  driver.__survivalMappingOverride = null
  await driver.sleep(1000)
  return true
}

// =============================================================================
// PHARMACOLOGY COLUMN MAPPING HANDLERS
// =============================================================================

/**
 * Handle Dose-Response column mapper dialog
 * Auto-selects dose and response columns from the available options
 */
async function handleDoseResponseColumnMapper(driver) {
  logStep('[UI] Checking for Dose-Response column mapper dialog...')

  await driver.sleep(1000)

  // Check if dose-response mapper dialog is present
  const hasDoseResponseDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Dose/Concentration') && text.includes('Response/Effect')
  })

  if (!hasDoseResponseDialog) {
    logStep('[UI] No Dose-Response column mapper dialog detected')
    return false
  }

  logStep('[UI] Dose-Response column mapper dialog detected')

  // Select first available option for dose, second for response
  const selected = await driver.executeScript(() => {
    // Find all select triggers (Radix UI uses button with role=combobox)
    const selectTriggers = Array.from(document.querySelectorAll('button[role="combobox"]'))

    if (selectTriggers.length < 2) {
      return { success: false, error: 'Not enough select elements found' }
    }

    let selectedCount = 0

    // Click first select (Dose)
    selectTriggers[0].click()
    return { success: true, step: 'opened_first_select' }
  })

  if (!selected.success) {
    logStep(`[UI] ERROR: ${selected.error}`)
    return false
  }

  await driver.sleep(500)

  // Select first option for dose
  await driver.executeScript(() => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    if (options.length > 0) {
      options[0].click()
    }
  })

  await driver.sleep(500)

  // Click second select (Response)
  await driver.executeScript(() => {
    const selectTriggers = Array.from(document.querySelectorAll('button[role="combobox"]'))
    if (selectTriggers.length >= 2) {
      selectTriggers[1].click()
    }
  })

  await driver.sleep(500)

  // Select first available option for response (which should be second column since first is used)
  await driver.executeScript(() => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    // Find first non-disabled option
    const availableOption = options.find(opt => !opt.hasAttribute('data-disabled'))
    if (availableOption) {
      availableOption.click()
    } else if (options.length > 0) {
      options[0].click()
    }
  })

  await driver.sleep(500)

  // Click Run Analysis button
  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find(btn => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on dose-response mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button')
  }

  await driver.sleep(1000)
  return true
}

/**
 * Handle Synergy column mapper dialog
 * Auto-selects the required columns for synergy analysis
 */
async function handleSynergyColumnMapper(driver) {
  logStep('[UI] Checking for Synergy column mapper dialog...')

  await driver.sleep(1000)

  // Check if synergy mapper dialog is present
  const hasSynergyDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (text.includes('Drug A Dose') && text.includes('Drug B Dose')) ||
           text.includes('Synergy') || text.includes('drug combination')
  })

  if (!hasSynergyDialog) {
    logStep('[UI] No Synergy column mapper dialog detected')
    return false
  }

  logStep('[UI] Synergy column mapper dialog detected')

  // Synergy mapper has 5 fields: doseA, doseB, responseA, responseB, responseCombined
  // Or it may use boundary mode where single-agent responses are derived from boundary rows

  // First check if there's a mode selector (Boundary vs Explicit)
  const modeSelected = await driver.executeScript(() => {
    // Look for radio buttons or tabs for mode selection
    const boundaryOption = Array.from(document.querySelectorAll('button, input[type="radio"], label'))
      .find(el => el.textContent?.toLowerCase().includes('boundary'))
    if (boundaryOption) {
      boundaryOption.click()
      return 'boundary'
    }
    return null
  })

  if (modeSelected) {
    logStep(`[UI] Selected ${modeSelected} mode for synergy`)
  }

  await driver.sleep(500)

  // Select columns for all available select fields
  // In boundary mode: doseA, doseB, responseCombined (3 fields)
  // In explicit mode: doseA, doseB, responseA, responseB, responseCombined (5 fields)
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })
  logStep(`[UI] Found ${selectTriggers.length} select triggers in synergy mapper`)

  for (let i = 0; i < selectTriggers.length; i++) {
    try {
      await selectTriggers[i].click()
      await driver.sleep(300)

      // Select first available option
      await driver.executeScript(() => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const availableOption = options.find(opt => !opt.hasAttribute('data-disabled'))
        if (availableOption) {
          availableOption.click()
        } else if (options.length > 0) {
          options[0].click()
        }
      })

      await driver.sleep(300)
    } catch (err) {
      logStep(`[UI] Error selecting option ${i}: ${err.message}`)
    }
  }

  await driver.sleep(500)

  // Click Run Analysis button
  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find(btn => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on synergy mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button')
  }

  await driver.sleep(1000)
  return true
}

/**
 * Handle Chi-Square GOF column mapper dialog
 * Maps category labels, observed counts, and expected proportions
 */
async function handleChiSquareGofColumnMapper(driver) {
  logStep('[UI] Checking for Chi-Square GOF column mapper dialog...')

  await driver.sleep(1000)

  const hasGofDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Goodness of Fit') && text.includes('Observed Counts')
  })

  if (!hasGofDialog) {
    logStep('[UI] No Chi-Square GOF column mapper dialog detected')
    driver.__chiSquareGofMappingOverride = null
    return false
  }

  logStep('[UI] Chi-Square GOF column mapper dialog detected')

  const mappingOverride = driver.__chiSquareGofMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for GOF mapper')
    return false
  }

  const fieldKeys = ['category', 'observed', 'expected']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null

        if (field === 'category') {
          if (mapping && mapping.category) {
            option = pickByText(mapping.category)
          }
          if (!option) {
            option = pickByText('No category labels')
          }
        } else if (field === 'observed') {
          if (mapping && mapping.observed === '__CATEGORY_COUNTS__') {
            option = pickByText('Derive from category counts')
          } else if (mapping && mapping.observed) {
            option = pickByText(mapping.observed)
          }
        } else if (field === 'expected') {
          if (mapping && mapping.expected) {
            option = pickByText(mapping.expected)
          }
          if (!option) {
            option = pickByText('Use uniform distribution')
          }
        }

        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on GOF mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in GOF mapper')
  }

  driver.__chiSquareGofMappingOverride = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle Chi-Square Independence column mapper dialog
 * Maps group (row) and outcome (column) variables
 */
async function handleChiSquareColumnMapper(driver) {
  logStep('[UI] Checking for Chi-Square column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Chi-Square') && text.includes('Outcome') && text.includes('Group')
  })

  if (!hasDialog) {
    logStep('[UI] No Chi-Square column mapper dialog detected')
    driver.__chiSquareMappingOverride = null
    return false
  }

  logStep('[UI] Chi-Square column mapper dialog detected')

  const mappingOverride = driver.__chiSquareMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Chi-Square mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on Chi-Square mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in Chi-Square mapper')
  }

  driver.__chiSquareMappingOverride = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle Fisher's Exact column mapper dialog
 * Maps group (row) and outcome (column) variables
 */
async function handleFisherExactColumnMapper(driver) {
  logStep('[UI] Checking for Fisher\'s Exact column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Fisher') && text.includes('Outcome') && text.includes('Group')
  })

  if (!hasDialog) {
    logStep('[UI] No Fisher\'s Exact column mapper dialog detected')
    driver.__fisherMappingOverride = null
    return false
  }

  logStep('[UI] Fisher\'s Exact column mapper dialog detected')

  const mappingOverride = driver.__fisherMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Fisher\'s Exact mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on Fisher\'s Exact mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in Fisher\'s Exact mapper')
  }

  driver.__fisherMappingOverride = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle Independent T-Test column mapper dialog
 * Maps group (categorical) and outcome (numeric) variables
 */
async function handleIndependentTTestColumnMapper(driver) {
  logStep('[UI] Checking for Independent T-Test column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      text.includes('Independent') &&
      text.includes('Group Variable') &&
      text.includes('Outcome Variable')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No Independent T-Test column mapper dialog detected')
    driver.__independentTTestMappingOverride = null
    return false
  }

  logStep('[UI] Independent T-Test column mapper dialog detected')

  const mappingOverride = driver.__independentTTestMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Independent T-Test mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on Independent T-Test mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in Independent T-Test mapper')
  }

  driver.__independentTTestMappingOverride = null
  await driver.sleep(1000)
  return true
}

async function handleMannWhitneyColumnMapper(driver) {
  logStep('[UI] Checking for Mann-Whitney U column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      text.includes('Mann-Whitney') &&
      text.includes('Group Variable') &&
      text.includes('Outcome Variable')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No Mann-Whitney column mapper dialog detected')
    driver.__mannWhitneyMappingOverride = null
    return false
  }

  logStep('[UI] Mann-Whitney column mapper dialog detected')

  const mappingOverride = driver.__mannWhitneyMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Mann-Whitney mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    const confirmBtn = buttons.find((btn) => btn.textContent.trim() === 'Confirm')
    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Confirmed Mann-Whitney U mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis/Confirm button in Mann-Whitney mapper')
  }

  driver.__mannWhitneyMappingOverride = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle Paired T-Test column mapper dialog
 * Maps time/condition (categorical) and outcome (numeric) variables
 */
async function handlePairedTTestColumnMapper(driver) {
  logStep('[UI] Checking for Paired T-Test column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      text.includes('Paired') &&
      text.includes('Time/Condition Variable') &&
      text.includes('Outcome Variable')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No Paired T-Test column mapper dialog detected')
    driver.__pairedTTestMappingOverride = null
    return false
  }

  logStep('[UI] Paired T-Test column mapper dialog detected')

  const mappingOverride = driver.__pairedTTestMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Paired T-Test mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on Paired T-Test mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in Paired T-Test mapper')
  }

  driver.__pairedTTestMappingOverride = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle Wilcoxon Signed-Rank Test column mapper dialog
 * @param {import('selenium-webdriver').WebDriver} driver
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleWilcoxonColumnMapper(driver) {
  logStep('[UI] Checking for Wilcoxon Signed-Rank Test column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      text.includes('Wilcoxon') &&
      text.includes('Time/Condition Variable') &&
      text.includes('Outcome Variable')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No Wilcoxon column mapper dialog detected')
    driver.__wilcoxonMappingOverride = null
    return false
  }

  logStep('[UI] Wilcoxon column mapper dialog detected')

  const mappingOverride = driver.__wilcoxonMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Wilcoxon mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on Wilcoxon mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in Wilcoxon mapper')
  }

  driver.__wilcoxonMappingOverride = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle One-Way ANOVA column mapper dialog
 * Maps group (categorical) and outcome (numeric) variables
 * @param {import('selenium-webdriver').WebDriver} driver
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleOneWayAnovaColumnMapper(driver) {
  logStep('[UI] Checking for One-Way ANOVA column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      text.includes('One-Way ANOVA') &&
      text.includes('Grouping Variable') &&
      text.includes('Outcome Variable')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No One-Way ANOVA column mapper dialog detected')
    driver.__oneWayAnovaMappingOverride = null
    return false
  }

  logStep('[UI] One-Way ANOVA column mapper dialog detected')

  const mappingOverride = driver.__oneWayAnovaMappingOverride || null
  const config = driver.__oneWayAnovaConfig || {}
  const groupValue = config.groupColumn || (mappingOverride && mappingOverride.group) || null
  const outcomeValue = config.valueColumn || config.outcomeColumn || (mappingOverride && mappingOverride.outcome) || null
  const useConfig = Boolean(groupValue || outcomeValue || config.adjustmentMethod || config.controlLevel)

  const groupSelects = await driver.findElements(By.css('[data-testid="one-way-group-select"]'))
  const outcomeSelects = await driver.findElements(By.css('[data-testid="one-way-outcome-select"]'))

  if (useConfig && groupSelects.length > 0 && outcomeSelects.length > 0) {
    if (groupValue) {
      await selectRadixOption(driver, 'one-way-group-select', groupValue, { matchAttribute: 'data-label', required: true })
    }
    if (outcomeValue) {
      await selectRadixOption(driver, 'one-way-outcome-select', outcomeValue, { matchAttribute: 'data-label', required: true })
    }
    if (config.adjustmentMethod) {
      await selectRadixOption(driver, 'one-way-adjustment-select', config.adjustmentMethod, { matchAttribute: 'data-value', required: true })
    }
    if (config.adjustmentMethod === 'dunnett' && config.controlLevel) {
      await selectRadixOption(driver, 'one-way-control-select', config.controlLevel, { matchAttribute: 'data-value', required: true })
    }
  } else {
    const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

    if (selectTriggers.length < 2) {
      logStep('[UI] WARNING: Not enough select fields for One-Way ANOVA mapper')
      return false
    }

    const fieldKeys = ['group', 'outcome']

    for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
      await selectTriggers[i].click()
      await driver.sleep(300)

      const fieldKey = fieldKeys[i]

      await driver.executeScript(
        (field, mapping) => {
          const options = Array.from(document.querySelectorAll('[role="option"]'))
          const pickByText = (text) =>
            options.find((opt) => (opt.textContent || '').includes(text))

          let option = null
          if (mapping && mapping[field]) {
            option = pickByText(mapping[field])
          }
          if (!option) {
            option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
          }

          if (option) {
            option.click()
          }
        },
        fieldKey,
        mappingOverride
      )

      await driver.sleep(300)
    }
  }

  let clicked = false
  const runBtns = await driver.findElements(By.css('[data-testid="one-way-anova-run"]'))
  if (runBtns.length > 0) {
    const runBtn = runBtns[0]
    const disabled = await runBtn.getAttribute('disabled')
    if (!disabled) {
      await runBtn.click()
      clicked = true
    }
  }

  if (!clicked) {
    clicked = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
      if (runBtn && !runBtn.disabled) {
        runBtn.click()
        return true
      }
      return false
    })
  }

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on One-Way ANOVA mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in One-Way ANOVA mapper')
  }

  driver.__oneWayAnovaMappingOverride = null
  driver.__oneWayAnovaConfig = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle Kruskal-Wallis Test column mapper dialog
 * Maps group (categorical) and outcome (numeric) variables
 * @param {import('selenium-webdriver').WebDriver} driver
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleKruskalWallisColumnMapper(driver) {
  logStep('[UI] Checking for Kruskal-Wallis column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return (
      text.includes('Kruskal-Wallis Test') &&
      text.includes('Grouping Variable') &&
      text.includes('Outcome Variable')
    )
  })

  if (!hasDialog) {
    logStep('[UI] No Kruskal-Wallis column mapper dialog detected')
    driver.__kruskalWallisMappingOverride = null
    return false
  }

  logStep('[UI] Kruskal-Wallis column mapper dialog detected')

  const mappingOverride = driver.__kruskalWallisMappingOverride || null
  const kruskalConfig = driver.__kruskalWallisConfig || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for Kruskal-Wallis mapper')
    return false
  }

  const fieldKeys = ['group', 'outcome']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  if (kruskalConfig?.adjustmentMethod) {
    const selected = await selectRadixOption(driver, 'kruskal-adjustment-select', kruskalConfig.adjustmentMethod, {
      matchAttribute: 'data-value',
      required: true,
    })
    if (!selected) {
      const currentText = await getRadixTriggerText(driver, 'kruskal-adjustment-select')
      if (!matchesAdjustmentValue(kruskalConfig.adjustmentMethod, currentText)) {
        throw new Error(`Failed to select Kruskal-Wallis adjustment method: ${kruskalConfig.adjustmentMethod}`)
      }
    }
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on Kruskal-Wallis mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in Kruskal-Wallis mapper')
  }

  driver.__kruskalWallisMappingOverride = null
  driver.__kruskalWallisConfig = null
  await driver.sleep(1000)
  return true
}

/**
 * Handle McNemar's Test column mapper dialog
 * Maps before (pre-treatment) and after (post-treatment) variables
 */
async function handleMcNemarColumnMapper(driver) {
  logStep('[UI] Checking for McNemar column mapper dialog...')

  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('McNemar') && text.includes('Before') && text.includes('After')
  })

  if (!hasDialog) {
    logStep('[UI] No McNemar column mapper dialog detected')
    driver.__mcnemarMappingOverride = null
    return false
  }

  logStep('[UI] McNemar column mapper dialog detected')

  const mappingOverride = driver.__mcnemarMappingOverride || null
  const selectTriggers = await driver.findElements({ css: 'button[role="combobox"]' })

  if (selectTriggers.length < 2) {
    logStep('[UI] WARNING: Not enough select fields for McNemar mapper')
    return false
  }

  const fieldKeys = ['before', 'after']

  for (let i = 0; i < Math.min(selectTriggers.length, fieldKeys.length); i++) {
    await selectTriggers[i].click()
    await driver.sleep(300)

    const fieldKey = fieldKeys[i]

    await driver.executeScript(
      (field, mapping) => {
        const options = Array.from(document.querySelectorAll('[role="option"]'))
        const pickByText = (text) =>
          options.find((opt) => (opt.textContent || '').includes(text))

        let option = null
        if (mapping && mapping[field]) {
          option = pickByText(mapping[field])
        }
        if (!option) {
          option = options.find((opt) => !opt.hasAttribute('data-disabled')) || options[0]
        }

        if (option) {
          option.click()
        }
      },
      fieldKey,
      mappingOverride
    )

    await driver.sleep(300)
  }

  const clicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find((btn) => btn.textContent.trim() === 'Run Analysis')
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (clicked) {
    logStep('[UI] Clicked Run Analysis on McNemar mapper')
  } else {
    logStep('[UI] WARNING: Could not find enabled Run Analysis button in McNemar mapper')
  }

  driver.__mcnemarMappingOverride = null
  await driver.sleep(1000)
  return true
}

// =============================================================================
// PHARMACOLOGY TESTS (Dose-Response and Synergy)
// =============================================================================

/**
 * Run a Dose-Response 3PL test via UI
 */
export async function runDoseResponse3PL(driver, config = {}) {
  logStep('[UI] Starting Dose-Response 3PL workflow...')
  await runTestById(driver, 'dose_response_3pl', 'pharmacology')
}

/**
 * Run a Dose-Response 4PL test via UI
 */
export async function runDoseResponse4PL(driver, config = {}) {
  logStep('[UI] Starting Dose-Response 4PL workflow...')
  await runTestById(driver, 'dose_response_4pl', 'pharmacology')
}

/**
 * Run a Dose-Response 5PL test via UI
 */
export async function runDoseResponse5PL(driver, config = {}) {
  logStep('[UI] Starting Dose-Response 5PL workflow...')
  await runTestById(driver, 'dose_response_5pl', 'pharmacology')
}

/**
 * Run a Dose-Response Model Comparison test via UI
 */
export async function runDoseResponseCompare(driver, config = {}) {
  logStep('[UI] Starting Dose-Response Compare workflow...')
  await runTestById(driver, 'dose_response_compare', 'pharmacology')
}

/**
 * Run a Synergy Bliss test via UI
 */
export async function runSynergyBliss(driver, config = {}) {
  logStep('[UI] Starting Synergy Bliss workflow...')
  await runTestById(driver, 'synergy_bliss', 'pharmacology')
}

/**
 * Run a Synergy HSA test via UI
 */
export async function runSynergyHSA(driver, config = {}) {
  logStep('[UI] Starting Synergy HSA workflow...')
  await runTestById(driver, 'synergy_hsa', 'pharmacology')
}

/**
 * Run a Synergy Loewe test via UI
 */
export async function runSynergyLoewe(driver, config = {}) {
  logStep('[UI] Starting Synergy Loewe workflow...')
  await runTestById(driver, 'synergy_loewe', 'pharmacology')
}

/**
 * Run a Synergy ZIP test via UI
 */
export async function runSynergyZIP(driver, config = {}) {
  logStep('[UI] Starting Synergy ZIP workflow...')
  await runTestById(driver, 'synergy_zip', 'pharmacology')
}

/**
 * Run Synergy All Methods test via UI
 */
export async function runSynergyAll(driver, config = {}) {
  logStep('[UI] Starting Synergy All Methods workflow...')
  await runTestById(driver, 'synergy_all', 'pharmacology')
}

// =============================================================================
// CATEGORICAL TESTS (Chi-Square, Fisher's Exact, McNemar)
// =============================================================================

/**
 * Run a categorical test (Chi-Square, Fisher, McNemar, GOF).
 * @param {object} driver - Selenium WebDriver
 * @param {string} testType - One of: chi_square, chi_square_gof, fishers_exact, mcnemar
 * @param {string[]} columnNames - Optional explicit column names to select
 */
export async function runCategoricalTest(driver, testType, columnNames = null) {
  logStep(`[UI] Starting categorical test: ${testType}`)

  // Store column selection override for handleCategoricalColumnSelection
  driver.__categoricalColumnOverride = columnNames
  driver.__categoricalTestType = testType
  if (testType === 'chi_square_gof') {
    if (Array.isArray(columnNames) && columnNames.length > 0) {
      driver.__chiSquareGofMappingOverride = {
        category: columnNames[0] ?? null,
        observed: columnNames[1] ?? '__CATEGORY_COUNTS__',
        expected: columnNames[2] ?? null,
      }
    } else {
      driver.__chiSquareGofMappingOverride = null
    }
  }
  if (testType === 'chi_square') {
    if (Array.isArray(columnNames) && columnNames.length > 0) {
      driver.__chiSquareMappingOverride = {
        group: columnNames[0] ?? null,
        outcome: columnNames[1] ?? null,
      }
    } else {
      driver.__chiSquareMappingOverride = null
    }
  }
  if (testType === 'fishers_exact') {
    if (Array.isArray(columnNames) && columnNames.length > 0) {
      driver.__fisherMappingOverride = {
        group: columnNames[0] ?? null,
        outcome: columnNames[1] ?? null,
      }
    } else {
      driver.__fisherMappingOverride = null
    }
  }
  if (testType === 'mcnemar') {
    if (Array.isArray(columnNames) && columnNames.length > 0) {
      driver.__mcnemarMappingOverride = {
        before: columnNames[0] ?? null,
        after: columnNames[1] ?? null,
      }
    } else {
      driver.__mcnemarMappingOverride = null
    }
  }

  await runTestById(driver, testType, 'categorical')
}

/**
 * Handle column selection specifically for categorical tests.
 * Different tests require different numbers of columns.
 */
async function handleCategoricalColumnSelection(driver) {
  logStep('[UI] Checking for categorical column selection dialog...')

  const testType = driver.__categoricalTestType
  const columnNames = driver.__categoricalColumnOverride

  await driver.sleep(1000)

  // Check if column selection dialog is present
  const hasColumnDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Select Columns') || text.includes('Pick a categorical')
  })

  if (!hasColumnDialog) {
    logStep('[UI] No categorical column selection dialog - test may auto-run')
    return
  }

  logStep(`[UI] Categorical column selection dialog detected for ${testType}`)

  if (columnNames && columnNames.length > 0) {
    // Explicit column selection by name
    await selectColumnsByName(driver, columnNames)
  } else {
    // Auto-select based on test type
    const selectedCount = await driver.executeScript((testTypeArg) => {
      const allDivs = Array.from(document.querySelectorAll('div'))

      // Find clickable column cards
      const columnCards = allDivs.filter(el => {
        const style = window.getComputedStyle(el)
        const text = el.innerText || ''

        const hasPointerCursor = style.cursor === 'pointer'
        const hasTypeBadge = text.includes('BINARY') || text.includes('CATEGORICAL')
        const hasMetadata = text.includes('unique values')
        const isReasonableSize = text.length < 500

        return hasPointerCursor && hasTypeBadge && hasMetadata && isReasonableSize
      })

      // Filter for categorical/binary only
      const categoricalCards = columnCards.filter(el =>
        el.innerText.includes('BINARY') || el.innerText.includes('CATEGORICAL')
      )

      let clickedCount = 0

      switch (testTypeArg) {
        case 'chi_square':
        case 'fishers_exact':
          // Select 2 categorical columns
          if (categoricalCards.length >= 2) {
            categoricalCards[0].click()
            categoricalCards[1].click()
            clickedCount = 2
          }
          break

        case 'chi_square_gof':
          // Select 1 categorical column
          if (categoricalCards.length >= 1) {
            categoricalCards[0].click()
            clickedCount = 1
          }
          break

        case 'mcnemar':
          // Select paired columns (before, after)
          if (categoricalCards.length >= 2) {
            categoricalCards[0].click()
            categoricalCards[1].click()
            clickedCount = 2
          }
          break

        default:
          // Fallback: select available categorical columns
          if (categoricalCards.length > 0) {
            categoricalCards[0].click()
            clickedCount = 1
          }
      }

      return clickedCount
    }, testType)

    logStep(`[UI] Selected ${selectedCount} categorical columns`)
  }

  // Clear overrides
  driver.__categoricalColumnOverride = null
  driver.__categoricalTestType = null

  await driver.sleep(1500)

  // Find and click "Run Analysis" button
  const runClicked = await driver.executeScript(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const runBtn = buttons.find(btn =>
      btn.textContent.includes('Run Analysis') || btn.textContent.includes('Run Test')
    )
    if (runBtn && !runBtn.disabled) {
      runBtn.click()
      return true
    }
    return false
  })

  if (runClicked) {
    logStep('[UI] Clicked Run Analysis for categorical test')
  } else {
    logStep('[UI] WARNING: Could not find Run Analysis button for categorical test')
  }

  await driver.sleep(1000)
}

/**
 * Run Chi-Square Independence Test via UI
 */
export async function runChiSquareTest(driver, columnNames = null) {
  await runCategoricalTest(driver, 'chi_square', columnNames)
}

/**
 * Run Chi-Square Goodness of Fit Test via UI
 */
export async function runChiSquareGOFTest(driver, columnNames = null) {
  await runCategoricalTest(driver, 'chi_square_gof', columnNames)
}

/**
 * Run Fisher's Exact Test via UI
 */
export async function runFishersExactTest(driver, columnNames = null) {
  await runCategoricalTest(driver, 'fishers_exact', columnNames)
}

/**
 * Run McNemar's Test via UI
 */
export async function runMcNemarTest(driver, columnNames = null) {
  await runCategoricalTest(driver, 'mcnemar', columnNames)
}

/**
 * Run a Distribution/Descriptive test (Normality All, Descriptive Stats, Outlier Detection).
 *
 * Group 5 tests are simpler than other groups:
 * - Require only 1 NUMERIC column (no categorical)
 * - No column mapper dialogs
 * - No encoding dialogs
 *
 * Does NOT call waitForResults() - caller should handle that after setting up validation.
 *
 * @param {object} driver - Selenium WebDriver instance
 * @param {string} testType - One of: normality_all, descriptive_stats, outlier_detection
 * @param {string} columnName - Optional specific column name to select (default: 'value')
 */
export async function runDistributionTest(driver, testType, columnName = 'value') {
  logStep(`[UI] Running distribution test: ${testType}`)

  // Capture baseline before orchestration so waitForResults can detect a new result.
  driver.__resultsBaseline = await getResultsSnapshot(driver)
  driver.__resultsBaselineAt = Date.now()

  // 1. Open test selection dialog
  await openTestSelectionDialog(driver)

  // 2. Expand distribution_descriptive group
  await expandTestGroup(driver, 'distribution_descriptive')

  // 3. Select specific test
  await selectTest(driver, testType)

  // 4. Confirm test selection (closes dialog and may trigger column selection)
  await confirmTestSelection(driver)

  // 5. Handle column selection using override for single numeric column
  // Default handleColumnSelection() may select all numeric columns, so we override
  await driver.executeScript((colName) => {
    window.__columnSelectionOverride = { selectColumns: [colName] }
  }, columnName)

  await handleColumnSelection(driver)

  logStep(`[UI] Distribution test submitted: ${testType}`)
  // NOTE: Does NOT call waitForResults() - caller handles this
  // This avoids double-wait issues when validateAgainstRBaseline() also waits
}

/**
 * Run Normality (All Tests) via UI
 */
export async function runNormalityAllTest(driver, columnName = 'value') {
  await runDistributionTest(driver, 'normality_all', columnName)
}

/**
 * Run Descriptive Statistics via UI
 */
export async function runDescriptiveStatsTest(driver, columnName = 'value') {
  await runDistributionTest(driver, 'descriptive_stats', columnName)
}

/**
 * Run Outlier Detection via UI
 */
export async function runOutlierDetectionTest(driver, columnName = 'value') {
  await runDistributionTest(driver, 'outlier_detection', columnName)
}

/**
 * Run Mediation Analysis (Model 4) via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Optional column mapping { outcome, predictor, mediator }
 */
export async function runMediationModel4Test(driver, config = {}) {
  logStep('[UI] Starting Mediation Analysis (Model 4) workflow...')
  if (config.mapping) {
    driver.__mediationMappingOverride = config.mapping
  }
  await runTestById(driver, 'mediation_model4', 'mediation_moderation')
}

/**
 * Run Moderation Analysis (Model 1) via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Optional column mapping { outcome, predictor, moderator }
 */
export async function runModerationModel1Test(driver, config = {}) {
  logStep('[UI] Starting Moderation Analysis (Model 1) workflow...')
  if (config.mapping) {
    driver.__moderationMappingOverride = config.mapping
  }
  await runTestById(driver, 'moderation_model1', 'mediation_moderation')
}

/**
 * Run Moderated Mediation (Model 7) via UI
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} config - Optional column mapping { outcome, predictor, mediator, moderator }
 */
export async function runModeratedMediationModel7Test(driver, config = {}) {
  logStep('[UI] Starting Moderated Mediation (Model 7) workflow...')
  if (config.mapping) {
    driver.__moderatedMediationMappingOverride = config.mapping
  }
  await runTestById(driver, 'moderated_mediation_model7', 'mediation_moderation')
}

/**
 * Handle Mediation Analysis dialog
 * @param {object} driver - Selenium WebDriver instance
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleMediationDialog(driver) {
  logStep('[UI] Checking for Mediation dialog...')
  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Mediation Analysis') || text.includes('Configure Mediation')
  })

  if (!hasDialog) {
    logStep('[UI] No Mediation dialog detected')
    driver.__mediationMappingOverride = null
    return false
  }

  logStep('[UI] Mediation dialog detected')
  const mappingOverride = driver.__mediationMappingOverride || { predictor: 'x', mediator: 'm', outcome: 'y' }

  // Select Independent Variable (X)
  logStep('[UI] Selecting predictor (X)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#iv')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.predictor)
  await driver.sleep(400)

  // Select Mediator (M)
  logStep('[UI] Selecting mediator (M)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#mediator')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.mediator)
  await driver.sleep(400)

  // Select Dependent Variable (Y)
  logStep('[UI] Selecting outcome (Y)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#dv')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.outcome)
  await driver.sleep(500)

  // Click Run Analysis button
  logStep('[UI] Clicking Run Analysis...')
  await driver.executeScript(() => {
    const runButton = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('Run Analysis'))
    if (runButton) runButton.click()
  })
  await driver.sleep(500)

  driver.__mediationMappingOverride = null
  logStep('[UI] Mediation dialog handled')
  return true
}

/**
 * Handle Moderation Analysis dialog
 * @param {object} driver - Selenium WebDriver instance
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleModerationDialog(driver) {
  logStep('[UI] Checking for Moderation dialog...')
  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Moderation Analysis') || text.includes('Configure Moderation')
  })

  if (!hasDialog) {
    logStep('[UI] No Moderation dialog detected')
    driver.__moderationMappingOverride = null
    return false
  }

  logStep('[UI] Moderation dialog detected')
  const mappingOverride = driver.__moderationMappingOverride || { predictor: 'x', moderator: 'w', outcome: 'y' }

  // Select Independent Variable (X)
  logStep('[UI] Selecting predictor (X)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#iv')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.predictor)
  await driver.sleep(400)

  // Select Moderator (W)
  logStep('[UI] Selecting moderator (W)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#moderator')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.moderator)
  await driver.sleep(400)

  // Select Dependent Variable (Y)
  logStep('[UI] Selecting outcome (Y)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#dv')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.outcome)
  await driver.sleep(500)

  // Uncheck centering checkboxes (for R baseline parity - R uses raw variables)
  logStep('[UI] Unchecking centering options...')
  await driver.executeScript(() => {
    // Find checkboxes by label text
    const labels = Array.from(document.querySelectorAll('label'))
    const centerXLabel = labels.find(l => l.textContent.includes('Center predictor'))
    const centerWLabel = labels.find(l => l.textContent.includes('Center moderator'))

    // Get the associated checkboxes and uncheck if checked
    if (centerXLabel) {
      const checkbox = centerXLabel.querySelector('input[type="checkbox"]') ||
                      document.querySelector('#center-predictor')
      if (checkbox && checkbox.checked) {
        checkbox.click()
      }
    }

    if (centerWLabel) {
      const checkbox = centerWLabel.querySelector('input[type="checkbox"]') ||
                      document.querySelector('#center-moderator')
      if (checkbox && checkbox.checked) {
        checkbox.click()
      }
    }
  })
  await driver.sleep(500)

  // Click Run Analysis button
  logStep('[UI] Clicking Run Analysis...')
  await driver.executeScript(() => {
    const runButton = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('Run Analysis'))
    if (runButton) runButton.click()
  })
  await driver.sleep(500)

  driver.__moderationMappingOverride = null
  logStep('[UI] Moderation dialog handled')
  return true
}

/**
 * Handle Moderated Mediation dialog
 * @param {object} driver - Selenium WebDriver instance
 * @returns {Promise<boolean>} true if dialog was handled
 */
async function handleModeratedMediationDialog(driver) {
  logStep('[UI] Checking for Moderated Mediation dialog...')
  await driver.sleep(1000)

  const hasDialog = await driver.executeScript(() => {
    const text = document.body.innerText
    return text.includes('Moderated Mediation') || text.includes('Configure Moderated Mediation')
  })

  if (!hasDialog) {
    logStep('[UI] No Moderated Mediation dialog detected')
    driver.__moderatedMediationMappingOverride = null
    return false
  }

  logStep('[UI] Moderated Mediation dialog detected')
  const mappingOverride = driver.__moderatedMediationMappingOverride || { predictor: 'x', mediator: 'm', moderator: 'w', outcome: 'y' }

  // Select Independent Variable (X)
  logStep('[UI] Selecting predictor (X)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#iv')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.predictor)
  await driver.sleep(400)

  // Select Mediator (M)
  logStep('[UI] Selecting mediator (M)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#mediator')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.mediator)
  await driver.sleep(400)

  // Select Moderator (W)
  logStep('[UI] Selecting moderator (W)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#moderator')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.moderator)
  await driver.sleep(400)

  // Select Dependent Variable (Y)
  logStep('[UI] Selecting outcome (Y)...')
  await driver.executeScript(() => {
    const trigger = document.querySelector('#dv')
    if (trigger) trigger.click()
  })
  await driver.sleep(400)

  await driver.executeScript((col) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const opt = options.find(o => o.textContent.toLowerCase().includes(col.toLowerCase()))
    if (opt) opt.click()
  }, mappingOverride.outcome)
  await driver.sleep(500)

  // Uncheck centering checkboxes (for R baseline parity - R uses raw variables)
  logStep('[UI] Unchecking centering options...')
  await driver.executeScript(() => {
    // Find checkboxes by label text
    const labels = Array.from(document.querySelectorAll('label'))
    const centerXLabel = labels.find(l => l.textContent.includes('Center predictor'))
    const centerWLabel = labels.find(l => l.textContent.includes('Center moderator'))

    // Get the associated checkboxes and uncheck if checked
    if (centerXLabel) {
      const checkbox = centerXLabel.querySelector('input[type="checkbox"]') ||
                      document.querySelector('#center-predictor')
      if (checkbox && checkbox.checked) {
        checkbox.click()
      }
    }

    if (centerWLabel) {
      const checkbox = centerWLabel.querySelector('input[type="checkbox"]') ||
                      document.querySelector('#center-moderator')
      if (checkbox && checkbox.checked) {
        checkbox.click()
      }
    }
  })
  await driver.sleep(500)

  // Click Run Analysis button
  logStep('[UI] Clicking Run Analysis...')
  await driver.executeScript(() => {
    const runButton = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('Run Analysis'))
    if (runButton) runButton.click()
  })
  await driver.sleep(500)

  driver.__moderatedMediationMappingOverride = null
  logStep('[UI] Moderated Mediation dialog handled')
  return true
}

/**
 * Generic helper: Wait for results to appear
 * @param {object} driver - Selenium WebDriver instance
 * @param {number} timeout - Maximum wait time in milliseconds (default: 30000)
 */
export async function waitForResults(driver, timeoutOrOptions = 30000) {
  const options = typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null
    ? timeoutOrOptions
    : {}
  const timeout =
    typeof timeoutOrOptions === 'number'
      ? timeoutOrOptions
      : (options.timeout ?? 30000)
  const resultsTabTimeout = options.resultsTabTimeout ?? 10000

  const startTime = Date.now()
  const baseline = driver.__resultsBaseline ?? await getResultsSnapshot(driver)
  const baselineAt = typeof driver.__resultsBaselineAt === 'number'
    ? driver.__resultsBaselineAt
    : startTime
  logStep('[UI] Waiting for results to appear...')

  // First, handle column selection if present (hypothesis testing or categorical)
  if (driver.__categoricalTestType) {
    await handleCategoricalColumnSelection(driver)
  } else {
    await handleColumnSelection(driver)
  }

  if (driver.__dvSelectionOverride) {
    await selectDependentVariable(driver, driver.__dvSelectionOverride)
    driver.__dvSelectionOverride = null
  }

  if (driver.__outcomeEncodingOverride) {
    await selectOutcomeEncoding(driver, driver.__outcomeEncodingOverride)
    driver.__outcomeEncodingOverride = null
  } else {
    // Try to dismiss any encoding dialog that appeared with default selection
    await dismissEncodingDialog(driver)
  }

  if (driver.__factorEncodingOverride) {
    await selectFactorEncoding(driver, driver.__factorEncodingOverride)
    driver.__factorEncodingOverride = null
  }

  // Handle hypothesis testing column mappers
  await handleIndependentTTestColumnMapper(driver)
  await handleMannWhitneyColumnMapper(driver)
  await handlePairedTTestColumnMapper(driver)
  await handleWilcoxonColumnMapper(driver)
  await handleOneWayAnovaColumnMapper(driver)
  await handleKruskalWallisColumnMapper(driver)

  // Handle survival analysis column mappers
  await handleSurvivalColumnMapper(driver)

  // Handle pharmacology-specific column mappers
  const handledDoseResponse = await handleDoseResponseColumnMapper(driver)
  if (!handledDoseResponse) {
    await handleSynergyColumnMapper(driver)
  }
  await handleChiSquareGofColumnMapper(driver)
  await handleChiSquareColumnMapper(driver)
  await handleFisherExactColumnMapper(driver)
  await handleMcNemarColumnMapper(driver)

  // Handle mediation/moderation dialogs
  await handleMediationDialog(driver)
  await handleModerationDialog(driver)
  await handleModeratedMediationDialog(driver)

  // Switch to Results tab so results-table is in DOM
  await switchToResultsTab(driver, resultsTabTimeout)

  // Now wait for results table (fallback to any data-stat cell)
  await driver.wait(async () => {
    const tables = await driver.findElements(By.css('[data-testid="results-table"]'))
    if (tables.length > 0) return true
    const stats = await driver.findElements(By.css('[data-stat]'))
    return stats.length > 0
  }, timeout)

  // Additional wait for results to fully render
  await driver.sleep(1000)

  // Guard: ensure we are still on Results view after render settles
  const resultsVisible = await driver.executeScript(() => {
    return Boolean(
      document.querySelector('[data-testid="results-table"]') ||
      document.querySelector('[data-stat]')
    )
  })
  if (!resultsVisible) {
    logStep('[UI] Results view lost, re-switching to Results tab...')
    await switchToResultsTab(driver)
    await driver.wait(async () => {
      const tables = await driver.findElements(By.css('[data-testid="results-table"]'))
      if (tables.length > 0) return true
      const stats = await driver.findElements(By.css('[data-stat]'))
      return stats.length > 0
    }, timeout)
    await driver.sleep(500)
  }

  logStep('[UI] Results appeared and rendered')

  // Guard against stale results: wait for a new result entry if possible
  if (baseline) {
    await driver.wait(async () => {
      const state = await driver.executeScript((baselineState, baselineTime) => {
        const store = window.useResultsStore?.getState?.()
        if (!store) return { ready: true }

        const activeFamilyId = store.activeStatisticsFamilyId
        const current = store.currentResult
        const currentId = current?.id ?? (activeFamilyId ? store.currentResultIdByFamily?.[activeFamilyId] : null)
        const executedAt = current?.executedAt

        let executedAtMs = null
        if (executedAt) {
          if (executedAt instanceof Date) {
            executedAtMs = executedAt.getTime()
          } else if (typeof executedAt === 'number') {
            executedAtMs = executedAt
          } else if (typeof executedAt === 'string') {
            const parsed = Date.parse(executedAt)
            executedAtMs = Number.isNaN(parsed) ? null : parsed
          }
        }

        const resultsCount = Array.isArray(store.results) ? store.results.length : 0
        const hasNewId = baselineState.currentId
          ? Boolean(currentId && currentId !== baselineState.currentId)
          : Boolean(currentId)
        const hasNewTime = executedAtMs !== null
          ? (baselineState.executedAtMs !== null
            ? executedAtMs > baselineState.executedAtMs
            : executedAtMs >= baselineTime)
          : false
        const hasNewCount = resultsCount > (baselineState.resultsCount ?? 0)

        return { ready: hasNewId || hasNewTime || hasNewCount }
      }, baseline, baselineAt)

      return state.ready
    }, timeout)
  }

  driver.__resultsBaseline = null
  driver.__resultsBaselineAt = null
}
