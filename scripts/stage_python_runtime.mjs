#!/usr/bin/env node

import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, execSync } from 'node:child_process'
import {
  REQUIRED_BACKENDS,
  assertRuntimePlatform,
  backendExecutableName,
} from './python-runtime-constants.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const MANIFEST_NAME = 'easycris_runtime_manifest.json'
const REQUIREMENT_FILES = [
  'requirements-macos.txt',
  'requirements-rnaseq.txt',
  'requirements-macos-builder.lock',
  'requirements-macos-x86_64.lock',
  'requirements-macos-arm64.lock',
]
const REQUIRED_DARWIN_MODULES = ['stats', 'rnaseq', 'plot']
const TASK5_MANIFEST_KEYS = new Set([
  'schema_version', 'head_sha', 'clean_tree', 'dirty_entry_count', 'development_reuse',
  'content_fingerprint', 'architecture', 'support_floor', 'archive', 'interpreter',
  'requirements_sha256', 'builder_provenance', 'wheel_archive_sha256', 'intel_gseapy_source_build',
  'backend_sources', 'runtime_distributions', 'universal_macho_thinning',
  'macho_inventory', 'probe_results', 'runtime_tree_sha256',
])
const TASK5_ARCHIVE_FIELDS = ['release', 'filename', 'url', 'sha256', 'python_version']
const TASK5_BACKEND_SOURCE_FILES = ['stats.py', 'rnaseq.py', 'plot.py', 'platform_trust.py', 'plot_exporter.py']
const TASK5_BACKEND_SOURCE_DIRECTORIES = ['statistics_module', 'rnaseq_module', 'plots_module']
const MACHO_MAGICS = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const FORBIDDEN_DARWIN_ROOT_PARTS = new Set([
  '.dist', 'builder', 'wheelhouse', 'archive', 'archives', 'pip-cache',
  'pip_cache', '_tmp',
])
const FORBIDDEN_DARWIN_WINDOWS_PARTS = new Set(['pywin32', 'win32com', 'pywin32_system32'])
const CPYTHON_VENV_ACTIVATE_PS1 = 'lib/python3.12/venv/scripts/common/activate.ps1'
const GSEAPY_CARGO_LOCK_SHA256 = '2083f2702da6288120f7a8c1a05222228b586e47869d28ccb1f4c543d578315a'

let task5ArchivePinsCache

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeDarwinArchitecture(architecture = process.arch) {
  if (architecture === 'x64' || architecture === 'x86_64') return 'x86_64'
  if (architecture === 'arm64') return 'arm64'
  return null
}

function task5ArchivePins() {
  if (task5ArchivePinsCache) return task5ArchivePinsCache
  const bootstrap = fs.readFileSync(path.join(rootDir, 'scripts', 'bootstrap_python_macos.py'), 'utf8')
  const start = bootstrap.indexOf('ARCHIVE_PINS = {')
  const end = bootstrap.indexOf('\n}\n\nBACKEND_SOURCE_FILES', start)
  if (start < 0 || end < 0) fail('Task 5 ARCHIVE_PINS declaration is unavailable')
  const section = bootstrap.slice(start, end)
  const pins = {}
  for (const architecture of ['x86_64', 'arm64']) {
    const blockStart = section.indexOf(`"${architecture}": {`)
    const blockEnd = section.indexOf('    },', blockStart)
    if (blockStart < 0 || blockEnd < 0) fail(`Task 5 ARCHIVE_PINS entry is unavailable: ${architecture}`)
    const block = section.slice(blockStart, blockEnd)
    const pin = {}
    for (const field of TASK5_ARCHIVE_FIELDS) {
      const match = new RegExp(`"${field}": "([^"]+)"`).exec(block)
      if (!match) fail(`Task 5 ARCHIVE_PINS field is unavailable: ${architecture}.${field}`)
      pin[field] = match[1]
    }
    pins[architecture] = Object.freeze(pin)
  }
  task5ArchivePinsCache = Object.freeze(pins)
  return task5ArchivePinsCache
}

function task5ArchivePin(architecture) {
  const pin = task5ArchivePins()[architecture]
  if (!pin) fail(`Unsupported Task 5 runtime architecture: ${architecture}`)
  return pin
}

export function readTargetPlatform(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--platform')
  if (index < 0) return assertRuntimePlatform(process.platform)
  const platform = argv[index + 1]
  if (!platform || platform.startsWith('--')) throw new Error('Missing value for --platform')
  return assertRuntimePlatform(platform)
}

export function backendArtifactPaths(distRoot, backend, platform = process.platform) {
  const executable = backendExecutableName(backend, platform)
  const distDirectory = path.join(distRoot, `${backend}.dist`)
  return {
    topLevel: path.join(distRoot, executable),
    distDirectory,
    distExecutable: path.join(distDirectory, executable),
  }
}

export function isTransientKaleidoLog(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/')
  return /(^|\/)(?:plot\.dist\/)?kaleido\/executable\/(?:.*\/)?[^/]+\.log$/i.test(normalized)
}

function fail(message) {
  throw new Error(`[stage-python-runtime] ${message}`)
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) fail(`${label} missing: ${targetPath}`)
}

function removeIfExists(targetPath) {
  if (!existsOrLink(targetPath)) return
  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    if (process.platform !== 'win32') throw error
    execSync(`cmd /c rmdir /s /q "${targetPath}"`, { stdio: 'ignore' })
    if (fs.existsSync(targetPath)) throw error
  }
}

function existsOrLink(targetPath) {
  try {
    fs.lstatSync(targetPath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function walkEntries(root) {
  if (!existsOrLink(root)) return []
  const entries = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      entries.push(candidate)
      if (entry.isDirectory()) stack.push(candidate)
    }
  }
  return entries
}

function walkFiles(targetDir) {
  return walkEntries(targetDir).filter(filePath => fs.lstatSync(filePath).isFile())
}

export function cleanTransientKaleidoLogs(roots) {
  let removed = 0
  for (const root of roots) {
    for (const filePath of walkFiles(root)) {
      if (isTransientKaleidoLog(filePath)) {
        fs.rmSync(filePath, { force: true })
        removed += 1
      }
    }
  }
  return removed
}

export function cleanDarwinRuntimeTransients(runtime) {
  let removed = cleanTransientKaleidoLogs([runtime])
  for (const candidate of walkEntries(runtime).sort((left, right) => right.length - left.length)) {
    const stat = fs.lstatSync(candidate)
    if (stat.isDirectory() && path.basename(candidate) === '__pycache__') {
      fs.rmSync(candidate, { recursive: true, force: true })
      removed += 1
    } else if (stat.isFile() && candidate.endsWith('.pyc')) {
      fs.rmSync(candidate, { force: true })
      removed += 1
    }
  }
  return removed
}

function sha256File(targetPath) {
  const digest = crypto.createHash('sha256')
  digest.update(fs.readFileSync(targetPath))
  return digest.digest('hex')
}

export function runtimeTreeSha256(runtime) {
  const digest = crypto.createHash('sha256')
  const resolvedRuntime = fs.realpathSync(runtime)
  const entries = walkEntries(runtime)
    .map(candidate => ({ candidate, relative: path.relative(runtime, candidate).split(path.sep).join('/') }))
    .filter(entry => entry.relative !== MANIFEST_NAME)
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.relative, 'utf8'),
      Buffer.from(right.relative, 'utf8'),
    ))
  for (const { candidate, relative } of entries) {
    const linkStat = fs.lstatSync(candidate)
    // Tauri's macOS resource bundler dereferences file symlinks and omits empty
    // directories. Hash the logical file tree so the staged and installed copies
    // retain one integrity identity across that deterministic packaging step.
    if (linkStat.isDirectory()) continue
    let stat = linkStat
    if (linkStat.isSymbolicLink()) {
      const resolvedTarget = fs.realpathSync(candidate)
      if (!isInside(resolvedRuntime, resolvedTarget)) {
        throw new Error(`Runtime tree symlink escapes runtime: ${candidate}`)
      }
      stat = fs.statSync(resolvedTarget)
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported runtime tree entry: ${candidate}`)
    }
    digest.update(relative, 'utf8')
    digest.update('\0')
    digest.update((stat.mode & 0o7777).toString(8).padStart(4, '0'), 'ascii')
    digest.update('\0')
    digest.update('file\0', 'ascii')
    digest.update(sha256File(candidate), 'ascii')
    digest.update('\0')
  }
  return digest.digest('hex')
}

function requirementHashes(root) {
  const source = path.join(root, 'python_embedded')
  return Object.fromEntries(REQUIREMENT_FILES.map(name => [name, sha256File(path.join(source, name))]))
}

function expectedBuilderProvenance(architecture) {
  const lockPath = path.join(rootDir, 'python_embedded', 'requirements-macos-builder.lock')
  const archiveSha256 = {}
  const distributions = []
  let pendingArchives = []
  for (const rawLine of fs.readFileSync(lockPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('# archive:')) {
      pendingArchives.push(line.slice('# archive:'.length).trim())
      continue
    }
    if (!line || line.startsWith('#')) continue
    const requirement = /^([A-Za-z0-9_.-]+)==([^\s;#]+)/.exec(line)
    const hashes = [...line.matchAll(/--hash=sha256:([0-9a-f]{64})/g)].map(match => match[1])
    if (!requirement || pendingArchives.length === 0 || pendingArchives.length !== hashes.length) {
      fail('Builder lock cannot be represented as exact provenance')
    }
    for (let index = 0; index < hashes.length; index += 1) {
      archiveSha256[pendingArchives[index]] = hashes[index]
    }
    distributions.push({
      name: requirement[1].toLowerCase().replaceAll('_', '-').replaceAll('.', '-'),
      version: requirement[2],
    })
    pendingArchives = []
  }
  distributions.sort((left, right) => compareText(left.name, right.name))
  const archive = task5ArchivePin(architecture)
  return {
    python_version: archive.python_version,
    source_archive_filename: archive.filename,
    source_archive_sha256: archive.sha256,
    lock_filename: 'requirements-macos-builder.lock',
    lock_sha256: sha256File(lockPath),
    archive_sha256: Object.fromEntries(
      Object.entries(archiveSha256).sort(([left], [right]) => compareText(left, right))
    ),
    distributions,
  }
}

function task5BackendSourceInventory(root) {
  const source = path.join(root, 'python_embedded')
  const files = []
  for (const name of TASK5_BACKEND_SOURCE_FILES) {
    const target = path.join(source, name)
    if (!existsOrLink(target) || fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile()) {
      fail(`Task 5 backend source is missing or unsafe: ${target}`)
    }
    files.push({ relative: name, target })
  }
  for (const directory of TASK5_BACKEND_SOURCE_DIRECTORIES) {
    const target = path.join(source, directory)
    if (!existsOrLink(target) || fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory()) {
      fail(`Task 5 backend source directory is missing or unsafe: ${target}`)
    }
    const selected = []
    for (const candidate of walkEntries(target).sort(compareText)) {
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) fail(`Task 5 backend source is a symlink: ${candidate}`)
      if (!stat.isFile()) continue
      const relative = path.relative(source, candidate).split(path.sep).join('/')
      const parts = relative.toLowerCase().split('/')
      const name = path.basename(candidate).toLowerCase()
      if (!['.py', '.json'].includes(path.extname(name)) || parts.some(part => ['__pycache__', 'test', 'tests', 'fixtures', 'logs', 'output', 'outputs'].includes(part)) || ['.env', 'credentials.json', 'secrets.json'].includes(name)) continue
      selected.push({ relative, target: candidate })
    }
    selected.sort((left, right) => compareText(left.relative, right.relative))
    files.push(...selected)
  }
  const digest = crypto.createHash('sha256')
  for (const file of files) {
    digest.update(file.relative, 'utf8')
    digest.update('\0', 'utf8')
    digest.update(fs.readFileSync(file.target))
    digest.update('\0', 'utf8')
  }
  return { files: files.map(file => file.relative), sha256: digest.digest('hex') }
}

function directoryContentSha256(directory) {
  if (!existsOrLink(directory) || fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) {
    fail(`Task 5 content directory is missing or unsafe: ${directory}`)
  }
  const digest = crypto.createHash('sha256')
  const files = []
  for (const target of walkEntries(directory).sort((left, right) => compareText(
    path.relative(directory, left).split(path.sep).join('/'),
    path.relative(directory, right).split(path.sep).join('/')
  ))) {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) fail(`Task 5 content directory contains a symlink: ${target}`)
    if (stat.isFile()) files.push({ target, relative: path.relative(directory, target).split(path.sep).join('/') })
  }
  for (const file of files) {
    digest.update(file.relative, 'utf8')
    digest.update('\0', 'utf8')
    digest.update(sha256File(file.target), 'ascii')
    digest.update('\0', 'utf8')
  }
  return digest.digest('hex')
}

function task5ContentFingerprint(root, architecture, requirements, backendSources) {
  const pin = task5ArchivePin(architecture)
  const inputs = {
    schema_version: 1,
    architecture,
    archive_url: pin.url,
    archive_sha256: pin.sha256,
    requirements,
    backend_sources: backendSources.sha256,
    build_recipe: Object.fromEntries([
      'scripts/bootstrap_python_macos.py',
      'scripts/apply_rnaseq_pydeseq2_patch.py',
      'scripts/validate_rnaseq_runtime.py',
      'scripts/gseapy-1.1.11.Cargo.lock',
    ].map(relative => [relative, sha256File(path.join(root, relative))])),
    rnaseq_patch_payload: directoryContentSha256(path.join(root, 'scripts', 'rnaseq_patches', 'pydeseq2_0_5_3')),
  }
  return sha256Text(canonicalJson(inputs))
}

export function runtimeManifestContext(root, overrides = {}) {
  const headSha = overrides.headSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirtyEntries = overrides.dirtyEntries ?? execFileSync(
    'git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }
  ).split(/\r?\n/).filter(Boolean)
  const architecture = overrides.architecture ?? (process.platform === 'darwin' ? normalizeDarwinArchitecture() : undefined)
  const requirementsSha256 = overrides.requirementsSha256 ?? requirementHashes(root)
  const builderProvenance = overrides.builderProvenance ?? (
    architecture ? expectedBuilderProvenance(architecture) : undefined
  )
  const backendSources = overrides.backendSources ?? (architecture ? task5BackendSourceInventory(root) : undefined)
  const contentFingerprint = overrides.contentFingerprint ?? (
    architecture ? task5ContentFingerprint(root, architecture, requirementsSha256, backendSources) : undefined
  )
  return {
    headSha,
    cleanTree: overrides.cleanTree ?? dirtyEntries.length === 0,
    dirtyEntryCount: overrides.dirtyEntryCount ?? dirtyEntries.length,
    requirementsSha256,
    builderProvenance,
    architecture,
    archive: overrides.archive ?? (architecture ? task5ArchivePin(architecture) : undefined),
    backendSources,
    contentFingerprint,
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function isMachOFile(targetPath) {
  try {
    return MACHO_MAGICS.has(fs.readFileSync(targetPath).subarray(0, 4).toString('hex'))
  } catch {
    return false
  }
}

function runtimeMachOFiles(runtime) {
  return walkEntries(runtime).filter(candidate => {
    const stat = fs.lstatSync(candidate)
    if (stat.isFile()) return true
    if (!stat.isSymbolicLink()) return false
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

function isMacOSVersionAtMost14(value) {
  const match = typeof value === 'string' && /^(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) return false
  const major = BigInt(match[1])
  const minor = BigInt(match[2] ?? '0')
  return major < 14n || (major === 14n && minor === 0n)
}

function runtimeMachOInventoryProblems(runtime, manifest, architecture) {
  const problems = []
  const inventory = manifest?.macho_inventory
  const actual = runtimeMachOFiles(runtime)
    .filter(isMachOFile)
    .map(target => ({
      path: path.relative(runtime, target).split(path.sep).join('/'),
      sha256: sha256File(target),
    }))
    .sort((left, right) => compareText(left.path, right.path))
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return ['runtime manifest Mach-O inventory is invalid']
  }
  if (!Array.isArray(inventory.files) || !Number.isInteger(inventory.count) || inventory.count <= 0 || inventory.count !== inventory.files.length) {
    problems.push('runtime manifest Mach-O inventory is incomplete')
    return problems
  }
  const expectedByPath = new Map()
  for (const record of inventory.files) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.path !== 'string' || !isSha256(record.sha256) || !Array.isArray(record.architectures) || canonicalJson(record.architectures) !== canonicalJson([architecture]) || !Array.isArray(record.minimum_macos_versions) || record.minimum_macos_versions.length === 0 || record.minimum_macos_versions.some(version => typeof version !== 'string' || !/^\d+(?:\.\d+)?$/.test(version))) {
      problems.push('runtime manifest Mach-O record is invalid')
      continue
    }
    if (record.minimum_macos_versions.some(version => !isMacOSVersionAtMost14(version))) {
      problems.push('runtime manifest Mach-O record minimum macOS version is newer than 14.0')
    }
    if (expectedByPath.has(record.path)) problems.push(`runtime manifest Mach-O inventory repeats a path: ${record.path}`)
    expectedByPath.set(record.path, record)
  }
  const expectedDigest = sha256Text(canonicalJson(inventory.files))
  if (!isSha256(inventory.sha256) || inventory.sha256 !== expectedDigest) problems.push('runtime manifest Mach-O inventory digest is invalid')
  const actualPaths = actual.map(record => record.path)
  const expectedPaths = [...expectedByPath.keys()].sort()
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) problems.push('runtime manifest Mach-O inventory does not match runtime files')
  for (const record of actual) {
    if (expectedByPath.get(record.path)?.sha256 !== record.sha256) problems.push(`runtime manifest Mach-O hash is stale: ${record.path}`)
  }
  const kaleido = actualPaths.filter(relative => `/${relative}`.includes('/kaleido/executable/'))
  if (kaleido.length === 0 || !Array.isArray(inventory.kaleido_helpers) || canonicalJson([...inventory.kaleido_helpers].sort()) !== canonicalJson(kaleido)) {
    problems.push('runtime manifest Mach-O Kaleido inventory is incomplete')
  }
  return problems
}

function sameObject(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function validateCompleteManifest(manifest, context, problems) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    problems.push('runtime manifest is invalid')
    return null
  }
  const keys = Object.keys(manifest)
  if (keys.length !== TASK5_MANIFEST_KEYS.size || keys.some(key => !TASK5_MANIFEST_KEYS.has(key))) {
    problems.push('runtime manifest does not contain the exact Task 5 provenance fields')
  }
  const architecture = manifest.architecture
  if (!['x86_64', 'arm64'].includes(architecture) || (context?.architecture && context.architecture !== architecture)) {
    problems.push('runtime manifest architecture is invalid or does not match the native host')
    return null
  }
  const pin = task5ArchivePin(architecture)
  if (!sameObject(manifest.archive, pin)) problems.push('runtime manifest CPython archive does not match the Task 5 pin')
  if (
    !manifest.interpreter || typeof manifest.interpreter !== 'object' ||
    manifest.interpreter.path !== 'bin/python3.12' ||
    manifest.interpreter.version !== pin.python_version ||
    !sameObject(manifest.interpreter.architectures, [architecture]) ||
    !Array.isArray(manifest.interpreter.minimum_macos_versions) || manifest.interpreter.minimum_macos_versions.length === 0 ||
    manifest.interpreter.minimum_macos_versions.some(version => typeof version !== 'string' || !/^\d+(?:\.\d+)?$/.test(version))
  ) problems.push('runtime manifest CPython interpreter data is invalid')
  else if (manifest.interpreter.minimum_macos_versions.some(version => !isMacOSVersionAtMost14(version))) {
    problems.push('runtime manifest CPython interpreter minimum macOS version is newer than 14.0')
  }
  if (manifest.development_reuse !== false) problems.push('runtime manifest development reuse must be false for release staging')
  if (!isSha256(manifest.content_fingerprint)) problems.push('runtime manifest content fingerprint is invalid')
  else if (context?.contentFingerprint && manifest.content_fingerprint !== context.contentFingerprint) problems.push('runtime manifest content fingerprint is stale')
  if (!manifest.backend_sources || !Array.isArray(manifest.backend_sources.files) || !isSha256(manifest.backend_sources.sha256)) {
    problems.push('runtime manifest backend source inventory is invalid')
  } else if (context?.backendSources && !sameObject(manifest.backend_sources, context.backendSources)) {
    problems.push('runtime manifest backend source inventory is stale')
  }
  if (!manifest.wheel_archive_sha256 || typeof manifest.wheel_archive_sha256 !== 'object' || Array.isArray(manifest.wheel_archive_sha256) || Object.keys(manifest.wheel_archive_sha256).length === 0 || Object.values(manifest.wheel_archive_sha256).some(value => !isSha256(value))) {
    problems.push('runtime manifest wheel archive inventory is invalid')
  }
  const builder = manifest.builder_provenance
  const expectedBuilder = expectedBuilderProvenance(architecture)
  if (
    !builder || typeof builder !== 'object' || Array.isArray(builder) ||
    builder.lock_filename !== 'requirements-macos-builder.lock' ||
    !isSha256(builder.lock_sha256) ||
    builder.lock_sha256 !== manifest.requirements_sha256?.['requirements-macos-builder.lock'] ||
    !builder.archive_sha256 || typeof builder.archive_sha256 !== 'object' || Array.isArray(builder.archive_sha256) ||
    Object.keys(builder.archive_sha256).length === 0 || Object.values(builder.archive_sha256).some(value => !isSha256(value)) ||
    !Array.isArray(builder.distributions) || builder.distributions.length === 0 ||
    builder.distributions.some(row => !row || typeof row.name !== 'string' || typeof row.version !== 'string') ||
    !sameObject(builder, expectedBuilder)
  ) problems.push('runtime manifest builder provenance is invalid')
  if (architecture === 'x86_64') {
    const provenance = manifest.intel_gseapy_source_build
    const cargoLockSha256 = sha256File(path.join(rootDir, 'scripts', 'gseapy-1.1.11.Cargo.lock'))
    if (!provenance || provenance.source_filename !== 'gseapy-1.1.11.tar.gz' || provenance.source_sha256 !== 'd36a164ee466f7ea6deadfe82ea041f3328ee937ff4c9de862b3e6e2825df0dd' || provenance.cargo_lock_filename !== 'gseapy-1.1.11.Cargo.lock' || cargoLockSha256 !== GSEAPY_CARGO_LOCK_SHA256 || provenance.cargo_lock_sha256 !== cargoLockSha256 || !provenance.wheel || typeof provenance.wheel.filename !== 'string' || !isSha256(provenance.wheel.sha256)) {
      problems.push('runtime manifest Intel GSEApy provenance is invalid')
    }
  } else if (manifest.intel_gseapy_source_build !== null) {
    problems.push('runtime manifest ARM64 Intel GSEApy provenance must be null')
  }
  if (!Array.isArray(manifest.runtime_distributions) || manifest.runtime_distributions.length === 0 || manifest.runtime_distributions.some(row => !row || typeof row.name !== 'string' || typeof row.version !== 'string')) {
    problems.push('runtime manifest distribution inventory is invalid')
  }
  if (!Array.isArray(manifest.universal_macho_thinning)) problems.push('runtime manifest Mach-O thinning provenance is invalid')
  if (!manifest.probe_results || typeof manifest.probe_results !== 'object' || ['stats', 'rnaseq', 'plot', 'pdf', 'tiff'].some(name => manifest.probe_results[name]?.success !== true)) {
    problems.push('runtime manifest probe results are incomplete')
  }
  return architecture
}

function isForbiddenDarwinPayload(relative, stat) {
  const normalized = relative.toLowerCase()
  const parts = normalized.split('/')
  const name = parts.at(-1)
  const pipPayload = normalized === 'lib/python3.12/ensurepip' ||
    normalized.startsWith('lib/python3.12/ensurepip/') ||
    normalized === 'lib/python3.12/site-packages/pip' ||
    normalized.startsWith('lib/python3.12/site-packages/pip/')
  const isAllowedActivatePs1 = normalized === CPYTHON_VENV_ACTIVATE_PS1 && stat.isFile()
  return (
    FORBIDDEN_DARWIN_ROOT_PARTS.has(parts[0]) ||
    (parts.length === 1 && name.endsWith('.dist')) ||
    parts.some(part => FORBIDDEN_DARWIN_WINDOWS_PARTS.has(part)) ||
    name.endsWith('.exe') || name.endsWith('.dll') || name.endsWith('.pyd') ||
    (name.endsWith('.ps1') && !isAllowedActivatePs1) ||
    name.endsWith('.pyc') || parts.includes('__pycache__') || pipPayload ||
    (stat.isFile() && isTransientKaleidoLog(relative))
  )
}

function runtimeProblems(runtime, { manifestContext: context } = {}) {
  const problems = []
  if (!existsOrLink(runtime) || !fs.lstatSync(runtime).isDirectory() || fs.lstatSync(runtime).isSymbolicLink()) {
    return [`runtime directory missing or unsafe: ${runtime}`]
  }
  const resolvedRuntime = fs.realpathSync(runtime)
  let hasEscapedRuntimeSymlink = false
  for (const candidate of walkEntries(runtime)) {
    const stat = fs.lstatSync(candidate)
    const relative = path.relative(runtime, candidate).split(path.sep).join('/')
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(candidate)
      const resolved = path.resolve(fs.realpathSync(path.dirname(candidate)), target)
      if (path.isAbsolute(target) || !isInside(resolvedRuntime, resolved)) {
        problems.push(`runtime symlink escapes runtime: ${relative}`)
        hasEscapedRuntimeSymlink = true
      }
    }
    if (isForbiddenDarwinPayload(relative, stat)) problems.push(`unexpected Darwin runtime payload: ${relative}`)
  }
  const interpreter = path.join(runtime, 'bin', 'python3.12')
  let executableInterpreter = false
  try {
    const stat = fs.statSync(interpreter)
    executableInterpreter = stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    executableInterpreter = false
  }
  if (!executableInterpreter) {
    problems.push(`missing executable bundled interpreter: ${interpreter}`)
  }
  for (const module of REQUIRED_DARWIN_MODULES) {
    const modulePath = path.join(runtime, 'lib', 'python3.12', 'site-packages', `${module}.py`)
    if (!existsOrLink(modulePath)) problems.push(`missing bundled backend module: ${modulePath}`)
  }
  const manifestPath = path.join(runtime, MANIFEST_NAME)
  if (!existsOrLink(manifestPath)) return [...problems, `runtime manifest missing: ${manifestPath}`]
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return [...problems, `runtime manifest is invalid: ${error.message}`]
  }
  if (manifest?.schema_version !== 1) problems.push('runtime manifest schema_version must be 1')
  if (!/^[0-9a-f]{40}$/i.test(manifest?.head_sha || '')) problems.push('runtime manifest has no pinned HEAD SHA')
  if (manifest?.clean_tree !== true || manifest?.dirty_entry_count !== 0) problems.push('runtime manifest was not provisioned from a clean tree')
  if (context) {
    if (manifest.head_sha !== context.headSha) problems.push('runtime manifest HEAD SHA is stale')
    if (context.cleanTree !== true || context.dirtyEntryCount !== 0) problems.push('repository must be clean before runtime staging or validation')
    for (const name of REQUIREMENT_FILES) {
      if (manifest?.requirements_sha256?.[name] !== context.requirementsSha256?.[name]) {
        problems.push(`runtime manifest requirements hash is stale: ${name}`)
      }
    }
  }
  const architecture = validateCompleteManifest(manifest, context, problems)
  if (manifest?.support_floor !== '14.0') problems.push('runtime manifest support floor must be 14.0')
  if (architecture && !hasEscapedRuntimeSymlink) problems.push(...runtimeMachOInventoryProblems(runtime, manifest, architecture))
  if (!/^[0-9a-f]{64}$/i.test(manifest?.runtime_tree_sha256 || '')) problems.push('runtime manifest tree hash is invalid')
  else if (manifest.runtime_tree_sha256 !== runtimeTreeSha256(runtime)) problems.push('runtime manifest tree hash is stale')
  return problems
}

export function validateDarwinRuntimeManifest(runtime, options = {}) {
  return runtimeProblems(runtime, options)
}

function assertNoTransientKaleidoLogs(roots) {
  const stale = roots.flatMap(root => walkFiles(root).filter(filePath => path.basename(filePath).toLowerCase().endsWith('.log')))
  if (stale.length > 0) fail(`Transient Kaleido logs remain: ${stale.join(', ')}`)
}

function assertDarwinRuntimeManifest(runtime, options) {
  const problems = validateDarwinRuntimeManifest(runtime, options)
  if (problems.length > 0) fail(problems.join('; '))
}

function stageOptionalWindowsPython({ root, stageRoot, platform }) {
  const destination = path.join(stageRoot, 'python.exe')
  removeIfExists(destination)
  if (platform !== 'win32') return
  const source = path.join(root, 'python_embedded', 'python.exe')
  if (!fs.existsSync(source)) {
    console.log(`[stage-python-runtime] Optional file skipped: ${source}`)
    return
  }
  fs.copyFileSync(source, destination)
  console.log('[stage-python-runtime] Optional file copied: python.exe')
}

function resolveSourceBackendExecutable(paths, backend, platform) {
  ensureExists(paths.distDirectory, `Source ${backend}.dist`)
  if (fs.existsSync(paths.topLevel)) return paths.topLevel
  if (fs.existsSync(paths.distExecutable)) return paths.distExecutable
  fail(`Source ${backend} executable missing in both dist root and ${backend}.dist for ${platform}`)
}

function stageWindowsPythonRuntime({ root, platform }) {
  const sourceDist = path.join(root, 'python_embedded', 'dist')
  const stageRoot = path.join(root, 'bundle_resources', 'python_embedded')
  const stageDist = path.join(stageRoot, 'dist')
  const generatedRoots = [
    path.join(sourceDist, 'plot.dist', 'kaleido', 'executable'),
    path.join(stageDist, 'plot.dist', 'kaleido', 'executable'),
  ]
  ensureExists(sourceDist, 'Source dist directory')
  cleanTransientKaleidoLogs(generatedRoots)
  assertNoTransientKaleidoLogs(generatedRoots)
  fs.mkdirSync(stageRoot, { recursive: true })
  removeIfExists(stageDist)
  fs.mkdirSync(stageDist, { recursive: true })
  for (const backend of REQUIRED_BACKENDS) {
    const sourcePaths = backendArtifactPaths(sourceDist, backend, platform)
    const stagedPaths = backendArtifactPaths(stageDist, backend, platform)
    const sourceExecutable = resolveSourceBackendExecutable(sourcePaths, backend, platform)
    removeIfExists(stagedPaths.topLevel)
    removeIfExists(stagedPaths.distDirectory)
    fs.copyFileSync(sourceExecutable, stagedPaths.topLevel)
    fs.cpSync(sourcePaths.distDirectory, stagedPaths.distDirectory, { recursive: true, force: true })
    ensureExists(stagedPaths.distExecutable, `Staged ${backend}.dist executable`)
  }
  stageOptionalWindowsPython({ root, stageRoot, platform })
  cleanTransientKaleidoLogs(generatedRoots)
  assertNoTransientKaleidoLogs(generatedRoots)
  for (const backend of REQUIRED_BACKENDS) {
    const stagedPaths = backendArtifactPaths(stageDist, backend, platform)
    ensureExists(stagedPaths.distDirectory, `Staged ${backend}.dist`)
    ensureExists(stagedPaths.distExecutable, `Staged ${backend}.dist executable`)
    ensureExists(stagedPaths.topLevel, `Staged ${backend}.exe`)
  }
  return { sourceDist, stageRoot, stageDist, platform }
}

function ensureSafeStageDirectory(root) {
  const resolvedRoot = fs.realpathSync(root)
  let current = resolvedRoot
  for (const part of ['bundle_resources', 'python_embedded']) {
    const candidate = path.join(current, part)
    if (!existsOrLink(candidate)) fs.mkdirSync(candidate, { mode: 0o755 })
    const stat = fs.lstatSync(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Darwin staging root is unsafe: ${candidate}`)
    current = fs.realpathSync(candidate)
    if (!isInside(resolvedRoot, current)) fail(`Darwin staging root escapes repository: ${candidate}`)
  }
  return current
}

function makePrivateDarwinSwapDirectory(stageRoot) {
  const swap = fs.mkdtempSync(path.join(stageRoot, '.runtime-stage-'))
  fs.chmodSync(swap, 0o700)
  const stat = fs.lstatSync(swap)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail(`Darwin staging candidate is unsafe: ${swap}`)
  return swap
}

function replaceDarwinRuntimeTransaction({ candidate, stagedRuntime, swapDirectory, validate }) {
  const backup = path.join(swapDirectory, 'previous-runtime')
  let previousMoved = false
  let candidateMoved = false
  try {
    if (existsOrLink(stagedRuntime)) {
      fs.renameSync(stagedRuntime, backup)
      previousMoved = true
    }
    fs.renameSync(candidate, stagedRuntime)
    candidateMoved = true
    validate(stagedRuntime)
  } catch (error) {
    const rollbackFailures = []
    const attemptRecovery = (description, operation) => {
      try {
        operation()
      } catch (rollback) {
        rollbackFailures.push(`${description}: ${rollback.message}`)
      }
    }
    if (candidateMoved) attemptRecovery('move candidate out of the live runtime path', () => fs.renameSync(stagedRuntime, candidate))
    if (previousMoved) attemptRecovery('restore the previous runtime', () => fs.renameSync(backup, stagedRuntime))
    if (rollbackFailures.length > 0) {
      const incomplete = new Error(
        `[stage-python-runtime] Darwin runtime replacement failed and rollback was incomplete: ${error.message}; ${rollbackFailures.join('; ')}`
      )
      incomplete.preserveSwapDirectory = true
      throw incomplete
    }
    throw error
  }
  try {
    if (previousMoved) removeIfExists(backup)
  } catch (error) {
    const cleanupFailure = new Error(
      `[stage-python-runtime] Darwin runtime was published but prior-runtime cleanup failed: ${error.message}`
    )
    cleanupFailure.preserveSwapDirectory = true
    throw cleanupFailure
  }
}

function stageDarwinPythonRuntime({ root, platform, manifestContext }) {
  const sourceRuntime = path.join(root, 'python_embedded', 'runtime')
  const stageRoot = ensureSafeStageDirectory(root)
  const stagedRuntime = path.join(stageRoot, 'runtime')
  const context = manifestContext ?? runtimeManifestContext(root, { architecture: normalizeDarwinArchitecture() })
  cleanDarwinRuntimeTransients(sourceRuntime)
  assertDarwinRuntimeManifest(sourceRuntime, { root, manifestContext: context })
  const swapDirectory = makePrivateDarwinSwapDirectory(stageRoot)
  const candidate = path.join(swapDirectory, 'candidate-runtime')
  let preserveSwapDirectory = false
  try {
    fs.cpSync(sourceRuntime, candidate, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true, force: false, errorOnExist: true })
    cleanDarwinRuntimeTransients(candidate)
    assertDarwinRuntimeManifest(candidate, { root, manifestContext: context })
    replaceDarwinRuntimeTransaction({
      candidate,
      stagedRuntime,
      swapDirectory,
      validate: target => assertDarwinRuntimeManifest(target, { root, manifestContext: context }),
    })
  } catch (error) {
    preserveSwapDirectory = error?.preserveSwapDirectory === true
    throw error
  } finally {
    if (!preserveSwapDirectory && existsOrLink(swapDirectory)) removeIfExists(swapDirectory)
  }
  return { sourceRuntime, stageRoot, stagedRuntime, platform }
}

export function stagePythonRuntime({ root = rootDir, platform = process.platform, manifestContext } = {}) {
  const targetPlatform = assertRuntimePlatform(platform)
  return targetPlatform === 'darwin'
    ? stageDarwinPythonRuntime({ root, platform: targetPlatform, manifestContext })
    : stageWindowsPythonRuntime({ root, platform: targetPlatform })
}

function main() {
  const platform = readTargetPlatform()
  const result = stagePythonRuntime({ platform })
  const target = platform === 'darwin' ? result.stagedRuntime : result.stageDist
  console.log(`[stage-python-runtime] Staged required runtime artifacts into ${target}`)
  console.log('[stage-python-runtime] Completed successfully')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(`[stage-python-runtime] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}
