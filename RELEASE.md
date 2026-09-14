# Release Checklist

Do not publish from an automated agent run. Publication requires a separate user instruction that explicitly says to publish this package.

## 1. Dependency and source gate

Run:

```bash
npm ci
npm run release:check
```

Review every `npm audit --omit=dev` finding. Confirm that each runtime dependency has an exact version and is used by source code.

## 2. Package-file gate

Run:

```bash
npm pack --dry-run
```

The archive can contain only:

- `package.json`
- `index.ts`
- `src/**`
- `README.md`
- `RELEASE.md`
- `LICENSE`

Reject the archive if it contains tests, source maps, credentials, `.env`, logs, coverage, plans, candidates, clones, journals, or backups.

## 3. Operating-system gate

Run `npm ci && npm run release:check` on current Linux, macOS, and Windows runners with Node.js 22. Run `npm run test:e2e` on each runner. Keep the executable-bit assertions platform-specific.

## 4. Clean Pi installation gate

Create a temporary Pi agent directory. Install the generated archive with `pi install <archive>`. Run `pi list` and load the extension with Pi offline. Confirm that `/config-sync` and all argument completions are available. Delete the temporary directory after the check.

## 5. Release-candidate synchronization gate

Run `npm run test:e2e`. Then use two disposable Pi agent directories and one disposable bare SHARED REPOSITORY. Complete one PUBLISH and one APPLY. Confirm equal final managed hashes and no remaining process, lock, worktree, or temporary directory.

## 6. Publication approval

Stop after all prior gates pass. Show the package version, archive file list, audit result, and test result to the user. Run `npm publish` only after the user gives a new, explicit publication instruction. A request to prepare, test, pack, or commit is not publication approval.
