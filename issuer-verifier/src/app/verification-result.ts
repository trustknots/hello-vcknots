import type { VerificationResult } from '../utils/verification-session-store.js'

/** Extract display data only after the library has verified the presentations. */
export function extractVerificationResult(payload: Record<string, unknown[]>): VerificationResult {
  for (const entry of Object.values(payload).flat()) {
    const vp = (entry as { vp?: { verifiableCredential?: unknown[] } })?.vp
    const jwt = vp?.verifiableCredential?.[0]
    if (typeof jwt !== 'string') continue
    const parts = jwt.split('.')
    if (parts.length !== 3 || !parts[1]) continue
    try {
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
      const vc = decoded.vc as { credentialSubject?: { username?: unknown } } | undefined
      return {
        username: typeof vc?.credentialSubject?.username === 'string'
          ? vc.credentialSubject.username : 'VC Knots Explorer',
        vc: decoded,
      }
    } catch {
      // A presentation format without a JWT VC has no medal details to display.
    }
  }
  return { username: 'VC Knots Explorer', vc: null }
}
