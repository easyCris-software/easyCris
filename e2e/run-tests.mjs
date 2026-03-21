/**
 * Test Runner for Selenium E2E Tests
 * Discovers and runs all .test.mjs files
 */

import { spawn } from 'child_process'
import { readdir } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const R_VALIDATION_SEGMENT = `${path.sep}features${path.sep}r-validation${path.sep}`
const STARTUP_CLEAN_STATE_SMOKE = path.join(__dirname, 'smoke', 'startup-clean-state.test.mjs')

/**
 * Recursively find all .test.mjs files
 */
async function findTestFiles(dir) {
  const files = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('node_modules')) {
      files.push(...await findTestFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(fullPath)
    }
  }

  return files
}

/**
 * Run a single test file
 */
function runTest(testFile) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Running: ${path.relative(__dirname, testFile)}`)
    console.log('='.repeat(60))

    const child = spawn(process.execPath, [testFile], {
      stdio: 'inherit',
      env: {
        ...process.env
      }
    })

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[PASSED] ${path.basename(testFile)}`)
        resolve(true)
      } else {
        console.error(`[FAILED] ${path.basename(testFile)} (exit code: ${code})`)
        resolve(false)
      }
    })

    child.on('error', (error) => {
      console.error(`[ERROR] ${path.basename(testFile)}`, error)
      resolve(false)
    })
  })
}

/**
 * Main test runner
 */
async function main() {
  console.log('[Test Runner] Discovering test files...\n')

  const args = process.argv.slice(2)
  const modeArg = args.find(arg => arg.startsWith('--mode='))
  const appPathArg = args.find(arg => arg.startsWith('--app-path='))
  const mode = modeArg ? modeArg.split('=')[1] : 'release'
  const targetArg = args.find(arg => !arg.startsWith('--'))

  if (!['release', 'e2e'].includes(mode)) {
    console.error(`[Test Runner] Invalid mode "${mode}". Use --mode=release or --mode=e2e.`)
    process.exit(1)
  }

  if (mode === 'e2e') {
    process.env.E2E_EXPECT_SHIM = '1'
    if (appPathArg) {
      process.env.E2E_APP_PATH = appPathArg.split('=')[1]
    }
    console.log('[Test Runner] Mode: e2e (window.__E2E__ expected)\n')
  } else {
    delete process.env.E2E_EXPECT_SHIM
    console.log('[Test Runner] Mode: release (window.__E2E__ must be absent)\n')
  }

  // Support running specific directory (e.g., "node run-tests.mjs features/r-validation")
  const targetDir = targetArg ? path.join(__dirname, targetArg) : __dirname

  const testFiles = await findTestFiles(targetDir)

  console.log(`[Test Runner] Found ${testFiles.length} test file(s):\n`)
  testFiles.forEach(f => console.log(`  - ${path.relative(__dirname, f)}`))

  if (testFiles.length === 0) {
    console.log('[Test Runner] No test files found.')
    process.exit(0)
  }

  console.log('\n[Test Runner] Running tests...\n')

  const results = []

  // Enforce clean-state preflight before any R-validation suite.
  if (testFiles.some((file) => file.includes(R_VALIDATION_SEGMENT))) {
    console.log('[Test Runner] Running R-validation clean-state preflight...')
    const smokePassed = await runTest(STARTUP_CLEAN_STATE_SMOKE)
    if (!smokePassed) {
      console.error('[Test Runner] Aborting: clean-state preflight failed')
      process.exit(1)
    }
  }

  for (const testFile of testFiles) {
    const passed = await runTest(testFile)
    results.push({ file: testFile, passed })
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('Test Summary')
  console.log('='.repeat(60))

  const passedCount = results.filter(r => r.passed).length
  const failedCount = results.filter(r => !r.passed).length

  console.log(`Total: ${results.length}`)
  console.log(`Passed: ${passedCount}`)
  console.log(`Failed: ${failedCount}`)

  if (failedCount > 0) {
    console.log('\nFailed tests:')
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${path.relative(__dirname, r.file)}`)
    })
  }

  process.exit(failedCount > 0 ? 1 : 0)
}

main().catch(error => {
  console.error('[Test Runner] Error:', error)
  process.exit(1)
})
