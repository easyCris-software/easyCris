import type { ReactNode } from 'react'
import { render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { PreferencesDialog } from './PreferencesDialog'

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    preferencesOpen: true,
    setPreferencesOpen: vi.fn(),
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
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))

describe('PreferencesDialog', () => {
  it('shows only account and appearance panes and defaults to account', () => {
    render(<PreferencesDialog />)

    expect(screen.getByRole('button', { name: /account/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /appearance/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /general/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /advanced/i })).not.toBeInTheDocument()

    expect(
      screen.getByRole('heading', { name: /account/i, level: 3 })
    ).toBeInTheDocument()
    expect(screen.getByText(/guest mode/i)).toBeInTheDocument()
  })
})
