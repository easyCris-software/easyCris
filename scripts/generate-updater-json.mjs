#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const TAURI_CONFIG_PATH = path.join(ROOT, 'src-tauri', 'tauri.conf.json')
const DEFAULT_BUNDLE_DIR = path.join(
  ROOT,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis'
)
const DEFAULT_OUTPUT = path.join(ROOT, 'latest.json')
const ARCH_TO_TARGET_ARCH = {
  x64: 'x86_64',
  'x86_64': 'x86_64',
  arm64: 'aarch64',
  aarch64: 'aarch64',
  x86: 'i686',
  i686: 'i686',
  armv7: 'armv7',
}

function fail(message) {
  console.error(`[updater-json] ERROR: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {
    bundleDir: DEFAULT_BUNDLE_DIR,
    output: DEFAULT_OUTPUT,
    prefer: undefined,
    arch: undefined,
    target: undefined,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      opts.dryRun = true
      continue
    }
    if (!arg.startsWith('--')) {
      continue
    }

    const [key, inlineValue] = arg.includes('=')
      ? arg.split(/=(.*)/s, 2)
      : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]

    if (inlineValue === undefined) {
      i += 1
    }

    switch (key) {
      case '--version':
        opts.version = value
        break
      case '--tag':
        opts.tag = value
        break
      case '--repo':
        opts.repo = value
        break
      case '--bundle-dir':
        opts.bundleDir = value
        break
      case '--output':
        opts.output = value
        break
      case '--notes':
        opts.notes = value
        break
      case '--pub-date':
        opts.pubDate = value
        break
      case '--prefer':
        opts.prefer = value
        break
      case '--arch':
        opts.arch = value
        break
      case '--target':
        opts.target = value
        break
      default:
        fail(`Unknown argument: ${key}`)
    }
  }
  return opts
}

function loadTauriConfig() {
  if (!fs.existsSync(TAURI_CONFIG_PATH)) {
    fail(`Missing Tauri config: ${TAURI_CONFIG_PATH}`)
  }
  const tauriConfig = JSON.parse(fs.readFileSync(TAURI_CONFIG_PATH, 'utf8'))
  if (!tauriConfig.version) {
    fail(`Missing version in ${TAURI_CONFIG_PATH}`)
  }
  return {
    version: String(tauriConfig.version).trim(),
    createUpdaterArtifacts: tauriConfig.bundle?.createUpdaterArtifacts,
  }
}

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase()
  if (normalized !== 'nsis' && normalized !== 'exe') {
    fail(`Invalid --prefer value '${mode}'. Use 'nsis' or 'exe'.`)
  }
  return normalized
}

function getDefaultMode(createUpdaterArtifacts) {
  // Tauri v2 docs:
  // - "v1Compatible" => NSIS zip updater bundle on Windows.
  // - true => installer artifact signatures (exe/msi) on Windows.
  if (createUpdaterArtifacts === 'v1Compatible') {
    return 'nsis'
  }
  return 'exe'
}

function parseRepoFromRemoteUrl(url) {
  const trimmed = String(url || '').trim()
  if (!trimmed) {
    return null
  }
  const match = trimmed.match(/github\.com[:/](.+?)(?:\.git)?$/i)
  return match?.[1] || null
}

function guessRepoFromGit() {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const parsed = parseRepoFromRemoteUrl(remote)
    if (parsed) {
      return parsed
    }
  } catch {
    // Fallback below.
  }
  try {
    const gitDir = fs.readFileSync(path.join(ROOT, '.git'), 'utf8')
    const gitPath = gitDir.trim().replace(/^gitdir:\s*/i, '')
    const configPath = path.resolve(ROOT, gitPath, 'config')
    const config = fs.readFileSync(configPath, 'utf8')
    const match = config.match(/\[remote "origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m)
    const parsed = parseRepoFromRemoteUrl(match?.[1])
    if (parsed) {
      return parsed
    }
  } catch {
    // Fall through.
  }
  fail('Could not infer GitHub repo from git remote. Pass --repo owner/name.')
}

function listBundleFiles(bundleDir) {
  if (!fs.existsSync(bundleDir)) {
    fail(`Bundle directory not found: ${bundleDir}`)
  }
  return fs.readdirSync(bundleDir)
}

function extractArchFromArtifactName(name, version, mode) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern =
    mode === 'nsis'
      ? new RegExp(`_${escapedVersion}_(.+)-setup\\.nsis\\.zip$`)
      : new RegExp(`_${escapedVersion}_(.+)-setup\\.exe$`)
  const match = name.match(pattern)
  if (!match) {
    return null
  }
  return String(match[1]).toLowerCase()
}

function resolveTargetKey(archToken, explicitTarget) {
  if (explicitTarget) {
    return explicitTarget
  }
  const mapped = ARCH_TO_TARGET_ARCH[archToken]
  if (!mapped) {
    fail(
      `Unsupported artifact arch token '${archToken}'. Pass --target explicitly (for example windows-aarch64).`
    )
  }
  return `windows-${mapped}`
}

function resolveWindowsArtifact(bundleDir, version, mode, requestedArch) {
  const files = listBundleFiles(bundleDir)
  const candidates = []
  for (const file of files) {
    if (mode === 'nsis' && !file.endsWith('.nsis.zip')) {
      continue
    }
    if (mode === 'exe' && (!file.endsWith('-setup.exe') || file.endsWith('.exe.sig'))) {
      continue
    }
    const arch = extractArchFromArtifactName(file, version, mode)
    if (!arch) {
      continue
    }
    const sig = `${file}.sig`
    if (!files.includes(sig)) {
      continue
    }
    candidates.push({ artifact: file, sig, archToken: arch, mode })
  }

  const filtered = requestedArch
    ? candidates.filter(c => c.archToken === String(requestedArch).toLowerCase())
    : candidates

  if (filtered.length === 1) {
    return filtered[0]
  }
  if (filtered.length > 1) {
    const arches = [...new Set(filtered.map(c => c.archToken))].join(', ')
    fail(
      `Multiple ${mode.toUpperCase()} artifact pairs found for ${version} (${arches}). Pass --arch to disambiguate.`
    )
  }

  if (requestedArch) {
    fail(
      `Missing ${mode.toUpperCase()} updater pair for version ${version} arch ${requestedArch} in ${bundleDir}`
    )
  }

  const anyModeFiles = files.filter(file => {
    return mode === 'nsis'
      ? file.includes(`_${version}_`) && file.endsWith('-setup.nsis.zip')
      : file.includes(`_${version}_`) && file.endsWith('-setup.exe')
  })
  if (anyModeFiles.length > 0) {
    const noSig = anyModeFiles.filter(file => !files.includes(`${file}.sig`))
    if (noSig.length > 0) {
      fail(
        `Missing signature file(s) for ${mode.toUpperCase()} artifact(s): ${noSig
          .map(f => `${f}.sig`)
          .join(', ')}`
      )
    }
  }

  fail(
    `Missing ${mode.toUpperCase()} updater pair for ${version}. Required files include artifact and matching .sig in ${bundleDir}`
  )
}

function readSignature(bundleDir, sigFileName) {
  const sigPath = path.join(bundleDir, sigFileName)
  const signature = fs.readFileSync(sigPath, 'utf8').trim()
  if (!signature) {
    fail(`Empty signature file: ${sigPath}`)
  }
  return signature
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const tauriConfig = loadTauriConfig()
  const version = (opts.version || tauriConfig.version).replace(/^v/, '')
  const tag = opts.tag || `v${version}`
  const repo = opts.repo || guessRepoFromGit()
  const bundleDir = path.resolve(ROOT, opts.bundleDir)
  const outputPath = path.resolve(ROOT, opts.output)
  const pubDate = opts.pubDate || new Date().toISOString()
  const notes = opts.notes ?? ''
  const mode = opts.prefer
    ? normalizeMode(opts.prefer)
    : getDefaultMode(tauriConfig.createUpdaterArtifacts)

  const artifact = resolveWindowsArtifact(bundleDir, version, mode, opts.arch)
  const signature = readSignature(bundleDir, artifact.sig)
  const url = `https://github.com/${repo}/releases/download/${tag}/${artifact.artifact}`
  const targetKey = resolveTargetKey(artifact.archToken, opts.target)

  const payload = {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [targetKey]: {
        signature,
        url,
      },
    },
  }

  const json = `${JSON.stringify(payload, null, 2)}\n`
  if (opts.dryRun) {
    console.log(json)
    console.log(
      `[updater-json] Dry run OK. Mode=${artifact.mode} Arch=${artifact.archToken} Target=${targetKey} Artifact=${artifact.artifact}`
    )
    return
  }

  fs.writeFileSync(outputPath, json, 'utf8')
  console.log(`[updater-json] Wrote ${outputPath}`)
  console.log(
    `[updater-json] Target ${targetKey} uses ${artifact.mode.toUpperCase()} artifact: ${artifact.artifact}`
  )
}

main()
