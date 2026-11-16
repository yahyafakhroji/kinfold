---
"kinfold": patch
---

WSL: every agent's wiring in a linked distro is now tested, with its hooks writing into the Windows memory and its recall line coming from the Windows daemon and its recall toast reading the Windows folder. A new CI job installs the built programs on a Windows runner and runs the Linux build in an Ubuntu WSL2 distro. WSL stays in preview because GitHub's Windows runners refuse mirrored networking, so the hop from the distro to the Windows daemon is checked by fakes only.
