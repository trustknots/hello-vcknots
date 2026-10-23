export const DEFAULT_VERIFICATION_TTL_MS = 5 * 60 * 1000

export type VerificationResult = {
  username: string
  vc: Record<string, unknown> | null
}

export type VerificationSession = VerificationResult & {
  transactionId?: string
  expiresAt: number
  status: 'idle' | 'verifying' | 'verified'
}

export type VerificationSessionStore = ReturnType<typeof createVerificationSessionStore>

/** One lifecycle for request URLs, Request Objects, callbacks and polling results. */
export function createVerificationSessionStore(options: {
  now?: () => number
  reservationTtlMs?: number
  resultTtlMs?: number
  cleanupIntervalMs?: number
  onDiscard?: (transactionId: string) => void
} = {}) {
  const now = options.now ?? Date.now
  const byState = new Map<string, VerificationSession>()

  const remove = (state: string, expected?: VerificationSession): void => {
    const session = byState.get(state)
    if (!session || (expected && session !== expected)) return
    byState.delete(state)
    if (session.transactionId) options.onDiscard?.(session.transactionId)
  }

  const get = (state: string): VerificationSession | undefined => {
    const session = byState.get(state)
    if (session && now() >= session.expiresAt) {
      remove(state, session)
      return undefined
    }
    return session
  }

  const sweep = (): void => {
    for (const state of byState.keys()) get(state)
  }

  const cleanupIntervalMs = options.cleanupIntervalMs ?? 30_000
  const timer = cleanupIntervalMs > 0 ? setInterval(sweep, cleanupIntervalMs) : undefined
  timer?.unref()

  return {
    get,
    remove,
    sweep,
    close: () => { if (timer) clearInterval(timer) },
    reserve(state: string): VerificationSession | undefined {
      if (get(state)) return undefined
      const session: VerificationSession = {
        status: 'idle', username: '', vc: null,
        expiresAt: now() + (options.reservationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS),
      }
      byState.set(state, session)
      return session
    },
    register(state: string, session: VerificationSession, transactionId: string, expiresAt: number): boolean {
      if (get(state) !== session || !Number.isFinite(expiresAt) || now() >= expiresAt) return false
      session.transactionId = transactionId
      session.expiresAt = expiresAt
      return true
    },
    claim(state: string): VerificationSession | undefined {
      const session = get(state)
      if (!session?.transactionId || session.status !== 'idle') return undefined
      session.status = 'verifying'
      return session
    },
    release(state: string, session: VerificationSession): void {
      if (get(state) === session && session.status === 'verifying') session.status = 'idle'
    },
    complete(state: string, session: VerificationSession, result: VerificationResult): boolean {
      if (get(state) !== session || session.status !== 'verifying') return false
      delete session.transactionId
      session.status = 'verified'
      session.username = result.username
      session.vc = result.vc
      session.expiresAt = now() + (options.resultTtlMs ?? DEFAULT_VERIFICATION_TTL_MS)
      return true
    },
  }
}
