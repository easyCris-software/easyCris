#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const tauriDir = path.join(rootDir, 'src-tauri')
const e2eTargetDir = path.join(tauriDir, 'target', 'e2e')
const baseTauriConfigPath = path.join(tauriDir, 'tauri.conf.json')
const e2eTauriConfigPath = path.join(tauriDir, 'tauri.e2e.conf.json')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    console.error(
      `[tauri-build-e2e] Failed to read ${filePath}: ${error.message}`
    )
    process.exit(1)
  }
}

function validateE2eTauriConfig() {
  const baseConfig = readJson(baseTauriConfigPath)
  const e2eConfig = readJson(e2eTauriConfigPath)

  if (!e2eConfig.identifier || typeof e2eConfig.identifier !== 'string') {
    console.error(
      '[tauri-build-e2e] tauri.e2e.conf.json must set a distinct top-level identifier'
    )
    process.exit(1)
  }

  if (e2eConfig.identifier === baseConfig.identifier) {
    console.error(
      `[tauri-build-e2e] E2E identifier must differ from production identifier (${baseConfig.identifier})`
    )
    process.exit(1)
  }

  if (
    e2eConfig.productName &&
    e2eConfig.productName !== baseConfig.productName
  ) {
    console.error(
      '[tauri-build-e2e] Do not rename the E2E product; E2E scripts expect easycris.exe'
    )
    process.exit(1)
  }
}

validateE2eTauriConfig()



const result = spawnSync(
  'npx',
  ['tauri', 'build', '--config', 'tauri.e2e.conf.json', '--no-bundle'],
  {
    cwd: tauriDir,
    env: {
      ...process.env,
      EASYCRIS_BUILD_PROFILE: 'e2e',
      VITE_REMOTE_FORCE_RELAY:
        process.env.VITE_REMOTE_FORCE_RELAY ??
        (process.env.E2E_REMOTE_LIVE === '1' ? '1' : '0'),
      CARGO_TARGET_DIR: e2eTargetDir,
      // Tauri build emits a release-profile binary. Keep release builds unchanged,
      // but avoid full release LTO in the isolated e2e target directory.
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
      CARGO_PROFILE_RELEASE_LTO: 'false',
      CARGO_PROFILE_RELEASE_STRIP: 'false',
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
)

process.exit(result.status ?? 1)

