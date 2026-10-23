import { randomUUID } from 'node:crypto'
import { VcknotsContext } from '@trustknots/vcknots'
import { err } from '@trustknots/vcknots/errors'
import {
  ClientIdentifier,
  VerifierAuthorizationResponse,
  VerifierClientId,
  VerifierClientIdPrefix,
  VerifierRequestObjectId,
  initializeVerifierFlow,
} from '@trustknots/vcknots/verifier'
import { Context, Hono } from 'hono'
import { extractVerificationResult } from '../app/verification-result.js'
import {
  createVerificationSessionStore,
  type VerificationSession,
  type VerificationSessionStore,
} from '../utils/verification-session-store.js'
import { handleError } from '../utils/error-handler.js'

export const createVerifierRouter = (
  context: VcknotsContext,
  baseUrl: string,
  options: { sessions?: VerificationSessionStore } = {}
) => {
  const verifyApp = new Hono()
  const verifierFlow = initializeVerifierFlow(context)
  const sessions = options.sessions ?? createVerificationSessionStore({
    onDiscard: (transactionId) => {
      void verifierFlow.deleteTransaction(transactionId).catch((error: unknown) => {
        console.error('[verify] Failed to delete expired transaction:', error)
      })
    },
  })
  type AuthzQueryInput = Parameters<typeof verifierFlow.createAuthzRequest>[4]
  type CreatedRequest = Awaited<ReturnType<typeof verifierFlow.createAuthzRequest>>

  const defaultQuery = (credentialId: string): AuthzQueryInput => ({
    dcql_query: {
      credentials: [{
        id: randomUUID(), format: 'jwt_vc_json', meta: { type_values: [[credentialId]] },
      }],
    },
  })
  const objectValue = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined
  const nonEmptyString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  const requestUrl = (request: CreatedRequest['request']) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(request)) {
      if (value !== undefined) params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    return 'openid4vp://authorize?' + params.toString()
  }
  const errorResponse = (c: Context, error: unknown) => {
    const body = handleError(error)
    return c.json(body, body.error === 'internal_server_error' ? 500 : 400)
  }
  const validateClientId = (value: unknown, fallback: string): ClientIdentifier => {
    const clientId = nonEmptyString(value) ?? fallback
    const prefix = clientId.split(':')[0] as VerifierClientIdPrefix
    if (!['redirect_uri', 'x509_san_dns'].includes(prefix)) {
      throw err('invalid_request', { message: 'Invalid client_id format' })
    }
    return ClientIdentifier(clientId)
  }

  // Bind both request delivery modes before returning a URL to the wallet.
  const saveRequest = async (
    state: string,
    reservation: VerificationSession,
    create: () => Promise<CreatedRequest>
  ): Promise<CreatedRequest['request']> => {
    let transactionId: string | undefined
    try {
      const created = await create()
      transactionId = created.transactionId
      const transaction = await verifierFlow.getTransaction(transactionId)
      if (!sessions.register(state, reservation, transactionId, transaction.expiresAt)) {
        throw err('invalid_request', { message: 'Request expired during creation' })
      }
      return created.request
    } catch (error) {
      sessions.remove(state, reservation)
      if (transactionId) await verifierFlow.deleteTransaction(transactionId)
      throw error
    }
  }

  verifyApp.get('/api/status', (c) => {
    c.header('Cache-Control', 'no-store')
    const state = nonEmptyString(c.req.query('state'))
    if (!state) return c.json({ error: 'invalid_request', error_description: 'state is required' }, 400)
    const session = sessions.get(state)
    if (!session) {
      return c.json({ error: 'invalid_request', error_description: 'Unknown or expired state' }, 404)
    }
    return c.json({
      status: session.status === 'verified' ? 'verified' : 'idle',
      username: session.username,
      vc: session.vc,
    })
  })

  verifyApp.post('/request', async (c) => {
    try {
      const body = objectValue(await c.req.json().catch(() => null))
      if (!body) return c.json({ error: 'invalid_request', error_description: 'Request body must be a JSON object' }, 400)
      const credentialId = nonEmptyString(body.credentialId)
      const inputQuery = objectValue(body.query) as AuthzQueryInput | undefined
      if (!credentialId && !inputQuery) {
        return c.json({ error: 'invalid_request', error_description: 'credentialId or query is required' }, 400)
      }
      const state = nonEmptyString(body.state)
      if (!state) return c.json({ error: 'invalid_request', error_description: 'state is required' }, 400)
      const clientId = validateClientId(body.client_id, 'redirect_uri:localhost')
      const reservation = sessions.reserve(state)
      if (!reservation) return c.json({ error: 'invalid_request', error_description: 'state is already in use' }, 409)
      const request = await saveRequest(state, reservation, () => verifierFlow.createAuthzRequest(
        VerifierClientId(baseUrl), 'vp_token', clientId, 'direct_post',
        inputQuery ?? defaultQuery(credentialId!), false,
        { state, response_uri: baseUrl + '/callback', base_url: baseUrl }
      ))
      return c.text(requestUrl(request))
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  verifyApp.post('/request-object', async (c) => {
    try {
      const raw = await c.req.text()
      const body = raw.trim() ? objectValue(JSON.parse(raw)) : {}
      if (!body) return c.json({ error: 'invalid_request', error_description: 'Request body must be a JSON object' }, 400)
      const state = nonEmptyString(body.state) ?? randomUUID().replaceAll('-', '')
      const query = objectValue(body.query) as AuthzQueryInput | undefined
      const clientId = validateClientId(body.client_id, 'x509_san_dns:localhost')
      const reservation = sessions.reserve(state)
      if (!reservation) return c.json({ error: 'invalid_request', error_description: 'state is already in use' }, 409)
      const request = await saveRequest(state, reservation, () => verifierFlow.createAuthzRequest(
        VerifierClientId(baseUrl), 'vp_token', clientId, 'direct_post',
        query ?? defaultQuery('VerifiableCredential'),
        typeof body.is_request_uri === 'boolean' ? body.is_request_uri : true,
        {
          state, base_url: baseUrl,
          response_uri: nonEmptyString(body.response_uri) ?? baseUrl + '/callback',
          request_uri: baseUrl + '/request.jwt',
          ...(body.is_transaction_data === true ? { transaction_data: { type: 'sample_type' } } : {}),
        }
      ))
      return c.text(requestUrl(request))
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: 'invalid_request', error_description: 'Request body must be valid JSON' }, 400)
      }
      return errorResponse(c, error)
    }
  })

  const callback = async (c: Context, isKbJwt: boolean) => {
    let claimed: VerificationSession | undefined
    let state: string | undefined
    try {
      const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (contentType !== 'application/x-www-form-urlencoded') {
        return c.json({ error: 'invalid_request', error_description: 'content-type must be application/x-www-form-urlencoded' }, 400)
      }
      const form = await c.req.formData()
      state = nonEmptyString(form.get('state'))
      const raw = form.get('vp_token')
      if (!state || typeof raw !== 'string') {
        return c.json({ error: 'invalid_request', error_description: 'state and vp_token are required' }, 400)
      }
      const vpToken = objectValue(JSON.parse(raw))
      if (!vpToken) return c.json({ error: 'invalid_request', error_description: 'vp_token must be a JSON object' }, 400)
      const response = VerifierAuthorizationResponse({
        state, vp_token: vpToken as VerifierAuthorizationResponse['vp_token'],
      })
      claimed = sessions.claim(state)
      if (!claimed) {
        return c.json({ error: 'invalid_request', error_description: 'Unknown, expired or already used state' }, 400)
      }
      const payload = await verifierFlow.verifyPresentations(response, claimed.transactionId!, { isKbJwt })
      if (!sessions.complete(state, claimed, extractVerificationResult(payload))) {
        return c.json({ error: 'invalid_request', error_description: 'Verification session has expired' }, 400)
      }
      return c.json({ redirect_uri: baseUrl + '/verified' })
    } catch (error) {
      if (state && claimed) sessions.release(state, claimed)
      if (error instanceof SyntaxError) {
        return c.json({ error: 'invalid_request', error_description: 'vp_token must be a JSON object' }, 400)
      }
      return errorResponse(c, error)
    }
  }
  verifyApp.post('/callback', (c) => callback(c, false))
  verifyApp.post('/callback-kbjwt', (c) => callback(c, true))

  verifyApp.get('/request.jwt/:request-object-Id', async (c) => {
    try {
      const id = VerifierRequestObjectId.schema.safeParse(c.req.param('request-object-Id'))
      if (!id.success) return c.json({ error: 'invalid_request', error_description: 'Invalid request-object-Id' }, 400)
      const jar = await verifierFlow.findRequestObject(VerifierClientId(baseUrl), id.data)
      return c.body(jar, 200, { 'Content-Type': 'application/oauth-authz-req+jwt', 'Cache-Control': 'no-store' })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  verifyApp.get('/verified', (c) => c.json({ message: 'DONE!!' }))

  verifyApp.get('/presentation-transaction/:transactionId', async (c) => {
    try {
      const transactionId = c.req.param('transactionId')
      const result = await verifierFlow.getTransaction(transactionId)
      return c.json({
        transaction_id: transactionId, state: result.state,
        client_id: result.clientId, expires_at: result.expiresAt,
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  verifyApp.delete('/presentation-transaction/:transactionId', async (c) => {
    try {
      const transactionId = c.req.param('transactionId')
      const existing = await verifierFlow.getTransaction(transactionId)
      if (existing.state) {
        const session = sessions.get(existing.state)
        if (session?.transactionId === transactionId) sessions.remove(existing.state, session)
      }
      await verifierFlow.deleteTransaction(transactionId)
      return c.json({ ok: true })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  return verifyApp
}
