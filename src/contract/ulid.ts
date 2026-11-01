// ULIDs name every event: sortable by time, unique without coordination, and
// safe as the dedupe key when a spool entry is retried.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIME = 2 ** 48 - 1
const RANDOM_BYTES = 10

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function ulid(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError('ulid: time must be epoch milliseconds within 48 bits')
  }
  if (random.length !== RANDOM_BYTES) throw new RangeError(`ulid: needs ${RANDOM_BYTES} random bytes`)

  const timeChars: string[] = []
  let time = now
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(CROCKFORD[time % 32]!)
    time = Math.floor(time / 32)
  }

  // 80 random bits read 5 at a time give exactly 16 characters.
  const randomChars: string[] = []
  let buffer = 0
  let bits = 0
  for (const byte of random) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      randomChars.push(CROCKFORD[(buffer >> bits) & 31]!)
    }
    buffer &= (1 << bits) - 1
  }

  return timeChars.join('') + randomChars.join('')
}
