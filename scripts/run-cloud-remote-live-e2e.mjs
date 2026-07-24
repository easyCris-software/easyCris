#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const liveRelayBaseUrl =
  process.env.E2E_REMOTE_SIGNALING_BASE_URL ?? 'https://remote.easycris.com'

if (process.env.E2E_REMOTE_LIVE !== '1') {
  console.log(
    '[Test] Skipping live cloud remote-session lane: set E2E_REMOTE_LIVE=1 to run'
  )
  process.exit(0)
}

const env = {
  ...process.env,
  E2E_REMOTE_SIGNALING_BASE_URL: liveRelayBaseUrl,
  VITE_REMOTE_SIGNALING_BASE_URL: liveRelayBaseUrl,
  VITE_REMOTE_ICE_CONFIG_URL: `${liveRelayBaseUrl.replace(/\/$/, '')}/v1/remote/ice-config`,
  VITE_REMOTE_FORCE_RELAY: '1',
}

function run(command, args) {
  const result = spawnSync(command, args, {
    env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

run('npm', ['run', '-s', 'e2e:prepare:e2e-binary'])
run('node', [
  'e2e/run-tests.mjs',
  'features/remote/remote-session.cloud-live.local.test.mjs',
  '--mode=e2e',
  '--app-path=src-tauri/target/e2e/release/easycris.exe',
])
