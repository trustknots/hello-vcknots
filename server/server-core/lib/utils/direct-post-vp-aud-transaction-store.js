/** Default TTL for in-memory `direct_post` state-to-transaction binding (5 minutes). */
export const DEFAULT_DIRECT_POST_STATE_TTL_MS = 5 * 60 * 1000;
/**
 * OpenID4VP `direct_post` state binding: maps the OAuth `state` parameter
 * (echoed by the wallet) back to the verifier transaction ID for VP validation.
 * `state` → `transactionId` lookup only; `clientId` and credential query are held by the library.
 */
export function createDirectPostVpAudTransactionStore(options) {
    const ttlMs = options?.ttlMs ?? DEFAULT_DIRECT_POST_STATE_TTL_MS;
    const byState = new Map();
    const consume = (state) => {
        byState.delete(state);
    };
    const sweepExpired = () => {
        const now = Date.now();
        for (const [key, val] of byState) {
            if (now > val.expiresAt)
                byState.delete(key);
        }
    };
    const reserve = (state) => {
        sweepExpired();
        const existing = byState.get(state);
        if (existing !== undefined) {
            if (Date.now() <= existing.expiresAt) {
                return {
                    ok: false,
                    error: {
                        error: 'invalid_request',
                        error_description: 'state is already in use for an active presentation transaction',
                    },
                };
            }
            byState.delete(state);
        }
        byState.set(state, { transactionId: '', expiresAt: Date.now() + ttlMs });
        return { ok: true };
    };
    const register = (state, transactionId) => {
        const existing = byState.get(state);
        if (existing !== undefined) {
            const isReservation = existing.transactionId === '';
            if (!isReservation && Date.now() <= existing.expiresAt) {
                return {
                    ok: false,
                    error: {
                        error: 'invalid_request',
                        error_description: 'state is already in use for an active presentation transaction',
                    },
                };
            }
            byState.delete(state);
        }
        byState.set(state, { transactionId, expiresAt: Date.now() + ttlMs });
        return { ok: true };
    };
    const resolve = (state) => {
        if (state == null || state.trim() === '') {
            return {
                ok: false,
                error: {
                    error: 'invalid_request',
                    error_description: 'state is required for VP audience validation',
                },
            };
        }
        const rec = byState.get(state);
        if (rec === undefined) {
            return {
                ok: false,
                error: { error: 'invalid_request', error_description: 'unknown or expired state' },
            };
        }
        if (Date.now() > rec.expiresAt) {
            consume(state);
            return {
                ok: false,
                error: { error: 'invalid_request', error_description: 'unknown or expired state' },
            };
        }
        if (rec.transactionId === '') {
            return {
                ok: false,
                error: { error: 'invalid_request', error_description: 'unknown or expired state' },
            };
        }
        return { ok: true, transactionId: rec.transactionId };
    };
    return { reserve, register, resolve, consume };
}
