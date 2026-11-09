// The Linux (WSL included) user service. A stub until the systemd unit is written.

import type { InstallEnv } from '../env'
import { StubService } from './stub-service'

export class SystemdUserService extends StubService {
  constructor(env: InstallEnv) {
    super(env, 'systemd user service')
  }
}
