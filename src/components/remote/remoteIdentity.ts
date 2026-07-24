import type { RemoteSessionIdentity } from '@/services/remoteSessionService'

export const buildRemoteIdentity = ({
  linkedEmail,
  deviceId,
  deviceFingerprint,
}: {
  linkedEmail: string | null
  deviceId: string | null
  deviceFingerprint: string | null
}): RemoteSessionIdentity => {
  const fallbackDeviceId = deviceFingerprint
    ? `guest-${deviceFingerprint.slice(0, 12)}`
    : 'guest-local'

  return {
    display_name: linkedEmail ?? `Device ${fallbackDeviceId.slice(-6)}`,
    device_id: deviceId ?? fallbackDeviceId,
    account_email: linkedEmail,
    is_guest: !linkedEmail,
  }
}
