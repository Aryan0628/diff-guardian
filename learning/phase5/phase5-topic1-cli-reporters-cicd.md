# Phase 5, Topic 1: CLI, Configuration & Output

This topic covers the **user-facing layer** of Diff-Guardian — how developers interact with it from the terminal, how it posts PR comments on GitHub, and how it integrates into CI/CD pipelines and git hooks.

The code lives in [`src/cli.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/cli.ts) (the CLI), [`src/config.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/config.ts) (configuration), [`src/reporter/`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/) (output renderers), and the GitHub Actions workflow template embedded in the CLI.

---

## 1. The CLI Entry Point

[`src/cli.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/cli.ts) is the single entry point. It starts with a shebang:

```typescript
#!/usr/bin/env node
```

This tells the OS to run it with Node.js when invoked directly. The `package.json` registers two binary names:

```json
"bin": {
  "diff-guardian": "./dist/cli.js",
  "dg": "./dist/cli.js"
}
```

So users can run `npx dg` or `npx diff-guardian` — both invoke the same CLI.

---

## 2. Argument Parsing with `minimist`

The CLI uses [`minimist`](https://www.npmjs.com/package/minimist) for argument parsing — a zero-dependency argument parser:

```typescript
const args = minimist(process.argv.slice(2), {
  boolean: ['help', 'staged'],
  string:  ['report-file'],
  alias:   { h: 'help' },
});
```

**Why `minimist` over `yargs` or `commander`?**

| Library | Bundle size | Dependencies |
|---|---|---|
| `minimist` | 5 KB | 0 |
| `yargs` | 200+ KB | 10+ |
| `commander` | 50 KB | 0 |

Diff-Guardian values minimal dependencies. `minimist` does exactly what's needed: parse `--staged`, `--help`, `--report-file`, and positional arguments. No subcommand framework needed.

### Command routing

```typescript
const command = args._[0];  // "check", "compare", "trace", "rules", "init", or undefined

if (command && !KNOWN_COMMANDS.includes(command)) {
  console.error(`Unknown command: "${command}"`);
  printHelp();
  process.exit(1);
}
```

Unknown commands are caught early with a helpful error message.

---

## 3. The Five Commands

### `npx dg` (Smart Default — no command)

The most common usage. It **auto-detects** whether it's running in CI or locally:

```typescript
async function runSmartDefault(repoRoot, failOnWarnings, reportFile, hookContext) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // ── CI Mode ────────────────────────────────────────
    const baseRef = process.env.GITHUB_BASE_REF;        // e.g., "main"
    const baseSha = baseRef ? `origin/${baseRef}` : getDefaultBranch();
    const headSha = process.env.GITHUB_HEAD_SHA || 'HEAD';
    
    const reporterConfig = {
      format: 'github',         // post PR comment
      githubToken: process.env.GITHUB_TOKEN,
      prNumber: getPrNumber(),  // extracted from GITHUB_REF
      repoSlug: process.env.GITHUB_REPOSITORY,
    };
    
    await runPipeline({ baseSha, headSha, config: reporterConfig });
    return 0;  // Always exit 0 in CI — advisory, never blocks
  } else {
    // ── Local Mode ─────────────────────────────────────
    const baseSha = getDefaultBranch();  // "main" or "master"
    const headSha = 'HEAD';
    
    const reporterConfig = { format: 'terminal' };
    return await runPipeline({ baseSha, headSha, config: reporterConfig });
  }
}
```

**Key design decisions:**

- **CI always exits 0**: The PR comment is advisory. Breaking changes don't block the merge — the team decides. This avoids the problem of "everyone adds `--no-verify` so the tool is useless".
- **`GITHUB_BASE_REF` needs `origin/` prefix**: In GitHub Actions, `GITHUB_BASE_REF` is a bare branch name like `main`. But in the runner's git context, the branch is at `origin/main`. Without the prefix, `git diff` can't find the ref.
- **`GITHUB_HEAD_SHA` vs `GITHUB_SHA`**: `GITHUB_SHA` is a merge commit created by GitHub. `GITHUB_HEAD_SHA` is the actual PR head commit. The head SHA gives more accurate diffs.

### `npx dg check [--staged] [path]`

Analyzes uncommitted changes:

```typescript
async function runCheck(repoRoot, staged, pathFilter, ...) {
  const headRef = staged ? STAGED : WORKING_TREE;
  // STAGED = compares HEAD to index (git add'd files)
  // WORKING_TREE = compares HEAD to working directory
  
  return await runPipeline({
    baseSha: 'HEAD',
    headSha: headRef,
    config: { format: 'terminal', mode: 'strict' },
    pathFilter,
  });
}
```

**`WORKING_TREE` and `STAGED` are sentinel values** — special strings that `git-diff.ts` recognizes to use different git commands:
- `WORKING_TREE` → `git diff HEAD` (uncommitted changes)
- `STAGED` → `git diff --cached HEAD` (staged changes only)

The optional `pathFilter` scopes analysis to a directory: `npx dg check src/payments` only analyzes files under `src/payments/`.

### `npx dg compare <base> [head]`

Compares any two git refs:

```typescript
async function runCompare(baseSha, headSha, repoRoot, ...) {
  return await runPipeline({ baseSha, headSha, config: { format: 'terminal' } });
}
```

Flexible inputs:
```bash
npx dg compare main                    # main vs HEAD
npx dg compare main feature-branch     # main vs feature-branch
npx dg compare v1.0.0 v2.0.0          # between tags
npx dg compare HEAD~3 HEAD            # last 3 commits
```

### `npx dg trace <symbol>`

Shows all importers of a symbol — standalone scanner invocation:

```typescript
async function runTrace(symbolName, repoRoot) {
  const scanner = new JITScanner(createDefaultTracerConfig(repoRoot, 'HEAD'));
  const importers = await scanner.scan(symbolName, '');
  
  // Group by file and print with chalk formatting
  for (const [file, imps] of byFile) {
    console.log(`  ${chalk.cyan(file)}`);
    for (const imp of imps) {
      console.log(`    L${imp.importLine}  ${imp.importedName}  [${imp.importType}]`);
    }
  }
}
```

This is useful for exploring dependencies: "Who uses this function?" without needing a PR.

### `npx dg rules`

Lists all 26 classification rules:

```typescript
function runRules() {
  for (const rule of Object.values(rules)) {
    console.log(`  ${rule.id} - ${rule.name} [Target: ${rule.target}]`);
    console.log(`    ${rule.description}`);
  }
}
```

### `npx dg init`

Scaffolds two files:

1. `.github/workflows/diff-guardian.yml` — GitHub Actions workflow
2. `dg.config.json` — default configuration

Both skip creation if the file already exists (idempotent).

---

## 4. The Configuration System

[`src/config.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/config.ts) defines the config schema:

```typescript
interface DgConfig {
  baseBranch?:      string;     // default: "main"
  failOnWarnings?:  boolean;    // default: false
  enableTracer?:    boolean;    // default: true
  maxGrepResults?:  number;     // default: 500
  maxBarrelDepth?:  number;     // default: 10
  maxTracerFiles?:  number;     // default: 100
}
```

Loading is simple — read `dg.config.json` from repo root, parse JSON, return defaults for missing fields:

```typescript
function loadConfig(repoRoot: string): DgConfig {
  const configPath = path.join(repoRoot, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn(`Failed to parse ${CONFIG_FILE}`);
    }
  }
  return {};  // all defaults
}
```

**Why JSON and not YAML/TOML?** Zero dependencies. `JSON.parse` is built into Node.js. Adding a YAML parser would add a dependency for no meaningful benefit — the config is simple enough that JSON handles it fine.

---

## 5. The Reporter Pattern

Three reporters share the same interface:

```typescript
interface Reporter {
  render(result: AnalysisResult, config: ReporterConfig): Promise<void>;
}
```

The pipeline selects the reporter based on config:

```typescript
if (config.format === 'github') {
  await GithubReporter.render(result, config);
} else if (config.format === 'json') {
  await JsonReporter.render(result, config);
} else {
  await TerminalReporter.render(result, config);
}
```

### Terminal Reporter

[`src/reporter/terminal.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/terminal.ts) — Rich chalk-colored output for local development:

```
Diff-Guardian API Analysis
Base: main → Head: HEAD
────────────────────────────────────────────────────────

[BREAKING] Changes (1)
  ► processPayment (signature_change)
    src/payments/index.ts:42
    Required parameter 'currency' was added.
    Affected call sites (2):
      ❌ src/checkout/cart.ts:47 — provides 1 arg(s), needs 2-3
      ✅ src/admin/refunds.ts:12 — Fixed by developer in this PR

────────────────────────────────────────────────────────
 [STRICT MODE] 
Breaking changes found. Exiting with code 1.

  ► To bypass this strict check, append --no-verify to your git command.
```

**Design details:**

- Severity icons: `❌` breaking, `⚠️` warning/indeterminate, `✅` fixed/safe
- Call sites are grouped under each breaking change with arg counts
- Hook context changes the bypass instructions:
  - `pre-push` → "git push --no-verify"
  - `pre-merge-commit` → "git merge --no-verify" + "git merge --abort"
- `quiet` mode suppresses all output (useful when only the exit code matters)
- Chalk respects `NO_COLOR` and `CI` env vars natively — no manual color stripping needed

### GitHub Reporter

[`src/reporter/github.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/github.ts) — Posts a PR comment via the GitHub REST API:

```markdown
## Diff-Guardian API Audit

### [BREAKING] Changes (1)

| File | Symbol | Type | Message |
|------|--------|------|---------|
| `src/payments/index.ts:42` | **processPayment** | `signature_change` | Required parameter 'currency' was added. |

<details>
<summary><strong>📍 Affected Call Sites</strong></summary>

#### `processPayment` — 2 call site(s)

- ❌ `src/checkout/cart.ts:47` — provides 1 arg(s), needs 2-3
- ✅ `src/admin/refunds.ts:12` — Fixed by developer in this PR

</details>
```

**Key features:**

#### `COMMENT_MARKER` for upsert

```typescript
const COMMENT_MARKER = '<!-- dg-report -->';
```

Every comment starts with this HTML comment. When the PR is re-pushed, the reporter searches for an existing comment with this marker and **updates** it instead of creating a new one. This prevents spam — each PR has exactly one Diff-Guardian comment that stays updated.

```typescript
async function upsertComment(config, markdown) {
  // Fetch existing comments
  const comments = await fetch(commentsUrl);
  const existing = comments.find(c => c.body?.includes(COMMENT_MARKER));

  if (existing) {
    await fetch(existing.url, { method: 'PATCH', body: { body: markdown } });
  } else {
    await fetch(commentsUrl, { method: 'POST', body: { body: markdown } });
  }
}
```

#### `<details>` sections

Call-site details are wrapped in collapsible `<details>` tags. This keeps the comment compact — reviewers see the summary table at a glance and can expand details if needed.

#### Markdown sanitization

Pipe characters (`|`) in messages would break the markdown table:

```typescript
function sanitizeInline(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}
```

#### SHA abbreviation

```typescript
function abbreviate(ref: string): string {
  return ref.length >= 40 ? ref.substring(0, 7) : ref;
}
```

Full 40-char SHAs get truncated to 7 chars. Short names like `main` or `HEAD` are kept as-is.

### JSON Reporter

[`src/reporter/json.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/json.ts) — The simplest reporter:

```typescript
export const JsonReporter: Reporter = {
  async render(result, config) {
    if (!config.quiet) {
      console.log(JSON.stringify(result, null, 2));
    }
  }
};
```

Dumps the full `AnalysisResult` as JSON. Used for piping to other tools or for `--report-file` output.

---

## 6. Exit Code Contract

The CLI uses a 3-code exit contract:

| Code | Meaning | When |
|---|---|---|
| `0` | Clean pass | No breaking changes (or CI advisory mode) |
| `1` | Breaking changes found | Strict mode + breaking changes present |
| `2` | Infrastructure error | Grammar load failure, git error, OOM |

```typescript
// Pipeline returns exit code
const hasBreaks = result.breaking.length > 0;
if (hasBreaks && config.mode === 'strict') return 1;
if (config.failOnWarnings && result.warnings.length > 0) return 1;
return 0;
```

**Why not exit 1 in CI?** The smart default always returns 0 in CI. Breaking changes are surfaced as a PR comment, not as a failing check. This is intentional — a failing check blocks the merge, which forces developers to use `--no-verify` escape hatches. An advisory comment informs without blocking.

Exit 2 is reserved for **real failures** — the tool itself broke. This turns the CI check red so the team knows something is wrong with the infrastructure, not just the code.

---

## 7. GitHub Actions Workflow

The `init` command scaffolds this workflow:

```yaml
name: "Diff-Guardian"

on:
  pull_request:
    branches: [ "main", "master" ]

permissions:
  contents: read
  pull-requests: write     # needed to post PR comments

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history, not shallow clone

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci
      - run: npm run build:grammars
      - run: npm run build

      - run: npx dg
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

**Critical details:**

- **`fetch-depth: 0`** — Without this, GitHub Actions does a shallow clone (depth 1). `git diff` between base and head would fail because the base commit doesn't exist in the shallow history.
- **`pull-requests: write`** — Required to post/update the PR comment. The default `GITHUB_TOKEN` has read-only permissions for pull requests.
- **`GITHUB_HEAD_SHA`** — Explicitly passed because `GITHUB_SHA` in a PR context is a merge commit, not the actual PR head.

---

## 8. Git Hooks (Husky)

The `package.json` includes `husky` for git hooks:

```json
"scripts": {
  "prepare": "husky"
}
```

Hooks set the `DG_HOOK` env var so the CLI knows the context:

```bash
# .husky/pre-push
DG_HOOK=pre-push npx dg compare origin/main HEAD

# .husky/pre-merge-commit  
DG_HOOK=pre-merge-commit npx dg compare HEAD MERGE_HEAD
```

The hook context changes the terminal reporter's bypass message:
- `pre-push` → "git push --no-verify"
- `pre-merge-commit` → "git merge --no-verify" and "git merge --abort"
- `post-merge` → advisory only, never blocks

### `--no-verify` escape hatch

Git natively supports `--no-verify` to skip hooks. This is the intended escape hatch when a developer knowingly introduces a breaking change:

```bash
git push --set-upstream origin HEAD --no-verify
```

The terminal reporter explicitly tells users about this option — the goal is to **inform**, not to trap.

---

## 9. `--report-file` Output

The pipeline can optionally write the full `AnalysisResult` to a JSON file:

```typescript
if (opts.config.reportFile) {
  const reportPath = path.resolve(repoRoot, opts.config.reportFile);
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');
}
```

Usage: `npx dg compare main --report-file .dg-report.json`

This is useful for:
- Downstream tooling that reads the JSON
- Archiving analysis results
- CI artifacts for debugging

---

## 10. Smart Branch Detection

[`getDefaultBranch()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/cli.ts#L45-L66) tries multiple strategies:

```typescript
function getDefaultBranch(): string {
  // 1. Ask the remote what its HEAD is
  try {
    const output = execSync(
      "git remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p'"
    ).trim();
    if (output) return output;
  } catch {}

  // 2. Check if 'main' or 'master' branches exist
  try {
    const branches = execSync("git branch --format='%(refname:short)'").split('\n');
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
    // 3. Fall back to first branch that isn't current
    const current = execSync("git branch --show-current").trim();
    const other = branches.find(b => b && b !== current);
    if (other) return other;
  } catch {}

  return 'main';  // ultimate fallback
}
```

This handles repos that use `master`, `main`, `develop`, or any other branch naming convention. The first strategy (asking the remote) is the most accurate — it returns whatever the repo's default branch actually is.

---

## 11. Interview Angle

> **"How does the tool integrate into a team's workflow?"**
>
> "Three integration points. First, local: `npx dg check` runs against uncommitted changes — instant feedback before you even commit. Second, git hooks: Husky's `pre-push` hook runs the analysis and blocks the push if breaking changes are found, with `--no-verify` as an explicit escape hatch. Third, CI: a GitHub Actions workflow posts a PR comment with a markdown table of all API changes, collapsible call-site details, and a severity summary. The CI mode is advisory — it never blocks the merge, just informs. The key insight is the 3-tier exit code contract: 0 = clean, 1 = breaking changes, 2 = infrastructure error."

> **"Why advisory mode in CI instead of blocking?"**
>
> "Blocking merges over breaking changes creates perverse incentives. Developers add `--no-verify` to everything, which means the tool is effectively disabled. Advisory mode keeps the information visible — a PR comment that says 'you're breaking 3 call sites' is more actionable than a red X that says 'check failed'. The team can then make an informed decision: is this intentional? If yes, document it. If not, fix it."

---

*Phase 5 complete! Next: [Phase 6, Topic 1 — Design Patterns & Engineering Decisions](./phase6-topic1-design-patterns.md)*
