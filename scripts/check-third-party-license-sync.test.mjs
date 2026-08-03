import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'check-third-party-license-sync.mjs'
)

const defaultPaths = {
  canonical: 'notices/canonical.txt',
  mirror: 'notices/mirror.txt',
  npm: 'artifacts/npm.json',
  rust: 'artifacts/rust.json',
  python: 'artifacts/python.json',
  other: 'artifacts/other.json',
}

const baseNotice = [
  'Third-Party Software Notices',
  '',
  'JavaScript Runtime License Texts (NPM)',
  '',
  'example-package@1.0.0',
  '---------------------',
  'MIT License',
  '',
  'Other License Texts',
  '',
  'Required Example License',
  '------------------------',
  'Required license text.',
].join('\n')

function writeFixtureFile(root, relativePath, content) {
  const absolutePath = join(root, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

function makeFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'easycris-license-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const paths = { ...defaultPaths, ...options.paths }
  const sourceOfTruth = {
    notice: {
      canonical: paths.canonical,
      mirror: paths.mirror,
    },
    artifacts: {
      npm: paths.npm,
      rust: paths.rust,
      python: paths.python,
      other: paths.other,
    },
  }
  writeFixtureFile(
    root,
    'legal/source-of-truth.json',
    JSON.stringify(sourceOfTruth, null, 2)
  )

  const canonical = options.canonical ?? baseNotice
  const mirror = options.mirror ?? canonical
  const other =
    options.other ??
    JSON.stringify({
      licenseTexts: [
        {
          title: 'Required Example License',
          required: true,
        },
        {
          title: 'Optional Example License',
          required: false,
        },
      ],
    })

  const files = {
    [paths.canonical]: canonical,
    [paths.mirror]: mirror,
    [paths.npm]: options.npm ?? '{}',
    [paths.rust]: options.rust ?? '{}',
    [paths.python]: options.python ?? '{}',
    [paths.other]: other,
  }

  for (const [relativePath, content] of Object.entries(files)) {
    if (!options.missing?.includes(relativePath)) {
      writeFixtureFile(root, relativePath, content)
    }
  }

  return { root, paths }
}

function runChecker(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
  })
}

function assertFailure(result, expectedMessage) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, expectedMessage)
}

test('accepts valid artifacts and notices resolved from source-of-truth.json', t => {
  const { root } = makeFixture(t)

  const result = runChecker(root)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Third-party license bundles are in sync\./)
})

test('compares notices after normalizing mixed line endings and trailing newlines', t => {
  const canonical = `${baseNotice.replaceAll('\n', '\r\n')}\r\n\r\n`
  const mirror = `${baseNotice.replaceAll('\n', '\r')}\n`
  const { root } = makeFixture(t, { canonical, mirror })

  const result = runChecker(root)

  assert.equal(result.status, 0, result.stderr)
})

test('rejects notices whose normalized contents differ', t => {
  const { root } = makeFixture(t, {
    mirror: baseNotice.replace('MIT License', 'Apache License'),
  })

  assertFailure(runChecker(root), /Third-party license bundles are out of sync/)
})

test('rejects each missing notice or inventory artifact with its path', async t => {
  for (const [kind, relativePath] of Object.entries({
    canonical: defaultPaths.canonical,
    mirror: defaultPaths.mirror,
    npm: defaultPaths.npm,
    rust: defaultPaths.rust,
    python: defaultPaths.python,
    other: defaultPaths.other,
  })) {
    await t.test(kind, nested => {
      const { root } = makeFixture(nested, { missing: [relativePath] })

      assertFailure(
        runChecker(root),
        new RegExp(relativePath.replaceAll('/', '\\/'))
      )
    })
  }
})

test('rejects machine-specific Windows and macOS paths in inventory artifacts', async t => {
  for (const [kind, value] of [
    ['Windows', '{"path":"C:\\\\Users\\\\alice\\\\package"}'],
    [
      'escaped Windows',
      '{"path":"C:\\\\\\\\Users\\\\\\\\alice\\\\\\\\package"}',
    ],
    ['macOS', '{"path":"/Users/alice/package"}'],
  ]) {
    await t.test(kind, nested => {
      const { root } = makeFixture(nested, { npm: value })

      assertFailure(runChecker(root), /machine-specific user path/)
    })
  }
})

test('rejects machine-specific Windows and macOS paths in the notice bundle', async t => {
  for (const [kind, path] of [
    ['Windows', 'C:\\Users\\alice\\package'],
    ['escaped Windows', 'C:\\\\Users\\\\alice\\\\package'],
    ['macOS', '/Users/alice/package'],
  ]) {
    await t.test(kind, nested => {
      const notice = `${baseNotice}\n${path}`
      const { root } = makeFixture(nested, {
        canonical: notice,
        mirror: notice,
      })

      assertFailure(runChecker(root), /machine-specific absolute/)
    })
  }
})

test('rejects legacy inventory section markers', async t => {
  for (const marker of [
    'JavaScript Runtime Dependencies (NPM)',
    'javascript runtime dependencies (npm)',
    'Rust Crate Notices (Cargo)',
    'Python Package Licenses Summary',
  ]) {
    await t.test(marker, nested => {
      const notice = `${baseNotice}\n${marker}`
      const { root } = makeFixture(nested, {
        canonical: notice,
        mirror: notice,
      })

      assertFailure(runChecker(root), /legacy inventory marker/)
    })
  }
})

test('rejects raw SPDX metadata noise', async t => {
  for (const line of [
    'SPDXVersion: SPDX-2.3',
    'PackageName: example-package',
    'FileChecksum: SHA256: abc',
    'ExtractedText: raw payload',
  ]) {
    await t.test(line, nested => {
      const notice = `${baseNotice}\n${line}`
      const { root } = makeFixture(nested, {
        canonical: notice,
        mirror: notice,
      })

      assertFailure(runChecker(root), /raw SPDX metadata noise/)
    })
  }
})

test('rejects package-block extraction noise', async t => {
  for (const [kind, line] of [
    ['Windows node_modules path', 'License file: node_modules\\pkg\\LICENSE'],
    ['POSIX node_modules path', 'License file: node_modules/pkg/LICENSE'],
    ['mixed-case node_modules path', 'LICENSE FILE: NODE_MODULES/pkg/LICENSE'],
    ['repository', 'Repository: https://example.com/repository'],
    ['mixed-case repository', 'rEpOsItOrY: HTTPS://example.com/repository'],
    ['fence', '```text'],
    ['markdown heading', '## Installation'],
    [
      'markdown badge',
      '[![Build](https://example.com/badge.svg)](https://example.com)',
    ],
    ['legalese HTML', '<legalese>'],
    ['mixed-case legalese HTML', '<LEGALESE>'],
    ['CommonJS export', 'module.exports = example'],
    ['mixed-case CommonJS export', 'MODULE.EXPORTS = example'],
    ['CommonJS require', "const example = require('example')"],
    ['mixed-case CommonJS require', "CONST example = REQUIRE('example')"],
  ]) {
    await t.test(kind, nested => {
      const notice = baseNotice.replace('MIT License', `MIT License\n${line}`)
      const { root } = makeFixture(nested, {
        canonical: notice,
        mirror: notice,
      })

      assertFailure(runChecker(root), /package-block noise|package section/)
    })
  }
})

test('requires the Other License Texts section when a required title exists', t => {
  const notice = baseNotice.replace(
    '\nOther License Texts',
    '\nSupplemental Notices'
  )
  const { root } = makeFixture(t, { canonical: notice, mirror: notice })

  assertFailure(
    runChecker(root),
    /missing required 'Other License Texts' section/
  )
})

test('requires every required other-license title but ignores optional titles', t => {
  const notice = baseNotice.replace(
    'Required Example License',
    'Different License'
  )
  const { root } = makeFixture(t, { canonical: notice, mirror: notice })

  assertFailure(
    runChecker(root),
    /missing required other-license text title: Required Example License/
  )
})

test('matches required other-license sections and titles case-insensitively', t => {
  const notice = baseNotice
    .replace('Other License Texts', 'other license texts')
    .replace('Required Example License', 'required example license')
  const { root } = makeFixture(t, { canonical: notice, mirror: notice })

  const result = runChecker(root)

  assert.equal(result.status, 0, result.stderr)
})

test('reports malformed source-of-truth configuration', t => {
  const { root } = makeFixture(t)
  writeFixtureFile(root, 'legal/source-of-truth.json', '{not-json')

  assertFailure(runChecker(root), /Failed to parse source-of-truth config/)
})
