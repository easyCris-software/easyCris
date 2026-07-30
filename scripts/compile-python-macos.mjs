#!/usr/bin/env node
/** Controlled, checkpointed Darwin Nuitka compilation. */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REQUIRED_BACKENDS } from './python-runtime-constants.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECKPOINT_SCHEMA_VERSION = 1
const DEFAULT_TIMEOUT_SECONDS = 9000

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

function completedBackends(checkpoint, fingerprint) {
  if (!checkpoint.fingerprint) return []
  assertCheckpointFingerprint(fingerprint, checkpoint.fingerprint)
  return REQUIRED_BACKENDS.filter(backend => checkpoint.backends?.[backend]?.status === 'passed')
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

async function defaultRunner(job, { onMeaningfulLine }) {
  await mkdir(path.dirname(job.logPath), { recursive: true })
  const child = spawn(job.python, job.args, {
    cwd: ROOT,
    env: { ...process.env, ...job.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = createWriteStream(job.logPath, { flags: 'a' })
  const tail = []
  let lastMeaningfulLine = ''
  const consume = chunk => {
    const text = String(chunk)
    log.write(text)
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        lastMeaningfulLine = line.trim()
        tail.push(lastMeaningfulLine)
        if (tail.length > 80) tail.shift()
        onMeaningfulLine(lastMeaningfulLine)
      }
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  const timeout = setTimeout(() => child.kill('SIGTERM'), Number(job.env.EASYCRIS_NUITKA_TIMEOUT_SECS) * 1000)
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve({ code, tail, lastMeaningfulLine }))
  })
  clearTimeout(timeout)
  await new Promise(resolve => log.end(resolve))
  return result
}

async function runProtocolProbes(backend, artifactPath) {
  const input = backend === 'plot' ? '{"action":"ping"}\n' : '{}\n'
  const result = await new Promise((resolve, reject) => {
    const child = spawn(artifactPath, [], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`${backend} protocol probe failed: ${result.stderr.trim()}`)
  if (backend !== 'plot') return { protocol: 'passed' }
  const probeRoot = path.join(ROOT, '_tmp', 'nuitka-probes')
  await mkdir(probeRoot, { recursive: true })
  const outputs = ['pdf', 'tiff'].map(format => path.join(probeRoot, `plot-probe.${format}`))
  for (const [index, outputPath] of outputs.entries()) {
    const exportResult = await new Promise((resolve, reject) => {
      const child = spawn(artifactPath, [], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout }))
      child.stdin.end(JSON.stringify({ action: 'export_plot', plotly_json: { data: [], layout: {} }, output_path: outputPath, options: { format: index === 0 ? 'pdf' : 'tiff' } }))
    })
    if (exportResult.code !== 0 || !existsSync(outputPath) || readFileSync(outputPath).length === 0) {
      throw new Error(`plot ${index === 0 ? 'PDF' : 'TIFF'} export probe failed`)
    }
  }
  return { protocol: 'passed', pdf: 'passed', tiff: 'passed' }
}

export async function runCompileJobs({ jobs, fingerprint, checkpointPath, runner = defaultRunner, probe = runProtocolProbes, inspectArtifact = artifactPath => commandOutput('file', [artifactPath]) }) {
  for (const job of jobs) {
    const startedAt = new Date().toISOString()
    const start = Date.now()
    let lastMeaningfulLine = ''
    const heartbeat = setInterval(() => {
      console.log(`[compile-python:macos] ${job.backend} elapsed=${Math.floor((Date.now() - start) / 1000)}s log=${job.logPath} last=${lastMeaningfulLine || '(waiting)'}`)
    }, 55_000)
    try {
      const result = await runner(job, { onMeaningfulLine: line => { lastMeaningfulLine = line } })
      if (result.code !== 0) throw new Error(`${job.backend} compilation failed; log: ${job.logPath}\n${boundedTail(result.tail || [])}`)
      const artifactPath = path.join(ROOT, 'python_embedded', 'dist', `${job.backend}.dist`, job.backend)
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
        exitStatus: 1, logPath: job.logPath, error: error.message,
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
    pythonVersion: commandOutput(python, ['--version']),
    nuitkaVersion: commandOutput(python, ['-m', 'nuitka', '--version']),
    runtimeManifestSha256: sha256File(runtimeManifest),
    backendSourceSha256: createHash('sha256').update(await readFile(path.join(ROOT, 'scripts', 'compile_python_nuitka.py'))).digest('hex'),
  }
  const completed = completedBackends(readCheckpoint(checkpointPath), fingerprint)
  const selected = selectCompileJobs({ requestedBackend, resume, completedBackends: completed })
  await runCompileJobs({ jobs: jobs.filter(job => selected.includes(job.backend)), fingerprint, checkpointPath })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[compile-python:macos] ERROR: ${error.message}`)
    process.exitCode = 1
  })
}
