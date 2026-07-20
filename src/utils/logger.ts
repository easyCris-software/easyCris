/**
 * Production Logging Utility
 *
 * Integrates with Tauri's log plugin for unified logging across:
 * - Frontend (TypeScript/React)
 * - Backend (Rust)
 * - Python subprocess
 *
 * Logs are automatically forwarded to:
 * - Terminal (stdout)
 * - Browser DevTools console
 * - System logs (macOS Console.app)
 * - Log files (if configured)
 *
 * Based on:
 * - @tauri-apps/api/log (MIT/Apache-2.0)
 * - tokio-rs/tracing (MIT)
 * - tauri-plugin-log (MIT/Apache-2.0)
 */

import { trace, debug, info, warn, error } from '@tauri-apps/plugin-log'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

function safeLogCall(fn: (message: string) => unknown, message: string): void {
  try {
    const result = fn(message) as any
    if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
      result.catch(() => {})
    }
  } catch {
    // Swallow logging failures (e.g., during tests where Tauri APIs aren't available)
  }
}

/**
 * Logger class with support for structured metadata
 */
export class Logger {
  private context: string

  constructor(context: string) {
    this.context = context
  }

  /**
   * Format log message with context
   */
  private format(message: string, metadata?: Record<string, unknown>): string {
    const metaStr = metadata ? ` ${JSON.stringify(metadata)}` : ''
    return `[${this.context}] ${message}${metaStr}`
  }

  /**
   * Trace-level logging (very verbose, only in development)
   */
  trace(message: string, metadata?: Record<string, unknown>): void {
    safeLogCall(trace, this.format(message, metadata))
  }

  /**
   * Debug-level logging (development diagnostics)
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    safeLogCall(debug, this.format(message, metadata))
  }

  /**
   * Info-level logging (production informational messages)
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    safeLogCall(info, this.format(message, metadata))
  }

  /**
   * Warning-level logging (recoverable issues)
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    safeLogCall(warn, this.format(message, metadata))
  }

  /**
   * Error-level logging (failures requiring attention)
   */
  error(message: string, err?: Error | unknown, metadata?: Record<string, unknown>): void {
    const errorData = err instanceof Error
      ? { error: err.message, stack: err.stack, ...metadata }
      : { error: String(err), ...metadata }

    safeLogCall(error, this.format(message, errorData))
  }

  /**
   * Create child logger with extended context
   */
  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`)
  }
}

/**
 * Create a logger instance for a specific module/component
 *
 * @example
 * const log = createLogger('StatisticsController')
 * log.info('Running Two-Way ANOVA', { factors: 2, n: 45 })
 * log.error('Analysis failed', error, { testId: 'two_way_anova' })
 */
export function createLogger(context: string): Logger {
  return new Logger(context)
}

/**
 * Global logger for quick ad-hoc logging
 */
export const log = {
  trace: (message: string, meta?: Record<string, unknown>) => safeLogCall(trace, message + (meta ? ` ${JSON.stringify(meta)}` : '')),
  debug: (message: string, meta?: Record<string, unknown>) => safeLogCall(debug, message + (meta ? ` ${JSON.stringify(meta)}` : '')),
  info: (message: string, meta?: Record<string, unknown>) => safeLogCall(info, message + (meta ? ` ${JSON.stringify(meta)}` : '')),
  warn: (message: string, meta?: Record<string, unknown>) => safeLogCall(warn, message + (meta ? ` ${JSON.stringify(meta)}` : '')),
  error: (message: string, err?: Error | unknown, meta?: Record<string, unknown>) => {
    const errorData = err instanceof Error
      ? { error: err.message, stack: err.stack, ...meta }
      : { error: String(err), ...meta }
    safeLogCall(error, message + ` ${JSON.stringify(errorData)}`)
  },
}

/**
 * Environment-aware logging control
 */
export const isDevelopment = import.meta.env.DEV
export const isProduction = import.meta.env.PROD

/**
 * Conditional debug logging (only in development)
 */
export function debugLog(message: string, metadata?: Record<string, unknown>): void {
  if (isDevelopment) {
    debug(message + (metadata ? ` ${JSON.stringify(metadata)}` : ''))
  }
}
