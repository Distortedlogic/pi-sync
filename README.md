# Pi Config Sync

`pi-config-sync` will synchronize Pi configuration between **THIS MACHINE** and a **SHARED REPOSITORY**.

## Current command

The package registers `/config-sync`. Work Unit 03 does not permit PUBLISH or APPLY operations. The command makes no configuration change.

## Data location

Configuration sync data is stored under `$PI_CODING_AGENT_DIR/.config-sync/`. Configuration, state, journal, plans, candidates, and backups stay outside the SHARED REPOSITORY working tree.

The default managed scope includes Pi settings, keybindings, instructions, extensions, skills, prompts, and themes. It excludes `models.json`. Permanent deny rules exclude credentials, environment files, sessions, installed package data, Git data, and configuration sync state.

File inventory rejects symlinks, special files, nested repositories, unsafe paths, path collisions, unreadable managed files, and configured size-limit failures. It hashes exact bytes. It also keeps exact `settings.json` bytes while it uses stable JSON for comparison.

## Runtime dependency decisions

All runtime dependency versions are exact pins.

| Need | Package | Decision |
|---|---|---|
| Glob matching | `minimatch` | Use the package already selected by Pi. |
| Stable JSON | `json-stable-stringify` | Produce deterministic JSON text without a custom serializer. |
| Atomic writes | `write-file-atomic` | Replace regular files without a custom write protocol. |
| File locking | `proper-lockfile` | Coordinate processes without a custom lock protocol. |
| Text and JSON differences | `diff` | Produce both text and structured JSON differences with one package. |
| Secret scanning | `secretlint` and `@secretlint/secretlint-rule-preset-recommend` | Use Secretlint with its maintained recommended rule set. |

Pi packages and `typebox` are peer dependencies. Node APIs provide temporary directories, file access, hashing, and process execution where later work units require them.
