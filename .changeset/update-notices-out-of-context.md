---
"kinfold": minor
---

BREAKING: Update notices no longer go into an agent's model context. Agents with a user line (Claude Code, Codex, Gemini CLI and others) still show them, OpenCode and Kilo Code show them as a toast, and Copilot CLI on its progress line. Cursor, Cline, Kiro, Antigravity and the other agents with no user line leave them to `kinfold status`, the dashboard and `kinfold watch`, which now prints the notice once.
