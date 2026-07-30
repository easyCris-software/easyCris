export const REQUIRED_BACKENDS = Object.freeze(['stats', 'rnaseq', 'plot'])
export const SUPPORTED_RUNTIME_PLATFORMS = Object.freeze(['win32', 'darwin'])

export function assertRuntimePlatform(platform = process.platform) {
  if (!SUPPORTED_RUNTIME_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported runtime platform: ${platform}`)
  }
  return platform
}

export function backendExecutableName(backend, platform = process.platform) {
  assertRuntimePlatform(platform)
  return platform === 'win32' ? `${backend}.exe` : backend
}

export function pythonVenvExecutable(platform = process.platform) {
  assertRuntimePlatform(platform)
  return platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
}
