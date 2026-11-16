// The devices paired with this hub. The hub reads this file on every request,
// so `kinfold central remove` takes effect on the next request with no
// restart. A file that does not parse lists nothing: no device is trusted
// from a list that cannot be read.

import { DEVICES_FILE, centralPath, readJsonFile, writePrivateJson } from './paths'

export interface PairedDevice {
  id: string
  name: string
  /** Base64 SPKI DER Ed25519 key. */
  publicKey: string
  /** The Tailscale node it paired from; a request from any other node is refused. */
  nodeId: string
  /** The Tailscale user that owns that node, the hub's own user. */
  userId: string
  pairedAt: number
}

function isDevice(value: unknown): value is PairedDevice {
  if (typeof value !== 'object' || value === null) return false
  const device = value as Record<string, unknown>
  return ['id', 'name', 'publicKey', 'nodeId', 'userId'].every((key) => typeof device[key] === 'string') && typeof device.pairedAt === 'number'
}

export function listDevices(dataDir: string): PairedDevice[] {
  const value = readJsonFile(centralPath(dataDir, DEVICES_FILE))
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { devices?: unknown }).devices)) return []
  const devices = (value as { devices: unknown[] }).devices
  return devices.every(isDevice) ? devices.map(({ id, name, publicKey, nodeId, userId, pairedAt }) => ({ id, name, publicKey, nodeId, userId, pairedAt })) : []
}

function save(dataDir: string, devices: readonly PairedDevice[]): void {
  writePrivateJson(dataDir, DEVICES_FILE, { devices })
}

export function findDevice(dataDir: string, id: string): PairedDevice | null {
  return listDevices(dataDir).find((device) => device.id === id) ?? null
}

/** Adds the device; one already paired under that id is replaced. */
export function addDevice(dataDir: string, device: PairedDevice): void {
  save(dataDir, [...listDevices(dataDir).filter((each) => each.id !== device.id), device])
}

/** Removes the device named by id, or else by name; returns it, or null when none matched. */
export function removeDevice(dataDir: string, idOrName: string): PairedDevice | null {
  const devices = listDevices(dataDir)
  const target = devices.find((device) => device.id === idOrName) ?? devices.find((device) => device.name === idOrName)
  if (target === undefined) return null
  save(dataDir, devices.filter((device) => device !== target))
  return target
}
