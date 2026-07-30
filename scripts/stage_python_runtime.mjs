#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import {
  REQUIRED_BACKENDS,
  assertRuntimePlatform,
  backendExecutableName,
} from './python-runtime-constants.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

export function readTargetPlatform(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--platform')
  return assertRuntimePlatform(index >= 0 ? argv[index + 1] : process.platform)
}

export function backendArtifactPaths(distRoot, backend, platform = process.platform) {
  const executable = backendExecutableName(backend, platform)
  const distDirectory = path.join(distRoot, `${backend}.dist`)
  return {
    topLevel: path.join(distRoot, executable),
    distDirectory,
    distExecutable: path.join(distDirectory, executable),
  }
}

export function isTransientKaleidoLog(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/')
  return /(^|\/)plot\.dist\/kaleido\/executable\/(?:.*\/)?[^/]+\.log$/i.test(normalized)
}

function walkFiles(targetDir) {
  if (!fs.existsSync(targetDir)) return []
  const files = []
  const stack = [targetDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(entryPath)
      else if (entry.isFile()) files.push(entryPath)
    }
  }
  return files
}

export function cleanTransientKaleidoLogs(roots) {
  let removed = 0
  for (const root of roots) {
    for (const filePath of walkFiles(root)) {
      if (isTransientKaleidoLog(filePath)) {
        fs.rmSync(filePath, { force: true })
        removed += 1
      }
    }
  }
  return removed
}

function fail(message) {
  throw new Error(`[stage-python-runtime] ${message}`)
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) fail(`${label} missing: ${targetPath}`)
}

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return
  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    if (process.platform !== 'win32') throw error
    execSync(`cmd /c rmdir /s /q "${targetPath}"`, { stdio: 'ignore' })
    if (fs.existsSync(targetPath)) throw error
  }
}

function assertNoTransientKaleidoLogs(roots) {
  const stale = roots.flatMap(root => walkFiles(root).filter(filePath => path.basename(filePath).toLowerCase().endsWith('.log')))
  if (stale.length > 0) fail(`Transient Kaleido logs remain: ${stale.join(', ')}`)
}

function stageOptionalWindowsPython({ root, stageRoot, platform }) {
  if (platform !== 'win32') return
  const source = path.join(root, 'python_embedded', 'python.exe')
  const destination = path.join(stageRoot, 'python.exe')
  removeIfExists(destination)
  if (!fs.existsSync(source)) {
    console.log(`[stage-python-runtime] Optional file skipped: ${source}`)
    return
  }
  fs.copyFileSync(source, destination)
  console.log('[stage-python-runtime] Optional file copied: python.exe')
}

function resolveSourceBackendExecutable(paths, backend, platform) {
  ensureExists(paths.distDirectory, `Source ${backend}.dist`)
  if (fs.existsSync(paths.topLevel)) return paths.topLevel
  if (fs.existsSync(paths.distExecutable)) return paths.distExecutable
  fail(`Source ${backend} executable missing in both dist root and ${backend}.dist for ${platform}`)
}

export function stagePythonRuntime({ root = rootDir, platform = process.platform } = {}) {
  const targetPlatform = assertRuntimePlatform(platform)
  const sourceDist = path.join(root, 'python_embedded', 'dist')
  const stageRoot = path.join(root, 'bundle_resources', 'python_embedded')
  const stageDist = path.join(stageRoot, 'dist')
  const generatedRoots = [
    path.join(sourceDist, 'plot.dist', 'kaleido', 'executable'),
    path.join(stageDist, 'plot.dist', 'kaleido', 'executable'),
  ]

  ensureExists(sourceDist, 'Source dist directory')
  cleanTransientKaleidoLogs(generatedRoots)
  assertNoTransientKaleidoLogs(generatedRoots)

  fs.mkdirSync(stageRoot, { recursive: true })
  removeIfExists(stageDist)
  fs.mkdirSync(stageDist, { recursive: true })

  for (const backend of REQUIRED_BACKENDS) {
    const sourcePaths = backendArtifactPaths(sourceDist, backend, targetPlatform)
    const stagedPaths = backendArtifactPaths(stageDist, backend, targetPlatform)
    const sourceExecutable = resolveSourceBackendExecutable(sourcePaths, backend, targetPlatform)

    removeIfExists(stagedPaths.topLevel)
    removeIfExists(stagedPaths.distDirectory)
    fs.copyFileSync(sourceExecutable, stagedPaths.topLevel)
    fs.cpSync(sourcePaths.distDirectory, stagedPaths.distDirectory, { recursive: true, force: true })
    ensureExists(stagedPaths.distExecutable, `Staged ${backend}.dist executable`)
  }

  stageOptionalWindowsPython({ root, stageRoot, platform: targetPlatform })
  cleanTransientKaleidoLogs(generatedRoots)
  assertNoTransientKaleidoLogs(generatedRoots)

  for (const backend of REQUIRED_BACKENDS) {
    const stagedPaths = backendArtifactPaths(stageDist, backend, targetPlatform)
    ensureExists(stagedPaths.distDirectory, `Staged ${backend}.dist`)
    ensureExists(stagedPaths.distExecutable, `Staged ${backend}.dist executable`)
    if (targetPlatform === 'win32') ensureExists(stagedPaths.topLevel, `Staged ${backend}.exe`)
  }

  return { sourceDist, stageRoot, stageDist, platform: targetPlatform }
}

function main() {
  const platform = readTargetPlatform()
  const result = stagePythonRuntime({ platform })
  console.log(`[stage-python-runtime] Staged required backend artifacts into ${result.stageDist}`)
  console.log('[stage-python-runtime] Completed successfully')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[stage-python-runtime] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}
