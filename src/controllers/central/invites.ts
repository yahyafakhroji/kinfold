// The one invite the hub has out at a time. Only a salt and the scrypt
// verifier are kept, never the code; the invite is gone once used, once ten
// minutes pass, or after five wrong tries. A new invite replaces the old one,
// so there is never more than one code that can pair a device.

import { newInviteCode, newSalt, verifierFor } from './code'
import { INVITES_FILE, centralPath, readJsonFile, removeCentralFile, writePrivateJson } from './paths'

export const INVITE_LIFE_MS = 10 * 60_000
export const INVITE_TRIES = 5

interface Invite {
  salt: string
  verifier: string
  expiresAt: number
  triesLeft: number
}

export type RedeemResult = { ok: true } | { ok: false; reason: 'no-invite' | 'expired' | 'wrong-code' | 'void' }

/** Makes a new invite and returns its code: the only time the code exists outside the user's hands. */
export function createInvite(dataDir: string, now: number): string {
  const code = newInviteCode()
  const salt = newSalt()
  const invite: Invite = { salt, verifier: verifierFor(code, salt), expiresAt: now + INVITE_LIFE_MS, triesLeft: INVITE_TRIES }
  writePrivateJson(dataDir, INVITES_FILE, invite)
  return code
}

function readInvite(dataDir: string): Invite | null {
  const value = readJsonFile(centralPath(dataDir, INVITES_FILE))
  if (typeof value !== 'object' || value === null) return null
  const { salt, verifier, expiresAt, triesLeft } = value as Record<string, unknown>
  if (typeof salt !== 'string' || typeof verifier !== 'string' || typeof expiresAt !== 'number' || typeof triesLeft !== 'number') return null
  return { salt, verifier, expiresAt, triesLeft }
}

/** Whether there is an invite out now, until when, and its salt (public: the device needs it to make its proof). */
export function pendingInvite(dataDir: string, now: number): { expiresAt: number; salt: string } | null {
  const invite = readInvite(dataDir)
  return invite === null || invite.expiresAt < now || invite.triesLeft <= 0 ? null : { expiresAt: invite.expiresAt, salt: invite.salt }
}

export function cancelInvite(dataDir: string): void {
  removeCentralFile(dataDir, INVITES_FILE)
}

/**
 * Asks `proves` whether the device's proof was made with this invite's code;
 * a yes uses the invite up, a no counts a try. The check gets the verifier
 * and salt, never a code.
 */
export function redeemInvite(dataDir: string, now: number, proves: (verifier: string, salt: string) => boolean): RedeemResult {
  const invite = readInvite(dataDir)
  if (invite === null || invite.triesLeft <= 0) return { ok: false, reason: 'no-invite' }
  if (invite.expiresAt < now) {
    cancelInvite(dataDir)
    return { ok: false, reason: 'expired' }
  }
  if (proves(invite.verifier, invite.salt)) {
    cancelInvite(dataDir)
    return { ok: true }
  }
  const triesLeft = invite.triesLeft - 1
  if (triesLeft <= 0) {
    cancelInvite(dataDir)
    return { ok: false, reason: 'void' }
  }
  writePrivateJson(dataDir, INVITES_FILE, { ...invite, triesLeft })
  return { ok: false, reason: 'wrong-code' }
}
