import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  assertRuntimePlatform,
  backendExecutableName,
  darwinBackendModule,
  darwinInterpreterPath,
  darwinSitePackagesPath,
  pythonVenvExecutable,
} from './python-runtime-constants.mjs'

test('keeps the Windows stats executable inside its compiled distribution', () => {
  const windowsStatsExecutable = path.join(
    'python_embedded',
    'dist',
    'stats.dist',
    backendExecutableName('stats', 'win32')
  )

  assert.equal(windowsStatsExecutable, path.join('python_embedded', 'dist', 'stats.dist', 'stats.exe'))
})

test('uses an extensionless backend executable on Darwin', () => {
  assert.equal(backendExecutableName('stats', 'darwin'), 'stats')
})

test('uses the native virtualenv interpreter layout', () => {
  assert.equal(pythonVenvExecutable('win32'), 'Scripts/python.exe')
  assert.equal(pythonVenvExecutable('darwin'), 'bin/python')
})

test('rejects unsupported release platforms', () => {
  assert.throws(() => assertRuntimePlatform('linux'), /Unsupported runtime platform: linux/)
})

test('resolves the bundled Darwin interpreter and site-packages directories', () => {
  const root = '/fixtures/easycris'

  assert.equal(
    darwinInterpreterPath(root),
    path.join(root, 'python_embedded', 'runtime', 'bin', 'python3.12')
  )
  assert.equal(
    darwinSitePackagesPath(root),
    path.join(root, 'python_embedded', 'runtime', 'lib', 'python3.12', 'site-packages')
  )
})

test('maps every required backend to its Darwin module', () => {
  assert.deepEqual(
    ['stats', 'rnaseq', 'plot'].map(darwinBackendModule),
    ['stats', 'rnaseq', 'plot']
  )
})

test('rejects an unknown Darwin backend module', () => {
  assert.throws(() => darwinBackendModule('unknown'), /Unknown backend: unknown/)
})

test('keeps Darwin helper results free of Windows artifacts and PYTHONPATH', () => {
  const results = [
    darwinInterpreterPath('/fixtures/easycris'),
    darwinSitePackagesPath('/fixtures/easycris'),
    darwinBackendModule('stats'),
  ]

  for (const result of results) {
    assert.doesNotMatch(result, /\.exe|\.dist|PYTHONPATH/i)
  }
})
