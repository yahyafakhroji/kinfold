---
"kinfold": minor
---

Updates have three levels, `off`, `notify` and `patch` (the default), set with the wizard, `kinfold install --updates <level>` or the dashboard. At `patch`, a minor or major release is downloaded and checked against `SHA256SUMS` in the background, then offered once at session start (`Kinfold 0.6.0 is ready · 3 changes, 1 breaking · kinfold update to install`) and on the dashboard with its changelog lines and an Install button. Nothing bigger than a patch installs without your yes. `--beta` offers prereleases the same way. Existing installs keep their choice: update check off is `off`, auto-update off is `notify`, anything else is `patch`.
