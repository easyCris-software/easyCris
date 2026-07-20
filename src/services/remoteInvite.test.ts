import { describe, expect, it } from 'vitest'
import {
  buildSignalingUrl,
  parseCloudRemoteInvite,
  parseRemoteInvite,
} from './remoteInvite'

describe('parseRemoteInvite', () => {
  it('parses the backend host:port invite shape', () => {
    expect(
      parseRemoteInvite(
        'easycris-remote://join?host=192.168.1.5:49152&session=session-1&token=secret'
      )
    ).toEqual({
      host: '192.168.1.5',
      port: '49152',
      sessionId: 'session-1',
      token: 'secret',
    })
  })

  it('parses a split host and port invite shape', () => {
    expect(
      parseRemoteInvite(
        'easycris-remote://join?host=192.168.1.5&port=49152&session=session-1&token=secret'
      )
    ).toEqual({
      host: '192.168.1.5',
      port: '49152',
      sessionId: 'session-1',
      token: 'secret',
    })
  })

  it('parses a bare IPv6 host only when port is explicit', () => {
    expect(
      parseRemoteInvite(
        'easycris-remote://join?host=fe80::1&port=49152&session=session-1&token=secret'
      )
    ).toEqual({
      host: 'fe80::1',
      port: '49152',
      sessionId: 'session-1',
      token: 'secret',
    })
  })

  it('parses a bracketed IPv6 host:port invite shape', () => {
    expect(
      parseRemoteInvite(
        'easycris-remote://join?host=[fe80::1]:49152&session=session-1&token=secret'
      )
    ).toEqual({
      host: '[fe80::1]',
      port: '49152',
      sessionId: 'session-1',
      token: 'secret',
    })
  })

  it('does not split a bare IPv6 host as host:port', () => {
    expect(() =>
      parseRemoteInvite(
        'easycris-remote://join?host=fe80::49152&session=session-1&token=secret'
      )
    ).toThrow('Invite is missing host, port, session, or token')
  })

  it('brackets bare IPv6 hosts when building a WebSocket URL', () => {
    expect(buildSignalingUrl('fe80::1', '49152', 'session-1')).toBe(
      'ws://[fe80::1]:49152/remote-session/session-1'
    )
  })

  it('does not double-bracket parsed IPv6 hosts when building a WebSocket URL', () => {
    expect(buildSignalingUrl('[fe80::1]', '49152', 'session-1')).toBe(
      'ws://[fe80::1]:49152/remote-session/session-1'
    )
  })
})

describe('parseCloudRemoteInvite', () => {
  it('parses HTTPS cloud invite links with fragment tokens', () => {
    expect(
      parseCloudRemoteInvite(
        'https://remote.easycris.com/join/rmt_abc123#token=guest-secret'
      )
    ).toEqual({
      inviteId: 'rmt_abc123',
      token: 'guest-secret',
    })
  })

  it('rejects non-TLS cloud invite links', () => {
    expect(() =>
      parseCloudRemoteInvite(
        'http://remote.easycris.com/join/rmt_abc123#token=guest-secret'
      )
    ).toThrow('Invite must be an easyCris remote link')
  })

  it('parses custom-protocol cloud invite links with query tokens', () => {
    expect(
      parseCloudRemoteInvite(
        'easycris-remote://join?mode=cloud&invite=rmt_abc123&token=guest-secret'
      )
    ).toEqual({
      inviteId: 'rmt_abc123',
      token: 'guest-secret',
    })
  })
})
