export type BearerChallengeError = 'invalid_request' | 'invalid_token' | 'insufficient_scope';
export type DpopChallengeError = 'invalid_request' | 'invalid_token' | 'invalid_dpop_proof' | 'use_dpop_nonce';
export type BearerChallengeOptions = {
    realm: string;
    error?: BearerChallengeError;
    errorDescription?: string;
    errorUri?: string;
    scope?: string;
};
export declare const buildBearerAuthenticateHeader: ({ realm, error, errorDescription, errorUri, scope, }: BearerChallengeOptions) => string;
export type DpopChallengeOptions = {
    realm: string;
    error?: DpopChallengeError;
    errorDescription?: string;
    errorUri?: string;
};
export declare const buildDpopAuthenticateHeader: ({ realm, error, errorDescription, errorUri, }: DpopChallengeOptions) => string;
