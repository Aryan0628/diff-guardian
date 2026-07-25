# Phase 2 · Topic 1: Problem Statement, Architecture & Data Flow

---

## Part A: Why Diff-Guardian Was Built

### The Problem in One Sentence

> Standard `git diff` shows **what text changed**. It cannot tell you **what breaks**.

### The Real-World Scenario

Imagine you work on a team of 8 developers. You maintain a shared `payments` module. Your colleague opens a PR that looks harmless:

```diff
--- a/src/payments/processor.ts
+++ b/src/payments/processor.ts
@@ -1,5 +1,5 @@
-export function processPayment(amount: number, currency: string): boolean {
+export function processPayment(amount: number): boolean {
   return amount > 0;
 }
```

The reviewer thinks: *"They simplified the function signature, looks clean, LGTM."* The PR merges.

What nobody noticed:
- `processPayment()` is imported by **12 files** across the codebase
- 8 of those 12 callers still pass 2 arguments — they now silently receive `undefined` for what used to be `currency`
- The checkout flow, the invoice generator, and 3 integration tests are now broken
- CI passes because the TypeScript compiler doesn't error on extra arguments by default
- You find out when a customer reports corrupt invoices at 2 AM

**This is the exact problem Diff-Guardian solves.** It would have:
1. Detected that a required parameter was removed (Rule R01)
2. Classified it as `BREAKING` severity
3. Traced 12 importer files and found 8 broken call sites
4. Blocked the push (or posted a PR comment) with the full blast radius report

### Target Users

| User | How they use Diff-Guardian |
|------|---------------------------|
| **Individual developer** | Run `npx dg check` before committing to catch self-inflicted breakages |
| **Team lead / code reviewer** | PR comments show exactly what each change breaks, with line-level call sites |
| **OSS maintainer** | Enforce semver compliance — catch breaking changes that should bump MAJOR |
| **Monorepo team** | Trace cross-package blast radius when a shared module changes |
| **CI/CD pipeline** | Automated gatekeeper — block or warn on breaking changes before merge |

---

## Part B: The 6-Phase Pipeline

Diff-Guardian processes a diff through a **6-phase linear pipeline**. Each phase takes the output of the previous one and transforms it into something richer.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        THE DIFF-GUARDIAN PIPELINE                       │
│                                                                         │
│  Phase 1          Phase 2          Phase 3          Phase 3.5           │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐      │
│  │  Source   │───►│   AST    │───►│Classifier│───►│   Tracer     │      │
│  │Extraction│    │  Parser  │    │  Engine  │    │  Metadata    │      │
│  └──────────┘    └──────────┘    └──────────┘    └──────────────┘      │
│  git-diff.ts     ast-mapper.ts   engine.ts        pipeline.ts          │
│                  translators/    rules/                                 │
│                                                                         │
│  Phase 4          Phase 5          Phase 6                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                          │
│  │   JIT    │───►│Aggregate │───►│ Reporter │───►  exit code           │
│  │  Tracer  │    │ Results  │    │  Output  │                          │
│  └──────────┘    └──────────┘    └──────────┘                          │
│  scanner.ts       pipeline.ts    terminal.ts                           │
│  tracer.ts                       github.ts                             │
│                                  json.ts                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Source Extraction

**File:** [git-diff.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts)
**Input:** Two git refs (e.g., `main` and `feature-branch`)
**Output:** `FileDiff[]`

```typescript
interface FileDiff {
  path:      string;   // 'src/payments/processor.ts'
  language:  string;   // 'ts'
  isNew:     boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  oldPath:   string;   // original path (same as path if not renamed)
  oldSource: string;   // full file text at baseSha
  newSource: string;   // full file text at headSha
}
```

This phase runs `git diff --name-status` to find changed files, then `git show ref:path` to read their full contents. You get a `FileDiff` for each changed file with both the old and new source text.

### Phase 2: AST Parsing

**File:** [ast-mapper.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts) + [translators/](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/translators)
**Input:** `FileDiff[]`
**Output:** `ParseResult[]`

```typescript
interface ParseResult {
  file:     string;                        // 'src/payments/processor.ts'
  language: Language;                      // 'typescript'
  oldSigs:  Map<string, AnySignature>;     // signatures from the old version
  newSigs:  Map<string, AnySignature>;     // signatures from the new version
  skipped:  boolean;
}
```

For each `FileDiff`, the ASTMapper:
1. Loads the correct WASM grammar for the language
2. Parses `oldSource` into a syntax tree → walks it → extracts `oldSigs`
3. Parses `newSource` into a syntax tree → walks it → extracts `newSigs`

Each signature map has entries like:
```
"processPayment" → FunctionSignature { name, params, returnType, exported, ... }
"interface:User" → InterfaceSignature { properties, exported, ... }
"enum:Status"    → EnumSignature { members, exported, ... }
```

### Phase 3: Classification

**File:** [engine.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/engine.ts) + [rules/](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/rules)
**Input:** `ParseResult` (one per file)
**Output:** `FunctionChange[]`

```typescript
interface FunctionChange {
  name:       string;      // 'processPayment'
  file:       string;      // 'src/payments/processor.ts'
  symbolType: 'function' | 'interface' | 'enum' | 'type_alias';
  changeType: ChangeType;  // 'signature_change', 'symbol_deleted', etc.
  breaking:   boolean;
  severity:   Severity;    // 'breaking' | 'warning' | 'safe'
  message:    string;      // "Parameter 'currency' was removed..."
  before:     AnySignature | null;  // old signature (null if added)
  after:      AnySignature | null;  // new signature (null if deleted)
  callers:    CallSite[];  // populated by tracer (empty at this point)
}
```

The classifier engine:
1. Takes the union of all keys from `oldSigs` and `newSigs`
2. For each key: is it deleted? Added? Modified?
3. If modified, runs all 26 rules against the old/new signature pair
4. Produces one `FunctionChange` per detected change

### Phase 3.5: Tracer Metadata Computation

**File:** [pipeline.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/pipeline.ts) (lines 78–199)
**Input:** `FunctionChange[]` (from classifier)
**Output:** Same `FunctionChange[]` but with tracer metadata populated

For functions: computes `requiredParamCount` and `totalParamCount` from the `after` signature — the tracer needs these to decide if a call site has the right number of arguments.

For enums: computes `removedEnumMembers` and `changedEnumMembers` — the tracer needs these to find broken `EnumName.MemberName` access patterns.

### Phase 4: JIT Tracing

**File:** [scanner.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts) + [tracer.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/tracer.ts)
**Input:** `FunctionChange[]` (breaking only) + `FileDiff[]`
**Output:** `CallSite[]` attached to each `FunctionChange`

```typescript
interface CallSite {
  file:           string;   // 'src/checkout/handler.ts'
  lineStart:      number;   // 42
  lineEnd:        number;   // 42
  argumentCount:  number;   // 2 (-1 if spread)
  isBroken:       boolean;  // true if args don't match new signature
  isFixed:        boolean;  // true if developer already updated
  isIndeterminate: boolean; // true if spread args
  covered:        boolean;  // true if a test file references this
}
```

This is a two-sub-phase process:
1. **Scanner** — uses `git grep` to find every file that imports the broken symbol, follows barrel/re-export chains
2. **Tracer** — parses each importer with Tree-Sitter, finds call expressions, counts arguments, validates against expected param range

### Phase 5: Aggregation

**File:** [pipeline.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/pipeline.ts) (lines 101–112)
**Input:** All `FunctionChange[]` (with call sites populated)
**Output:** `AnalysisResult`

```typescript
interface AnalysisResult {
  from:       string;           // 'main'
  to:         string;           // 'feature-branch'
  baseSha:    string;           // exact commit hash
  headSha:    string;           // exact commit hash
  breaking:   FunctionChange[]; // severity: 'breaking'
  warnings:   FunctionChange[]; // severity: 'warning'
  apiChanges: FunctionChange[]; // all changes
  testGaps:   FunctionChange[]; // breaking changes whose callers lack tests
  riskFiles:  RiskFile[];       // files ranked by risk
}
```

### Phase 6: Reporting

**Files:** [terminal.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/terminal.ts), [github.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/github.ts), [json.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/reporter/json.ts)
**Input:** `AnalysisResult` + `ReporterConfig`
**Output:** Terminal output / GitHub PR comment / JSON file

Three reporter formats:
- **Terminal** — chalk-colored CLI output with severity icons
- **GitHub** — markdown PR comment with tables and collapsible call-site sections
- **JSON** — machine-readable report file (`.dg-report.json`)

---

## Part C: The Full Data Journey — One File Through All 6 Phases

Let's trace a single file change through the entire pipeline:

### Starting Point: Developer Changes a Function

```typescript
// src/payments/processor.ts — BEFORE (on main branch)
export function processPayment(amount: number, currency: string): boolean {
  return amount > 0;
}

// src/payments/processor.ts — AFTER (on feature branch)
export function processPayment(amount: number): boolean {
  return amount > 0;
}
```

### Phase 1 Output: `FileDiff`

```typescript
{
  path: 'src/payments/processor.ts',
  language: 'ts',
  isNew: false,
  isDeleted: false,
  isRenamed: false,
  oldPath: 'src/payments/processor.ts',
  oldSource: 'export function processPayment(amount: number, currency: string): boolean {\n  return amount > 0;\n}',
  newSource: 'export function processPayment(amount: number): boolean {\n  return amount > 0;\n}',
}
```

### Phase 2 Output: `ParseResult`

```typescript
{
  file: 'src/payments/processor.ts',
  language: 'typescript',
  oldSigs: Map {
    'processPayment' → {
      name: 'processPayment',
      exported: true,
      async: false,
      params: [
        { name: 'amount', type: 'number', optional: false, hasDefault: false },
        { name: 'currency', type: 'string', optional: false, hasDefault: false },
      ],
      returnType: 'boolean',
      line: 1,
    }
  },
  newSigs: Map {
    'processPayment' → {
      name: 'processPayment',
      exported: true,
      async: false,
      params: [
        { name: 'amount', type: 'number', optional: false, hasDefault: false },
      ],
      returnType: 'boolean',
      line: 1,
    }
  },
  skipped: false,
}
```

### Phase 3 Output: `FunctionChange`

```typescript
{
  name: 'processPayment',
  file: 'src/payments/processor.ts',
  symbolType: 'function',
  changeType: 'signature_change',
  breaking: true,
  severity: 'breaking',
  message: "Parameter 'currency' was removed. Callers providing this argument will fail.",
  before: { /* old FunctionSignature with 2 params */ },
  after:  { /* new FunctionSignature with 1 param */ },
  callers: [],  // ← empty, tracer hasn't run yet
  requiredParamCount: undefined,
  totalParamCount: undefined,
}
```

### Phase 3.5: Tracer Metadata Added

```typescript
{
  // ...same as above, plus:
  requiredParamCount: 1,  // params.filter(p => !p.optional && !p.isRest).length
  totalParamCount: 1,     // params.filter(p => !p.isRest).length
}
```

### Phase 4: Call Sites Populated

```typescript
{
  // ...same as above, plus:
  callers: [
    { file: 'src/checkout/handler.ts', lineStart: 42, argumentCount: 2,
      isBroken: true, isFixed: false, isIndeterminate: false },
    { file: 'src/invoices/generator.ts', lineStart: 18, argumentCount: 2,
      isBroken: true, isFixed: false, isIndeterminate: false },
    { file: 'tests/payments.test.ts', lineStart: 7, argumentCount: 1,
      isBroken: false, isFixed: true, isIndeterminate: false },
  ],
}
```

### Phase 5: Aggregated into `AnalysisResult`

```typescript
{
  from: 'main',
  to: 'feature-branch',
  baseSha: 'abc123...',
  headSha: 'def456...',
  breaking: [ /* the FunctionChange above */ ],
  warnings: [],
  apiChanges: [ /* same */ ],
  testGaps: [],
  riskFiles: [],
}
```

### Phase 6: Terminal Output

```
  Diff Guardian · Compare

  Base: main
  Head: feature-branch

  BREAKING  src/payments/processor.ts → processPayment()
     R01: Parameter 'currency' was removed. Callers providing this argument will fail.

     3 call sites affected:
        ❌ src/checkout/handler.ts:42   processPayment("usd", 100)
        ❌ src/invoices/generator.ts:18 processPayment(curr, amount)
        ✅ tests/payments.test.ts:7     processPayment(100)  [fixed]
```

---

## Part D: The Pipeline Code — `pipeline.ts`

Here is the actual [pipeline.ts](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/pipeline.ts) flow, simplified:

```typescript
export async function runPipeline(opts: PipelineOptions): Promise<number> {
  const repoRoot = opts.repoRoot || process.cwd();

  // ── Phase 1: Extract sources ──────────────────────────────────
  const diffs = await extractGitSources(opts.baseSha, opts.headSha, repoRoot, opts.pathFilter);

  // ── Phase 2: Parse ASTs ───────────────────────────────────────
  const mapper = new ASTMapper();
  await mapper.init();
  const parsedDiffs = await mapper.buildSignatureCache(diffs);

  // ── Phase 3: Classify changes ─────────────────────────────────
  const engine = new ClassifierEngine();
  const allChanges: FunctionChange[] = [];
  for (const diff of parsedDiffs) {
    if (diff.skipped) continue;
    const fileChanges = engine.compare(diff);
    allChanges.push(...fileChanges);
  }

  // ── Phase 3.5: Compute tracer metadata ────────────────────────
  for (const change of allChanges) {
    if (!isTraceable(change)) continue;
    if (change.symbolType === 'function') computeParamCounts(change);
    else if (change.symbolType === 'enum') computeEnumMetadata(change);
  }

  // ── Phase 4: JIT Trace ────────────────────────────────────────
  const traceableChanges = allChanges.filter(isTraceable);
  if (traceableChanges.length > 0) {
    await traceCallSites(traceableChanges, diffs, repoRoot, opts.headSha);
  }

  // ── Phase 5: Aggregate ────────────────────────────────────────
  const result: AnalysisResult = {
    from: opts.baseSha, to: opts.headSha,
    baseSha: opts.baseSha, headSha: opts.headSha,
    breaking: allChanges.filter(c => c.severity === 'breaking'),
    warnings: allChanges.filter(c => c.severity === 'warning'),
    apiChanges: allChanges,
    testGaps: [], riskFiles: [],
  };

  // ── Phase 6: Report ───────────────────────────────────────────
  if (opts.config.format === 'github') await GithubReporter.render(result, opts.config);
  else if (opts.config.format === 'json') await JsonReporter.render(result, opts.config);
  else await TerminalReporter.render(result, opts.config);

  // ── Exit code ─────────────────────────────────────────────────
  if (result.breaking.length > 0 && opts.config.mode === 'strict') return 1;
  if (opts.config.failOnWarnings && result.warnings.length > 0) return 1;
  return 0;
}
```

Notice:
- The pipeline is **linear** — no branching, no parallel phases. Each phase feeds the next.
- The pipeline is **orchestrating**, not doing work itself — it delegates to specialized modules.
- Error handling is **non-fatal** — individual files or traces can fail without aborting the entire run.
- The exit code contract is simple: `0` = clean, `1` = breaking changes detected, `2` = infrastructure error.

---

## Key Terms

| Term | Definition |
|------|-----------|
| **Pipeline** | The linear sequence of processing phases that transforms a git diff into a breaking-change report |
| **FileDiff** | Phase 1 output — raw old/new source text for one changed file |
| **ParseResult** | Phase 2 output — old and new signature maps for one file |
| **FunctionChange** | Phase 3 output — one detected change with severity, rule, and message |
| **CallSite** | Phase 4 output — one location where a broken function is called |
| **AnalysisResult** | Phase 5 output — the complete aggregated report consumed by reporters |
| **isTraceable()** | Filter that decides which changes are worth tracing (only breaking function/enum changes) |
| **Orchestrator** | A module (like `pipeline.ts`) that coordinates other modules but contains minimal logic itself |

---

## 🎤 Interview Q&A

### "Give me the 30-second pitch for your project"

> "Diff-Guardian is a CLI tool that detects breaking API changes in git diffs. Standard git diff shows what text changed — our tool shows what breaks. It uses Tree-Sitter WASM parsers to build ASTs of your code, extracts structural signatures — parameters, types, visibility — and compares old vs new. When it finds a breaking change, it traces every call site across the codebase using a JIT import scanner and shows exactly who is affected. It supports 6 languages, runs in CI or locally, and takes zero configuration."

### "Walk me through the architecture in 2 minutes"

> "The tool runs a 6-phase linear pipeline. Phase 1 uses git plumbing commands to extract old and new source code for every changed file. Phase 2 parses both versions into syntax trees using Tree-Sitter WASM grammars and extracts structural signatures — things like function parameters, return types, export status. Phase 3 is the classifier — it compares old vs new signatures across 26 rules to detect breaking changes. Phase 4 is the JIT tracer — for each breaking change, it uses `git grep` to find all importers, then parses them to count arguments at each call site. Phase 5 aggregates everything into an AnalysisResult. Phase 6 renders the report — terminal, GitHub PR comment, or JSON. The key design choice is the 'lazy graph' in Phase 4 — we only trace symbols that are actually broken, not the entire codebase."

### "Why a linear pipeline? Why not parallel?"

> "Two reasons. First, there are strict data dependencies — you can't classify until you've parsed, you can't trace until you've classified. The phases must be sequential. Second, Tree-Sitter WASM parsing is sequential by design — the WASM heap is shared across parse calls, so concurrent parsing can cause heap fragmentation. Within Phase 1 (source extraction), we do use `Promise.allSettled()` for parallel I/O, but the pipeline itself is sequential."

### "How does the data evolve through each phase?"

> "It goes from raw text to increasingly structured representations. Phase 1 gives us strings — old and new file contents. Phase 2 converts those into signature Maps — structured objects with parameters, types, modifiers. Phase 3 compares signatures and produces change records with severity and rule IDs. Phase 4 adds call-site data — file, line, argument count, broken/fixed status. Phase 5 buckets everything by severity. Each phase adds information that the previous phase couldn't compute."

---

*Next up: [Phase 2, Topic 2 — Project Structure & Tech Stack](./phase2-topic2-project-structure-tech-stack.md)*
