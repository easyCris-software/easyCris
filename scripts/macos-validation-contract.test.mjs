import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(
  new URL('../.github/workflows/macos-validation.yml', import.meta.url),
  'utf8'
)
const ciWorkflow = await readFile(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8'
)

test('protected validation targets native Intel and Apple Silicon only', () => {
  assert.match(workflow, /runner:\s*macos-15-intel/)
  assert.match(workflow, /rust_target:\s*x86_64-apple-darwin/)
  assert.match(workflow, /runner:\s*macos-15/)
  assert.match(workflow, /rust_target:\s*aarch64-apple-darwin/)
  assert.doesNotMatch(workflow, /runner:\s*macos-14/)
  assert.doesNotMatch(workflow, /windows-latest/)
})

test('protected validation provisions, stages, builds, signs, and validates', () => {
  assert.match(workflow, /provision-python:macos/)
  assert.match(workflow, /stage_python_runtime\.mjs/)
  assert.match(workflow, /validate_release\.js/)
  assert.match(workflow, /--bundles app/)
  assert.match(workflow, /tauri\.validation\.macos\.conf\.json/)
  assert.match(workflow, /codesign/)
  assert.match(workflow, /--installed-app/)
  assert.match(workflow, /bundled_runtime/)
  assert.match(workflow, /gseapy-dependency-smoke\.mjs/)
  assert.doesNotMatch(workflow, /@tauri-apps\/cli@2/)
})

test('protected validation never mutates public releases or private E2E', () => {
  for (const forbidden of [
    'softprops/action-gh-release',
    'latest.json',
    'TAURI_SIGNING_PRIVATE_KEY',
    'APPLE_CERTIFICATE',
    'notarytool submit',
    'npm run -s e2e',
    'e2e/run-tests',
    'e2e/macos',
  ]) {
    assert.equal(workflow.includes(forbidden), false, forbidden)
  }
  // Leak gate may list private path prefixes; it must not execute private suites.
  assert.match(workflow, /git ls-files \| grep -E '\^\(e2e\//)
  assert.match(workflow, /validation\/macos\/\*\*/)
  assert.match(workflow, /validation\/ci\/\*\*/)
})

test('routine CI stays free of protected provisioning steps', () => {
  const macosStart = ciWorkflow.indexOf('  macos-quality-gates:')
  assert.notEqual(macosStart, -1)
  const nextJob = /^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/gm
  nextJob.lastIndex = macosStart + 1
  const boundary = nextJob.exec(ciWorkflow)?.index
  const macosJob = ciWorkflow.slice(macosStart, boundary)
  assert.equal(macosJob.includes('provision-python:macos'), false)
  assert.equal(macosJob.includes('codesign'), false)
  assert.equal(macosJob.includes('--installed-app'), false)
})
