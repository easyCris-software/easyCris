type DebugScope = 'grid' | 'app' | 'paste' | 'remote-input'

const scopeSequence: Record<DebugScope, number> = {
  grid: 0,
  app: 0,
  paste: 0,
  'remote-input': 0,
}

const cachedStorageFlags: {
  global: boolean | null
  grid: boolean | null
  app: boolean | null
  paste: boolean | null
  remoteInput: boolean | null
} = {
  global: null,
  grid: null,
  app: null,
  paste: null,
  remoteInput: null,
}

function readStorageFlag(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const value = window.localStorage.getItem(key)
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

function readCachedStorageFlag(scope: keyof typeof cachedStorageFlags, key: string): boolean {
  const cached = cachedStorageFlags[scope]
  if (cached !== null) return cached
  const next = readStorageFlag(key)
  cachedStorageFlags[scope] = next
  return next
}

export function isRuntimeDebugEnabled(scope: DebugScope): boolean {
  if (typeof window === 'undefined') return false

  const globalWindowFlag = window.__EASYCRIS_DEBUG__
  const globalFlag =
    globalWindowFlag === true ||
    (globalWindowFlag !== false &&
      readCachedStorageFlag('global', 'easycris:debug'))
  if (globalFlag) return true

  if (scope === 'grid') {
    const gridWindowFlag = window.__EASYCRIS_GRID_DEBUG__
    if (gridWindowFlag === true) return true
    if (gridWindowFlag === false) return false
    return (
      readCachedStorageFlag('grid', 'easycris:grid-debug')
    )
  }

  if (scope === 'remote-input') {
    const remoteInputWindowFlag = window.__EASYCRIS_REMOTE_INPUT_DEBUG__
    if (remoteInputWindowFlag === true) return true
    if (remoteInputWindowFlag === false) return false
    return readCachedStorageFlag(
      'remoteInput',
      'easycris:remote-input-debug'
    )
  }

  if (scope === 'paste') {
    const pasteWindowFlag = window.__EASYCRIS_PASTE_DEBUG__
    if (pasteWindowFlag === true) return true
    if (pasteWindowFlag === false) return false
    return readCachedStorageFlag('paste', 'easycris:paste-debug')
  }

  const appWindowFlag = window.__EASYCRIS_APP_DEBUG__
  if (appWindowFlag === true) return true
  if (appWindowFlag === false) return false
  return (
    readCachedStorageFlag('app', 'easycris:app-debug')
  )
}

export function logRuntimeDebug(
  scope: DebugScope,
  event: string,
  payload?: Record<string, unknown>
): void {
  if (!isRuntimeDebugEnabled(scope)) return
  scopeSequence[scope] += 1
  const sequence = scopeSequence[scope]
  const now = new Date().toISOString()
  const prefix = `[DEBUG:${scope.toUpperCase()}:${sequence}]`
  if (payload) {
    console.log(prefix, event, { at: now, ...payload })
    return
  }
  console.log(prefix, event, { at: now })
}
