// Whether this data folder is a hub, a device using a hub, or neither
// (local, as before). The mode is saved in install.json by the central
// commands only; this module reads it without loading the installer, so the
// daemon and the MCP server can ask cheaply.

import { join } from 'node:path'
import { readJsonFile } from './paths'

export type CentralMode =
  | { role: 'hub'; port: number }
  | {
    role: 'device'
    /** The hub's Tailscale address or MagicDNS name, as the user gave it. */
    hub: string
    port: number
    hubName: string
    /** Every answer from the hub must be signed by this key. */
    hubPublicKey: string
    deviceId: string
    joinedAt: number
  }

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252})$/
const PUBLIC_KEY = /^[A-Za-z0-9+/]{59}=$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/
/** C0 and C1 controls, zero-width and text-direction characters: in a terminal they can hide or reorder what a name says. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
export const MAX_NAME_CHARS = 64

/** A device or hub name as it may be printed or stored: without those characters, bounded. May come back empty. */
export function plainName(name: string): string {
  return name.replace(UNPRINTABLE, '').slice(0, MAX_NAME_CHARS)
}

/** Whether a name a device sends at pairing is one the hub keeps: 1 to 64 characters, none of them unprintable. */
export function isPlainName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NAME_CHARS && plainName(name) === name
}

const isPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65_535

export function parseCentralMode(value: unknown): CentralMode | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const mode = value as Record<string, unknown>
  if (mode.role === 'hub') return isPort(mode.port) ? { role: 'hub', port: mode.port } : null
  if (mode.role !== 'device') return null
  const { hub, port, hubName, hubPublicKey, deviceId, joinedAt } = mode
  if (typeof hub !== 'string' || !HOST.test(hub) || !isPort(port)) return null
  if (typeof hubName !== 'string' || !NAME.test(hubName) || typeof hubPublicKey !== 'string' || !PUBLIC_KEY.test(hubPublicKey)) return null
  if (typeof deviceId !== 'string' || !ID.test(deviceId) || typeof joinedAt !== 'number' || !Number.isFinite(joinedAt)) return null
  // A name saved before names were cleaned is cleaned here, so every line that prints it is safe.
  return { role: 'device', hub, port, hubName: plainName(hubName) || 'the hub', hubPublicKey, deviceId, joinedAt }
}

/** The saved mode; null (local) when there is no install record or its field is missing or does not parse. */
export function centralModeOf(dataDir: string): CentralMode | null {
  const record = readJsonFile(join(dataDir, 'install.json'))
  if (typeof record !== 'object' || record === null) return null
  return parseCentralMode((record as { central?: unknown }).central)
}
