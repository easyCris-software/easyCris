#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const tauriDir = path.join(rootDir, 'src-tauri')
const devTauriConfigPath = path.join(tauriDir, 'tauri.dev.conf.json')
const args = process.argv.slice(2)

function hasConfigArg(argv) {
  return argv.some(
    arg => arg === '--config' || arg === '-c' || arg.startsWith('--config=')
  )
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    console.error(`[tauri-cli] Failed to read ${filePath}: ${error.message}`)
    process.exit(1)
  }
}

function validateDevConfig() {
  const baseConfig = readJson(
    path.join(rootDir, 'src-tauri', 'tauri.conf.json')
  )
  const devConfig = readJson(devTauriConfigPath)

  if (!devConfig.identifier || typeof devConfig.identifier !== 'string') {
    console.error(
      '[tauri-cli] tauri.dev.conf.json must set a distinct top-level identifier'
    )
    process.exit(1)
  }

  if (devConfig.identifier === baseConfig.identifier) {
    console.error(
      `[tauri-cli] Dev identifier must differ from production identifier (${baseConfig.identifier})`
    )
    process.exit(1)
  }

  if (
    devConfig.productName &&
    devConfig.productName !== baseConfig.productName
  ) {
    console.error(
      '[tauri-cli] Do not rename the dev product; scripts expect easycris.exe'
    )
    process.exit(1)
  }
}

const tauriArgs = [...args]
if (tauriArgs[0] === 'dev' && !hasConfigArg(tauriArgs)) {
  validateDevConfig()
  tauriArgs.push('--config', 'tauri.dev.conf.json')
}

const result = spawnSync('npx', ['tauri', ...tauriArgs], {
  cwd: tauriArgs[0] === 'dev' ? tauriDir : rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error(`[tauri-cli] Failed to start Tauri CLI: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
