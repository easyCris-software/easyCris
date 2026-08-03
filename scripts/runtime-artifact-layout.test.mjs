import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  backendArtifactPaths,
  cleanTransientKaleidoLogs,
  isTransientKaleidoLog,
  readTargetPlatform as readStageTargetPlatform,
  runtimeManifestContext,
  runtimeTreeSha256,
  stagePythonRuntime,
} from './stage_python_runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_REQUIREMENTS = Object.fromEntries([
  'requirements-macos.txt',
  'requirements-rnaseq.txt',
  'requirements-macos-x86_64.lock',
  'requirements-macos-arm64.lock',
].map(name => [name, 'a'.repeat(64)]))
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function copyTask5FingerprintInputs(root) {
  const sourceRoot = path.join(PROJECT_ROOT, 'python_embedded')
  const copies = [
    ...['requirements-macos.txt', 'requirements-rnaseq.txt', 'requirements-macos-x86_64.lock', 'requirements-macos-arm64.lock', 'stats.py', 'rnaseq.py', 'plot.py', 'platform_trust.py', 'plot_exporter.py'].map(name => path.join('python_embedded', name)),
    ...['statistics_module', 'rnaseq_module', 'plots_module'].map(name => path.join('python_embedded', name)),
    'scripts/bootstrap_python_macos.py',
    'scripts/apply_rnaseq_pydeseq2_patch.py',
    'scripts/validate_rnaseq_runtime.py',
    'scripts/rnaseq_patches/pydeseq2_0_5_3',
  ]
  for (const relative of copies) {
    const source = relative.startsWith('python_embedded/')
      ? path.join(sourceRoot, relative.slice('python_embedded/'.length))
      : path.join(PROJECT_ROOT, relative)
    const destination = path.join(root, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, { recursive: true })
  }
}

function task5FingerprintContext(root) {
  return runtimeManifestContext(root, {
    headSha: 'b'.repeat(40),
    dirtyEntries: [],
    cleanTree: true,
    dirtyEntryCount: 0,
    architecture: 'x86_64',
  })
}

function pythonTask5Fingerprint(root) {
  return spawnSync('python3', ['-c', [
    'from pathlib import Path',
    'import sys',
    "sys.path.insert(0, 'scripts')",
    'import bootstrap_python_macos as bootstrap',
    "print(bootstrap.compute_content_fingerprint(Path('.'), 'x86_64'))",
  ].join('\n')], { cwd: root, encoding: 'utf8' })
}

function pythonRuntimeTreeDigest(runtime) {
  return spawnSync('python3', ['-c', [
    'from pathlib import Path',
    'import sys',
    "sys.path.insert(0, 'scripts')",
    'import bootstrap_python_macos as bootstrap',
    'print(bootstrap.runtime_tree_sha256(Path(sys.argv[1])))',
  ].join('\n'), runtime], { cwd: PROJECT_ROOT, encoding: 'utf8' })
}

function writeDarwinRuntime(root, { includeTask5KeptPaths = false, includeInterpreterMachAliases = false } = {}) {
  const runtime = path.join(root, 'python_embedded', 'runtime')
  const python = path.join(runtime, 'bin', 'python3.12')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(python, includeInterpreterMachAliases ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]) : '#!/bin/sh\n')
  fs.chmodSync(python, 0o755)
  fs.symlinkSync('python3.12', path.join(runtime, 'bin', 'python3'))
  if (includeInterpreterMachAliases) fs.symlinkSync('python3.12', path.join(runtime, 'bin', 'python'))
  for (const module of ['stats', 'rnaseq', 'plot']) {
    const modulePath = path.join(runtime, 'lib', 'python3.12', 'site-packages', `${module}.py`)
    fs.mkdirSync(path.dirname(modulePath), { recursive: true })
    fs.writeFileSync(modulePath, '# module\n')
  }
  fs.mkdirSync(path.join(runtime, 'kaleido', 'executable'), { recursive: true })
  const nativeRelative = 'kaleido/executable/bin/kaleido'
  const native = path.join(runtime, nativeRelative)
  fs.mkdirSync(path.dirname(native), { recursive: true })
  fs.writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  if (includeTask5KeptPaths) {
    const activate = path.join(runtime, 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
    const statsmodelsArchive = path.join(runtime, 'lib', 'python3.12', 'site-packages', 'statsmodels', 'sandbox', 'archive', '__init__.py')
    fs.mkdirSync(path.dirname(activate), { recursive: true })
    fs.mkdirSync(path.dirname(statsmodelsArchive), { recursive: true })
    fs.writeFileSync(activate, '# CPython virtual-environment activation script retained by Task 5\n')
    fs.writeFileSync(statsmodelsArchive, '# Statsmodels archive package retained by Task 5\n')
  }
  const nativeRecords = [
    nativeRelative,
    ...(includeInterpreterMachAliases ? ['bin/python', 'bin/python3', 'bin/python3.12'] : []),
  ].sort().map(relative => ({
    architectures: ['x86_64'],
    minimum_macos_versions: ['14.0'],
    path: relative,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, relative))).digest('hex'),
  }))
  const manifest = {
    schema_version: 1,
    head_sha: 'b'.repeat(40),
    clean_tree: true,
    dirty_entry_count: 0,
    architecture: 'x86_64',
    support_floor: '14.0',
    development_reuse: false,
    content_fingerprint: 'd'.repeat(64),
    interpreter: { path: 'bin/python3.12', version: '3.12.13', architectures: ['x86_64'], minimum_macos_versions: ['14.0'] },
    archive: fixtureManifestContext(root).archive,
    requirements_sha256: FIXTURE_REQUIREMENTS,
    wheel_archive_sha256: { 'fixture.whl': 'e'.repeat(64) },
    intel_gseapy_source_build: { source_filename: 'gseapy-1.1.11.tar.gz', source_sha256: 'd36a164ee466f7ea6deadfe82ea041f3328ee937ff4c9de862b3e6e2825df0dd', wheel: { filename: 'fixture.whl', sha256: 'f'.repeat(64) } },
    backend_sources: fixtureManifestContext(root).backendSources,
    runtime_distributions: [{ name: 'fixture', version: '1.0' }],
    universal_macho_thinning: [],
    macho_inventory: { count: nativeRecords.length, sha256: crypto.createHash('sha256').update(JSON.stringify(nativeRecords)).digest('hex'), kaleido_helpers: [nativeRelative], files: nativeRecords },
    probe_results: { stats: { success: true }, rnaseq: { success: true }, plot: { success: true }, pdf: { success: true }, tiff: { success: true } },
  }
  manifest.runtime_tree_sha256 = runtimeTreeSha256(runtime)
  fs.writeFileSync(path.join(runtime, 'easycris_runtime_manifest.json'), JSON.stringify(manifest))
  return runtime
}

function fixtureManifestContext(root) {
  return runtimeManifestContext(root, {
    headSha: 'b'.repeat(40),
    dirtyEntries: [],
    cleanTree: true,
    dirtyEntryCount: 0,
    requirementsSha256: FIXTURE_REQUIREMENTS,
    architecture: 'x86_64',
    contentFingerprint: 'd'.repeat(64),
    backendSources: { files: ['fixture.py'], sha256: 'c'.repeat(64) },
  })
}

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

test('runtime tree digest survives Tauri symlink dereferencing and empty-directory elision', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-runtime-digest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const staged = path.join(root, 'staged')
  const installed = path.join(root, 'installed')
  fs.mkdirSync(path.join(staged, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(staged, 'lib', 'empty'), { recursive: true })
  const interpreter = path.join(staged, 'bin', 'python3.12')
  fs.writeFileSync(interpreter, 'fixture interpreter')
  fs.chmodSync(interpreter, 0o755)
  fs.symlinkSync('python3.12', path.join(staged, 'bin', 'python'))
  fs.symlinkSync('python3.12', path.join(staged, 'bin', 'python3'))
  const manDirectory = path.join(staged, 'share', 'man', 'man1')
  fs.mkdirSync(manDirectory, { recursive: true })
  fs.writeFileSync(path.join(manDirectory, 'python3.12.1'), 'fixture manual')
  fs.chmodSync(path.join(manDirectory, 'python3.12.1'), 0o644)
  fs.symlinkSync('python3.12.1', path.join(manDirectory, 'python3.1'))
  fs.writeFileSync(path.join(staged, '\uE000.py'), 'private-use fixture')
  fs.writeFileSync(path.join(staged, '\u{10000}.py'), 'non-BMP fixture')

  fs.cpSync(staged, installed, { recursive: true })
  for (const [alias, target] of [
    ['bin/python', 'bin/python3.12'],
    ['bin/python3', 'bin/python3.12'],
    ['share/man/man1/python3.1', 'share/man/man1/python3.12.1'],
  ]) {
    fs.rmSync(path.join(installed, alias))
    fs.copyFileSync(path.join(installed, target), path.join(installed, alias))
  }
  fs.rmSync(path.join(installed, 'lib', 'empty'), { recursive: true })

  assert.equal(runtimeTreeSha256(installed), runtimeTreeSha256(staged))
  const stagedPython = pythonRuntimeTreeDigest(staged)
  const installedPython = pythonRuntimeTreeDigest(installed)
  assert.equal(stagedPython.status, 0, stagedPython.stderr)
  assert.equal(installedPython.status, 0, installedPython.stderr)
  assert.equal(stagedPython.stdout.trim(), runtimeTreeSha256(staged))
  assert.equal(installedPython.stdout.trim(), runtimeTreeSha256(installed))
})

test('runtime tree digest rejects escaped symlinks before reading their targets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-runtime-digest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = path.join(root, 'runtime')
  const external = path.join(root, 'external.py')
  fs.mkdirSync(runtime)
  fs.writeFileSync(external, 'external content')
  fs.symlinkSync(external, path.join(runtime, 'escape.py'))
  const originalReadFile = fs.readFileSync
  let externalRead = false
  fs.readFileSync = (target, ...args) => {
    if (path.resolve(String(target)) === external) externalRead = true
    return originalReadFile(target, ...args)
  }
  t.after(() => { fs.readFileSync = originalReadFile })

  assert.throws(() => runtimeTreeSha256(runtime), /symlink escapes runtime/)
  assert.equal(externalRead, false)
})

test('runtime tree digest still detects packaged file content and executable-mode changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-runtime-digest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = path.join(root, 'runtime')
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true })
  const interpreter = path.join(runtime, 'bin', 'python3.12')
  fs.writeFileSync(interpreter, 'fixture interpreter')
  fs.chmodSync(interpreter, 0o755)
  fs.symlinkSync('python3.12', path.join(runtime, 'bin', 'python'))
  const originalDigest = runtimeTreeSha256(runtime)

  fs.writeFileSync(interpreter, 'tampered interpreter')
  assert.notEqual(runtimeTreeSha256(runtime), originalDigest)
  fs.writeFileSync(interpreter, 'fixture interpreter')
  fs.chmodSync(interpreter, 0o644)
  assert.notEqual(runtimeTreeSha256(runtime), originalDigest)
})

test('recognizes only transient Kaleido logs', () => {
  assert.equal(isTransientKaleidoLog('plot.dist/kaleido/executable/debug.log'), true)
  assert.equal(isTransientKaleidoLog('plot.dist/kaleido/executable/chrome_debug.log'), true)
  assert.equal(isTransientKaleidoLog('plot.dist/kaleido/executable/kaleido'), false)
  assert.equal(isTransientKaleidoLog('stats.dist/backend.log'), false)
})

test('staging target platform parser rejects missing platform values', () => {
  assert.throws(() => readStageTargetPlatform(['--platform']), /Missing value for --platform/)
  assert.throws(() => readStageTargetPlatform(['--platform', '--other']), /Missing value for --platform/)
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

test('stages a Darwin runtime without copying Windows artifacts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceRuntime = writeDarwinRuntime(root)
  fs.writeFileSync(path.join(root, 'python_embedded', 'python.exe'), 'windows-only')
  const staleStagedPython = path.join(root, 'bundle_resources', 'python_embedded', 'python.exe')
  fs.mkdirSync(path.dirname(staleStagedPython), { recursive: true })
  fs.writeFileSync(staleStagedPython, 'stale-windows-runtime')
  const generatedLog = path.join(sourceRuntime, 'kaleido', 'executable', 'debug.log')
  const unrelatedLog = path.join(root, 'backend.log')
  const cache = path.join(sourceRuntime, 'lib', 'python3.12', 'site-packages', '__pycache__')
  fs.mkdirSync(path.dirname(generatedLog), { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(generatedLog, 'remove')
  fs.writeFileSync(path.join(cache, 'stats.cpython-312.pyc'), 'remove')
  fs.writeFileSync(unrelatedLog, 'keep')

  const result = stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) })

  assert.equal(result.sourceRuntime, sourceRuntime)
  assert.equal(fs.existsSync(path.join(result.stagedRuntime, 'bin', 'python3.12')), true)
  assert.equal(fs.statSync(path.join(result.stagedRuntime, 'bin', 'python3.12')).mode & 0o111, 0o111)
  assert.equal(fs.readlinkSync(path.join(result.stagedRuntime, 'bin', 'python3')), 'python3.12')
  assert.equal(fs.existsSync(path.join(result.stagedRuntime, 'lib', 'python3.12', 'site-packages', '__pycache__')), false)
  assert.equal(fs.existsSync(path.join(result.stageRoot, 'python.exe')), true)
  assert.equal(fs.existsSync(generatedLog), false)
  assert.equal(fs.existsSync(unrelatedLog), true)
})

test('Darwin staging rejects stale requirement hashes and every Windows or builder payload family', t => {
  const forbidden = ['backend.dist', 'python.exe', 'bridge.dll', 'native.pyd', 'setup.ps1', 'pywin32', 'wheelhouse', 'archive', '_tmp']
  const roots = forbidden.map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-')))
  const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => [...roots, staleRoot].forEach(root => fs.rmSync(root, { recursive: true, force: true })))
  for (const [index, root] of roots.entries()) {
    const runtime = writeDarwinRuntime(root)
    const payload = path.join(runtime, forbidden[index])
    if (path.extname(payload)) fs.writeFileSync(payload, 'forbidden')
    else fs.mkdirSync(payload, { recursive: true })
    const manifestPath = path.join(runtime, 'easycris_runtime_manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.runtime_tree_sha256 = runtimeTreeSha256(runtime)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }), /unexpected Darwin runtime payload/)
  }
  const runtime = writeDarwinRuntime(staleRoot)
  const manifestPath = path.join(runtime, 'easycris_runtime_manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.requirements_sha256['requirements-macos.txt'] = 'f'.repeat(64)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.throws(
    () => stagePythonRuntime({ root: staleRoot, platform: 'darwin', manifestContext: fixtureManifestContext(staleRoot) }),
    /requirements hash is stale/
  )
})

test('Darwin staging rejects a missing or stale pinned runtime manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => [root, staleRoot].forEach(target => fs.rmSync(target, { recursive: true, force: true })))
  const runtime = writeDarwinRuntime(root)
  fs.rmSync(path.join(runtime, 'easycris_runtime_manifest.json'))
  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /runtime manifest missing/
  )

  const staleRuntime = writeDarwinRuntime(staleRoot)
  fs.writeFileSync(path.join(staleRuntime, 'added.py'), '# stale source\n')
  assert.throws(
    () => stagePythonRuntime({ root: staleRoot, platform: 'darwin', manifestContext: fixtureManifestContext(staleRoot) }),
    /tree hash is stale/
  )
})

test('Darwin staging rejects escaped symlinks, missing modules, and Windows payloads', t => {
  const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const escaped = makeRoot()
  const missing = makeRoot()
  const windows = makeRoot()
  t.after(() => [escaped, missing, windows].forEach(root => fs.rmSync(root, { recursive: true, force: true })))
  const escapedRuntime = writeDarwinRuntime(escaped)
  fs.symlinkSync('../outside', path.join(escapedRuntime, 'escape'))
  const missingRuntime = writeDarwinRuntime(missing)
  fs.rmSync(path.join(missingRuntime, 'lib', 'python3.12', 'site-packages', 'plot.py'))
  const windowsRuntime = writeDarwinRuntime(windows)
  fs.writeFileSync(path.join(windowsRuntime, 'python.exe'), 'forbidden')
  for (const root of [escaped, missing, windows]) {
    assert.throws(() => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }))
  }
})

test('Darwin staging creates an exclusive candidate instead of traversing attacker-owned symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-outside-'))
  const originalNow = Date.now
  t.after(() => {
    Date.now = originalNow
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stageRoot = path.join(root, 'bundle_resources', 'python_embedded')
  const predictableCandidate = path.join(stageRoot, `.runtime-stage-${process.pid}-1700000000000`)
  fs.mkdirSync(predictableCandidate, { recursive: true })
  fs.symlinkSync(outside, path.join(predictableCandidate, 'bin'))
  Date.now = () => 1700000000000

  assert.doesNotThrow(() => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }))
  assert.equal(fs.existsSync(path.join(outside, 'python3.12')), false)
})

test('Darwin staging rolls back the prior runtime when candidate replacement fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const originalRename = fs.renameSync
  t.after(() => {
    fs.renameSync = originalRename
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stagedRuntime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  fs.mkdirSync(stagedRuntime, { recursive: true })
  fs.writeFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'preserve-me')
  const committedRuntime = path.join(fs.realpathSync(path.dirname(stagedRuntime)), 'runtime')
  let failOnce = true
  fs.renameSync = (from, to) => {
    if (failOnce && to === committedRuntime) {
      failOnce = false
      throw new Error('simulated candidate replacement failure')
    }
    return originalRename(from, to)
  }

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /simulated candidate replacement failure/
  )
  assert.equal(fs.readFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'utf8'), 'preserve-me')
})

test('Darwin staging preserves the backup when candidate commit and backup restore both fail', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const originalRename = fs.renameSync
  t.after(() => {
    fs.renameSync = originalRename
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stagedRuntime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  fs.mkdirSync(stagedRuntime, { recursive: true })
  fs.writeFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'preserve-me')
  const stageRoot = fs.realpathSync(path.dirname(stagedRuntime))
  const committedRuntime = path.join(stageRoot, 'runtime')
  let candidateCommitFailed = false
  fs.renameSync = (from, to) => {
    if (!candidateCommitFailed && path.basename(from) === 'candidate-runtime' && to === committedRuntime) {
      candidateCommitFailed = true
      throw new Error('simulated candidate commit failure')
    }
    if (candidateCommitFailed && path.basename(from) === 'previous-runtime' && to === committedRuntime) {
      throw new Error('simulated backup restore failure')
    }
    return originalRename(from, to)
  }

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /rollback was incomplete/
  )
  assert.equal(fs.existsSync(stagedRuntime), false)
  const swapDirectories = fs.readdirSync(stageRoot).filter(name => name.startsWith('.runtime-stage-'))
  assert.equal(swapDirectories.length, 1)
  assert.equal(
    fs.readFileSync(path.join(stageRoot, swapDirectories[0], 'previous-runtime', 'previous-runtime.txt'), 'utf8'),
    'preserve-me'
  )
})

test('Darwin staging attempts backup recovery even when candidate rollback fails after commit validation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const originalRename = fs.renameSync
  t.after(() => {
    fs.renameSync = originalRename
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stagedRuntime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  fs.mkdirSync(stagedRuntime, { recursive: true })
  fs.writeFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'preserve-me')
  const stageRoot = fs.realpathSync(path.dirname(stagedRuntime))
  const committedRuntime = path.join(stageRoot, 'runtime')
  let committed = false
  let backupRestoreAttempted = false
  fs.renameSync = (from, to) => {
    if (committed && from === committedRuntime && path.basename(to) === 'candidate-runtime') {
      throw new Error('simulated candidate rollback failure')
    }
    if (committed && path.basename(from) === 'previous-runtime' && to === committedRuntime) {
      backupRestoreAttempted = true
      throw new Error('simulated backup restore failure')
    }
    const result = originalRename(from, to)
    if (!committed && path.basename(from) === 'candidate-runtime' && to === committedRuntime) {
      committed = true
      fs.writeFileSync(path.join(to, 'post-commit-mutation'), 'invalidate copied manifest')
    }
    return result
  }

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /rollback was incomplete/
  )
  assert.equal(backupRestoreAttempted, true)
  const swapDirectories = fs.readdirSync(stageRoot).filter(name => name.startsWith('.runtime-stage-'))
  assert.equal(swapDirectories.length, 1)
  assert.equal(
    fs.readFileSync(path.join(stageRoot, swapDirectories[0], 'previous-runtime', 'previous-runtime.txt'), 'utf8'),
    'preserve-me'
  )
})

test('Darwin staging restores the prior runtime after post-commit validation fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const originalRename = fs.renameSync
  t.after(() => {
    fs.renameSync = originalRename
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stagedRuntime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  fs.mkdirSync(stagedRuntime, { recursive: true })
  fs.writeFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'preserve-me')
  const stageRoot = fs.realpathSync(path.dirname(stagedRuntime))
  const committedRuntime = path.join(stageRoot, 'runtime')
  let committed = false
  fs.renameSync = (from, to) => {
    const result = originalRename(from, to)
    if (!committed && path.basename(from) === 'candidate-runtime' && to === committedRuntime) {
      committed = true
      fs.writeFileSync(path.join(to, 'post-commit-mutation'), 'invalidate copied manifest')
    }
    return result
  }

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /runtime manifest tree hash is stale/
  )
  assert.equal(fs.readFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'utf8'), 'preserve-me')
  assert.equal(fs.readdirSync(stageRoot).some(name => name.startsWith('.runtime-stage-')), false)
})

test('Darwin staging keeps the validated runtime live and retains the backup after committed-backup cleanup fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const originalRemove = fs.rmSync
  t.after(() => {
    fs.rmSync = originalRemove
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stagedRuntime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  fs.mkdirSync(stagedRuntime, { recursive: true })
  fs.writeFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'preserve-me')
  fs.rmSync = (target, options) => {
    if (path.basename(target) === 'previous-runtime') throw new Error('simulated committed-backup cleanup failure')
    return originalRemove(target, options)
  }

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /simulated committed-backup cleanup failure/
  )
  assert.equal(fs.existsSync(path.join(stagedRuntime, 'previous-runtime.txt')), false)
  assert.equal(fs.existsSync(path.join(stagedRuntime, 'bin', 'python3.12')), true)
  const stageRoot = fs.realpathSync(path.dirname(stagedRuntime))
  const swapDirectories = fs.readdirSync(stageRoot).filter(name => name.startsWith('.runtime-stage-'))
  assert.equal(swapDirectories.length, 1)
  assert.equal(
    fs.readFileSync(path.join(stageRoot, swapDirectories[0], 'previous-runtime', 'previous-runtime.txt'), 'utf8'),
    'preserve-me'
  )
})

test('Darwin staging does not restore a partially deleted backup after publication', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  const originalRemove = fs.rmSync
  t.after(() => {
    fs.rmSync = originalRemove
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeDarwinRuntime(root)
  const stagedRuntime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  fs.mkdirSync(path.join(stagedRuntime, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(stagedRuntime, 'previous-runtime.txt'), 'preserve-me')
  fs.writeFileSync(path.join(stagedRuntime, 'bin', 'python3.12'), 'previous-interpreter')
  fs.rmSync = (target, options) => {
    if (path.basename(target) === 'previous-runtime') {
      originalRemove(path.join(target, 'bin', 'python3.12'), { force: true })
      throw new Error('simulated partial committed-backup cleanup failure')
    }
    return originalRemove(target, options)
  }

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /simulated partial committed-backup cleanup failure/
  )
  assert.equal(fs.existsSync(path.join(stagedRuntime, 'previous-runtime.txt')), false)
  assert.equal(fs.statSync(path.join(stagedRuntime, 'bin', 'python3.12')).mode & 0o111, 0o111)
  const stageRoot = fs.realpathSync(path.dirname(stagedRuntime))
  const swapDirectories = fs.readdirSync(stageRoot).filter(name => name.startsWith('.runtime-stage-'))
  assert.equal(swapDirectories.length, 1)
  assert.equal(fs.existsSync(path.join(stageRoot, swapDirectories[0], 'previous-runtime', 'bin', 'python3.12')), false)
  assert.equal(
    fs.readFileSync(path.join(stageRoot, swapDirectories[0], 'previous-runtime', 'previous-runtime.txt'), 'utf8'),
    'preserve-me'
  )
})

test('Darwin staging rejects forged CPython/archive provenance and an empty Mach-O inventory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = writeDarwinRuntime(root)
  const manifestPath = path.join(runtime, 'easycris_runtime_manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.development_reuse = true
  manifest.content_fingerprint = 'f'.repeat(64)
  manifest.interpreter.version = '3.12.999'
  manifest.archive = {
    python_version: '3.12.999',
    filename: 'cpython-3.12.999-forged.tar.gz',
    sha256: 'e'.repeat(64),
  }
  manifest.runtime_tree_sha256 = runtimeTreeSha256(runtime)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /CPython|archive|development reuse|content fingerprint|Mach-O inventory/
  )
})

test('Darwin staging rejects a rehashed Mach-O inventory with a macOS floor newer than 14.0', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = writeDarwinRuntime(root)
  const manifestPath = path.join(runtime, 'easycris_runtime_manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.macho_inventory.files[0].minimum_macos_versions = ['15.0']
  manifest.macho_inventory.sha256 = crypto.createHash('sha256').update(JSON.stringify(manifest.macho_inventory.files)).digest('hex')
  manifest.runtime_tree_sha256 = runtimeTreeSha256(runtime)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  assert.throws(
    () => stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) }),
    /Mach-O.*14\.0/
  )
})

test('Darwin staging accepts the Task 5 retained virtualenv and Statsmodels archive layout', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeDarwinRuntime(root, { includeTask5KeptPaths: true })

  const result = stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) })
  assert.equal(
    fs.existsSync(path.join(result.stagedRuntime, 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')),
    true
  )
  assert.equal(
    fs.existsSync(path.join(result.stagedRuntime, 'lib', 'python3.12', 'site-packages', 'statsmodels', 'sandbox', 'archive', '__init__.py')),
    true
  )
})

test('Darwin staging matches Task 5 Mach-O inventory entries for confined interpreter aliases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeDarwinRuntime(root, { includeInterpreterMachAliases: true })

  const result = stagePythonRuntime({ root, platform: 'darwin', manifestContext: fixtureManifestContext(root) })
  const manifest = JSON.parse(fs.readFileSync(path.join(result.stagedRuntime, 'easycris_runtime_manifest.json'), 'utf8'))
  assert.deepEqual(
    manifest.macho_inventory.files.map(record => record.path),
    ['bin/python', 'bin/python3', 'bin/python3.12', 'kaleido/executable/bin/kaleido']
  )
})

test('Task 5 JavaScript fingerprint matches Python for copied runtime inputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-task5-fingerprint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copyTask5FingerprintInputs(root)

  const javascript = task5FingerprintContext(root)
  const python = pythonTask5Fingerprint(root)
  assert.equal(python.status, 0, python.stderr)
  assert.equal(javascript.contentFingerprint, python.stdout.trim())
})

test('Task 5 JavaScript fingerprint rejects a symlink in backend sources exactly as Python does', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-task5-fingerprint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copyTask5FingerprintInputs(root)
  fs.symlinkSync('ecp_basic.py', path.join(root, 'python_embedded', 'statistics_module', 'unsafe-link.py'))

  assert.throws(() => task5FingerprintContext(root), /backend source is a symlink/)
  const python = pythonTask5Fingerprint(root)
  assert.notEqual(python.status, 0)
  assert.match(python.stderr, /Backend source must not be a symlink/)
})

test('Task 5 JavaScript fingerprint rejects a symlink in the RNA patch payload exactly as Python does', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-task5-fingerprint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copyTask5FingerprintInputs(root)
  fs.symlinkSync('__init__.py', path.join(root, 'scripts', 'rnaseq_patches', 'pydeseq2_0_5_3', 'unsafe-link.py'))

  assert.throws(() => task5FingerprintContext(root), /content directory contains a symlink/)
  const python = pythonTask5Fingerprint(root)
  assert.notEqual(python.status, 0)
  assert.match(python.stderr, /Content directory must not contain symlinks/)
})

test('staging preserves the Windows interpreter copy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceDist = path.join(root, 'python_embedded', 'dist')
  for (const backend of ['stats', 'rnaseq', 'plot']) {
    const topLevel = path.join(sourceDist, `${backend}.exe`)
    const nested = path.join(sourceDist, `${backend}.dist`, `${backend}.exe`)
    fs.mkdirSync(path.dirname(nested), { recursive: true })
    fs.writeFileSync(topLevel, `${backend}-top-level`)
    fs.writeFileSync(nested, `${backend}-nested`)
  }
  const sourcePython = path.join(root, 'python_embedded', 'python.exe')
  fs.writeFileSync(sourcePython, 'windows-interpreter')

  const result = stagePythonRuntime({ root, platform: 'win32' })

  assert.equal(fs.readFileSync(path.join(result.stageRoot, 'python.exe'), 'utf8'), 'windows-interpreter')
  assert.equal(fs.existsSync(path.join(result.stageDist, 'plot.exe')), true)
  assert.equal(fs.existsSync(path.join(result.stageDist, 'plot.dist', 'plot.exe')), true)
})
