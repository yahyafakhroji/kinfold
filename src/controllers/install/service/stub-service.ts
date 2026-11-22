// The service on a platform whose real one is not written yet: it reports
// nothing configured and nothing running, and refuses to start or stop, so
// install prints the manual-start line and never plans a step through it.

import { notSupportedYet } from '../../platform/platform'
import type { InstallEnv } from '../env'
import type { ServiceControl, ServiceStep } from './control'

export const NOT_SET_UP_REASON = 'not set up on this platform yet'

export class StubService implements ServiceControl {
  constructor(
    protected readonly env: InstallEnv,
    readonly label: string,
  ) {}

  isConfigured(): boolean {
    return false
  }

  async isRunning(): Promise<boolean> {
    return false
  }

  async start(): Promise<void> {
    throw new Error(notSupportedYet(this.label))
  }

  async stop(): Promise<void> {
    throw new Error(notSupportedYet(this.label))
  }

  configuredDataDir(): string | null {
    return null
  }

  configuredPort(): number | null {
    return null
  }

  async fileHolders(_path: string): Promise<string> {
    return ''
  }

  configPath(): string | null {
    return null
  }

  configContent(_port: number): string | null {
    return null
  }

  describe(_step: ServiceStep): string {
    return notSupportedYet(this.label)
  }

  unavailableReason(): string | null {
    return NOT_SET_UP_REASON
  }
}
