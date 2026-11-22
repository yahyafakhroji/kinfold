// What the edge pipeline treats as secret. Bump RULES_VERSION whenever a rule
// changes, so the leak scanner knows to re-check rows stored under older rules.

export const RULES_VERSION = 3

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

function namesSensitivePath(segment: string): boolean {
  return wordsOf(segment).some((word) => !word.startsWith('-') && !BARE_EXTENSION.test(word) && isSensitivePath(word))
}

/**
 * Whether a command names a sensitive file. Such a command may be writing the
 * file (`echo KEY=... >> .env`, a heredoc), so its own text can hold the secret.
 */
export function commandNamesSensitivePath(command: string): boolean {
  return command.split(SEGMENT_SEPARATOR).some(namesSensitivePath)
}

function isSensitiveSegment(segment: string): boolean {
  const words = wordsOf(segment)
  if (namesSensitivePath(segment)) return true

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

/** A line break inside a key: a real one, or the backslash-n a JSON string holds. */
const PEM_BREAK = String.raw`(?:\r?\n|(?:\\r)?\\n)`
/** The line number a file reader puts before each line: `     2<tab>` or `2→`. */
const LINE_NUMBER = String.raw`(?:[ \t]*\d+(?:\t|→))?`
/**
 * A whole key block, or one cut off before its END line (a Read with a limit,
 * `head`, part of an Edit): then every following line that is only base64,
 * and nothing after them. A passphrase-protected key has `Proc-Type:` and
 * `DEK-Info:` lines and a blank one before its body, which are taken with it.
 * The header alone, as prose mentions it, is no key.
 */
const PEM_HEADERS = String.raw`(?:${PEM_BREAK}${LINE_NUMBER}[ \t]*[A-Za-z-]{1,32}: [^\r\n\\"]{0,200}){1,4}(?:${PEM_BREAK}${LINE_NUMBER}[ \t]*)?`
const PEM_PRIVATE_KEY = new RegExp(
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:${PEM_HEADERS})?(?:${PEM_BREAK}${LINE_NUMBER}[ \t]*[A-Za-z0-9+/=]+[ \t]*(?=${PEM_BREAK}|"|$))+)`,
  'g',
)

export const FORMAT_RULES: readonly FormatRule[] = [
  { name: 'pem_private_key', pattern: PEM_PRIVATE_KEY },
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

// A key name is a run of [A-Za-z0-9_.-] holding one of these words, or a word ending in _pwd.
// Both patterns below start at the word, not at the start of the run: a pattern that first
// ate the run and then backed up looking for the word did so again from every position in
// it, which on a long dotted or base64url run took seconds to minutes (the capture hook was
// killed and the event lost). The rest of the name after the word is capped at
// KEY_NAME_TAIL_CHARS for the same reason; no real key name comes near it.
const KEY_WORD = String.raw`password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential`
const KEY_NAME_TAIL_CHARS = 256

/** A key name that suggests its value is a secret: the word anywhere in the text, or a name ending in _pwd. */
export const SECRET_KEY_NAME = new RegExp(String.raw`${KEY_WORD}|[A-Za-z0-9_]_pwd(?![A-Za-z0-9])`, 'i')

export const PREFIXED_RULES: readonly FormatRule[] = [
  // Starts at `://` and looks back for the scheme, for the reason above: eating a dotted run first and then looking for `://` was quadratic.
  { name: 'url_credentials', pattern: /((?<=\b[a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi },
  { name: 'bearer_token', pattern: /(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{16,})/g },
  {
    name: 'keyed_value',
    // Group 1 starts at the word; the part of the name before it is left in place either way, since group 1 is kept.
    pattern: new RegExp(String.raw`((?:(?:${KEY_WORD})s?[A-Za-z0-9_.-]{0,${KEY_NAME_TAIL_CHARS}}|(?<=[A-Za-z0-9_])_pwd)\b\s*(?:["']\s*)?[:=]\s*["']?)([^\s"'\x60,;{}<>]+)`, 'gi'),
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
