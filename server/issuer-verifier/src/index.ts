import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { initializeContext } from '@trustknots/vcknots'
import {
  AuthorizationServerIssuer,
  AuthorizationServerMetadata,
  initializeAuthzFlow,
} from '@trustknots/vcknots/authz'
import {
  CredentialIssuer,
  CredentialIssuerMetadata,
  initializeIssuerFlow,
} from '@trustknots/vcknots/issuer'
import { initializeVerifierFlow, VerifierClientId, VerifierMetadata } from '@trustknots/vcknots/verifier'

import { createAuthzRouter } from '@trustknots/server-core/routes/authz'
import { createIssueRouter } from '@trustknots/server-core/routes/issue'
import { createVerifierRouter } from '@trustknots/server-core/routes/verify'
import { createCustomRouter } from './app/routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function run() {
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:8080'
  const port = Number.parseInt(process.env.PORT ?? '8080')
  const projectDir = resolve(__dirname, '..')
  const configDir = process.env.ISSUER_VERIFIER_CONFIG_DIR ?? join(projectDir, 'config')
  const metadataDir = join(configDir, 'metadata')
  const keyDir = process.env.ISSUER_VERIFIER_KEY_DIR ?? join(configDir, 'keys')

  const issuerMetadataConfig = CredentialIssuerMetadata(
    JSON.parse(readFileSync(join(metadataDir, 'issuer_metadata.json'), 'utf-8'))
  )
  const authorizationMetadataConfig = AuthorizationServerMetadata(
    JSON.parse(readFileSync(join(metadataDir, 'authorization_metadata.json'), 'utf-8'))
  )
  const verifierMetadataConfig = VerifierMetadata(
    JSON.parse(readFileSync(join(metadataDir, 'verifier_metadata.json'), 'utf-8'))
  )

  const context = initializeContext({ debug: true })

  const issuerFlow = initializeIssuerFlow(context)
  const authzFlow = initializeAuthzFlow(context)
  const verifierFlow = initializeVerifierFlow(context)

  async function initMetadata() {
    const clientId = VerifierClientId(baseUrl)
    const existingVerifier = await verifierFlow.findVerifierMetadata(clientId)
    if (!existingVerifier) {
      const privateKeyPath =
        process.env.VERIFIER_PRIVATE_KEY_PATH ?? join(keyDir, 'private_key_openid.pem')
      const certificatePath =
        process.env.VERIFIER_CERTIFICATE_PATH ?? join(keyDir, 'certificate_openid.pem')
      const privateKey = readFileSync(privateKeyPath, 'utf-8')
      const certificate = readFileSync(certificatePath, 'utf-8')

      await verifierFlow.createVerifierMetadata(clientId, verifierMetadataConfig, {
        privateKey,
        certificate,
        format: 'pem',
        alg: 'ES256',
      })
      console.log(`[hello-vcknots] Verifier metadata initialized for ${clientId}`)
    }

    issuerMetadataConfig.credential_issuer = CredentialIssuer(baseUrl)
    issuerMetadataConfig.authorization_servers = [baseUrl]
    issuerMetadataConfig.credential_endpoint = `${baseUrl}/credentials`
    issuerMetadataConfig.deferred_credential_endpoint = `${baseUrl}/deferred_credential`
    issuerMetadataConfig.nonce_endpoint = `${baseUrl}/nonce`
    const existingIssuer = await issuerFlow.findIssuerMetadata(issuerMetadataConfig.credential_issuer)
    if (!existingIssuer) {
      await issuerFlow.createIssuerMetadata(issuerMetadataConfig)
      console.log('[hello-vcknots] Issuer metadata initialized')
    }

    authorizationMetadataConfig.issuer = AuthorizationServerIssuer(baseUrl)
    authorizationMetadataConfig.authorization_endpoint = `${baseUrl}/authorize`
    authorizationMetadataConfig.token_endpoint = `${baseUrl}/token`
    const existingAuthz = await authzFlow.findAuthzServerMetadata(authorizationMetadataConfig.issuer)
    if (!existingAuthz) {
      await authzFlow.createAuthzServerMetadata(authorizationMetadataConfig)
      console.log('[hello-vcknots] Authz metadata initialized')
    }
  }

  await initMetadata().catch((err) => {
    console.error('Metadata initialization warning:', err)
  })

  const app = new Hono()

  app.route('/', createCustomRouter(context, baseUrl))
  app.route('/', createIssueRouter(context, baseUrl))
  app.route('/', createAuthzRouter(context, baseUrl))
  app.route('/', createVerifierRouter(context, baseUrl))

  const publicDir = resolve(projectDir, 'public')
  app.use('/verifier.html', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })
  app.use('/*', serveStatic({ root: publicDir }))

  app.notFound((c) => c.text('404 Not Found', 404))
  app.onError((err, c) => {
    console.error('[hello-vcknots] Hono Server Error:', err)
    return c.json({ error: 'internal_server_error', message: err.message }, 500)
  })

  serve({ fetch: app.fetch, port }, () => {
    console.log(`\n======================================================`)
    console.log(`hello-vcknots Issuer/Verifier Server is running!`)
    console.log(`Issuer Web UI  : http://localhost:${port}/issuer.html`)
    console.log(`Verifier Web UI: http://localhost:${port}/verifier.html`)
    console.log(`======================================================\n`)
  })
}

run().catch((error) => {
  console.error('[hello-vcknots] Fatal Server crash:', error)
  process.exit(1)
})
