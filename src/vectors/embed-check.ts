// `kinfold embed-check`: proves the program can load its bundled model in a
// worker and make sensible vectors, with no store and no network. The release
// smoke runs it on every target. Fixed texts only, so nothing private is read.

import { type LocalEmbedder, type ModelPathsAnswer, localModelPaths, startLocalEmbedder } from './local-embedder'
import type { ModelPaths } from './local-embed-protocol'

const TEXTS = ['Kinfold keeps memory on this machine.', 'The memory stays local to this computer.', 'Two eggs and a cup of flour make the batter.']

export interface EmbedCheckDeps {
  paths?: () => ModelPathsAnswer
  start?: (options: { paths: ModelPaths }) => Promise<{ ok: true; embedder: LocalEmbedder; ms: number } | { ok: false; reason: string }>
  print?: (line: string) => void
}

const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, value, i) => sum + value * b[i]!, 0)

export async function runEmbedCheck(deps: EmbedCheckDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line))
  const paths = (deps.paths ?? localModelPaths)()
  if (!paths.ok) {
    print(`embed-check failed: ${paths.reason}`)
    return 1
  }
  const started = await (deps.start ?? startLocalEmbedder)({ paths: paths.paths })
  if (!started.ok) {
    print(`embed-check failed: ${started.reason}`)
    return 1
  }
  const { embedder } = started
  try {
    const before = performance.now()
    const [a, b, c] = await embedder.embed(TEXTS)
    const embedMs = Math.round(performance.now() - before)
    if (a === undefined || b === undefined || c === undefined || a.length !== embedder.dims) {
      print('embed-check failed: the model answered the wrong number or length of vectors')
      return 1
    }
    const related = dot(a, b)
    const unrelated = dot(a, c)
    if (!(related > unrelated)) {
      print(`embed-check failed: the related pair scored ${related.toFixed(3)}, not above ${unrelated.toFixed(3)}`)
      return 1
    }
    print(`embed-check ok model=${embedder.model} dims=${embedder.dims} load_ms=${started.ms} embed_ms=${embedMs} related=${related.toFixed(3)} unrelated=${unrelated.toFixed(3)}`)
    return 0
  } catch (error: unknown) {
    print(`embed-check failed: ${error instanceof Error ? error.message : 'the embed failed'}`)
    return 1
  } finally {
    await embedder.close()
  }
}
