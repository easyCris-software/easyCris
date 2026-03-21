/**
 * Selenium WebDriver Setup Utilities
 * Provides session management, cleanup, and state reset for E2E tests
 *
 * FIX 2: Path configuration via config.json + env vars
 * FIX 5: Window size consistency (DPI self-corrects on data load)
 * FIX 6: Cleanup strategy for cross-test isolation
 */

import * as e2e from '@tauri-e2e/selenium'
import { until } from 'selenium-webdriver'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { revokeApprovedDeviceLink } from './device-approval-helper.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const CLEAN_STATE_TIMEOUT_MS = 5000
const CLEAN_STATE_POLL_MS = 100
const WEBDRIVER_READY_TIMEOUT_MS = 10000
const WEBDRIVER_READY_POLL_MS = 100

// Load configuration
const CONFIG_PATH = path.join(PROJECT_ROOT, 'e2e/config.json')
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))

/**
 * FIX 2: Resolve paths with environment variable substitution
 */
function resolvePath(pathTemplate, fallback) {
  // Check if env var is set
  const envVarMatch = pathTemplate.match(/\$\{([^}]+)\}/)
  if (envVarMatch) {
    const envVar = envVarMatch[1]
    const envValue = process.env[envVar]
    if (envValue) {
      console.log(`[Setup] Using ${envVar}: ${envValue}`)
      return envValue
    }
  }

  // Use fallback (relative to project root)
  const fallbackPath = path.resolve(PROJECT_ROOT, fallback)
  console.log(`[Setup] Using fallback path: ${fallbackPath}`)
  return fallbackPath
}

function normalizeResetOptions(options = {}) {
  return {
    resetAuth: options.resetAuth === true,
    clearFingerprint: options.clearFingerprint !== false,
    showWelcome: options.showWelcome === true,
    skipAuthReset: options.skipAuthReset === true,
  }
}

async function waitForWebDriverReady(timeoutMs = WEBDRIVER_READY_TIMEOUT_MS) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch('http://127.0.0.1:4674/status')
      if (response.ok) {
        return
      }
      lastError = new Error(`WebDriver status returned ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, WEBDRIVER_READY_POLL_MS))
  }

  throw new Error(
    `Timed out waiting for WebDriver to become ready at http://127.0.0.1:4674/status${
      lastError ? `: ${lastError.message}` : ''
    }`
  )
}

/**
 * Setup Selenium WebDriver session for Tauri app
 * @param {object} options - Setup options
 * @returns {Promise<{driver: object, webdriver: object}>}
 */
export async function setupTest(options = {}) {
  console.log('[Setup] Starting Selenium WebDriver session...')
  const expectShim = process.env.E2E_EXPECT_SHIM === '1'

  if (expectShim && !process.env.E2E_APP_PATH) {
    throw new Error('E2E_EXPECT_SHIM=1 requires E2E_APP_PATH to point to an e2e-mode binary')
  }

  // FIX 2: Resolve app and driver paths
  const appPath = resolvePath(config.app.binary, config.app.binaryFallback)
  const driverPath = resolvePath(config.webdriver.binary, config.webdriver.binaryFallback)

  // Validate paths exist
  if (!fs.existsSync(appPath)) {
    throw new Error(`App binary not found: ${appPath}`)
  }
  if (!fs.existsSync(driverPath)) {
    throw new Error(`WebDriver binary not found: ${driverPath}`)
  }

  // Set environment variables for @tauri-e2e/selenium
  process.env.TAURI_SELENIUM_BINARY = appPath
  process.env.TAURI_WEBDRIVER_BINARY = driverPath
  process.env.SELENIUM_REMOTE_URL = 'http://127.0.0.1:4674'

  console.log(`[Setup] App: ${appPath}`)
  console.log(`[Setup] Driver: ${driverPath}`)
  console.log(`[Setup] Shim mode: ${expectShim ? 'e2e expected' : 'release forbidden'}`)

  // Spawn WebDriver process
  const webdriver = await e2e.launch.spawnWebDriver({ setupExitHandlers: false })
  await waitForWebDriverReady()

  // Create WebDriver session
  const driver = await new e2e.selenium.Builder().build()

  // FIX 5: Set consistent window size (DPI self-corrects on data load)
  await driver.manage().window().setRect({
    width: config.window.width,
    height: config.window.height,
    x: 0,
    y: 0
  })

  console.log(`[Setup] Window size: ${config.window.width}x${config.window.height}`)

  // Wait for app to load (look for body element)
  await driver.wait(until.elementLocated({ css: 'body' }), config.timeouts.appLoad)
  console.log('[Setup] App loaded')

  // Wait a bit more for full initialization
  await new Promise(resolve => setTimeout(resolve, 1000))

  // FIX 6: Reset state BEFORE test
  await resetAppState(driver, options)

  console.log('[Setup] Session ready')

  return { driver, webdriver }
}

/**
 * FIX 6: Reset app to clean state
 * Prevents cross-test contamination
 * @param {object} driver - Selenium WebDriver instance
 */
export async function resetAppState(driver, options = {}) {
  console.log('[Cleanup] Resetting app state...')
  const resetOptions = normalizeResetOptions(options)

  try {
    // 1. Clear all state via E2E API (single source of truth)
    await driver.executeScript(({ resetAuth, clearFingerprint, showWelcome, skipAuthReset }) => {
      if (!window.__E2E__) {
        throw new Error('window.__E2E__ is unavailable in resetAppState')
      }
      return window.__E2E__.clearAllData().then(async () => {
        if (!resetAuth || skipAuthReset) {
          return
        }
        await window.__E2E__.clearDeviceAuthState({
          clearFingerprint,
          showWelcome,
        })
      })
    }, resetOptions)

    // 2. Deterministically wait for clean state instead of fixed sleep.
    const startedAt = Date.now()
    let datasetCount = -1
    while (Date.now() - startedAt <= CLEAN_STATE_TIMEOUT_MS) {
      datasetCount = await driver.executeScript(() => window.__E2E__?.getDatasetCount?.() || 0)
      if (datasetCount === 0) {
        break
      }
      await driver.sleep(CLEAN_STATE_POLL_MS)
    }

    if (datasetCount !== 0) {
      const diagnostics = await driver.executeScript(() => ({
        datasetCount: window.__E2E__?.getDatasetCount?.() ?? null,
        familyState: window.__E2E__?.getFamilyState?.() ?? null,
      }))
      throw new Error(
        `Reset did not reach clean state within ${CLEAN_STATE_TIMEOUT_MS}ms: ${JSON.stringify(diagnostics)}`
      )
    }

    console.log('[Cleanup] App state reset complete')
  } catch (error) {
    console.warn('[Cleanup] Reset warning:', error.message)
  }
}

/**
 * Verify app is in clean state (call at test start)
 * @param {object} driver - Selenium WebDriver instance
 * @throws {Error} If app not in clean state
 */
export async function verifyCleanState(driver) {
  const diagnostics = await driver.executeScript(() => ({
    datasetCount: window.__E2E__?.getDatasetCount?.() || 0,
    familyState: window.__E2E__?.getFamilyState?.() || null,
  }))
  const datasetCount = diagnostics.datasetCount

  if (datasetCount !== 0) {
    throw new Error(`App not in clean state: ${datasetCount} dataset(s) still loaded; diagnostics=${JSON.stringify(diagnostics.familyState)}`)
  }

  console.log('[Verify] App in clean state')
}

/**
 * Cleanup WebDriver session
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} webdriver - WebDriver process handle
 */
export async function cleanupTest(driver, webdriver, options = {}) {
  console.log('[Cleanup] Cleaning up WebDriver session...')

  try {
    if (options.approvedDeviceLink?.deviceId) {
      await revokeApprovedDeviceLink(options.approvedDeviceLink)
    }
  } catch (error) {
    console.warn('[Cleanup] Backend device cleanup warning:', error.message)
  }

  try {
    // FIX 6: Reset state AFTER test
    await resetAppState(driver, options)
  } catch (error) {
    console.warn('[Cleanup] State reset warning:', error.message)
  }

  try {
    await e2e.selenium.cleanupSession(driver)
  } catch (error) {
    console.warn('[Cleanup] Driver cleanup warning:', error.message)
  }

  try {
    e2e.launch.killWebDriver(webdriver)
  } catch (error) {
    console.warn('[Cleanup] WebDriver kill warning:', error.message)
  }

  console.log('[Cleanup] Session cleanup complete')
}

/**
 * Get configuration
 * @returns {object} Configuration object
 */
export function getConfig() {
  return config
}
