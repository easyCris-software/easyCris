import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildDarwinPlotParityMatrix,
  resolveInstalledDarwinDist,
  validateDarwinRuntime,
  validateMacBundleResources,
  shouldRunWindowsScriptPlotParity,
} from './validate_release.js'

function makeFixtureTree(root) {
  const sourceDist = path.join(root, 'python_embedded', 'dist')
  const stagedDist = path.join(root, 'bundle_resources', 'python_embedded', 'dist')
  const appPath = path.join(root, 'easyCris.app')
  const installedDist = resolveInstalledDarwinDist(appPath)
  for (const dist of [sourceDist, stagedDist, installedDist]) {
    for (const backend of ['stats', 'rnaseq', 'plot']) {
      const executable = path.join(dist, `${backend}.dist`, backend)
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      fs.writeFileSync(executable, '#!/bin/sh\n')
    }
  }
  const scriptPython = path.join(root, 'bin', 'python3.12')
  const scriptPlot = path.join(root, 'python_embedded', 'plot.py')
  fs.mkdirSync(path.dirname(scriptPython), { recursive: true })
  fs.writeFileSync(scriptPython, '#!/bin/sh\n')
  fs.writeFileSync(scriptPlot, '# plot\n')
  return { sourceDist, stagedDist, appPath, installedDist, scriptPython, scriptPlot }
}

function successfulRunner(calls, { emptyExports = false } = {}) {
  return ({ command, args, input }) => {
    calls.push({ command, args, input })
    const payload = JSON.parse(input)
    if (payload.output_path) fs.writeFileSync(payload.output_path, emptyExports ? '' : 'export')
    return { status: 0, stdout: JSON.stringify({ success: true }), stderr: '' }
  }
}

test('resolves installed Darwin runtime in the updater resource path', () => {
  assert.equal(
    resolveInstalledDarwinDist('/Applications/easyCris.app'),
    '/Applications/easyCris.app/Contents/Resources/_up_/bundle_resources/python_embedded/dist'
  )
})

test('builds script and compiled Darwin PDF/TIFF parity probes', () => {
  const paths = {
    scriptPython: 'python3.12',
    scriptPlot: 'python_embedded/plot.py',
    sourceDist: 'python_embedded/dist',
    stagedDist: 'bundle_resources/python_embedded/dist',
  }
  assert.deepEqual(
    buildDarwinPlotParityMatrix(paths).map(probe => `${probe.scope}:${probe.format}`),
    [
      'script:pdf',
      'script:tiff',
      'source-compiled:pdf',
      'source-compiled:tiff',
      'staged-compiled:pdf',
      'staged-compiled:tiff',
    ]
  )
})

test('Darwin community validation runs all script and compiled PDF/TIFF parity probes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const calls = []

  const result = validateDarwinRuntime({
    paths,
    requireScriptCompiledPlotParity: true,
    runner: successfulRunner(calls),
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.deepEqual(result.errors, [])
  assert.equal(calls.filter(call => JSON.parse(call.input).action === 'export_plot').length, 6)
})

test('Darwin RNA-seq availability probe preserves its non-success result allowance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const result = validateDarwinRuntime({
    paths,
    runner: ({ input }) => {
      const payload = JSON.parse(input)
      return payload.test === 'rnaseq_deseq2'
        ? { status: 0, stdout: JSON.stringify({ success: false, error: 'expected fixture response' }), stderr: '' }
        : { status: 0, stdout: JSON.stringify({ success: true }), stderr: '' }
    },
    probeOutputDir: path.join(root, 'probe-output'),
  })
  assert.deepEqual(result.errors, [])
})

test('Darwin validation removes only generated Kaleido logs and rejects empty exports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const generatedLog = path.join(paths.sourceDist, 'plot.dist', 'kaleido', 'executable', 'debug.log')
  const unrelatedLog = path.join(paths.sourceDist, 'stats.dist', 'backend.log')
  fs.mkdirSync(path.dirname(generatedLog), { recursive: true })
  fs.writeFileSync(generatedLog, 'transient')
  fs.writeFileSync(unrelatedLog, 'keep')

  const result = validateDarwinRuntime({
    paths,
    requireScriptCompiledPlotParity: true,
    runner: successfulRunner([], { emptyExports: true }),
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('empty output file')))
  assert.equal(fs.existsSync(generatedLog), false)
  assert.equal(fs.existsSync(unrelatedLog), true)
})

test('Darwin validation rejects a missing installed backend', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  fs.rmSync(path.join(paths.installedDist, 'rnaseq.dist', 'rnaseq'))

  const result = validateDarwinRuntime({
    paths,
    installedApp: paths.appPath,
    runner: successfulRunner([]),
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('installed rnaseq.dist executable')))
})

test('macOS resources reject Windows-only payloads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'win32com'), { recursive: true })
  fs.mkdirSync(path.join(root, 'pywin32'), { recursive: true })
  fs.writeFileSync(path.join(root, 'win32com', 'bridge.dll'), 'windows')
  const errors = validateMacBundleResources(root)
  assert.ok(errors.some(error => error.includes(path.join(root, 'win32com', 'bridge.dll'))))
  assert.ok(errors.some(error => error.includes(path.join(root, 'pywin32'))))
})

test('Windows community mode retains its existing script parity selection', () => {
  assert.equal(shouldRunWindowsScriptPlotParity({ communityMode: true }), false)
  assert.equal(shouldRunWindowsScriptPlotParity({ communityMode: false }), true)
})
