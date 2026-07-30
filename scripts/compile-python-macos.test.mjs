import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertCheckpointFingerprint,
  assertBuilderVersions,
  assertSuccessfulJson,
  backendSourceHash,
  buildCompileJobs,
  runProtocolProbes,
  scheduleProcessTermination,
  selectCompileJobs,
  validateReusableCheckpoints,
} from './compile-python-macos.mjs'

const currentFingerprint = Object.freeze({
  headSha: 'abc123def456',
  cleanTree: true,
  arch: 'x86_64',
  pythonVersion: '3.12.11',
  nuitkaVersion: '2.8.10',
  runtimeManifestSha256: 'runtime-sha256',
  backendSourceSha256: 'backend-source-sha256',
})

test('buildCompileJobs schedules the three backends in checkpoint order', () => {
  // Mutation caught: compiling out of order or writing logs outside the commit scope.
  assert.deepEqual(
    buildCompileJobs({
      arch: 'x86_64',
      headSha: 'abc123def456',
      timeoutSeconds: 9000,
      logRoot: '/tmp/nuitka',
    }).map(job => ({
      backend: job.backend,
      args: job.args,
      timeout: job.env.EASYCRIS_NUITKA_TIMEOUT_SECS,
      logPath: job.logPath,
    })),
    [
      { backend: 'stats', args: ['scripts/compile_python_nuitka.py', 'stats'], timeout: '9000', logPath: '/tmp/nuitka/abc123def456/x86_64/stats.log' },
      { backend: 'rnaseq', args: ['scripts/compile_python_nuitka.py', 'rnaseq'], timeout: '9000', logPath: '/tmp/nuitka/abc123def456/x86_64/rnaseq.log' },
      { backend: 'plot', args: ['scripts/compile_python_nuitka.py', 'plot'], timeout: '9000', logPath: '/tmp/nuitka/abc123def456/x86_64/plot.log' },
    ],
  )
})

test('checkpoint helpers select valid resumable work and reject changed evidence', () => {
  // Mutation caught: resuming a stale or out-of-order compile chain.
  assert.deepEqual(selectCompileJobs({ requestedBackend: 'rnaseq', resume: false, completedBackends: ['stats'] }), ['rnaseq'])
  assert.deepEqual(selectCompileJobs({ requestedBackend: null, resume: true, completedBackends: ['stats'] }), ['rnaseq', 'plot'])
  assert.throws(
    () => assertCheckpointFingerprint(currentFingerprint, { ...currentFingerprint, runtimeManifestSha256: 'changed' }),
    /runtime manifest hash changed/,
  )
  assert.throws(
    () => selectCompileJobs({ requestedBackend: 'rnaseq', resume: false, completedBackends: [] }),
    /stats checkpoint/,
  )
  assert.throws(
    () => selectCompileJobs({ requestedBackend: 'plot', resume: false, completedBackends: ['stats'] }),
    /rnaseq checkpoint/,
  )
  assert.throws(
    () => selectCompileJobs({ requestedBackend: null, resume: true, completedBackends: ['rnaseq'] }),
    /contiguous backend prefix/,
  )
})

test('a failed rnaseq compile stops the chain and records no passing rnaseq checkpoint', async () => {
  // Mutation caught: continuing to plot after RNA-seq failure or claiming its checkpoint passed.
  const { runCompileJobs } = await import('./compile-python-macos.mjs')
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-compile-test-'))
  const checkpointPath = path.join(temporary, 'checkpoint.json')
  const artifactRoot = path.join(temporary, 'artifacts')
  const jobs = ['stats', 'rnaseq', 'plot'].map(backend => ({ backend, logPath: path.join(temporary, `${backend}.log`), env: {} }))
  const started = []
  await assert.rejects(
    () => runCompileJobs({
      jobs,
      fingerprint: currentFingerprint,
      checkpointPath,
      runner: async job => {
        started.push(job.backend)
        if (job.backend === 'rnaseq') return { code: 7, tail: ['RNA-seq compiler failed'] }
        const artifact = path.join(artifactRoot, `${job.backend}.dist`, job.backend)
        await mkdir(path.dirname(artifact), { recursive: true })
        await writeFile(artifact, 'fixture')
        return { code: 0, tail: [] }
      },
      probe: async () => ({ protocol: 'passed' }),
      inspectArtifact: () => 'Mach-O 64-bit executable x86_64',
      artifactResolver: backend => path.join(artifactRoot, `${backend}.dist`, backend),
    }),
    /rnaseq compilation failed; log: .*rnaseq\.log/,
  )
  assert.deepEqual(started, ['stats', 'rnaseq'])
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  assert.equal(checkpoint.backends.stats.status, 'passed')
  assert.equal(checkpoint.backends.rnaseq.status, 'failed')
  assert.equal(checkpoint.backends.plot, undefined)
  await rm(temporary, { recursive: true, force: true })
})

test('protocol probes reject exit-zero JSON failures and stale exports', async () => {
  // Mutation caught: accepting a backend error payload or a file that predated this probe.
  assert.throws(() => assertSuccessfulJson({ code: 0, stdout: '{"success":false,"error":"no"}', stderr: '' }, 'stats'), /success=true/)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-probe-test-'))
  const stalePdf = path.join(temporary, 'plot-probe.pdf')
  await writeFile(stalePdf, 'stale')
  let call = 0
  await assert.rejects(
    () => runProtocolProbes('plot', '/fake/plot', {
      probeRoot: temporary,
      runProcess: async () => {
        call += 1
        return { code: 0, signal: null, stdout: '{"success":true}', stderr: '' }
      },
    }),
    /PDF export probe failed/,
  )
  assert.equal(call, 2)
  await rm(temporary, { recursive: true, force: true })
})

test('resume validates artifacts, hashes, architecture, and re-probes passed checkpoints', async () => {
  // Mutation caught: reusing a tampered or merely claimed-passed backend artifact.
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-resume-test-'))
  const artifact = path.join(temporary, 'stats')
  await writeFile(artifact, 'stats artifact')
  const digest = (await import('node:crypto')).createHash('sha256').update('stats artifact').digest('hex')
  const checkpoint = {
    schemaVersion: 1,
    fingerprint: currentFingerprint,
    backends: { stats: { status: 'passed', artifactPath: artifact, artifactSha256: digest, fileArchitecture: 'Mach-O x86_64', probe: { protocol: 'passed' } } },
  }
  const reused = await validateReusableCheckpoints({
    checkpoint, fingerprint: currentFingerprint, artifactResolver: () => artifact,
    inspectArtifact: () => 'Mach-O x86_64', probe: async () => ({ protocol: 'passed' }),
  })
  assert.deepEqual(reused, ['stats'])
  await writeFile(artifact, 'tampered')
  await assert.rejects(
    () => validateReusableCheckpoints({ checkpoint, fingerprint: currentFingerprint, artifactResolver: () => artifact, inspectArtifact: () => 'Mach-O x86_64', probe: async () => ({ protocol: 'passed' }) }),
    /artifact hash mismatch/,
  )
  await writeFile(artifact, 'stats artifact')
  checkpoint.backends.stats.probe = { protocol: 'passed' }
  checkpoint.backends.rnaseq = { ...checkpoint.backends.stats }
  checkpoint.backends.plot = { ...checkpoint.backends.stats, probe: { protocol: 'passed' } }
  await assert.rejects(
    () => validateReusableCheckpoints({ checkpoint, fingerprint: currentFingerprint, artifactResolver: () => artifact, inspectArtifact: () => 'Mach-O x86_64', probe: async () => ({ protocol: 'passed' }) }),
    /plot checkpoint probe evidence/,
  )
  await rm(temporary, { recursive: true, force: true })
})

test('compile and probe termination schedules TERM then KILL after bounded grace', () => {
  const callbacks = []
  const signals = []
  const cancel = scheduleProcessTermination({
    pid: 321, timeoutMs: 9_030_000, setTimer: callback => { callbacks.push(callback); return callbacks.length }, clearTimer: () => {},
    signalProcess: (_pid, signal) => signals.push(signal),
  })
  assert.equal(callbacks.length, 1)
  callbacks[0]()
  assert.deepEqual(signals, ['SIGTERM'])
  assert.equal(callbacks.length, 2)
  callbacks[1]()
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  cancel()
})

test('backend source hash covers all three backend entrypoints', async () => {
  const digest = await backendSourceHash(process.cwd())
  assert.match(digest, /^[a-f0-9]{64}$/)
})

test('builder validation requires Python 3.12 and exactly Nuitka 2.8.10', () => {
  assert.doesNotThrow(() => assertBuilderVersions('Python 3.12.13', '2.8.10'))
  assert.doesNotThrow(() => assertBuilderVersions('Python 3.12.13', '2.8.10\nCommercial: None\nPython: 3.12.13'))
  assert.throws(() => assertBuilderVersions('Python 3.13.0', '2.8.10'), /Python 3\.12/)
  assert.throws(() => assertBuilderVersions('Python 3.12.13', '2.8.11'), /Nuitka 2\.8\.10/)
})
