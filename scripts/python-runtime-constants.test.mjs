import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertRuntimePlatform,
  backendExecutableName,
  pythonVenvExecutable,
} from './python-runtime-constants.mjs'

test('uses exe suffix only on Windows', () => {
  assert.equal(backendExecutableName('stats', 'win32'), 'stats.exe')
  assert.equal(backendExecutableName('stats', 'darwin'), 'stats')
})

test('uses the native virtualenv interpreter layout', () => {
  assert.equal(pythonVenvExecutable('win32'), 'Scripts/python.exe')
  assert.equal(pythonVenvExecutable('darwin'), 'bin/python')
})

test('rejects unsupported release platforms', () => {
  assert.throws(() => assertRuntimePlatform('linux'), /Unsupported runtime platform: linux/)
})
