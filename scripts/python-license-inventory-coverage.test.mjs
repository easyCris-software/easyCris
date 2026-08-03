import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const frozenWindowsBaselineHash =
  '1aa8c8ead2b8a7127644770a09089711886c17c181edd71ccd9d407f33f34c0b'

function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/[-_.\s]+/g, '-')
}

function exactPins(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('--'))
    .map(line => {
      const match = /^([A-Za-z0-9_.-]+)==([^\s;#]+)/.exec(line)
      assert.ok(match, `non-exact Python runtime entry in ${path}: ${line}`)
      return [normalizeName(match[1]), match[2]]
    })
}

function noticePairs(notice) {
  const pythonSection = notice
    .split('Python Package Licenses (pip-licenses)')[1]
    ?.split('JavaScript Runtime License Texts (NPM)')[0]
  assert.ok(pythonSection, 'missing Python notice section')
  const lines = pythonSection.split(/\r?\n/)
  const pairs = new Set()
  for (let index = 1; index < lines.length; index += 1) {
    const version = lines[index].trim()
    const name = lines[index - 1].trim()
    if (name && /^\d[\w.+-]*$/.test(version)) {
      pairs.add(`${normalizeName(name)}==${version}`)
    }
  }
  return pairs
}

test('legal inventory preserves Windows and covers the pruned Darwin runtime', () => {
  const inventory = JSON.parse(
    readFileSync(resolve(root, 'legal/python-licenses.json'), 'utf8')
  )
  const windowsBaseline = inventory.filter(row => !row.Platform)
  assert.equal(windowsBaseline.length, 154)
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(windowsBaseline))
      .digest('hex'),
    frozenWindowsBaselineHash,
    'the frozen upstream/main Windows legal baseline changed'
  )

  const disclosed = new Map(
    inventory.map(row => [
      `${normalizeName(row.Name)}==${row.Version}`,
      row,
    ])
  )
  const shippedPairs = new Set(
    windowsBaseline.map(
      row => `${normalizeName(row.Name)}==${row.Version}`
    )
  )
  for (const lock of [
    'python_embedded/requirements-macos-x86_64.lock',
    'python_embedded/requirements-macos-arm64.lock',
  ]) {
    for (const [name, version] of exactPins(resolve(root, lock))) {
      shippedPairs.add(`${name}==${version}`)
    }
  }
  for (const pair of [
    'cpython==3.12.13',
    'kaleido-executable==0.2.1',
    'kaleido-chromium-credits==0.2.1',
    'kaleido-mathjax==0.2.1',
  ]) {
    shippedPairs.add(pair)
  }

  assert.equal(inventory.length, 175)
  for (const key of shippedPairs) {
    const row = disclosed.get(key)
    assert.ok(row, `missing shipped runtime license row: ${key}`)
    if (key !== 'matplotlib-inline==0.2.1') {
      assert.ok(
        String(row.License ?? '').trim() && row.License !== 'UNKNOWN',
        `missing normalized license: ${key}`
      )
    }
    assert.ok(String(row.LicenseText ?? '').trim(), `missing license text: ${key}`)
  }

  for (const key of [
    'kaleido==0.1.0.post1',
    'kaleido==0.2.1',
    'truststore==0.10.4',
    'certifi==2026.7.22',
    'cpython==3.12.13',
    'kaleido-executable==0.2.1',
    'kaleido-chromium-credits==0.2.1',
    'kaleido-mathjax==0.2.1',
  ]) {
    assert.ok(disclosed.has(key), `missing required runtime notice: ${key}`)
  }
  assert.equal(disclosed.get('certifi==2026.7.22').License, 'MPL-2.0')

  const darwinRows = inventory.filter(row => row.Platform === 'Darwin')
  assert.equal(darwinRows.length, 21)
  for (const row of darwinRows) {
    const name = normalizeName(row.Name)
    assert.ok(
      !['pip', 'nuitka', 'pip-licenses'].includes(name),
      `provisioning-only Darwin package was disclosed: ${name}`
    )
    const provenance = String(row.LicenseFile ?? '')
    assert.doesNotMatch(
      provenance,
      /(?:\/Users\/|file:\/\/|_tmp|\.venv-macos-build|wheelhouse|provision\.log)/i
    )
  }

  for (const relativePath of [
    'legal/THIRD_PARTY_LICENSES.txt',
    'src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt',
  ]) {
    const notice = readFileSync(resolve(root, relativePath), 'utf8')
    const pairs = noticePairs(notice)
    for (const key of shippedPairs) {
      assert.ok(pairs.has(key), `missing ${key} from ${relativePath}`)
    }
    assert.match(
      notice,
      /matplotlib-inline\n0\.2\.1\nSummary ref:[^\n]*\nBSD-3-Clause\n/i,
      `frozen UNKNOWN label was not normalized from its actual BSD text in ${relativePath}`
    )
  }
})
