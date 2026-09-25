/** Default TTL for in-memory `direct_post` state-to-transaction binding (5 minutes). */
export declare const DEFAULT_DIRECT_POST_STATE_TTL_MS: number;
export type DirectPostVpAudTransactionStore = {
    reserve: (state: string) => {
        ok: true;
    } | {
        ok: false;
        error: {
            error: string;
            error_description: string;
        };
    };
    register: (state: string, transactionId: string) => {
        ok: true;
    } | {
        ok: false;
        error: {
            error: string;
            error_description: string;
        };
    };
    resolve: (state: string | undefined) => {
        ok: true;
        transactionId: string;
    } | {
        ok: false;
        error: {
            error: string;
            error_description: string;
        };
    };
    consume: (state: string) => void;
};
/**
 * OpenID4VP `direct_post` state binding: maps the OAuth `state` parameter
 * (echoed by the wallet) back to the verifier transaction ID for VP validation.
 * `state` → `transactionId` lookup only; `clientId` and credential query are held by the library.
 */
export declare function createDirectPostVpAudTransactionStore(options?: {
    ttlMs?: number;
}): DirectPostVpAudTransactionStore;
