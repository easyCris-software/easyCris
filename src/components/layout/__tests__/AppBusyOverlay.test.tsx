import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AppBusyOverlay } from '../AppBusyOverlay'
import type { AppOperationLock } from '@/store/app-store'

const createLock = (overrides: Partial<AppOperationLock> = {}): AppOperationLock => ({
  active: true,
  token: 'token-1',
  owner: 'paste',
  operation: 'Pasting data',
  progress: 45,
  stage: 'Preparing paste 16/16...',
  startedAt: '2026-06-20T00:00:00.000Z',
  ...overrides,
})

describe('AppBusyOverlay', () => {
  it('shows operation-specific copy for paste instead of results copy', () => {
    render(<AppBusyOverlay lock={createLock()} />)

    expect(screen.getByText('Pasting data')).toBeInTheDocument()
    expect(screen.queryByText('Please wait for results')).not.toBeInTheDocument()
  })

  it('hides stale percent text when the lock is indeterminate', () => {
    render(<AppBusyOverlay lock={createLock({
      indeterminate: true,
      stage: 'Applying paste...',
    })} />)

    expect(screen.getByText('Applying paste...')).toBeInTheDocument()
    expect(screen.queryByText('45% complete')).not.toBeInTheDocument()
  })
})
