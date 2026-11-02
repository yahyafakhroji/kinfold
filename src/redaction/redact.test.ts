import { describe, expect, test } from 'bun:test'
import { ALL_SECRET_VALUES, FAKE_SECRETS, leakyOutput } from '../../test/fixtures/secrets'
import { UNKEYED_EPOCH, formatRef, markerRefs, parseRef, redactJson, redactText, refMatches, secretRef } from './redact'

const options = { hmacKey: 'test-hmac-key' }

describe('redactText', () => {
  test.each(ALL_SECRET_VALUES.map((secret, index) => [index, secret]))('removes corpus secret #%d', (_index, secret) => {
    expect(redactText(leakyOutput(), 'tool.output', options).value).not.toContain(secret)
  })

  test('keeps ordinary text, config numbers and commit hashes', () => {
    const { value } = redactText(leakyOutput(), 'tool.output', options)
    expect(value).toContain('Loaded config for app')
    expect(value).toContain('max_tokens=4096')
    expect(value).toContain('commit 3f9c2a7b1d4e5f60718293a4b5c6d7e8f9012345')
  })

  test('keeps the user and host of a URL and drops only the password', () => {
    const { value } = redactText(`postgres://app:${FAKE_SECRETS.dbPassword}@db.internal:5432/app`, 'f', options)
    expect(value).toStartWith('postgres://app:<redacted type="url_credentials"')
    expect(value).toEndWith('@db.internal:5432/app')
  })

  test('gives the same secret the same ref and another key a different ref', () => {
    const twice = `a ${FAKE_SECRETS.github} b ${FAKE_SECRETS.github}`
    const refs = [...redactText(twice, 'f', options).value.matchAll(/ref="([0-9a-f]{8})"/g)].map((m) => m[1])
    expect(refs).toEqual([secretRef(FAKE_SECRETS.github, 'test-hmac-key'), secretRef(FAKE_SECRETS.github, 'test-hmac-key')])
    expect(secretRef(FAKE_SECRETS.github, 'other-key')).not.toBe(refs[0])
  })

  test('counts each rule per field', () => {
    const { notes } = redactText(`${FAKE_SECRETS.aws} ${FAKE_SECRETS.aws}`, 'tool.output', options)
    expect(notes).toEqual([{ field: 'tool.output', rule: 'aws_access_key', count: 2 }])
  })

  describe('key fragments', () => {
    test('a quoted key prefix with a few key characters is redacted', () => {
      const text = 'the summary file holds sk-or-v1-a1b2… in plain text, and ghp_c3d4 too'
      const { value, notes } = redactText(text, 'assistantText', options)
      expect(value).not.toContain('sk-or-v1-a1b2')
      expect(value).not.toContain('ghp_c3d4')
      expect(value).toContain('in plain text')
      expect(notes).toEqual([{ field: 'assistantText', rule: 'key_fragment', count: 2 }])
    })

    test('a bare prefix or a placeholder stays', () => {
      const text = 'OpenRouter keys start with sk-or-v1- and look like sk-ant-... in the docs'
      expect(redactText(text, 'f', options)).toEqual({ value: text, notes: [] })
    })

    test('a full key is still named by its own rule, not as a fragment', () => {
      const { notes } = redactText(`key ${FAKE_SECRETS.openrouter}`, 'f', options)
      expect(notes).toEqual([{ field: 'f', rule: 'openrouter_key', count: 1 }])
    })
  })

  describe('entropy modes', () => {
    const neutral = `build id ${FAKE_SECRETS.unnamedRandom}`
    const keyed = `signing secret: ${FAKE_SECRETS.unnamedRandom}x`

    test('keyed mode flags an unnamed random string on a neutral line but keeps it', () => {
      const result = redactText(neutral, 'f', options)
      expect(result.value).toBe(neutral)
      expect(result.notes).toEqual([{ field: 'f', rule: 'high_entropy_flagged', count: 1 }])
    })

    test('keyed mode redacts it next to a secret-looking key', () => {
      expect(redactText(keyed, 'f', options).value).not.toContain(FAKE_SECRETS.unnamedRandom)
    })

    test('strict mode redacts it everywhere, commit hashes included', () => {
      const strict = { ...options, entropyMode: 'strict' as const }
      expect(redactText(neutral, 'f', strict).value).not.toContain(FAKE_SECRETS.unnamedRandom)
      expect(redactText('commit 3f9c2a7b1d4e5f60718293a4b5c6d7e8f9012345', 'f', strict).value).toContain('high_entropy')
    })
  })
})

describe('redactJson', () => {
  test('redacts values under secret-looking keys and strings everywhere, without mutating input', () => {
    const input = {
      command: `curl -H "Authorization: Bearer ${FAKE_SECRETS.bearer}" https://api.example.com`,
      env: { OPENROUTER_API_KEY: 'plain-looking-value-123', LOG_LEVEL: 'debug' },
      args: [FAKE_SECRETS.slack],
      retries: 3,
    }
    const snapshot = structuredClone(input)
    const { value, notes } = redactJson(input, 'tool.input', options)
    const text = JSON.stringify(value)

    expect(text).not.toContain(FAKE_SECRETS.bearer)
    expect(text).not.toContain('plain-looking-value-123')
    expect(text).not.toContain(FAKE_SECRETS.slack)
    expect(text).toContain('"LOG_LEVEL":"debug"')
    expect(text).toContain('"retries":3')
    expect(notes.map((n) => n.field)).toEqual(['tool.input.command', 'tool.input.env.OPENROUTER_API_KEY', 'tool.input.args[0]'])
    expect(input).toEqual(snapshot)
  })
})

describe('epoch-tagged refs', () => {
  const tagged = { hmacKey: 'test-hmac-key', epoch: 202610 }

  test('refs name their epoch; epoch 0 writes the old untagged form', () => {
    const value = redactText(`x ${FAKE_SECRETS.github}`, 'f', tagged).value
    expect(value).toContain(`ref="e202610.${secretRef(FAKE_SECRETS.github, 'test-hmac-key')}"`)
    expect(redactText(`x ${FAKE_SECRETS.github}`, 'f', options).value).toContain(`ref="${secretRef(FAKE_SECRETS.github, 'test-hmac-key')}"`)
  })

  test('formatRef and parseRef round-trip both forms; anything else is not a ref', () => {
    for (const [hex, epoch] of [['0a1b2c3d', 0], ['0a1b2c3d', 202610], ['ffffffff', UNKEYED_EPOCH]] as const) {
      expect(parseRef(formatRef(hex, epoch))).toEqual({ epoch, hex })
    }
    expect(formatRef('0a1b2c3d', 202610)).toBe('e202610.0a1b2c3d')
    expect(parseRef('0a1b2c3d')).toEqual({ epoch: 0, hex: '0a1b2c3d' })
    for (const bad of ['', 'e.0a1b2c3d', 'e0.0a1b2c3d', '0A1B2C3D', '0a1b2c3d0', 'e202610:0a1b2c3d']) expect(parseRef(bad)).toBeNull()
  })

  test('markerRefs reads old and new markers from the same text', () => {
    const text = 'a <redacted type="openai_key" ref="0a1b2c3d"/> b <redacted type="jwt" ref="e202611.11223344"/> c <redacted type="jwt" ref="bogus"/>'
    expect(markerRefs(text)).toEqual([{ epoch: 0, hex: '0a1b2c3d' }, { epoch: 202611, hex: '11223344' }])
  })

  test('text redacted once, under either form, is not redacted again by a later epoch', () => {
    for (const first of [options, tagged]) {
      const once = redactText(leakyOutput(), 'f', first).value
      const again = redactText(once, 'f', { hmacKey: 'later-key', epoch: 202611 })
      expect(again.value).toBe(once)
      expect(again.notes.filter((note) => note.rule !== 'high_entropy_flagged')).toEqual([])
      const json = redactJson({ password: FAKE_SECRETS.dbPassword, out: once }, 'tool', first).value
      expect(redactJson(json, 'tool', { hmacKey: 'later-key', epoch: 202611 }).value).toEqual(json)
    }
  })

  test('refMatches checks a secret against a ref of any epoch through the epoch\'s key; x. refs never match', () => {
    const keys: Record<number, string> = { 0: 'legacy-key', 202610: 'oct-key' }
    const keyFor = (epoch: number): string | null => keys[epoch] ?? null
    const old = secretRef(FAKE_SECRETS.github, 'legacy-key')
    const oct = formatRef(secretRef(FAKE_SECRETS.github, 'oct-key'), 202610)
    expect(refMatches(FAKE_SECRETS.github, old, keyFor)).toBe(true)
    expect(refMatches(FAKE_SECRETS.github, oct, keyFor)).toBe(true)
    expect(refMatches(FAKE_SECRETS.aws, oct, keyFor)).toBe(false)
    expect(refMatches(FAKE_SECRETS.github, formatRef(secretRef(FAKE_SECRETS.github, 'nov-key'), 202611), keyFor)).toBe(false)
    expect(refMatches(FAKE_SECRETS.github, formatRef(old, UNKEYED_EPOCH), () => 'legacy-key')).toBe(false)
  })
})
