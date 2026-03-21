import { fireEvent, render, screen } from '@/test/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutocompleteDropdown } from '../AutocompleteDropdown'

const useThemeMock = vi.fn(() => ({
  theme: 'light',
  resolvedTheme: 'light',
  setTheme: vi.fn(),
}))

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => useThemeMock(),
}))

describe('AutocompleteDropdown', () => {
  afterEach(() => {
    vi.useRealTimers()
    useThemeMock.mockReturnValue({
      theme: 'light',
      resolvedTheme: 'light',
      setTheme: vi.fn(),
    })
  })

  it('calls onHover when mouse enters a suggestion', () => {
    const onHover = vi.fn()

    render(
      <AutocompleteDropdown
        suggestions={[
          { name: 'SUM', signature: 'SUM' },
          { name: 'SUBTOTAL', signature: 'SUBTOTAL' },
        ]}
        selectedIndex={0}
        position={{ top: 10, left: 10 }}
        onSelect={() => {}}
        onHover={onHover}
        usePortal={false}
      />
    )

    fireEvent.mouseEnter(screen.getByText('SUM'))
    expect(onHover).toHaveBeenCalledWith(0)
  })

  it('suppresses hover updates briefly after wheel scrolling', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T12:00:00Z'))
    const onHover = vi.fn()

    render(
      <AutocompleteDropdown
        suggestions={[
          { name: 'SUM', signature: 'SUM' },
          { name: 'SUBTOTAL', signature: 'SUBTOTAL' },
        ]}
        selectedIndex={0}
        position={{ top: 10, left: 10 }}
        onSelect={() => {}}
        onHover={onHover}
        usePortal={false}
      />
    )

    const dropdown = document.querySelector('.formula-autocomplete-dropdown') as HTMLElement
    fireEvent.wheel(dropdown)
    fireEvent.mouseEnter(screen.getByText('SUM'))
    expect(onHover).not.toHaveBeenCalled()

    vi.advanceTimersByTime(130)
    fireEvent.mouseEnter(screen.getByText('SUBTOTAL'))
    expect(onHover).toHaveBeenCalledWith(1)
  })

  it('uses a neutral cursor for formula suggestion rows', () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          { name: 'RAND', signature: 'RAND()' },
        ]}
        selectedIndex={0}
        position={{ top: 10, left: 10 }}
        onSelect={() => {}}
        usePortal={false}
      />
    )

    const row = screen.getByText('RAND').closest('div') as HTMLElement
    expect(row.style.cursor).toBe('default')
  })

  it('uses dark-aware chrome when the resolved theme is dark', () => {
    useThemeMock.mockReturnValue({
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: vi.fn(),
    })

    render(
      <AutocompleteDropdown
        suggestions={[
          { name: 'RAND', signature: 'RAND()' },
        ]}
        selectedIndex={0}
        position={{ top: 10, left: 10 }}
        onSelect={() => {}}
        usePortal={false}
      />
    )

    const dropdown = document.querySelector('.formula-autocomplete-dropdown') as HTMLElement
    const row = screen.getByText('RAND').closest('div') as HTMLElement

    expect(dropdown).toHaveStyle({ backgroundColor: '#0f172a' })
    expect(row).toHaveStyle({ color: '#e2e8f0' })
  })
})
