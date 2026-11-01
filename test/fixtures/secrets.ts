// Fake secrets in every format the redaction rules claim to cover. Each value
// is assembled at runtime so this file never holds a literal that a secret
// scanner (or GitHub push protection) would flag. None of them are real.

export const FAKE_SECRETS = {
  anthropic: 'sk-ant-' + 'api03-' + 'A1b2C3d4'.repeat(10),
  openrouter: 'sk-or-v1-' + '0a1b2c3d'.repeat(8),
  openai: 'sk-' + 'proj-' + 'Zx9Yw8Vu'.repeat(6),
  aws: 'AKIA' + 'Q2W3E4R5T6Y7U8I9',
  github: 'ghp_' + 'a1B2c3D4e5'.repeat(4),
  slack: 'xoxb-' + '123456789012-' + 'abcdefABCDEF',
  google: 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'.slice(0, 35),
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  pemBody: 'MIIEv' + 'QIBADANBgkqhkiG9w0BAQEFAASC'.repeat(3),
  dbPassword: 'p4ssW0rd-' + 'Prod77',
  envPassword: 'hunter2-' + 'Prod-77',
  bearer: 'abc123DEF456' + 'ghi789JKL0mn',
  unnamedRandom: 'Qm9vT3h2' + 'Zk1xR3p4WnY5' + 'Ty8rL2Vh',
} as const

export const pemBlock = (): string =>
  '-----BEGIN ' + 'PRIVATE KEY-----\n' + FAKE_SECRETS.pemBody + '\n-----END ' + 'PRIVATE KEY-----'

/** A tool output that mixes every format with ordinary text. */
export function leakyOutput(): string {
  return [
    'Loaded config for app',
    `ANTHROPIC_API_KEY=${FAKE_SECRETS.anthropic}`,
    `openrouter key: ${FAKE_SECRETS.openrouter}`,
    `export OPENAI_API_KEY="${FAKE_SECRETS.openai}"`,
    `aws_access_key_id = ${FAKE_SECRETS.aws}`,
    `GITHUB_TOKEN=${FAKE_SECRETS.github}`,
    `slack: ${FAKE_SECRETS.slack}`,
    `maps key ${FAKE_SECRETS.google}`,
    `session=${FAKE_SECRETS.jwt}`,
    pemBlock(),
    `DATABASE_URL=postgres://app:${FAKE_SECRETS.dbPassword}@db.internal:5432/app`,
    `DATABASE_PASSWORD=${FAKE_SECRETS.envPassword}`,
    `Authorization: Bearer ${FAKE_SECRETS.bearer}`,
    'max_tokens=4096',
    'commit 3f9c2a7b1d4e5f60718293a4b5c6d7e8f9012345',
  ].join('\n')
}

export const ALL_SECRET_VALUES: readonly string[] = [
  FAKE_SECRETS.anthropic,
  FAKE_SECRETS.openrouter,
  FAKE_SECRETS.openai,
  FAKE_SECRETS.aws,
  FAKE_SECRETS.github,
  FAKE_SECRETS.slack,
  FAKE_SECRETS.google,
  FAKE_SECRETS.jwt,
  FAKE_SECRETS.pemBody,
  FAKE_SECRETS.dbPassword,
  FAKE_SECRETS.envPassword,
  FAKE_SECRETS.bearer,
]
