import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8'
)

function macosQualityJob(source) {
  const start = source.indexOf('  macos-quality-gates:')
  if (start === -1) return undefined

  const nextJob = /^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/gm
  nextJob.lastIndex = start + 1
  const boundary = nextJob.exec(source)?.index
  return source.slice(start, boundary)
}

test('preserves Windows and adds native Intel and Apple Silicon macOS lanes', () => {
  assert.match(workflow, /\n  quality-gates:[\s\S]*?runs-on:\s*windows-latest/)
  const macosJob = macosQualityJob(workflow)
  assert.notEqual(macosJob, undefined)
  assert.match(macosJob, /name:\s*macos-community-quality-gates/)
  assert.match(
    macosJob,
    /- runner:\s*macos-15-intel\s+rust_target:\s*x86_64-apple-darwin\s+suffix:\s*x86_64/
  )
  assert.match(
    macosJob,
    /- runner:\s*macos-15\s+rust_target:\s*aarch64-apple-darwin\s+suffix:\s*aarch64/
  )
  assert.doesNotMatch(macosJob, /runner:\s*macos-14/)
})

test('macOS PR quality lane excludes private E2E and expensive release work', () => {
  const macosJob = macosQualityJob(workflow)
  assert.notEqual(macosJob, undefined)
  assert.equal(macosJob.includes('if: matrix.'), false, 'matrix-specific step')
  assert.equal(macosJob.includes('continue-on-error'), false, 'allowed failure')
  for (const forbidden of [
    'e2e/',
    'bootstrap-python:macos',
    'compile-python:macos',
    'tauri:build:macos',
    '_tmp/nuitka',
    'provision-python:macos',
    'softprops/action-gh-release',
    'latest.json',
    'APPLE_CERTIFICATE',
    'TAURI_SIGNING_PRIVATE_KEY',
  ]) {
    assert.equal(macosJob.includes(forbidden), false, forbidden)
  }
})

test('public CI enforces cross-platform third-party license synchronization', () => {
  const macosJob = macosQualityJob(workflow)
  assert.notEqual(macosJob, undefined)
  assert.match(macosJob, /npm run -s license:check-sync/)
  assert.match(macosJob, /check-third-party-license-sync\.test\.mjs/)
})

test('macOS fast job boundary excludes protected sibling contents', () => {
  const workflowWithProtectedSibling = `${workflow}

  protected-native-validation:
    steps:
      - run: npm run -s compile-python:macos -- --backend stats
`
  const macosJob = macosQualityJob(workflowWithProtectedSibling)
  assert.notEqual(macosJob, undefined)
  assert.equal(macosJob.includes('compile-python:macos'), false)
})

test('macOS fast lane runs provisioner mocks and bundled-mode Rust tests', () => {
  const macosJob = macosQualityJob(workflow)
  assert.notEqual(macosJob, undefined)
  assert.match(macosJob, /test:python-runtime:macos/)
  assert.match(macosJob, /bundled_runtime/)
  assert.match(macosJob, /backend_mode/)
  assert.match(macosJob, /choose_backend_mode/)
})
