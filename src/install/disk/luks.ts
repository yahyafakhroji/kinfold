// The Linux (WSL included) disk check. A stub until the LUKS probe is written.

import { stubDiskCheck } from './stub-check'

export const luksCheck = stubDiskCheck('LUKS')
