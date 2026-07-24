import type { ReactNode } from 'react'
import { render, screen } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { PreferencesDialog } from './PreferencesDialog'

let activePreferencesPane = 'account'
const mockSetActivePreferencesPane = vi.fn((pane: string) => {
  activePreferencesPane = pane
})

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    preferencesOpen: true,
    setPreferencesOpen: vi.fn(),
    activePreferencesPane,
    setActivePreferencesPane: mockSetActivePreferencesPane,
  }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

describe('PreferencesDialog', () => {
  beforeEach(() => {
    activePreferencesPane = 'account'
    mockSetActivePreferencesPane.mockClear()
    useRemoteJoinUrlStore.setState({ pendingUrl: null })
  })

  it('shows preference panes and defaults to account', () => {
    render(<PreferencesDialog />)

    expect(screen.getByRole('button', { name: /account/i })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /appearance/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /powerpoint/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remote/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /general/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /advanced/i })
    ).not.toBeInTheDocument()

    expect(
      screen.getByRole('heading', { name: /account/i, level: 3 })
    ).toBeInTheDocument()
    expect(screen.getByText(/guest mode/i)).toBeInTheDocument()
  })

  it('opens the Remote pane when the app selects it for a pending remote invite', () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl('easycris-remote://join?host=127.0.0.1:49152')
    activePreferencesPane = 'remote'

    render(<PreferencesDialog />)

    expect(screen.getByTestId('preferences-nav-remote')).toHaveAttribute(
      'data-active',
      'true'
    )
    expect(screen.getByRole('button', { name: /remote/i })).toBeInTheDocument()
  })
})
