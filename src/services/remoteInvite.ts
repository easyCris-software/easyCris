export interface ParsedRemoteInvite {
  host: string
  port: string
  sessionId: string
  token: string
}

export interface ParsedCloudRemoteInvite {
  inviteId: string
  token: string
}

export const inviteModeFromLink = (value: string): 'lan' | 'cloud' => {
  try {
    const url = new URL(value.trim())
    if (url.protocol === 'https:') return 'cloud'
    if (url.searchParams.get('mode') === 'cloud') return 'cloud'
    if (url.searchParams.has('invite')) return 'cloud'
  } catch {
    return 'lan'
  }
  return 'lan'
}

export const parseRemoteInvite = (value: string): ParsedRemoteInvite => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Paste a remote-session invite first')
  }

  const url = new URL(trimmed)
  if (url.protocol !== 'easycris-remote:') {
    throw new Error('Invite must start with easycris-remote://')
  }

  const hostParam = url.searchParams.get('host') ?? ''
  const explicitPort = url.searchParams.get('port') ?? ''
  const sessionId = url.searchParams.get('session') ?? ''
  const token = url.searchParams.get('token') ?? ''
  const lastColon = hostParam.lastIndexOf(':')
  const closeBracket = hostParam.indexOf(']')
  const colonCount = [...hostParam].filter(char => char === ':').length
  const isBracketedIpv6 = hostParam.startsWith('[') && hostParam.includes(']')
  const bracketedIpv6HasEmbeddedPort =
    isBracketedIpv6 &&
    closeBracket > 0 &&
    closeBracket < hostParam.length - 2 &&
    hostParam[closeBracket + 1] === ':'
  const hostHasEmbeddedPort =
    lastColon > 0 &&
    lastColon < hostParam.length - 1 &&
    colonCount === 1 &&
    !isBracketedIpv6
  const host = bracketedIpv6HasEmbeddedPort
    ? hostParam.slice(0, closeBracket + 1)
    : hostHasEmbeddedPort
      ? hostParam.slice(0, lastColon)
      : hostParam
  const port =
    explicitPort ||
    (bracketedIpv6HasEmbeddedPort
      ? hostParam.slice(closeBracket + 2)
      : hostHasEmbeddedPort
        ? hostParam.slice(lastColon + 1)
        : '')

  if (!host || !port || !sessionId || !token) {
    throw new Error('Invite is missing host, port, session, or token')
  }

  return { host, port, sessionId, token }
}

export const buildSignalingUrl = (
  host: string,
  port: string,
  sessionId: string
) => {
  const urlHost =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `ws://${urlHost}:${port}/remote-session/${encodeURIComponent(sessionId)}`
}

export const parseCloudRemoteInvite = (
  value: string
): ParsedCloudRemoteInvite => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Paste a remote-session invite first')
  }

  const url = new URL(trimmed)
  if (url.protocol === 'https:') {
    const parts = url.pathname.split('/').filter(Boolean)
    const inviteId = parts.at(-1) ?? ''
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
    const token = hashParams.get('token') ?? ''
    if (!inviteId || !token) {
      throw new Error('Invite is missing invite id or token')
    }
    return { inviteId, token }
  }

  if (url.protocol !== 'easycris-remote:') {
    throw new Error('Invite must be an easyCris remote link')
  }

  const inviteId = url.searchParams.get('invite') ?? ''
  const token = url.searchParams.get('token') ?? ''
  if (!inviteId || !token) {
    throw new Error('Invite is missing invite id or token')
  }
  return { inviteId, token }
}
