#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const localRelayBaseUrl =
  process.env.E2E_REMOTE_SIGNALING_BASE_URL ?? 'http://127.0.0.1:48980'

const env = {
  ...process.env,
  E2E_REMOTE_PROTOCOL_LINK_CLOUD: '1',
  E2E_REMOTE_SIGNALING_BASE_URL: localRelayBaseUrl,
  VITE_REMOTE_SIGNALING_BASE_URL: localRelayBaseUrl,
  VITE_REMOTE_ICE_CONFIG_URL: `${localRelayBaseUrl.replace(/\/$/, '')}/v1/remote/ice-config`,
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
  'features/remote/remote.protocol-link-cloud.local.test.mjs',
  '--mode=e2e',
  '--app-path=src-tauri/target/e2e/release/easycris.exe',
])
