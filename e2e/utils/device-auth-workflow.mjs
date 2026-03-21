import { By, until } from 'selenium-webdriver'
import { approveDeviceLinkByUserCode } from './device-approval-helper.mjs'
import { cleanupTest, setupTest } from './selenium-setup.mjs'

const DEFAULT_TIMEOUT_MS = 10_000
const PAIRING_TIMEOUT_MS = 20_000
const WELCOME_TIMEOUT_MS = 15_000
const LINKED_TIMEOUT_MS = 30_000
const UI_POLL_INTERVAL_MS = 1_000

function extractUserCodeFromText(text) {
  const compact = text.replace(/\s+/g, '').trim().toUpperCase()
  const sectionMatch = compact.match(/PAIRINGCODE([A-Z0-9-]{8,12})/)
  const candidate = sectionMatch?.[1] ?? compact
  const match = candidate.match(/[A-Z0-9]{4}-?[A-Z0-9]{4}/)
  if (!match) {
    return null
  }

  const normalized = match[0].replace(/-/g, '')
  if (normalized.length !== 8) {
    return null
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

export async function clickVisibleText(driver, text, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await clickVisibleTextMatch(driver, text, { timeoutMs, match: 'exact' })
}

export async function clickVisibleTextContains(driver, text, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await clickVisibleTextMatch(driver, text, { timeoutMs, match: 'contains' })
}

async function clickVisibleTextMatch(
  driver,
  text,
  { timeoutMs = DEFAULT_TIMEOUT_MS, match = 'exact' } = {}
) {
  await driver.wait(async () => {
    return driver.executeScript((label, strategy) => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }

      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], [role="menuitem"]')
      )

      const match = candidates.find((element) => {
        const normalized = element.textContent?.replace(/\s+/g, ' ').trim()
        if (!normalized || !isVisible(element)) return false
        if (strategy === 'contains') {
          return normalized.includes(label)
        }
        return normalized === label
      })

      if (!(match instanceof HTMLElement)) {
        return false
      }

      match.click()
      return true
    }, text, match)
  }, timeoutMs, `Timed out clicking visible text "${text}" using ${match} match`)
}

async function waitForDialogTitle(driver, text, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await driver.wait(async () => {
    return driver.executeScript((label) => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      return dialogs.some((dialog) => dialog.textContent?.includes(label))
    }, text)
  }, timeoutMs, `Timed out waiting for dialog text "${text}"`)
}

async function isWelcomeScreenVisible(driver) {
  return driver.executeScript(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    return dialogs.some((dialog) => {
      const text = dialog.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      return text.includes("Let's Get Started") && text.includes('Continue as guest')
    })
  })
}

async function dismissWelcomeToGuest(driver, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const welcomeVisible = await isWelcomeScreenVisible(driver)
  if (!welcomeVisible) {
    return
  }

  await clickVisibleTextContains(driver, 'Continue as guest', timeoutMs)
  await driver.wait(async () => {
    return driver.executeScript(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      const welcomeStillVisible = dialogs.some((dialog) => {
        const text = dialog.textContent?.replace(/\s+/g, ' ').trim() ?? ''
        return text.includes("Let's Get Started") && text.includes('Continue as guest')
      })
      if (welcomeStillVisible) {
        return false
      }
      const snapshot = window.__E2E__?.getDeviceAuthSnapshot?.() ?? null
      return snapshot?.mode === 'guest' && snapshot.sessionTokenPresent === false
    })
  }, timeoutMs, 'Timed out dismissing the welcome screen into guest mode')
}

async function forceWelcomeScreen(driver) {
  await driver.executeScript(() => {
    if (!window.__E2E__) {
      throw new Error('window.__E2E__ is unavailable while forcing first-launch state')
    }
    window.__E2E__.setFirstLaunchState(true)
    window.location.reload()
  })

  await driver.wait(until.elementLocated(By.css('body')), DEFAULT_TIMEOUT_MS)
  await driver.wait(async () => isWelcomeScreenVisible(driver), WELCOME_TIMEOUT_MS)
}

export async function openFirstLaunchLinkFlow(driver) {
  const welcomeVisible = await isWelcomeScreenVisible(driver)
  if (!welcomeVisible) {
    await forceWelcomeScreen(driver)
  }

  await clickVisibleTextContains(driver, 'Link this device')
  await waitForDialogTitle(driver, 'Link this device')
}

export async function openPreferencesAccountPane(driver) {
  await dismissWelcomeToGuest(driver)
  const fileMenuTrigger = await driver.wait(
    until.elementLocated(By.xpath("//button[normalize-space()='File']")),
    DEFAULT_TIMEOUT_MS,
    'Timed out waiting for the File menu trigger'
  )
  await driver.wait(until.elementIsVisible(fileMenuTrigger), DEFAULT_TIMEOUT_MS)
  await fileMenuTrigger.click()

  const preferencesMenuItem = await driver.wait(
    until.elementLocated(
      By.xpath(
        "//*[@role='menuitem' and contains(normalize-space(), 'Preferences...')]"
      )
    ),
    DEFAULT_TIMEOUT_MS,
    'Timed out waiting for the Preferences menu item'
  )
  await driver.wait(until.elementIsVisible(preferencesMenuItem), DEFAULT_TIMEOUT_MS)
  await preferencesMenuItem.click()
  await driver.wait(
    until.elementLocated(By.xpath("//*[normalize-space()='Preferences']")),
    DEFAULT_TIMEOUT_MS,
    'Timed out waiting for the Preferences dialog'
  )
  await driver.wait(until.elementLocated(By.xpath("//*[normalize-space()='Account']")), DEFAULT_TIMEOUT_MS)
}

export async function openPreferencesAccountLinkFlow(driver) {
  await openPreferencesAccountPane(driver)
  await clickVisibleText(driver, 'Link this device')
  await waitForDialogTitle(driver, 'Link this device')
}

export async function waitForPairingCode(driver, timeoutMs = PAIRING_TIMEOUT_MS) {
  const startedAt = Date.now()
  let lastDialogText = null
  let lastSnapshot = null

  while (Date.now() - startedAt <= timeoutMs) {
    const diagnostics = await driver.executeScript(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      const dialogText =
        dialogs.find((dialog) => {
          const text = dialog.textContent ?? ''
          return text.includes('Link this device') && text.includes('Pairing code')
        })?.textContent ??
        null

      const snapshot = window.__E2E__?.getDeviceAuthSnapshot?.() ?? null
      return {
        dialogText,
        snapshot,
      }
    })

    lastDialogText = diagnostics?.dialogText ?? null
    lastSnapshot = diagnostics?.snapshot ?? null

    if (typeof lastDialogText === 'string') {
      const normalized = lastDialogText.replace(/\s+/g, ' ').trim()
      if (!normalized.includes('Loading') && !normalized.includes('--------')) {
        const code = extractUserCodeFromText(normalized)
        if (code) {
          return code
        }
      }
    }

    await driver.sleep(UI_POLL_INTERVAL_MS)
  }

  throw new Error(
    `Timed out waiting for a pairing code to appear. Last snapshot=${JSON.stringify(lastSnapshot)} dialog=${JSON.stringify(lastDialogText)}`
  )
}

export async function readPairingCode(driver) {
  const text = await driver.executeScript(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    const dialog = dialogs.find((entry) => {
      const textContent = entry.textContent ?? ''
      return textContent.includes('Link this device') && textContent.includes('Pairing code')
    })
    return dialog?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  })

  const code = text ? extractUserCodeFromText(text) : null
  if (!code) {
    throw new Error('Pairing code is not readable from the link dialog.')
  }

  return code
}

export async function waitForLinkedState(driver, timeoutMs = LINKED_TIMEOUT_MS) {
  const userCode = await readPairingCode(driver)
  const approval = await approveDeviceLinkByUserCode(userCode)

  let lastSnapshot = null
  let lastDialogText = null

  await driver.wait(async () => {
    const diagnostics = await driver.executeScript(() => {
      const snapshot = window.__E2E__?.getDeviceAuthSnapshot?.() ?? null
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      const dialogText =
        dialogs.find((dialog) => {
          const text = dialog.textContent ?? ''
          return text.includes('Link this device') && text.includes('Pairing code')
        })?.textContent ??
        null

      return {
        snapshot,
        dialogText,
      }
    })

    lastSnapshot = diagnostics?.snapshot ?? null
    lastDialogText = diagnostics?.dialogText ?? null

    return Boolean(
      lastSnapshot &&
        lastSnapshot.mode === 'linked' &&
        lastSnapshot.sessionTokenPresent === true
    )
  }, timeoutMs, () => {
    return `Timed out waiting for linked desktop state. Last snapshot=${JSON.stringify(lastSnapshot)} dialog=${JSON.stringify(lastDialogText)}`
  })

  return approval
}

export async function assertGuestState(driver, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastSnapshot = null
  let lastBodyHasGuestMode = false

  await driver.wait(async () => {
    const diagnostics = await driver.executeScript(() => {
      const snapshot = window.__E2E__?.getDeviceAuthSnapshot?.() ?? null
      const bodyHasGuestMode = document.body.textContent?.includes('Guest mode') ?? false
      return {
        snapshot,
        bodyHasGuestMode,
      }
    })

    lastSnapshot = diagnostics?.snapshot ?? null
    lastBodyHasGuestMode = diagnostics?.bodyHasGuestMode === true

    return Boolean(
      lastSnapshot &&
        lastSnapshot.mode === 'guest' &&
        lastSnapshot.sessionTokenPresent === false
    )
  }, timeoutMs, () => {
    return `Timed out waiting for guest device auth state. Last snapshot=${JSON.stringify(lastSnapshot)} bodyHasGuestMode=${lastBodyHasGuestMode}`
  })
}

export async function assertLinkedState(driver, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await driver.wait(async () => {
    return driver.executeScript(() => {
      const snapshot = window.__E2E__?.getDeviceAuthSnapshot?.() ?? null
      return snapshot?.mode === 'linked' && snapshot.sessionTokenPresent === true
    })
  }, timeoutMs, 'Timed out waiting for linked device auth state')
}

export async function assertInvalidState(driver, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await driver.wait(async () => {
    return driver.executeScript(() => {
      const snapshot = window.__E2E__?.getDeviceAuthSnapshot?.() ?? null
      return snapshot?.mode === 'invalid' && snapshot.sessionTokenPresent === false
    })
  }, timeoutMs, 'Timed out waiting for invalid device auth state')
}

export async function assertWelcomeGuestEntry(driver, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const welcomeVisible = await isWelcomeScreenVisible(driver)
  if (!welcomeVisible) {
    await forceWelcomeScreen(driver)
  }

  await driver.wait(async () => isWelcomeScreenVisible(driver), timeoutMs, 'Timed out waiting for first-launch guest entry UI')
}

export async function relaunchPreservingAuthState(
  driver,
  webdriver,
  options = {}
) {
  await cleanupTest(driver, webdriver, {
    resetAuth: true,
    skipAuthReset: true,
    showWelcome: false,
    ...options,
  })

  return await setupTest({
    resetAuth: true,
    skipAuthReset: true,
    showWelcome: false,
  })
}
