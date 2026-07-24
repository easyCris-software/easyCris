/**
 * Python Bridge Utilities
 *
 * Shared utilities for Python script execution via Tauri.
 * Consolidates path resolution and provides safe script building.
 */

import tauriApi from './tauriApi'

// Cache the Python embedded path to avoid repeated lookups
let cachedPythonPath: string | null = null

/**
 * Normalize arbitrary JS values into JSON-safe values for Tauri invoke payloads.
 */
function toJsonSafeValue(value: unknown): unknown {
  if (value === null) return null
  if (value === undefined) return undefined

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }

  if (Array.isArray(value)) {
    return value.map((entry) => {
      const normalized = toJsonSafeValue(entry)
      return normalized === undefined ? null : normalized
    })
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>, (entry) =>
      Number.isFinite(entry) ? entry : null
    )
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalized = toJsonSafeValue(entry)
      if (normalized !== undefined) {
        out[key] = normalized
      }
    }
    return out
  }

  return value
}

/**
 * Get the path to python_embedded directory.
 * Cached after first successful lookup.
 */
export async function getPythonEmbeddedPath(): Promise<string> {
  if (cachedPythonPath) return cachedPythonPath

  try {
    const result = await tauriApi.executePythonScript(
      `
import sys
from pathlib import Path
print(str(Path(sys.executable).parent))
`,
      {}
    )
    cachedPythonPath = result.output.trim()
    return cachedPythonPath
  } catch {
    // Fallback to common path
    return 'python_embedded'
  }
}

/**
 * Build the Python path setup preamble.
 * This is injected at the start of scripts to ensure imports work.
 * Uses context variable for path to avoid injection risks.
 */
export function buildPythonPreamble(): string {
  return `
import sys
import json
from pathlib import Path

# Path passed via context to avoid injection
script_dir = Path(context["_python_embedded_path"])
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))
deps_dir = script_dir / "python_dependencies"
if str(deps_dir) not in sys.path:
    sys.path.insert(0, str(deps_dir))
`
}

/**
 * Execute a Python script with automatic path setup.
 * Adds python_embedded path to context automatically.
 *
 * @param scriptBody - The Python script body (without preamble)
 * @param context - Context variables to pass to the script
 * @param timeoutMs - Optional timeout in milliseconds (default: 30000)
 */
export async function executePythonWithSetup(
  scriptBody: string,
  context: Record<string, unknown>,
  timeoutMs = 30000
): Promise<{ output: string; error?: string }> {
  const pythonPath = await getPythonEmbeddedPath()

  const fullScript = `${buildPythonPreamble()}
${scriptBody}
`

  const fullContext = toJsonSafeValue({
    ...context,
    _python_embedded_path: pythonPath,
  }) as Record<string, unknown>

  // Execute with timeout wrapper
  const timeoutPromise = new Promise<{ output: string; error: string }>((_, reject) => {
    setTimeout(() => reject(new Error(`Python script timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  const executionPromise = tauriApi.executePythonScript(fullScript, fullContext)

  try {
    return await Promise.race([executionPromise, timeoutPromise])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { output: '', error: message }
  }
}

export default {
  getPythonEmbeddedPath,
  buildPythonPreamble,
  executePythonWithSetup,
}
