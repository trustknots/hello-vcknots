import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PRIVATE_KEY_FILE = join(__dirname, 'private_key_sample.pem')
const CERTIFICATE_FILE = join(__dirname, 'certificate_sample.pem')

if (existsSync(PRIVATE_KEY_FILE) && existsSync(CERTIFICATE_FILE)) {
  console.log('Keys already exist, skipping.')
  process.exit(0)
}

const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const

const keyPair = await crypto.subtle.generateKey(alg, true, ['sign', 'verify'])

const pkcs8Buf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
const pkcs8B64 = Buffer.from(pkcs8Buf).toString('base64')
const privateKeyPem = [
  '-----BEGIN PRIVATE KEY-----',
  ...pkcs8B64.match(/.{1,64}/g)!,
  '-----END PRIVATE KEY-----',
  '',
].join('\n')

const notBefore = new Date()
const notAfter = new Date(notBefore)
notAfter.setFullYear(notAfter.getFullYear() + 10)

const sanValues = (process.env.VCKNOTS_SAN ?? 'localhost,127.0.0.1')
  .split(',').map((s: string) => s.trim()).filter(Boolean)

const skiExt = await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey)
const akiExt = new x509.AuthorityKeyIdentifierExtension(skiExt.keyId)
const basicConstraintsExt = new x509.BasicConstraintsExtension(true, undefined, true)

const isIp = (v: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v)
const sanExt = sanValues.length > 0
  ? [new x509.SubjectAlternativeNameExtension(
      sanValues.map((v: string) => ({ type: isIp(v) ? 'ip' : 'dns', value: v }) as x509.JsonGeneralName)
    )]
  : []

const extensions: x509.Extension[] = [skiExt, akiExt, basicConstraintsExt, ...sanExt]

const cert = await x509.X509CertificateGenerator.createSelfSigned({
  serialNumber: '01',
  name: 'CN=localhost',
  notBefore,
  notAfter,
  signingAlgorithm: alg,
  keys: keyPair,
  extensions,
})

writeFileSync(PRIVATE_KEY_FILE, privateKeyPem)
writeFileSync(CERTIFICATE_FILE, cert.toString('pem'))

console.log(`Generated: ${PRIVATE_KEY_FILE}`)
console.log(`Generated: ${CERTIFICATE_FILE}`)
