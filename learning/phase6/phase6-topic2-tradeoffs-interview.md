# Phase 6, Topic 2: Trade-offs, Scalability & Interview Q&A

This is the final topic. It prepares you to **talk about Diff-Guardian in interviews** — explaining trade-offs, handling difficult questions, and delivering polished pitches at different time scales.

---

## 1. Trade-offs Made

Every engineering decision involves giving something up. Here are the conscious trade-offs in Diff-Guardian:

### No incremental caching

**What:** Every `npx dg` invocation re-parses everything from scratch. There's no `.dg-cache` that remembers previous runs.

**Why not cache?**
- Cold analysis is already <100ms for most PRs — caching would save ~50ms
- Cache invalidation is a hard problem: which files changed? Did a transitive dependency shift? Did the base branch move?
- Stale caches produce wrong results, which erodes trust
- Git already provides efficient content-addressable storage

**When this hurts:** Monorepos with 500+ changed files per PR. But even then, the bottleneck is `git diff` (Phase 1), not parsing.

### Sequential tracer (not parallel)

**What:** The tracer processes one file at a time, not concurrently.

**Why?**
- Tree-sitter's WASM runtime has a single heap — concurrent parsing causes non-deterministic fragmentation
- At 100k lines/sec, sequential is fast enough
- Parallel would add `Promise.all` + error handling complexity for ~2x speedup on a 20ms operation

**When this hurts:** Never, in practice. The tracer processes 3–15 files totaling ~1500 lines. Even at worst case (100 files), sequential takes ~20ms.

### Missing languages

**What:** Only 5 languages are supported (TypeScript, JavaScript, Python, Java, Go, Rust). No C/C++, C#, Kotlin, Swift, PHP, Ruby, etc.

**Why?**
- Each language needs: a tree-sitter grammar, a translator (signature extractor), and a language strategy (import patterns + call queries)
- The translator is the hard part — ~400 lines of language-specific AST walking per language
- The strategy pattern makes adding languages additive, but each one is still ~300 lines of work

**When this hurts:** Teams with mixed codebases (e.g., TypeScript frontend + C# backend). The backend changes would be invisible to Diff-Guardian.

### No type-level analysis

**What:** The classifier compares signatures structurally (parameter names, types as strings, optional flags). It doesn't resolve type aliases, generics, or inheritance.

**Why?**
- Type resolution requires a full language server or compiler — `tsc`, `pyright`, `javac` — each taking seconds to initialize
- Structural comparison catches 90%+ of real breaking changes
- The false-negative rate (missed breaks due to type aliasing) is low in practice

**When this hurts:** Complex generic constraints, conditional types, or inheritance hierarchies where `ParentType` changes break children.

### No cross-file signature tracking

**What:** Each file is parsed independently. If `file A` defines a type that `file B` uses as a parameter type, changing that type in `file A` won't be detected as affecting `file B`'s signature.

**Why?**
- Cross-file analysis requires a full dependency graph — the exact thing JIT tracing is designed to avoid
- The classifier only compares the same symbol before/after within the same file

**When this hurts:** Shared types that change (e.g., a `Config` interface used as a parameter type in 20 functions across 10 files).

---

## 2. What You'd Improve

In interviews, "what would you improve?" shows self-awareness and forward thinking.

### IDE integration

**Current:** CLI-only. Developers run `npx dg` manually or via git hooks.

**Improvement:** A VS Code extension that shows breaking change annotations inline, red squiggles on broken call sites, and a sidebar with blast radius visualization.

**Challenge:** The extension would need to run the tracer on every save, which means sub-50ms latency requirement. The current pipeline is already fast enough, but the extension lifecycle management (activation, deactivation, file watching) is the real complexity.

### Parallel tracing with worker threads

**Current:** Sequential file-by-file tracing.

**Improvement:** Use Node.js `worker_threads` to parse multiple files concurrently, each with their own WASM instance (not shared heap).

**Challenge:** Each worker needs its own `Parser` and `WasmLanguage` instance (~10ms init per worker). For 3 files, the init cost exceeds the savings. Only worth it for 50+ files.

### Semantic versioning suggestions

**Current:** The tool says "breaking change detected" but doesn't suggest what SemVer bump is needed.

**Improvement:** Aggregate all changes and suggest: "This PR requires a major version bump (2 breaking changes) or minor bump (5 additions)."

**Challenge:** Not all repos use SemVer. The suggestion would need to be configurable and context-aware (monorepo packages each have their own version).

### Cross-file type tracking

**Current:** Each file analyzed independently.

**Improvement:** Build a lightweight type graph for shared types, so changing `Config` in `types.ts` flags all functions that use `Config` as a parameter type.

**Challenge:** This approaches "building a compiler" territory. The graph needs to be invalidated on every change, and the resolution rules differ per language.

---

## 3. How It Scales — And Where It Doesn't

### Where it scales well

| Dimension | Why it scales |
|---|---|
| **Number of files in repo** | `git grep` uses the index, O(log n) on sorted file list |
| **Number of languages** | Strategy pattern — add new languages without touching core |
| **Number of rules** | Individual rule files — add new rules without touching engine |
| **PR size (changed files)** | JIT tracing only processes files that import broken symbols |
| **CI parallelism** | Each PR runs independently, no shared state |

### Where it doesn't scale

| Dimension | Why it breaks | Mitigation |
|---|---|---|
| **Very common symbols** | `format` matches 10,000 files | `maxGrepResults: 500` cap |
| **Deep barrel chains** | 10+ layers of re-exports | `maxBarrelDepth: 10` cap |
| **Massive PRs** (500+ files) | Phase 1 (`git diff`) becomes slow | `pathFilter` to scope analysis |
| **Monorepo with many packages** | Each package analyzed independently | Future: package-aware mode |
| **Binary files / large blobs** | `git show` loads entire file into memory | `MAX_BUFFER: 10MB` cap |

### Performance benchmarks (approximate)

| Repo size | PR size | Total time | Bottleneck |
|---|---|---|---|
| 1,000 files | 5 files | ~200ms | Git diff |
| 10,000 files | 20 files | ~400ms | AST parsing |
| 50,000 files | 50 files | ~800ms | Git grep + tracing |
| 100,000 files | 100 files | ~2s | Git diff on large repo |

---

## 4. Testing Strategy

### Vitest

The project uses [`Vitest`](https://vitest.dev/) (configured in `package.json`):

```json
"test": "vitest"
```

**Why Vitest over Jest?**
- Native TypeScript support — no `ts-jest` transformer needed
- ESM-first — works with the project's module system
- Fast — Vite's transform pipeline is faster than Jest's
- Compatible — same `describe/it/expect` API

### Test levels

| Level | What it tests | Example |
|---|---|---|
| **Unit** | Individual rules, translators, utility functions | "R01 detects param_removed" |
| **Integration** | Phase-to-phase data flow | "Parser → Classifier produces correct FunctionChange[]" |
| **E2E** | Full pipeline from git diff to report | "Real repo with known breaking change produces expected output" |

### WASM in tests

Tree-sitter grammars need to be loaded in test environments. This requires:
1. Running `npm run build:grammars` before tests
2. `Parser.init()` in test setup (initializes the WASM runtime)
3. Tests use `grammar.parser.parse(sourceCode)` to get real ASTs

### Fixture-based testing

Translators are tested with fixture files — small source code snippets with known signatures:

```typescript
const input = `
  export function processPayment(amount: number, currency?: string): void {}
`;
const signatures = extractTypeScriptSignatures(parse(input));
expect(signatures.get('processPayment').params).toHaveLength(2);
expect(signatures.get('processPayment').params[1].optional).toBe(true);
```

---

## 5. The 30-Second Pitch

> "Diff-Guardian is a CLI tool I built that detects breaking API changes in git diffs. You run `npx dg` on a PR and it tells you which function signatures changed, whether callers will break, and which call sites have already been fixed. It supports 5 languages, uses tree-sitter for fast AST parsing, and has a JIT tracer that finds every importer of a broken function in under 100ms. It integrates into GitHub Actions as a PR comment."

---

## 6. The 2-Minute Walkthrough

> "The tool is a 6-phase pipeline. Phase 1 extracts old and new source code from git using plumbing commands like `git show` and `git diff`. Phase 2 parses both versions into syntax trees using tree-sitter WASM grammars and extracts structural signatures — function parameters, return types, export status.
>
> Phase 3 is the classifier — it runs 26 rules that compare old vs new signatures. For example, R01 checks if a parameter was removed, R03 checks if a required parameter was added. Each rule assigns a severity: breaking, warning, or safe.
>
> Phase 4 is the most interesting part — the JIT tracer. For each breaking change, it uses `git grep` to find all files mentioning the symbol (50ms), then regex patterns to confirm actual imports (2ms), then tree-sitter to count arguments at each call site (20ms). It detects when a developer has already fixed a call site in the same PR by comparing old and new ASTs.
>
> Phase 5 aggregates results into breaking/warning/safe buckets. Phase 6 renders the output — either terminal colors for local use, a markdown PR comment for GitHub Actions, or raw JSON for downstream tooling."

---

## 7. The 5-Minute Deep Dive

Use the 2-minute walkthrough, then extend with:

> "The key design decision is the lazy graph. The naive approach is to parse every file and build a full call graph — that takes 16 minutes on a 50,000-file repo. Instead, we only trace symbols that are actually broken. `git grep --word-regexp` is the fast filter — it reads from the git index, not the filesystem, so it's ~50ms on any repo size. Then language-specific regex patterns classify each match as a direct import, barrel re-export, or false positive.
>
> The architecture uses the Strategy pattern for multi-language support. Each language implements `LanguageStrategy` — with import regex patterns for the scanner and tree-sitter S-expression queries for the tracer. Adding a new language means creating one file and registering it. Zero changes to the scanner or tracer.
>
> For the 'no false positives' guarantee: spread arguments are always marked indeterminate. Aliased imports are tracked through the localName field. Namespace imports use `verifyCallTarget()` to check the object, not just the method name. And overloaded functions use a Set of valid argument counts instead of a single expected count.
>
> The CI integration posts a PR comment via the GitHub REST API using an upsert pattern — the comment has a hidden HTML marker so subsequent pushes update the existing comment instead of creating a new one. Exit code is always 0 in CI — advisory mode. Locally, it's strict mode with exit code 1 for breaking changes. The philosophy is that developers should be informed, not blocked."

---

## 8. Handling "Why not just use X?"

### "Why not use the TypeScript compiler?"

> "Three reasons. First, it only works for TypeScript — we support 5 languages. Second, `tsc` initialization takes 5+ seconds. Third, we don't need full type resolution — structural comparison of signatures catches 90%+ of breaking changes. Tree-sitter gives us the same structural information at 100x the speed."

### "Why not use ESLint?"

> "ESLint is a linter — it checks code quality within a single file. Diff-Guardian is a diff analyzer — it compares two versions of a function's API surface and finds callers that would break. They're complementary tools. ESLint can't tell you that adding a required parameter to `processPayment` will break 47 call sites across 12 files."

### "Why not use semver-check / api-extractor / etc.?"

> "Most existing tools focus on package-level API surface detection — they compare `.d.ts` files between versions. Diff-Guardian goes deeper: it traces into your actual codebase to find specific call sites that will break, counts the arguments, and tells you which callers have already been fixed. It's the blast radius analysis that other tools don't do."

### "Why build this instead of using a monorepo tool like Turborepo?"

> "Turborepo solves build orchestration — which packages need to be rebuilt when files change. Diff-Guardian solves API contract enforcement — when a function signature changes, which callers break. They operate at different levels. Turborepo tells you which packages to build. Diff-Guardian tells you which call sites need to be updated."

---

## 9. Handling "How does it scale?"

> "Three dimensions. Repo size: `git grep` uses the git index, which is O(log n) on a sorted file list — it's 50ms on 50,000 files. PR size: the JIT tracer only processes files that import broken symbols, so a 100-file PR with 3 breaking changes still traces under 100ms. Languages: the Strategy pattern makes it O(1) per file — look up the strategy by extension. The performance caps (500 grep results, 100 tracer files, 10 barrel depth) prevent pathological cases from causing timeouts."

---

## 10. Common Interview Follow-ups

### "What was the hardest bug?"

> "Barrel file cycles. When file A re-exports from B and B re-exports from A, the naive recursive approach loops infinitely. The fix was BFS with a visited Set for cycle detection, plus a depth limit for runaway barrel chains. The depth limit was tricky to tune — Angular-style libraries can have 5+ layers of barrels, but anything over 10 is almost certainly a cycle."

### "What would you do differently?"

> "I'd add incremental caching from the start. Right now, every run re-parses from scratch. For large repos, caching the signature map by content hash (SHA) would skip Phase 2 entirely for unchanged files. The design already supports this — `git show <sha>:path` gives content-addressable access — but the implementation would need a cache storage layer and invalidation logic."

### "How do you ensure correctness?"

> "Three layers. Unit tests for each of the 26 classifier rules with fixture files — known inputs and expected outputs. Integration tests for the parser → classifier pipeline. And the 'no false positives' guarantee in the tracer: spread = indeterminate (never broken), alias tracking, namespace verification. I'd rather miss a real problem than flag a false one — false positives erode trust in the tool faster than anything."

### "What's the performance profile?"

> "The pipeline is dominated by I/O, not computation. Phase 1 (git diff + git show) takes ~100ms — that's the git subprocess overhead. Phase 2 (AST parsing) takes ~50ms for a typical PR. Phase 3 (classification) is negligible — it's just Map comparisons. Phase 4 (JIT tracing) takes ~70ms. Total: under 300ms for most PRs. The only way to meaningfully improve this is to eliminate the git subprocess calls, which would require a git library binding instead of shell exec."

---

## 11. The Complete Architecture Diagram

```
Developer runs: npx dg compare main

┌──────────────────────────────────────────────────────────────┐
│                        CLI (cli.ts)                          │
│  minimist → route → build ReporterConfig → call pipeline     │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    Pipeline (pipeline.ts)                     │
│                                                              │
│  Phase 1: extractGitSources()                                │
│    └─ git diff → git show → FileDiff[]                       │
│                                                              │
│  Phase 2: ASTMapper.buildSignatureCache()                    │
│    └─ tree-sitter parse → translator → Map<string, Sig>      │
│    └─ Per language: ts.ts, py.ts, java.ts, go.ts, rust.ts    │
│                                                              │
│  Phase 3: ClassifierEngine.compare()                         │
│    └─ 26 rules (R01–R28) → FunctionChange[]                 │
│                                                              │
│  Phase 4: JIT Tracing                                        │
│    ├─ isTraceable() gate                                     │
│    ├─ computeParamCounts() / computeEnumMetadata()           │
│    ├─ Scanner: git grep → classifyFile → walkBarrels         │
│    │   └─ LanguageStrategy.buildImportPatterns()             │
│    └─ Tracer: extractCallSites → correlateByIndex            │
│        └─ LanguageStrategy.callExpressionQueries             │
│                                                              │
│  Phase 5: Aggregate → AnalysisResult                         │
│    └─ { breaking[], warnings[], apiChanges[] }               │
│                                                              │
│  Phase 6: Report                                             │
│    ├─ TerminalReporter → chalk-colored stdout                │
│    ├─ GithubReporter → PR comment via REST API               │
│    └─ JsonReporter → JSON.stringify to stdout                │
└──────────────────────────────────────────────────────────────┘
```

---

## 12. Final Summary

Diff-Guardian is a **6-phase pipeline** that:

1. **Extracts** old and new source from git
2. **Parses** both into structural signatures via tree-sitter
3. **Classifies** changes across 26 rules
4. **Traces** blast radius with a JIT 2-tier engine
5. **Aggregates** into severity buckets
6. **Reports** via terminal, GitHub PR comment, or JSON

The key innovations:
- **JIT tracing** — 16,000x faster than full graph analysis
- **Strategy pattern** — 5 languages with zero duplication in core logic
- **No false positives** — conservative classification with graceful degradation
- **Advisory CI** — inform developers, don't block them

---

*🎓 All 14 topics complete! You've covered the entire Diff-Guardian codebase from git internals to interview mastery.*
