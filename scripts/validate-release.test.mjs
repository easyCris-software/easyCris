import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeManifestContext, runtimeTreeSha256 } from './stage_python_runtime.mjs'
import {
  readTargetPlatform as readValidationTargetPlatform,
  resolveInstalledDarwinDist,
  shouldRunWindowsScriptPlotParity,
  validateDarwinRuntime,
  validateMacBundleResources,
} from './validate_release.js'
import * as releaseValidation from './validate_release.js'

const REQUIREMENTS = Object.fromEntries([
  'requirements-macos.txt',
  'requirements-rnaseq.txt',
  'requirements-macos-builder.lock',
  'requirements-macos-x86_64.lock',
  'requirements-macos-arm64.lock',
].map(name => [name, 'a'.repeat(64)]))
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
REQUIREMENTS['requirements-macos-builder.lock'] = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(PROJECT_ROOT, 'python_embedded', 'requirements-macos-builder.lock')))
  .digest('hex')

function manifestContext(root) {
  return runtimeManifestContext(root, {
    headSha: 'b'.repeat(40),
    dirtyEntries: [],
    cleanTree: true,
    dirtyEntryCount: 0,
    requirementsSha256: REQUIREMENTS,
    architecture: 'x86_64',
    contentFingerprint: 'd'.repeat(64),
    backendSources: { files: ['fixture.py'], sha256: 'c'.repeat(64) },
  })
}

function sealRuntime(runtime, manifest) {
  manifest.runtime_tree_sha256 = runtimeTreeSha256(runtime)
  fs.writeFileSync(path.join(runtime, 'easycris_runtime_manifest.json'), JSON.stringify(manifest))
}

function makeRuntime(runtime) {
  const python = path.join(runtime, 'bin', 'python3.12')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(python, '#!/bin/sh\n')
  fs.chmodSync(python, 0o755)
  for (const module of ['stats', 'rnaseq', 'plot']) {
    const target = path.join(runtime, 'lib', 'python3.12', 'site-packages', `${module}.py`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '# module\n')
  }
  const nativeRelative = 'kaleido/executable/bin/kaleido'
  const native = path.join(runtime, nativeRelative)
  fs.mkdirSync(path.dirname(native), { recursive: true })
  fs.writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  const nativeRecord = {
    architectures: ['x86_64'],
    minimum_macos_versions: ['14.0'],
    path: nativeRelative,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(native)).digest('hex'),
  }
  const context = manifestContext(runtime)
  const manifest = {
    schema_version: 1,
    head_sha: 'b'.repeat(40),
    clean_tree: true,
    dirty_entry_count: 0,
    architecture: 'x86_64',
    support_floor: '14.0',
    development_reuse: false,
    content_fingerprint: context.contentFingerprint,
    interpreter: { path: 'bin/python3.12', version: '3.12.13', architectures: ['x86_64'], minimum_macos_versions: ['14.0'] },
    archive: context.archive,
    requirements_sha256: REQUIREMENTS,
    builder_provenance: context.builderProvenance,
    wheel_archive_sha256: { 'fixture.whl': 'e'.repeat(64) },
    intel_gseapy_source_build: { source_filename: 'gseapy-1.1.11.tar.gz', source_sha256: 'd36a164ee466f7ea6deadfe82ea041f3328ee937ff4c9de862b3e6e2825df0dd', cargo_lock_filename: 'gseapy-1.1.11.Cargo.lock', cargo_lock_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'gseapy-1.1.11.Cargo.lock'))).digest('hex'), wheel: { filename: 'fixture.whl', sha256: 'f'.repeat(64) } },
    backend_sources: context.backendSources,
    runtime_distributions: [{ name: 'fixture', version: '1.0' }],
    universal_macho_thinning: [],
    macho_inventory: { count: 1, sha256: crypto.createHash('sha256').update(JSON.stringify([nativeRecord])).digest('hex'), kaleido_helpers: [nativeRelative], files: [nativeRecord] },
    probe_results: { stats: { success: true }, rnaseq: { success: true }, plot: { success: true }, pdf: { success: true }, tiff: { success: true } },
  }
  sealRuntime(runtime, manifest)
  return { runtime, manifest }
}

function fixtureMachOInspector() {
  return 'Mach-O 64-bit executable x86_64\ncmd LC_BUILD_VERSION\n  minos 14.0'
}

function refreshMachOInventory(runtime, manifest, relativePaths) {
  const records = relativePaths.map(relative => ({
    architectures: ['x86_64'],
    minimum_macos_versions: ['14.0'],
    path: relative,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, relative))).digest('hex'),
  })).sort((left, right) => left.path.localeCompare(right.path))
  manifest.macho_inventory = {
    count: records.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    kaleido_helpers: records.filter(record => `/${record.path}`.includes('/kaleido/executable/')).map(record => record.path),
    files: records,
  }
}

function addTask5InterpreterMachOAliases(runtime, manifest) {
  const interpreter = path.join(runtime, 'bin', 'python3.12')
  fs.writeFileSync(interpreter, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  fs.chmodSync(interpreter, 0o755)
  fs.symlinkSync('python3.12', path.join(runtime, 'bin', 'python'))
  fs.symlinkSync('python3.12', path.join(runtime, 'bin', 'python3'))
  refreshMachOInventory(runtime, manifest, [
    'bin/python',
    'bin/python3',
    'bin/python3.12',
    'kaleido/executable/bin/kaleido',
  ])
  sealRuntime(runtime, manifest)
}

function successRunner(calls, runtime, { outsideSysPath = false, sysPathEntries, mutateRuntime } = {}) {
  return ({ command, args, input }) => {
    calls.push({ command, args, input })
    if (args.includes('--version')) return { status: 0, stdout: 'Python 3.12.13\n', stderr: '' }
    if (args.includes('-c')) {
      return { status: 0, stdout: JSON.stringify(sysPathEntries ?? [outsideSysPath ? '/outside-runtime' : path.resolve(path.dirname(command), '..')]), stderr: '' }
    }
    if (mutateRuntime) mutateRuntime(command, args)
    const payload = JSON.parse(input)
    if (payload.output_path) {
      const bytes = payload.options.format === 'pdf'
        ? Buffer.from('%PDF-1.4\nfixture\n')
        : Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
      fs.writeFileSync(payload.output_path, bytes)
    }
    return { status: 0, stdout: JSON.stringify({ success: true }), stderr: '' }
  }
}

function copyCliRuntimeInputs(root) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const name of ['validate_release.js', 'stage_python_runtime.mjs', 'python-runtime-constants.mjs', 'darwin-artifact-validation.mjs', 'plot-export-signatures.mjs']) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', name), path.join(root, 'scripts', name))
  }
  for (const name of ['requirements-macos.txt', 'requirements-rnaseq.txt', 'requirements-macos-builder.lock', 'requirements-macos-x86_64.lock', 'requirements-macos-arm64.lock', 'stats.py', 'rnaseq.py', 'plot.py', 'platform_trust.py', 'plot_exporter.py']) {
    fs.mkdirSync(path.join(root, 'python_embedded'), { recursive: true })
    fs.copyFileSync(path.join(PROJECT_ROOT, 'python_embedded', name), path.join(root, 'python_embedded', name))
  }
  for (const directory of ['statistics_module', 'rnaseq_module', 'plots_module']) {
    fs.cpSync(path.join(PROJECT_ROOT, 'python_embedded', directory), path.join(root, 'python_embedded', directory), { recursive: true })
  }
  for (const name of ['bootstrap_python_macos.py', 'apply_rnaseq_pydeseq2_patch.py', 'validate_rnaseq_runtime.py', 'gseapy-1.1.11.Cargo.lock']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', name), path.join(root, 'scripts', name))
  }
  fs.cpSync(
    path.join(PROJECT_ROOT, 'scripts', 'rnaseq_patches', 'pydeseq2_0_5_3'),
    path.join(root, 'scripts', 'rnaseq_patches', 'pydeseq2_0_5_3'),
    { recursive: true }
  )
  for (const argument of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', argument, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
}

function noOpFullValidationHooks() {
  const noOp = () => undefined
  return {
    validateLegalFiles: noOp,
    validateWindowsRuntime: noOp,
    validatePortableRelease: noOp,
    validateNsisReleaseConfig: noOp,
    validateNsisArtifactSignatures: noOp,
  }
}

test('resolves the installed Darwin runtime in updater resources', () => {
  assert.equal(
    resolveInstalledDarwinDist('/Applications/easyCris.app'),
    '/Applications/easyCris.app/Contents/Resources/_up_/bundle_resources/python_embedded/runtime'
  )
  assert.throws(() => readValidationTargetPlatform(['--platform']), /Missing value for --platform/)
})

test('release CLI rejects an unsupported platform before creating probe outputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copyCliRuntimeInputs(root)

  const result = spawnSync(
    globalThis.process.execPath,
    ['scripts/validate_release.js', '--platform', 'linux', '--community'],
    { cwd: root, encoding: 'utf8' }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unsupported runtime platform: linux/)
  assert.equal(fs.existsSync(path.join(root, '_tmp')), false)
})

test('Darwin validation runs stats, rnaseq, and plot through each isolated runtime', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = makeRuntime(path.join(root, 'python_embedded', 'runtime')).runtime
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  const app = path.join(root, 'easyCris.app')
  const installed = makeRuntime(resolveInstalledDarwinDist(app)).runtime
  const calls = []
  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    installedApp: app,
    runner: successRunner(calls, source),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })
  assert.deepEqual(result.errors, [])
  const moduleCalls = calls.filter(call => call.args.includes('-m'))
  assert.equal(moduleCalls.length, 15)
  for (const call of moduleCalls) assert.deepEqual(call.args.slice(0, 4), ['-I', '-B', '-m', call.args[3]])
  assert.ok(moduleCalls.some(call => call.command === path.join(installed, 'bin', 'python3.12') && call.args[3] === 'plot'))
})

test('release dispatcher runs signed installed backends without revalidating unsigned manifest hashes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = makeRuntime(path.join(root, 'python_embedded', 'runtime')).runtime
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  const app = path.join(root, 'easyCris.app')
  const installed = makeRuntime(resolveInstalledDarwinDist(app)).runtime

  // Ad-hoc signing changes Mach-O bytes after the provision manifest was sealed.
  fs.appendFileSync(path.join(installed, 'kaleido', 'executable', 'bin', 'kaleido'), 'signed')

  assert.equal(typeof releaseValidation.dispatchReleaseValidation, 'function')
  const fullResult = releaseValidation.dispatchReleaseValidation({
    argv: ['--platform', 'darwin', '--community', '--installed-app', app],
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner([], source),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'full-exports'),
    fullValidationHooks: noOpFullValidationHooks(),
  })
  assert.ok(fullResult.errors.some(error => /installed .*Mach-O hash is stale|installed .*tree hash is stale/.test(error)))

  const calls = []
  const executionResult = releaseValidation.dispatchReleaseValidation({
    argv: [
      '--platform', 'darwin',
      '--community',
      '--post-sign-installed-execution',
      '--installed-app', app,
    ],
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner(calls, installed),
    probeOutputDir: path.join(root, 'post-sign-exports'),
    fullValidationHooks: noOpFullValidationHooks(),
  })
  assert.deepEqual(executionResult.errors, [])
  const moduleCalls = calls.filter(call => call.args.includes('-m'))
  assert.equal(moduleCalls.length, 5)
  assert.ok(moduleCalls.every(call => call.command === path.join(installed, 'bin', 'python3.12')))
  assert.deepEqual(
    moduleCalls.map(call => call.args[3]),
    ['stats', 'rnaseq', 'plot', 'plot', 'plot']
  )
})

test('post-sign installed execution mode requires an installed app', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/validate_release.js', '--platform', 'darwin', '--community', '--post-sign-installed-execution'],
    { cwd: PROJECT_ROOT, encoding: 'utf8' }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--post-sign-installed-execution requires --installed-app/)
})

test('post-sign installed execution CLI rejects non-Darwin targets', () => {
  const result = spawnSync(
    globalThis.process.execPath,
    [
      'scripts/validate_release.js',
      '--platform', 'win32',
      '--community',
      '--post-sign-installed-execution',
      '--installed-app', 'easyCris.app',
    ],
    { cwd: PROJECT_ROOT, encoding: 'utf8' }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--post-sign-installed-execution requires --platform darwin/)
})

test('Darwin release validation accepts Task 5 Mach-O inventory entries for confined interpreter aliases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceFixture = makeRuntime(path.join(root, 'python_embedded', 'runtime'))
  const stagedFixture = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime'))
  addTask5InterpreterMachOAliases(sourceFixture.runtime, sourceFixture.manifest)
  addTask5InterpreterMachOAliases(stagedFixture.runtime, stagedFixture.manifest)

  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: sourceFixture.runtime, stagedRuntime: stagedFixture.runtime },
    runner: successRunner([], sourceFixture.runtime),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })

  assert.deepEqual(result.errors, [])
})

test('Darwin validation rejects sys.path escapes, protocol failures, and post-probe mutations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = makeRuntime(path.join(root, 'python_embedded', 'runtime')).runtime
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner([], source, { outsideSysPath: true }),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })
  assert.ok(result.errors.some(error => error.includes('sys.path escapes runtime')))
})

test('Darwin validation rejects relative sys.path escapes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = makeRuntime(path.join(root, 'python_embedded', 'runtime')).runtime
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner([], source, { sysPathEntries: ['../outside-runtime'] }),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })
  assert.ok(result.errors.some(error => error.includes('sys.path escapes runtime')))
})

test('Darwin validation reports transients without deleting pre-existing or probe-created artifacts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = makeRuntime(path.join(root, 'python_embedded', 'runtime')).runtime
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  const preexistingCache = path.join(source, 'lib', 'python3.12', 'site-packages', '__pycache__', 'preexisting.pyc')
  fs.mkdirSync(path.dirname(preexistingCache), { recursive: true })
  fs.writeFileSync(preexistingCache, 'bytecode')
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, 'easycris_runtime_manifest.json'), 'utf8'))
  sealRuntime(source, sourceManifest)
  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner([], source, {
      mutateRuntime(command, args) {
        if (!args.includes('-m')) return
        const cache = path.join(path.dirname(command), '..', 'lib', 'python3.12', 'site-packages', '__pycache__', 'probe.pyc')
        fs.mkdirSync(path.dirname(cache), { recursive: true })
        fs.writeFileSync(cache, 'probe-bytecode')
      },
    }),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })
  assert.equal(fs.existsSync(preexistingCache), true)
  const probeCache = path.join(staged, 'lib', 'python3.12', 'site-packages', '__pycache__', 'probe.pyc')
  assert.equal(fs.existsSync(probeCache), true)
  assert.ok(result.errors.some(error => /transient|mutated during validation/i.test(error)))
})

test('Darwin release CLI permits runtime Python sources while rejecting sibling Python files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copyCliRuntimeInputs(root)
  const runtimePython = path.join(root, 'bundle_resources', 'python_embedded', 'runtime', 'lib', 'python3.12', 'site-packages', 'stats.py')
  fs.mkdirSync(path.dirname(runtimePython), { recursive: true })
  fs.writeFileSync(runtimePython, '# permitted runtime module\n')
  const siblingPython = path.join(root, 'bundle_resources', 'python_embedded', 'outside-runtime.py')
  fs.writeFileSync(siblingPython, '# forbidden sibling\n')
  const legacyPython = path.join(root, 'bundle_resources', 'python_embedded', 'legacy.dist', 'legacy.py')
  fs.mkdirSync(path.dirname(legacyPython), { recursive: true })
  fs.writeFileSync(legacyPython, '# forbidden legacy runtime source\n')
  const result = spawnSync(process.execPath, ['scripts/validate_release.js', '--platform', 'darwin', '--community'], { cwd: root, encoding: 'utf8' })
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1)
  assert.doesNotMatch(output, /runtime\/lib\/python3\.12\/site-packages\/stats\.py/)
  assert.match(output, /outside-runtime\.py/)
  assert.match(output, /legacy\.dist\/legacy\.py/)
})

test('Darwin release CLI permits only the confined Task 5 Activate.ps1 while rejecting arbitrary PowerShell and sibling dist payloads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copyCliRuntimeInputs(root)
  const runtime = path.join(root, 'bundle_resources', 'python_embedded', 'runtime')
  const activate = path.join(runtime, 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
  const arbitraryPowerShell = path.join(runtime, 'unsafe.ps1')
  const legacyDist = path.join(root, 'bundle_resources', 'python_embedded', 'dist')
  fs.mkdirSync(path.dirname(activate), { recursive: true })
  fs.mkdirSync(legacyDist, { recursive: true })
  fs.writeFileSync(activate, '# retained by Task 5\n')
  fs.writeFileSync(arbitraryPowerShell, '# reject\n')

  const result = spawnSync(process.execPath, ['scripts/validate_release.js', '--platform', 'darwin', '--community'], { cwd: root, encoding: 'utf8' })
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1)
  assert.doesNotMatch(output, /Activate\.ps1/)
  assert.match(output, /unsafe\.ps1/)
  assert.match(output, /Legacy Python runtime or build payload.*python_embedded\/dist/)
})

test('macOS staged resource scanning rejects the installed-layout Activate.ps1 prefix', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-staged-resource-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const resources = path.join(root, 'bundle_resources')
  const runtime = path.join(resources, 'python_embedded', 'runtime')
  const activate = path.join(runtime, 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
  const installedLayoutActivate = path.join(resources, '_up_', 'bundle_resources', 'python_embedded', 'runtime', 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
  fs.mkdirSync(path.dirname(activate), { recursive: true })
  fs.mkdirSync(path.dirname(installedLayoutActivate), { recursive: true })
  fs.writeFileSync(activate, '# retained by Task 5\n')
  fs.writeFileSync(installedLayoutActivate, '# reject cross-layout bypass\n')

  const errors = validateMacBundleResources(resources, { runtimeRoot: runtime })
  assert.equal(errors.some(error => error.includes(activate)), false)
  assert.ok(errors.some(error => error.includes(installedLayoutActivate)))
})

test('macOS installed resource scanning permits only the exact Task 5 Activate.ps1 path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-installed-resource-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const resources = path.join(root, 'easyCris.app', 'Contents', 'Resources')
  const runtime = path.join(resources, '_up_', 'bundle_resources', 'python_embedded', 'runtime')
  const activate = path.join(runtime, 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
  const arbitraryPowerShell = path.join(runtime, 'unsafe.ps1')
  const symlinkPowerShell = path.join(runtime, 'alias.ps1')
  const stagedLayoutActivate = path.join(resources, 'python_embedded', 'runtime', 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
  const legacyDist = path.join(resources, '_up_', 'bundle_resources', 'python_embedded', 'dist')
  const builder = path.join(resources, '_up_', 'bundle_resources', 'python_embedded', 'builder')
  fs.mkdirSync(path.dirname(activate), { recursive: true })
  fs.mkdirSync(path.dirname(stagedLayoutActivate), { recursive: true })
  fs.mkdirSync(legacyDist, { recursive: true })
  fs.mkdirSync(builder, { recursive: true })
  fs.writeFileSync(activate, '# retained by Task 5\n')
  fs.writeFileSync(stagedLayoutActivate, '# reject cross-layout bypass\n')
  fs.writeFileSync(arbitraryPowerShell, '# reject\n')
  fs.symlinkSync('lib/python3.12/venv/scripts/common/Activate.ps1', symlinkPowerShell)

  const errors = validateMacBundleResources(resources, { runtimeRoot: runtime })
  assert.equal(errors.some(error => error.includes(activate)), false)
  assert.ok(errors.some(error => error.includes(arbitraryPowerShell)))
  assert.ok(errors.some(error => error.includes(symlinkPowerShell)))
  assert.ok(errors.some(error => error.includes(legacyDist)))
  assert.ok(errors.some(error => error.includes(builder)))
  assert.ok(errors.some(error => error.includes(stagedLayoutActivate)))
})

test('Darwin validation rejects stale manifests, missing modules, and Windows resources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = makeRuntime(path.join(root, 'python_embedded', 'runtime')).runtime
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  fs.writeFileSync(path.join(source, 'changed.py'), '# stale\n')
  fs.rmSync(path.join(staged, 'lib', 'python3.12', 'site-packages', 'plot.py'))
  fs.writeFileSync(path.join(root, 'bundle_resources', 'python_embedded', 'python.exe'), 'windows')
  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner([], source),
    inspectMachO: fixtureMachOInspector,
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })
  assert.ok(result.errors.some(error => error.includes('tree hash is stale')))
  assert.ok(result.errors.some(error => error.includes('missing bundled backend module')))
  assert.ok(result.errors.some(error => error.includes('Windows-only payload')))
})

test('Darwin validation scans non-executable Mach-O files against the manifest and macOS floor', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { runtime: source, manifest } = makeRuntime(path.join(root, 'python_embedded', 'runtime'))
  const staged = makeRuntime(path.join(root, 'bundle_resources', 'python_embedded', 'runtime')).runtime
  const native = path.join(source, 'lib', 'native.dylib')
  fs.mkdirSync(path.dirname(native), { recursive: true })
  fs.writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  refreshMachOInventory(source, manifest, ['kaleido/executable/bin/kaleido', 'lib/native.dylib'])
  sealRuntime(source, manifest)
  const result = validateDarwinRuntime({
    paths: { root, sourceRuntime: source, stagedRuntime: staged },
    runner: successRunner([], source),
    inspectMachO: target => target === native
      ? 'Mach-O 64-bit executable arm64\ncmd LC_BUILD_VERSION\n  minos 15.0'
      : 'Mach-O 64-bit executable x86_64\ncmd LC_BUILD_VERSION\n  minos 14.0',
    manifestContext: manifestContext(root),
    expectedArchitecture: 'x64',
    probeOutputDir: path.join(root, 'exports'),
  })
  assert.ok(result.errors.some(error => error.includes('architecture mismatch')))
  assert.ok(result.errors.some(error => error.includes('minimum macOS version 15.0 exceeds 14.0')))
})

test('macOS resource scanning and Windows community behavior remain available', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'PyWin32_system32'), { recursive: true })
  fs.writeFileSync(path.join(root, 'PyWin32_system32', 'bridge.dll'), 'windows')
  assert.ok(validateMacBundleResources(root).some(error => error.includes('bridge.dll')))
  assert.equal(shouldRunWindowsScriptPlotParity({ communityMode: true }), false)
  assert.equal(shouldRunWindowsScriptPlotParity({ communityMode: false }), true)
})

test('macOS resource scanning rejects legacy sibling runtimes and build payloads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycris-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pythonRoot = path.join(root, 'bundle_resources', 'python_embedded')
  const forbidden = ['legacy.dist', 'dist', 'builder', 'build', 'wheelhouse', 'archive', 'pip-cache', '_tmp']
  for (const name of forbidden) fs.mkdirSync(path.join(pythonRoot, name), { recursive: true })
  const errors = validateMacBundleResources(path.join(root, 'bundle_resources'))
  for (const name of forbidden) assert.ok(errors.some(error => error.includes(name)), name)
})
