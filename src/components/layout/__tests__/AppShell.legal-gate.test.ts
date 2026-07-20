import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { getChangedLegalDocs } from '../AppShell'

const storedAcceptance = {
  schemaVersion: 1,
  policyVersion: '2026-04-05',
  acceptedAt: '2026-05-28T00:00:00.000Z',
  hashes: {
    eula: 'eula-v1',
    privacy: 'privacy-v1',
    thirdParty: 'third-party-v1',
  },
}

describe('AppShell legal gate', () => {
  it('does not require re-consent when only third-party license notices change', () => {
    const changedDocs = getChangedLegalDocs(storedAcceptance, {
      eula: 'eula-v1',
      privacy: 'privacy-v1',
      thirdParty: 'third-party-v2',
    })

    expect(changedDocs).toEqual([])
  })

  it('requires re-consent when EULA or privacy policy changes', () => {
    expect(
      getChangedLegalDocs(storedAcceptance, {
        eula: 'eula-v2',
        privacy: 'privacy-v1',
        thirdParty: 'third-party-v2',
      })
    ).toEqual(['eula'])

    expect(
      getChangedLegalDocs(storedAcceptance, {
        eula: 'eula-v1',
        privacy: 'privacy-v2',
        thirdParty: 'third-party-v2',
      })
    ).toEqual(['privacy'])
  })

  it('returns EULA then privacy when both acceptance documents change', () => {
    const changedDocs = getChangedLegalDocs(storedAcceptance, {
      eula: 'eula-v2',
      privacy: 'privacy-v2',
      thirdParty: 'third-party-v2',
    })

    expect(changedDocs).toEqual(['eula', 'privacy'])
  })

  it('accepts new-format stored records without third-party notice hashes', () => {
    const changedDocs = getChangedLegalDocs(
      {
        schemaVersion: 1,
        policyVersion: '2026-04-05',
        acceptedAt: '2026-05-28T00:00:00.000Z',
        hashes: {
          eula: 'eula-v1',
          privacy: 'privacy-v1',
        },
      },
      {
        eula: 'eula-v1',
        privacy: 'privacy-v1',
      }
    )

    expect(changedDocs).toEqual([])
  })

  it('does not expose legal document loading copy during startup', () => {
    const source = readFileSync(resolve(__dirname, '../AppShell.tsx'), 'utf8')

    expect(source).not.toContain('Preparing legal documents')
    expect(source).not.toContain('Please wait before using easyCris')
  })

  it('keeps a silent blocker while the startup legal check is unresolved', () => {
    const source = readFileSync(resolve(__dirname, '../AppShell.tsx'), 'utf8')

    expect(source).toMatch(
      /legalGateEnabled && !legalGateReady[\s\S]{0,150}aria-hidden="true"/
    )
    expect(source).toMatch(
      /\.\.\.\(legalGateEnabled && !legalGateReady \? \{ inert: '' \} : \{\}\)/
    )
  })
})
