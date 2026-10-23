import { createHash } from 'node:crypto'

export type IssuanceSession = {
  username: string
  expiresAt: number
}

export type IssuanceSessionStore = ReturnType<typeof createIssuanceSessionStore>

/** Application claims follow an offer code through token redemption, without inspecting JWT claims. */
export function createIssuanceSessionStore(options: {
  now?: () => number
  cleanupIntervalMs?: number
} = {}) {
  const now = options.now ?? Date.now
  const offers = new Map<string, IssuanceSession>()
  const tokens = new Map<string, IssuanceSession>()
  // Keep application-owned lookup keys, rather than raw codes or access tokens.
  const key = (value: string) => createHash('sha256').update(value).digest('hex')
  const get = (store: Map<string, IssuanceSession>, value: string) => {
    const id = key(value)
    const session = store.get(id)
    if (session && now() >= session.expiresAt) {
      store.delete(id)
      return undefined
    }
    return session
  }
  const sweep = () => {
    for (const store of [offers, tokens]) {
      for (const [id, session] of store) {
        if (now() >= session.expiresAt) store.delete(id)
      }
    }
  }
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 30_000
  const timer = cleanupIntervalMs > 0 ? setInterval(sweep, cleanupIntervalMs) : undefined
  timer?.unref()

  return {
    sweep,
    close: () => { if (timer) clearInterval(timer) },
    addOffer(code: string, username: string, ttlSec: number): void {
      offers.set(key(code), { username, expiresAt: now() + ttlSec * 1000 })
    },
    getOffer: (code: string) => get(offers, code),
    bindToken(code: string, expected: IssuanceSession, accessToken: string, ttlSec: number): boolean {
      if (get(offers, code) !== expected || !Number.isFinite(ttlSec) || ttlSec <= 0) return false
      tokens.set(key(accessToken), { username: expected.username, expiresAt: now() + ttlSec * 1000 })
      offers.delete(key(code))
      return true
    },
    getForToken: (accessToken: string) => get(tokens, accessToken),
  }
}
