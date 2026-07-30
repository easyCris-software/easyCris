import test from 'node:test'
import assert from 'node:assert/strict'
import {
  backendArtifactPaths,
  cleanTransientKaleidoLogs,
  isTransientKaleidoLog,
  stagePythonRuntime,
} from './stage_python_runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('resolves Windows backend layout', () => {
  assert.deepEqual(backendArtifactPaths('/tmp/dist', 'stats', 'win32'), {
    topLevel: '/tmp/dist/stats.exe',
    distDirectory: '/tmp/dist/stats.dist',
    distExecutable: '/tmp/dist/stats.dist/stats.exe',
  })
})

test('resolves Darwin backend layout', () => {
  assert.deepEqual(backendArtifactPaths('/tmp/dist', 'stats', 'darwin'), {
    topLevel: '/tmp/dist/stats',
    distDirectory: '/tmp/dist/stats.dist',
    distExecutable: '/tmp/dist/stats.dist/stats',
  })
})

test('recognizes only transient Kaleido logs', () => {
  assert.equal(isTransientKaleidoLog('plot.dist/kaleido/executable/debug.log'), true)
  assert.equal(isTransientKaleidoLog('plot.dist/kaleido/executable/chrome_debug.log'), true)
  assert.equal(isTransientKaleidoLog('plot.dist/kaleido/executable/kaleido'), false)
  assert.equal(isTransientKaleidoLog('stats.dist/backend.log'), false)
})

test('cleans logs only below generated Kaleido roots', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const kaleidoRoot = path.join(root, 'plot.dist', 'kaleido', 'executable')
  const transient = path.join(kaleidoRoot, 'debug.log')
  const unrelated = path.join(root, 'stats.dist', 'backend.log')
  fs.mkdirSync(kaleidoRoot, { recursive: true })
  fs.mkdirSync(path.dirname(unrelated), { recursive: true })
  fs.writeFileSync(transient, 'remove')
  fs.writeFileSync(unrelated, 'keep')

  assert.equal(cleanTransientKaleidoLogs([root]), 1)
  assert.equal(fs.existsSync(transient), false)
  assert.equal(fs.existsSync(unrelated), true)
})

test('stages extensionless Darwin artifacts without copying the Windows interpreter', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceDist = path.join(root, 'python_embedded', 'dist')
  for (const backend of ['stats', 'rnaseq', 'plot']) {
    const executable = path.join(sourceDist, `${backend}.dist`, backend)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, `${backend}-fake`)
  }
  fs.writeFileSync(path.join(root, 'python_embedded', 'python.exe'), 'windows-only')
  const generatedLog = path.join(sourceDist, 'plot.dist', 'kaleido', 'executable', 'debug.log')
  const unrelatedLog = path.join(sourceDist, 'stats.dist', 'backend.log')
  fs.mkdirSync(path.dirname(generatedLog), { recursive: true })
  fs.writeFileSync(generatedLog, 'remove')
  fs.writeFileSync(unrelatedLog, 'keep')

  const result = stagePythonRuntime({ root, platform: 'darwin' })

  assert.equal(fs.existsSync(path.join(result.stageDist, 'plot.dist', 'plot')), true)
  assert.equal(fs.existsSync(path.join(result.stageDist, 'plot')), true)
  assert.equal(fs.existsSync(path.join(result.stageRoot, 'python.exe')), false)
  assert.equal(fs.existsSync(generatedLog), false)
  assert.equal(fs.existsSync(unrelatedLog), true)
})
