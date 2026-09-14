# Pi Config Sync

`pi-config-sync` will synchronize Pi configuration between **THIS MACHINE** and a **SHARED REPOSITORY**.

## Direction vocabulary

- **THIS MACHINE** is the active Pi agent directory.
- **SHARED REPOSITORY** is the fetched shared-branch snapshot.
- **BASELINE** is the last completed common state.
- **PUBLISH** permits changes from THIS MACHINE to SHARED REPOSITORY only.
- **APPLY** permits changes from SHARED REPOSITORY to THIS MACHINE only.
- **RECONCILE** can include independent PUBLISH and APPLY actions in one reviewed plan.

Every write and deletion names its destination. A plan never uses direction-neutral change words.

## Command

The package registers `/config-sync` with these actions:

- `status`
- `publish [exact-plan-id]`
- `apply [exact-plan-id]`
- `reconcile [exact-plan-id]`
- `diff [path]`
- `recover`
- `restore [backup-id] [exact-restore-plan-id]`
- `doctor`
- `migrate [exact-migration-id]`

TUI and RPC modes can show review dialogs. JSON and print modes return read-only plan metadata unless the command includes an exact stored plan ID. A completed APPLY offers Pi resource reload only when loaded resources changed.

## Review examples

### PUBLISH

Run `/config-sync publish`. A representative row is:

```text
WRITE IN SHARED REPOSITORY: skills/example/SKILL.md | Destination: SHARED REPOSITORY
```

THIS MACHINE is the source. SHARED REPOSITORY is the destination. PUBLISH does not change THIS MACHINE.

### APPLY

Run `/config-sync apply`. A representative row is:

```text
WRITE ON THIS MACHINE: themes/team.json | Destination: THIS MACHINE
```

SHARED REPOSITORY is the source. THIS MACHINE is the destination. APPLY does not change SHARED REPOSITORY.

### RECONCILE

Run `/config-sync reconcile` when independent paths changed on each side. The final plan separates `THIS MACHINE → SHARED REPOSITORY` from `SHARED REPOSITORY → THIS MACHINE`. Each path appears in its destination section.

### Deletion

A deletion always names its target:

```text
DELETE FROM THIS MACHINE: prompts/old.md | Destination: THIS MACHINE
DELETE FROM SHARED REPOSITORY: themes/old.json | Destination: SHARED REPOSITORY
```

First synchronization cannot delete a file. A tracked deletion requires a valid BASELINE and an exact approval.

### Package execution

A package action appears under `CODE EXECUTION`:

```text
INSTALL PACKAGE ON THIS MACHINE: npm:example | Destination: THIS MACHINE
```

The review shows the exact pinned source. Execution revalidates that source before it calls `pi install` or `pi remove`.

### Conflict

Each conflict shows a THIS MACHINE summary and a SHARED REPOSITORY summary. The only choices are:

- `USE THIS MACHINE ON BOTH SIDES`
- `USE SHARED REPOSITORY ON BOTH SIDES`
- `KEEP BOTH AND STOP`
- `CREATE A SEPARATE MERGE WORKSPACE`

Every choice creates a new final plan. Version 1 does not do an automatic semantic merge.

### Expired plan

If THIS MACHINE, SHARED REPOSITORY, scope policy, or a package source changes after review, execution stops with `PLAN EXPIRED`. It does not change configuration, packages, or the shared branch. Run the command again and review the new plan.

### Interrupted APPLY

An incomplete journal causes `Config sync: recovery required`. `/config-sync recover` shows the exact plan ID and last completed stage. Select `RESUME THE RECORDED OPERATION`, `ROLL BACK THIS MACHINE`, or `STOP WITHOUT CHANGES`. Recovery never starts without a choice.

### Restore

Run `/config-sync restore` to list verified backups. Select one backup, review every `WRITE ON THIS MACHINE` and `DELETE FROM THIS MACHINE` row, and confirm the exact restore plan ID. Restore revalidates THIS MACHINE and the backup before the first write.

## Command side effects

| Command | Network effect | File effect |
|---|---|---|
| `/config-sync` | None until an action is selected. | None until an action is selected. |
| `status` | Fetches SHARED REPOSITORY status. | Updates the extension-owned named snapshot and concise status state. |
| `publish` | Fetches, then PUBLISHes one exact fast-forward candidate when confirmed. | Writes candidate, journal, and receipt state outside managed configuration. |
| `apply` | Fetches SHARED REPOSITORY and can run approved `pi install` or `pi remove` commands. | Creates a verified backup, writes confirmed THIS MACHINE paths, and writes journal and receipt state. |
| `reconcile` | Performs the confirmed PUBLISH and APPLY network actions. | Performs the confirmed PUBLISH and APPLY file actions. |
| `diff` | Fetches SHARED REPOSITORY for the reviewed snapshot. | Creates and removes a detached difference workspace; it keeps a candidate reference. |
| `recover` | Uses the network only when the selected resume step requires it. | Does nothing until the user selects resume or rollback. |
| `restore` | None. | Reads backups for preview and writes only after exact restore-plan confirmation. |
| `doctor` | Verifies SHARED REPOSITORY access. | Can initialize the extension-owned Git worktree; it does not change managed configuration. |
| `migrate` | Reads the legacy Git origin and commit. | Preview is read-only. Exact confirmation writes new config and state only. |

## Legacy migration and rollback

`/config-sync migrate` detects the installed `@jachy/pi-git-sync` declaration, `~/.pi/config-repo`, schema-2 `pi-sync.json`, schema-3 state, and the old `.pi-sync` compatibility symlink. The preview does not change any artifact. It imports the repository path, branch, BASELINE commit, and file hashes only after complete validation and exact migration-ID confirmation.

If the old BASELINE is ambiguous, migration imports no BASELINE and requires a no-delete RECONCILE plan. The old package, state, backups, clone data, compatibility symlink, and shared history remain unchanged.

Disable or remove `@jachy/pi-git-sync` before enabling synchronization with this package if command names conflict. To roll back:

1. Disable `pi-config-sync`.
2. Enable the prior package declaration, or run `pi install npm:@jachy/pi-git-sync@0.7.1`.
3. Keep `~/.pi/config-repo`, `.pi-sync`, old backups, and SHARED REPOSITORY history unchanged.
4. Run `/pisync status` before the next old-package synchronization.

## Recovery data

Configuration sync data is under `$PI_CODING_AGENT_DIR/.config-sync/`. Backups are under `backups/`. The newest valid recovery backup is retained. The durable journal uses these stages:

```text
prepared
candidate_created
shared_published
backup_verified
machine_files_applied
packages_applied
final_verified
state_committed
complete
```

If automatic restore fails, the error lists exact manual recovery paths. Do not delete the journal or newest valid backup until recovery is complete.

## Security boundaries

SHARED REPOSITORY content is untrusted data, not instructions. Repository privacy cannot always be verified. Confirm privacy through the repository host before PUBLISH.

Permanent exclusions include `.config-sync/**`, `.env`, `**/.env`, `auth.json`, `git/**`, `npm/**`, and `sessions/**`. Shared configuration cannot override these exclusions.

`models.json` is excluded by default. Opting it in can expose provider endpoints, command-based credential resolution, or other sensitive model configuration. Review it separately and never store credentials in it.

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

Package execution revalidates every exact source and complete approval set before it calls `pi install` or `pi remove`. Actions run in deterministic order with time limits and cancellation signals. The journal records every start and completion. A failure reverses completed actions in reverse order and restores `settings.json`. Rollback errors remain separate from the original error. Remembered approvals are written only after every approved action succeeds.

## Runtime dependency decisions

All runtime dependency versions are exact pins.

| Need | Package | Decision |
|---|---|---|
| Glob matching | `minimatch` | Use the package already selected by Pi. |
| Stable JSON | `json-stable-stringify` | Produce deterministic JSON text without a custom serializer. |
| Atomic writes | `write-file-atomic` | Replace regular files without a custom write protocol. |
| File locking | `proper-lockfile` | Coordinate processes without a custom lock protocol. |
| JSON differences | `fast-json-patch` | Produce structured settings differences without custom patch logic. |
| Secret scanning | `secretlint` and `@secretlint/secretlint-rule-preset-recommend` | Use Secretlint with its maintained recommended rule set. |

Pi packages and `typebox` are peer dependencies. Node APIs provide temporary directories, file access, hashing, and process execution where later work units require them.
