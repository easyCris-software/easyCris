import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const [nvmrc, packageJsonRaw, ciWorkflow, releaseWorkflow] = await Promise.all([
  readFile(new URL('.nvmrc', root), 'utf8'),
  readFile(new URL('package.json', root), 'utf8'),
  readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
  readFile(new URL('.github/workflows/release.yml', root), 'utf8'),
])
const packageJson = JSON.parse(packageJsonRaw)

test('pins Node.js 24 in project toolchain files', () => {
  assert.equal(nvmrc.trim(), '24')
  assert.equal(packageJson.engines?.node, '24.x')
  assert.equal(packageJson.devEngines?.runtime?.name, 'node')
  assert.equal(packageJson.devEngines?.runtime?.version, '24.x')
  assert.equal(packageJson.devEngines?.runtime?.onFail, 'error')
})

test('routine CI and release workflows pin Node 24 only', () => {
  assert.match(ciWorkflow, /node-version:\s*"24"/)
  assert.equal((ciWorkflow.match(/node-version:\s*"24"/g) || []).length >= 2, true)
  assert.doesNotMatch(ciWorkflow, /node-version:\s*"20"/)
  assert.match(releaseWorkflow, /NODE_VERSION:\s*"24"/)
  assert.doesNotMatch(releaseWorkflow, /NODE_VERSION:\s*"20"/)
  assert.doesNotMatch(ciWorkflow + releaseWorkflow + packageJsonRaw, /">=24"/)
})
