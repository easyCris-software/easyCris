import path from 'node:path'

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

export function darwinInterpreterPath(root) {
  return path.join(root, 'python_embedded', 'runtime', 'bin', 'python3.12')
}

export function darwinSitePackagesPath(root) {
  return path.join(root, 'python_embedded', 'runtime', 'lib', 'python3.12', 'site-packages')
}

export function darwinBackendModule(backend) {
  if (!REQUIRED_BACKENDS.includes(backend)) {
    throw new Error(`Unknown backend: ${backend}`)
  }
  return backend
}
