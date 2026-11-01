// What the edge pipeline treats as secret. Bump RULES_VERSION whenever a rule
// changes, so the leak scanner knows to re-check rows stored under older rules.

export const RULES_VERSION = 2

export type EntropyMode = 'keyed' | 'strict'

// ---- Paths whose contents are never captured -------------------------------

const ENV_FILE = /^\.env(\..+)?$/
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/
const SENSITIVE_PATHS: readonly RegExp[] = [
  /\.(pem|key|p12|pfx|jks|keystore|tfvars)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(npmrc|netrc|pypirc|pgpass|git-credentials)$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
]

export function isSensitivePath(path: string, extra: readonly RegExp[] = []): boolean {
  const normalized = path.replace(/\\/g, '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) return true
  return [...SENSITIVE_PATHS, ...extra].some((pattern) => pattern.test(normalized))
}

// ---- Commands whose output is never captured -------------------------------

/**
 * Decide whether a shell command's output must be withheld from memory.
 *
 * Called for every Bash-like tool call, with the raw command string, before
 * the output is redacted. Returning true replaces the whole output with a
 * metadata marker, so pattern redaction never gets a chance to miss anything.
 *
 * Inputs look like: `printenv`, `env | grep AWS`, `cat .env`, `cat .env.example`,
 * `gh auth token`, `kubectl get secret db -o yaml`, `echo $PATH`, `git log`.
 *
 * Trade-off: every command you match loses its output from memory entirely,
 * including the useful parts. Every command you miss falls back to pattern
 * redaction, which only catches secrets in formats it knows.
 */
export function isSensitiveCommand(command: string): boolean {
  return command.split(SEGMENT_SEPARATOR).some(isSensitiveSegment)
}

const SEGMENT_SEPARATOR = /\|\||&&|[|;\n]/
/** Prefixes that run the next word as the command. RTK is how Claude Code's rtk hook rewrites `cat` and `grep`. */
const PASSTHROUGH_WRAPPERS = new Set(['rtk', 'sudo', 'command', 'exec', 'time', 'nohup', 'xargs'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** `.key` and `.pem` alone are jq filters or globs far more often than file names. */
const BARE_EXTENSION = /^\.(pem|key|p12|pfx|jks|keystore|tfvars)$/i
const SECRET_VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g

/** Matched in order from the command word on; flags may sit between the parts. */
const CREDENTIAL_COMMANDS: readonly (readonly string[])[] = [
  ['gh', 'auth', 'token'],
  ['aws', 'configure', 'get'],
  ['aws', 'configure', 'export-credentials'],
  ['aws', 'sts', 'get-session-token'],
  ['kubectl', 'get', 'secret'],
  ['kubectl', 'get', 'secrets'],
  ['kubectl', 'describe', 'secret'],
  ['gcloud', 'auth', 'print-access-token'],
  ['gcloud', 'auth', 'print-identity-token'],
  ['vault', 'read'],
  ['vault', 'kv', 'get'],
  ['op', 'read'],
  ['op', 'item', 'get'],
  ['heroku', 'auth:token'],
  ['security', 'find-generic-password'],
  ['security', 'find-internet-password'],
]

function wordsOf(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[<>]+/, '').replace(/^\$\(|^`/, '').replace(/[)`]+$/, '').replace(/^['"]|['"]$/g, ''))
    .filter((word) => word !== '')
}

function withoutWrappers(words: string[]): string[] {
  let start = 0
  while (start < words.length && (ASSIGNMENT.test(words[start]!) || PASSTHROUGH_WRAPPERS.has(words[start]!))) start++
  return words.slice(start)
}

function hasInOrder(words: readonly string[], parts: readonly string[]): boolean {
  if (words[0] !== parts[0]) return false
  let next = 1
  for (const word of words.slice(1)) if (word === parts[next]) next++
  return next === parts.length
}

function isEnvDump(head: string, args: readonly string[]): boolean {
  const operands = args.filter((arg) => !arg.startsWith('-'))
  switch (head) {
    case 'printenv':
      return operands.length === 0 || operands.some((name) => SECRET_KEY_NAME.test(name))
    case 'export':
    case 'declare':
    case 'typeset':
      return operands.length === 0
    case 'set':
      return args.length === 0
    default:
      return false
  }
}

function isSensitiveSegment(segment: string): boolean {
  const words = wordsOf(segment)
  if (words.some((word) => !word.startsWith('-') && !BARE_EXTENSION.test(word) && isSensitivePath(word))) return true

  const command = withoutWrappers(words)
  const [head, ...args] = command
  if (head === undefined) return false
  if (head === 'env') {
    // `env` alone dumps the environment; `env FOO=1 bun test` just runs bun.
    const rest = args.filter((arg) => !arg.startsWith('-') && !ASSIGNMENT.test(arg))
    return rest.length === 0 || isSensitiveSegment(rest.join(' '))
  }
  if (isEnvDump(head, args)) return true
  if (CREDENTIAL_COMMANDS.some((parts) => hasInOrder(command, parts))) return true
  return [...segment.matchAll(SECRET_VARIABLE)].some((match) => SECRET_KEY_NAME.test(match[1]!))
}

// ---- Secrets in known formats: the whole match is the secret ---------------

export interface FormatRule {
  readonly name: string
  readonly pattern: RegExp
}

export const FORMAT_RULES: readonly FormatRule[] = [
  { name: 'pem_private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openrouter_key', pattern: /\bsk-or-(?:v1-)?[A-Za-z0-9]{32,}/g },
  { name: 'openai_key', pattern: /\bsk-(?!ant-|or-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Runs after the full-format rules, so what it finds is a fragment: a model
  // quoting `sk-or-v1-` plus the first few characters of a real key (seen live).
  // A bare prefix or a placeholder such as `sk-ant-...` has no key characters and stays.
  { name: 'key_fragment', pattern: /\b(?:sk-or-v1-|sk-or-(?!v1-)|sk-ant-|sk-proj-|github_pat_|gh[pousr]_|xox[abposr]-)[A-Za-z0-9_-]+/g },
]

// ---- Secrets after a prefix: group 1 is kept, group 2 is the secret --------

const KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)s?[A-Za-z0-9_.-]*|[A-Za-z0-9_]+_pwd`

/** A key name that suggests its value is a secret. */
export const SECRET_KEY_NAME = new RegExp(String.raw`(?:^|[^A-Za-z0-9])(?:${KEY_NAME})(?:$|[^A-Za-z0-9])|^(?:${KEY_NAME})$`, 'i')

export const PREFIXED_RULES: readonly FormatRule[] = [
  { name: 'url_credentials', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi },
  { name: 'bearer_token', pattern: /(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{16,})/g },
  {
    name: 'keyed_value',
    pattern: new RegExp(String.raw`(\b(?:${KEY_NAME})\b\s*["']?\s*[:=]\s*["']?)([^\s"'\x60,;{}<>]+)`, 'gi'),
  },
]

/** Filters keyed values that are config, not secrets: `max_tokens=4096`, `token: true`, `$TOKEN`. */
export function looksLikeSecretValue(value: string): boolean {
  return value.length >= 6
    && /[A-Za-z]/.test(value)
    && !/^(true|false|null|none|undefined)$/i.test(value)
    && !value.startsWith('$')
    && !value.startsWith('{{')
    && !value.startsWith('<redacted')
}

// ---- Unnamed random strings ------------------------------------------------

export const ENTROPY_TOKEN = /[A-Za-z0-9_+=-]{24,}/g
const ENTROPY_THRESHOLD_BITS = 4.0
const MIN_STRICT_HEX_LENGTH = 32

export function shannonEntropy(text: string): number {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** Hex strings (commit hashes, checksums) only count in strict mode. */
export function looksRandom(token: string, mode: EntropyMode): boolean {
  if (/^[0-9a-f]+$/i.test(token)) return mode === 'strict' && token.length >= MIN_STRICT_HEX_LENGTH
  return /[A-Za-z]/.test(token) && /[0-9]/.test(token) && shannonEntropy(token) >= ENTROPY_THRESHOLD_BITS
}
