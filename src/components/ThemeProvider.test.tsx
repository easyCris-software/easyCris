import { render, screen } from '@/test/test-utils'
import { useTheme } from '@/hooks/use-theme'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from './ThemeProvider'

const usePreferencesMock = vi.fn(() => ({ data: undefined }))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => usePreferencesMock(),
}))

type MatchMediaRecord = {
  media: string
  matches: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

let matchMediaRecord: MatchMediaRecord

function installMatchMedia(initialMatches: boolean) {
  matchMediaRecord = {
    media: '(prefers-color-scheme: dark)',
    matches: initialMatches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => matchMediaRecord),
  })
}

function ThemeHarness() {
  const { theme, resolvedTheme } = useTheme() as ReturnType<typeof useTheme> & {
    resolvedTheme?: 'light' | 'dark'
  }

  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved-theme">{resolvedTheme}</span>
    </div>
  )
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
    usePreferencesMock.mockReturnValue({ data: undefined })
  })

  it('normalizes a legacy system preference to the current OS theme', () => {
    installMatchMedia(false)
    localStorage.setItem('ui-theme', 'system')

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('light')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('keeps an explicit dark preference', () => {
    installMatchMedia(false)
    localStorage.setItem('ui-theme', 'dark')

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('dark')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
