---
"kinfold": patch
---

A dashboard session now survives a daemon restart, so pressing Install on the dashboard no longer ends at the sign-in page. Sessions are kept in `dashboard-sessions.json` in the data folder (mode 0600, holding only hashes of the session secrets), keep their 12-hour expiry and sign-out, and are removed on uninstall. With the beta channel on, a newer beta no longer holds back the automatic patch of the running release: the daily check keeps the newest patch of the running version beside the release on offer, installs the patch under `patch`, and still waits for a yes on the beta.
