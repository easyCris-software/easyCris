import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const [nvmrc, packageJsonRaw, ciWorkflow, releaseWorkflow, protectedWorkflow] = await Promise.all([
  readFile(new URL('.nvmrc', root), 'utf8'),
  readFile(new URL('package.json', root), 'utf8'),
  readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
  readFile(new URL('.github/workflows/release.yml', root), 'utf8'),
  readFile(new URL('.github/workflows/macos-validation.yml', root), 'utf8'),
])
const packageJson = JSON.parse(packageJsonRaw)

function workflowJob(source, jobName) {
  const marker = `  ${jobName}:`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow job: ${jobName}`)
  const nextJob = /^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/gm
  nextJob.lastIndex = start + marker.length
  const boundary = nextJob.exec(source)?.index
  return source.slice(start, boundary)
}

test('pins Node.js 24 in project toolchain files', () => {
  assert.equal(nvmrc.trim(), '24')
  assert.equal(packageJson.engines?.node, '24.x')
  assert.equal(packageJson.devEngines?.runtime?.name, 'node')
  assert.equal(packageJson.devEngines?.runtime?.version, '24.x')
  assert.equal(packageJson.devEngines?.runtime?.onFail, 'error')
})

function assertNode24AndCleanInstalledTauri(job, label) {
  assert.match(job, /node-version:\s*"24"/, `${label} Node version`)
  assert.doesNotMatch(job, /node-version:\s*"20"/, `${label} stale Node version`)
  const install = job.indexOf('run: npm ci --legacy-peer-deps --no-audit --no-fund')
  const tauri = job.indexOf('run: npm exec -- tauri --version')
  assert.notEqual(install, -1, `${label} npm ci`)
  assert.notEqual(tauri, -1, `${label} Tauri launch`)
  assert.ok(tauri > install, `${label} must launch Tauri after npm ci`)
}

test('routine Windows job pins Node 24 and launches clean-installed Tauri', () => {
  assertNode24AndCleanInstalledTauri(workflowJob(ciWorkflow, 'quality-gates'), 'Windows quality-gates')
})

test('routine macOS matrix pins Node 24 and launches clean-installed Tauri on both architectures', () => {
  assertNode24AndCleanInstalledTauri(workflowJob(ciWorkflow, 'macos-quality-gates'), 'macOS quality-gates')
})

test('protected macOS validation and release workflows pin Node 24 only', () => {
  const protectedJob = workflowJob(protectedWorkflow, 'bundled-runtime-proof')
  assert.match(protectedJob, /node-version:\s*"24"/)
  assert.doesNotMatch(protectedJob, /node-version:\s*"20"/)
  assert.match(releaseWorkflow, /NODE_VERSION:\s*"24"/)
  assert.doesNotMatch(releaseWorkflow, /NODE_VERSION:\s*"20"/)
  assert.doesNotMatch(releaseWorkflow + packageJsonRaw, /">=24"/)
})
