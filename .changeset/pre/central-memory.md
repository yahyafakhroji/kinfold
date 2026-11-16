---
"kinfold": minor
---

One memory for all your devices over Tailscale. `kinfold central serve` makes a machine the hub, and `kinfold central join <hub> <code>` points a device at it: the device's agents then capture into and recall from the hub's memory. Joining copies in the projects the hub lacks and leaves the device's own memory as it was. Only nodes of the hub's own Tailscale user can pair; each device signs every request with its own key, can read and capture, and leaves purge, retention, backup, restore, encryption and observer settings to the hub. Captures wait on the device while the hub is away. `kinfold central devices`, `remove`, `invite`, `leave` and `import --project` manage it, and `kinfold status` and the dashboard show the mode.
