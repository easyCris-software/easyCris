import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const isolationIndexPath = path.resolve(
  __dirname,
  '../../../src-tauri/isolation/index.html'
)

function readAllowedCommands(): string[] {
  const source = fs.readFileSync(isolationIndexPath, 'utf8')
  const match = source.match(
    /const ALLOWED_CUSTOM_COMMANDS = new Set\(\[([\s\S]*?)\]\);/
  )

  if (!match) {
    throw new Error('Failed to locate ALLOWED_CUSTOM_COMMANDS in isolation/index.html')
  }

  const commandBlock = match[1] ?? ''
  return Array.from(commandBlock.matchAll(/'([^']+)'/g), (entry) => entry[1] ?? '')
}

describe('tauri isolation command allowlist', () => {
  it('allows the desktop auth command bridge used by device linking', () => {
    const commands = readAllowedCommands()

    expect(commands).toEqual(
      expect.arrayContaining([
        'desktop_auth_start',
        'desktop_auth_poll',
        'desktop_auth_validate_session',
        'desktop_auth_refresh_session',
        'desktop_auth_revoke_session',
        'desktop_auth_store_session_token',
        'desktop_auth_load_session_token',
        'desktop_auth_clear_session_token',
      ])
    )
  })

  it('allows the remote-session spike command bridge', () => {
    const commands = readAllowedCommands()

    expect(commands).toEqual(
      expect.arrayContaining([
        'start_remote_session',
        'capture_native_window_screenshot',
        'start_e2e_native_audio_capture',
        'start_native_mic_capture',
        'start_native_screen_capture',
        'stop_e2e_native_audio_capture',
        'stop_native_mic_capture',
        'stop_native_screen_capture',
        'set_e2e_remote_capture_rect',
        'stop_remote_session',
        'get_remote_session_status',
        'approve_remote_session_guest',
        'reject_remote_session_guest',
        'revoke_remote_control',
        'remote_input_mouse_event',
        'remote_input_key_event',
      ])
    )
  })
})
