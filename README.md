<p align="center">
  <img src="https://raw.githubusercontent.com/Aryan0628/diff-guardian/main/.github/banner.png" alt="Diff Guardian" width="600" />
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/diff-guardian?style=flat-square&color=blue" alt="npm version" />
  <img src="https://img.shields.io/github/license/Aryan0628/diff-guardian?style=flat-square" alt="license" />
  <img src="https://img.shields.io/node/v/diff-guardian?style=flat-square" alt="node version" />
  <img src="https://img.shields.io/github/actions/workflow/status/Aryan0628/diff-guardian/diff-guardian.yml?branch=main&style=flat-square&label=CI" alt="CI status" />
</p>

<p align="center">
  <strong>Impact-aware git diff engine that uses WASM Tree-Sitter AST parsing to detect breaking API changes before they ship.</strong>
</p>

<p align="center">
  <a href="https://diffguardian.space">Website</a> &middot;
  <a href="https://diffguardian.space/docs">Documentation</a> &middot;
  <a href="https://diffguardian.space/docs/rules/all">Rules Reference</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## Why Diff Guardian?

### The Problem: Silent API Breakages
Standard `git diff` makes merging code dangerous because it only understands added or removed text lines, not your code's actual structure. When teams collaborate on shared interfaces, standard `git` won't warn you if a colleague accidentally removes a required argument, changes a return type, or mutates an exported enum. 
The result? Silent regressions, broken CI/CD pipelines, and painful merge resolutions that easily slip past code review.

### The Solution
Traditional diffs show **what changed**. Diff Guardian shows **what breaks**.

Diff Guardian acts as an automated safety net. Using WASM-compiled Tree-Sitter grammars, it parses your code into abstract syntax tree (AST) signatures, compares the before and after states across any branch, and evaluates every diff against **26 strict production rules**. It then traces every call site across your ecosystem to show **exactly who is affected** before you merge or push.

```
$ npx dg compare main feature-branch

  Diff Guardian · Compare

  Base: main
  Head: feature-branch

  BREAKING  src/api/payments.ts → processPayment()
     R01: Parameter 'currency' was removed. Callers providing this argument will fail.

     3 call sites affected:
        src/checkout/handler.ts:42   processPayment("usd", 100)
        src/invoices/generator.ts:18 processPayment(curr, amount)
        tests/payments.test.ts:7     processPayment("eur", 50)
```

**Zero config required.** Install it. Run it. Ship with confidence.

---

## Features

| Capability | Description |
|---|---|
| **AST-Powered Analysis** | Tree-Sitter WASM grammars parse your code into structural signatures — not regex |
| **26 Classification Rules** | Covers parameter changes, return types, generics, visibility, enums, interfaces, and more |
| **Blast Radius Tracing** | JIT import scanner and call-site tracer shows every consumer affected by a breaking change |
| **CI/CD Native** | Auto-detects GitHub Actions and posts PR comments with full audit reports |
| **Git Hook Enforcement** | Built-in Husky hooks block broken code at `pre-push`, `pre-merge-commit`, and `post-merge` |
| **Multi-Language** | TypeScript, JavaScript, Python, Go, Java, and Rust |
| **Fast** | WASM grammars cached to disk; lazy graph only traces what is broken |
| **Zero Config** | Works out of the box with `npx dg` |

---

## Quick Start

### Installation

```bash
# Install as a dev dependency (recommended)
npm install --save-dev diff-guardian

# Or run directly with npx — no install needed
npx dg
```

### Initialize Your Project

```bash
npx dg init
```

This scaffolds two files:

| File | Purpose |
|---|---|
| `dg.config.json` | Project configuration |
| `.github/workflows/diff-guardian.yml` | GitHub Actions workflow for automated PR audits |

### Run Your First Scan

```bash
# Smart mode — auto-detects CI vs local
npx dg

# Compare your branch against main
npx dg compare main

# Check uncommitted changes
npx dg check

# Check only staged files
npx dg check --staged
```

---

## Commands

### `dg` — Smart Default

```bash
npx dg
```

Auto-detects the execution context:

| Context | Behavior |
|---|---|
| **GitHub Actions** | Compares PR base to head and posts a comment on the PR |
| **Local terminal** | Compares default branch to `HEAD` and prints a terminal report |

### `dg check` — Working Tree Analysis

```bash
# Analyze all uncommitted changes
npx dg check

# Analyze only staged files
npx dg check --staged

# Scope to a specific directory
npx dg check src/payments
```

### `dg compare <base> [head]` — Git Ref Comparison

```bash
# Compare current branch against main
npx dg compare main

# Compare two branches
npx dg compare main feature-branch

# Compare two tags
npx dg compare v1.0.0 v2.0.0

# Compare recent commits
npx dg compare HEAD~3 HEAD
```

### `dg trace <symbol>` — Impact Tracing

```bash
npx dg trace processPayment
```

Shows every file that imports the given symbol and where it is used:

```
  processPayment — 3 importer(s) found

  src/checkout/handler.ts
    L4  processPayment  [named]

  src/invoices/generator.ts
    L2  processPayment  [named]

  tests/payments.test.ts
    L1  processPayment  [named]
```

### `dg rules` — List Classification Rules

```bash
npx dg rules
```

Prints all 26 classification rules with their IDs, names, targets, and descriptions.

> For detailed examples and remediation guidance, see the [full rules documentation](https://diffguardian.space/docs/rules/all).

### `dg init` — Project Scaffolding

```bash
npx dg init
```

Creates `dg.config.json` and the GitHub Actions workflow. Skips files that already exist.

### Global Options

| Option | Description |
|---|---|
| `--help`, `-h` | Show help message |
| `--staged` | Limit `check` to staged files only |
| `--report-file <path>` | Write JSON report to a file |

---

## Configuration

Diff Guardian looks for a `dg.config.json` file in your project root.

```json
{
  "baseBranch": "main",
  "failOnWarnings": false,
  "enableTracer": true,
  "maxGrepResults": 500,
  "maxBarrelDepth": 10,
  "maxTracerFiles": 100
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `baseBranch` | `string` | `"main"` | Default branch to compare against |
| `failOnWarnings` | `boolean` | `false` | Exit with code `1` on warnings (not just breaking changes) |
| `enableTracer` | `boolean` | `true` | Enable or disable call-site tracing |
| `maxGrepResults` | `number` | `500` | Max files returned by `git grep` per symbol |
| `maxBarrelDepth` | `number` | `10` | Max recursive barrel file depth |
| `maxTracerFiles` | `number` | `100` | Max files to AST-parse for call sites per symbol |

---

## CI/CD Integration

### GitHub Actions

Run `npx dg init` to generate the workflow file, or add this to your pipeline manually:

```yaml
name: "Diff Guardian"

on:
  pull_request:
    branches: [ "main", "master" ]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  analyze:
    name: API Contract Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Cache WASM Grammars
        id: grammar-cache
        uses: actions/cache@v4
        with:
          path: grammars/
          key: wasm-grammars-${{ hashFiles('package-lock.json') }}
          restore-keys: |
            wasm-grammars-

      - name: Build WASM Grammars
        if: steps.grammar-cache.outputs.cache-hit != 'true'
        run: npm run build:grammars

      - run: npm run build

      - name: Run Diff Guardian
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: npx dg
```

In CI mode, Diff Guardian automatically:

- Resolves `GITHUB_BASE_REF` and `GITHUB_HEAD_SHA` for accurate comparison
- Posts a formatted comment on the PR with the full audit report
- Caches WASM grammars for faster subsequent runs
- Returns exit code `0` (advisory mode — classifications never block the merge)

### Git Hook Enforcement

Diff Guardian ships with Husky hooks for local enforcement:

| Hook | Behavior |
|---|---|
| `pre-push` | **Blocks push** if breaking changes are detected (`exit 1`) |
| `pre-merge-commit` | **Blocks merge** if breaking changes are detected (`exit 1`) |
| `post-merge` | Advisory scan after merge — generates `.dg-report.json` |

---

## Supported Languages

| Language | Grammar | Extensions |
|---|---|---|
| TypeScript | `tree-sitter-typescript` | `.ts`, `.tsx` |
| JavaScript | `tree-sitter-javascript` | `.js`, `.jsx` |
| Python | `tree-sitter-python` | `.py` |
| Go | `tree-sitter-go` | `.go` |
| Java | `tree-sitter-java` | `.java` |
| Rust | `tree-sitter-rust` | `.rs` |

---

## Programmatic API

Diff Guardian can be used as a library in your own tooling:

```typescript
import { runPipeline, ClassifierEngine, ASTMapper } from 'diff-guardian';

// Run the full pipeline
const exitCode = await runPipeline({
  baseSha: 'main',
  headSha: 'HEAD',
  repoRoot: process.cwd(),
  config: {
    mode: 'strict',
    format: 'json',
  },
});

// Or use individual components
const mapper = new ASTMapper();
await mapper.init();
const diffs = await mapper.buildSignatureCache(/* ... */);

const engine = new ClassifierEngine();
const changes = engine.compare(diff);
```

### Exported Types

```typescript
import type {
  PipelineOptions,
  ReporterConfig,
  AnalysisResult,
  FunctionChange,
  FileDiff,
  ParseResult,
  FunctionSignature,
  InterfaceSignature,
  EnumSignature,
} from 'diff-guardian';
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                           CLI Layer                              │
│         npx dg check | compare | trace | rules | init            │
├──────────────────────────────────────────────────────────────────┤
│                         Pipeline                                 │
│           Orchestrates the full analysis flow                    │
├──────────────┬──────────────┬──────────────┬─────────────────────┤
│  Git Diff    │  AST Mapper  │  Classifier  │  Reporter           │
│  Parser      │  (WASM TS)   │  Engine      │  (Terminal/GitHub)  │
├──────────────┴──────────────┼──────────────┴─────────────────────┤
│     Language Translators    │    Tracer (Scanner + Call Sites)   │
│     TS · JS · Python · Go   │    JIT import resolution           │
│     Java · Rust             │    Lazy blast-radius graph         │
└─────────────────────────────┴────────────────────────────────────┘
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Clean — no breaking changes detected |
| `1` | Breaking changes detected (or warnings, if `failOnWarnings` is enabled) |
| `2` | Infrastructure error (missing grammar, parse failure, etc.) |

---

## Requirements

- **Node.js** >= 18
- **Git** — must be run inside a git repository

---

## Documentation

> Visit the official website at [diffguardian.space](https://diffguardian.space) for an overview of the project, and [diffguardian.space/docs](https://diffguardian.space/docs) for full documentation, guides, and examples.

The docs site covers:

- Detailed installation guides
- Rule-by-rule reference with examples
- Configuration deep dives
- CI/CD recipes for GitHub Actions
- Architecture and internals

---

## Contributing

Contributions are welcome. Please see the [Contributing Guide](CONTRIBUTING.md) for details on setting up your development environment, project architecture, writing classification rules, and submitting pull requests.

Please review our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

---

## License

[MIT](LICENSE) &copy; Aryan Gupta
