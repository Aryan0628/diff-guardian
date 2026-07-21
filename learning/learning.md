# Diff-Guardian — SDE Interview Prep Curriculum

> **Target:** SDE-1 / New Grad interview. Zero prior knowledge assumed.
>
> **How to use:** Go phase by phase. Say *"let's do Phase 1, Topic 2"* or *"next topic"* and I'll create a detailed session file. Each session will cover concepts from scratch, walk through real code, and end with interview Q&A.

---

## Phase 1: Foundation Concepts
> *The CS fundamentals this project is built on. You need these before touching any code.*

- [x] **Topic 1: ASTs, Parsing & Tree-Sitter** ✅ → [session file](./phase1-topic1-asts-parsing-tree-sitter.md)
  - What parsing is — tokenization (lexing) → tree building
  - Abstract Syntax Trees — what they are, why "abstract", nodes/leaves/root
  - Why regex/grep fails for code analysis (multi-line, comments, false positives)
  - Tree-Sitter specifically — parser generator, incremental parsing, error recovery
  - S-expression queries — how to "search" an AST structurally
  - Why Tree-Sitter over Babel, ESLint parser, SWC, etc.
  - WebAssembly (WASM) — why Tree-Sitter grammars compile to `.wasm`, platform portability
  - The `web-tree-sitter` npm package and how it's loaded at runtime

- [x] **Topic 2: Git Internals for Code Analysis** ✅ → [session file](./phase1-topic2-git-internals.md)
  - Git objects (blobs, trees, commits) — how git actually stores code
  - `git show ref:path` — reading file contents from any commit without checkout
  - `git diff --name-status` — detecting which files changed (M/A/D/R status codes)
  - `git grep` — fast pattern matching across the git index
  - Working tree vs staging area (index) vs committed history
  - Why these primitives matter for Diff-Guardian's source extraction

- [x] **Topic 3: Breaking Changes & API Contracts** ✅ → [session file](./phase1-topic3-breaking-changes.md)
  - What an API contract is — the "promise" a function makes to its callers
  - Semantic versioning (semver) — major/minor/patch and what breaks what
  - Categories of breaking changes: parameter removal, type narrowing, visibility changes, enum mutations
  - Why standard `git diff` can't detect these — it sees text, not structure
  - Real-world examples of silent API breakages that pass code review
  - The gap between "what changed" and "what breaks" — the core motivation for this project

---

## Phase 2: Project Architecture
> *The complete picture — what Diff-Guardian does, how it's built, and how data flows through it.*

- [x] **Topic 1: Problem Statement, Architecture & Data Flow** ✅ → [session file](./phase2-topic1-architecture-data-flow.md)
  - Why Diff-Guardian was built — the specific pain it solves for teams
  - Target users and use cases (OSS maintainers, monorepo teams, CI pipelines)
  - The 6-phase pipeline: Source Extraction → AST Parsing → Classification → Tracer Metadata → JIT Tracing → Reporting
  - How each phase transforms data — the shape of data at every boundary
  - Full data journey: `FileDiff → ParseResult → FunctionChange → AnalysisResult`
  - Tracing one changed file end-to-end through all 6 phases

- [x] **Topic 2: Project Structure & Tech Stack** ✅ → [session file](./phase2-topic2-project-structure-tech-stack.md)
  - Every directory and file — what it does and why it exists
  - Import dependency graph — who imports whom, layering discipline
  - Tech stack: TypeScript, Tree-Sitter WASM, chalk, minimist, Husky, Vitest
  - What alternatives were considered and why they weren't chosen
  - `package.json` deep dive — scripts, bin, dependencies vs devDependencies

---

## Phase 3: The Core Engine — Parsing & Classification
> *The heart of the tool. How source code becomes structured signatures and how signatures get compared.*

- [ ] **Topic 1: Source Extraction (`git-diff.ts`)**
  - `extractGitSources()` — the entry point that produces `FileDiff[]`
  - Parsing `git diff --name-status` output — status codes M/A/D/R
  - Three modes of extraction:
    - Standard: `git show baseSha:path` vs `git show headSha:path`
    - Working tree: old from git, new from `fs.readFileSync()`
    - Staged: old from git, new from `git show :path` (index syntax)
  - Concurrency with `Promise.allSettled()` — why not `Promise.all()`
  - 10MB buffer limit, error isolation, rename detection

- [ ] **Topic 2: AST Parsing & Signature Extraction (`ast-mapper.ts` + Translators)**
  - `ASTMapper` lifecycle: `init()` → `buildSignatureCache()`
  - WASM grammar loading — the `languages` Map, deduplication, thundering herd prevention
  - `extractFromSource()`: parse → dispatch to translator → inject filePath
  - WASM memory management — `tree.delete()` in `finally`
  - The TypeScript translator deep dive:
    - S-expression queries (FN_QUERY_SRC, ARROW_QUERY_SRC, etc.)
    - Parameter extraction: optional, defaults, rest, destructuring
    - Return type: annotation vs `'inferred'`
    - Export detection, class methods, interfaces, enums, overloads
  - Multi-language translators: Python, Go, Java, Rust — what's shared, what's unique
  - The Signature Map: `Map<string, AnySignature>`, key prefixes (`interface:`, `enum:`, `type:`), why O(1) lookup matters

- [ ] **Topic 3: The Classifier Engine — 26 Rules (`engine.ts` + Rules)**
  - `ClassifierEngine.compare()` — the core algorithm:
    - Key union: `new Set([...old.keys(), ...new.keys()])`
    - Case A (deletion), Case B (addition), Case C (modification)
    - `isDeepStrictEqual()` short-circuit, deterministic sort
  - The `Rule<T>` interface — generic contract, `check()` return type, language scoping
  - O(1) key routing — pre-computed rule buckets (`key.startsWith('interface:')`)
  - All 26 rules grouped by category:
    - **Parameter rules** (R01–R05, R12, R14, R18–R19): removed, reordered, added, type changes, mutability
    - **Return type rules** (R06, R07, R22): nullable, narrowed, `never`
    - **Visibility & modifier rules** (R08, R28, R20, R11, R21, R17): export changes, async toggle, static swap
    - **Generic & overload rules** (R13, R15, R16, R23, R24): constraints, overloads, defaults, constructors
    - **Interface, enum & type rules** (R25–R27): property changes, member removal
  - The `FunctionChange` output — `symbolType`, `before`/`after`, `callers`

- [ ] **Topic 4: The Data Contract (`types.ts`, `constants.ts`, `utils.ts`)**
  - The enum foundations: `Language`, `Severity`, `ChangeType`
  - `Param` and `TypeParameter` — representing function arguments
  - Signature types: `FunctionSignature` (15+ fields), `InterfaceSignature`, `EnumSignature`, `TypeAliasSignature`
  - The `AnySignature` union type
  - Output types: `FunctionChange`, `CallSite`, `AnalysisResult`
  - Tracer domain types: `ImportReference`, `GrepMatch`, `TracerResult`, `TracerConfig`
  - Constants: supported extensions, excluded paths, `isTargetFile()`

---

## Phase 4: The JIT Tracer — Blast Radius Engine
> *The most technically impressive part. A two-phase JIT engine that traces who calls a broken function and whether they'll actually break.*

- [ ] **Topic 1: JIT Architecture & The Scanner (`scanner.ts`)**
  - The "Lazy Graph" concept — why not parse the entire codebase?
  - JIT vs AOT analysis — performance: 50ms grep + 20ms trace = <100ms
  - `isTraceable()` — which changes are worth tracing (not all are)
  - Tracer metadata computation: `computeParamCounts()`, `computeEnumMetadata()`
  - The Scanner pipeline: `scan()` → `gitGrep()` → `classifyFile()` → `walkBarrels()`
  - `git grep -n --word-regexp` — why word-boundary matching matters
  - Import classification via language strategy:
    - `buildImportPatterns()` → regex per language
    - `extractAlias()` — resolving `import { fn as alias }`
    - `verifyMatch()` — eliminating false positives
  - Barrel file walking — BFS with cycle detection, depth limits, `findBarrelConsumers()`

- [ ] **Topic 2: Call-Site Tracing & Validation (`tracer.ts`)**
  - `trace()` entry point — the per-file loop
  - `extractCallSites()` — Tree-Sitter query matching with `@callee`, `@args`, `@call` captures
  - `countArguments()` — spread detection
  - `verifyCallTarget()` — namespace verification (`payments.fn()` vs `other.fn()`)
  - Argument validation: `buildValidArgCounts()` as Set, `isValidArgCount()` logic
  - Old↔New correlation:
    - `correlateByIndex()` — 1:1 when call count matches
    - `classifyWithBestEffortCorrelation()` — when calls are added/removed
    - Detecting "Fixed" call sites — developer already updated them
  - Enum tracing: `traceEnum()`, `walkEnumAccess()`, removed vs changed members
  - The Language Strategy pattern:
    - `LanguageStrategy` interface — the full contract
    - Strategy registry, `getStrategyForFile()`, why TS/JS share a strategy
    - How to add a new language (the 5-step process)
  - The "No False Positives" guarantee — spread → indeterminate, alias tracking, namespace verification

---

## Phase 5: CLI, Reporters & CI/CD Integration
> *How users interact with Diff-Guardian — from the terminal command to GitHub PR comments to git hooks.*

- [ ] **Topic 1: CLI, Configuration & Output**
  - `cli.ts` — shebang, `minimist` argument parsing, command routing
  - Smart default mode — CI detection via `GITHUB_ACTIONS` env var
  - Commands: `check`, `compare`, `trace`, `rules`, `init`
  - `WORKING_TREE` and `STAGED` sentinel values
  - Configuration system: `dg.config.json` schema, `loadConfig()`, how config flows into `PipelineOptions`
  - Terminal Reporter: chalk coloring, severity icons (❌ ✅ ⚠️), footer
  - GitHub Reporter: `COMMENT_MARKER` for upsert, `upsertComment()`, markdown tables, `<details>` sections
  - JSON Reporter, `--report-file`, `.dg-report.json`
  - Exit code contract: 0 (clean), 1 (breaking), 2 (infrastructure error)
  - GitHub Actions workflow: `fetch-depth: 0`, WASM caching, `GITHUB_TOKEN` permissions
  - Husky git hooks: `pre-push` (blocks), `pre-merge-commit` (blocks), `post-merge` (advisory)
  - `--no-verify` escape hatch, TTY detection for VS Code

---

## Phase 6: System Design & Interview Mastery
> *How to talk about this project in an interview. Design patterns, trade-offs, and the pitch.*

- [ ] **Topic 1: Design Patterns & Engineering Decisions**
  - Strategy Pattern — `LanguageStrategy` for multi-language support
  - Pipeline/Chain Pattern — the 6-phase pipeline
  - Factory Pattern — `createDefaultTracerConfig()`
  - Visitor Pattern — AST tree walking in translators
  - Lazy Evaluation — JIT tracer (only trace what's broken)
  - Performance decisions: sequential WASM parsing (heap fragmentation), `git grep` vs file scanning, performance caps (`maxGrepResults`, `maxBarrelDepth`, `maxTracerFiles`)

- [ ] **Topic 2: Trade-offs, Scalability & Interview Q&A**
  - Trade-offs made: no incremental caching, sequential tracer, missing languages
  - What you'd improve: IDE integration, parallel tracing, semantic versioning suggestions
  - How it scales — and where it doesn't
  - The 30-second pitch, 2-minute walkthrough, 5-minute deep dive
  - Handling "why not just use X?" questions
  - Handling "how does it scale?" questions
  - Testing strategy: Vitest, unit/integration/E2E, fixtures, WASM in tests

---

## Progress Tracker

| Phase | Topics | Completed |
|-------|--------|-----------|
| Phase 1: Foundations | 3 | 3/3 ✅ |
| Phase 2: Architecture | 2 | 2/2 ✅ |
| Phase 3: Core Engine | 4 | 0/4 |
| Phase 4: JIT Tracer | 2 | 0/2 |
| Phase 5: CLI & Integration | 1 | 0/1 |
| Phase 6: Design & Interview | 2 | 0/2 |
| **Total** | **14** | **5/14** |
