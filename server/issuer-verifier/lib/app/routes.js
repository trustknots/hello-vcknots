import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initializeIssuerFlow, CredentialIssuer, CredentialConfigurationId, CredentialRequest, } from '@trustknots/vcknots/issuer';
import { initializeVerifierFlow, VerifierClientId, VerifierAuthorizationResponse, ClientIdentifier, } from '@trustknots/vcknots/verifier';
import { AuthorizationServerIssuer, initializeAuthzFlow } from '@trustknots/vcknots/authz';
export const globalState = {
    currentUsername: 'VCKnots Explorer',
    lastVerifiedUsername: '',
    verificationStatus: 'idle', // 'idle' | 'verified'
};
export const createIssuerCustomRouter = (context, issuerBaseUrl) => {
    const router = new Hono();
    const issuerFlow = initializeIssuerFlow(context);
    const authzFlow = initializeAuthzFlow(context);
    router.post('/api/setup', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const username = (body.username || 'VCKnots Explorer').trim();
            globalState.currentUsername = username;
            globalState.verificationStatus = 'idle';
            globalState.lastVerifiedUsername = '';
            console.log(`[hello-vcknots] Setup demo user: ${username}`);
            return c.json({ ok: true, username });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : 'Unknown error';
            return c.json({ error: message }, 500);
        }
    });
    router.post('/configurations/:configuration/offer', async (c) => {
        try {
            const configuration = c.req.param('configuration');
            const issuer = CredentialIssuer(issuerBaseUrl);
            const { offer } = await issuerFlow.offerCredential(issuer, [CredentialConfigurationId(configuration)], {
                usePreAuth: true,
                ttlSec: 600,
            });
            console.log(`[hello-vcknots] Generated offer for ${configuration}. Code-preauth.`);
            return c.text(`openid-credential-offer://?credential_offer=${encodeURIComponent(JSON.stringify(offer))}`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            console.error('[hello-vcknots] Offer error:', err);
            return c.json({ error: message }, 400);
        }
    });
    router.post('/credentials', async (c) => {
        const issuer = CredentialIssuer(issuerBaseUrl);
        const authz = AuthorizationServerIssuer(issuerBaseUrl);
        let authorizationContext;
        try {
            authorizationContext = await authzFlow.authorizeCredentialEndpointAccess(authz, {
                authorizationHeader: c.req.header('Authorization'),
                dpopHeader: c.req.header('DPoP'),
                htm: c.req.method,
                htu: `${issuerBaseUrl}/credentials`,
                nonceRequired: true,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Token is required';
            return c.json({ error: 'invalid_token', error_description: message }, 401);
        }
        const requestBody = await c.req.json().catch(() => null);
        if (!requestBody) {
            return c.json({ error: 'invalid_request', error_description: 'Request body must be valid JSON' }, 400);
        }
        const parseResult = CredentialRequest.schema.safeParse(requestBody);
        if (!parseResult.success) {
            return c.json({ error: 'invalid_request', error_description: 'Invalid CredentialRequest' }, 400);
        }
        const claims = {
            username: globalState.currentUsername,
            issued_at: new Date().toISOString(),
            medal_type: 'VCKnots User Medal',
            user_level: 'Beginner',
        };
        console.log(`[hello-vcknots] Issuing VCKnotsUserMedal to user: "${claims.username}"`);
        try {
            const credential = await issuerFlow.issueCredential(issuer, parseResult.data, {
                authorizationContext,
                alg: 'ES256',
                cnonce: {
                    c_nonce_expires_in: 300000,
                },
                claims,
                proofJwt: { usePreAuth: true },
            });
            return c.json(credential);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            console.error('[hello-vcknots] Credential issue error:', err);
            return c.json({ error: 'invalid_request', error_description: message }, 400);
        }
    });
    return router;
};
export const createVerifierCustomRouter = (context, verifierBaseUrl) => {
    const router = new Hono();
    const verifierFlow = initializeVerifierFlow(context);
    const stateToTransactionId = new Map();
    router.get('/api/status', (c) => {
        return c.json({
            status: globalState.verificationStatus,
            username: globalState.lastVerifiedUsername,
        });
    });
    router.post('/request', async (c) => {
        try {
            const verifierId = VerifierClientId(verifierBaseUrl);
            const body = await c.req.json().catch(() => ({}));
            const inputQuery = typeof body.query === 'object' && body.query !== null && !Array.isArray(body.query)
                ? body.query
                : undefined;
            const credentialId = typeof body.credentialId === 'string' && body.credentialId.trim() !== ''
                ? body.credentialId
                : undefined;
            if (!credentialId && !inputQuery) {
                return c.json({ error: 'invalid_request', error_description: 'credentialId is required' }, 400);
            }
            const state = typeof body.state === 'string' && body.state.trim() !== '' ? body.state.trim() : undefined;
            if (!state) {
                return c.json({ error: 'invalid_request', error_description: 'state is required' }, 400);
            }
            const query = inputQuery ?? {
                dcql_query: {
                    credentials: [
                        {
                            id: randomUUID(),
                            format: 'jwt_vc_json',
                            meta: {
                                type_values: [[credentialId]],
                            },
                        },
                    ],
                },
            };
            const { request, transactionId } = await verifierFlow.createAuthzRequest(verifierId, 'vp_token', ClientIdentifier('redirect_uri:localhost'), 'direct_post', query, false, {
                state,
                response_uri: `${verifierBaseUrl}/callback`,
                base_url: verifierBaseUrl,
            });
            stateToTransactionId.set(state, transactionId);
            const encoded = Object.entries({ ...request, state })
                .map(([key, value]) => {
                const encode = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
                return `${encodeURIComponent(key)}=${encodeURIComponent(encode)}`;
            })
                .join('&');
            return c.text(`openid4vp://authorize?${encoded}`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return c.json({ error: 'internal_server_error', error_description: message }, 500);
        }
    });
    router.post('/callback', async (c) => {
        try {
            const formData = await c.req.formData();
            const state = formData.get('state');
            const vpTokenRaw = formData.get('vp_token');
            if (typeof state !== 'string' || typeof vpTokenRaw !== 'string') {
                return c.json({ error: 'invalid_request', error_description: 'state and vp_token are required' }, 400);
            }
            const transactionId = stateToTransactionId.get(state);
            if (!transactionId) {
                return c.json({ error: 'invalid_request', error_description: 'Unknown or expired state' }, 400);
            }
            let parsedVpToken;
            try {
                parsedVpToken = JSON.parse(vpTokenRaw);
            }
            catch {
                return c.json({ error: 'invalid_request', error_description: 'vp_token must be a JSON object' }, 400);
            }
            const authorizationResponse = VerifierAuthorizationResponse({
                state,
                vp_token: parsedVpToken,
            });
            const vpPayload = await verifierFlow.verifyPresentations(authorizationResponse, transactionId);
            stateToTransactionId.delete(state);
            console.log('[hello-vcknots] Verified presentations successfully:', JSON.stringify(vpPayload));
            let verifiedUsername = 'VCKnots Explorer';
            try {
                const allVps = Object.values(vpPayload).flat();
                for (const vpEntry of allVps) {
                    const vpRecord = vpEntry;
                    const vcArr = vpRecord?.vc?.verifiableCredential;
                    const vcJwt = Array.isArray(vcArr) ? vcArr[0] : undefined;
                    if (typeof vcJwt === 'string') {
                        const parts = vcJwt.split('.');
                        if (parts.length === 3 && parts[1]) {
                            const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                            const credSubject = decoded?.vc?.credentialSubject;
                            if (typeof credSubject?.username === 'string') {
                                verifiedUsername = credSubject.username;
                                break;
                            }
                        }
                    }
                }
            }
            catch (ex) {
                console.warn('[hello-vcknots] Failed to extract username from payload:', ex);
            }
            globalState.lastVerifiedUsername = verifiedUsername;
            globalState.verificationStatus = 'verified';
            console.log(`[hello-vcknots] Verifier successfully verified medal for: "${verifiedUsername}"`);
            return c.json({ redirect_uri: `${verifierBaseUrl}/verified.html` }, 200);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            console.error('[hello-vcknots] Verification callback error:', err);
            return c.json({ error: 'invalid_request', error_description: message }, 400);
        }
    });
    return router;
};
