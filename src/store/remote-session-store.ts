import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  RemoteSessionRevokedReason,
  RemoteSessionGuestSummary,
  RemoteSessionIdentity,
  RemoteSessionInvite,
  RemoteSessionLimitEvent,
  RemoteSessionMode,
  RemoteSessionStatus,
} from '@/services/remoteSessionService'
import {
  approveRemoteSessionGuest,
  clearActiveCloudHostSecret,
  getRemoteSessionStatus,
  rejectRemoteSessionGuest,
  startCloudRemoteSession,
  revokeRemoteControl,
  startRemoteSession,
  stopRemoteSession,
} from '@/services/remoteSessionService'

export interface RemoteSessionLimitWarning extends RemoteSessionLimitEvent {
  expires_at_unix_ms: number
}

export interface RemoteSessionAudioState {
  localEnabled: boolean
  localMuted: boolean
  remotePlaybackEnabled: boolean
  connecting: boolean
}

const defaultAudioState = (): RemoteSessionAudioState => ({
  localEnabled: false,
  localMuted: false,
  remotePlaybackEnabled: false,
  connecting: false,
})

interface RemoteSessionStoreState {
  status: RemoteSessionStatus | null
  invite: RemoteSessionInvite | null
  pendingGuest: RemoteSessionGuestSummary | null
  approvedGuest: RemoteSessionGuestSummary | null
  error: string | null
  sessionWarning: RemoteSessionLimitWarning | null
  idleWarning: RemoteSessionLimitWarning | null
  audioState: RemoteSessionAudioState
  guestHostDeviceId: string | null
  isHost: boolean
  isGuest: boolean
  isBusy: boolean

  startHosting: (
    identity: RemoteSessionIdentity,
    mode?: RemoteSessionMode
  ) => Promise<RemoteSessionInvite>
  stopHosting: () => Promise<void>
  refreshStatus: () => Promise<RemoteSessionStatus>
  approveGuest: (guestDeviceId: string) => Promise<RemoteSessionStatus>
  rejectGuest: (guestDeviceId: string) => Promise<RemoteSessionStatus>
  revoke: (reason?: RemoteSessionRevokedReason) => Promise<RemoteSessionStatus>
  setSessionWarning: (warning: RemoteSessionLimitWarning | null) => void
  setIdleWarning: (warning: RemoteSessionLimitWarning | null) => void
  setAudioState: (patch: Partial<RemoteSessionAudioState>) => void
  resetAudioState: () => void
  setGuestHostDeviceId: (hostDeviceId: string | null) => void
  setGuestMode: (isGuest: boolean) => void
  clearError: () => void
}

const syncStatus = (
  status: RemoteSessionStatus,
  extras: Partial<RemoteSessionStoreState> = {}
) => ({
  status,
  pendingGuest: status.pending_guest,
  approvedGuest: status.approved_guest,
  error: null,
  ...extras,
})

const rawErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const errorMessage = (error: unknown) => {
  const message = rawErrorMessage(error)
  if (
    message.includes('Failed to bind remote-session signaling server') ||
    message.includes('address already in use')
  ) {
    return 'Could not start remote session. The local listening port is blocked or unavailable; check firewall/network settings and try again.'
  }
  return message
}

export const useRemoteSessionStore = create<RemoteSessionStoreState>()(
  devtools(
    (set, get) => ({
      status: null,
      invite: null,
      pendingGuest: null,
      approvedGuest: null,
      error: null,
      sessionWarning: null,
      idleWarning: null,
      audioState: defaultAudioState(),
      guestHostDeviceId: null,
      isHost: false,
      isGuest: false,
      isBusy: false,

      startHosting: async (identity, mode = 'lan') => {
        set({ isBusy: true, error: null }, undefined, 'remote/startHosting')
        try {
          const result =
            mode === 'cloud'
              ? await startCloudRemoteSession(identity)
              : await startRemoteSession(identity)
          set(
            syncStatus(result.status, {
              invite: result.invite,
              isHost: true,
              isGuest: false,
              isBusy: false,
              sessionWarning: null,
              idleWarning: null,
              audioState: defaultAudioState(),
            }),
            undefined,
            'remote/startHosting:success'
          )
          return result.invite
        } catch (error) {
          set(
            { isBusy: false, error: errorMessage(error) },
            undefined,
            'remote/startHosting:error'
          )
          throw error
        }
      },

      stopHosting: async () => {
        set({ isBusy: true, error: null }, undefined, 'remote/stopHosting')
        try {
          const status = await stopRemoteSession()
          clearActiveCloudHostSecret()
          set(
            syncStatus(status, {
              invite: null,
              isHost: false,
              isBusy: false,
              sessionWarning: null,
              idleWarning: null,
              audioState: defaultAudioState(),
            }),
            undefined,
            'remote/stopHosting:success'
          )
        } catch (error) {
          set(
            { isBusy: false, error: errorMessage(error) },
            undefined,
            'remote/stopHosting:error'
          )
          throw error
        }
      },

      refreshStatus: async () => {
        const status = await getRemoteSessionStatus()
        const hasSession = Boolean(status.current_session)
        const sameSession =
          hasSession &&
          get().status?.current_session?.session_id ===
            status.current_session?.session_id
        set(
          syncStatus(status, {
            isHost: hasSession ? get().isHost : false,
            invite: hasSession ? get().invite : null,
            sessionWarning:
              sameSession &&
              get().sessionWarning?.session_id ===
                status.current_session?.session_id
                ? get().sessionWarning
                : null,
            idleWarning:
              sameSession &&
              get().idleWarning?.session_id ===
                status.current_session?.session_id
                ? get().idleWarning
                : null,
            audioState: sameSession ? get().audioState : defaultAudioState(),
          }),
          undefined,
          'remote/refreshStatus'
        )
        return status
      },

      approveGuest: async guestDeviceId => {
        const sessionId = get().status?.current_session?.session_id
        if (!sessionId) {
          throw new Error('No active remote session')
        }

        set({ isBusy: true, error: null }, undefined, 'remote/approveGuest')
        try {
          const status = await approveRemoteSessionGuest({
            session_id: sessionId,
            guest_device_id: guestDeviceId,
            can_control: true,
          })
          set(
            syncStatus(status, { isBusy: false }),
            undefined,
            'remote/approveGuest:success'
          )
          return status
        } catch (error) {
          set(
            { isBusy: false, error: errorMessage(error) },
            undefined,
            'remote/approveGuest:error'
          )
          throw error
        }
      },

      rejectGuest: async guestDeviceId => {
        const sessionId = get().status?.current_session?.session_id
        if (!sessionId) {
          throw new Error('No active remote session')
        }

        set({ isBusy: true, error: null }, undefined, 'remote/rejectGuest')
        try {
          const status = await rejectRemoteSessionGuest({
            session_id: sessionId,
            guest_device_id: guestDeviceId,
          })
          set(
            syncStatus(status, { isBusy: false }),
            undefined,
            'remote/rejectGuest:success'
          )
          return status
        } catch (error) {
          set(
            { isBusy: false, error: errorMessage(error) },
            undefined,
            'remote/rejectGuest:error'
          )
          throw error
        }
      },

      revoke: async reason => {
        const sessionId = get().status?.current_session?.session_id
        if (!sessionId) {
          throw new Error('No active remote session')
        }

        set({ isBusy: true, error: null }, undefined, 'remote/revoke')
        try {
          await revokeRemoteControl(sessionId, reason).catch(() => undefined)
          const status = await stopRemoteSession()
          clearActiveCloudHostSecret()
          set(
            syncStatus(status, {
              invite: null,
              isHost: false,
              isBusy: false,
              sessionWarning: null,
              idleWarning: null,
              audioState: defaultAudioState(),
            }),
            undefined,
            'remote/revoke:success'
          )
          return status
        } catch (error) {
          set(
            { isBusy: false, error: errorMessage(error) },
            undefined,
            'remote/revoke:error'
          )
          throw error
        }
      },

      setGuestMode: isGuest =>
        set(
          {
            isGuest,
            guestHostDeviceId: isGuest ? get().guestHostDeviceId : null,
            audioState: isGuest ? get().audioState : defaultAudioState(),
          },
          undefined,
          'remote/setGuestMode'
        ),

      setGuestHostDeviceId: hostDeviceId =>
        set(
          { guestHostDeviceId: hostDeviceId },
          undefined,
          'remote/setGuestHostDeviceId'
        ),

      setSessionWarning: warning =>
        set({ sessionWarning: warning }, undefined, 'remote/setSessionWarning'),

      setIdleWarning: warning =>
        set({ idleWarning: warning }, undefined, 'remote/setIdleWarning'),

      setAudioState: patch =>
        set(
          state => ({ audioState: { ...state.audioState, ...patch } }),
          undefined,
          'remote/setAudioState'
        ),

      resetAudioState: () =>
        set(
          { audioState: defaultAudioState() },
          undefined,
          'remote/resetAudioState'
        ),

      clearError: () => set({ error: null }, undefined, 'remote/clearError'),
    }),
    { name: 'remote-session-store', enabled: import.meta.env.DEV }
  )
)

export default useRemoteSessionStore
