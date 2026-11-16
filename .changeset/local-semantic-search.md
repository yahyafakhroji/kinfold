---
"kinfold": minor
---

Semantic search runs on a bundled local model by default: all-MiniLM-L6-v2 on your CPU, free, offline, with no memory text leaving the machine. OpenRouter and a local LLM server on loopback (Ollama, LM Studio) are opt-in, picked in the wizard, with `--embeddings`, or on the dashboard's Models page. Search goes through a per-project sqlite-vec index, and switching embedders builds the new index in the background while search keeps the old one. A store that already has OpenRouter vectors stays on OpenRouter until you switch. The program is about 36 MB larger.
