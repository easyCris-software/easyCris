import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import path from 'path'

const hasDeviceApprovalHelper = existsSync(
  path.resolve(__dirname, 'e2e/utils/device-approval-helper.mjs'),
)
const hasRValidationHelper = existsSync(
  path.resolve(__dirname, 'e2e/utils/r-validation.mjs'),
)
const hasValidationFixturesHelper = existsSync(
  path.resolve(__dirname, 'e2e/utils/fixtures.mjs'),
)

const privateE2eContractTests = [
  ...(hasDeviceApprovalHelper
    ? []
    : ['src/services/__tests__/deviceApprovalHelper.test.ts']),
  ...(hasRValidationHelper
    ? []
    : [
        'src/utils/__tests__/rValidation.compareToRBaseline.test.ts',
        'src/utils/__tests__/rValidation.extractStatsFromUI.test.ts',
        'src/utils/__tests__/rValidation.lmmInferentialReport.test.ts',
      ]),
  ...(hasValidationFixturesHelper && hasRValidationHelper
    ? []
    : ['src/utils/__tests__/validationPathAliases.test.ts']),
]

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // AppShell contract suites reset modules and import the full shell. Bounding
    // concurrent transforms prevents hook starvation while retaining parallelism.
    maxWorkers: 4,
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
