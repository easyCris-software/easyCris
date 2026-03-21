#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const tauriDir = path.join(rootDir, 'src-tauri')
const e2eTargetDir = path.join(tauriDir, 'target', 'e2e')

const result = spawnSync('npx', ['tauri', 'build', '--config', 'tauri.e2e.conf.json', '--no-bundle'], {
  cwd: tauriDir,
  env: {
    ...process.env,
    EASYCRIS_BUILD_PROFILE: 'e2e',
    CARGO_TARGET_DIR: e2eTargetDir,
  },
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

process.exit(result.status ?? 1)
