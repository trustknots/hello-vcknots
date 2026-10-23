import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
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

import { createAuthzRouter } from './routes/authz.js'
import { createIssueRouter } from './routes/issue.js'
import { createVerifierRouter } from './routes/verify.js'
import { createIssuerCustomRouter } from './app/routes.js'
import { createIssuanceSessionStore } from './utils/issuance-session-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function portFromUrl(url: string): number | undefined {
  try {
    const port = new URL(url).port
    return port ? Number.parseInt(port) : undefined
  } catch {
    return undefined
  }
}

async function run() {
  const issuerBaseUrl = process.env.ISSUER_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:8080'
  const issuerPort = Number.parseInt(
    process.env.ISSUER_PORT ?? process.env.PORT ?? String(portFromUrl(issuerBaseUrl) ?? 8080)
  )
  const verifierBaseUrl = process.env.VERIFIER_BASE_URL ?? process.env.BASE_URL ?? issuerBaseUrl
  const verifierPort = Number.parseInt(
    process.env.VERIFIER_PORT ??
      (process.env.VERIFIER_BASE_URL
        ? String(portFromUrl(verifierBaseUrl) ?? issuerPort)
        : String(issuerPort))
  )

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
    const clientId = VerifierClientId(verifierBaseUrl)
    const existingVerifier = await verifierFlow.findVerifierMetadata(clientId)
    if (!existingVerifier) {
      const privateKeyPath =
        process.env.VERIFIER_PRIVATE_KEY_PATH ?? join(keyDir, 'private_key_sample.pem')
      const certificatePath =
        process.env.VERIFIER_CERTIFICATE_PATH ?? join(keyDir, 'certificate_sample.pem')
      if (!existsSync(privateKeyPath) || !existsSync(certificatePath)) {
        throw new Error(
          `Key files not found. Run \`pnpm gen-keys\` first.\n  Expected: ${privateKeyPath}\n  Expected: ${certificatePath}`
        )
      }
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

    issuerMetadataConfig.credential_issuer = CredentialIssuer(issuerBaseUrl)
    issuerMetadataConfig.authorization_servers = [issuerBaseUrl]
    issuerMetadataConfig.credential_endpoint = `${issuerBaseUrl}/credentials`
    issuerMetadataConfig.deferred_credential_endpoint = `${issuerBaseUrl}/deferred_credential`
    issuerMetadataConfig.nonce_endpoint = `${issuerBaseUrl}/nonce`
    const existingIssuer = await issuerFlow.findIssuerMetadata(issuerMetadataConfig.credential_issuer)
    if (!existingIssuer) {
      await issuerFlow.createIssuerMetadata(issuerMetadataConfig)
      console.log('[hello-vcknots] Issuer metadata initialized')
    }

    authorizationMetadataConfig.issuer = AuthorizationServerIssuer(issuerBaseUrl)
    authorizationMetadataConfig.authorization_endpoint = `${issuerBaseUrl}/authorize`
    authorizationMetadataConfig.token_endpoint = `${issuerBaseUrl}/token`
    const existingAuthz = await authzFlow.findAuthzServerMetadata(authorizationMetadataConfig.issuer)
    if (!existingAuthz) {
      await authzFlow.createAuthzServerMetadata(authorizationMetadataConfig)
      console.log('[hello-vcknots] Authz metadata initialized')
    }
  }

  await initMetadata().catch((err: unknown) => {
    console.error('[hello-vcknots] Failed to initialize metadata:', err instanceof Error ? err.message : err)
    process.exit(1)
  })

  const publicDir = resolve(projectDir, 'public')
  const issuanceSessions = createIssuanceSessionStore()

  if (issuerPort === verifierPort) {
    const app = new Hono()
    app.route('/', createIssuerCustomRouter(context, issuerBaseUrl, issuanceSessions))
    app.route('/', createIssueRouter(context, issuerBaseUrl))
    app.route('/', createAuthzRouter(context, issuerBaseUrl, { issuanceSessions }))
    app.route('/', createVerifierRouter(context, verifierBaseUrl))
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

    serve({ fetch: app.fetch, port: issuerPort }, () => {
      console.log(`\n======================================================`)
      console.log(`hello-vcknots Issuer/Verifier Server is running!`)
      console.log(`Issuer Web UI  : ${issuerBaseUrl}/issuer.html`)
      console.log(`Verifier Web UI: ${verifierBaseUrl}/verifier.html`)
      console.log(`======================================================\n`)
    })
  } else {
    const issuerApp = new Hono()
    issuerApp.route('/', createIssuerCustomRouter(context, issuerBaseUrl, issuanceSessions))
    issuerApp.route('/', createIssueRouter(context, issuerBaseUrl))
    issuerApp.route('/', createAuthzRouter(context, issuerBaseUrl, { issuanceSessions }))
    issuerApp.get('/verifier.html', (c) => c.text('404 Not Found', 404))
    issuerApp.use('/*', serveStatic({ root: publicDir }))
    issuerApp.notFound((c) => c.text('404 Not Found', 404))
    issuerApp.onError((err, c) => {
      console.error('[hello-vcknots] Issuer Server Error:', err)
      return c.json({ error: 'internal_server_error', message: err.message }, 500)
    })

    const verifierApp = new Hono()
    verifierApp.route('/', createVerifierRouter(context, verifierBaseUrl))
    verifierApp.get('/issuer.html', (c) => c.text('404 Not Found', 404))
    verifierApp.use('/verifier.html', async (c, next) => {
      await next()
      c.header('Cache-Control', 'no-store')
    })
    verifierApp.use('/*', serveStatic({ root: publicDir }))
    verifierApp.notFound((c) => c.text('404 Not Found', 404))
    verifierApp.onError((err, c) => {
      console.error('[hello-vcknots] Verifier Server Error:', err)
      return c.json({ error: 'internal_server_error', message: err.message }, 500)
    })

    serve({ fetch: issuerApp.fetch, port: issuerPort }, () => {
      console.log(`\n======================================================`)
      console.log(`hello-vcknots Issuer Server is running!`)
      console.log(`Issuer Web UI  : ${issuerBaseUrl}/issuer.html`)
      console.log(`======================================================\n`)
    })
    serve({ fetch: verifierApp.fetch, port: verifierPort }, () => {
      console.log(`\n======================================================`)
      console.log(`hello-vcknots Verifier Server is running!`)
      console.log(`Verifier Web UI: ${verifierBaseUrl}/verifier.html`)
      console.log(`======================================================\n`)
    })
  }
}

run().catch((error) => {
  console.error('[hello-vcknots] Fatal Server crash:', error)
  process.exit(1)
})
