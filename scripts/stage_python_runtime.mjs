#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { REQUIRED_BACKENDS } from './python-runtime-constants.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const sourceDist = path.join(rootDir, 'python_embedded', 'dist')
const stageRoot = path.join(rootDir, 'bundle_resources', 'python_embedded')
const stageDist = path.join(stageRoot, 'dist')

const optionalCopies = [
  {
    source: path.join(rootDir, 'python_embedded', 'python.exe'),
    destination: path.join(stageRoot, 'python.exe'),
  },
]

const staleFiles = [
]

function fail(message) {
  console.error(`[stage-python-runtime] ERROR: ${message}`)
  process.exit(1)
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    fail(`${label} missing: ${targetPath}`)
  }
}

function removeIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return
    } catch (error) {
      if (process.platform !== 'win32') {
        throw error
      }
      // Windows can intermittently fail recursive deletes with ENOTEMPTY on large trees.
      execSync(`cmd /c rmdir /s /q "${targetPath}"`, { stdio: 'ignore' })
      if (fs.existsSync(targetPath)) {
        throw error
      }
    }
  }
}

function stageOptionalFile(entry) {
  removeIfExists(entry.destination)
  if (!fs.existsSync(entry.source)) {
    console.log(`[stage-python-runtime] Optional file skipped: ${entry.source}`)
    return
  }
  fs.copyFileSync(entry.source, entry.destination)
  console.log(`[stage-python-runtime] Optional file copied: ${path.basename(entry.source)}`)
}

function validateStagedBackends() {
  for (const backend of REQUIRED_BACKENDS) {
    ensureExists(path.join(stageDist, `${backend}.exe`), `Staged ${backend}.exe`)
    ensureExists(path.join(stageDist, `${backend}.dist`), `Staged ${backend}.dist`)
    ensureExists(
      path.join(stageDist, `${backend}.dist`, `${backend}.exe`),
      `Staged ${backend}.dist executable`
    )
  }
}

function resolveSourceBackendExe(backend, sourceDistDir) {
  const topLevelExe = path.join(sourceDist, `${backend}.exe`)
  if (fs.existsSync(topLevelExe)) {
    return topLevelExe
  }

  const distExe = path.join(sourceDistDir, `${backend}.exe`)
  if (fs.existsSync(distExe)) {
    console.warn(
      `[stage-python-runtime] WARN: Source ${backend}.exe missing, using ${backend}.dist/${backend}.exe`
    )
    return distExe
  }

  return null
}

function stageBackendArtifacts() {
  fs.mkdirSync(stageDist, { recursive: true })

  for (const backend of REQUIRED_BACKENDS) {
    const sourceDistDir = path.join(sourceDist, `${backend}.dist`)
    const sourceExe = resolveSourceBackendExe(backend, sourceDistDir)
    const targetExe = path.join(stageDist, `${backend}.exe`)
    const targetDistDir = path.join(stageDist, `${backend}.dist`)

    ensureExists(sourceDistDir, `Source ${backend}.dist`)
    if (!sourceExe) {
      fail(`Source ${backend}.exe missing in both dist root and ${backend}.dist`)
    }

    removeIfExists(targetExe)
    removeIfExists(targetDistDir)

    fs.copyFileSync(sourceExe, targetExe)
    fs.cpSync(sourceDistDir, targetDistDir, { recursive: true, force: true })
  }
}

function main() {
  ensureExists(sourceDist, 'Source dist directory')

  fs.mkdirSync(stageRoot, { recursive: true })
  for (const staleFile of staleFiles) {
    removeIfExists(staleFile)
  }
  removeIfExists(stageDist)
  stageBackendArtifacts()
  console.log(`[stage-python-runtime] Staged required backend artifacts into ${stageDist}`)

  for (const entry of optionalCopies) {
    stageOptionalFile(entry)
  }

  validateStagedBackends()
  console.log('[stage-python-runtime] Completed successfully')
}

main()
