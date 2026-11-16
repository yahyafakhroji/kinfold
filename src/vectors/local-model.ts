// The embedding model Kinfold carries, pinned by hash. all-MiniLM-L6-v2 in its
// int8 ONNX form is 23 MB and makes 384-dim sentence vectors on the CPU; it is
// the smallest widely used English sentence model, so the program grows by
// about 36 MB with the runtime. The files come from one Hugging Face revision
// and onnxruntime-web's npm package; a release build checks each against these
// hashes, and the program checks them again before loading, because loading a
// model runs its graph and loading the wasm runs its code.

export const LOCAL_MODEL_ID = 'local/all-MiniLM-L6-v2'
export const LOCAL_MODEL_DIMS = 384
/** sentence-transformers truncates this model at 256 word pieces; longer input costs time and adds nothing it was trained on. */
export const LOCAL_MAX_TOKENS = 256

export const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2'
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9'

export type LocalModelFile = 'model' | 'vocab' | 'wasm'

export interface PinnedFile {
  /** The name in .cache/embed-model and in the program's embedded assets. */
  name: string
  sha256: string
  bytes: number
  /** Where a build fetches it from; the wasm comes from node_modules instead. */
  url?: string
}

const hf = (path: string): string => `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${path}`

export const LOCAL_MODEL_FILES: Readonly<Record<LocalModelFile, PinnedFile>> = {
  model: { name: 'model_quantized.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', bytes: 22_972_370, url: hf('onnx/model_quantized.onnx') },
  vocab: { name: 'vocab.txt', sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3', bytes: 231_508, url: hf('vocab.txt') },
  wasm: { name: 'ort-wasm-simd-threaded.wasm', sha256: 'be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17', bytes: 12_361_745 },
}

/** The added install size a release may not pass: model, vocab, wasm and the runtime's JS together. */
export const MAX_ADDED_BYTES = 60 * 1024 * 1024
