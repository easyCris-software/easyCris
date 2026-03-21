// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
export interface AppPreferences {
  theme: string
  // OLE integration settings (Windows only)
  ole_integration_prompted?: boolean
  ole_integration_enabled?: boolean
  // Add new persistent preferences here, e.g.:
  // auto_save: boolean
  // language: string
}

export const defaultPreferences: AppPreferences = {
  theme: 'light',
  ole_integration_prompted: false,
  ole_integration_enabled: false,
  // Add defaults for new preferences here
}
