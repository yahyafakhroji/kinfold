// The order the local embed worker works in. One text at a time, and a query
// first: an indexing batch of 32 texts takes seconds on the CPU, and a search
// waiting behind it would miss its deadline. Between texts the queue yields to
// the event loop, so a query or a cancel posted meanwhile is seen.

export type EmbedPurpose = 'query' | 'index'

export interface EmbedJob extends Promise<Float32Array[]> {
  id: number
}

export interface EmbedQueue {
  submit(texts: readonly string[], purpose: EmbedPurpose, id?: number): EmbedJob
  cancel(id: number): void
}

interface Entry {
  id: number
  texts: readonly string[]
  done: Float32Array[]
  resolve: (vectors: Float32Array[]) => void
  reject: (error: Error) => void
}

export function createEmbedQueue(inference: { embed(text: string): Promise<Float32Array> }): EmbedQueue {
  const queries: Entry[] = []
  const indexing: Entry[] = []
  let nextId = 1
  let running = false

  const remove = (entry: Entry): void => {
    for (const list of [queries, indexing]) {
      const at = list.indexOf(entry)
      if (at >= 0) list.splice(at, 1)
    }
  }

  const drain = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (;;) {
        const entry = queries[0] ?? indexing[0]
        if (entry === undefined) return
        try {
          entry.done.push(await inference.embed(entry.texts[entry.done.length]!))
        } catch (error: unknown) {
          remove(entry)
          entry.reject(error instanceof Error ? error : new Error('the embed failed'))
          continue
        }
        if (entry.done.length === entry.texts.length) {
          remove(entry)
          entry.resolve(entry.done)
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      running = false
    }
  }

  return {
    submit: (texts, purpose, id) => {
      const jobId = id ?? nextId++
      let entry: Entry | undefined
      const promise = new Promise<Float32Array[]>((resolve, reject) => {
        entry = { id: jobId, texts, done: [], resolve, reject }
      }) as EmbedJob
      promise.id = jobId
      if (texts.length === 0) entry!.resolve([])
      else {
        ;(purpose === 'query' ? queries : indexing).push(entry!)
        void drain()
      }
      return promise
    },
    cancel: (id) => {
      const entry = [...queries, ...indexing].find((candidate) => candidate.id === id)
      if (entry === undefined) return
      remove(entry)
      entry.reject(new Error('cancelled'))
    },
  }
}
