import { existsSync, readFileSync } from 'node:fs'

const defaults = {
  canonicalPath: 'src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt',
  mirrorPath: 'legal/THIRD_PARTY_LICENSES.txt',
  otherArtifactPath: 'legal/other-components.json',
  npmArtifactPath: 'runtime-licenses-js.json',
  rustArtifactPath: 'runtime-licenses-rust.json',
  pythonArtifactPath: 'legal/python-licenses.json',
}

const sourceOfTruthPath = 'legal/source-of-truth.json'

const legacyMarkers = new Set([
  'JavaScript Runtime Dependencies (NPM)',
  'Rust Crate Notices (Cargo)',
  'Python Package Licenses Summary',
])

const spdxNoisePattern =
  /^(SPDXVersion|DataLicense|DataFormat|SPDXID|DocumentName|DocumentNamespace|Relationship|Package(Name|Supplier|HomePage|LicenseDeclared|CopyrightText|Summary|Comment|DownloadLocation|Version|VerificationCode|LicenseConcluded|LicenseInfoFromFiles|LicenseComments|FilesAnalyzed)|File(Name|Checksum|Type|LicenseConcluded|CopyrightText)|License(ID|Name|CrossReference|Comment)|ExtractedText):\s*/i

function fail(message) {
  throw new Error(message)
}

function normalizeText(text) {
  return text.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '')
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

function resolvePaths() {
  const paths = { ...defaults }
  if (!existsSync(sourceOfTruthPath)) {
    return paths
  }

  let sourceOfTruth
  try {
    sourceOfTruth = JSON.parse(readText(sourceOfTruthPath))
  } catch {
    fail(`Failed to parse source-of-truth config at ${sourceOfTruthPath}`)
  }

  if (sourceOfTruth.notice?.canonical) {
    paths.canonicalPath = String(sourceOfTruth.notice.canonical)
  }
  if (sourceOfTruth.notice?.mirror) {
    paths.mirrorPath = String(sourceOfTruth.notice.mirror)
  }
  if (sourceOfTruth.artifacts?.other) {
    paths.otherArtifactPath = String(sourceOfTruth.artifacts.other)
  }
  if (sourceOfTruth.artifacts?.npm) {
    paths.npmArtifactPath = String(sourceOfTruth.artifacts.npm)
  }
  if (sourceOfTruth.artifacts?.rust) {
    paths.rustArtifactPath = String(sourceOfTruth.artifacts.rust)
  }
  if (sourceOfTruth.artifacts?.python) {
    paths.pythonArtifactPath = String(sourceOfTruth.artifacts.python)
  }

  return paths
}

function assertFileExists(path, description) {
  if (!existsSync(path)) {
    fail(`${description} missing: ${path}`)
  }
}

function containsMachineSpecificUserPath(text) {
  return /[A-Z]:(?:\\+|\/)Users(?:\\+|\/)|\/Users\//i.test(text)
}

function isPackageHeaderLine(current, next) {
  const trimmed = current.trim()
  const nextTrimmed = next.trim()
  if (!trimmed || trimmed.includes(':') || !/^-{3,}$/.test(nextTrimmed)) {
    return false
  }
  return (
    /^[^:]+@[^\\\s]+$/.test(trimmed) ||
    /^[A-Za-z0-9_.+-]+(?:-[A-Za-z0-9_.+-]+)*\s+\d[\w.+-]*$/.test(trimmed)
  )
}

function validateArtifacts(paths) {
  assertFileExists(paths.canonicalPath, 'Canonical file')
  assertFileExists(paths.mirrorPath, 'Mirror file')
  assertFileExists(paths.otherArtifactPath, 'Other components artifact')

  for (const artifactPath of [
    paths.npmArtifactPath,
    paths.rustArtifactPath,
    paths.pythonArtifactPath,
    paths.otherArtifactPath,
  ]) {
    assertFileExists(artifactPath, 'License inventory artifact')
    if (containsMachineSpecificUserPath(readText(artifactPath))) {
      fail(
        `License inventory contains a machine-specific user path: ${artifactPath}`
      )
    }
  }
}

function validateNoticeNoise(canonical, lines) {
  if (/C:\\Users\\/.test(canonical)) {
    fail(
      'Third-party license bundle contains blocked noise token (machine-specific absolute Windows path).'
    )
  }
  if (canonical.includes('/Users/')) {
    fail(
      'Third-party license bundle contains blocked noise token (machine-specific absolute macOS path).'
    )
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (legacyMarkers.has(trimmed)) {
      fail(
        `Third-party license bundle contains blocked noise token (legacy inventory marker): ${trimmed}`
      )
    }
    if (trimmed && spdxNoisePattern.test(trimmed)) {
      fail(
        `Third-party license bundle contains blocked noise token (raw SPDX metadata noise): ${trimmed}`
      )
    }
  }
}

function validatePackageBlocks(lines) {
  const sectionStart = lines.indexOf('JavaScript Runtime License Texts (NPM)')
  if (sectionStart < 0) {
    return
  }

  let inPackageSection = false
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) {
      continue
    }

    const next = index + 1 < lines.length ? lines[index + 1].trim() : ''
    if (isPackageHeaderLine(trimmed, next)) {
      inPackageSection = true
      continue
    }
    if (!inPackageSection) {
      continue
    }

    if (/^License file:\s*node_modules[\\/]/.test(trimmed)) {
      fail(
        `Third-party license bundle contains package-block noise (node_modules license path): ${trimmed}`
      )
    }
    if (/^Repository:\s*https?:\/\//.test(trimmed)) {
      fail(
        `Third-party license bundle contains package-block noise (repository line): ${trimmed}`
      )
    }
    if (/^```/.test(trimmed)) {
      fail(
        'Third-party license bundle contains fenced code block inside a package section.'
      )
    }
    if (/^#{1,6}\s+/.test(trimmed) || /^\[!\[/.test(trimmed)) {
      fail(
        `Third-party license bundle contains markdown artifact inside a package section: ${trimmed}`
      )
    }
    if (/<\/?legalese>/.test(trimmed)) {
      fail(
        `Third-party license bundle contains HTML/README artifact inside a package section: ${trimmed}`
      )
    }
    if (
      /^module\.exports\b/.test(trimmed) ||
      /^(var|let|const)\s+\w+\s*=.*require\(/.test(trimmed)
    ) {
      fail(
        `Third-party license bundle contains code artifact inside a package section: ${trimmed}`
      )
    }
  }
}

function validateRequiredOtherLicenses(lines, otherArtifactPath) {
  let otherArtifact
  try {
    otherArtifact = JSON.parse(readText(otherArtifactPath))
  } catch {
    fail(`Failed to parse other components artifact at ${otherArtifactPath}`)
  }

  const requiredTitles = (otherArtifact.licenseTexts ?? [])
    .filter(entry => entry?.title && entry.required !== false)
    .map(entry => String(entry.title).trim())
    .filter(Boolean)

  if (requiredTitles.length === 0) {
    return
  }
  if (!lines.includes('Other License Texts')) {
    fail(
      "Third-party license bundle is missing required 'Other License Texts' section."
    )
  }
  for (const title of requiredTitles) {
    if (!lines.includes(title)) {
      fail(
        `Third-party license bundle is missing required other-license text title: ${title}`
      )
    }
  }
}

function checkLicenseSync() {
  const paths = resolvePaths()
  validateArtifacts(paths)

  const canonical = normalizeText(readText(paths.canonicalPath))
  const mirror = normalizeText(readText(paths.mirrorPath))
  if (canonical !== mirror) {
    fail(
      `Third-party license bundles are out of sync:\n  Canonical: ${paths.canonicalPath}\n  Mirror:    ${paths.mirrorPath}`
    )
  }

  const lines = canonical.split('\n')
  validateNoticeNoise(canonical, lines)
  validatePackageBlocks(lines)
  validateRequiredOtherLicenses(lines, paths.otherArtifactPath)
}

try {
  checkLicenseSync()
  console.log('Third-party license bundles are in sync.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
