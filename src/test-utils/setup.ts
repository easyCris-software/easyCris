/**
 * Vitest Test Setup
 *
 * Global configuration for all tests:
 * - Cleanup after each test
 * - Mock Tauri APIs
 * - Mock Zustand stores
 * - Deterministic UUIDs and RNG
 * - Property-based test configuration
 */

import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import fc from 'fast-check'

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Configure fast-check with deterministic seed for reproducible property tests
fc.configureGlobal({ seed: 42, numRuns: 100 })

// Mock Tauri APIs globally
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock window.crypto for UUID generation (deterministic in tests)
let uuidCounter = 0
Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: () => `test-uuid-${uuidCounter++}`,
  },
})

// Provide matchMedia mock for components that query system theme
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Reset UUID counter and stores before each test
beforeEach(() => {
  uuidCounter = 0
  vi.clearAllMocks()
})
