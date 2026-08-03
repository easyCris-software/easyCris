import { openSync, readSync, closeSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const MACOS_DEPLOYMENT_TARGET = '14.0'

function versionTuple(raw) {
  const match = /^(\d+)(?:\.(\d+))?/.exec(String(raw).trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2] || 0)]
}

function compareVersions(left, right) {
  return left[0] - right[0] || left[1] - right[1]
}

export function minimumMacOSVersions(description) {
  const versions = []
  const patterns = [
    /cmd\s+LC_BUILD_VERSION[\s\S]*?\n\s*minos\s+(\d+(?:\.\d+)?)/g,
    /cmd\s+LC_VERSION_MIN_MACOSX[\s\S]*?\n\s*version\s+(\d+(?:\.\d+)?)/g,
  ]
  for (const pattern of patterns) {
    for (const match of String(description).matchAll(pattern)) versions.push(match[1])
  }
  return versions
}

export function inspectDarwinBinary(targetPath) {
  const fileResult = spawnSync('file', ['-b', targetPath], { encoding: 'utf8' })
  if (fileResult.status !== 0) {
    throw new Error((fileResult.stderr || '').trim() || `file exited ${fileResult.status}`)
  }
  const fileDescription = fileResult.stdout.trim()
  if (!fileDescription.includes('Mach-O')) return fileDescription
  const otoolResult = spawnSync('otool', ['-l', targetPath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (otoolResult.status !== 0) {
    throw new Error((otoolResult.stderr || '').trim() || `otool exited ${otoolResult.status}`)
  }
  return `${fileDescription}\n${otoolResult.stdout}`
}

export function validateDarwinBinaryDescription({
  description,
  expectedArchitecture,
  label,
  targetPath,
  deploymentTarget = MACOS_DEPLOYMENT_TARGET,
}) {
  const errors = []
  const text = String(description)
  if (!text.includes('Mach-O')) return errors
  const architectures = text.match(/\b(?:x86_64|arm64)\b/g) || []
  if (!architectures.includes(expectedArchitecture)) {
    errors.push(`${label} architecture mismatch: expected ${expectedArchitecture}, got ${text.split('\n', 1)[0] || '(empty result)'} (${targetPath})`)
  }
  const versions = minimumMacOSVersions(text)
  if (versions.length === 0) {
    errors.push(`Unable to determine ${label} minimum macOS version: ${targetPath}`)
    return errors
  }
  const floor = versionTuple(deploymentTarget)
  for (const version of versions) {
    if (compareVersions(versionTuple(version), floor) > 0) {
      errors.push(`${label} minimum macOS version ${version} exceeds ${deploymentTarget}: ${targetPath}`)
    }
  }
  return errors
}

function walkFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(candidate)
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(candidate)
    }
  }
  return files
}

function hasMachOMagic(targetPath) {
  const descriptor = openSync(targetPath, 'r')
  try {
    const header = Buffer.alloc(4)
    if (readSync(descriptor, header, 0, 4, 0) !== 4) return false
    return new Set([
      'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
      'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
    ]).has(header.toString('hex'))
  } finally {
    closeSync(descriptor)
  }
}

export function validateDarwinTree(
  root,
  expectedArchitecture,
  { inspect = inspectDarwinBinary, label = 'Darwin runtime payload' } = {},
) {
  const errors = []
  for (const targetPath of walkFiles(root)) {
    if (inspect === inspectDarwinBinary && !hasMachOMagic(targetPath)) continue
    let description
    try {
      description = inspect(targetPath)
    } catch (error) {
      errors.push(`Failed to inspect ${label}: ${targetPath} (${error.message})`)
      continue
    }
    errors.push(...validateDarwinBinaryDescription({
      description,
      expectedArchitecture,
      label,
      targetPath,
    }))
  }
  return errors
}
