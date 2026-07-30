import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'path'

const privateE2eUtilsPath = path.resolve(__dirname, 'e2e/utils')
const hasPrivateE2eDependencyClosure = (...helperFiles: string[]) =>
  helperFiles.every((helperFile) =>
    existsSync(path.resolve(privateE2eUtilsPath, helperFile)),
  )

const hasDeviceApprovalDependencies = hasPrivateE2eDependencyClosure(
  'device-approval-helper.mjs',
)
const hasRValidationDependencies = hasPrivateE2eDependencyClosure(
  'r-validation.mjs',
  'categorical-stat-map.mjs',
  'group5-stat-map.mjs',
)
const hasValidationPathAliasDependencies = hasPrivateE2eDependencyClosure(
  'r-validation.mjs',
  'categorical-stat-map.mjs',
  'group5-stat-map.mjs',
  'fixtures.mjs',
  'manifest.mjs',
)

const privateE2eContractTests = [
  ...(hasDeviceApprovalDependencies
    ? []
    : ['src/services/__tests__/deviceApprovalHelper.test.ts']),
  ...(hasRValidationDependencies
    ? []
    : [
        'src/utils/__tests__/rValidation.compareToRBaseline.test.ts',
        'src/utils/__tests__/rValidation.extractStatsFromUI.test.ts',
        'src/utils/__tests__/rValidation.lmmInferentialReport.test.ts',
      ]),
  ...(hasValidationPathAliasDependencies
    ? []
    : ['src/utils/__tests__/validationPathAliases.test.ts']),
]

const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1))

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // AppShell contract suites reset modules and import the full shell. Bounding
    // concurrent transforms prevents hook starvation while retaining parallelism;
    // reserve one CPU when possible and never exceed the verified four-worker cap.
    maxWorkers,
    exclude: [
      'node_modules',
      'dist',
      'src-tauri',
      '.git',
      '.cache',
      'build',
      // Private checkouts provide these ignored helpers and keep this coverage.
      // Public checkouts remain self-contained without publishing private E2E code.
      ...privateE2eContractTests,
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'src/lib/modules/**/*.ts',
        'src/components/layout/AppShell.tsx',
        'src/utils/ecpTableBuilders/**/*.ts'
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__tests__/**',
        '**/types.ts',
        '**/index.ts'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
