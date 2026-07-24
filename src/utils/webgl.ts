let cachedWebGLSupport: boolean | null = null

export function isWebGLSupported(): boolean {
  if (cachedWebGLSupport !== null) return cachedWebGLSupport
  if (typeof document === 'undefined') {
    cachedWebGLSupport = false
    return cachedWebGLSupport
  }

  try {
    const canvas = document.createElement('canvas')
    cachedWebGLSupport = Boolean(
      canvas.getContext('webgl') ??
      canvas.getContext('webgl2') ??
      canvas.getContext('experimental-webgl')
    )
  } catch {
    cachedWebGLSupport = false
  }

  return cachedWebGLSupport
}

export function resetWebGLSupportCacheForTests(): void {
  cachedWebGLSupport = null
}
