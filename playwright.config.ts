import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for Tauri E2E tests
 *
 * Tauri app must be built and running before tests execute.
 * Use: npm run tauri:dev (in one terminal) then npm run test:e2e (in another)
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Tauri apps can't run multiple instances
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for Tauri
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'tauri-e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Note: Start tauri:dev manually before running tests (Windows doesn't support 'source' command)
  // Terminal 1: npm run tauri dev (or tauri:dev)
  // Terminal 2: npm run test:e2e
})
