---
"kinfold": patch
---

On Windows, the daemon keeps answering while it drops an old embedding index after you switch embedding models. Vectors upkeep and the indexer now wait while the store is being checkpointed: a write on the daemon's thread waited behind each checkpoint, and on a Windows CI runner it held the thread for 2.4 to 3.7 s.

Also: the daemon waits up to 10 s for its checkpoint worker to close when it stops, so a slow last checkpoint no longer leaves the store file open on Windows.
