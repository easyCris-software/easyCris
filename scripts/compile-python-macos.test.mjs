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
  runCompileJobs,
  runProtocolProbes,
  resolveReusableBackendsForInvocation,
  scheduleProcessTermination,
  selectCompileJobs,
  shouldResetCheckpointForInvocation,
  truncateAttemptLog,
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

test('plain fresh all-backend builds ignore reusable checkpoints', async () => {
  const completed = await resolveReusableBackendsForInvocation({
    requestedBackend: null,
    resume: false,
    validate: async () => {
      throw new Error('stale checkpoint must not be inspected')
    },
  })
  assert.deepEqual(completed, [])
})

test('checkpoint reset is limited to fresh all-backend and stats rebuilds', () => {
  assert.equal(shouldResetCheckpointForInvocation({ requestedBackend: null, resume: false }), true)
  assert.equal(shouldResetCheckpointForInvocation({ requestedBackend: 'stats', resume: false }), true)
  assert.equal(shouldResetCheckpointForInvocation({ requestedBackend: 'rnaseq', resume: false }), false)
  assert.equal(shouldResetCheckpointForInvocation({ requestedBackend: 'plot', resume: false }), false)
  assert.equal(shouldResetCheckpointForInvocation({ requestedBackend: null, resume: true }), false)
})

test('resume and requested-backend builds validate only their reusable prerequisite prefix', async () => {
  for (const invocation of [
    { requestedBackend: null, resume: true, expected: ['stats', 'rnaseq', 'plot'] },
    { requestedBackend: 'stats', resume: false, expected: [] },
    { requestedBackend: 'rnaseq', resume: false, expected: ['stats'] },
    { requestedBackend: 'plot', resume: false, expected: ['stats', 'rnaseq'] },
  ]) {
    const completed = await resolveReusableBackendsForInvocation({
      ...invocation,
      validate: async backends => backends,
    })
    assert.deepEqual(completed, invocation.expected)
  }
})

test('fresh compile replaces a stale checkpoint before recording the first backend', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-fresh-checkpoint-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const checkpointPath = path.join(temporary, 'checkpoint.json')
  const artifact = path.join(temporary, 'stats.dist', 'stats')
  await writeFile(checkpointPath, JSON.stringify({
    schemaVersion: 1,
    fingerprint: { ...currentFingerprint, headSha: 'stale-head' },
    backends: { stats: { status: 'passed' } },
  }))

  await runCompileJobs({
    jobs: [{ backend: 'stats', logPath: path.join(temporary, 'stats.log'), env: {} }],
    fingerprint: currentFingerprint,
    checkpointPath,
    resetCheckpoint: true,
    runner: async () => {
      await mkdir(path.dirname(artifact), { recursive: true })
      await writeFile(artifact, 'fresh stats artifact')
      return { code: 0, signal: null, timedOut: false, tail: [] }
    },
    probe: async () => ({ protocol: 'passed' }),
    inspectArtifact: () => 'Mach-O 64-bit executable x86_64',
    artifactResolver: () => artifact,
  })

  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  assert.equal(checkpoint.fingerprint.headSha, currentFingerprint.headSha)
  assert.equal(checkpoint.backends.stats.status, 'passed')
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
        if (job.backend === 'rnaseq') return { code: 7, signal: 'SIGTERM', timedOut: true, tail: ['RNA-seq compiler failed'] }
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
  assert.equal(checkpoint.backends.rnaseq.exitStatus, 7)
  assert.equal(checkpoint.backends.rnaseq.signal, 'SIGTERM')
  assert.equal(checkpoint.backends.rnaseq.timedOut, true)
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

test('compiled protocol and export probes allow 120 seconds for a cold start', async t => {
  // Mutation caught: restoring the shorter 60-second wrapper bound that rejected a valid cold executable.
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-cold-probe-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const observedTimeouts = []

  const result = await runProtocolProbes('plot', '/fake/plot', {
    probeRoot: temporary,
    runProcess: async (_command, input, timeoutMs) => {
      observedTimeouts.push(timeoutMs)
      const payload = JSON.parse(input)
      if (payload.output_path) await writeFile(payload.output_path, 'fresh export')
      return {
        code: 0,
        signal: null,
        timedOut: false,
        stdout: '{"success":true}',
        stderr: 'RequestsDependencyWarning: optional charset detector differs',
      }
    },
  })

  assert.deepEqual(observedTimeouts, [120_000, 120_000, 120_000])
  assert.deepEqual(result, { protocol: 'passed', pdf: 'passed', tiff: 'passed' })
})

test('protocol process failures identify timeout, signal, and exit status', () => {
  const cases = [
    {
      result: { code: 0, signal: null, timedOut: true, stdout: '', stderr: 'warning only' },
      expected: [/timed out=true/i, /signal=null/i, /exit status=0/i],
    },
    {
      result: { code: null, signal: 'SIGKILL', timedOut: false, stdout: '', stderr: '' },
      expected: [/timed out=false/i, /signal=SIGKILL/i, /exit status=null/i],
    },
    {
      result: { code: 7, signal: null, timedOut: false, stdout: '', stderr: 'backend failure' },
      expected: [/timed out=false/i, /signal=null/i, /exit status=7/i],
    },
  ]

  for (const { result, expected } of cases) {
    assert.throws(
      () => assertSuccessfulJson(result, 'stats'),
      error => expected.every(pattern => pattern.test(error.message)),
    )
  }
})

test('protocol success accepts non-fatal stderr warnings', () => {
  const payload = assertSuccessfulJson({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: '{"success":true,"result":"ready"}',
    stderr: 'RequestsDependencyWarning: optional charset detector differs',
  }, 'stats')

  assert.deepEqual(payload, { success: true, result: 'ready' })
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
    pid: 321, timeoutMs: 9_030_000, setTimer: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length }, clearTimer: () => {},
    signalProcess: (_pid, signal) => signals.push(signal),
  })
  assert.equal(callbacks.length, 1)
  assert.equal(callbacks[0].delay, 9_030_000)
  callbacks[0].callback()
  assert.deepEqual(signals, ['SIGTERM'])
  assert.equal(callbacks.length, 2)
  assert.equal(callbacks[1].delay, 5_000)
  callbacks[1].callback()
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  cancel()
})

test('backend source hash changes for each compiler/backend input', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-source-hash-test-'))
  const inputs = ['scripts/compile_python_nuitka.py', 'python_embedded/stats.py', 'python_embedded/rnaseq.py', 'python_embedded/plot.py']
  for (const [index, input] of inputs.entries()) {
    const target = path.join(temporary, input)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, `fixture-${index}`)
  }
  const baseline = await backendSourceHash(temporary)
  for (const input of inputs) {
    const target = path.join(temporary, input)
    await writeFile(target, `${await readFile(target, 'utf8')}-changed`)
    assert.notEqual(await backendSourceHash(temporary), baseline, input)
    await writeFile(target, (await readFile(target, 'utf8')).replace('-changed', ''))
  }
  await rm(temporary, { recursive: true, force: true })
})

test('resume rejects schema, path, architecture, failed fresh probes, and incomplete plot evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-resume-reject-test-'))
  const artifact = path.join(temporary, 'stats')
  await writeFile(artifact, 'artifact')
  const digest = (await import('node:crypto')).createHash('sha256').update('artifact').digest('hex')
  const base = { schemaVersion: 1, fingerprint: currentFingerprint, backends: { stats: { status: 'passed', artifactPath: artifact, artifactSha256: digest, fileArchitecture: 'Mach-O x86_64', probe: { protocol: 'passed' } } } }
  const args = extra => ({ checkpoint: extra, fingerprint: currentFingerprint, artifactResolver: () => artifact, inspectArtifact: () => 'Mach-O x86_64', probe: async () => ({ protocol: 'passed' }) })
  await assert.rejects(() => validateReusableCheckpoints(args({ ...base, schemaVersion: 9 })), /schema/)
  await assert.rejects(() => validateReusableCheckpoints(args({ ...base, backends: { stats: { ...base.backends.stats, artifactPath: '/wrong' } } })), /artifact path/)
  await assert.rejects(() => validateReusableCheckpoints({ ...args(base), inspectArtifact: () => 'Mach-O arm64' }), /architecture/)
  await assert.rejects(() => validateReusableCheckpoints({ ...args(base), probe: async () => ({ protocol: 'failed' }) }), /re-probe/)
  await rm(temporary, { recursive: true, force: true })
})

test('attempt logs truncate old output before a new attempt', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'easycris-log-test-'))
  const logPath = path.join(temporary, 'stats.log')
  await writeFile(logPath, 'old compiler output')
  const stream = await truncateAttemptLog(logPath)
  stream.end('new compiler output')
  await new Promise(resolve => stream.on('finish', resolve))
  assert.equal(await readFile(logPath, 'utf8'), 'new compiler output')
  await rm(temporary, { recursive: true, force: true })
})

test('builder validation requires Python 3.12 and exactly Nuitka 2.8.10', () => {
  assert.doesNotThrow(() => assertBuilderVersions('Python 3.12.13', '2.8.10'))
  assert.doesNotThrow(() => assertBuilderVersions('Python 3.12.13', '2.8.10\nCommercial: None\nPython: 3.12.13'))
  assert.throws(() => assertBuilderVersions('Python 3.13.0', '2.8.10'), /Python 3\.12/)
  assert.throws(() => assertBuilderVersions('Python 3.12.13', '2.8.11'), /Nuitka 2\.8\.10/)
})
