const FINGERPRINT_LINE = /^a=fingerprint:\S+\s+([0-9a-f:]+)$/im

export const extractDtlsFingerprint = (sdp: string | undefined | null) => {
  if (!sdp) return null
  const match = sdp.match(FINGERPRINT_LINE)
  if (!match?.[1]) return null
  return match[1].replace(/:/g, '').toUpperCase()
}

export const formatRemoteSecurityCode = (
  fingerprint: string | undefined | null
) => {
  // Accept raw colon-separated SDP fingerprints and pre-normalized hex strings.
  const normalized = fingerprint?.replace(/:/g, '').toUpperCase() ?? ''
  if (normalized.length < 12 || /[^0-9A-F]/.test(normalized)) return null
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`
}

export const deriveRemoteSecurityCode = (
  description: RTCSessionDescriptionInit | undefined | null
) => formatRemoteSecurityCode(extractDtlsFingerprint(description?.sdp))
