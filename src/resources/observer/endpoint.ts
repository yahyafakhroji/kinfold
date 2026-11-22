// The base URL of an endpoint provider. The OpenAI-compatible observer takes
// https anywhere, or plain http only on this machine (Ollama, LM Studio), so
// session text never crosses a network in the clear. Qwen takes only an https
// DashScope host or a Model Studio workspace host, since a DashScope key is
// bound to its region's URL; other aliyuncs.com hosts belong to customers
// (OSS buckets, Function Compute). A URL
// that carries a user name, a password, a query or a fragment is refused: a
// key belongs in the key store, never in a setting. Errors never quote the
// URL.

import type { Parsed } from '../context/types'
import type { EndpointProvider } from './types'

export const DASHSCOPE_DEFAULT_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const MAX_ENDPOINT_CHARS = 500

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]'])
/** dashscope.aliyuncs.com, dashscope-intl…, cn-hongkong.dashscope… */
const DASHSCOPE_HOST = /^(?:[a-z0-9-]+\.)?dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com$/
/** {WorkspaceId}.{region}.maas.aliyuncs.com, the workspace addresses Model Studio moved to. */
const WORKSPACE_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/

const NOT_A_URL = 'the endpoint must be an http or https URL'
const NOT_HTTPS = 'the endpoint must use https unless it is on this machine (127.0.0.1, ::1 or localhost)'
const NOT_DASHSCOPE = 'the Qwen endpoint must be an https DashScope or Model Studio URL'

function parseUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

export function isLoopbackEndpoint(text: string): boolean {
  const url = parseUrl(text)
  return url !== null && isLoopbackHost(url.hostname)
}

/** The trimmed URL without a trailing slash, or the rule it breaks. */
export function checkEndpoint(provider: EndpointProvider, raw: string): Parsed<string> {
  const text = raw.trim()
  if (text.length > MAX_ENDPOINT_CHARS) return { ok: false, error: `the endpoint must be at most ${MAX_ENDPOINT_CHARS} characters` }
  const url = parseUrl(text)
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return { ok: false, error: NOT_A_URL }
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'the endpoint must not carry a user name or password' }
  if (url.search !== '' || url.hash !== '' || text.includes('?') || text.includes('#')) return { ok: false, error: 'the endpoint must not carry a query or a fragment' }
  if (provider === 'qwen-api') {
    if (url.protocol !== 'https:' || !(DASHSCOPE_HOST.test(url.hostname) || WORKSPACE_HOST.test(url.hostname))) return { ok: false, error: NOT_DASHSCOPE }
  } else if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: NOT_HTTPS }
  }
  return { ok: true, value: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}
