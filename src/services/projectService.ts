/**
 * Project Service
 *
 * Service layer for project loading (E2E testing support)
 *
 * This service holds a reference to AppShell's loadProjectFromPath function,
 * allowing E2E tests to trigger full project loading with state updates.
 */

/**
 * Reference to the actual loadProjectFromPath implementation
 * This is set by AppShell on mount
 */
export interface LoadProjectOptions {
  nonInteractive?: boolean
}

let _loadProjectFromPath:
  | ((filePath: string, options?: LoadProjectOptions) => Promise<void>)
  | null = null

/**
 * Set the project loader function (called by AppShell on mount)
 * @internal
 */
export function setProjectLoader(
  loader: (filePath: string, options?: LoadProjectOptions) => Promise<void>
): void {
  _loadProjectFromPath = loader
}

/**
 * Load project file with full state restoration
 *
 * @param filePath - Absolute path to .ecp file
 * @returns Promise that resolves when project is fully loaded
 *
 * @throws Error if called before AppShell has mounted
 */
export async function loadProjectFromPath(
  filePath: string,
  options?: LoadProjectOptions
): Promise<void> {
  if (!_loadProjectFromPath) {
    throw new Error('Project loader not initialized. AppShell must mount first.')
  }
  await _loadProjectFromPath(filePath, options)
}
