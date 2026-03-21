/**
 * Custom Assertions for Selenium E2E Tests
 * Simple assertion helpers with clear error messages
 */

/**
 * Assert two values are equal
 */
export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Assertion failed: expected ${expected}, got ${actual}`)
  }
}

/**
 * Assert value is truthy
 */
export function assertTrue(value, message) {
  if (!value) {
    throw new Error(message || `Assertion failed: expected truthy, got ${value}`)
  }
}

/**
 * Assert value is falsy
 */
export function assertFalse(value, message) {
  if (value) {
    throw new Error(message || `Assertion failed: expected falsy, got ${value}`)
  }
}

/**
 * Assert element exists in DOM
 */
export async function assertElementExists(driver, selector, message) {
  const elements = await driver.findElements({ css: selector })
  if (elements.length === 0) {
    throw new Error(message || `Element not found: ${selector}`)
  }
}

/**
 * Assert dataset count matches expected
 */
export async function assertDatasetCount(driver, expected) {
  const count = await driver.executeScript(() => window.__E2E__.getDatasetCount())
  assertEqual(count, expected, `Expected ${expected} dataset(s), got ${count}`)
}

/**
 * Assert element has specific text content
 */
export async function assertElementText(driver, selector, expectedText, message) {
  const element = await driver.findElement({ css: selector })
  const actualText = await element.getText()
  assertEqual(actualText.trim(), expectedText, message || `Expected text "${expectedText}", got "${actualText}"`)
}

/**
 * Assert element is visible
 */
export async function assertElementVisible(driver, selector, message) {
  const element = await driver.findElement({ css: selector })
  const isVisible = await element.isDisplayed()
  assertTrue(isVisible, message || `Element not visible: ${selector}`)
}

/**
 * Assert window.__E2E__ is available
 */
export async function assertE2EShimExists(driver) {
  const shimExists = await driver.executeScript(() => typeof window.__E2E__ === 'object')
  assertTrue(shimExists, 'window.__E2E__ not available. Ensure app was built with VITE_E2E_ENABLED=true')
}

/**
 * Assert close to (for floating point comparisons)
 */
export function assertCloseTo(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected)
  if (diff > tolerance) {
    throw new Error(message || `Assertion failed: expected ${expected} +/- ${tolerance}, got ${actual} (diff: ${diff})`)
  }
}

/**
 * Logging helpers
 */
export function logStep(message) {
  console.log(`[Test] ${message}`)
}

export function logSuccess(message) {
  console.log(`[Test] PASS: ${message}`)
}

export function logFailure(message) {
  console.error(`[Test] FAIL: ${message}`)
}

export function logInfo(message) {
  console.log(`[Test] ${message}`)
}
