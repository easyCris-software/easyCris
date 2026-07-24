import { fireEvent, render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { WelcomeScreen } from './WelcomeScreen'

describe('WelcomeScreen', () => {
  it('shows explicit first-launch actions without redundant guest exits', () => {
    const onComplete = vi.fn()
    const onLinkDevice = vi.fn()
    const onCreateProject = vi.fn()
    const onImportData = vi.fn()
    const onBrowseExamples = vi.fn()
    const onContinueAsGuest = vi.fn()

    render(
      <WelcomeScreen
        open
        onComplete={onComplete}
        onLinkDevice={onLinkDevice}
        onCreateProject={onCreateProject}
        onImportData={onImportData}
        onBrowseExamples={onBrowseExamples}
        onContinueAsGuest={onContinueAsGuest}
      />
    )

    expect(screen.getByRole('button', { name: /link this device/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeInTheDocument()
    expect(
      screen.getByText(/you can link this device later from preferences > account/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^skip$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument()
  })

  it('starts device linking without completing onboarding immediately', () => {
    const onComplete = vi.fn()
    const onLinkDevice = vi.fn()

    render(
      <WelcomeScreen
        open
        onComplete={onComplete}
        onLinkDevice={onLinkDevice}
        onCreateProject={vi.fn()}
        onImportData={vi.fn()}
        onBrowseExamples={vi.fn()}
        onContinueAsGuest={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /link this device/i }))

    expect(onLinkDevice).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('calls the explicit guest handler when continue as guest is chosen', () => {
    const onComplete = vi.fn()
    const onContinueAsGuest = vi.fn()

    render(
      <WelcomeScreen
        open
        onComplete={onComplete}
        onLinkDevice={vi.fn()}
        onCreateProject={vi.fn()}
        onImportData={vi.fn()}
        onBrowseExamples={vi.fn()}
        onContinueAsGuest={onContinueAsGuest}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    expect(onContinueAsGuest).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
