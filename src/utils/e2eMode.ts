/**
 * Runtime-safe E2E detection used by startup flows that must not block automation.
 */
export function isE2EEnabled(): boolean {
  const modeFlag = import.meta.env.MODE === 'e2e' || import.meta.env.VITE_E2E_ENABLED === 'true'
  if (modeFlag) return true

  const webdriverFlag = typeof navigator !== 'undefined' && navigator.webdriver === true
  if (webdriverFlag) return true

  const shimAvailable =
    typeof window !== 'undefined' && typeof (window as { __E2E__?: unknown }).__E2E__ === 'object'

  return shimAvailable
}
