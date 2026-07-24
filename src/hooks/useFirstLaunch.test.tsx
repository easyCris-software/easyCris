import { render, screen, waitFor } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFirstLaunch } from './useFirstLaunch'

vi.mock('@/utils/e2eMode', () => ({
  isE2EEnabled: vi.fn(),
}))

import { isE2EEnabled } from '@/utils/e2eMode'

function HookProbe() {
  const { isFirstLaunch, isLoading } = useFirstLaunch()

  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="first-launch">{String(isFirstLaunch)}</span>
    </div>
  )
}

describe('useFirstLaunch', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(isE2EEnabled).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps the welcome screen skipped by default in E2E mode', async () => {
    vi.mocked(isE2EEnabled).mockReturnValue(true)

    render(<HookProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('loading')).toHaveTextContent('false')
    )

    expect(screen.getByTestId('first-launch')).toHaveTextContent('false')
    expect(window.localStorage.getItem('hasSeenWelcome')).toBe('true')
  })

  it('allows E2E to force the welcome screen back on', async () => {
    vi.mocked(isE2EEnabled).mockReturnValue(true)
    window.localStorage.setItem('easycris.e2e.force_first_launch', 'true')

    render(<HookProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('loading')).toHaveTextContent('false')
    )

    expect(screen.getByTestId('first-launch')).toHaveTextContent('true')
    expect(window.localStorage.getItem('hasSeenWelcome')).toBeNull()
  })
})
