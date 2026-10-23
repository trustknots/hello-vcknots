import { Hono } from 'hono'
import {
  initializeIssuerFlow,
  CredentialIssuer,
  CredentialConfigurationId,
  CredentialRequest,
} from '@trustknots/vcknots/issuer'
import { AuthorizationServerIssuer, initializeAuthzFlow } from '@trustknots/vcknots/authz'
import { parseAuthorizationHeader, VcknotsContext } from '@trustknots/vcknots'
import type { IssuanceSessionStore } from '../utils/issuance-session-store.js'

const PRE_AUTH_TTL_SEC = 600

export const createIssuerCustomRouter = (
  context: VcknotsContext,
  issuerBaseUrl: string,
  sessions: IssuanceSessionStore
) => {
  const router = new Hono()
  const issuerFlow = initializeIssuerFlow(context)
  const authzFlow = initializeAuthzFlow(context)

  router.post('/configurations/:configuration/offer', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null)
      const username = body && typeof body === 'object' && 'username' in body
        && typeof body.username === 'string' ? body.username.trim() : ''
      if (!username) {
        return c.json({ error: 'invalid_request', error_description: 'username must be a non-empty string' }, 400)
      }
      const configuration = c.req.param('configuration')
      const issuer = CredentialIssuer(issuerBaseUrl)

      const { offer } = await issuerFlow.offerCredential(issuer, [CredentialConfigurationId(configuration)], {
        usePreAuth: true,
        ttlSec: PRE_AUTH_TTL_SEC,
      })

      const code = offer.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']?.['pre-authorized_code']
      if (!code) throw new Error('Pre-authorized code was not returned')
      sessions.addOffer(code, username, PRE_AUTH_TTL_SEC)

      console.log(`[hello-vcknots] Generated offer for ${configuration}. Code-preauth.`)
      return c.text(
        `openid-credential-offer://?credential_offer=${encodeURIComponent(JSON.stringify(offer))}`
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[hello-vcknots] Offer error:', err)
      return c.json({ error: message }, 400)
    }
  })

  router.post('/credentials', async (c) => {
    const issuer = CredentialIssuer(issuerBaseUrl)
    const authz = AuthorizationServerIssuer(issuerBaseUrl)

    let authorizationContext: Awaited<ReturnType<typeof authzFlow.authorizeCredentialEndpointAccess>>
    try {
      authorizationContext = await authzFlow.authorizeCredentialEndpointAccess(authz, {
        authorizationHeader: c.req.header('Authorization'),
        dpopHeader: c.req.header('DPoP'),
        htm: c.req.method,
        htu: `${issuerBaseUrl}/credentials`,
        nonceRequired: true,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Token is required'
      return c.json({ error: 'invalid_token', error_description: message }, 401)
    }

    const requestBody = await c.req.json().catch(() => null)
    if (!requestBody) {
      return c.json({ error: 'invalid_request', error_description: 'Request body must be valid JSON' }, 400)
    }
    const parseResult = CredentialRequest.schema.safeParse(requestBody)
    if (!parseResult.success) {
      return c.json({ error: 'invalid_request', error_description: 'Invalid CredentialRequest' }, 400)
    }

    // Authorization was verified above. Look up application claims using the same token.
    const authorization = parseAuthorizationHeader(c.req.header('Authorization'))
    const session = authorization.ok ? sessions.getForToken(authorization.value.token) : undefined
    if (!session) {
      return c.json({ error: 'invalid_request', error_description: 'Issuance session not found or expired' }, 400)
    }

    const claims = {
      username: session.username,
      issued_at: new Date().toISOString(),
      medal_type: 'VC Knots User Medal',
      user_level: 'Beginner',
    }

    console.log(`[hello-vcknots] Issuing VCKnotsUserMedal to user: "${claims.username}"`)

    try {
      const credential = await issuerFlow.issueCredential(issuer, parseResult.data, {
        authorizationContext,
        alg: 'ES256',
        cnonce: {
          c_nonce_expires_in: 300000,
        },
        claims,
        proofJwt: { usePreAuth: true },
      })
      return c.json(credential)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[hello-vcknots] Credential issue error:', err)
      return c.json({ error: 'invalid_request', error_description: message }, 400)
    }
  })

  return router
}
