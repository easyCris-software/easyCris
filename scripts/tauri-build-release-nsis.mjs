#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const tauriDir = path.join(rootDir, 'src-tauri')

function cleanKaleidoRuntimeLogs() {
  const roots = [
    path.join(rootDir, 'python_embedded', 'dist', 'plot.dist', 'kaleido', 'executable'),
    path.join(rootDir, 'bundle_resources', 'python_embedded', 'dist', 'plot.dist', 'kaleido', 'executable'),
  ]

  const removeLogs = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        removeLogs(entryPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.log')) {
        fs.rmSync(entryPath, { force: true })
      }
    }
  }

  for (const root of roots) {
    if (fs.existsSync(root)) {
      removeLogs(root)
      continue
    }
  }
}

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

run('npx', tauriBuildArgs, {
  cwd: rootDir,
  env: tauriBuildEnv,
})

cleanKaleidoRuntimeLogs()
run('node', ['scripts/validate_release.js', '--require-frontend-dist', '--community'])


