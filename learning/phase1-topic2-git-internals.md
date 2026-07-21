# Phase 1 · Topic 2: Git Internals for Code Analysis

---

## Why Do You Need to Know This?

Diff-Guardian's **first pipeline phase** is extracting source code from Git. It doesn't read files from your filesystem the way `cat` or `fs.readFileSync()` does. Instead, it reaches into Git's internal object database to pull the **exact version** of a file at any point in history.

To understand how this works, you need to understand how Git actually stores code — not as files, but as **objects**.

---

## Part A: How Git Actually Stores Code

When you run `git init`, Git creates a hidden `.git` directory. Inside it, Git maintains its own database. This database stores four types of objects:

### The 4 Git Object Types

```
┌────────────────────────────────────────────────────────┐
│                    commit                               │
│  "Aryan added processPayment function"                 │
│  tree → 8f3c...   (points to root tree)                │
│  parent → a1b2... (points to previous commit)          │
│  author, date, message                                 │
├────────────────────────────────────────────────────────┤
│                     tree                                │
│  Maps names to blobs/other trees (like a directory)     │
│  src/ → tree 4d5e...                                   │
│  README.md → blob 7a8b...                              │
│  package.json → blob 9c0d...                           │
├────────────────────────────────────────────────────────┤
│                     blob                                │
│  Raw file content. No filename. No metadata.            │
│  Just bytes: "function processPayment(amount: number)…" │
├────────────────────────────────────────────────────────┤
│                      tag                                │
│  A named pointer to a commit (e.g., v1.0.0 → commit)  │
└────────────────────────────────────────────────────────┘
```

**The key insight:** Git doesn't store "files." It stores content-addressed **blobs** (file contents), organized by **trees** (directory structures), referenced by **commits** (snapshots in time).

Every object is identified by its **SHA-1 hash** — a 40-character hex string computed from the content. If the content is identical, the hash is identical. This is how Git knows whether a file changed.

### How a Commit Maps to Files

```
commit abc123
  └── tree (root)
        ├── blob "package.json"    → { "name": "diff-guardian" ... }
        ├── tree "src/"
        │     ├── blob "cli.ts"    → "#!/usr/bin/env node ..."
        │     ├── blob "pipeline.ts" → "import * as fs from 'fs' ..."
        │     └── tree "parsers/"
        │           ├── blob "ast-mapper.ts" → "export class ASTMapper ..."
        │           └── blob "git-diff.ts"   → "export async function ..."
        └── tree "tests/"
              └── blob "classifier.test.ts" → "describe('R01', ..."
```

---

## Part B: The Three Git Commands Diff-Guardian Uses

Diff-Guardian's [git-diff.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts) uses exactly three Git plumbing commands. Understanding these is crucial.

### Command 1: `git diff --name-status`

**Purpose:** Find out which files changed between two refs.

```bash
$ git diff --name-status main feature-branch
M       src/payments/processor.ts      # Modified
A       src/payments/validator.ts      # Added (new file)
D       src/legacy/old-handler.ts      # Deleted
R085    src/utils/helper.ts  src/utils/helpers.ts   # Renamed (85% similarity)
```

The status codes:

| Code | Meaning | Diff-Guardian behavior |
|------|---------|----------------------|
| `M` | Modified | Parse both old and new versions, compare signatures |
| `A` | Added | Only new version exists — all symbols are "added" (safe) |
| `D` | Deleted | Only old version exists — all symbols are "deleted" (breaking) |
| `R` | Renamed | Like `M` but with a different path. Old path → new path tracked. |
| `C` | Copied | Treated like `A` (rare) |

This is the first thing Diff-Guardian does — it asks Git "what changed?" to know which files need analysis.

### Command 2: `git show ref:path`

**Purpose:** Read the contents of a file at any point in history, without checking it out.

```bash
# Read processor.ts as it exists on the main branch
$ git show main:src/payments/processor.ts

# Read processor.ts as it existed 3 commits ago
$ git show HEAD~3:src/payments/processor.ts

# Read processor.ts from the staging area (index)
$ git show :src/payments/processor.ts
```

**This is the magic command.** It lets Diff-Guardian read the "before" version of a file from the base branch and the "after" version from the head branch — without switching branches, without touching the working directory, without any file I/O.

The colon syntax `ref:path` is Git's way of saying "give me the blob at this path in this tree."

### Command 3: `git grep`

**Purpose:** Search for a pattern across all tracked files, extremely fast.

```bash
# Find every file that contains the word "processPayment"
$ git grep -n --word-regexp "processPayment"

src/checkout/handler.ts:42:  const result = processPayment(amount, currency);
src/invoices/generator.ts:18:  await processPayment(curr, amount);
tests/payments.test.ts:7:  processPayment("eur", 50);
```

This is used by the **JIT Tracer** (Phase 4) to find all files that might reference a broken function — before doing expensive AST parsing on them.

Flags explained:
- `-n` → show line numbers
- `--word-regexp` → match whole words only (prevents "processPaymentV2" from matching "processPayment")

Why `git grep` instead of regular `grep`? Because `git grep` only searches **tracked files** — it automatically skips `node_modules/`, `.git/`, build artifacts, and anything in `.gitignore`. It's also faster because it reads from Git's index.

---

## Part C: The Three Modes of Source Extraction

Diff-Guardian supports three different ways to get "before" and "after" source code:

### Mode 1: Standard (Ref Comparison)

```bash
npx dg compare main feature-branch
```

```
Old source: git show main:src/processor.ts
New source: git show feature-branch:src/processor.ts
```

Both versions come from Git's object database. Nothing is read from disk. This is the most common mode — comparing two branches or commits.

### Mode 2: Working Tree

```bash
npx dg check
```

```
Old source: git show HEAD:src/processor.ts     ← from last commit
New source: fs.readFileSync('src/processor.ts') ← from disk (uncommitted changes)
```

The old version comes from Git. The new version comes from the **filesystem** — whatever you've changed but not yet committed. Used for pre-commit analysis.

### Mode 3: Staged

```bash
npx dg check --staged
```

```
Old source: git show HEAD:src/processor.ts   ← from last commit
New source: git show :src/processor.ts       ← from git index (staged files)
```

Both versions come from Git, but the "new" version uses the special `:path` syntax (no ref before the colon) which reads from the **staging area** — files you've `git add`-ed but not committed. Used for pre-commit hook integration.

### The Three Git Zones

This is a fundamental Git concept that Diff-Guardian's modes map onto:

```
┌──────────────┐    git add    ┌──────────────┐   git commit   ┌──────────────┐
│  Working     │ ──────────► │   Staging     │ ──────────►  │  Repository  │
│  Tree        │              │   Area        │               │  (History)   │
│              │              │   (Index)     │               │              │
│ Files on     │              │ Files in      │               │ Committed    │
│ your disk    │              │ "git show :"  │               │ "git show    │
│              │              │               │               │  ref:path"   │
└──────────────┘              └──────────────┘               └──────────────┘

  Mode 2: check                 Mode 3: check --staged          Mode 1: compare
  (new from disk)               (new from index)                (both from history)
```

---

## Part D: How `git-diff.ts` Implements This

Here's the actual implementation pattern from [git-diff.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts):

```typescript
// Special sentinel values — not real git refs
export const WORKING_TREE = 'WORKING_TREE';
export const STAGED = 'STAGED';

export async function extractGitSources(
  baseSha: string,
  headSha: string,
  repoRoot: string = process.cwd(),
  pathFilter?: string,
): Promise<FileDiff[]> {

  // Build diff command based on mode
  let diffCmd: string;

  if (headSha === WORKING_TREE) {
    diffCmd = `git diff --name-status ${baseSha}`;         // uncommitted changes
  } else if (headSha === STAGED) {
    diffCmd = `git diff --name-status --cached ${baseSha}`; // staged changes only
  } else {
    diffCmd = `git diff --name-status ${baseSha} ${headSha}`; // two refs
  }

  // ... parse output, extract sources for each changed file
}
```

For each changed file, the old and new source are extracted:

```typescript
// Old source — always from git (unless file is new)
const oldSource = isNew ? '' : await gitShow(baseSha, filePath);

// New source — depends on mode
let newSource: string;
if (headSha === WORKING_TREE) {
  newSource = fs.readFileSync(absolutePath, 'utf-8');  // from disk
} else if (headSha === STAGED) {
  newSource = await gitShow('', filePath);  // '' + ':' + path = index
} else {
  newSource = await gitShow(headSha, filePath);  // from git history
}
```

### Why `Promise.allSettled()` Instead of `Promise.all()`?

```typescript
const results = await Promise.allSettled(files.map(f => extractFileContent(f)));
```

- `Promise.all()` → If **any** file fails, the **entire batch** fails. One corrupted binary file kills the whole scan.
- `Promise.allSettled()` → Each file resolves independently. Failed files are skipped with a warning. Successful files proceed.

This is an important design choice: **one bad file should never abort an entire diff scan**. A monorepo might have 200 changed files — you don't want to lose all 199 results because one file had an encoding issue.

---

## Part E: Edge Cases and Error Handling

### 10MB Buffer Limit

```typescript
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

const { stdout } = await execAsync(`git show ${ref}:${filePath}`, {
  maxBuffer: MAX_BUFFER,
});
```

Git commands are run via `child_process.exec()`, which buffers stdout in memory. If a file is larger than 10MB, the command fails. This is intentional — files that large (usually generated code or data files) shouldn't be AST-parsed anyway.

### File Rename Detection

```
R085    src/old/helper.ts    src/new/helpers.ts
```

The `R` status code includes a similarity percentage. Git detected that `helpers.ts` is 85% similar to `helper.ts` — it's a rename, not a delete+add. Diff-Guardian tracks this so it compares the old file at its old path against the new file at its new path.

### Path Filtering

```bash
npx dg check src/payments
```

Only files under `src/payments/` are analyzed. This is useful in monorepos where you only care about changes in your module.

---

## Key Terms

| Term | Definition |
|------|-----------|
| **Blob** | A Git object storing raw file content. No filename, no metadata. Identified by SHA-1 hash. |
| **Tree** | A Git object mapping filenames to blobs (like a directory listing). |
| **Commit** | A Git object pointing to a tree (snapshot) plus metadata (author, message, parent). |
| **Ref** | A human-readable name for a commit hash: `main`, `HEAD`, `v1.0.0`, `feature-branch`. |
| **Index / Staging Area** | The "next commit" buffer. Files you've `git add`-ed live here. |
| **Working Tree** | The actual files on disk in your project directory. |
| **`git show ref:path`** | Read a file's content at a specific commit without checking it out. |
| **`git diff --name-status`** | List changed files with their status codes (M/A/D/R). |
| **`git grep`** | Search for patterns across tracked files, fast and `.gitignore`-aware. |
| **`Promise.allSettled()`** | Run promises in parallel, collect all results (fulfilled or rejected) without short-circuiting. |

---

## 🎤 Interview Q&A

### "How does your tool access different versions of a file?"

> "We use `git show ref:path` — a Git plumbing command that reads file contents directly from Git's object database at any commit, without checking out the branch. This lets us get the 'before' version from the base branch and the 'after' version from the feature branch, all in the same process. For working tree mode, we fall back to `fs.readFileSync()` for uncommitted changes."

### "What are Git objects?"

> "Git stores everything as content-addressed objects — identified by their SHA-1 hash. There are three main types: **blobs** store raw file content, **trees** map filenames to blobs like a directory listing, and **commits** point to a tree (the snapshot) plus metadata. When you run `git show main:src/file.ts`, Git walks from the commit to its tree to the right blob and returns the content."

### "How do you handle errors when extracting files?"

> "We use `Promise.allSettled()` instead of `Promise.all()` so one failed file doesn't abort the entire scan. We also cap the buffer at 10MB to prevent memory issues with very large files. Files that fail extraction are logged as warnings but don't block the pipeline — critical for monorepos where you might have 200+ changed files."

### "What's the difference between working tree, staging area, and repository?"

> "The **working tree** is the actual files on disk — what you see in your editor. The **staging area** (index) is a buffer of changes you've marked for the next commit via `git add`. The **repository** is the committed history. Diff-Guardian supports all three: `dg compare` reads both versions from history, `dg check` reads the 'new' version from disk, and `dg check --staged` reads from the staging area using `git show :path` syntax."

### "DSA connection: Why content-addressed storage?"

> "Git uses **hash maps** (SHA-1 hash → content) for deduplication. If two files have identical content, they produce the same hash and Git stores only one copy. Trees are essentially **tries/prefix trees** of paths mapping to blob hashes. This is the same principle behind content delivery networks (CDNs) and distributed caching — content-addressed storage enables O(1) lookups and automatic deduplication."

---

*Next up: [Phase 1, Topic 3 — Breaking Changes & API Contracts](./phase1-topic3-breaking-changes.md)*
