import { clearDeviceAuthSession, loadDeviceFingerprint } from '@/services/deviceAuthStorage'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'

const DEVICE_AUTH_FINGERPRINT_KEY = 'easycris.device_auth.fingerprint'
const DEVICE_AUTH_SESSION_METADATA_KEY = 'easycris.device_auth.session_metadata'
const FIRST_LAUNCH_KEY = 'hasSeenWelcome'
export const E2E_FORCE_FIRST_LAUNCH_KEY = 'easycris.e2e.force_first_launch'

export interface E2EDeviceAuthSnapshot {
  mode: ReturnType<typeof useDeviceAuthStore.getState>['mode']
  deviceFingerprint: string | null
  linkDialogOpen: boolean
  linkedEmail: string | null
  tier: ReturnType<typeof useDeviceAuthStore.getState>['tier']
  deviceId: string | null
  invalidReason: string | null
  deviceCode: string | null
  userCode: string | null
  verificationUri: string | null
  pollIntervalSeconds: number | null
  pairingExpiresAt: string | null
  pairingError: string | null
  sessionTokenPresent: boolean
  hasSeenWelcome: boolean
}

interface ClearDeviceAuthStateOptions {
  clearFingerprint?: boolean
  showWelcome?: boolean
}

export function setFirstLaunchState(showWelcome: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  if (showWelcome) {
    window.localStorage.setItem(E2E_FORCE_FIRST_LAUNCH_KEY, 'true')
    window.localStorage.removeItem(FIRST_LAUNCH_KEY)
    return
  }

  window.localStorage.removeItem(E2E_FORCE_FIRST_LAUNCH_KEY)
  window.localStorage.setItem(FIRST_LAUNCH_KEY, 'true')
}

export function getDeviceAuthSnapshot(): E2EDeviceAuthSnapshot {
  const state = useDeviceAuthStore.getState()

  return {
    mode: state.mode,
    deviceFingerprint: loadDeviceFingerprint(),
    linkDialogOpen: state.linkDialogOpen,
    linkedEmail: state.linkedEmail,
    tier: state.tier,
    deviceId: state.deviceId,
    invalidReason: state.invalidReason,
    deviceCode: state.deviceCode,
    userCode: state.userCode,
    verificationUri: state.verificationUri,
    pollIntervalSeconds: state.pollIntervalSeconds,
    pairingExpiresAt: state.pairingExpiresAt,
    pairingError: state.pairingError,
    sessionTokenPresent: Boolean(state.sessionToken),
    hasSeenWelcome:
      typeof window !== 'undefined' && Boolean(window.localStorage?.getItem(FIRST_LAUNCH_KEY)),
  }
}

export async function clearDeviceAuthState(
  options: ClearDeviceAuthStateOptions = {}
): Promise<void> {
  const { clearFingerprint = true, showWelcome = true } = options

  await clearDeviceAuthSession()

  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(DEVICE_AUTH_SESSION_METADATA_KEY)
    if (clearFingerprint) {
      window.localStorage.removeItem(DEVICE_AUTH_FINGERPRINT_KEY)
    }
  }

  const store = useDeviceAuthStore.getState()
  store.resetToGuest()
  store.setLinkDialogOpen(false)
  setFirstLaunchState(showWelcome)
}
