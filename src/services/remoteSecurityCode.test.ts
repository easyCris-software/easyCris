import { describe, expect, it } from 'vitest'
import {
  deriveRemoteSecurityCode,
  extractDtlsFingerprint,
  formatRemoteSecurityCode,
} from './remoteSecurityCode'

const sampleSdp = [
  'v=0',
  'o=- 46117326 2 IN IP4 127.0.0.1',
  'a=group:BUNDLE 0',
  'a=fingerprint:sha-256 12:34:ab:cd:ef:90:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:01:23:45:67:89:ab:cd:ef:01:23',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
].join('\r\n')

describe('remote security code', () => {
  it('extracts the DTLS fingerprint from SDP', () => {
    expect(extractDtlsFingerprint(sampleSdp)).toBe(
      '1234ABCDEF9000112233445566778899AABBCCDDEEFF0123456789ABCDEF0123'
    )
  })

  it('formats a short compare code from a fingerprint', () => {
    expect(
      formatRemoteSecurityCode(
        '12:34:ab:cd:ef:90:00:11:22:33:44:55:66:77:88:99'
      )
    ).toBe('1234-ABCD-EF90')
  })

  it('derives the same compare code from a session description', () => {
    expect(deriveRemoteSecurityCode({ type: 'offer', sdp: sampleSdp })).toBe(
      '1234-ABCD-EF90'
    )
  })

  it('returns null when no fingerprint is present', () => {
    expect(deriveRemoteSecurityCode({ type: 'offer', sdp: 'v=0' })).toBeNull()
  })

  it('rejects fingerprints that are too short', () => {
    expect(formatRemoteSecurityCode('12:34:ab:cd')).toBeNull()
    expect(formatRemoteSecurityCode('1234ABCD')).toBeNull()
  })

  it('rejects non-hex fingerprints', () => {
    expect(formatRemoteSecurityCode('12:34:ab:cd:ef:zz')).toBeNull()
  })
})
