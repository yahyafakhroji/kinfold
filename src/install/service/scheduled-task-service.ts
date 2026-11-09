// The Windows logon task. A stub until the scheduled task is written.

import type { InstallEnv } from '../env'
import { StubService } from './stub-service'

export class ScheduledTaskService extends StubService {
  constructor(env: InstallEnv) {
    super(env, 'scheduled task')
  }
}
