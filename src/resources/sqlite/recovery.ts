// The recovery code: the database key itself, written for
// a person to copy. 32 key bytes plus 2 checksum bytes (the start of the key's
// sha256), Crockford base32, 55 characters in 11 groups of 5. Decoding ignores
// case, dashes and spaces, reads I and L as 1 and O as 0, and the checksum
// catches a mistyped group before the code touches the database.

import { createHash } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const KEY_BYTES = 32
const CHECK_BYTES = 2
export const RECOVERY_GROUP = 5
export const RECOVERY_CHARS = Math.ceil(((KEY_BYTES + CHECK_BYTES) * 8) / 5)

export class RecoveryCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryCodeError'
  }
}

function checksum(key: Uint8Array): Uint8Array {
  return createHash('sha256').update(key).digest().subarray(0, CHECK_BYTES)
}

/** 64 hex characters in, `XXXXX-XXXXX-…` (11 groups) out. */
export function encodeRecoveryCode(hexKey: string): string {
  if (!/^[0-9a-f]{64}$/.test(hexKey)) throw new RecoveryCodeError('the key is not 64 hex characters')
  const key = Buffer.from(hexKey, 'hex')
  const bytes = Buffer.concat([key, checksum(key)])
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.match(new RegExp(`.{1,${RECOVERY_GROUP}}`, 'g'))!.join('-')
}

/** The last group, which `kinfold encrypt` asks the person to type back. */
export function lastGroup(code: string): string {
  return code.split('-').at(-1)!
}

/** A code back to the 64-hex key; a wrong character, length or checksum throws without echoing the input. */
export function decodeRecoveryCode(code: string): string {
  const chars = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (chars.length !== RECOVERY_CHARS) throw new RecoveryCodeError(`a recovery code has ${RECOVERY_CHARS} characters; this one has ${chars.length}`)
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of chars) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) throw new RecoveryCodeError('a recovery code uses only 0-9 and A-Z without U')
    value = ((value << 5) | digit) & 0xffff
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  const key = Uint8Array.from(bytes.slice(0, KEY_BYTES))
  const check = Uint8Array.from(bytes.slice(KEY_BYTES, KEY_BYTES + CHECK_BYTES))
  if (key.length !== KEY_BYTES || Buffer.compare(Buffer.from(check), Buffer.from(checksum(key))) !== 0) {
    throw new RecoveryCodeError('the recovery code does not check out; look for a mistyped group')
  }
  const hex = Buffer.from(key).toString('hex')
  // The last character carries 3 padding bits; only the canonical spelling is accepted.
  if (encodeRecoveryCode(hex).replace(/-/g, '') !== chars) throw new RecoveryCodeError('the recovery code does not check out; look for a mistyped group')
  return hex
}
