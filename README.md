# Pi Config Sync

`pi-config-sync` will synchronize Pi configuration between **THIS MACHINE** and a **SHARED REPOSITORY**.

## Current command

The package registers `/config-sync`. Work Unit 01 does not permit PUBLISH or APPLY operations. The command makes no configuration change.

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
