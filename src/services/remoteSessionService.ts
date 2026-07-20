import { invoke } from '@tauri-apps/api/core'
import type {
  RemoteInputKeyEventPayload,
  RemoteInputMouseEventPayload,
} from '@/services/remoteInputEvents'
import type { RemoteSessionRevokedReason } from '@/services/remoteSignalingProtocol'

export type { RemoteSessionRevokedReason } from '@/services/remoteSignalingProtocol'

export type RemoteSessionPhase =
  | 'idle'
  | 'listening'
  | 'pending_approval'
  | 'connected'
  | 'revoked'
  | 'error'

export type RemoteSessionMode = 'lan' | 'cloud'

export interface RemoteSessionIdentity {
  display_name: string
  device_id: string
  account_email: string | null
  is_guest: boolean
}

export interface RemoteSessionInfo {
  session_id: string
  invite_token_preview: string
  signaling_port: number | null
  host_candidates: string[]
  mode: RemoteSessionMode
  host_display_name: string
  host_device_id: string
  guest_display_name: string | null
  guest_device_id: string | null
  status: RemoteSessionPhase
  can_control: boolean
}

export interface RemoteSessionGuestSummary {
  guest_display_name: string
  guest_device_id: string
}

export interface RemoteSessionStatus {
  current_session: RemoteSessionInfo | null
  pending_guest: RemoteSessionGuestSummary | null
  approved_guest: RemoteSessionGuestSummary | null
  approved_control: boolean
}

export interface RemoteSessionLimitEvent {
  session_id: string
  seconds_remaining: number
}

export interface RemoteSessionInvite {
  session_id: string
  invite_token: string
  share_url: string
  signaling_port: number | null
  host_candidates: string[]
  mode: RemoteSessionMode
  relay_url?: string | null
  invite_id?: string | null
  host_secret?: string | null
  expires_at_unix_ms: number
}

export interface RemoteSessionStartResult {
  status: RemoteSessionStatus
  invite: RemoteSessionInvite
}

interface CloudInviteResponse {
  invite_id: string
  guest_token: string
  host_secret: string
  share_url: string
  relay_url: string
  expires_at_unix_ms: number
}

interface CloudInviteMetadata {
  invite_id: string
  relay_url: string
  expires_at_unix_ms: number
  status: string
}

export interface RemoteControlPermission {
  session_id: string
  guest_device_id: string
  can_control: boolean
}

export interface RemoteGuestRejection {
  session_id: string
  guest_device_id: string
}

export interface RemoteInputMouseResult {
  rect_height: number
  rect_left: number
  rect_top: number
  rect_width: number
  screen_x: number
  screen_y: number
}

export const startRemoteSession = (hostIdentity: RemoteSessionIdentity) =>
  invoke<RemoteSessionStartResult>('start_remote_session', { hostIdentity })

export const remoteSignalingBaseUrl =
  import.meta.env.VITE_REMOTE_SIGNALING_BASE_URL ??
  'https://remote.easycris.com'

export const remoteForceRelayEnabled =
  import.meta.env.VITE_REMOTE_FORCE_RELAY === '1'

const remoteSignalingUrl = (path: string) =>
  `${remoteSignalingBaseUrl.replace(/\/$/, '')}${path}`

let activeCloudHostSecret: string | null = null

export const getActiveCloudHostSecret = () => activeCloudHostSecret

export const clearActiveCloudHostSecret = () => {
  activeCloudHostSecret = null
}

export const createCloudRemoteInvite = async (
  hostIdentity: RemoteSessionIdentity
) => {
  const response = await fetch(remoteSignalingUrl('/v1/remote/invites'), {
    body: JSON.stringify({
      host_device_id: hostIdentity.device_id,
      host_display_name: hostIdentity.display_name,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Cloud remote invite failed: HTTP ${response.status}`)
  }
  return (await response.json()) as CloudInviteResponse
}

export const getCloudRemoteInviteMetadata = async (inviteId: string) => {
  const response = await fetch(
    remoteSignalingUrl(`/v1/remote/invites/${encodeURIComponent(inviteId)}`)
  )
  if (!response.ok) {
    throw new Error(
      `Cloud remote invite lookup failed: HTTP ${response.status}`
    )
  }
  return (await response.json()) as CloudInviteMetadata
}

export const startCloudRemoteSession = async (
  hostIdentity: RemoteSessionIdentity
) => {
  const cloudInvite = await createCloudRemoteInvite(hostIdentity)
  activeCloudHostSecret = cloudInvite.host_secret
  const invite: RemoteSessionInvite = {
    session_id: cloudInvite.invite_id,
    invite_token: cloudInvite.guest_token,
    share_url: cloudInvite.share_url,
    signaling_port: null,
    host_candidates: [],
    mode: 'cloud',
    relay_url: cloudInvite.relay_url,
    invite_id: cloudInvite.invite_id,
    host_secret: cloudInvite.host_secret,
    expires_at_unix_ms: cloudInvite.expires_at_unix_ms,
  }
  try {
    return await invoke<RemoteSessionStartResult>(
      'start_cloud_remote_session',
      {
        hostIdentity,
        invite,
      }
    )
  } catch (error) {
    clearActiveCloudHostSecret()
    throw error
  }
}

export const stopRemoteSession = () =>
  invoke<RemoteSessionStatus>('stop_remote_session')

export const getRemoteSessionStatus = () =>
  invoke<RemoteSessionStatus>('get_remote_session_status')

export const noteRemoteSessionGuestPending = (
  sessionId: string,
  guestDisplayName: string,
  guestDeviceId: string
) =>
  invoke<RemoteSessionStatus>('set_remote_session_pending_guest', {
    guest: {
      session_id: sessionId,
      guest_display_name: guestDisplayName,
      guest_device_id: guestDeviceId,
      guest_ip: null,
    },
  })

export const approveRemoteSessionGuest = (
  permission: RemoteControlPermission
) => invoke<RemoteSessionStatus>('approve_remote_session_guest', { permission })

export const rejectRemoteSessionGuest = (rejection: RemoteGuestRejection) =>
  invoke<RemoteSessionStatus>('reject_remote_session_guest', { rejection })

export const revokeRemoteControl = (
  sessionId: string,
  reason?: RemoteSessionRevokedReason
) => invoke<RemoteSessionStatus>('revoke_remote_control', { sessionId, reason })

export const sendRemoteMouseInput = async (
  event: RemoteInputMouseEventPayload
) => {
  return await invoke<RemoteInputMouseResult>('remote_input_mouse_event', {
    event,
  })
}

export const sendRemoteKeyInput = async (event: RemoteInputKeyEventPayload) => {
  await invoke('remote_input_key_event', { event })
}

export const setRemoteWindowCaptureExclusion = (excluded: boolean) =>
  invoke('set_remote_window_capture_exclusion', { excluded })
