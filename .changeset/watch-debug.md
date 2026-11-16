---
"kinfold": minor
---

`kinfold watch --debug` shows why each recall came out as it did: how long the hook waited and whether the daemon answered in time, the search (keyword or meaning, the embedding model, the prompt's terms), each candidate with its distance and matched terms and why it was sent or left out, the new memory from other sessions, and the tokens sent. At a Claude Code turn end it prints the turn's usage from the transcript beside the tokens Kinfold added, and it shows each observer run and each session-start pack. `--json` prints one JSON object per event. The daemon records the trace only while a debug watch is connected, keeps it in memory only (the last few hundred events, gone after a restart), and the prompt hook makes no extra request for it.
