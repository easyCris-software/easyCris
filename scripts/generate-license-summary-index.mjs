#!/usr/bin/env node
/**
 * generate-license-summary-index.mjs
 *
 * Produces a clean shipped THIRD_PARTY_LICENSES bundle by:
 * - Reading dependency/license inventories from audit artifacts (not in-file inventory blocks)
 * - Rebuilding the summary index
 * - Removing legacy in-file runtime inventory sections
 * - Removing SPDX metadata noise lines from shipped output
 *
 * Canonical output:
 *   src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt
 * Mirror output:
 *   legal/THIRD_PARTY_LICENSES.txt
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SOURCE_OF_TRUTH_PATH = resolve('legal/source-of-truth.json')

function loadSourceOfTruth() {
  if (!existsSync(SOURCE_OF_TRUTH_PATH)) return {}
  try {
    return JSON.parse(readFileSync(SOURCE_OF_TRUTH_PATH, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to parse source-of-truth config at ${SOURCE_OF_TRUTH_PATH}: ${error.message}`)
  }
}

const SOURCE_OF_TRUTH = loadSourceOfTruth()
const CANONICAL_PATH = resolve(SOURCE_OF_TRUTH?.notice?.canonical || 'src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt')
const MIRROR_PATH = resolve(SOURCE_OF_TRUTH?.notice?.mirror || 'legal/THIRD_PARTY_LICENSES.txt')

const NPM_ARTIFACT_PATH = resolve(SOURCE_OF_TRUTH?.artifacts?.npm || 'runtime-licenses-js.json')
const RUST_ARTIFACT_PATH = resolve(SOURCE_OF_TRUTH?.artifacts?.rust || 'runtime-licenses-rust.json')
const PYTHON_ARTIFACT_PATH = resolve(SOURCE_OF_TRUTH?.artifacts?.python || 'legal/python-licenses.json')
const OTHER_ARTIFACT_PATH = resolve(SOURCE_OF_TRUTH?.artifacts?.other || 'legal/other-components.json')
const PYTHON_RUNTIME_DEPENDENCIES_DIR = resolve('python_embedded/python_dependencies')

const LEGACY_MARKER_NPM = 'JavaScript Runtime Dependencies (NPM)'
const LEGACY_MARKER_RUST = 'Rust Crate Notices (Cargo)'
const LEGACY_MARKER_PYTHON_SUMMARY = 'Python Package Licenses Summary'

const MARKER_PYTHON_LICENSE_TEXT = 'Python Package Licenses (pip-licenses)'
const MARKER_JS_LICENSE_TEXT = 'JavaScript Runtime License Texts (NPM)'
const MARKER_RUST_LICENSE_TEXT = 'Rust Crate License Texts'
const MARKER_OTHER_LICENSE_TEXTS = 'Other License Texts'

const SPDX_PREFERENCE = [
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  'Zlib',
  '0BSD',
  'MIT-0',
  'Unlicense',
  'CC0-1.0',
  'PSF-2.0',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'Unicode-3.0',
  'HPND',
  'BSL-1.0',
  'CDLA-Permissive-2.0',
  'MPL-2.0',
]

const SPDX_ALLOWED = new Set(SPDX_PREFERENCE)

const FIRST_PARTY_EXCLUSIONS = new Set(['tauri-app', 'easycris', 'certifi'])
const NON_RUNTIME_EXCLUSIONS = new Set(['@rajioba1/managing-software-licensing'])

const JS_LICENSE_OVERRIDES = new Map([
  ['@plotly/mapbox-gl@1.13.4', 'BSD-3-Clause AND MIT'],
  ['stack-trace@0.0.9', 'MIT'],
  ['@mapbox/jsonlint-lines-primitives@2.0.2', 'MIT'],
  ['json-bignum@0.0.3', 'MIT'],
])

const RUST_LICENSE_OVERRIDES = new Map([
  ['dlopen2', 'MIT'],
  ['dlopen2_derive', 'MIT'],
])

function normalizeLineEndings(text) {
  return text.replace(/\r+\n/g, '\n').replace(/\r/g, '\n')
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+\([^)]*\)\s*$/, '')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isExcludedPackage(name) {
  const normalized = normalizeName(name)
  return FIRST_PARTY_EXCLUSIONS.has(normalized) || NON_RUNTIME_EXCLUSIONS.has(normalized)
}

function normalizeLicense(raw) {
  if (!raw || raw.trim() === '') return 'UNKNOWN'

  let cleaned = raw.trim()
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) cleaned = cleaned.slice(1, -1).trim()
  if (cleaned.startsWith('(')) cleaned = cleaned.slice(1).trim()
  cleaned = cleaned.replace(/\*$/, '')

  const normalizedLower = cleaned.toLowerCase().replace(/\s+/g, ' ')
  const normMap = {
    'mit license': 'MIT',
    'the mit license (mit)': 'MIT',
    'mit license (mit)': 'MIT',
    'mit license*': 'MIT',
    mit: 'MIT',
    'mit-cmu': 'MIT-CMU',
    bsd: 'BSD-3-Clause',
    'bsd license': 'BSD-3-Clause',
    'bsd 3-clause': 'BSD-3-Clause',
    'bsd 3-clause license': 'BSD-3-Clause',
    'bsd-3-clause': 'BSD-3-Clause',
    'bsd 2-clause': 'BSD-2-Clause',
    'bsd 2-clause license': 'BSD-2-Clause',
    'bsd-2-clause': 'BSD-2-Clause',
    'apache software license': 'Apache-2.0',
    'apache 2.0': 'Apache-2.0',
    'apache license 2.0': 'Apache-2.0',
    'apache license, version 2.0': 'Apache-2.0',
    'python software foundation license': 'PSF-2.0',
    psf: 'PSF-2.0',
    psfl: 'PSF-2.0',
    'dual license': 'Apache-2.0',
    'license agreement for matplotlib versions 1.3.0 and later': 'PSF-2.0',
  }

  if (normMap[normalizedLower]) return normMap[normalizedLower]
  if (SPDX_ALLOWED.has(cleaned)) return cleaned

  if (cleaned.includes(' OR ')) {
    const parts = cleaned.split(/\s+OR\s+/).map((part) => normalizeLicense(part.trim()))
    for (const preferred of SPDX_PREFERENCE) {
      if (parts.includes(preferred)) return preferred
    }
    return parts[0]
  }

  if (cleaned.includes(' AND ')) {
    const parts = cleaned
      .split(/\s+AND\s+/)
      .map((part) => normalizeLicense(part.trim()))
      .filter(Boolean)
    return [...new Set(parts)].join(' AND ')
  }

  if (cleaned.includes(';')) {
    const parts = cleaned.split(';').map((part) => part.trim())
    for (const preferred of SPDX_PREFERENCE) {
      if (parts.includes(preferred)) return preferred
    }
    return normalizeLicense(parts[0])
  }

  if (/\bmit\b/i.test(cleaned)) return 'MIT'
  if (/\bapache\b/i.test(cleaned) && /\b2(\.0)?\b/.test(cleaned)) return 'Apache-2.0'
  if (/\bpsf(l)?\b/i.test(cleaned) || /python software foundation/i.test(cleaned)) return 'PSF-2.0'
  if (/\bbsd\b/i.test(cleaned) && /\b(2|two)[ -]?clause\b/i.test(cleaned)) return 'BSD-2-Clause'
  if (/\bbsd\b/i.test(cleaned)) return 'BSD-3-Clause'
  if (/\bisc\b/i.test(cleaned)) return 'ISC'
  if (/\bunlicense\b/i.test(cleaned)) return 'Unlicense'
  if (/\bzlib\b/i.test(cleaned)) return 'Zlib'

  return cleaned
}

function readRequiredJson(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Missing required ${label} runtime artifact: ${path}`)
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return { path, data: parsed }
  } catch (error) {
    throw new Error(`Failed to parse ${label} artifact at ${path}: ${error.message}`)
  }
}

function parseNpmKey(key) {
  const separator = key.lastIndexOf('@')
  if (separator <= 0 || separator === key.length - 1) return null
  return {
    name: key.slice(0, separator),
    version: key.slice(separator + 1),
  }
}

function parseNpmArtifact(rawData) {
  const packages = []

  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new Error('Unexpected NPM artifact format (expected object keyed by package@version)')
  }

  for (const [key, meta] of Object.entries(rawData)) {
    const parsed = parseNpmKey(key)
    if (!parsed) continue

    const { name, version } = parsed
    if (isExcludedPackage(name)) continue

    const override = JS_LICENSE_OVERRIDES.get(`${name}@${version}`)
    const license = override || meta?.licenses || meta?.license || 'UNKNOWN'

    packages.push({ name, version, license, ecosystem: 'npm' })
  }

  return packages
}

function parseRustArtifact(rawData) {
  const rows = Array.isArray(rawData) ? rawData : []
  const packages = []

  for (const row of rows) {
    const name = row?.name
    const version = row?.version
    if (!name || !version) continue
    if (isExcludedPackage(name)) continue

    const override = RUST_LICENSE_OVERRIDES.get(`${name}@${version}`) || RUST_LICENSE_OVERRIDES.get(name)
    const license = override || row?.license || 'UNKNOWN'

    packages.push({ name, version, license, ecosystem: 'rust' })
  }

  return packages
}

function normalizePythonPackageName(name) {
  return normalizeName(name).replace(/[-_.]+/g, '-')
}

function collectRuntimePythonVersions() {
  const versions = new Map()
  if (!existsSync(PYTHON_RUNTIME_DEPENDENCIES_DIR)) return versions

  const entries = readdirSync(PYTHON_RUNTIME_DEPENDENCIES_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.endsWith('.dist-info')) continue

    const base = entry.name.slice(0, -'.dist-info'.length)
    const match = /^(.*)-([0-9][\w.+-]*)$/.exec(base)
    if (!match) continue

    const packageName = normalizePythonPackageName(match[1])
    const version = match[2]
    const current = versions.get(packageName)
    if (!current) {
      versions.set(packageName, version)
      continue
    }
    const compare = String(version).localeCompare(String(current), 'en', {
      numeric: true,
      sensitivity: 'base',
    })
    if (compare >= 0) {
      versions.set(packageName, version)
    }
  }

  return versions
}

function pickPythonRow(current, candidate, runtimeVersion) {
  if (!current) return candidate

  const currentIsRuntime = runtimeVersion && current.version === runtimeVersion
  const candidateIsRuntime = runtimeVersion && candidate.version === runtimeVersion
  if (candidateIsRuntime && !currentIsRuntime) return candidate
  if (currentIsRuntime && !candidateIsRuntime) return current

  const currentKnown = normalizeLicense(current.license) !== 'UNKNOWN'
  const candidateKnown = normalizeLicense(candidate.license) !== 'UNKNOWN'
  if (candidateKnown && !currentKnown) return candidate
  if (currentKnown && !candidateKnown) return current

  const compare = String(candidate.version).localeCompare(String(current.version), 'en', {
    numeric: true,
    sensitivity: 'base',
  })

  return compare >= 0 ? candidate : current
}

function parsePythonArtifact(rawData, runtimeVersions) {
  const rows = Array.isArray(rawData) ? rawData : Array.isArray(rawData?.packages) ? rawData.packages : []
  const byName = new Map()

  for (const row of rows) {
    const name = row?.Name || row?.name
    let version = row?.Version || row?.version
    if (!name) continue

    if (!version && /\.dist-info$/i.test(name)) {
      const match = /^(.*)-([0-9][\w.+-]*)\.dist-info$/i.exec(name)
      if (match) {
        version = match[2]
      }
    }

    if (!version) continue
    if (isExcludedPackage(name)) continue

    const rawLicense = String(row?.License || row?.license || 'UNKNOWN')
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) || 'UNKNOWN'
    const license = normalizeLicense(rawLicense)
    const canonicalName = normalizePythonPackageName(name)
    const candidate = { name, version, license, ecosystem: 'python' }
    const runtimeVersion = runtimeVersions.get(canonicalName)
    const current = byName.get(canonicalName)

    byName.set(canonicalName, pickPythonRow(current, candidate, runtimeVersion))
  }

  return [...byName.values()]
}

function parseOtherComponentsArtifact(rawData) {
  const componentRows = Array.isArray(rawData?.components) ? rawData.components : []
  const licenseTexts = Array.isArray(rawData?.licenseTexts) ? rawData.licenseTexts : []
  const packages = []

  for (const row of componentRows) {
    const name = String(row?.name || '').trim()
    if (!name || isExcludedPackage(name)) continue

    const version = String(row?.version || 'manual').trim() || 'manual'
    const license = normalizeLicense(String(row?.license || 'UNKNOWN'))
    packages.push({ name, version, license, ecosystem: 'other' })
  }

  return { packages, licenseTexts }
}

function dedupePackages(packages) {
  const unique = []
  const seen = new Set()
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}::${normalizeName(pkg.name)}::${pkg.version}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(pkg)
  }
  return unique
}

function buildSingleVersionMap(packages) {
  const versionsByName = new Map()
  for (const pkg of packages) {
    const key = normalizeName(pkg.name)
    if (!versionsByName.has(key)) versionsByName.set(key, new Set())
    versionsByName.get(key).add(String(pkg.version))
  }

  const singleVersionMap = new Map()
  for (const [key, versions] of versionsByName.entries()) {
    if (versions.size === 1) {
      singleVersionMap.set(key, [...versions][0])
    }
  }
  return singleVersionMap
}

function sortPackages(packages) {
  return packages.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    if (nameCmp !== 0) return nameCmp
    return String(a.version).localeCompare(String(b.version), 'en', { sensitivity: 'base' })
  })
}

function buildCollapsedGroups(packages) {
  const groups = new Map()
  for (const pkg of packages) {
    const normalizedLicense = normalizeLicense(pkg.license)
    const key = `${normalizeName(pkg.name)}::${normalizedLicense}`
    if (!groups.has(key)) {
      groups.set(key, { name: pkg.name, license: normalizedLicense, versions: new Set() })
    }
    groups.get(key).versions.add(pkg.version)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
}

function buildSummaryReferenceMaps(byEcosystem) {
  const refs = {
    npm: new Map(),
    rust: new Map(),
    python: new Map(),
    pythonByName: new Map(),
  }

  const npmGroups = buildCollapsedGroups(byEcosystem.npm)
  npmGroups.forEach((group, idx) => {
    refs.npm.set(`${normalizeName(group.name)}::${normalizeLicense(group.license)}`, idx + 1)
  })

  const rustGroups = buildCollapsedGroups(byEcosystem.rust)
  rustGroups.forEach((group, idx) => {
    refs.rust.set(`${normalizeName(group.name)}::${normalizeLicense(group.license)}`, idx + 1)
  })

  byEcosystem.python.forEach((pkg, idx) => {
    const key = `${normalizePythonPackageName(pkg.name)}::${String(pkg.version).trim()}`
    refs.python.set(key, idx + 1)
    const nameKey = normalizePythonPackageName(pkg.name)
    if (!refs.pythonByName.has(nameKey)) refs.pythonByName.set(nameKey, idx + 1)
  })

  return refs
}

function buildSummaryBlock(byEcosystem) {
  const totalPackagesCore = byEcosystem.npm.length + byEcosystem.rust.length + byEcosystem.python.length
  const totalPackagesAll = totalPackagesCore + byEcosystem.other.length
  const summaryLines = []

  summaryLines.push('========================================================================')
  summaryLines.push('Summary Index')
  summaryLines.push('========================================================================')
  summaryLines.push('')
  summaryLines.push('Licenses')
  summaryLines.push('------------------------------------------------------------------------')
  summaryLines.push('')

  const sortVersions = (versions) => {
    return [...versions].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' }))
  }

  const renderEcosystem = (label, packages, collapseVersions) => {
    const collapsed = collapseVersions ? buildCollapsedGroups(packages) : null
    const displayCount = collapseVersions ? collapsed.length : packages.length
    const heading = collapseVersions
      ? `### ${label} (${displayCount} grouped, ${packages.length} total versions)`
      : `### ${label} (${displayCount})`

    summaryLines.push(heading)
    summaryLines.push('')

    if (collapseVersions && collapsed) {
      collapsed.forEach((group, idx) => {
        summaryLines.push(`${idx + 1}. ${group.name} (${group.license}) versions: ${sortVersions(group.versions).join(', ')}`)
      })
      summaryLines.push('')
      return
    }

    packages.forEach((pkg, idx) => {
      const license = normalizeLicense(pkg.license)
      if (pkg.assetItems) {
        summaryLines.push(`${idx + 1}. ${pkg.name} (${license})`)
      } else {
        summaryLines.push(`${idx + 1}. ${pkg.name} ${pkg.version} (${license})`)
      }
    })
    summaryLines.push('')
  }

  renderEcosystem('JavaScript (NPM)', byEcosystem.npm, true)
  renderEcosystem('Rust (Cargo)', byEcosystem.rust, true)
  renderEcosystem('Python (pip)', byEcosystem.python, false)
  if (byEcosystem.other.length > 0) {
    renderEcosystem('Other Third-Party Components', byEcosystem.other, false)
  }

  const licenseCounts = {}
  for (const ecosystem of ['npm', 'rust', 'python']) {
    for (const pkg of byEcosystem[ecosystem]) {
      const license = normalizeLicense(pkg.license)
      licenseCounts[license] = (licenseCounts[license] || 0) + 1
    }
  }
  const uniqueLicenses = Object.keys(licenseCounts).length

  return {
    block: summaryLines.join('\n'),
    totalPackages: totalPackagesCore,
    totalPackagesAll,
    uniqueLicenses,
  }
}

function buildOtherLicenseTextsBlock(licenseTexts) {
  const entries = Array.isArray(licenseTexts) ? licenseTexts : []
  if (entries.length === 0) return ''

  const lines = [MARKER_OTHER_LICENSE_TEXTS, '-------------------', '']

  for (const entry of entries) {
    const title = String(entry?.title || '').trim()
    const required = entry?.required !== false
    if (!title) {
      if (required) throw new Error('Other component license text entry is missing "title"')
      continue
    }

    let bodyLines = []
    const sourceFile = String(entry?.sourceFile || '').trim()
    if (sourceFile) {
      const sourcePath = resolve(sourceFile)
      if (!existsSync(sourcePath)) {
        if (required) throw new Error(`Missing required other license text source file: ${sourcePath}`)
      } else {
        bodyLines = normalizeLineEndings(readFileSync(sourcePath, 'utf-8')).split('\n')
      }
    } else if (Array.isArray(entry?.lines)) {
      bodyLines = entry.lines.map((line) => String(line ?? ''))
    } else if (typeof entry?.text === 'string' && entry.text.trim()) {
      bodyLines = normalizeLineEndings(entry.text).split('\n')
    }

    if (required && bodyLines.length === 0) {
      throw new Error(`Missing required text body for other license entry "${title}"`)
    }
    if (bodyLines.length === 0) continue

    lines.push(title)
    lines.push('-'.repeat(Math.max(3, title.length)))
    lines.push(...bodyLines)
    lines.push('')
  }

  return collapseBlankRuns(lines).join('\n')
}

function replaceOrInsertSummaryBlock(fileText, summaryBlock, firstInventoryStart) {
  const normalized = normalizeLineEndings(fileText)
  const lines = normalized.split('\n')

  const summaryHeadingIndex = lines.findIndex((line, idx) => idx < firstInventoryStart && line.trim() === 'Summary Index')

  if (summaryHeadingIndex !== -1) {
    let replaceStart = summaryHeadingIndex
    if (summaryHeadingIndex > 0 && /^={3,}$/.test(lines[summaryHeadingIndex - 1].trim())) {
      replaceStart = summaryHeadingIndex - 1
    }
    const replaceEnd = firstInventoryStart
    if (replaceEnd <= replaceStart) {
      throw new Error('Invalid summary replacement range (summary and inventory boundaries are out of order)')
    }
    const replacementLines = [...summaryBlock.split('\n'), '']
    lines.splice(replaceStart, Math.max(0, replaceEnd - replaceStart), ...replacementLines)
    return lines.join('\n')
  }

  const headerAnchor = 'This file aggregates'
  const anchorIndex = normalized.indexOf(headerAnchor)
  if (anchorIndex !== -1) {
    const paragraphEnd = normalized.indexOf('\n\n', anchorIndex)
    if (paragraphEnd !== -1) {
      return normalized.slice(0, paragraphEnd + 2) + summaryBlock + '\n\n' + normalized.slice(paragraphEnd + 2)
    }
  }

  return summaryBlock + '\n\n' + normalized
}

function replaceOrInsertOtherLicenseTexts(fileText, otherBlock) {
  const lines = normalizeLineEndings(fileText).split('\n')
  let firstInventoryStart = findFirstInventoryBoundary(lines)
  const sectionStart = lines.findIndex((line, idx) => idx < firstInventoryStart && line.trim() === MARKER_OTHER_LICENSE_TEXTS)

  if (sectionStart !== -1) {
    lines.splice(sectionStart, Math.max(0, firstInventoryStart - sectionStart))
    firstInventoryStart = findFirstInventoryBoundary(lines)
  }

  if (!otherBlock || otherBlock.trim() === '') {
    return collapseBlankRuns(lines).join('\n')
  }

  const insertion = ['', ...otherBlock.split('\n'), '']
  lines.splice(firstInventoryStart, 0, ...insertion)
  return collapseBlankRuns(lines).join('\n')
}

function collapseBlankRuns(lines, maxRun = 2) {
  const out = []
  let blankRun = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1
      if (blankRun <= maxRun) out.push(line)
      continue
    }
    blankRun = 0
    out.push(line)
  }
  return out
}

function stripLegacyInventorySections(fileText) {
  const lines = normalizeLineEndings(fileText).split('\n')

  const ranges = [
    { start: LEGACY_MARKER_PYTHON_SUMMARY, end: MARKER_PYTHON_LICENSE_TEXT },
    { start: LEGACY_MARKER_NPM, end: LEGACY_MARKER_RUST },
    { start: LEGACY_MARKER_RUST, end: MARKER_JS_LICENSE_TEXT },
  ]

  const removals = []
  for (const range of ranges) {
    const start = lines.findIndex((line) => line.includes(range.start))
    if (start === -1) continue

    const end = lines.findIndex((line, idx) => idx > start && line.includes(range.end))
    if (end === -1) {
      throw new Error(`Legacy marker mismatch: found "${range.start}" without terminating marker "${range.end}"`)
    }

    removals.push({ start, end })
  }

  removals
    .sort((a, b) => b.start - a.start)
    .forEach(({ start, end }) => {
      lines.splice(start, Math.max(0, end - start))
    })

  return collapseBlankRuns(lines).join('\n')
}

function sanitizeSpdxNoiseLines(fileText) {
  const lines = normalizeLineEndings(fileText).split('\n')
  const cleaned = []

  const spdxPrefixRegex = /^(SPDXVersion|DataLicense|DataFormat|SPDXID|DocumentName|DocumentNamespace|Relationship|Package(Name|Supplier|HomePage|LicenseDeclared|CopyrightText|Summary|Comment|DownloadLocation|Version|VerificationCode|LicenseConcluded|LicenseInfoFromFiles|LicenseComments|FilesAnalyzed)|File(Name|Checksum|Type|LicenseConcluded|CopyrightText)|License(ID|Name|CrossReference|Comment)|ExtractedText):/i

  let skipTextBlock = false
  let skipSpdxBlock = false

  const looksLikeSpdxFragment = (startIdx) => {
    let matches = 0
    const stop = Math.min(lines.length, startIdx + 24)
    for (let idx = startIdx; idx < stop; idx += 1) {
      const candidate = lines[idx].trim()
      if (candidate === '') {
        if (matches >= 3) break
        continue
      }
      if (spdxPrefixRegex.test(candidate)) {
        matches += 1
      }
    }
    return matches >= 3
  }

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    const trimmed = line.trim()

    if (skipTextBlock) {
      if (trimmed.includes('</text>')) skipTextBlock = false
      continue
    }

    if (skipSpdxBlock) {
      if (/^Package(Summary|Comment):\s*<text>/i.test(trimmed) && !trimmed.includes('</text>')) {
        skipTextBlock = true
        continue
      }

      if (trimmed === '' || spdxPrefixRegex.test(trimmed)) {
        continue
      }

      skipSpdxBlock = false
    }

    if (spdxPrefixRegex.test(trimmed) && looksLikeSpdxFragment(idx)) {
      skipSpdxBlock = true
      continue
    }

    cleaned.push(line)
  }

  return collapseBlankRuns(cleaned).join('\n')
}

function isDashedLine(line) {
  return /^-{3,}\s*$/.test(String(line || '').trim())
}

function isNpmPackageHeading(line) {
  return /^@?[\w./+-]+@[\w.+-]+$/.test(String(line || '').trim())
}

function isRustPackageHeading(line) {
  return /^[A-Za-z0-9_.+-]+(?:-[A-Za-z0-9_.+-]+)*\s+\d[\w.+-]*$/.test(String(line || '').trim())
}

function isPackageHeading(lines, idx) {
  if (idx < 0 || idx >= lines.length - 1) return false
  const heading = String(lines[idx] || '').trim()
  if (!heading || heading.includes(':')) return false
  if (!isDashedLine(lines[idx + 1])) return false
  if (heading === MARKER_JS_LICENSE_TEXT || heading === MARKER_RUST_LICENSE_TEXT || heading === MARKER_PYTHON_LICENSE_TEXT) return false
  return isNpmPackageHeading(heading) || isRustPackageHeading(heading)
}

function extractReadmeLicenseContent(contentLines, declaredLicense) {
  const normalizedLicense = normalizeLicense(declaredLicense)
  const isLegalSignal = (line) => {
    const trimmed = String(line || '').trim()
    if (!trimmed) return false
    return /(^copyright\b|all rights reserved|permission is hereby granted|redistribution and use|this software is provided|without warranty|in no event|licensed under|apache license|mit license|isc license|bsd\s*(?:2|3)?[- ]?clause|gnu general public license|mozilla public license)/i.test(
      trimmed
    )
  }
  const hasCodeArtifact = (line) => {
    const trimmed = String(line || '').trim()
    if (!trimmed) return false
    return /^(var|let|const)\s+\w+\s*=|^module\.exports|^function\s+\w+\(|=>|^\s*[{[\]}]?\s*$|^\s*\/\/|^\s*\/\*/.test(trimmed)
  }
  const canonicalFallbackFor = (license, existingLines) => {
    let copyrightLine = existingLines.find((line) => /(copyright|\(c\))/i.test(line))
    if (!copyrightLine) copyrightLine = 'Copyright (c) the respective authors'
    copyrightLine = String(copyrightLine).replace(/\s*MIT License\s*$/i, '').trim()

    if (license === 'MIT') {
      return [
        copyrightLine,
        '',
        'Permission is hereby granted, free of charge, to any person obtaining',
        'a copy of this software and associated documentation files (the',
        '"Software"), to deal in the Software without restriction, including',
        'without limitation the rights to use, copy, modify, merge, publish,',
        'distribute, sublicense, and/or sell copies of the Software, and to',
        'permit persons to whom the Software is furnished to do so, subject to',
        'the following conditions:',
        '',
        'The above copyright notice and this permission notice shall be',
        'included in all copies or substantial portions of the Software.',
        '',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,',
        'EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF',
        'MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
        'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY',
        'CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,',
        'TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE',
        'SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
      ]
    }

    if (license === 'ISC') {
      return [
        copyrightLine,
        '',
        'Permission to use, copy, modify, and/or distribute this software for',
        'any purpose with or without fee is hereby granted, provided that the',
        'above copyright notice and this permission notice appear in all copies.',
        '',
        'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
        'WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF',
        'MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR',
        'ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES',
        'WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN',
        'ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF',
        'OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
      ]
    }

    if (license === 'Unlicense') {
      return [
        'This is free and unencumbered software released into the public domain.',
        '',
        'Anyone is free to copy, modify, publish, use, compile, sell, or',
        'distribute this software, either in source code form or as a compiled',
        'binary, for any purpose, commercial or non-commercial, and by any',
        'means.',
        '',
        'In jurisdictions that recognize copyright laws, the author or authors',
        'of this software dedicate any and all copyright interest in the',
        'software to the public domain. We make this dedication for the benefit',
        'of the public at large and to the detriment of our heirs and',
        'successors.',
        '',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,',
        'EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF',
        'MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
        'IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR',
        'OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,',
        'ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR',
        'OTHER DEALINGS IN THE SOFTWARE.',
      ]
    }

    if (license === 'Apache-2.0') {
      return [
        'Apache License 2.0',
        'Apache License 2.0 text is included earlier in this document.',
      ]
    }

    return existingLines
  }

  const normalizeLicenseTextLines = (inputLines) => {
    return inputLines.map((line) => {
      let next = String(line ?? '')
      next = next.replace(/`([^`]+)`/g, '$1')
      next = next.replace(/^#{1,6}\s+/, '')
      if (/^\*\*.*\*\*$/u.test(next)) {
        const inner = next.slice(2, -2)
        if (/[A-Za-z0-9]/u.test(inner)) next = inner
      }
      if (/^__.*__$/u.test(next)) {
        const inner = next.slice(2, -2)
        if (/[A-Za-z0-9]/u.test(inner)) next = inner
      }
      next = next.replace(/<\/?legalese>/gi, '')
      return next
    })
  }

  let lines = [...contentLines]
  const licenseHeadingIndex = lines.findIndex((line) => /^\s*#{1,6}\s*license\b/i.test(line.trim()) || /^\s*license\s*$/i.test(line.trim()))
  if (licenseHeadingIndex !== -1) {
    lines = lines.slice(licenseHeadingIndex + 1)
  }

  lines = lines.filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '') return true
    if (/^```/.test(trimmed)) return false
    if (/^#{1,6}\s+/.test(trimmed)) return false
    if (/^\[!\[/.test(trimmed) || /^!\[/.test(trimmed)) return false
    if (/^\|.+\|$/.test(trimmed)) return false
    return true
  })

  const legalStart = lines.findIndex((line) => isLegalSignal(line))
  if (legalStart > 0) {
    lines = lines.slice(legalStart)
  }

  const hasMitGrant = lines.some((line) => /Permission is hereby granted/i.test(line))
  const hasUnlicenseLead = lines.some((line) => /free and unencumbered software released into the public domain/i.test(line))
  const hasAnyLegalSignal = lines.some((line) => isLegalSignal(line))
  const codeArtifactCount = lines.filter((line) => hasCodeArtifact(line)).length
  if (
    (normalizedLicense === 'MIT' && !hasMitGrant) ||
    (normalizedLicense === 'Unlicense' && !hasUnlicenseLead) ||
    (!hasAnyLegalSignal && codeArtifactCount >= 1)
  ) {
    lines = canonicalFallbackFor(normalizedLicense, lines)
  }

  return collapseBlankRuns(normalizeLicenseTextLines(lines), 1)
}

function cleanPackageBlock(blockLines) {
  const heading = blockLines[0]
  const underline = blockLines[1]
  const rest = blockLines.slice(2)

  const metadata = []
  const content = []
  let inMetadata = true
  let sawMetadata = false
  let readmeDerived = false
  let declaredLicense = 'UNKNOWN'

  for (const line of rest) {
    const trimmed = line.trim()

    if (inMetadata) {
      if (/^License:\s*/i.test(trimmed)) {
        sawMetadata = true
        declaredLicense = trimmed.replace(/^License:\s*/i, '').trim() || declaredLicense
        metadata.push(line)
        continue
      }

      if (/^(Repository|Source):\s*/i.test(trimmed)) {
        sawMetadata = true
        continue
      }

      if (/^License file:\s*/i.test(trimmed)) {
        sawMetadata = true
        if (/readme/i.test(trimmed)) readmeDerived = true
        if (/Included below in this document/i.test(trimmed)) {
          metadata.push(line)
        }
        continue
      }

      if (trimmed === '' && sawMetadata) {
        inMetadata = false
        continue
      }

      if (!sawMetadata && trimmed === '') {
        continue
      }

      inMetadata = false
    }

    content.push(line)
  }

  const codeArtifactCount = content.filter((line) => /^(var|let|const)\s+\w+\s*=|^module\.exports|^function\s+\w+\(|=>/.test(String(line || '').trim())).length
  const hasLicenseBodySignal = content.some((line) =>
    /(permission is hereby granted|redistribution and use|this software is provided|without warranty|in no event|isc license|apache license,\s*version|mit license|unencumbered software released into the public domain|gnu general public license|mozilla public license)/i.test(
      String(line || '').trim()
    )
  )
  const looksLikeArtifactNoise = codeArtifactCount >= 1 && !hasLicenseBodySignal

  const normalizeLicenseBodyFormatting = (inputLines) =>
    inputLines.map((line) => {
      let next = String(line ?? '')
      next = next.replace(/`([^`]+)`/g, '$1')
      next = next.replace(/^#{1,6}\s+/, '')
      if (/^\*\*.*\*\*$/u.test(next)) {
        const inner = next.slice(2, -2)
        if (/[A-Za-z0-9]/u.test(inner)) next = inner
      }
      if (/^__.*__$/u.test(next)) {
        const inner = next.slice(2, -2)
        if (/[A-Za-z0-9]/u.test(inner)) next = inner
      }
      next = next.replace(/<\/?legalese>/gi, '')
      return next
    })

  const cleanedContent =
    readmeDerived || looksLikeArtifactNoise
      ? extractReadmeLicenseContent(content, declaredLicense)
      : normalizeLicenseBodyFormatting(content)
  while (cleanedContent.length > 0 && cleanedContent[0].trim() === '') cleanedContent.shift()
  while (cleanedContent.length > 0 && cleanedContent[cleanedContent.length - 1].trim() === '') cleanedContent.pop()

  const out = [heading, underline]
  if (metadata.length > 0) {
    out.push(...collapseBlankRuns(metadata, 1))
  }
  if (cleanedContent.length > 0) {
    if (out[out.length - 1].trim() !== '') out.push('')
    out.push(...cleanedContent)
  }
  out.push('')
  return out
}

function buildNpmLicenseFileHintSet(rawNpmArtifact) {
  const hints = new Set()
  if (!rawNpmArtifact || typeof rawNpmArtifact !== 'object' || Array.isArray(rawNpmArtifact)) return hints

  for (const [key, meta] of Object.entries(rawNpmArtifact)) {
    const licenseFile = String(meta?.licenseFile || '')
    if (!licenseFile) continue
    if (/readme(\.|$)/i.test(licenseFile) || /\.(?:[cm]?js|ts)$/i.test(licenseFile)) {
      hints.add(key.trim())
    }
  }
  return hints
}

function sanitizePackageSectionNoise(fileText, npmLicenseFileHints = new Set()) {
  const lines = normalizeLineEndings(fileText).split('\n')
  const jsStart = lines.findIndex((line) => line.includes(MARKER_JS_LICENSE_TEXT))
  if (jsStart === -1) return fileText

  const output = [...lines.slice(0, jsStart)]
  let idx = jsStart

  while (idx < lines.length) {
    if (!isPackageHeading(lines, idx)) {
      output.push(lines[idx])
      idx += 1
      continue
    }

    const blockStart = idx
    idx += 2
    while (idx < lines.length && !isPackageHeading(lines, idx)) {
      idx += 1
    }

    const block = lines.slice(blockStart, idx)
    const heading = String(block[0] || '').trim()
    const forceReadmeMode = npmLicenseFileHints.has(heading)

    const withMode = (() => {
      if (!forceReadmeMode) return cleanPackageBlock(block)

      // Force readme-derived cleanup for artifact-indicated README/source-backed blocks.
      const headingLine = block[0]
      const dashLine = block[1]
      const rest = block.slice(2)
      const metadata = []
      const content = []
      let inMeta = true
      let declaredLicense = 'UNKNOWN'

      for (const line of rest) {
        const trimmed = line.trim()
        if (inMeta) {
          if (/^License:\s*/i.test(trimmed)) {
            declaredLicense = trimmed.replace(/^License:\s*/i, '').trim() || declaredLicense
            metadata.push(line)
            continue
          }
          if (/^(Repository|Source|License file):\s*/i.test(trimmed)) continue
          if (trimmed === '') {
            inMeta = false
            continue
          }
          inMeta = false
        }
        content.push(line)
      }

      const cleanedContent = extractReadmeLicenseContent(content, declaredLicense)
      const out = [headingLine, dashLine, ...metadata]
      if (out[out.length - 1]?.trim() !== '') out.push('')
      out.push(...cleanedContent)
      out.push('')
      return collapseBlankRuns(out)
    })()

    output.push(...withMode)
  }

  return collapseBlankRuns(output).join('\n')
}

function annotateJsRustSummaryRefs(fileText, summaryRefs, rustSingleVersionByName = new Map()) {
  const lines = normalizeLineEndings(fileText).split('\n')
  const jsStart = lines.findIndex((line) => line.includes(MARKER_JS_LICENSE_TEXT))
  if (jsStart === -1) return fileText

  const output = [...lines.slice(0, jsStart)]
  let idx = jsStart

  while (idx < lines.length) {
    if (!isPackageHeading(lines, idx)) {
      output.push(lines[idx])
      idx += 1
      continue
    }

    const blockStart = idx
    idx += 2
    while (idx < lines.length && !isPackageHeading(lines, idx)) idx += 1
    const block = lines.slice(blockStart, idx)

    const heading = String(block[0] || '').trim()
    let headingLine = block[0]
    let body = block.slice(2).filter((line) => !/^Summary ref:\s*/i.test(String(line || '').trim()))
    const licenseLine = body.find((line) => /^License:\s*/i.test(String(line || '').trim()))
    const normalizedLicense = normalizeLicense(String(licenseLine || '').replace(/^License:\s*/i, '').trim())

    let refLabel = null
    let refNumber = null

    if (isNpmPackageHeading(heading)) {
      const parsed = parseNpmKey(heading)
      if (parsed) {
        refNumber = summaryRefs.npm.get(`${normalizeName(parsed.name)}::${normalizedLicense}`) || null
        refLabel = 'JavaScript (NPM)'
      }
    } else if (isRustPackageHeading(heading)) {
      const rustMatch = /^(.+?)\s+(\d[\w.+-]*)$/.exec(heading)
      if (rustMatch) {
        const crateName = rustMatch[1].trim()
        const textVersion = rustMatch[2].trim()
        const preferredVersion = rustSingleVersionByName.get(normalizeName(crateName))

        if (preferredVersion && preferredVersion !== textVersion) {
          headingLine = `${crateName} ${preferredVersion}`
          const cratePattern = escapeRegExp(crateName)
          const versionPattern = escapeRegExp(textVersion)
          const downloadedRefPattern = new RegExp(
            `(downloaded-rust-licenses/${cratePattern}-)${versionPattern}(-LICENSE-[A-Za-z0-9._+-]+)`,
            'g'
          )
          body = body.map((line) => String(line || '').replace(downloadedRefPattern, `$1${preferredVersion}$2`))
        }

        refNumber = summaryRefs.rust.get(`${normalizeName(crateName)}::${normalizedLicense}`) || null
        refLabel = 'Rust (Cargo)'
      }
    }

    const annotatedBlock = [headingLine, block[1]]
    let inserted = false
    for (const line of body) {
      annotatedBlock.push(line)
      if (!inserted && /^License:\s*/i.test(String(line || '').trim()) && refLabel && refNumber) {
        annotatedBlock.push(`Summary ref: ${refLabel} #${refNumber}`)
        inserted = true
      }
    }
    if (!inserted && refLabel && refNumber) {
      annotatedBlock.push(`Summary ref: ${refLabel} #${refNumber}`)
    }
    annotatedBlock.push('')

    output.push(...collapseBlankRuns(annotatedBlock))
  }

  return collapseBlankRuns(output).join('\n')
}

function annotatePythonSummaryRefs(fileText, summaryRefs) {
  const lines = normalizeLineEndings(fileText).split('\n')
  const sectionStart = lines.findIndex((line) => line.includes(MARKER_PYTHON_LICENSE_TEXT))
  if (sectionStart === -1) return fileText
  const sectionEnd = lines.findIndex((line, idx) => idx > sectionStart && line.includes(MARKER_JS_LICENSE_TEXT))
  if (sectionEnd === -1) return fileText

  const headerLines = []
  let cursor = sectionStart
  while (cursor < sectionEnd) {
    const line = lines[cursor]
    headerLines.push(line)
    cursor += 1
    if (line.trim() === '' && cursor < sectionEnd) break
  }

  const bodyLines = lines.slice(cursor, sectionEnd)
  const versionPattern = /^\d[\w.+-]*$/
  const rebuilt = [...headerLines]

  let idx = 0
  while (idx < bodyLines.length) {
    while (idx < bodyLines.length && bodyLines[idx].trim() === '') idx += 1
    if (idx >= bodyLines.length) break

    const maybeName = bodyLines[idx]?.trim()
    const maybeVersion = bodyLines[idx + 1]?.trim()
    if (!maybeName || !maybeVersion || !versionPattern.test(maybeVersion)) {
      rebuilt.push(bodyLines[idx])
      idx += 1
      continue
    }

    const start = idx
    idx += 1
    while (idx < bodyLines.length) {
      const n1 = bodyLines[idx]?.trim()
      const n2 = bodyLines[idx + 1]?.trim()
      if (n1 && n2 && versionPattern.test(n2)) break
      idx += 1
    }

    const block = bodyLines.slice(start, idx)
    const cleaned = block.filter((line) => !/^Summary ref:\s*/i.test(String(line || '').trim()))
    const normalizedName = normalizePythonPackageName(maybeName)
    const exactKey = `${normalizedName}::${maybeVersion}`
    const refNumber = summaryRefs.python.get(exactKey) || summaryRefs.pythonByName.get(normalizedName) || null

    const annotated = []
    cleaned.forEach((line, lineIdx) => {
      annotated.push(line)
      if (lineIdx === 1 && refNumber) {
        annotated.push(`Summary ref: Python (pip) #${refNumber}`)
      }
    })

    rebuilt.push(...annotated)
    if (rebuilt[rebuilt.length - 1].trim() !== '') rebuilt.push('')
    rebuilt.push('')
  }

  const nextLines = [...lines.slice(0, sectionStart), ...collapseBlankRuns(rebuilt), ...lines.slice(sectionEnd)]
  return nextLines.join('\n')
}

function prunePythonLicenseTextSection(fileText, selectedPythonPackages, { warnOnMissing = true } = {}) {
  const lines = normalizeLineEndings(fileText).split('\n')
  const sectionStart = lines.findIndex((line) => line.includes(MARKER_PYTHON_LICENSE_TEXT))
  if (sectionStart === -1) return fileText

  const sectionEnd = lines.findIndex((line, idx) => idx > sectionStart && line.includes(MARKER_JS_LICENSE_TEXT))
  if (sectionEnd === -1) {
    throw new Error(`Missing end marker "${MARKER_JS_LICENSE_TEXT}" for section "${MARKER_PYTHON_LICENSE_TEXT}"`)
  }

  const selectedKeys = new Set(
    selectedPythonPackages.map((pkg) => `${normalizePythonPackageName(pkg.name)}::${String(pkg.version).trim()}`)
  )

  const headerLines = []
  let cursor = sectionStart
  while (cursor < sectionEnd) {
    const line = lines[cursor]
    headerLines.push(line)
    cursor += 1
    if (line.trim() === '' && cursor < sectionEnd) break
  }

  const bodyLines = lines.slice(cursor, sectionEnd)
  const versionPattern = /^\d[\w.+-]*$/
  const blocks = []

  let idx = 0
  while (idx < bodyLines.length) {
    while (idx < bodyLines.length && bodyLines[idx].trim() === '') idx += 1
    if (idx >= bodyLines.length) break

    const maybeName = bodyLines[idx]?.trim()
    const maybeVersion = bodyLines[idx + 1]?.trim()
    if (!maybeName || !maybeVersion || !versionPattern.test(maybeVersion)) {
      // Preserve any unmatched lines to avoid destructive loss on unexpected formatting.
      blocks.push({ key: null, name: null, version: null, lines: [bodyLines[idx]] })
      idx += 1
      continue
    }

    const start = idx
    idx += 1

    while (idx < bodyLines.length) {
      const n1 = bodyLines[idx]?.trim()
      const n2 = bodyLines[idx + 1]?.trim()
      if (n1 && n2 && versionPattern.test(n2)) break
      idx += 1
    }

    const blockLines = bodyLines.slice(start, idx)
    const normalizedName = normalizePythonPackageName(maybeName)
    const key = `${normalizedName}::${maybeVersion}`
    blocks.push({ key, name: normalizedName, version: maybeVersion, lines: blockLines })
  }

  const byExactKey = new Map()
  const byName = new Map()
  for (const block of blocks) {
    if (block.key === null) continue
    if (!byExactKey.has(block.key)) byExactKey.set(block.key, block)
    if (!byName.has(block.name)) byName.set(block.name, [])
    byName.get(block.name).push(block)
  }

  const picked = []
  const pickedKeys = new Set()
  for (const selectedKey of selectedKeys) {
    const exact = byExactKey.get(selectedKey)
    if (exact) {
      picked.push(exact)
      pickedKeys.add(exact.key)
      continue
    }

    const [selectedName] = selectedKey.split('::')
    const candidates = (byName.get(selectedName) || [])
      .filter((candidate) => !pickedKeys.has(candidate.key))
      .sort((a, b) => String(b.version).localeCompare(String(a.version), 'en', { numeric: true, sensitivity: 'base' }))

    if (candidates.length > 0) {
      picked.push(candidates[0])
      pickedKeys.add(candidates[0].key)
    }
  }

  const retainedSelectedNames = new Set(picked.map((block) => block.name))
  const missingNames = [...new Set([...selectedKeys].map((key) => key.split('::')[0]))].filter((name) => !retainedSelectedNames.has(name))
  if (warnOnMissing && missingNames.length > 0) {
    console.warn(`WARN: Missing Python license text blocks for package names: ${missingNames.slice(0, 10).join(', ')}`)
  }

  const rebuiltSection = [...headerLines]
  picked
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .forEach((block, index) => {
      const blockLines = block.lines
    if (index > 0 && rebuiltSection[rebuiltSection.length - 1].trim() !== '') rebuiltSection.push('')
    rebuiltSection.push(...blockLines)
    if (rebuiltSection[rebuiltSection.length - 1].trim() !== '') rebuiltSection.push('')
    rebuiltSection.push('')
    })

  const nextLines = [...lines.slice(0, sectionStart), ...collapseBlankRuns(rebuiltSection), ...lines.slice(sectionEnd)]
  return nextLines.join('\n')
}

function findFirstInventoryBoundary(lines) {
  const indexes = [MARKER_PYTHON_LICENSE_TEXT, MARKER_JS_LICENSE_TEXT, MARKER_RUST_LICENSE_TEXT]
    .map((marker) => lines.findIndex((line) => line.includes(marker)))
    .filter((idx) => idx >= 0)

  return indexes.length === 0 ? lines.length : Math.min(...indexes)
}

function main() {
  const checkMode = process.argv.includes('--check')

  const rawCanonical = readFileSync(CANONICAL_PATH, 'utf-8')
  const preserveCrlf = rawCanonical.includes('\r\n')

  const sanitizedBase = sanitizeSpdxNoiseLines(stripLegacyInventorySections(rawCanonical))
  const baseLines = normalizeLineEndings(sanitizedBase).split('\n')

  const firstInventoryStart = findFirstInventoryBoundary(baseLines)

  const npmArtifact = readRequiredJson(NPM_ARTIFACT_PATH, 'NPM')
  const rustArtifact = readRequiredJson(RUST_ARTIFACT_PATH, 'Rust')
  const pythonArtifact = readRequiredJson(PYTHON_ARTIFACT_PATH, 'Python')
  const otherArtifact = readRequiredJson(OTHER_ARTIFACT_PATH, 'Other')
  const pythonRuntimeVersions = collectRuntimePythonVersions()

  const npmPackages = parseNpmArtifact(npmArtifact.data)
  const rustPackages = parseRustArtifact(rustArtifact.data)
  const pythonPackages = parsePythonArtifact(pythonArtifact.data, pythonRuntimeVersions)
  const otherData = parseOtherComponentsArtifact(otherArtifact.data)
  const npmLicenseFileHints = buildNpmLicenseFileHintSet(npmArtifact.data)

  if (npmPackages.length === 0) throw new Error('Parsed zero NPM packages from artifacts')
  if (rustPackages.length === 0) throw new Error('Parsed zero Rust packages from artifacts')
  if (pythonPackages.length === 0) throw new Error('Parsed zero Python packages from artifacts')

  const allPackages = dedupePackages([...npmPackages, ...rustPackages, ...pythonPackages, ...otherData.packages])
  const byEcosystem = {
    npm: sortPackages(allPackages.filter((pkg) => pkg.ecosystem === 'npm')),
    rust: sortPackages(allPackages.filter((pkg) => pkg.ecosystem === 'rust')),
    python: sortPackages(allPackages.filter((pkg) => pkg.ecosystem === 'python')),
    other: sortPackages(allPackages.filter((pkg) => pkg.ecosystem === 'other')),
  }

  const knownNames = new Set([...byEcosystem.npm, ...byEcosystem.rust, ...byEcosystem.python].map((pkg) => normalizeName(pkg.name)))
  byEcosystem.other = byEcosystem.other.filter((pkg) => !knownNames.has(normalizeName(pkg.name)))

  const summary = buildSummaryBlock(byEcosystem)
  const summaryRefs = buildSummaryReferenceMaps(byEcosystem)
  const rustSingleVersionByName = buildSingleVersionMap(byEcosystem.rust)
  const otherLicenseTextsBlock = buildOtherLicenseTextsBlock(otherData.licenseTexts)
  let newCanonical = prunePythonLicenseTextSection(sanitizedBase, byEcosystem.python, { warnOnMissing: !checkMode })
  newCanonical = sanitizePackageSectionNoise(newCanonical, npmLicenseFileHints)
  newCanonical = annotatePythonSummaryRefs(newCanonical, summaryRefs)
  newCanonical = annotateJsRustSummaryRefs(newCanonical, summaryRefs, rustSingleVersionByName)
  newCanonical = replaceOrInsertSummaryBlock(newCanonical, summary.block, firstInventoryStart)
  newCanonical = replaceOrInsertOtherLicenseTexts(newCanonical, otherLicenseTextsBlock)
  newCanonical = sanitizeSpdxNoiseLines(newCanonical)

  if (preserveCrlf) {
    newCanonical = newCanonical.replace(/\n/g, '\r\n')
  }

  if (checkMode) {
    if (normalizeLineEndings(rawCanonical) !== normalizeLineEndings(newCanonical)) {
      console.error('FAIL: Summary/licenses bundle is out of date. Run: npm run -s license:summary')
      process.exit(1)
    }

    if (!existsSync(MIRROR_PATH)) {
      console.error(`FAIL: Mirror file missing: ${MIRROR_PATH}`)
      process.exit(1)
    }

    const rawMirror = readFileSync(MIRROR_PATH, 'utf-8')
    if (normalizeLineEndings(rawMirror) !== normalizeLineEndings(newCanonical)) {
      console.error('FAIL: Mirror file is out of sync. Run: npm run -s license:summary')
      process.exit(1)
    }

    console.log('OK: Summary index is current and mirror is in sync.')
    process.exit(0)
  }

  writeFileSync(CANONICAL_PATH, newCanonical, 'utf-8')
  mkdirSync(dirname(MIRROR_PATH), { recursive: true })
  writeFileSync(MIRROR_PATH, newCanonical, 'utf-8')

  console.log('Summary index generated from artifacts.')
  console.log(`  NPM artifact:      ${npmArtifact.path}`)
  console.log(`  Rust artifact:     ${rustArtifact.path}`)
  console.log(`  Python artifact:   ${pythonArtifact.path}`)
  console.log(`  Other artifact:    ${otherArtifact.path}`)
  console.log(`  JavaScript (NPM):  ${byEcosystem.npm.length}`)
  console.log(`  Rust (Cargo):      ${byEcosystem.rust.length}`)
  console.log(`  Python (pip):      ${byEcosystem.python.length}`)
  console.log(`  Other:             ${byEcosystem.other.length}`)
  console.log(`  Total (core):      ${summary.totalPackages}`)
  console.log(`  Total (all):       ${summary.totalPackagesAll}`)
  console.log(`  Unique licenses:   ${summary.uniqueLicenses}`)
  console.log(`  Canonical:         ${CANONICAL_PATH}`)
  console.log(`  Mirror synced:     ${MIRROR_PATH}`)
}

main()
