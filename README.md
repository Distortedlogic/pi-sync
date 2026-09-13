# Pi Config Sync

`pi-config-sync` will synchronize Pi configuration between **THIS MACHINE** and a **SHARED REPOSITORY**.

## Current command

The package registers `/config-sync`. Work Unit 09 can apply confirmed file actions to THIS MACHINE after it creates and verifies a recovery backup. It does not execute package actions.

## Data location

Configuration sync data is stored under `$PI_CODING_AGENT_DIR/.config-sync/`. Configuration, state, journal, plans, candidates, and backups stay outside the SHARED REPOSITORY working tree.

The default managed scope includes Pi settings, keybindings, instructions, extensions, skills, prompts, and themes. It excludes `models.json`. Permanent deny rules exclude credentials, environment files, sessions, installed package data, Git data, and configuration sync state.

File inventory rejects symlinks, special files, nested repositories, unsafe paths, path collisions, unreadable managed files, and configured size-limit failures. It hashes exact bytes. It also keeps exact `settings.json` bytes while it uses stable JSON for comparison.

The pure three-way planner classifies machine, shared, and baseline values. It produces fixed-direction actions, blocks modes that require the opposite direction, sorts actions by risk and path, and computes exact final trees without file, Git, network, UI, or time access.

Git work uses a dedicated extension-owned worktree and `pi.exec()` argument arrays. Planning fetches and names the exact SHARED REPOSITORY commit. Candidate commits keep that commit as their only parent. PUBLISH fetches again and returns `PLAN EXPIRED` if SHARED REPOSITORY changed. Diff operations use the last named snapshot and access the network only through an explicit refresh request.

Settings plans use stable JSON and identify changes by JSON Pointer. Machine-only settings and approved machine-only package declarations survive APPLY. Package install, update, and removal actions are separate code-execution actions. Every action requires a complete decision for its exact source.

Final plans have full and short SHA-256 IDs, fixed review sections, exact destinations, final trees, decisions, and explicit effects that will not happen. Display text is outside the security fingerprint. TUI and RPC reviews collect decisions before rebuilding the final plan. Execution authorization requires the exact full plan ID. JSON and print modes return the plan without authorization.

Candidate validation checks every managed staged file, all managed JSON, conflict markers, permanent denies, shared package policy, machine-only preservation, and exact final-tree fingerprints. Secretlint scans the complete managed tree and exact candidate difference with its recommended preset. Scanner failures block PUBLISH. Reports contain only finding type, relative path, and line number.

Machine file application requires an exact plan authorization and a valid baseline for each deletion. A verified backup records every affected prior file and every path that will be created. Writes are atomic. Final hashes are verified. A failure restores the complete backup, or reports exact manual recovery paths. Backup cleanup is a separate best-effort operation and always keeps the newest valid recovery backup.

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
