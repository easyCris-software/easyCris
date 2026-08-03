#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_BACKENDS,
  assertRuntimePlatform,
  backendExecutableName,
} from './python-runtime-constants.mjs'
import {
  inspectDarwinBinary,
  minimumMacOSVersions,
  validateDarwinBinaryDescription,
  validateDarwinTree,
} from './darwin-artifact-validation.mjs'
import { assertPlotExportArtifact } from './plot-export-signatures.mjs'
import {
  cleanTransientKaleidoLogs,
  runtimeManifestContext,
  runtimeTreeSha256,
  validateDarwinRuntimeManifest,
} from './stage_python_runtime.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const sourceDist = path.join(rootDir, 'python_embedded', 'dist')
const stagedRoot = path.join(rootDir, 'bundle_resources', 'python_embedded')
const stagedDist = path.join(stagedRoot, 'dist')
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const installedUpdaterDist = path.join(
  localAppData,
  'easycris',
  '_up_',
  'bundle_resources',
  'python_embedded',
  'dist'
)
const releaseConfigPath = path.join(rootDir, 'src-tauri', 'tauri.release.nsis.conf.json')
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json')
const frontendDistPath = path.join(rootDir, 'dist', 'assets')
const scriptPythonExePath = path.join(rootDir, 'python_embedded', 'python.exe')
const scriptPlotBackendPath = path.join(rootDir, 'python_embedded', 'plot.py')
const shippedFontDirPath = path.join(rootDir, 'public', 'fonts')
const requireFrontendDist = process.argv.includes('--require-frontend-dist')
const checkInstalledUpdater = process.argv.includes('--check-installed-updater')
const communityMode = process.argv.includes('--community')
const probeOutputDir = path.join(rootDir, '_tmp')

const allowedPythonFiles = new Set()
const VC_RUNTIME_REQUIRED = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']
const RNASEQ_REQUIRED_CACHE_FILES = [
  'gene_cache_meta.json',
  'gene_symbols_human_ensembl.json',
  'gene_symbols_human_entrez.json',
  'gene_symbols_human_uniprot.json',
  'gene_symbols_human_uniprot_swissprot.json',
  'gene_symbols_mouse_ensembl.json',
  'gene_symbols_mouse_entrez.json',
  'gene_symbols_mouse_uniprot.json',
  'gene_symbols_mouse_uniprot_swissprot.json',
]
const RNASEQ_REQUIRED_CACHE_METADATA_KEYS = [
  'human_ensembl_ensembl_version',
  'mouse_ensembl_ensembl_version',
  'human_entrez_source_name',
  'human_uniprot_source_name',
  'human_uniprot_swissprot_source_name',
  'mouse_entrez_source_name',
  'mouse_uniprot_source_name',
  'mouse_uniprot_swissprot_source_name',
]
const RNASEQ_DISALLOWED_MISLEADING_KEYS = [
  'human_entrez_ensembl_version',
  'human_uniprot_ensembl_version',
  'human_uniprot_swissprot_ensembl_version',
  'mouse_entrez_ensembl_version',
  'mouse_uniprot_ensembl_version',
  'mouse_uniprot_swissprot_ensembl_version',
]
const DARWIN_KALEIDO_NATIVE_LIBRARY_FILES = [
  'libEGL.dylib',
  'libGLESv2.dylib',
  'libswiftshader_libEGL.dylib',
  'libswiftshader_libGLESv2.dylib',
]
const BACKEND_PROBE_TIMEOUT_MS = 120000
const RNASEQ_REAL_COUNTS_CSV = path.join(
  rootDir,
  'RNA_seq',
  'validation',
  'newdata',
  'sample_count.csv'
)
const RNASEQ_REAL_METADATA_CSV = path.join(
  rootDir,
  'RNA_seq',
  'validation',
  'newdata',
  'sample_metadata_fixed.csv'
)

const PLOT_EXPORT_PROBE_FIGURE = {
  data: [{ type: 'scatter', mode: 'lines', x: [0, 1], y: [0, 1], name: 'probe' }],
  layout: { title: { text: 'release-probe' } },
}

function buildPlotExportProbe(format) {
  return {
    backend: 'plot',
    distFolder: 'plot.dist',
    payload: {
      action: 'export_plot',
      plotly_json: PLOT_EXPORT_PROBE_FIGURE,
      output_path: '__VALIDATION_EXPORT_DYNAMIC__',
      options: { format, width: 80, height: 80 },
    },
    requireSuccess: true,
    expectOutputFile: true,
    outputFormat: format,
  }
}

const BASE_BACKEND_PROBES = [
  {
    backend: 'stats',
    distFolder: 'stats.dist',
    payload: {
      test: 'independent_ttest',
      data: { group1: [1.2, 2.3, 3.1], group2: [4.1, 5.2, 4.8] },
      parameters: { alpha: 0.05, equal_var: true },
      arrow_data_path: null,
    },
    requireSuccess: true,
  },
  {
    backend: 'stats',
    distFolder: 'stats.dist',
    payload: {
      test: 'kruskal_wallis',
      data: {
        groups: [
          [1.1, 1.2, 1.3],
          [2.1, 2.2, 2.3],
          [3.0, 3.2, 3.4],
        ],
        group_names: ['A', 'B', 'C'],
      },
      parameters: { alpha: 0.05 },
      arrow_data_path: null,
    },
    requireSuccess: true,
  },
  {
    backend: 'rnaseq',
    distFolder: 'rnaseq.dist',
    payload: {
      test: 'rnaseq_deseq2',
      data: {
        counts_matrix: {},
        sample_metadata: {},
      },
      parameters: {
        condition_column: 'condition',
        design_factors: ['condition'],
        condition_a: 'A',
        condition_b: 'B',
      },
      arrow_data_path: null,
    },
    requireSuccess: false,
  },
  buildPlotExportProbe('pdf'),
  buildPlotExportProbe('tiff'),
]

const errors = []
const warnings = []
const kaleidoProbeFailureLocations = new Set()

function assertExists(targetPath, message) {
  if (!fs.existsSync(targetPath)) {
    errors.push(`${message}: ${targetPath}`)
  }
}

function readJson(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  } catch (error) {
    errors.push(`Failed to parse JSON: ${targetPath} (${error.message})`)
    return null
  }
}

function walkFilesRecursive(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return []
  }
  const result = []
  const stack = [targetDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        result.push(fullPath)
      }
    }
  }
  return result
}

function ensureProbeOutputDirectory() {
  fs.mkdirSync(probeOutputDir, { recursive: true })
}

function createProbeOutputPath(format, scopeLabel) {
  const safeScope = String(scopeLabel || 'probe').replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  return path.join(probeOutputDir, `release_probe_${safeScope}_${suffix}.${format}`)
}

function removeProbeOutputFileIfPresent(targetPath) {
  if (!targetPath) {
    return
  }
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true })
  }
}

export function resolveInstalledDarwinDist(appPath) {
  return path.join(
    appPath,
    'Contents',
    'Resources',
    '_up_',
    'bundle_resources',
    'python_embedded',
    'runtime'
  )
}

export function buildDarwinPlotParityMatrix(paths) {
  const buildProbe = (scope, format, executable, args = []) => ({
    scope,
    format,
    command: [executable, ...args].join(' '),
    executable,
    args,
  })
  return [
    buildProbe('script', 'pdf', paths.scriptPython, [paths.scriptPlot]),
    buildProbe('script', 'tiff', paths.scriptPython, [paths.scriptPlot]),
    buildProbe('source-compiled', 'pdf', path.join(paths.sourceDist, 'plot.dist', 'plot')),
    buildProbe('source-compiled', 'tiff', path.join(paths.sourceDist, 'plot.dist', 'plot')),
    buildProbe('staged-compiled', 'pdf', path.join(paths.stagedDist, 'plot.dist', 'plot')),
    buildProbe('staged-compiled', 'tiff', path.join(paths.stagedDist, 'plot.dist', 'plot')),
  ]
}

export function normalizeDarwinArchitecture(architecture = os.arch()) {
  if (architecture === 'x64' || architecture === 'x86_64') return 'x86_64'
  if (architecture === 'arm64') return 'arm64'
  throw new Error(`Unsupported Darwin architecture: ${architecture}`)
}

export function shouldRunWindowsScriptPlotParity({ communityMode }) {
  return !communityMode
}

function darwinBackendProbe(backend) {
  if (backend === 'stats') return BASE_BACKEND_PROBES[0]
  if (backend === 'rnaseq') {
    return {
      backend: 'rnaseq',
      payload: {
        test: 'rnaseq_validate_samples',
        data: { counts_sample_ids: ['s1'], metadata_sample_ids: ['s1'] },
        params: {},
      },
      requireSuccess: true,
    }
  }
  return {
    backend: 'plot',
    payload: { action: 'ping' },
    requireSuccess: true,
  }
}

function parseProbeResult(result, label, localErrors) {
  if (result?.error) {
    localErrors.push(`Backend probe failed to execute ${label}: ${result.error.message}`)
    return null
  }
  if (result?.status !== 0) {
    localErrors.push(`Backend probe returned non-zero exit for ${label}: exit=${result?.status}`)
    return null
  }
  const parsed = parseJsonFromBackendStdout(result?.stdout)
  if (!parsed || typeof parsed !== 'object') {
    localErrors.push(`Backend probe returned no JSON object for ${label}`)
    return null
  }
  return parsed
}

function defaultDarwinRunner({ command, args, input, cwd }) {
  return spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: BACKEND_PROBE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
}

function defaultMachOInspector(targetPath) {
  return inspectDarwinBinary(targetPath)
}

function isPathLikeExecutable(executable) {
  return path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
}

function runDarwinProbe({ executable, args = [], payload, label, outputFormat, requireSuccess = true, runner, probeOutputDir: outputDir, localErrors }) {
  if (isPathLikeExecutable(executable) && !fs.existsSync(executable)) {
    localErrors.push(`Backend probe missing executable (${label}): ${executable}`)
    return
  }

  let outputPath = null
  try {
    const probePayload = JSON.parse(JSON.stringify(payload))
    if (outputFormat) {
      fs.mkdirSync(outputDir, { recursive: true })
      outputPath = path.join(outputDir, `release_probe_${label.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}_${Math.random().toString(16).slice(2)}.${outputFormat}`)
      probePayload.output_path = outputPath
    }
    const result = runner({
      command: executable,
      args,
      input: JSON.stringify(probePayload),
      cwd: path.dirname(executable),
    })
    const parsed = parseProbeResult(result, label, localErrors)
    if (!parsed) return
    if (requireSuccess && parsed.success !== true) {
      localErrors.push(`Backend probe did not report success=true for ${label}: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error ?? parsed.success ?? null)}`)
      return
    }
    if (outputPath) {
      if (!fs.existsSync(outputPath)) {
        localErrors.push(`Backend probe did not produce expected output file for ${label}: ${outputPath}`)
      } else if (fs.statSync(outputPath).size <= 0) {
        localErrors.push(`Backend probe produced empty output file for ${label}: ${outputPath}`)
      } else {
        try {
          assertPlotExportArtifact(outputPath, outputFormat)
        } catch (error) {
          localErrors.push(`Backend probe ${error.message} (${label})`)
        }
      }
    }
  } finally {
    if (outputPath) removeProbeOutputFileIfPresent(outputPath)
  }
}

function validateDarwinMachO(targetPath, label, expectedArchitecture, inspectMachO, localErrors) {
  if (!fs.existsSync(targetPath)) return null
  let description
  try {
    description = String(inspectMachO(targetPath))
  } catch (error) {
    localErrors.push(`Failed to inspect ${label} architecture: ${targetPath} (${error.message})`)
    return null
  }
  const architectures = description.match(/\b(?:x86_64|arm64)\b/g) || []
  if (!description.includes('Mach-O') || !architectures.includes(expectedArchitecture)) {
    localErrors.push(`${label} architecture mismatch: expected ${expectedArchitecture}, got ${description || '(empty result)'} (${targetPath})`)
  }
  localErrors.push(...validateDarwinBinaryDescription({
    description,
    expectedArchitecture,
    label,
    targetPath,
  }).filter(error => !error.includes('architecture mismatch')))
  return description
}

function validateDarwinRnaSeqCaches(backendDistDir, label, localErrors) {
  const cacheDir = path.join(backendDistDir, 'rnaseq_module', 'gene_cache')
  if (!fs.existsSync(cacheDir)) {
    localErrors.push(`Missing ${label} rnaseq gene_cache directory: ${cacheDir}`)
    return
  }
  for (const cacheFile of RNASEQ_REQUIRED_CACHE_FILES) {
    const cachePath = path.join(cacheDir, cacheFile)
    if (!fs.existsSync(cachePath)) {
      localErrors.push(`Missing ${label} rnaseq cache file: ${cachePath}`)
    }
  }

  const metadataPath = path.join(cacheDir, 'gene_cache_meta.json')
  if (!fs.existsSync(metadataPath)) return
  let metadata
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  } catch (error) {
    localErrors.push(`Failed to parse ${label} rnaseq cache metadata: ${metadataPath} (${error.message})`)
    return
  }
  for (const key of RNASEQ_REQUIRED_CACHE_METADATA_KEYS) {
    if (typeof metadata?.[key] !== 'string' || metadata[key].trim().length === 0) {
      localErrors.push(`Missing ${label} rnaseq cache metadata key: ${key}`)
    }
  }
  for (const key of RNASEQ_DISALLOWED_MISLEADING_KEYS) {
    if (typeof metadata?.[key] === 'string' && metadata[key].trim().length > 0) {
      localErrors.push(`Misleading ${label} rnaseq metadata key present: ${key}`)
    }
  }
}

function validateDarwinRuntimePayloadForLocation(
  backend,
  backendDistDir,
  label,
  { expectedArchitecture, inspectMachO, localErrors }
) {
  const numpyRoot = path.join(backendDistDir, 'numpy')
  const numpyNativeModules = walkFilesRecursive(numpyRoot).filter(filePath => filePath.endsWith('.so'))
  const multiarrayModule = numpyNativeModules.find(filePath => path.basename(filePath) === '_multiarray_umath.so')
  if (!multiarrayModule) {
    localErrors.push(`Missing ${label} NumPy native module: expected _multiarray_umath.so under ${numpyRoot}`)
  }
  for (const nativeModule of numpyNativeModules) {
    validateDarwinMachO(nativeModule, `${label} NumPy native module`, expectedArchitecture, inspectMachO, localErrors)
  }

  if (backend === 'rnaseq') {
    validateDarwinRnaSeqCaches(backendDistDir, label, localErrors)
  }

  if (backend === 'plot') {
    const kaleidoRoot = path.join(backendDistDir, 'kaleido', 'executable')
    const wrapper = path.join(kaleidoRoot, 'kaleido')
    const nativeExecutable = path.join(kaleidoRoot, 'bin', 'kaleido')
    if (!fs.existsSync(wrapper)) {
      localErrors.push(`Missing ${label} Kaleido executable wrapper: ${wrapper}`)
    }
    if (!fs.existsSync(nativeExecutable)) {
      localErrors.push(`Missing ${label} Kaleido native executable: ${nativeExecutable}`)
    } else {
      validateDarwinMachO(nativeExecutable, `${label} Kaleido native executable`, expectedArchitecture, inspectMachO, localErrors)
    }
    for (const fileName of DARWIN_KALEIDO_NATIVE_LIBRARY_FILES) {
      const nativePayload = path.join(kaleidoRoot, 'bin', fileName)
      if (!fs.existsSync(nativePayload)) {
        localErrors.push(`Missing ${label} Kaleido native payload: ${nativePayload}`)
      } else {
        validateDarwinMachO(nativePayload, `${label} Kaleido native payload`, expectedArchitecture, inspectMachO, localErrors)
      }
    }
  }
}

function validateDarwinBackendTree(distRoot, label, localErrors, { expectedArchitecture, inspectMachO }) {
  for (const backend of REQUIRED_BACKENDS) {
    const backendDistDir = path.join(distRoot, `${backend}.dist`)
    const executable = path.join(distRoot, `${backend}.dist`, backendExecutableName(backend, 'darwin'))
    if (!fs.existsSync(backendDistDir)) {
      localErrors.push(`Missing ${label} ${backend}.dist: ${backendDistDir}`)
      continue
    }
    if (!fs.existsSync(executable)) {
      localErrors.push(`Missing ${label} ${backend}.dist executable: ${executable}`)
    } else {
      validateDarwinMachO(executable, `${label} ${backend}.dist executable`, expectedArchitecture, inspectMachO, localErrors)
    }
    validateDarwinRuntimePayloadForLocation(backend, backendDistDir, `${label} ${backend}.dist`, {
      expectedArchitecture,
      inspectMachO,
      localErrors,
    })
    localErrors.push(...validateDarwinTree(backendDistDir, expectedArchitecture, {
      inspect: inspectMachO,
      label: `${label} ${backend}.dist payload`,
    }))
  }
}

function walkPathsRecursive(targetDir) {
  if (!fs.existsSync(targetDir)) return []
  const result = [targetDir]
  const stack = [targetDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      result.push(entryPath)
      if (entry.isDirectory()) stack.push(entryPath)
    }
  }
  return result
}

function isConfinedTask5ActivatePs1(runtimeRoot, candidate) {
  if (!runtimeRoot) return false
  try {
    if (!fs.lstatSync(candidate).isFile()) return false
    const runtime = fs.realpathSync(runtimeRoot)
    return fs.realpathSync(candidate) === path.join(runtime, 'lib', 'python3.12', 'venv', 'scripts', 'common', 'Activate.ps1')
  } catch {
    return false
  }
}

export function validateMacBundleResources(resourceRoot, { runtimeRoot } = {}) {
  const forbiddenMacSuffixes = ['.exe', '.dll', '.pyd', '.ps1']
  const forbiddenMacNames = ['pywin32', 'win32com', 'msedgedriver']
  const forbiddenLegacyRuntimeNames = new Set(['dist', 'builder', 'build', 'wheelhouse', 'archive', 'archives', 'pip-cache', 'pip_cache', '_tmp'])
  const localErrors = []
  if (!fs.existsSync(resourceRoot)) return localErrors
  const paths = walkPathsRecursive(resourceRoot)
  for (const candidate of paths) {
    const parts = path.relative(resourceRoot, candidate).split(path.sep).filter(Boolean)
    const name = path.basename(candidate).toLowerCase()
    if (
      (forbiddenMacSuffixes.some(suffix => name.endsWith(suffix)) && !isConfinedTask5ActivatePs1(runtimeRoot, candidate)) ||
      parts.some(part => {
        const normalized = part.toLowerCase()
        return forbiddenMacNames.includes(normalized) || normalized.startsWith('pywin32')
      })
    ) {
      localErrors.push(`Windows-only payload found in macOS resources: ${candidate}`)
    }
    if (path.basename(path.dirname(candidate)).toLowerCase() === 'python_embedded') {
      const normalized = name.toLowerCase()
      if (normalized.endsWith('.dist') || forbiddenLegacyRuntimeNames.has(normalized)) {
        localErrors.push(`Legacy Python runtime or build payload found in macOS resources: ${candidate}`)
      }
    }
  }
  return localErrors
}

function validateLegacyDarwinRuntime({
  paths,
  requireScriptCompiledPlotParity: requireParity = false,
  installedApp,
  runner = defaultDarwinRunner,
  inspectMachO = defaultMachOInspector,
  expectedArchitecture = os.arch(),
  probeOutputDir: outputDir = probeOutputDir,
} = {}) {
  const localErrors = []
  const normalizedArchitecture = normalizeDarwinArchitecture(expectedArchitecture)
  const sourceDistPath = paths?.sourceDist
  const stagedDistPath = paths?.stagedDist
  const generatedKaleidoRoots = [
    sourceDistPath && path.join(sourceDistPath, 'plot.dist', 'kaleido', 'executable'),
    stagedDistPath && path.join(stagedDistPath, 'plot.dist', 'kaleido', 'executable'),
  ].filter(Boolean)
  const trees = [
    { dist: sourceDistPath, label: 'source' },
    { dist: stagedDistPath, label: 'staged' },
  ]
  let installedDist = null
  if (installedApp) {
    installedDist = resolveInstalledDarwinDist(installedApp)
    generatedKaleidoRoots.push(path.join(installedDist, 'plot.dist', 'kaleido', 'executable'))
    trees.push({ dist: installedDist, label: 'installed' })
  }

  try {
    for (const tree of trees) {
      if (!tree.dist) {
        localErrors.push(`Missing ${tree.label} Python dist directory`)
        continue
      }
      validateDarwinBackendTree(tree.dist, tree.label, localErrors, {
        expectedArchitecture: normalizedArchitecture,
        inspectMachO,
      })
      for (const backend of REQUIRED_BACKENDS) {
        const executable = path.join(tree.dist, `${backend}.dist`, backendExecutableName(backend, 'darwin'))
        const probe = darwinBackendProbe(backend)
        runDarwinProbe({
          executable,
          payload: probe.payload,
          requireSuccess: probe.requireSuccess,
          label: `${tree.label}_${backend}`,
          runner,
          probeOutputDir: outputDir,
          localErrors,
        })
      }
    }

    for (const parityProbe of buildDarwinPlotParityMatrix({
      scriptPython: paths.scriptPython,
      scriptPlot: paths.scriptPlot,
      sourceDist: sourceDistPath,
      stagedDist: stagedDistPath,
    })) {
      if (parityProbe.scope === 'script' && !requireParity) continue
      runDarwinProbe({
        executable: parityProbe.executable,
        args: parityProbe.args,
        payload: buildPlotExportProbe(parityProbe.format).payload,
        label: `${parityProbe.scope}_${parityProbe.format}`,
        outputFormat: parityProbe.format,
        runner,
        probeOutputDir: outputDir,
        localErrors,
      })
    }

    if (installedDist) {
      for (const format of ['pdf', 'tiff']) {
        runDarwinProbe({
          executable: path.join(installedDist, 'plot.dist', 'plot'),
          payload: buildPlotExportProbe(format).payload,
          label: `installed_${format}`,
          outputFormat: format,
          runner,
          probeOutputDir: outputDir,
          localErrors,
        })
      }
      localErrors.push(...validateMacBundleResources(path.join(installedApp, 'Contents', 'Resources')))
    }
    if (stagedDistPath) {
      localErrors.push(...validateMacBundleResources(path.dirname(path.dirname(stagedDistPath))))
    }
  } finally {
    cleanTransientKaleidoLogs(generatedKaleidoRoots)
    for (const root of generatedKaleidoRoots) {
      const logs = walkFilesRecursive(root).filter(filePath => path.basename(filePath).toLowerCase().endsWith('.log'))
      for (const log of logs) localErrors.push(`Transient Kaleido log remained after validation: ${log}`)
    }
  }

  return { errors: localErrors }
}

function bundledBackendPayload(backend, format, outputPath) {
  if (backend === 'stats') {
    return { test: 'independent_ttest', data: { group1: [1, 2, 3, 4], group2: [5, 6, 7, 8] }, parameters: { equal_var: true } }
  }
  if (backend === 'rnaseq') {
    return { test: 'rnaseq_validate', data: { counts: { GeneA: { S1: 20, S2: 25 } }, metadata: { S1: { condition: 'A' }, S2: { condition: 'B' } } }, parameters: {} }
  }
  if (format) {
    return {
      action: 'export_plot',
      plotly_json: PLOT_EXPORT_PROBE_FIGURE,
      output_path: outputPath,
      options: { format, width: 80, height: 80, dpi: 96 },
    }
  }
  return { action: 'trendline', x: [1, 2, 3, 4], y: [2, 4, 6, 8], type: 'linear' }
}

function isMachOFile(targetPath) {
  try {
    const header = fs.readFileSync(targetPath).subarray(0, 4).toString('hex')
    return new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']).has(header)
  } catch {
    return false
  }
}

function walkValidatedRuntimeFiles(runtime) {
  const result = []
  const stack = [runtime]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const targetPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(targetPath)
      } else if (entry.isFile()) {
        result.push(targetPath)
      } else if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(targetPath).isFile()) result.push(targetPath)
        } catch {}
      }
    }
  }
  return result
}

function validateBundledMachO(runtime, manifest, expectedArchitecture, inspectMachO, localErrors) {
  const expected = new Map((manifest?.macho_inventory?.files || []).map(entry => [entry.path, entry]))
  const found = walkValidatedRuntimeFiles(runtime).filter(isMachOFile)
  for (const targetPath of found) {
    const relative = path.relative(runtime, targetPath).split(path.sep).join('/')
    const record = expected.get(relative)
    if (!record) {
      localErrors.push(`Mach-O missing from runtime manifest inventory: ${relative}`)
      continue
    }
    if (record.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex')) {
      localErrors.push(`Mach-O hash differs from runtime manifest: ${relative}`)
    }
    const description = validateDarwinMachO(targetPath, `runtime Mach-O ${relative}`, expectedArchitecture, inspectMachO, localErrors)
    if (!description || !record) continue
    const architectures = [...new Set(description.match(/\b(?:x86_64|arm64)\b/g) || [])].sort()
    if (JSON.stringify(architectures) !== JSON.stringify([expectedArchitecture])) {
      localErrors.push(`runtime Mach-O ${relative} is not an exact native slice: ${architectures.join(', ') || 'none'}`)
    }
    const versions = minimumMacOSVersions(description)
    if (JSON.stringify(record.architectures) !== JSON.stringify([expectedArchitecture]) || JSON.stringify(record.minimum_macos_versions) !== JSON.stringify(versions)) {
      localErrors.push(`Runtime manifest Mach-O metadata is stale: ${relative}`)
    }
  }
  for (const relative of expected.keys()) {
    if (!found.some(targetPath => path.relative(runtime, targetPath).split(path.sep).join('/') === relative)) {
      localErrors.push(`Runtime manifest Mach-O is missing: ${relative}`)
    }
  }
}

function validateRuntimeSysPath(runtime, interpreter, runner, localErrors) {
  const result = runner({
    command: interpreter,
    args: ['-I', '-B', '-c', 'import json,sys; print(json.dumps(sys.path))'],
    input: '',
    cwd: runtime,
  })
  if (result?.status !== 0) {
    localErrors.push(`Bundled interpreter sys.path probe failed: ${runtime}`)
    return
  }
  let entries
  try { entries = JSON.parse(String(result.stdout).trim()) } catch { entries = null }
  if (!Array.isArray(entries)) {
    localErrors.push(`Bundled interpreter returned invalid sys.path data: ${runtime}`)
    return
  }
  const resolved = fs.realpathSync(runtime)
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      localErrors.push(`Bundled interpreter returned invalid sys.path entry: ${String(entry)}`)
      continue
    }
    const candidate = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(runtime, entry)
    const canonical = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate
    const relative = path.relative(resolved, canonical)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      localErrors.push(`Bundled interpreter sys.path escapes runtime: ${entry}`)
    }
  }
}

function validateBundledInterpreterVersion(runtime, interpreter, version, runner, localErrors) {
  const result = runner({ command: interpreter, args: ['--version'], input: '', cwd: runtime })
  if (result?.status !== 0 || result?.error) {
    localErrors.push(`Bundled interpreter version probe failed: ${runtime}`)
    return
  }
  const expected = `Python ${version}`
  if (String(result.stdout).trim() !== expected) {
    localErrors.push(`Bundled interpreter version differs from pinned CPython: expected ${expected}, got ${String(result.stdout).trim() || '(empty)'}`)
  }
}

function runtimeManifestSha256(runtime) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, 'easycris_runtime_manifest.json'))).digest('hex')
}

function runBundledBackendProbe({ runtime, backend, runner, outputDir, localErrors }) {
  const interpreter = path.join(runtime, 'bin', 'python3.12')
  const run = (format) => {
    const outputPath = format
      ? path.join(outputDir, `${path.basename(runtime)}-${backend}-${format}-${Date.now()}-${Math.random().toString(16).slice(2)}.${format}`)
      : null
    if (outputPath) fs.mkdirSync(outputDir, { recursive: true })
    const result = runner({
      command: interpreter,
      args: ['-I', '-B', '-m', backend],
      input: JSON.stringify(bundledBackendPayload(backend, format, outputPath)),
      cwd: runtime,
    })
    const parsed = parseProbeResult(result, `${path.basename(runtime)}:${backend}${format ? `:${format}` : ''}`, localErrors)
    if (parsed?.success !== true) localErrors.push(`Bundled ${backend} protocol did not report success=true: ${runtime}`)
    if (outputPath) {
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        localErrors.push(`Bundled plot did not create ${format.toUpperCase()} output: ${runtime}`)
      } else {
        try { assertPlotExportArtifact(outputPath, format) } catch (error) { localErrors.push(error.message) }
      }
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true })
    }
  }
  run()
  if (backend === 'plot') {
    run('pdf')
    run('tiff')
  }
}

export function validateDarwinRuntime({
  paths,
  installedApp,
  runner = defaultDarwinRunner,
  inspectMachO = defaultMachOInspector,
  expectedArchitecture = os.arch(),
  probeOutputDir: outputDir = probeOutputDir,
  manifestContext,
} = {}) {
  const localErrors = []
  const normalizedArchitecture = normalizeDarwinArchitecture(expectedArchitecture)
  const trees = [
    { runtime: paths?.sourceRuntime, label: 'source' },
    { runtime: paths?.stagedRuntime, label: 'staged' },
  ]
  if (installedApp) trees.push({ runtime: resolveInstalledDarwinDist(installedApp), label: 'installed' })
  for (const tree of trees) {
    if (!tree.runtime) {
      localErrors.push(`Missing ${tree.label} bundled runtime directory`)
      continue
    }
    const context = manifestContext
      ? { ...manifestContext, architecture: normalizedArchitecture }
      : runtimeManifestContext(paths?.root ?? rootDir, { architecture: normalizedArchitecture })
    const manifestErrors = validateDarwinRuntimeManifest(tree.runtime, { root: paths?.root, manifestContext: context })
    localErrors.push(...manifestErrors.map(error => `${tree.label} ${error}`))
    if (manifestErrors.length > 0) continue
    const manifest = JSON.parse(fs.readFileSync(path.join(tree.runtime, 'easycris_runtime_manifest.json'), 'utf8'))
    const before = runtimeTreeSha256(tree.runtime)
    const manifestBefore = runtimeManifestSha256(tree.runtime)
    const interpreter = path.join(tree.runtime, 'bin', 'python3.12')
    validateBundledMachO(tree.runtime, manifest, normalizedArchitecture, inspectMachO, localErrors)
    validateBundledInterpreterVersion(tree.runtime, interpreter, manifest.interpreter.version, runner, localErrors)
    validateRuntimeSysPath(tree.runtime, interpreter, runner, localErrors)
    for (const backend of REQUIRED_BACKENDS) {
      runBundledBackendProbe({ runtime: tree.runtime, backend, runner, outputDir, localErrors })
    }
    if (runtimeTreeSha256(tree.runtime) !== before) localErrors.push(`Bundled runtime mutated during validation: ${tree.runtime}`)
    if (runtimeManifestSha256(tree.runtime) !== manifestBefore) localErrors.push(`Bundled runtime manifest mutated during validation: ${tree.runtime}`)
  }
  if (paths?.stagedRuntime) {
    localErrors.push(...validateMacBundleResources(path.dirname(path.dirname(paths.stagedRuntime)), { runtimeRoot: paths.stagedRuntime }))
  }
  if (installedApp) {
    const installedRuntime = resolveInstalledDarwinDist(installedApp)
    localErrors.push(...validateMacBundleResources(path.join(installedApp, 'Contents', 'Resources'), { runtimeRoot: installedRuntime }))
  }
  return { errors: localErrors }
}

export function validateInstalledDarwinExecution({
  installedApp,
  runner = defaultDarwinRunner,
  probeOutputDir: outputDir = probeOutputDir,
} = {}) {
  if (!installedApp) {
    throw new Error('post-sign installed execution requires an installed app')
  }
  const localErrors = []
  const runtime = resolveInstalledDarwinDist(installedApp)
  for (const backend of REQUIRED_BACKENDS) {
    runBundledBackendProbe({ runtime, backend, runner, outputDir, localErrors })
  }
  return { errors: localErrors }
}

function validateCompiledBackends() {
  assertExists(sourceDist, 'Missing Nuitka source dist directory')
  assertExists(stagedDist, 'Missing staged Python dist directory')

  for (const backend of REQUIRED_BACKENDS) {
    const sourceBackendDist = path.join(sourceDist, `${backend}.dist`)
    const stagedBackendDist = path.join(stagedDist, `${backend}.dist`)
    const sourceTopLevelExe = path.join(sourceDist, `${backend}.exe`)
    const sourceDistExe = path.join(sourceBackendDist, `${backend}.exe`)
    const stagedTopLevelExe = path.join(stagedDist, `${backend}.exe`)

    assertExists(sourceBackendDist, `Missing source ${backend}.dist`)
    assertExists(sourceDistExe, `Missing source ${backend}.dist executable`)

    if (!fs.existsSync(sourceTopLevelExe)) {
      warnings.push(
        `Source compatibility copy missing (non-authoritative): ${sourceTopLevelExe}`
      )
    }

    assertExists(stagedBackendDist, `Missing staged ${backend}.dist`)
    assertExists(
      path.join(stagedBackendDist, `${backend}.exe`),
      `Missing staged ${backend}.dist executable`
    )
    if (!fs.existsSync(stagedTopLevelExe)) {
      warnings.push(
        `Staged compatibility copy missing (non-authoritative): ${stagedTopLevelExe}`
      )
    }

    validateVCRuntimeDllsForBackend(backend, sourceBackendDist, stagedBackendDist)
    validateBackendRuntimePayloadForLocation(backend, sourceBackendDist, `source ${backend}.dist`)
    validateBackendRuntimePayloadForLocation(backend, stagedBackendDist, `staged ${backend}.dist`)
  }
}

function validateInstalledUpdaterBackends() {
  if (!checkInstalledUpdater) {
    warnings.push('Skipping installed updater runtime checks (pass --check-installed-updater to enable)')
    return
  }

  assertExists(installedUpdaterDist, 'Missing installed updater Python dist directory')
  if (!fs.existsSync(installedUpdaterDist)) {
    return
  }

  for (const backend of REQUIRED_BACKENDS) {
    const installedBackendDist = path.join(installedUpdaterDist, `${backend}.dist`)
    const installedTopLevelExe = path.join(installedUpdaterDist, `${backend}.exe`)
    assertExists(installedBackendDist, `Missing installed updater ${backend}.dist`)
    assertExists(
      path.join(installedBackendDist, `${backend}.exe`),
      `Missing installed updater ${backend}.dist executable`
    )
    if (!fs.existsSync(installedTopLevelExe)) {
      warnings.push(
        `Installed updater compatibility copy missing (non-authoritative): ${installedTopLevelExe}`
      )
    }

    validateVCRuntimeDllsForSingleLocation(backend, installedBackendDist, `installed updater ${backend}.dist`)
    validateBackendRuntimePayloadForLocation(backend, installedBackendDist, `installed updater ${backend}.dist`)
  }
}

function summarizeOutput(text) {
  const normalized = String(text || '').trim()
  if (!normalized) {
    return 'empty'
  }
  const lines = normalized.split(/\r?\n/)
  const preview = lines.slice(0, 3).join(' | ')
  return `${normalized.length} chars (${lines.length} lines) :: ${preview}`
}

function extractJsonObject(candidate) {
  const text = String(candidate || '')
  const start = text.indexOf('{')
  if (start === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

function parseJsonFromBackendStdout(stdoutText) {
  const text = String(stdoutText || '')
  const candidates = [text]
  const newlineBrace = /\r?\n\{/g
  let match
  while ((match = newlineBrace.exec(text)) !== null) {
    const idx = match.index + match[0].length - 1
    candidates.push(text.slice(idx))
  }

  for (const candidate of candidates) {
    const jsonSlice = extractJsonObject(candidate)
    if (!jsonSlice) {
      continue
    }
    try {
      return JSON.parse(jsonSlice)
    } catch {
      // continue trying fallback candidates
    }
  }

  return null
}

function isKaleidoExecutableMissingError(errorMessage) {
  const normalized = String(errorMessage || '').toLowerCase()
  return (
    normalized.includes('the kaleido executable is required') ||
    normalized.includes('kaleido executable is required')
  )
}

function parseSimpleCsv(csvText) {
  const lines = String(csvText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)

  if (lines.length < 2) {
    throw new Error('CSV must include header and at least one data row')
  }

  return lines.map(line => line.split(',').map(cell => cell.trim()))
}

function buildRnaSeqRealDataPayload() {
  if (!fs.existsSync(RNASEQ_REAL_COUNTS_CSV)) {
    throw new Error(`Missing RNA-seq counts CSV for release probe: ${RNASEQ_REAL_COUNTS_CSV}`)
  }
  if (!fs.existsSync(RNASEQ_REAL_METADATA_CSV)) {
    throw new Error(`Missing RNA-seq metadata CSV for release probe: ${RNASEQ_REAL_METADATA_CSV}`)
  }

  const countsRows = parseSimpleCsv(fs.readFileSync(RNASEQ_REAL_COUNTS_CSV, 'utf8'))
  const metadataRows = parseSimpleCsv(fs.readFileSync(RNASEQ_REAL_METADATA_CSV, 'utf8'))

  const sampleIds = countsRows[0].slice(1)
  if (sampleIds.length === 0) {
    throw new Error(`Counts CSV has no sample columns: ${RNASEQ_REAL_COUNTS_CSV}`)
  }

  const counts = {}
  for (const row of countsRows.slice(1, 21)) {
    const geneId = String(row[0] || '').trim()
    if (!geneId) continue
    const geneCounts = {}
    for (let i = 0; i < sampleIds.length; i += 1) {
      const sampleId = sampleIds[i]
      const raw = row[i + 1]
      const value = Number.parseFloat(raw ?? '0')
      geneCounts[sampleId] = Number.isFinite(value) ? Math.round(value) : 0
    }
    counts[geneId] = geneCounts
  }

  if (Object.keys(counts).length === 0) {
    throw new Error(`Counts CSV produced empty payload: ${RNASEQ_REAL_COUNTS_CSV}`)
  }

  const metadataHeaders = metadataRows[0]
  const metadata = {}
  for (const row of metadataRows.slice(1)) {
    const sampleId = String(row[0] || '').trim()
    if (!sampleId) continue
    const factors = {}
    for (let i = 1; i < metadataHeaders.length; i += 1) {
      const key = String(metadataHeaders[i] || '').trim()
      if (!key) continue
      factors[key] = String(row[i] ?? '').trim()
    }
    metadata[sampleId] = factors
  }

  if (Object.keys(metadata).length === 0) {
    throw new Error(`Metadata CSV produced empty payload: ${RNASEQ_REAL_METADATA_CSV}`)
  }

  return {
    test: 'rnaseq_deseq2',
    data: {
      counts,
      metadata,
    },
    parameters: {
      design_formula: '~condition',
      contrast: ['condition', 'Hypoxia', 'Normoxia'],
      options: {
        annotate_genes: true,
        compute_pca: false,
        compute_vst: false,
        confirm_warnings: true,
        quiet: true,
        organism: 'hsapiens',
        gene_id_type: 'ensembl',
        annotation_allow_online: false,
      },
    },
    arrow_data_path: null,
  }
}

function buildBackendProbes() {
  const probes = [...BASE_BACKEND_PROBES]
  probes.push({
    backend: 'rnaseq',
    distFolder: 'rnaseq.dist',
    payload: buildRnaSeqRealDataPayload(),
    requireSuccess: true,
    assertion: 'rnaseq_annotation_local_cache',
  })
  probes.push({
    backend: 'rnaseq',
    distFolder: 'rnaseq.dist',
    payload: {
      test: 'rnaseq_heatmap',
      data: {
        genes: [],
        normalized_counts: [],
        sample_ids: [],
      },
      parameters: {
        options: {
          n_top_genes: 5,
          cluster_rows: false,
          cluster_cols: false,
          use_padj: true,
          space_colorbar: 0,
        },
      },
      arrow_data_path: null,
    },
    requireSuccess: true,
  })
  return probes
}

function runCompiledBackendProbe(baseDistPath, locationLabel, probeConfig) {
  const exePath = path.join(baseDistPath, probeConfig.distFolder, `${probeConfig.backend}.exe`)
  if (!fs.existsSync(exePath)) {
    errors.push(`Backend probe missing executable (${locationLabel}): ${exePath}`)
    return
  }

  const payload = JSON.parse(JSON.stringify(probeConfig.payload))
  let probeOutputPath = null
  if (probeConfig.expectOutputFile && probeConfig.outputFormat) {
    probeOutputPath = createProbeOutputPath(probeConfig.outputFormat, `${probeConfig.backend}_${locationLabel}`)
    payload.output_path = probeOutputPath
    removeProbeOutputFileIfPresent(probeOutputPath)
  }

  const result = spawnSync(exePath, [], {
    cwd: path.dirname(exePath),
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: BACKEND_PROBE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.error) {
    errors.push(`Backend probe failed to execute ${probeConfig.backend} (${locationLabel}): ${result.error.message}`)
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  if (result.status !== 0) {
    errors.push(
      `Backend probe returned non-zero exit for ${probeConfig.backend} (${locationLabel}): exit=${result.status}, stdout=${summarizeOutput(result.stdout)}, stderr=${summarizeOutput(result.stderr)}`
    )
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  const parsed = parseJsonFromBackendStdout(result.stdout)
  if (!parsed || typeof parsed !== 'object') {
    errors.push(
      `Backend probe returned no JSON object for ${probeConfig.backend} (${locationLabel}): stdout=${summarizeOutput(result.stdout)}, stderr=${summarizeOutput(result.stderr)}`
    )
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  if (probeConfig.requireSuccess && parsed.success === false) {
    const errorMessage = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error ?? null)
    if (
      probeConfig.backend === 'plot' &&
      isKaleidoExecutableMissingError(errorMessage)
    ) {
      if (!kaleidoProbeFailureLocations.has(locationLabel)) {
        kaleidoProbeFailureLocations.add(locationLabel)
        errors.push(
          `Backend plot export probes failed for ${locationLabel}: Kaleido executable payload is missing/unresolved in compiled runtime`
        )
      }
      removeProbeOutputFileIfPresent(probeOutputPath)
      return
    }
    errors.push(
      `Backend probe returned unsuccessful payload for ${probeConfig.backend} (${locationLabel}): ${errorMessage}`
    )
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  if (probeConfig.expectOutputFile && probeOutputPath) {
    if (!fs.existsSync(probeOutputPath)) {
      errors.push(
        `Backend probe did not produce expected output file for ${probeConfig.backend} (${locationLabel}): ${probeOutputPath}`
      )
      return
    }
    const stats = fs.statSync(probeOutputPath)
    if (stats.size <= 0) {
      errors.push(
        `Backend probe produced empty output file for ${probeConfig.backend} (${locationLabel}): ${probeOutputPath}`
      )
      removeProbeOutputFileIfPresent(probeOutputPath)
      return
    }
    removeProbeOutputFileIfPresent(probeOutputPath)
  }

  if (probeConfig.assertion === 'rnaseq_annotation_local_cache') {
    const genes = Array.isArray(parsed.genes) ? parsed.genes : []
    const mappedCount = genes.filter(g => {
      if (!g || typeof g !== 'object') return false
      const geneId = String(g.gene_id ?? '')
      const geneSymbol = String(g.gene_symbol ?? '')
      return geneId.length > 0 && geneSymbol.length > 0 && geneId !== geneSymbol
    }).length
    if (mappedCount <= 0) {
      errors.push(
        `RNA-seq annotation probe returned zero mapped symbols for ${probeConfig.backend} (${baseDistPath})`
      )
    }

    const annotationSource = String(parsed.annotation_source ?? parsed.annotationSource ?? '').toLowerCase()
    if (!annotationSource || annotationSource.includes('mygene') || annotationSource.includes('online')) {
      errors.push(
        `RNA-seq annotation probe returned non-local annotation source for ${probeConfig.backend}: ${annotationSource || 'missing'}`
      )
    }

    const stderrLower = String(result.stderr || '').toLowerCase()
    if (stderrLower.includes('mygene') || stderrLower.includes('biothings')) {
      errors.push(
        `RNA-seq annotation probe stderr indicates online fallback path for ${probeConfig.backend}: ${summarizeOutput(result.stderr)}`
      )
    }
  }
}

function validateCompiledBackendProbes() {
  const probes = buildBackendProbes()
  for (const probeConfig of probes) {
    runCompiledBackendProbe(sourceDist, 'source_dist', probeConfig)
    runCompiledBackendProbe(stagedDist, 'staged_dist', probeConfig)
    if (checkInstalledUpdater && fs.existsSync(installedUpdaterDist)) {
      runCompiledBackendProbe(installedUpdaterDist, 'installed_updater_dist', probeConfig)
    }
  }
}

function runScriptPlotBackendProbe(probeConfig) {
  if (!fs.existsSync(scriptPythonExePath)) {
    errors.push(`Script-mode probe missing embedded Python executable: ${scriptPythonExePath}`)
    return
  }
  if (!fs.existsSync(scriptPlotBackendPath)) {
    errors.push(`Script-mode probe missing plot backend entrypoint: ${scriptPlotBackendPath}`)
    return
  }

  const payload = JSON.parse(JSON.stringify(probeConfig.payload))
  let probeOutputPath = null
  if (probeConfig.expectOutputFile && probeConfig.outputFormat) {
    probeOutputPath = createProbeOutputPath(probeConfig.outputFormat, 'plot_script_mode')
    payload.output_path = probeOutputPath
    removeProbeOutputFileIfPresent(probeOutputPath)
  }

  const result = spawnSync(scriptPythonExePath, [scriptPlotBackendPath], {
    cwd: path.dirname(scriptPlotBackendPath),
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: BACKEND_PROBE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.error) {
    errors.push(`Script-mode plot probe failed to execute: ${result.error.message}`)
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  if (result.status !== 0) {
    errors.push(
      `Script-mode plot probe returned non-zero exit: exit=${result.status}, stdout=${summarizeOutput(result.stdout)}, stderr=${summarizeOutput(result.stderr)}`
    )
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  const parsed = parseJsonFromBackendStdout(result.stdout)
  if (!parsed || typeof parsed !== 'object') {
    errors.push(
      `Script-mode plot probe returned no JSON object: stdout=${summarizeOutput(result.stdout)}, stderr=${summarizeOutput(result.stderr)}`
    )
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  if (parsed.success === false) {
    const errorMessage = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error ?? null)
    errors.push(`Script-mode plot probe returned unsuccessful payload: ${errorMessage}`)
    removeProbeOutputFileIfPresent(probeOutputPath)
    return
  }

  if (probeConfig.expectOutputFile && probeOutputPath) {
    if (!fs.existsSync(probeOutputPath)) {
      errors.push(`Script-mode plot probe did not produce expected output file: ${probeOutputPath}`)
      return
    }
    const stats = fs.statSync(probeOutputPath)
    if (stats.size <= 0) {
      errors.push(`Script-mode plot probe produced empty output file: ${probeOutputPath}`)
      removeProbeOutputFileIfPresent(probeOutputPath)
      return
    }
    removeProbeOutputFileIfPresent(probeOutputPath)
  }
}

function validateScriptAndCompiledPlotParityProbes() {
  runScriptPlotBackendProbe(buildPlotExportProbe('pdf'))
  runScriptPlotBackendProbe(buildPlotExportProbe('tiff'))
}

function validateVCRuntimeDllsForSingleLocation(backend, backendDistDir, label) {
  for (const dll of VC_RUNTIME_REQUIRED) {
    assertExists(path.join(backendDistDir, dll), `Missing ${label} VC runtime DLL`)
  }
}

function validateVCRuntimeDllsForBackend(backend, sourceBackendDist, stagedBackendDist) {
  validateVCRuntimeDllsForSingleLocation(backend, sourceBackendDist, `source ${backend}.dist`)
  validateVCRuntimeDllsForSingleLocation(backend, stagedBackendDist, `staged ${backend}.dist`)
}

function validateBackendRuntimePayloadForLocation(backend, backendDistDir, label) {
  // Catch partially copied/corrupted Nuitka dist folders that still contain only the EXE + VC DLLs.
  const numpyRuntimeCandidates = [
    path.join('numpy', 'core', '_multiarray_umath.pyd'),
    path.join('numpy', '_core', '_multiarray_umath.pyd'),
  ]
  assertAnyExists(backendDistDir, numpyRuntimeCandidates, `Missing ${label} runtime dependency`)

  if (backend === 'rnaseq') {
    validateRnaSeqBundledCaches(backendDistDir, label)
  }

  if (backend === 'plot') {
    const kaleidoRuntimeFiles = [
      path.join('kaleido', 'executable', 'kaleido.cmd'),
      path.join('kaleido', 'executable', 'bin', 'kaleido.exe'),
    ]
    for (const relativeFile of kaleidoRuntimeFiles) {
      assertExists(path.join(backendDistDir, relativeFile), `Missing ${label} Kaleido runtime payload`)
    }

    const kaleidoExecutableDir = path.join(backendDistDir, 'kaleido', 'executable')
    if (fs.existsSync(kaleidoExecutableDir)) {
      const unexpectedLogFiles = walkFilesRecursive(kaleidoExecutableDir).filter(filePath =>
        filePath.toLowerCase().endsWith('.log')
      )
      for (const logFile of unexpectedLogFiles) {
        errors.push(`Unexpected ${label} Kaleido runtime log artifact: ${logFile}`)
      }
    }
  }
}

function validateRnaSeqBundledCaches(backendDistDir, label) {
  const cacheDir = path.join(backendDistDir, 'rnaseq_module', 'gene_cache')
  assertExists(cacheDir, `Missing ${label} rnaseq gene_cache directory`)
  for (const cacheFile of RNASEQ_REQUIRED_CACHE_FILES) {
    assertExists(path.join(cacheDir, cacheFile), `Missing ${label} rnaseq cache file`)
  }
  const metaPath = path.join(cacheDir, 'gene_cache_meta.json')
  if (fs.existsSync(metaPath)) {
    const meta = readJson(metaPath)
    if (meta && typeof meta === 'object') {
      for (const key of RNASEQ_REQUIRED_CACHE_METADATA_KEYS) {
        const value = meta[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          errors.push(`Missing ${label} rnaseq cache metadata key: ${key}`)
        }
      }
      for (const key of RNASEQ_DISALLOWED_MISLEADING_KEYS) {
        if (typeof meta[key] === 'string' && meta[key].trim().length > 0) {
          errors.push(`Misleading ${label} rnaseq metadata key present: ${key}`)
        }
      }
    }
  }
}

function assertAnyExists(baseDir, candidates, messagePrefix) {
  const found = candidates.some(candidate => fs.existsSync(path.join(baseDir, candidate)))
  if (!found) {
    errors.push(`${messagePrefix}: expected one of [${candidates.join(', ')}] under ${baseDir}`)
  }
}

export function validateNoUnexpectedPyFiles({ resourceRoot = stagedRoot, platform = process.platform, localErrors = errors } = {}) {
  const stagedFiles = walkFilesRecursive(resourceRoot)
  const disallowed = stagedFiles.filter(filePath => {
    if (!filePath.toLowerCase().endsWith('.py')) {
      return false
    }
    const relativePath = path.relative(resourceRoot, filePath).replace(/\\/g, '/')
    // Only the Windows Nuitka layout legitimately includes Python files inside *.dist folders.
    if (platform !== 'darwin' && /(^|\/)[^/]+\.dist\//.test(relativePath)) {
      return false
    }
    // The Darwin runtime intentionally contains CPython's stdlib and backend modules.
    if (platform === 'darwin' && relativePath.startsWith('runtime/')) {
      return false
    }
    return !allowedPythonFiles.has(relativePath)
  })

  if (disallowed.length > 0) {
    for (const filePath of disallowed) {
      localErrors.push(`Disallowed Python source found in staged runtime: ${filePath}`)
    }
  }
}

function validateNoNuitkaInStagedRuntime() {
  const stagedFiles = walkFilesRecursive(stagedRoot)
  const nuitkaPathPatterns = [
    /(^|\/)nuitka(\/|$)/i,
    /(^|\/)nuitka_plugins(\/|$)/i,
    /(^|\/)Nuitka-[^/]+\.dist-info(\/|$)/i,
  ]

  const matches = stagedFiles.filter(filePath => {
    const relativePath = path.relative(stagedRoot, filePath).replace(/\\/g, '/')
    return nuitkaPathPatterns.some(pattern => pattern.test(relativePath))
  })

  if (matches.length > 0) {
    for (const filePath of matches) {
      errors.push(`Disallowed Nuitka build tool artifact found in staged runtime: ${filePath}`)
    }
  }
}

function validateNoSourceMaps() {
  if (!fs.existsSync(frontendDistPath)) {
    if (requireFrontendDist) {
      errors.push(`Frontend dist assets missing for release validation: ${frontendDistPath}`)
    } else {
      warnings.push(`Frontend dist assets not found (skipping sourcemap check): ${frontendDistPath}`)
    }
    return
  }

  const files = walkFilesRecursive(frontendDistPath)
  const sourceMaps = files.filter(filePath => filePath.toLowerCase().endsWith('.map'))
  if (sourceMaps.length > 0) {
    for (const sourceMap of sourceMaps) {
      errors.push(`Source map found in release assets: ${sourceMap}`)
    }
  }
}

function validateNoE2EArtifactsInReleaseDist() {
  if (!fs.existsSync(frontendDistPath)) {
    return
  }

  const files = walkFilesRecursive(frontendDistPath)
  const e2eArtifacts = files.filter(filePath => {
    const base = path.basename(filePath).toLowerCase()
    return base.startsWith('e2e-shim-') || base === 'e2e-shim.js'
  })

  if (e2eArtifacts.length > 0) {
    const preview = e2eArtifacts.slice(0, 5).join(', ')
    errors.push(
      `E2E frontend artifacts detected in release dist/assets. Rebuild release frontend into dist (not dist-e2e). Found: ${preview}`
    )
  }
}

function validateNoUnresolvedStoreAliasInBundle() {
  if (!fs.existsSync(frontendDistPath)) {
    return
  }

  const files = walkFilesRecursive(frontendDistPath).filter(filePath =>
    filePath.toLowerCase().endsWith('.js')
  )
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8')
    if (source.includes('@/store/')) {
      errors.push(`Unresolved '@/store/*' alias found in bundle: ${filePath}`)
    }
  }
}

function validateStrictCspAgainstRuntimeCodegen() {
  if (!fs.existsSync(tauriConfigPath) || !fs.existsSync(frontendDistPath)) {
    return
  }

  const baseConfig = readJson(tauriConfigPath)
  if (!baseConfig) {
    return
  }

  const releaseOverride = fs.existsSync(releaseConfigPath) ? readJson(releaseConfigPath) : null
  const csp =
    releaseOverride?.app?.security?.csp ??
    baseConfig?.app?.security?.csp ??
    ''
  const isStrictScriptCsp =
    csp.includes("script-src 'self'") && !csp.includes("'unsafe-eval'")
  if (!isStrictScriptCsp) {
    return
  }

  const files = walkFilesRecursive(frontendDistPath).filter(filePath =>
    filePath.toLowerCase().endsWith('.js')
  )

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8')
    if (source.includes('new Function(') || source.includes('eval(')) {
      errors.push(
        `Strict CSP blocks runtime code generation but bundle contains eval/new Function: ${filePath}`
      )
      break
    }
  }
}

function validateNsisArtifactSignatures() {
  const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
  if (!fs.existsSync(nsisDir)) {
    // Not built yet â€” skip silently (only meaningful after a build).
    warnings.push('NSIS bundle dir not found â€” skipping artifact signature check (run after build).')
    return
  }
  const files = fs.readdirSync(nsisDir)
  const zips = files.filter(f => f.endsWith('.nsis.zip'))
  if (zips.length === 0) {
    warnings.push('No .nsis.zip artifacts found in bundle/nsis â€” skipping signature check.')
    return
  }
  for (const zip of zips) {
    const sigFile = `${zip}.sig`
    if (!files.includes(sigFile)) {
      errors.push(`NSIS artifact missing .sig file: ${zip} (required for updater integrity)`)
    } else {
      const sigPath = path.join(nsisDir, sigFile)
      const sigContent = fs.readFileSync(sigPath, 'utf8').trim()
      if (!sigContent || sigContent.length < 20) {
        errors.push(`NSIS signature file appears empty or truncated: ${sigFile}`)
      }
    }
  }
}

function validateNsisReleaseConfig() {
  assertExists(releaseConfigPath, 'Missing release override config')
  if (!fs.existsSync(releaseConfigPath)) {
    return
  }

  const config = readJson(releaseConfigPath)
  if (!config) {
    return
  }

  const target = config?.bundle?.targets
  if (target !== 'nsis') {
    errors.push(
      `Release override must set bundle.targets to "nsis" (current: ${JSON.stringify(target)})`
    )
  }
}

const REQUIRED_LEGAL_FILES = ['EULA.txt', 'PRIVACY_POLICY.txt', 'THIRD_PARTY_LICENSES.txt']
const REQUIRED_LEGAL_BUNDLE_PATHS = REQUIRED_LEGAL_FILES.map(f => `resources/legal/${f}`)

function validateLegalFiles() {
  const legalDir = path.join(rootDir, 'src-tauri', 'resources', 'legal')

  // 1. All required legal files must exist on disk and be non-empty.
  for (const filename of REQUIRED_LEGAL_FILES) {
    const filePath = path.join(legalDir, filename)
    if (!fs.existsSync(filePath)) {
      errors.push(`Required legal file missing from src-tauri/resources/legal/: ${filename}`)
      continue
    }
    const size = fs.statSync(filePath).size
    if (size === 0) {
      errors.push(`Required legal file is empty: ${filename}`)
    }
  }

  // 2. All required legal files must be listed in tauri.conf.json bundle.resources.
  const tauriConfig = readJson(tauriConfigPath)
  if (!tauriConfig) return
  const bundledResources = tauriConfig?.bundle?.resources ?? []
  const resourceList = Array.isArray(bundledResources)
    ? bundledResources
    : Object.keys(bundledResources)
  for (const requiredPath of REQUIRED_LEGAL_BUNDLE_PATHS) {
    if (!resourceList.includes(requiredPath)) {
      errors.push(
        `Legal file not listed in tauri.conf.json bundle.resources (differential updates will skip it): ${requiredPath}`
      )
    }
  }

  // 3. Stale OSS_TERMS.txt must not exist (would indicate incomplete migration).
  const staleFile = path.join(legalDir, 'OSS_TERMS.txt')
  if (fs.existsSync(staleFile)) {
    errors.push(
      'Stale legal/OSS_TERMS.txt still exists. Delete it â€” app now uses EULA.txt.'
    )
  }
}

export function readTargetPlatform(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--platform')
  if (index < 0) return assertRuntimePlatform(process.platform)
  const platform = argv[index + 1]
  if (!platform || platform.startsWith('--')) {
    throw new Error('Missing value for --platform')
  }
  return assertRuntimePlatform(platform)
}

function readInstalledApp(argv) {
  const index = argv.indexOf('--installed-app')
  if (index < 0) return null
  const appPath = argv[index + 1]
  if (!appPath || appPath.startsWith('--')) {
    throw new Error('Use --installed-app <path>')
  }
  return path.resolve(appPath)
}

function validateWindowsRuntime() {
  validateCompiledBackends()
  validateInstalledUpdaterBackends()
  validateCompiledBackendProbes()
  if (shouldRunWindowsScriptPlotParity({ communityMode })) {
    validateScriptAndCompiledPlotParityProbes()
  }
}

function validatePortableRelease(targetPlatform) {
  validateNoUnexpectedPyFiles({ platform: targetPlatform })
  validateNoNuitkaInStagedRuntime()
  validateNoE2EArtifactsInReleaseDist()
  validateNoSourceMaps()
  validateNoUnresolvedStoreAliasInBundle()
  validateStrictCspAgainstRuntimeCodegen()
}

function main(argv = process.argv.slice(2)) {
  const targetPlatform = readTargetPlatform(argv)
  ensureProbeOutputDirectory()
  const postSignInstalledExecution = argv.includes('--post-sign-installed-execution')
  if (postSignInstalledExecution) {
    if (targetPlatform !== 'darwin') {
      throw new Error('--post-sign-installed-execution requires --platform darwin')
    }
    const installedApp = readInstalledApp(argv)
    if (!installedApp) {
      throw new Error('--post-sign-installed-execution requires --installed-app <path>')
    }
    errors.push(...validateInstalledDarwinExecution({ installedApp }).errors)
  } else {
    validateLegalFiles()
    if (targetPlatform === 'win32') {
      validateWindowsRuntime()
    } else {
      const darwinResult = validateDarwinRuntime({
        paths: {
          root: rootDir,
          sourceRuntime: path.join(rootDir, 'python_embedded', 'runtime'),
          stagedRuntime: path.join(stagedRoot, 'runtime'),
        },
        installedApp: readInstalledApp(argv),
        manifestContext: runtimeManifestContext(rootDir),
      })
      errors.push(...darwinResult.errors)
    }
    validatePortableRelease(targetPlatform)
    if (targetPlatform === 'win32') {
      validateNsisReleaseConfig()
      validateNsisArtifactSignatures()
    }
  }

  for (const warning of warnings) {
    console.warn(`[validate-release] WARN: ${warning}`)
  }

  if (errors.length > 0) {
    console.error('[validate-release] FAILED')
    for (const error of errors) {
      console.error(`  - ${error}`)
    }
    process.exit(1)
  }

  console.log('[validate-release] OK: Hardened release prerequisites validated')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[validate-release] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}
