# Changesets

Every pull request that changes what users get (src/, scripts/, tools/, npm/ or packaging) adds one file here. Write it with:

```sh
bunx changeset          # pick patch, minor or major, then write the changelog line
bunx changeset --empty  # a docs or tests change with no release note
```

The file names the bump and holds one line for CHANGELOG.md:

```md
---
"kinfold": minor
---

`kinfold size` breaks the store down by part.
```

- patch: a fix, no new behaviour.
- minor: a new feature or setting.
- major: a breaking change once Kinfold is 1.0.

Start the summary with `BREAKING:` for any change a script or user could notice: a renamed flag, a changed output line, a moved file, a refused input that used to work. This holds in 0.x as well as for majors. CHANGELOG.md keeps the prefix, and the update check lists those lines first.

Merging to main opens or updates the Version PR. Merging the Version PR tags the release, and release.yml builds, smoke-tests and publishes it. Betas come from the `beta` branch in pre mode (`bunx changeset pre enter beta` there); main never enters pre mode.
