// Ed25519 keys for the hub and each device, and what they sign. A device
// signs every request; the hub signs every reply, bound to the request it
// answers, so a device can tell its own hub from anything else answering at
// that address. Each canonical string starts with its own label, so a
// signature made for one purpose never verifies for another.

import { type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

export interface KeyPair {
  /** Base64 SPKI DER: what is sent and stored as the other side's key. */
  publicKey: string
  /** PKCS8 PEM: stays in this data folder, 0600. */
  privateKey: string
}

export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** The public half of a stored private key. */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64')
}

export function bodyHash(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

export interface SignedRequest {
  method: string
  path: string
  deviceId: string
  time: number
  nonce: string
  bodySha256: string
}

export interface SignedReply {
  requestSignature: string
  status: number
  bodySha256: string
}

function requestString(request: SignedRequest): string {
  return ['kinfold-central-request-v1', request.method, request.path, request.deviceId, String(request.time), request.nonce, request.bodySha256].join('\n')
}

function replyString(reply: SignedReply): string {
  return ['kinfold-central-reply-v1', reply.requestSignature, String(reply.status), reply.bodySha256].join('\n')
}

/** How many parsed keys of each kind are kept: the hub's own, and one per paired device that is talking to it. */
const KEY_CACHE_LIMIT = 64
const privateKeys = new Map<string, KeyObject>()
const publicKeys = new Map<string, KeyObject>()

/**
 * The parsed key for its text, parsed once: every signed request used to parse
 * the hub's PEM to sign the reply and the device's DER to check the request.
 * Only a key that parsed is kept, and the text is the cache key, so a device
 * whose key is replaced (a new pairing) is checked against the new one.
 */
function parsedKey(cache: Map<string, KeyObject>, text: string, parse: () => KeyObject): KeyObject {
  const known = cache.get(text)
  if (known !== undefined) return known
  const key = parse()
  if (cache.size >= KEY_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done !== true) cache.delete(oldest.value)
  }
  cache.set(text, key)
  return key
}

function signString(privateKeyPem: string, text: string): string {
  return sign(null, Buffer.from(text), parsedKey(privateKeys, privateKeyPem, () => createPrivateKey(privateKeyPem))).toString('base64')
}

function verifyString(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = parsedKey(publicKeys, publicKey, () => createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }))
    if (key.asymmetricKeyType !== 'ed25519') return false
    return verify(null, Buffer.from(text), key, Buffer.from(signature, 'base64'))
  } catch {
    // A key or signature that does not parse proves nothing.
    return false
  }
}

export function signRequest(privateKeyPem: string, request: SignedRequest): string {
  return signString(privateKeyPem, requestString(request))
}

export function verifyRequest(publicKey: string, request: SignedRequest, signature: string): boolean {
  return verifyString(publicKey, requestString(request), signature)
}

export function signReply(privateKeyPem: string, reply: SignedReply): string {
  return signString(privateKeyPem, replyString(reply))
}

export function verifyReply(publicKey: string, reply: SignedReply, signature: string): boolean {
  return verifyString(publicKey, replyString(reply), signature)
}
