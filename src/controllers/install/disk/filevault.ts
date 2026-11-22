// The macOS disk check: `fdesetup status`, which needs no admin rights.

import type { DiskEncryptionCheck } from './check'

export const FDESETUP = '/usr/bin/fdesetup'

const FDESETUP_TIMEOUT_MS = 5_000

export const fileVaultCheck: DiskEncryptionCheck = {
  name: 'FileVault',
  async check(env) {
    const result = await env.run({ argv: [FDESETUP, 'status'], timeoutMs: FDESETUP_TIMEOUT_MS })
    if (result.exitCode !== 0) return { kind: 'unknown', detail: `could not check (fdesetup exit ${result.exitCode})` }
    if (result.stdout.includes('FileVault is On')) return { kind: 'on' }
    if (result.stdout.includes('FileVault is Off')) return { kind: 'off', advice: 'Turn it on in System Settings > Privacy & Security' }
    return { kind: 'unknown', detail: 'FileVault state unknown' }
  },
}
