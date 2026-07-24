const GENERIC_DISPLAY_NAMES = new Set(['guest', 'host'])

interface RemoteIdentityNameInput {
  deviceId?: string | null
  displayName?: string | null
  fallback: string
}

export const remoteIdentityName = ({
  deviceId,
  displayName,
  fallback,
}: RemoteIdentityNameInput) => {
  const name = displayName?.trim()
  const id = deviceId?.trim()
  if (
    name &&
    !GENERIC_DISPLAY_NAMES.has(name.toLowerCase()) &&
    !/^Device\s+/i.test(name)
  ) {
    return name
  }
  return id || name || fallback
}
