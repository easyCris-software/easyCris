#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const tauriDir = path.join(rootDir, 'src-tauri')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const tauriBuildArgs = ['@tauri-apps/cli', 'build', '--config', 'src-tauri/tauri.release.nsis.conf.json']
const rustObfuscationEnabled = process.env.EASYCRIS_ENABLE_RUST_OBFUSCATE === '1'
const easycrisObfuscationKey = process.env.EASYCRIS_LITCRYPT_KEY
const litcryptObfuscationKey = process.env.LITCRYPT_ENCRYPT_KEY

if (
  easycrisObfuscationKey &&
  litcryptObfuscationKey &&
  easycrisObfuscationKey !== litcryptObfuscationKey
) {
  console.error(
    '[tauri-build-release-nsis] EASYCRIS_LITCRYPT_KEY and LITCRYPT_ENCRYPT_KEY are both set but differ'
  )
  process.exit(1)
}

const obfuscationKey = easycrisObfuscationKey ?? litcryptObfuscationKey

if (rustObfuscationEnabled) {
  if (!obfuscationKey) {
    console.error(
      '[tauri-build-release-nsis] Set EASYCRIS_LITCRYPT_KEY (or LITCRYPT_ENCRYPT_KEY) when EASYCRIS_ENABLE_RUST_OBFUSCATE=1'
    )
    process.exit(1)
  }
  tauriBuildArgs.push('--features', 'obfuscate')
}

const skipPythonCompile = process.env.EASYCRIS_SKIP_PYTHON_COMPILE === '1'

if (skipPythonCompile) {
  console.log('[tauri-build-release-nsis] Skipping Python compilation (EASYCRIS_SKIP_PYTHON_COMPILE=1)')
} else {
  run('npm', ['run', 'compile-python'])
}
run('node', ['scripts/stage_python_runtime.mjs'])

const tauriBuildEnv = {
  ...process.env,
  EASYCRIS_BUILD_PROFILE: 'release',
}

if (rustObfuscationEnabled && obfuscationKey) {
  tauriBuildEnv.LITCRYPT_ENCRYPT_KEY = obfuscationKey
} else {
  delete tauriBuildEnv.LITCRYPT_ENCRYPT_KEY
}

run('npx', tauriBuildArgs, {
  cwd: rootDir,
  env: tauriBuildEnv,
})

run('node', ['scripts/validate_release.js', '--require-frontend-dist'])
