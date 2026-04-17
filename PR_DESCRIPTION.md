# Consistent Hook Enforcement Architecture

## Summary

Redesigns the Diff-Guardian hook layer to fix the VS Code "Sync Changes" dead-end, add merge-time enforcement via `pre-merge-commit`, and establish consistent gatekeeper behavior across all git workflows.

## Problem

Three issues existed in the previous hook architecture:

1. **VS Code blocked entirely** — The `pre-push` hook exits with code 1 when breaking changes are detected. VS Code's Source Control UI has no mechanism to pass `--no-verify`, making the "Sync Changes" button a dead-end when any breaking API change exists.

2. **Merge enforcement was post-hoc** — The `post-merge` hook ran `npx dg` *after* the merge was already complete. Exit code 1 at that point is meaningless — the merge is done, the breaking code is in history. This was architecturally broken as a gatekeeper.

3. **Inconsistent enforcement model** — Push was strict (pre-hook, blocking), but merge was advisory (post-hook, non-blocking). The dangerous action (merging into main) had weaker enforcement than the safe action (pushing to a feature branch).

## Solution

### Enforcement Matrix

| Scenario | Hook | Behavior | Bypass |
|----------|------|----------|--------|
| `git push` (terminal) | `pre-push` | **Strict** — exit 1 blocks | `--no-verify` |
| `git push` (VS Code sync) | `pre-push` | **Advisory** — push goes through, `.dg-report.json` generated | Automatic |
| `git merge` (non-fast-forward) | `pre-merge-commit` | **Strict** — exit 1 blocks merge commit | `--no-verify` |
| `git merge` (fast-forward) | `post-merge` | **Advisory** — report generated, undo command shown | `git reset --hard ORIG_HEAD` |
| Open PR | GitHub Actions | **Advisory** — PR comment posted, merge button green | N/A |

### Key Design Decisions

- **VS Code detection** uses `VSCODE_GIT_ASKPASS_MAIN` — an environment variable injected by VS Code's Git extension into all spawned git processes. This is the most reliable detection method as it's set by VS Code's own code, not the user's shell config.

- **`pre-merge-commit`** (not `pre-merge`) is the correct Git hook — it fires after merge resolution succeeds but before the merge commit is written. `--no-verify` bypasses it natively.

- **Post-merge FF detection** uses parent count (`git log -1 --format='%P' HEAD | wc -w`). Non-FF merge commits have 2+ parents, meaning `pre-merge-commit` already handled enforcement — post-merge skips to avoid duplicate reports.

- **`DG_HOOK` environment variable** is set by each hook script and read by the CLI as `hookContext`. This allows the terminal reporter to show context-appropriate bypass commands without polluting the CLI flag interface.

## Changes

### Hook Scripts

| File | Action | Description |
|------|--------|-------------|
| `.husky/pre-push` | Modified | Added VS Code detection — terminal stays strict, VS Code gets advisory mode + `.dg-report.json` |
| `.husky/pre-merge-commit` | **New** | Blocking gate for `git merge` — compares `HEAD` vs `MERGE_HEAD`, exit 1 blocks |
| `.husky/post-merge` | Modified | Rewritten as FF-only fallback — skips on non-FF, advisory + undo command for FF merges |

### TypeScript

| File | Action | Description |
|------|--------|-------------|
| `src/reporter/types.ts` | Modified | Added `reportFile` and `hookContext` to `ReporterConfig` |
| `src/cli.ts` | Modified | New `--report-file <path>` flag, reads `DG_HOOK` env var, threaded through all command paths |
| `src/pipeline.ts` | Modified | Step 5.5 — writes `AnalysisResult` JSON to `reportFile` after reporter renders |
| `src/reporter/terminal.ts` | Modified | Context-aware strict mode footer: merge context shows `git merge --no-verify` + `git merge --abort`, push context shows `git push --no-verify` |

### Config

| File | Action | Description |
|------|--------|-------------|
| `.gitignore` | Modified | Added `.dg-report.json` (local-only generated artifact) |

## Terminal Reporter Output

### Push Context (unchanged)
```
 [STRICT MODE]
Breaking changes found. Exiting with code 1.

  ► To bypass this strict check, append --no-verify to your git command.
    (e.g., git push --set-upstream origin HEAD --no-verify)
    Document this change in your CHANGELOG before merging.
```

### Merge Context (new)
```
 [STRICT MODE]
Breaking changes found. Exiting with code 1.

  ► To bypass this strict check, append --no-verify to your merge command.
    (e.g., git merge --no-verify <branch>)

  ► To undo this blocked merge, run:
      git merge --abort
    Document this change in your CHANGELOG before merging.
```

### Post-Merge FF Fallback (new)
```
 Diff-Guardian: Fast-forward merge detected — running advisory analysis...

 ⚠️  This was a fast-forward merge. If breaking changes were detected
    and you want to undo this merge, run:

      git reset --hard ORIG_HEAD
```

## Testing

- [x] `tsc` compiles clean — zero errors
- [x] All hook scripts are executable (`chmod +x`)
- [ ] Terminal `git push` still blocks with exit 1 when breaking changes exist
- [ ] VS Code "Sync Changes" pushes successfully + `.dg-report.json` generated
- [ ] `git merge --no-ff feature` blocked when breaking changes detected
- [ ] `git merge --no-verify feature` bypasses enforcement
- [ ] Fast-forward merge generates advisory report + undo command
