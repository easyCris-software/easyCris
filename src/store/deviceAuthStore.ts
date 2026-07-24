import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  DeviceAuthMode,
  DeviceEntitlementTier,
  PairingSnapshot,
  StoredDeviceAuthSession,
} from '@/lib/deviceAuth'

interface DeviceAuthState {
  mode: DeviceAuthMode
  deviceFingerprint: string | null
  sessionToken: string | null
  linkedEmail: string | null
  tier: DeviceEntitlementTier | null
  deviceId: string | null
  expiresAt: string | null
  lastValidatedAt: string | null
  invalidReason: string | null
  linkDialogOpen: boolean

  deviceCode: string | null
  userCode: string | null
  verificationUri: string | null
  pollIntervalSeconds: number | null
  pairingExpiresAt: string | null
  pairingError: string | null
  resumeSession: StoredDeviceAuthSession | null

  setDeviceFingerprint: (fingerprint: string) => void
  setLinkDialogOpen: (open: boolean) => void
  beginPairing: (snapshot: PairingSnapshot) => void
  cancelPairing: () => void
  setPairingError: (message: string | null) => void
  completeLinking: (session: StoredDeviceAuthSession) => void
  restoreLinkedSession: (session: StoredDeviceAuthSession) => void
  markInvalid: (reason: string) => void
  resetToGuest: () => void
}

const createInitialState = () => ({
  mode: 'guest' as DeviceAuthMode,
  deviceFingerprint: null,
  sessionToken: null,
  linkedEmail: null,
  tier: null,
  deviceId: null,
  expiresAt: null,
  lastValidatedAt: null,
  invalidReason: null,
  linkDialogOpen: false,
  deviceCode: null,
  userCode: null,
  verificationUri: null,
  pollIntervalSeconds: null,
  pairingExpiresAt: null,
  pairingError: null,
  resumeSession: null,
})

const deviceAuthStateCreator: StateCreator<DeviceAuthState> = (set) => ({
  ...createInitialState(),

  setDeviceFingerprint: (fingerprint) => set({ deviceFingerprint: fingerprint }),

  setLinkDialogOpen: (open) => set({ linkDialogOpen: open }),

  beginPairing: (snapshot) =>
    set((state) => ({
      mode: 'pairing',
      invalidReason: null,
      pairingError: null,
      deviceCode: snapshot.deviceCode,
      userCode: snapshot.userCode,
      verificationUri: snapshot.verificationUri,
      pollIntervalSeconds: snapshot.pollIntervalSeconds,
      pairingExpiresAt: snapshot.expiresAt,
      sessionToken: null,
      linkedEmail: null,
      tier: null,
      deviceId: null,
      expiresAt: null,
      lastValidatedAt: null,
      linkDialogOpen: true,
      deviceFingerprint: state.deviceFingerprint,
      resumeSession: state.sessionToken
        ? {
            sessionToken: state.sessionToken,
            linkedEmail: state.linkedEmail,
            tier: state.tier,
            deviceId: state.deviceId,
            expiresAt: state.expiresAt,
            lastValidatedAt: state.lastValidatedAt,
          }
        : null,
    })),

  cancelPairing: () =>
    set((state) => {
      if (state.resumeSession) {
        return {
          mode: 'linked',
          sessionToken: state.resumeSession.sessionToken,
          linkedEmail: state.resumeSession.linkedEmail,
          tier: state.resumeSession.tier,
          deviceId: state.resumeSession.deviceId,
          expiresAt: state.resumeSession.expiresAt,
          lastValidatedAt: state.resumeSession.lastValidatedAt,
          invalidReason: null,
          linkDialogOpen: false,
          deviceCode: null,
          userCode: null,
          verificationUri: null,
          pollIntervalSeconds: null,
          pairingExpiresAt: null,
          pairingError: null,
          resumeSession: null,
        }
      }

      return {
        mode: 'guest',
        invalidReason: null,
        linkDialogOpen: false,
        deviceCode: null,
        userCode: null,
        verificationUri: null,
        pollIntervalSeconds: null,
        pairingExpiresAt: null,
        pairingError: null,
        sessionToken: null,
        linkedEmail: null,
        tier: null,
        deviceId: null,
        expiresAt: null,
        lastValidatedAt: null,
        resumeSession: null,
      }
    }),

  setPairingError: (message) => set({ pairingError: message }),

  completeLinking: (session) =>
    set((state) => {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('hasSeenWelcome', 'true')
      }

      return {
        mode: 'linked',
        sessionToken: session.sessionToken,
        linkedEmail: session.linkedEmail,
        tier: session.tier,
        deviceId: session.deviceId,
        expiresAt: session.expiresAt,
        lastValidatedAt: session.lastValidatedAt,
        invalidReason: null,
        deviceCode: null,
        userCode: null,
        verificationUri: null,
        pollIntervalSeconds: null,
        pairingExpiresAt: null,
        pairingError: null,
        linkDialogOpen: state.linkDialogOpen,
        resumeSession: null,
      }
    }),

  restoreLinkedSession: (session) =>
    set({
      mode: 'linked',
      sessionToken: session.sessionToken,
      linkedEmail: session.linkedEmail,
      tier: session.tier,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt,
      lastValidatedAt: session.lastValidatedAt,
      invalidReason: null,
    }),

  markInvalid: (reason) =>
    set((state) => ({
      mode: 'invalid',
      sessionToken: null,
      linkedEmail: null,
      tier: null,
      deviceId: null,
      expiresAt: null,
      lastValidatedAt: null,
      invalidReason: reason,
      deviceCode: null,
      userCode: null,
      verificationUri: null,
      pollIntervalSeconds: null,
      pairingExpiresAt: null,
      pairingError: null,
      linkDialogOpen: false,
      deviceFingerprint: state.deviceFingerprint,
      resumeSession: null,
    })),

  resetToGuest: () =>
    set((state) => ({
      ...createInitialState(),
      deviceFingerprint: state.deviceFingerprint,
    })),
})

const useDeviceAuthStoreDev = create<DeviceAuthState>()(
  devtools(deviceAuthStateCreator, { name: 'device-auth-store' })
)

const useDeviceAuthStoreProd = create<DeviceAuthState>()(deviceAuthStateCreator)

export const useDeviceAuthStore = import.meta.env.DEV
  ? useDeviceAuthStoreDev
  : useDeviceAuthStoreProd

export default useDeviceAuthStore
