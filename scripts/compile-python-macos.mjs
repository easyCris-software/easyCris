#!/usr/bin/env node
/** Controlled, checkpointed Darwin Nuitka compilation. */

import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REQUIRED_BACKENDS } from './python-runtime-constants.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECKPOINT_SCHEMA_VERSION = 1
const DEFAULT_TIMEOUT_SECONDS = 9000
const COMPILED_PROBE_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 5_000
const MAX_CAPTURE_BYTES = 64 * 1024

function signalDarwinProcessGroup(pid, signal) {
  process.kill(process.platform === 'darwin' ? -pid : pid, signal)
}

export function scheduleProcessTermination({
  pid, timeoutMs, graceMs = KILL_GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
  signalProcess = signalDarwinProcessGroup,
}) {
  let killTimer = null
  const termTimer = setTimer(() => {
    try { signalProcess(pid, 'SIGTERM') } catch { /* process already exited */ }
    killTimer = setTimer(() => {
      try { signalProcess(pid, 'SIGKILL') } catch { /* process already exited */ }
    }, graceMs)
  }, timeoutMs)
  return () => {
    clearTimer(termTimer)
    if (killTimer !== null) clearTimer(killTimer)
  }
}

function requireDarwinHost(platformName = process.platform, arch = os.machine()) {
  if (platformName !== 'darwin') throw new Error(`Darwin host required; detected ${platformName}`)
  if (!['x86_64', 'arm64'].includes(arch)) throw new Error(`Unsupported Darwin architecture: ${arch}`)
  return arch
}

function positiveTimeout(raw = process.env.EASYCRIS_NUITKA_TIMEOUT_SECS) {
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_SECONDS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('EASYCRIS_NUITKA_TIMEOUT_SECS must be a positive integer')
  return parsed
}

export function buildCompileJobs({ arch, headSha, timeoutSeconds, logRoot }) {
  return REQUIRED_BACKENDS.map(backend => ({
    backend,
    args: ['scripts/compile_python_nuitka.py', backend],
    env: {
      EASYCRIS_NUITKA_TIMEOUT_SECS: String(timeoutSeconds),
      EASYCRIS_TARGET_PLATFORM: 'darwin',
      EASYCRIS_TARGET_ARCH: arch,
    },
    logPath: path.join(logRoot, headSha, arch, `${backend}.log`),
  }))
}

export function assertCheckpointFingerprint(current, checkpoint) {
  for (const key of ['headSha', 'cleanTree', 'arch', 'pythonVersion', 'nuitkaVersion', 'runtimeManifestSha256', 'backendSourceSha256']) {
    if (current[key] !== checkpoint[key]) {
      const label = key === 'runtimeManifestSha256' ? 'runtime manifest hash' : key.replace(/([A-Z])/g, ' $1').toLowerCase()
      throw new Error(`Checkpoint fingerprint mismatch: ${label} changed`)
    }
  }
}

export function selectCompileJobs({ requestedBackend, resume, completedBackends }) {
  if (requestedBackend !== null && !REQUIRED_BACKENDS.includes(requestedBackend)) {
    throw new Error(`Unknown backend: ${requestedBackend}`)
  }
  const completed = new Set(completedBackends)
  const firstMissing = REQUIRED_BACKENDS.findIndex(backend => !completed.has(backend))
  if (firstMissing !== -1 && REQUIRED_BACKENDS.slice(firstMissing + 1).some(backend => completed.has(backend))) {
    throw new Error('Checkpoint entries must be a contiguous backend prefix')
  }
  const assertPrerequisites = backend => {
    const targetIndex = REQUIRED_BACKENDS.indexOf(backend)
    for (const prerequisite of REQUIRED_BACKENDS.slice(0, targetIndex)) {
      if (!completed.has(prerequisite)) throw new Error(`${prerequisite} checkpoint is required before ${backend}`)
    }
  }
  if (requestedBackend !== null) {
    assertPrerequisites(requestedBackend)
    return [requestedBackend]
  }
  if (!resume) return [...REQUIRED_BACKENDS]
  return REQUIRED_BACKENDS.filter(backend => !completed.has(backend))
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
  return result.stdout.trim()
}

export function assertBuilderVersions(pythonVersion, nuitkaVersion) {
  if (!/^Python 3\.12(?:\.\d+)?\b/.test(pythonVersion)) throw new Error(`Nuitka builder must use Python 3.12: ${pythonVersion}`)
  if (nuitkaVersion.trim().split(/\r?\n/, 1)[0] !== '2.8.10') throw new Error(`Nuitka builder must use Nuitka 2.8.10: ${nuitkaVersion}`)
}

export async function backendSourceHash(root = ROOT) {
  const inputs = [
    path.join(root, 'scripts', 'compile_python_nuitka.py'),
    path.join(root, 'python_embedded', 'stats.py'),
    path.join(root, 'python_embedded', 'rnaseq.py'),
    path.join(root, 'python_embedded', 'plot.py'),
  ]
  const digest = createHash('sha256')
  for (const input of inputs) {
    digest.update(path.relative(root, input))
    digest.update(await readFile(input))
  }
  return digest.digest('hex')
}

function trackedTreeIsClean() {
  return commandOutput('git', ['status', '--porcelain', '--untracked-files=no']) === ''
}

function requireIgnoredNuitkaRoot(logRoot) {
  const probe = path.join(logRoot, '.easycris-ignore-probe')
  const result = spawnSync('git', ['check-ignore', '-q', probe], { cwd: ROOT })
  if (result.status !== 0) throw new Error(`Nuitka log root must be ignored: ${logRoot}`)
}

function readCheckpoint(checkpointPath) {
  if (!existsSync(checkpointPath)) return { schemaVersion: CHECKPOINT_SCHEMA_VERSION, backends: {} }
  return JSON.parse(readFileSync(checkpointPath, 'utf8'))
}

export async function validateReusableCheckpoints({
  checkpoint,
  fingerprint,
  artifactResolver,
  inspectArtifact,
  probe,
  backends = REQUIRED_BACKENDS,
}) {
  if (!checkpoint.fingerprint) return []
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) throw new Error('Checkpoint schema version is invalid')
  assertCheckpointFingerprint(fingerprint, checkpoint.fingerprint)
  const completed = []
  for (const backend of backends) {
    const entry = checkpoint.backends?.[backend]
    if (!entry) break
    if (entry.status !== 'passed') break
    const expectedArtifact = artifactResolver(backend)
    if (entry.artifactPath !== expectedArtifact || !existsSync(expectedArtifact)) {
      throw new Error(`${backend} checkpoint artifact path is invalid`)
    }
    if (sha256File(expectedArtifact) !== entry.artifactSha256) throw new Error(`${backend} checkpoint artifact hash mismatch`)
    const fileArchitecture = inspectArtifact(expectedArtifact)
    if (!fileArchitecture.includes(fingerprint.arch) || entry.fileArchitecture !== fileArchitecture) {
      throw new Error(`${backend} checkpoint artifact architecture is invalid`)
    }
    const expectedProbeKeys = backend === 'plot' ? ['protocol', 'pdf', 'tiff'] : ['protocol']
    if (expectedProbeKeys.some(key => entry.probe?.[key] !== 'passed')) throw new Error(`${backend} checkpoint probe evidence is invalid`)
    const currentProbe = await probe(backend, expectedArtifact)
    if (expectedProbeKeys.some(key => currentProbe?.[key] !== 'passed')) throw new Error(`${backend} checkpoint protocol re-probe failed`)
    completed.push(backend)
  }
  return completed
}

export async function resolveReusableBackendsForInvocation({ requestedBackend, resume, validate }) {
  if (!resume && requestedBackend === null) return []
  const backends = resume
    ? [...REQUIRED_BACKENDS]
    : REQUIRED_BACKENDS.slice(0, REQUIRED_BACKENDS.indexOf(requestedBackend))
  if (backends.length === 0) return []
  return validate(backends)
}

export function shouldResetCheckpointForInvocation({ requestedBackend, resume }) {
  return !resume && (requestedBackend === null || requestedBackend === REQUIRED_BACKENDS[0])
}

function appendCheckpoint(checkpointPath, fingerprint, backend, entry) {
  const current = readCheckpoint(checkpointPath)
  if (current.fingerprint) assertCheckpointFingerprint(fingerprint, current.fingerprint)
  const next = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    fingerprint,
    backends: { ...(current.backends || {}), [backend]: entry },
  }
  writeFileSync(checkpointPath, `${JSON.stringify(next, null, 2)}\n`)
}

function boundedTail(lines) {
  return lines.slice(-80).join('\n')
}

export async function truncateAttemptLog(logPath) {
  await mkdir(path.dirname(logPath), { recursive: true })
  writeFileSync(logPath, '')
  return createWriteStream(logPath, { flags: 'a' })
}

async function defaultRunner(job, { onMeaningfulLine }) {
  const child = spawn(job.python, job.args, {
    cwd: ROOT,
    env: { ...process.env, ...job.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform === 'darwin',
  })
  const log = await truncateAttemptLog(job.logPath)
  const tail = []
  let lastMeaningfulLine = ''
  const consume = chunk => {
    const text = String(chunk)
    log.write(text)
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        lastMeaningfulLine = line.trim().slice(-1024)
        tail.push(lastMeaningfulLine)
        if (tail.length > 80) tail.shift()
        onMeaningfulLine(lastMeaningfulLine)
      }
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  let timedOut = false
  const innerTimeoutMs = Number(job.env.EASYCRIS_NUITKA_TIMEOUT_SECS) * 1000
  const cancelTermination = scheduleProcessTermination({
    pid: child.pid,
    timeoutMs: innerTimeoutMs + 30_000,
    signalProcess: (pid, signal) => {
      timedOut = true
      try { signalDarwinProcessGroup(pid, signal) } catch { child.kill(signal) }
    },
  })
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, timedOut, tail, lastMeaningfulLine }))
  })
  cancelTermination()
  await new Promise(resolve => log.end(resolve))
  return result
}

async function runBoundedProcess(command, input, timeoutMs = COMPILED_PROBE_TIMEOUT_MS) {
  const child = spawn(command, [], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform === 'darwin' })
  let stdout = ''
  let stderr = ''
  const append = (current, chunk) => (current + String(chunk)).slice(-MAX_CAPTURE_BYTES)
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
  let timedOut = false
  const cancelTermination = scheduleProcessTermination({
    pid: child.pid, timeoutMs,
    signalProcess: (pid, signal) => {
      timedOut = true
      try { signalDarwinProcessGroup(pid, signal) } catch { child.kill(signal) }
    },
  })
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, timedOut, stdout, stderr }))
    child.stdin.end(input)
  })
  cancelTermination()
  return result
}

export function assertSuccessfulJson(result, label) {
  if (result.code !== 0 || result.signal || result.timedOut) {
    const processState = `timed out=${result.timedOut === true}; signal=${result.signal ?? 'null'}; exit status=${result.code ?? 'null'}`
    const stderr = String(result.stderr || '').trim()
    throw new Error(`${label} protocol probe process failed (${processState})${stderr ? `: ${stderr}` : ''}`)
  }
  let payload
  try { payload = JSON.parse(result.stdout) } catch { throw new Error(`${label} protocol probe did not return JSON`) }
  if (payload?.success !== true) throw new Error(`${label} protocol probe did not report success=true`)
  return payload
}

export async function runProtocolProbes(backend, artifactPath, { runProcess = runBoundedProcess, probeRoot = path.join(ROOT, '_tmp', 'nuitka-probes') } = {}) {
  const inputs = {
    stats: JSON.stringify({ test: '__warmup__', parameters: { warmup_families: [] } }),
    rnaseq: JSON.stringify({ test: 'rnaseq_validate_samples', data: { counts_sample_ids: ['s1'], metadata_sample_ids: ['s1'] }, params: {} }),
    plot: JSON.stringify({ action: 'ping' }),
  }
  const result = await runProcess(artifactPath, `${inputs[backend]}\n`, COMPILED_PROBE_TIMEOUT_MS)
  assertSuccessfulJson(result, backend)
  if (backend !== 'plot') return { protocol: 'passed' }
  await mkdir(probeRoot, { recursive: true })
  for (const format of ['pdf', 'tiff']) {
    const outputPath = path.join(probeRoot, `plot-${randomUUID()}.${format}`)
    await rm(outputPath, { force: true })
    const exportResult = await runProcess(artifactPath, JSON.stringify({ action: 'export_plot', plotly_json: { data: [], layout: {} }, output_path: outputPath, options: { format } }), COMPILED_PROBE_TIMEOUT_MS)
    assertSuccessfulJson(exportResult, `plot ${format}`)
    if (!existsSync(outputPath) || readFileSync(outputPath).length === 0) {
      throw new Error(`plot ${format.toUpperCase()} export probe failed`)
    }
  }
  return { protocol: 'passed', pdf: 'passed', tiff: 'passed' }
}

export async function runCompileJobs({
  jobs,
  fingerprint,
  checkpointPath,
  resetCheckpoint = false,
  runner = defaultRunner,
  probe = runProtocolProbes,
  inspectArtifact = artifactPath => commandOutput('file', [artifactPath]),
  artifactResolver = backend => path.join(ROOT, 'python_embedded', 'dist', `${backend}.dist`, backend),
}) {
  if (resetCheckpoint) await rm(checkpointPath, { force: true })
  for (const job of jobs) {
    const startedAt = new Date().toISOString()
    const start = Date.now()
    let lastMeaningfulLine = ''
    let result
    const heartbeat = setInterval(() => {
      console.log(`[compile-python:macos] ${job.backend} elapsed=${Math.floor((Date.now() - start) / 1000)}s log=${job.logPath} last=${lastMeaningfulLine || '(waiting)'}`)
    }, 55_000)
    try {
      result = await runner(job, { onMeaningfulLine: line => { lastMeaningfulLine = line } })
      if (result.code !== 0 || result.signal || result.timedOut) throw new Error(`${job.backend} compilation failed; log: ${job.logPath}\n${boundedTail(result.tail || [])}`)
      const artifactPath = artifactResolver(job.backend)
      if (!existsSync(artifactPath)) throw new Error(`${job.backend} artifact missing: ${artifactPath}`)
      const fileArchitecture = inspectArtifact(artifactPath)
      if (!fileArchitecture.includes(fingerprint.arch)) throw new Error(`${job.backend} architecture mismatch: ${fileArchitecture}`)
      const probeResult = await probe(job.backend, artifactPath)
      appendCheckpoint(checkpointPath, fingerprint, job.backend, {
        status: 'passed', startedAt, endedAt: new Date().toISOString(), durationSeconds: (Date.now() - start) / 1000,
        exitStatus: 0, logPath: job.logPath, artifactPath, artifactSha256: sha256File(artifactPath), fileArchitecture, probe: probeResult,
      })
    } catch (error) {
      appendCheckpoint(checkpointPath, fingerprint, job.backend, {
        status: 'failed', startedAt, endedAt: new Date().toISOString(), durationSeconds: (Date.now() - start) / 1000,
        exitStatus: typeof result?.code === 'number' ? result.code : 1, signal: result?.signal ?? null, timedOut: result?.timedOut ?? false, logPath: job.logPath, error: error.message,
      })
      throw error
    } finally {
      clearInterval(heartbeat)
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const planOnly = args.includes('--plan')
  const resume = args.includes('--resume')
  const backendIndex = args.indexOf('--backend')
  const requestedBackend = backendIndex === -1 ? null : args[backendIndex + 1]
  if ((backendIndex !== -1 && !requestedBackend) || args.filter(arg => arg === '--backend').length > 1) throw new Error('Use --backend stats|rnaseq|plot once')
  if (args.some(arg => !['--plan', '--resume', '--backend', requestedBackend].includes(arg))) throw new Error('Unknown compile-python:macos option')
  const arch = requireDarwinHost()
  const timeoutSeconds = positiveTimeout()
  const headSha = commandOutput('git', ['rev-parse', 'HEAD'])
  const logRoot = path.join(ROOT, '_tmp', 'nuitka')
  requireIgnoredNuitkaRoot(logRoot)
  const python = path.join(ROOT, '.venv-nuitka-build', 'bin', 'python')
  if (!existsSync(python)) throw new Error(`Nuitka builder Python not found: ${python}`)
  const builderPythonVersion = commandOutput(python, ['--version'])
  const builderNuitkaVersion = commandOutput(python, ['-m', 'nuitka', '--version'])
  assertBuilderVersions(builderPythonVersion, builderNuitkaVersion)
  const jobs = buildCompileJobs({ arch, headSha, timeoutSeconds, logRoot }).map(job => ({ ...job, python }))
  const checkpointPath = path.join(logRoot, headSha, arch, 'checkpoint.json')
  if (planOnly) {
    for (const job of jobs) console.log(JSON.stringify(job))
    return
  }
  if (!trackedTreeIsClean()) throw new Error('Refusing to compile from a dirty tracked tree')
  const runtimeManifest = path.join(ROOT, 'python_embedded', 'python_dependencies', 'easycris_runtime_manifest.json')
  if (!existsSync(runtimeManifest)) throw new Error(`Runtime manifest missing: ${runtimeManifest}`)
  const fingerprint = {
    headSha, cleanTree: true, arch,
    pythonVersion: builderPythonVersion,
    nuitkaVersion: builderNuitkaVersion,
    runtimeManifestSha256: sha256File(runtimeManifest),
    backendSourceSha256: await backendSourceHash(ROOT),
  }
  const artifactResolver = backend => path.join(ROOT, 'python_embedded', 'dist', `${backend}.dist`, backend)
  const completed = await resolveReusableBackendsForInvocation({
    requestedBackend,
    resume,
    validate: backends => validateReusableCheckpoints({
      checkpoint: readCheckpoint(checkpointPath), fingerprint, artifactResolver,
      inspectArtifact: artifactPath => commandOutput('file', [artifactPath]), probe: runProtocolProbes, backends,
    }),
  })
  const selected = selectCompileJobs({ requestedBackend, resume, completedBackends: completed })
  await runCompileJobs({
    jobs: jobs.filter(job => selected.includes(job.backend)),
    fingerprint,
    checkpointPath,
    resetCheckpoint: shouldResetCheckpointForInvocation({ requestedBackend, resume }),
    artifactResolver,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[compile-python:macos] ERROR: ${error.message}`)
    process.exitCode = 1
  })
}
