import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildDarwinPlotParityMatrix,
  normalizeDarwinArchitecture,
  readTargetPlatform as readValidationTargetPlatform,
  resolveInstalledDarwinDist,
  validateDarwinRuntime,
  validateMacBundleResources,
  shouldRunWindowsScriptPlotParity,
} from './validate_release.js'

const RNASEQ_CACHE_FILES = [
  'gene_symbols_human_ensembl.json',
  'gene_symbols_human_entrez.json',
  'gene_symbols_human_uniprot.json',
  'gene_symbols_human_uniprot_swissprot.json',
  'gene_symbols_mouse_ensembl.json',
  'gene_symbols_mouse_entrez.json',
  'gene_symbols_mouse_uniprot.json',
  'gene_symbols_mouse_uniprot_swissprot.json',
]

const RNASEQ_CACHE_METADATA = {
  human_ensembl_ensembl_version: '113',
  mouse_ensembl_ensembl_version: '113',
  human_entrez_source_name: 'NCBI',
  human_uniprot_source_name: 'UniProt',
  human_uniprot_swissprot_source_name: 'Swiss-Prot',
  mouse_entrez_source_name: 'NCBI',
  mouse_uniprot_source_name: 'UniProt',
  mouse_uniprot_swissprot_source_name: 'Swiss-Prot',
}

function writeDarwinRuntimePayload(dist) {
  for (const backend of ['stats', 'rnaseq', 'plot']) {
    const numpyNative = path.join(dist, `${backend}.dist`, 'numpy', 'core', '_multiarray_umath.so')
    fs.mkdirSync(path.dirname(numpyNative), { recursive: true })
    fs.writeFileSync(numpyNative, 'Mach-O fixture')
  }

  const cacheDir = path.join(dist, 'rnaseq.dist', 'rnaseq_module', 'gene_cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'gene_cache_meta.json'), JSON.stringify(RNASEQ_CACHE_METADATA))
  for (const cacheFile of RNASEQ_CACHE_FILES) {
    fs.writeFileSync(path.join(cacheDir, cacheFile), '{}')
  }

  const kaleidoRoot = path.join(dist, 'plot.dist', 'kaleido', 'executable')
  fs.mkdirSync(path.join(kaleidoRoot, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(kaleidoRoot, 'kaleido'), '#!/bin/sh\n')
  for (const nativeFile of [
    'kaleido',
    'libEGL.dylib',
    'libGLESv2.dylib',
    'libswiftshader_libEGL.dylib',
    'libswiftshader_libGLESv2.dylib',
  ]) {
    fs.writeFileSync(path.join(kaleidoRoot, 'bin', nativeFile), 'Mach-O fixture')
  }
}

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
    writeDarwinRuntimePayload(dist)
  }
  const scriptPython = path.join(root, 'bin', 'python3.12')
  const scriptPlot = path.join(root, 'python_embedded', 'plot.py')
  fs.mkdirSync(path.dirname(scriptPython), { recursive: true })
  fs.writeFileSync(scriptPython, '#!/bin/sh\n')
  fs.writeFileSync(scriptPlot, '# plot\n')
  return { sourceDist, stagedDist, appPath, installedDist, scriptPython, scriptPlot }
}

function x86_64Inspector() {
  return 'Mach-O 64-bit executable x86_64\ncmd LC_BUILD_VERSION\n  minos 14.0'
}

function successfulRunner(calls, { emptyExports = false, corruptExports = false } = {}) {
  return ({ command, args, input }) => {
    calls.push({ command, args, input })
    const payload = JSON.parse(input)
    if (payload.output_path) {
      const format = path.extname(payload.output_path).slice(1)
      const validBytes = format === 'pdf'
        ? Buffer.from('%PDF-1.4\n% fixture\n')
        : Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
      fs.writeFileSync(payload.output_path, emptyExports ? '' : corruptExports ? 'corrupt export' : validBytes)
    }
    return { status: 0, stdout: JSON.stringify({ success: true }), stderr: '' }
  }
}

test('resolves installed Darwin runtime in the updater resource path', () => {
  assert.equal(
    resolveInstalledDarwinDist('/Applications/easyCris.app'),
    '/Applications/easyCris.app/Contents/Resources/_up_/bundle_resources/python_embedded/dist'
  )
})

test('release target platform parser rejects missing platform values', () => {
  assert.throws(() => readValidationTargetPlatform(['--platform']), /Missing value for --platform/)
  assert.throws(() => readValidationTargetPlatform(['--platform', '--community']), /Missing value for --platform/)
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

test('normalizes Node Darwin architecture labels to Mach-O labels', () => {
  assert.equal(normalizeDarwinArchitecture('x64'), 'x86_64')
  assert.equal(normalizeDarwinArchitecture('x86_64'), 'x86_64')
  assert.equal(normalizeDarwinArchitecture('arm64'), 'arm64')
  assert.throws(() => normalizeDarwinArchitecture('ia32'), /Unsupported Darwin architecture/)
})

test('Darwin validation always runs compiled source and staged PDF/TIFF exports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const calls = []

  const result = validateDarwinRuntime({
    paths,
    runner: successfulRunner(calls),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.deepEqual(result.errors, [])
  const exportCommands = calls
    .filter(call => JSON.parse(call.input).action === 'export_plot')
    .map(call => path.relative(root, call.command))
  assert.deepEqual(exportCommands, [
    'python_embedded/dist/plot.dist/plot',
    'python_embedded/dist/plot.dist/plot',
    'bundle_resources/python_embedded/dist/plot.dist/plot',
    'bundle_resources/python_embedded/dist/plot.dist/plot',
  ])
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
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.deepEqual(result.errors, [])
  assert.equal(calls.filter(call => JSON.parse(call.input).action === 'export_plot').length, 6)
})

test('Darwin parity accepts a bare PATH command and rejects a missing path-like executable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const calls = []
  const bareCommandResult = validateDarwinRuntime({
    paths: { ...paths, scriptPython: 'python3.12' },
    requireScriptCompiledPlotParity: true,
    runner: successfulRunner(calls),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'bare-probe-output'),
  })
  assert.deepEqual(bareCommandResult.errors, [])
  assert.ok(calls.some(call => call.command === 'python3.12'))

  const missingCommand = path.join(root, 'missing', 'python3.12')
  const missingCalls = []
  const missingPathResult = validateDarwinRuntime({
    paths: { ...paths, scriptPython: missingCommand },
    requireScriptCompiledPlotParity: true,
    runner: successfulRunner(missingCalls),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'missing-probe-output'),
  })
  assert.ok(missingPathResult.errors.some(error => error.includes(missingCommand)))
  assert.equal(missingCalls.some(call => call.command === missingCommand), false)
})

test('Darwin RNA-seq probe uses valid matching IDs and requires success=true', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const calls = []
  const result = validateDarwinRuntime({
    paths,
    runner: successfulRunner(calls),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })
  assert.deepEqual(result.errors, [])
  const rnaPayloads = calls
    .map(call => JSON.parse(call.input))
    .filter(payload => payload.test === 'rnaseq_validate_samples')
  assert.deepEqual(rnaPayloads, [
    { test: 'rnaseq_validate_samples', data: { counts_sample_ids: ['s1'], metadata_sample_ids: ['s1'] }, params: {} },
    { test: 'rnaseq_validate_samples', data: { counts_sample_ids: ['s1'], metadata_sample_ids: ['s1'] }, params: {} },
  ])

  for (const response of [{}, { success: null }, { success: 'true' }, { success: false }]) {
    const rejected = validateDarwinRuntime({
      paths,
      runner: () => ({ status: 0, stdout: JSON.stringify(response), stderr: '' }),
      inspectMachO: x86_64Inspector,
      expectedArchitecture: 'x64',
      probeOutputDir: path.join(root, `rejected-probe-output-${String(response.success)}`),
    })
    assert.ok(rejected.errors.some(error => error.includes('did not report success=true')))
  }
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
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('empty output file')))
  assert.equal(fs.existsSync(generatedLog), false)
  assert.equal(fs.existsSync(unrelatedLog), true)
})

test('Darwin validation rejects nonempty corrupt PDF and TIFF exports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const result = validateDarwinRuntime({
    paths,
    requireScriptCompiledPlotParity: true,
    runner: successfulRunner([], { corruptExports: true }),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })
  assert.ok(result.errors.some(error => error.includes('PDF signature')))
  assert.ok(result.errors.some(error => error.includes('TIFF signature')))
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
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('installed rnaseq.dist executable')))
})

test('Darwin validation cleans installed Kaleido logs and scans full staged and installed resources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const installedLog = path.join(paths.installedDist, 'plot.dist', 'kaleido', 'executable', 'debug.log')
  const installedUnrelatedLog = path.join(paths.installedDist, 'stats.dist', 'backend.log')
  const stagedSibling = path.join(root, 'bundle_resources', 'msedgedriver')
  const installedSibling = path.join(paths.appPath, 'Contents', 'Resources', 'PyWin32_system32')
  fs.mkdirSync(path.dirname(installedLog), { recursive: true })
  fs.mkdirSync(path.dirname(installedUnrelatedLog), { recursive: true })
  fs.mkdirSync(stagedSibling, { recursive: true })
  fs.mkdirSync(installedSibling, { recursive: true })
  fs.writeFileSync(installedLog, 'remove')
  fs.writeFileSync(installedUnrelatedLog, 'keep')

  const result = validateDarwinRuntime({
    paths,
    installedApp: paths.appPath,
    runner: successfulRunner([]),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.equal(fs.existsSync(installedLog), false)
  assert.equal(fs.existsSync(installedUnrelatedLog), true)
  assert.ok(result.errors.some(error => error.includes(stagedSibling)))
  assert.ok(result.errors.some(error => error.includes(installedSibling)))
})

test('Darwin validation rejects missing NumPy, RNA-seq, and Kaleido payloads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  fs.rmSync(path.join(paths.sourceDist, 'stats.dist', 'numpy', 'core', '_multiarray_umath.so'))
  fs.rmSync(path.join(paths.stagedDist, 'rnaseq.dist', 'rnaseq_module', 'gene_cache', 'gene_symbols_human_entrez.json'))
  fs.rmSync(path.join(paths.installedDist, 'plot.dist', 'kaleido', 'executable', 'bin', 'kaleido'))
  fs.rmSync(path.join(paths.stagedDist, 'plot.dist', 'kaleido', 'executable', 'bin', 'libswiftshader_libEGL.dylib'))

  const result = validateDarwinRuntime({
    paths,
    installedApp: paths.appPath,
    runner: successfulRunner([]),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('source stats.dist NumPy native module')))
  assert.ok(result.errors.some(error => error.includes('staged rnaseq.dist rnaseq cache file')))
  assert.ok(result.errors.some(error => error.includes('installed plot.dist Kaleido native executable')))
  assert.ok(result.errors.some(error => error.includes('staged plot.dist Kaleido native payload')))
})

test('Darwin validation rejects incomplete RNA-seq cache metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  fs.writeFileSync(
    path.join(paths.sourceDist, 'rnaseq.dist', 'rnaseq_module', 'gene_cache', 'gene_cache_meta.json'),
    JSON.stringify({ ...RNASEQ_CACHE_METADATA, human_entrez_source_name: '' }),
  )

  const result = validateDarwinRuntime({
    paths,
    runner: successfulRunner([]),
    inspectMachO: x86_64Inspector,
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('source rnaseq.dist rnaseq cache metadata key: human_entrez_source_name')))
})

test('Darwin validation rejects wrong-architecture launchers and native payloads in every tree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const mismatches = new Set([
    path.join(paths.sourceDist, 'stats.dist', 'stats'),
    path.join(paths.stagedDist, 'rnaseq.dist', 'numpy', 'core', '_multiarray_umath.so'),
    path.join(paths.installedDist, 'plot.dist', 'kaleido', 'executable', 'bin', 'libEGL.dylib'),
  ])

  const result = validateDarwinRuntime({
    paths,
    installedApp: paths.appPath,
    runner: successfulRunner([]),
    inspectMachO: target => mismatches.has(target)
      ? 'Mach-O 64-bit executable arm64\ncmd LC_BUILD_VERSION\n  minos 14.0'
      : x86_64Inspector(),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })

  assert.ok(result.errors.some(error => error.includes('source stats.dist executable architecture mismatch')))
  assert.ok(result.errors.some(error => error.includes('staged rnaseq.dist NumPy native module architecture mismatch')))
  assert.ok(result.errors.some(error => error.includes('installed plot.dist Kaleido native payload architecture mismatch')))
})

test('Darwin validation rejects every shipped Mach-O newer than the macOS 14 floor', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = makeFixtureTree(root)
  const incompatible = path.join(paths.sourceDist, 'stats.dist', 'numpy', 'core', '_multiarray_umath.so')
  const result = validateDarwinRuntime({
    paths,
    runner: successfulRunner([]),
    inspectMachO: target => target === incompatible
      ? 'Mach-O 64-bit executable x86_64\ncmd LC_BUILD_VERSION\n  minos 15.0'
      : x86_64Inspector(),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'probe-output'),
  })
  assert.ok(result.errors.some(error => error.includes('minimum macOS version 15.0 exceeds 14.0')))
})

test('macOS resources reject Windows-only payloads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'win32com'), { recursive: true })
  fs.mkdirSync(path.join(root, 'PyWin32_system32'), { recursive: true })
  fs.writeFileSync(path.join(root, 'win32com', 'bridge.dll'), 'windows')
  const errors = validateMacBundleResources(root)
  assert.ok(errors.some(error => error.includes(path.join(root, 'win32com', 'bridge.dll'))))
  assert.ok(errors.some(error => error.includes(path.join(root, 'PyWin32_system32'))))
})

test('Windows community mode retains its existing script parity selection', () => {
  assert.equal(shouldRunWindowsScriptPlotParity({ communityMode: true }), false)
  assert.equal(shouldRunWindowsScriptPlotParity({ communityMode: false }), true)
})
