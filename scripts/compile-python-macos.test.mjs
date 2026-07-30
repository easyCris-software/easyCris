import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertCheckpointFingerprint,
  buildCompileJobs,
  selectCompileJobs,
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
        const artifact = path.join(process.cwd(), 'python_embedded', 'dist', `${job.backend}.dist`, job.backend)
        await mkdir(path.dirname(artifact), { recursive: true })
        await writeFile(artifact, 'fixture')
        return { code: 0, tail: [] }
      },
      probe: async () => ({ protocol: 'passed' }),
      inspectArtifact: () => 'Mach-O 64-bit executable x86_64',
    }),
    /rnaseq compilation failed; log: .*rnaseq\.log/,
  )
  assert.deepEqual(started, ['stats', 'rnaseq'])
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  assert.equal(checkpoint.backends.stats.status, 'passed')
  assert.equal(checkpoint.backends.rnaseq.status, 'failed')
  assert.equal(checkpoint.backends.plot, undefined)
})
