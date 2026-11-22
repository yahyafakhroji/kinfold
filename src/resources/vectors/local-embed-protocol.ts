// Messages between the daemon and the local embed worker (local-embed-worker.ts).

import type { EmbedPurpose } from './embed-queue'

export interface ModelPaths {
  model: string
  vocab: string
  wasm: string
}

export type EmbedWorkerRequest =
  | { kind: 'start'; paths: ModelPaths }
  | { kind: 'embed'; id: number; texts: string[]; purpose: EmbedPurpose }
  | { kind: 'cancel'; id: number }

export type EmbedWorkerReply =
  | { kind: 'started'; ok: true; ms: number }
  | { kind: 'started'; ok: false; reason: string }
  | { kind: 'vectors'; id: number; vectors: Float32Array[] }
  | { kind: 'failed'; id: number; reason: string }
