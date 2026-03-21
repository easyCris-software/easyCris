/**
 * Plot Workflow Helpers
 * UI automation for creating plots via "From Data" tab
 */

import { By, Key, until } from 'selenium-webdriver'
import { waitForPlot as waitForPlotRender } from './plot-validation.mjs'

async function isCreatePlotDialogOpen(driver) {
  const dialogs = await driver.findElements(
    By.xpath('//div[@role="dialog"]//h2[normalize-space()="Create New Plot"]')
  )
  return dialogs.length > 0
}

async function dismissBlockingDialog(driver) {
  const overlay = await driver.findElements(
    By.css('[data-slot="dialog-overlay"][data-state="open"]')
  )
  if (overlay.length === 0) return

  if (await isCreatePlotDialogOpen(driver)) {
    return
  }

  const cancelButtons = await driver.findElements(
    By.xpath('//div[@role="dialog"]//button[normalize-space()="Cancel" or normalize-space()="Close"]')
  )

  if (cancelButtons.length > 0) {
    await cancelButtons[0].click()
  } else {
    const body = await driver.findElement(By.css('body'))
    await body.sendKeys(Key.ESCAPE)
  }

  await driver.wait(async () => {
    const openOverlays = await driver.findElements(
      By.css('[data-slot="dialog-overlay"][data-state="open"]')
    )
    return openOverlays.length === 0
  }, 5000).catch(() => {})
}

/**
 * Navigate to Plots panel
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
export async function navigateToPlotsPanel(driver) {
  console.log('[Plot Workflow] Navigating to Plots panel...')

  // Click Plots view in navigator tree
  const plotsTab = await driver.wait(
    until.elementLocated(By.xpath('//button[.//span[normalize-space()="Plots"]]')),
    5000,
    'Plots tab not found'
  )
  await plotsTab.click()

  // Wait for plots panel to be visible
  await driver.wait(
    until.elementLocated(By.css('[data-testid="plots-panel"]')),
    5000,
    'Plots panel not visible'
  )

  console.log('[Plot Workflow] Plots panel visible')
}

/**
 * Open the Create Plot dialog
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
export async function openCreatePlotDialog(driver) {
  console.log('[Plot Workflow] Opening Create Plot dialog...')

  // First ensure we're on plots panel
  await navigateToPlotsPanel(driver)

  if (await isCreatePlotDialogOpen(driver)) {
    console.log('[Plot Workflow] Create Plot dialog already open')
    return
  }

  await dismissBlockingDialog(driver)
  await driver.wait(async () => {
    const overlays = await driver.findElements(
      By.css('[data-slot="dialog-overlay"][data-state="open"]')
    )
    return overlays.length === 0
  }, 10000)

  const createButtons = await driver.findElements(
    By.xpath('//div[@data-testid="plots-panel"]//button[normalize-space()="Create Plot"]')
  )

  let createButton
  if (createButtons.length > 0) {
    createButton = createButtons[0]
  } else {
    createButton = await driver.wait(
      until.elementLocated(
        By.xpath('//h3[normalize-space()="Plot Gallery"]/ancestor::div[1]//button')
      ),
      5000,
      'Create Plot button not found'
    )
  }

  await createButton.click()

  // Wait for dialog to open (shadcn Dialog)
  await driver.wait(
    until.elementLocated(By.xpath('//div[@role="dialog"]//h2[normalize-space()="Create New Plot"]')),
    5000,
    'Create Plot dialog did not open'
  )

  console.log('[Plot Workflow] Create Plot dialog opened')
}

/**
 * Ensure "From Data" mode is selected (default mode)
 * @param {WebDriver} driver - Selenium WebDriver instance
 *
 * NOTE: "From Data" is the default (plotSource = 'user_derived').
 * This function only clicks the button if "From Test Results" is currently active.
 */
export async function ensureFromDataMode(driver) {
  console.log('[Plot Workflow] Ensuring "From Data" mode...')

  // Check if "From Data" button exists and click if needed
  const fromDataButtons = await driver.findElements(By.xpath('//button[contains(text(), "From Data")]'))

  if (fromDataButtons.length > 0) {
    // Check if button is already active (may have aria-pressed="true" or active class)
    const isActive = await fromDataButtons[0].getAttribute('aria-pressed')

    if (isActive !== 'true') {
      console.log('[Plot Workflow] Switching to "From Data" mode...')
      await fromDataButtons[0].click()
      await driver.sleep(200)
    } else {
      console.log('[Plot Workflow] Already in "From Data" mode')
    }
  } else {
    // Default mode - no action needed
    console.log('[Plot Workflow] "From Data" is default mode')
  }
}

/**
 * Select plot type from the plot type selector (button grid)
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} plotType - Plot type (e.g., 'scatter', 'line', 'bar', 'histogram')
 */
export async function selectPlotType(driver, plotType) {
  console.log(`[Plot Workflow] Selecting plot type: ${plotType}...`)

  let plotTypeButton
  const selectors = [
    `button[data-plot-type="${plotType}"]`,
    `[data-plot-type="${plotType}"][role="button"]`
  ]

  for (const selector of selectors) {
    try {
      const candidate = await driver.wait(
        until.elementLocated(By.css(selector)),
        2000
      )
      await driver.wait(until.elementIsVisible(candidate), 2000)
      plotTypeButton = candidate
      console.log(`[Plot Workflow] Found plot type element via selector: ${selector}`)
      break
    } catch (error) {
      // Try next selector
    }
  }

  if (!plotTypeButton) {
    // Fallback: Find button by display name (case-insensitive)
    console.warn(`[Plot Workflow] data-plot-type selector not found, falling back to text match`)

    const plotTypeDisplayNames = {
      'scatter': 'Scatter Plot',
      'scattergl': 'Scatter Plot (Large Dataset)',
      'line': 'Line Chart',
      'histogram': 'Histogram',
      'box': 'Box Plot',
      'violin': 'Violin Plot',
      'bar': 'Bar Chart',
      'grouped_bar': 'Grouped Bar Chart',
      'stacked_bar': 'Stacked Bar Chart',
      'pie': 'Pie Chart'
    }

    const displayName = plotTypeDisplayNames[plotType] || plotType

    plotTypeButton = await driver.wait(
      until.elementLocated(
        By.xpath(`//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${displayName.toLowerCase()}")]`)
      ),
      5000,
      `Plot type button "${displayName}" not found`
    )
  }

  await plotTypeButton.click()
  await driver.sleep(200) // Selection processing

  console.log(`[Plot Workflow] Plot type "${plotType}" selected`)
}

/**
 * Assign a column to a role (x, y, group, color, etc.)
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} labelText - Column label (e.g., 'X Variable', 'Category')
 * @param {string} columnName - Column name to assign
 */
export async function assignColumn(driver, labelText, columnName) {
  console.log(`[Plot Workflow] Assigning column "${columnName}" to "${labelText}"...`)

  // ColumnRoleDropdown uses shadcn Select (Radix UI)
  // Structure: Label + SelectTrigger -> SelectContent -> SelectItem

  // Find the Select trigger button near the label
  const selectTrigger = await driver.wait(async () => {
    // Find label with role text
    const labels = await driver.findElements(By.xpath(`//label[contains(text(), "${labelText}")]`))
    if (labels.length === 0) return null

    // Find the Select trigger button (usually next sibling or within same container)
    const parent = await labels[0].findElement(By.xpath('..'))
    const buttons = await parent.findElements(By.css('button[role="combobox"]'))

    return buttons.length > 0 ? buttons[0] : null
  }, 5000, `Select trigger for "${labelText}" not found`)

  // Click to open dropdown
  await selectTrigger.click()
  await driver.sleep(300) // Wait for dropdown animation

  // Wait for SelectContent to appear
  await driver.wait(
    until.elementLocated(By.css('[role="listbox"]')),
    5000,
    'Select dropdown did not open'
  )

  // Find and click the column option
  const columnOption = await driver.wait(
    until.elementLocated(
      By.xpath(
        `//div[@role="option"]//span[contains(text(), "${columnName}")]/ancestor::div[@role="option"]`
      )
    ),
    5000,
    `Column "${columnName}" not found in "${labelText}" selector`
  )
  await columnOption.click()

  await driver.sleep(200) // Selection processing

  console.log(`[Plot Workflow] Column "${columnName}" assigned to "${labelText}"`)
}

/**
 * Set plot title
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} title - Plot title
 */
export async function setPlotTitle(driver, title) {
  console.log(`[Plot Workflow] Setting plot title: "${title}"...`)

  const titleInput = await driver.wait(
    until.elementLocated(By.css('#plot-title')),
    5000,
    'Plot title input not found'
  )

  await titleInput.clear()
  await titleInput.sendKeys(title)

  console.log(`[Plot Workflow] Plot title set to "${title}"`)
}

/**
 * Click the "Create Plot" button to generate the plot
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
export async function clickCreatePlot(driver) {
  console.log('[Plot Workflow] Clicking "Create Plot" button...')

  // Find "Create Plot" button in DialogFooter (NOT "Cancel")
  // Must be INSIDE the dialog to avoid clicking plot gallery button
  const createButton = await driver.wait(
    until.elementLocated(
      By.xpath('//div[@role="dialog"]//button[contains(text(), "Create Plot") and not(contains(text(), "Cancel"))]')
    ),
    5000,
    'Create Plot submit button not found in dialog'
  )

  // Use JavaScript click to bypass overlay interception
  await driver.executeScript('arguments[0].click();', createButton)

  // Wait for dialog to close
  await driver.wait(
    until.stalenessOf(createButton),
    5000,
    'Create Plot dialog did not close'
  )

  await driver.wait(async () => {
    const overlays = await driver.findElements(
      By.css('[data-slot="dialog-overlay"][data-state="open"]')
    )
    return overlays.length === 0
  }, 5000).catch(() => {})

  console.log('[Plot Workflow] Plot creation initiated')
}

/**
 * Complete workflow: Create a plot from data
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {object} options - Plot configuration
 * @param {string} options.plotType - Plot type (required)
 * @param {object} options.columns - Column assignments { x: 'colName', y: 'colName', ... }
 * @param {string} [options.title] - Plot title (optional)
 * @param {string} [options.colorBy] - Column for color grouping (optional)
 */
export async function createPlotFromData(driver, options) {
  const { plotType, columns, title, colorBy } = options

  console.log(`[Plot Workflow] Creating ${plotType} plot...`)

  // Step 1: Open dialog
  await openCreatePlotDialog(driver)

  // Step 2: Ensure "From Data" mode (default mode)
  await ensureFromDataMode(driver)

  // Step 3: Select plot type
  await selectPlotType(driver, plotType)

  // Step 4: Assign columns
  const roleLabelMap = {
    scatter: { x: 'X Variable', y: 'Y Variable', color: 'Color By', size: 'Size By' },
    scattergl: { x: 'X Variable', y: 'Y Variable', color: 'Color By' },
    line: { x: 'X Variable', y: 'Y Variable', group: 'Color By (Category)' },
    histogram: { x: 'Variable', group: 'Split By' },
    bar: { x: 'Category', y: 'Value', color: 'Stack By' },
    grouped_bar: { x: 'Category', y: 'Value', group: 'Group' },
    stacked_bar: { x: 'Category', y: 'Value', color: 'Stack By' },
    box: { y: 'Value', group: 'Group', color: 'Color By' },
    violin: { y: 'Value', group: 'Group' },
    pie: { theta: 'Value', color: 'Category' },
  }
  for (const [role, columnName] of Object.entries(columns)) {
    const label = roleLabelMap[plotType]?.[role] ?? role
    await assignColumn(driver, label, columnName)
  }

  // Step 5: Set title (optional)
  if (title) {
    await setPlotTitle(driver, title)
  }

  // Step 6: Set color grouping (optional)
  if (colorBy) {
    const label = roleLabelMap[plotType]?.color ?? 'Color By'
    await assignColumn(driver, label, colorBy)
  }

  // Step 7: Create plot
  await clickCreatePlot(driver)

  console.log(`[Plot Workflow] ${plotType} plot created`)
}

export const waitForPlot = waitForPlotRender

/**
 * Toggle trendline on/off
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {boolean} enabled - True to enable, false to disable
 */
export async function toggleTrendline(driver, enabled) {
  console.log(`[Plot Workflow] ${enabled ? 'Enabling' : 'Disabling'} trendline...`)

  // Navigate to Axes tab in Plot Sidebar (trendline controls are there)
  const axesTab = await driver.wait(
    until.elementLocated(By.xpath('//button[.//span[normalize-space()="Axes"]]')),
    5000,
    'Axes tab not found in Plot Sidebar'
  )
  await axesTab.click()

  // Wait for trendline toggle switch
  const trendlineSwitch = await driver.wait(
    until.elementLocated(By.xpath('//span[normalize-space()="Show trendline"]/preceding-sibling::button[@role="switch"]')),
    5000,
    'Trendline toggle switch not found'
  )

  // Check current state
  const ariaChecked = await trendlineSwitch.getAttribute('data-state')
  const isCurrentlyEnabled = ariaChecked === 'checked'

  if (isCurrentlyEnabled !== enabled) {
    await trendlineSwitch.click()
    // Wait for trendline computation (might take a moment)
    await driver.sleep(500)
    await driver.wait(async () => {
      return await driver.executeScript((isEnabled) => {
        const node = document.querySelector('[data-plot-stats]')
        if (!node) return false
        const type = node.getAttribute('data-trendline-type')
        return isEnabled ? Boolean(type) : !type
      }, enabled)
    }, 10000, 'Trendline stats not updated')
    console.log(`[Plot Workflow] Trendline ${enabled ? 'enabled' : 'disabled'}`)
  } else {
    console.log(`[Plot Workflow] Trendline already ${enabled ? 'enabled' : 'disabled'}`)
  }
}

/**
 * Change trendline type (linear or polynomial)
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} type - 'linear' or 'polynomial'
 */
export async function changeTrendlineType(driver, type) {
  console.log(`[Plot Workflow] Changing trendline type to: ${type}`)

  // Ensure Axes tab is active
  const axesTab = await driver.wait(
    until.elementLocated(By.xpath('//button[.//span[normalize-space()="Axes"]]')),
    5000
  )
  await axesTab.click()

  // Click Type dropdown
  const typeDropdown = await driver.wait(
    until.elementLocated(By.xpath('//label[normalize-space()="Type"]/following-sibling::button')),
    5000,
    'Trendline type dropdown not found'
  )
  await typeDropdown.click()

  // Select type from dropdown (capitalize first letter for UI match)
  const typeValue = type.charAt(0).toUpperCase() + type.slice(1)
  const typeOption = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role="option"][normalize-space()="${typeValue}"]`)),
    3000,
    `Trendline type option "${typeValue}" not found`
  )
  await typeOption.click()

  // Wait for trendline recomputation
  await driver.wait(async () => {
    return await driver.executeScript((expectedType) => {
      const node = document.querySelector('[data-plot-stats]')
      if (!node) return false
      return node.getAttribute('data-trendline-type') === expectedType
    }, type)
  }, 10000, `Trendline type did not update to ${type}`)
  await driver.sleep(200)
  console.log(`[Plot Workflow] Trendline type changed to ${type}`)
}

/**
 * Change polynomial degree (only works when type is 'polynomial')
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {number} degree - Polynomial degree (2-5)
 */
export async function changeTrendlineDegree(driver, degree) {
  console.log(`[Plot Workflow] Changing polynomial degree to: ${degree}`)

  // Ensure Axes tab is active
  const axesTab = await driver.wait(
    until.elementLocated(By.xpath('//button[.//span[normalize-space()="Axes"]]')),
    5000
  )
  await axesTab.click()

  // Click Degree dropdown
  const degreeDropdown = await driver.wait(
    until.elementLocated(By.xpath('//label[normalize-space()="Degree"]/following-sibling::button')),
    5000,
    'Trendline degree dropdown not found'
  )
  await degreeDropdown.click()

  // Select degree from dropdown
  const degreeOption = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role="option"][normalize-space()="${degree}"]`)),
    3000,
    `Degree option "${degree}" not found`
  )
  await degreeOption.click()

  // Wait for trendline recomputation
  await driver.sleep(800)
  console.log(`[Plot Workflow] Polynomial degree changed to ${degree}`)
}

export default {
  navigateToPlotsPanel,
  openCreatePlotDialog,
  ensureFromDataMode,
  selectPlotType,
  assignColumn,
  setPlotTitle,
  clickCreatePlot,
  createPlotFromData,
  waitForPlot: waitForPlotRender,
  toggleTrendline,
  changeTrendlineType,
  changeTrendlineDegree,
}
