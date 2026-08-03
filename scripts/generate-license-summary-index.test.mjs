import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')
const generatorPath = join(
  repoRoot,
  'scripts',
  'generate-license-summary-index.mjs'
)
const certifiLicenseText = readFileSync(
  join(
    repoRoot,
    'python_embedded',
    'python_dependencies',
    'certifi-2026.7.22.dist-info',
    'licenses',
    'LICENSE'
  ),
  'utf8'
)

function writeFixture(root, path, contents) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, 'utf8')
}

test('generated notices disclose Darwin certifi while excluding EasyCris packages', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easycris-license-generator-'))

  try {
    writeFixture(
      fixtureRoot,
      'legal/source-of-truth.json',
      JSON.stringify(
        {
          notice: {
            canonical: 'src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt',
            mirror: 'legal/THIRD_PARTY_LICENSES.txt',
          },
          artifacts: {
            npm: 'runtime-licenses-js.json',
            rust: 'runtime-licenses-rust.json',
            python: 'legal/python-licenses.json',
            other: 'legal/other-components.json',
          },
        },
        null,
        2
      )
    )
    writeFixture(
      fixtureRoot,
      'runtime-licenses-js.json',
      JSON.stringify({ 'fixture-npm@1.0.0': { licenses: 'MIT' } })
    )
    writeFixture(
      fixtureRoot,
      'runtime-licenses-rust.json',
      JSON.stringify([
        { name: 'fixture-rust', version: '1.0.0', license: 'MIT' },
      ])
    )
    writeFixture(
      fixtureRoot,
      'runtime-licenses-py.json',
      JSON.stringify({
        packages: [
          { name: 'builder-only', version: '99.0.0' },
          { name: 'easycris', version: '1.0.0' },
        ],
      })
    )
    writeFixture(
      fixtureRoot,
      'legal/python-licenses.json',
      JSON.stringify([
        {
          Name: 'anyio',
          Version: '4.11.0',
          License: 'MIT',
          LicenseText: 'Windows AnyIO license text',
        },
        {
          Name: 'numpy',
          Version: '1.0.0',
          License: 'BSD-3-Clause',
          LicenseText: 'Fixture NumPy license text',
        },
        {
          Name: 'matplotlib-inline',
          Version: '0.2.1',
          License: 'UNKNOWN',
          LicenseText:
            'BSD 3-Clause License\nRedistribution and use in source and binary forms are permitted.\nNeither the name of the copyright holder nor contributors may endorse products.',
        },
        {
          Name: 'certifi',
          Version: '2026.7.22',
          License: 'MPL-2.0',
          LicenseText: certifiLicenseText,
        },
        {
          Name: 'kaleido',
          Version: '0.1.0.post1',
          License: 'MIT',
          LicenseText: 'Windows Kaleido license text',
        },
        {
          Name: 'kaleido',
          Version: '0.2.1',
          License: 'MIT',
          LicenseText: 'Darwin Kaleido license text',
        },
        { Name: 'easycris', Version: '1.0.0', License: 'Apache-2.0' },
        { Name: 'easycris-community', Version: '1.0.0', License: 'Apache-2.0' },
      ])
    )
    writeFixture(
      fixtureRoot,
      'legal/other-components.json',
      JSON.stringify({ components: [], licenseTexts: [] })
    )
    writeFixture(
      fixtureRoot,
      'python_embedded/requirements-validated.txt',
      'numpy==1.0.0\nkaleido==0.1.0.post1\n'
    )
    writeFixture(fixtureRoot, 'python_embedded/requirements-rnaseq.txt', '')
    writeFixture(
      fixtureRoot,
      'python_embedded/requirements-macos.txt',
      'certifi==2026.7.22\n'
    )
    writeFixture(
      fixtureRoot,
      'python_embedded/requirements-macos-x86_64.lock',
      'kaleido==0.2.1 --hash=sha256:fixture\n'
    )
    writeFixture(
      fixtureRoot,
      'python_embedded/requirements-macos-arm64.lock',
      'kaleido==0.2.1 --hash=sha256:fixture\n'
    )
    writeFixture(
      fixtureRoot,
      'src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt',
      `Third-Party Notices

Python Package Licenses (pip-licenses)
=====================================

certifi
2026.7.22
MPL-2.0
${certifiLicenseText}

certifi
9999.1.1
MPL-2.0
Wrong competing certifi license text

kaleido
0.1.0.post1
MIT
Windows Kaleido license text

kaleido
0.2.1
MIT
Darwin Kaleido license text

easycris
1.0.0
Apache-2.0
EasyCris first-party text

easycris-community
1.0.0
Apache-2.0
EasyCris first-party text

numpy
1.0.0
BSD-3-Clause
Fixture NumPy license text

JavaScript Runtime License Texts (NPM)
--------------------------------------

fixture-npm@1.0.0
-----------------
License: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy.

Rust Crate License Texts
------------------------

fixture-rust 1.0.0
------------------
License: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy.
`
    )

    const result = spawnSync(process.execPath, [generatorPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const output = readFileSync(
      join(fixtureRoot, 'src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt'),
      'utf8'
    )
    const mirror = readFileSync(
      join(fixtureRoot, 'legal/THIRD_PARTY_LICENSES.txt'),
      'utf8'
    )

    assert.match(output, /^\d+\. certifi 2026\.7\.22 \(MPL-2\.0\)$/m)
    assert.doesNotMatch(output, /certifi 9999\.1\.1/)
    assert.match(output, /^\d+\. kaleido 0\.1\.0\.post1 \(MIT\)$/m)
    assert.match(output, /^\d+\. kaleido 0\.2\.1 \(MIT\)$/m)
    assert.match(output, /Windows Kaleido license text/)
    assert.match(output, /Darwin Kaleido license text/)
    assert.match(output, /anyio 4\.11\.0 \(MIT\)/)
    assert.match(output, /Windows AnyIO license text/)
    assert.match(
      output,
      /^\d+\. matplotlib-inline 0\.2\.1 \(BSD-3-Clause\)$/m
    )
    assert.doesNotMatch(output, /builder-only/)
    assert.match(
      output,
      new RegExp(certifiLicenseText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
    assert.equal(mirror, output)
    assert.doesNotMatch(output, /easycris 1\.0\.0 \(Apache-2\.0\)/)
    assert.doesNotMatch(output, /easycris-community 1\.0\.0 \(Apache-2\.0\)/)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('platform TLS policy distinguishes the Windows stub from Darwin certifi', () => {
  const requirements = readFileSync(
    join(repoRoot, 'python_embedded', 'requirements-validated.txt'),
    'utf8'
  )

  assert.match(
    requirements,
    /Windows retains the custom MIT certifi compatibility stub/
  )
  assert.match(
    requirements,
    /Darwin ships the real certifi package \(MPL-2\.0\) and truststore/
  )
  assert.doesNotMatch(requirements, /ZERO copyleft/)
})
