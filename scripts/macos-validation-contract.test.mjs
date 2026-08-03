import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(
  new URL('../.github/workflows/macos-validation.yml', import.meta.url),
  'utf8'
)
const ciWorkflow = await readFile(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8'
)
const validationConfig = JSON.parse(await readFile(
  new URL('../src-tauri/tauri.validation.macos.conf.json', import.meta.url),
  'utf8'
))

function workflowStep(name) {
  const marker = `      - name: ${name}`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? undefined : next)
}

test('protected validation targets native Intel and Apple Silicon only', () => {
  assert.match(workflow, /runner:\s*macos-15-intel/)
  assert.match(workflow, /rust_target:\s*x86_64-apple-darwin/)
  assert.match(workflow, /runner:\s*macos-15/)
  assert.match(workflow, /rust_target:\s*aarch64-apple-darwin/)
  assert.doesNotMatch(workflow, /runner:\s*macos-14/)
  assert.doesNotMatch(workflow, /windows-latest/)
})

test('protected validation provisions, stages, builds, signs, and validates', () => {
  assert.match(workflow, /provision-python:macos/)
  assert.match(workflow, /stage_python_runtime\.mjs/)
  assert.match(workflow, /validate_release\.js/)
  assert.match(workflow, /--bundles app/)
  assert.match(workflow, /tauri\.validation\.macos\.conf\.json/)
  assert.match(workflow, /codesign/)
  assert.match(workflow, /--installed-app/)
  assert.match(workflow, /bundled_runtime/)
  assert.match(workflow, /gseapy-dependency-smoke\.mjs/)
  assert.doesNotMatch(workflow, /@tauri-apps\/cli@2/)
})

test('protected validation checks unsigned manifests before signing and executes installed probes after signature verification', () => {
  const buildStart = workflow.indexOf('- name: Build unsigned macOS app bundle')
  const fullValidationStart = workflow.indexOf('- name: Validate unsigned installed runtime and manifests')
  const signStart = workflow.indexOf('- name: Sign nested runtime inside-out')
  const postSignStart = workflow.indexOf('- name: Run signed installed execution probes')

  assert.notEqual(buildStart, -1)
  assert.notEqual(fullValidationStart, -1)
  assert.notEqual(signStart, -1)
  assert.notEqual(postSignStart, -1)
  assert.ok(buildStart < fullValidationStart)
  assert.ok(fullValidationStart < signStart)
  assert.ok(signStart < postSignStart)

  const fullValidationStep = workflow.slice(fullValidationStart, signStart)
  assert.match(fullValidationStep, /validate_release\.js[\s\S]*--installed-app "\$APP_PATH"/)
  assert.doesNotMatch(fullValidationStep, /--post-sign-installed-execution/)

  const signStep = workflow.slice(signStart, postSignStart)
  const nestedCommand = signStep.indexOf('cmd = [')
  const nestedHardenedSign = signStep.indexOf('"--options", "runtime", "--sign", "-",', nestedCommand)
  const nestedExecution = signStep.indexOf('subprocess.run(cmd, check=True)', nestedHardenedSign)
  const appCommand = signStep.indexOf('app_cmd = [', nestedExecution)
  const appHardenedSign = signStep.indexOf('"--options", "runtime", "--sign", "-",', appCommand)
  const appExecution = signStep.indexOf('subprocess.run(app_cmd, check=True)', appHardenedSign)
  const strictVerification = signStep.indexOf(
    'codesign --verify --deep --strict --verbose=2 "$APP_PATH"',
    appExecution
  )
  for (const [label, position] of [
    ['nested signing command', nestedCommand],
    ['nested hardened-runtime identity', nestedHardenedSign],
    ['nested signing execution', nestedExecution],
    ['outer-app signing command', appCommand],
    ['outer-app hardened-runtime identity', appHardenedSign],
    ['outer-app signing execution', appExecution],
    ['strict outer-app verification', strictVerification],
  ]) {
    assert.notEqual(position, -1, `missing ${label}`)
  }
  assert.ok(nestedCommand < nestedHardenedSign)
  assert.ok(nestedHardenedSign < nestedExecution)
  assert.ok(nestedExecution < appCommand)
  assert.ok(appCommand < appHardenedSign)
  assert.ok(appHardenedSign < appExecution)
  assert.ok(appExecution < strictVerification)

  const postSignStep = workflow.slice(postSignStart)
  assert.match(postSignStep, /validate_release\.js[\s\S]*--post-sign-installed-execution[\s\S]*--installed-app "\$APP_PATH"/)
})

test('Tauri build explicitly disables signing before full installed manifest validation', () => {
  const buildStep = workflowStep('Build unsigned macOS app bundle')
  assert.match(buildStep, /npm exec -- tauri build[\s\S]*--no-sign/)
  assert.doesNotMatch(buildStep, /codesign/)
})

test('validation overlay clears the inherited macOS signing identity', () => {
  assert.equal(validationConfig.bundle?.macOS?.signingIdentity, null)
})

test('GSEApy smokes use distinct staged and installed interpreters, never the source interpreter for staged proof', () => {
  const sourcePython = 'python_embedded/runtime/bin/python3.12'
  const stagedPython = 'bundle_resources/python_embedded/runtime/bin/python3.12'
  assert.notEqual(stagedPython, sourcePython)

  const stagedStep = workflowStep('Public GSEApy dependency smoke (staged runtime)')
  assert.match(stagedStep, /--python bundle_resources\/python_embedded\/runtime\/bin\/python3\.12(?:\s|$)/)
  assert.doesNotMatch(stagedStep, /--python python_embedded\/runtime\/bin\/python3\.12(?:\s|$)/)

  const installedStep = workflowStep('Run signed installed execution probes')
  assert.match(installedStep, /--python "\$INSTALLED_PYTHON"/)
  assert.doesNotMatch(installedStep, /--python (?:python_embedded|bundle_resources)\//)
})

test('sign step exports APP_PATH for same-step consumers and later steps', () => {
  const signStart = workflow.indexOf('Sign nested runtime inside-out')
  assert.notEqual(signStart, -1)
  const postSignStart = workflow.indexOf('Run signed installed execution probes')
  assert.notEqual(postSignStart, -1)
  assert.ok(postSignStart > signStart)
  const signStep = workflow.slice(signStart, postSignStart)

  // GITHUB_ENV alone is not visible in the same step; same-step signing needs export.
  assert.match(signStep, /export APP_PATH="\$APP"/)
  assert.match(signStep, /echo "APP_PATH=\$APP" >> "\$GITHUB_ENV"/)
  // Prefer argv over delayed GITHUB_ENV for the quoted python heredoc.
  assert.match(signStep, /python3 - "\$APP_PATH"/)
  assert.match(signStep, /Path\(sys\.argv\[1\]\)/)
  assert.doesNotMatch(signStep, /os\.environ\["APP_PATH"\]/)
  assert.match(signStep, /codesign --verify --deep --strict --verbose=2 "\$APP_PATH"/)
})

test('protected validation never mutates public releases or private E2E', () => {
  for (const forbidden of [
    'softprops/action-gh-release',
    'latest.json',
    'TAURI_SIGNING_PRIVATE_KEY',
    'APPLE_CERTIFICATE',
    'notarytool submit',
    'npm run -s e2e',
    'e2e/run-tests',
    'e2e/macos',
  ]) {
    assert.equal(workflow.includes(forbidden), false, forbidden)
  }
  // Leak gate may list private path prefixes; it must not execute private suites.
  assert.match(workflow, /git ls-files \| grep -E '\^\(e2e\//)
  assert.match(workflow, /validation\/macos\/\*\*/)
  assert.match(workflow, /validation\/ci\/\*\*/)
})

test('routine CI stays free of protected provisioning steps', () => {
  const macosStart = ciWorkflow.indexOf('  macos-quality-gates:')
  assert.notEqual(macosStart, -1)
  const nextJob = /^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/gm
  nextJob.lastIndex = macosStart + 1
  const boundary = nextJob.exec(ciWorkflow)?.index
  const macosJob = ciWorkflow.slice(macosStart, boundary)
  assert.equal(macosJob.includes('provision-python:macos'), false)
  assert.equal(macosJob.includes('codesign'), false)
  assert.equal(macosJob.includes('--installed-app'), false)
})
