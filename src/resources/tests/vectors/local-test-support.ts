// Where the tests find the real model files: KINFOLD_TEST_MODEL_DIR (set by
// tools/fetch-model.ts in CI), else .cache/embed-model when a developer has
// fetched it. Null skips the tests that need the model; nothing is downloaded.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_MODEL_FILES } from '../../vectors/local-model'

export function testModelDir(): string | null {
  const dir = process.env.KINFOLD_TEST_MODEL_DIR ?? join(import.meta.dir, '..', '..', '..', '..', '.cache', 'embed-model')
  return Object.values(LOCAL_MODEL_FILES).every((file) => existsSync(join(dir, file.name))) ? dir : null
}
