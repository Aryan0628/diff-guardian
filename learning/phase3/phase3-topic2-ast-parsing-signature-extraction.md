# Phase 3, Topic 2: AST Parsing & Signature Extraction (`ast-mapper.ts` + Translators)

Welcome to the biggest topic in Phase 3. This is where raw source code becomes structured data. The code lives in [`src/parsers/ast-mapper.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts) and the [`src/parsers/translators/`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/translators) directory.

## What Happens in This Phase?

In Topic 1, we got the raw source text for every changed file — old version and new version. Now we need to answer: **"What functions, interfaces, enums, and type aliases exist in this code, and what do they look like?"**

The answer to that question is called a **Signature** — a structured representation of a symbol's shape (its name, parameters, return type, modifiers, etc.).

```
                      Phase 1 (git-diff.ts)          Phase 2 (ast-mapper.ts + translators)
                    ┌─────────────────┐             ┌──────────────────────────────┐
  git diff          │ "Here are the   │             │ "Here is every function,     │
  main..feature ──► │  files that     │ FileDiff[] ──► interface, and enum in     │
                    │  changed"       │             │  each file — structured"     │
                    └─────────────────┘             └──────────────────────────────┘
                                                              │
                                                        ParseResult[]
                                                              │
                                                              ▼
                                                    Phase 3 (classifier)
```

---

## 1. The ASTMapper Class — The Orchestrator

The [`ASTMapper`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts#L49-L329) class doesn't parse code itself. It **orchestrates** everything:

1. Loads the correct WASM grammar for the file's language
2. Parses the source text into a Tree-Sitter tree
3. Dispatches the tree to the correct **translator** for signature extraction
4. Injects the `filePath` into every signature (the translator has no file context)
5. Frees WASM memory safely in a `finally` block

### The Lifecycle: `init()` → `buildSignatureCache()`

```typescript
// Step 1: Initialise the WASM runtime — MUST be called before anything else
const mapper = new ASTMapper();
await mapper.init();

// Step 2: Convert FileDiff[] into ParseResult[]
const results = await mapper.buildSignatureCache(diffs);
```

**Why is `init()` separate?** Because `Parser.init()` initialises the entire WebAssembly runtime — this is heavy (loads WASM binaries, allocates memory). By making it explicit, the caller controls when this happens and it's clear that it's async.

**Idempotency:** If you call `init()` twice, the second call is a no-op (`if (this.parser) return`). This prevents double-initialisation bugs.

---

## 2. Sequential Processing — Why Not Parallel?

Look at [`buildSignatureCache()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts#L88-L102):

```typescript
async buildSignatureCache(diffs: FileDiff[]): Promise<ParseResult[]> {
    const results: ParseResult[] = [];
    for (const diff of diffs) {
        results.push(await this.processDiff(diff));
    }
    return results;
}
```

**Wait — why a sequential `for` loop instead of `Promise.all()`?** In Topic 1, we used `Promise.allSettled()` for git commands. Why not here?

The answer is **WASM heap fragmentation**:
- Tree-Sitter parses at ~100,000 lines per second — it's already blazing fast
- Concurrent parsing would mean multiple WASM trees allocated simultaneously
- WASM memory is a single contiguous buffer. Concurrent allocations and frees cause **non-deterministic fragmentation** — memory usage becomes unpredictable
- Sequential parsing keeps memory perfectly flat: allocate tree → extract → free → next file
- The performance gain from concurrency would be negligible (Tree-Sitter is CPU-bound, not I/O-bound like `git show`)

**Interview insight:** This is a great example of knowing when NOT to parallelise. The `for` loop is a deliberate engineering decision, not a mistake.

---

## 3. Per-File Processing: `processDiff()`

For each file, [`processDiff()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts#L106-L142) does:

```
FileDiff → determine language → load grammar → parse old source → parse new source → ParseResult
```

```typescript
private async processDiff(diff: FileDiff): Promise<ParseResult> {
    // 1. Map file extension to language
    const language = EXTENSION_TO_LANGUAGE[`.${diff.language}`];
    if (!language) return this.skipped(diff.path, `unsupported extension`);

    // 2. Load the WASM grammar (cached after first load)
    const lang = await this.getLanguage(language);

    // 3. Swap the parser's grammar — one shared parser instance
    this.parser!.setLanguage(lang);

    // 4. Extract signatures from BOTH old and new source
    const oldSigs = this.extractFromSource(diff.oldSource, ...);
    const newSigs = this.extractFromSource(diff.newSource, ...);

    return { file: diff.path, language, oldSigs, newSigs, skipped: false };
}
```

**Key insight:** There is only **one** `Parser` instance, shared across all files. We just swap the language when the file type changes. This saves memory — each WASM `Parser` allocates its own memory buffer.

---

## 4. Grammar Loading & The Thundering Herd Prevention

The [`getLanguage()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts#L251-L272) method manages WASM grammar loading with a **three-layer caching strategy**:

```typescript
private async getLanguage(code: string): Promise<WasmLanguage> {
    // Layer 1: Already loaded — O(1) Map lookup
    if (this.languages.has(code)) {
        return this.languages.get(code)!;
    }

    // Layer 2: Currently loading — wait for in-flight promise
    // PREVENTS THUNDERING HERD
    if (this.loadingLanguages.has(code)) {
        return this.loadingLanguages.get(code)!;
    }

    // Layer 3: First request — start the load
    const loadPromise = this.loadGrammar(code).finally(() => {
        this.loadingLanguages.delete(code); // Clean up
    });
    this.loadingLanguages.set(code, loadPromise);
    return loadPromise;
}
```

### What is a "Thundering Herd"?

Imagine a PR that changes 10 TypeScript files. Without Layer 2, all 10 would simultaneously try to load `tree-sitter-typescript.wasm` — 10 concurrent file reads, 10 WASM compilations, massive memory waste.

With the `loadingLanguages` Map, the **first** file triggers the load. Files 2–10 find the in-flight Promise in Layer 2 and just `await` it. Only one WASM binary is ever loaded.

### Why `__dirname` instead of `process.cwd()`?

```typescript
const wasmPath = path.resolve(__dirname, '..', '..', 'grammars', wasmFilename);
```

`process.cwd()` is wherever the user ran the command from — it changes. `__dirname` always points to the directory of the compiled `.js` file. This matters when `diff-guardian` is installed as a global npm package or used as a library — `process.cwd()` would be the user's project, not diff-guardian's directory.

---

## 5. `extractFromSource()` — Parsing and Memory Safety

This is where Tree-Sitter actually runs. Look at [`extractFromSource()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts#L154-L204):

```typescript
private extractFromSource(source: string, ext: string, lang: WasmLanguage, filePath: string): RawSignatureMap {
    if (!source || source.trim() === '') return new Map();

    let tree: Tree | null = null;

    try {
        tree = this.parser!.parse(source);
        if (!tree) return new Map();

        // Parse errors? Warn but continue — partial results > no results
        if (tree.rootNode.hasError) {
            console.warn(`Parse errors in "${filePath}" — signatures may be incomplete`);
        }

        const rawMap = this.dispatch(tree, ext, lang);

        // Inject filePath into every FunctionSignature
        for (const [key, sig] of rawMap.entries()) {
            if (!key.includes(':')) {
                (sig as FunctionSignature).filePath = filePath;
            }
        }

        return rawMap;

    } finally {
        // CRITICAL: ALWAYS free WASM memory
        tree?.delete();
    }
}
```

### Three critical design decisions:

**1. `tree.delete()` in `finally`:**
WASM-allocated trees are NOT garbage collected by JavaScript's GC. If you forget to call `tree.delete()`, the WASM heap grows until it runs out of memory. The `finally` block guarantees cleanup even if the translator throws an error.

**2. Partial results on parse errors:**
If the source has syntax errors, Tree-Sitter still produces a tree with an ERROR node at the root. Instead of bailing out, we continue — the classifier handles missing signatures gracefully. Partial analysis is better than no analysis.

**3. filePath injection:**
The translator is a **pure function** — it receives an AST tree and returns signatures. It has no knowledge of file paths. The `ASTMapper` is the layer that knows both the filename and the signature, so it injects `filePath` after the translator returns. Keys without a colon (`:`) are function signatures; keys with colons are interfaces/enums/types.

---

## 6. The `dispatch()` Method — Language Routing

[`dispatch()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts#L219-L247) routes the parsed tree to the correct translator:

```typescript
private dispatch(tree: Tree, ext: string, lang: WasmLanguage): RawSignatureMap {
    switch (ext) {
        case 'ts': case 'tsx': case 'js': case 'jsx':
            return extractTSSignatures(tree, lang);   // TS handles JS too
        case 'py':
            return extractPySignatures(tree, lang);
        case 'go':
            return extractGoSignatures(tree, lang);
        case 'java':
            return extractJavaSignatures(tree, lang);
        case 'rs':
            return extractRustSignatures(tree, lang);
        default:
            return new Map();
    }
}
```

**Why does TypeScript handle JS/JSX/TSX?** Tree-Sitter's TypeScript grammar is a superset of its JavaScript grammar. The same node types (`function_declaration`, `arrow_function`, etc.) appear in both. Using one translator avoids duplicating ~870 lines of code.

---

## 7. The TypeScript Translator — Deep Dive

The [`typescript.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/translators/typescript.ts) translator is the most complex at 870 lines. Let's walk through its key concepts.

### S-Expression Queries

Tree-Sitter queries use a Lisp-like syntax called S-expressions to structurally search the AST:

```typescript
const FN_QUERY_SRC = `
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    return_type: (type_annotation)? @return
  ) @fn
`;
```

This says: *"Find any `function_declaration` node. Capture its `name` child as `@name`, its `parameters` as `@params`, and its optional `return_type` as `@return`. Capture the whole node as `@fn`."*

The translator uses **6 queries** to find all API-relevant constructs:

| Query | What it finds | Why needed |
|-------|--------------|------------|
| `FN_QUERY_SRC` | Functions, methods, interface method signatures | Core API surfaces |
| `ARROW_QUERY_SRC` | `const fn = () => {}` arrow functions | Common in modern TS/JS |
| `CTOR_QUERY_SRC` | Class constructors | R24: constructor changes |
| `INTERFACE_QUERY_SRC` | Interface declarations | R25/R26: property changes |
| `ENUM_QUERY_SRC` | Enum declarations | R27: member changes |
| `TYPE_ALIAS_QUERY_SRC` | `type X = ...` aliases | Type narrowing detection |

### Query Cache — Compile Once, Reuse Forever

Compiling an S-expression string into WASM bytecode is expensive. The translator uses a module-level cache:

```typescript
let cachedLanguage: Language | null = null;
let cachedQueries: CompiledQueries | null = null;

function getQueries(language: Language): CompiledQueries {
    if (cachedQueries && cachedLanguage === language) {
        return cachedQueries;  // Already compiled — reuse
    }
    disposeQueries();  // Free old WASM memory
    // Compile all 6 queries...
}
```

In production, the `Language` instance never changes (the ASTMapper caches it), so these queries compile **exactly once** across the entire program lifetime.

### Parameter Extraction — The Most Complex Part

The [`extractParams()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/translators/typescript.ts#L499-L645) function handles every TypeScript parameter variant:

| Parameter Pattern | AST Node Type | Example |
|-------------------|---------------|---------|
| Required | `required_parameter` | `x: string` |
| Optional | `optional_parameter` | `x?: string` |
| Default value | `required_parameter` with `value` | `x = 'hello'` |
| Rest | `rest_parameter` | `...args: string[]` |
| Destructured object | `object_pattern` | `{ id, name }: User` |
| Destructured array | `array_pattern` | `[a, b]: number[]` |
| Constructor shorthand | `public_field_definition` | `private name: string` |

Each becomes a `Param` object:
```typescript
interface Param {
    name:          string;    // 'userId', '{...}', '[...]', '...args'
    type:          string;    // 'string', 'User | null'
    optional:      boolean;   // true if ? or has default
    hasDefault:    boolean;   // true if = someValue
    defaultValue?: string;    // the actual default text
    isRest?:       boolean;   // true if ...rest
}
```

**Key subtlety: `optional` vs `hasDefault`:**
- `x?: string` → `optional: true, hasDefault: false`
- `x = 'hi'` → `optional: true, hasDefault: true`
- The classifier uses `hasDefault` to distinguish R01 (param removed) from R05 (optional param added) and R23 (default value changed).

### Return Type: `'inferred'` Sentinel

```typescript
const returnType: string = returnNode
    ? returnNode.text.replace(/^:\s*/, '').trim()
    : 'inferred';
```

When a function has no return type annotation (`function foo() { ... }` instead of `function foo(): string { ... }`), the translator sets `returnType: 'inferred'`. This is a sentinel value — it tells the classifier to **skip** rules R06/R07 (return type widened/narrowed) because there was nothing explicit to compare.

**Critical: NEVER default to `'any'`** — because `any` is a real TypeScript type. If someone writes `function foo(): any`, that's different from having no annotation at all.

### The Signature Map Key Format

The map returned by the translator uses specific key conventions:

| Symbol Type | Key Format | Example |
|-------------|-----------|---------|
| Top-level function | `name` | `processPayment` |
| Instance method | `ClassName#method` | `PaymentService#charge` |
| Static method | `ClassName.method` | `PaymentService.create` |
| Constructor | `ClassName#constructor` | `PaymentService#constructor` |
| Interface | `interface:name` | `interface:UserConfig` |
| Enum | `enum:name` | `enum:Status` |
| Type alias | `type:name` | `type:UserId` |

The colon prefix for non-function types serves two purposes:
1. **Prevents key collisions** — a function and interface can both be named `User`
2. **Enables O(1) routing** — the classifier uses `key.startsWith('interface:')` to dispatch to the correct rule bucket

### Overload Handling

TypeScript supports function overloads:
```typescript
function parse(input: string): AST;
function parse(input: Buffer): AST;
function parse(input: string | Buffer): AST { ... }
```

The translator tracks each overload with an `overloadIndex` (0, 1, 2...) and an `overloadCount`. The **last** signature (the implementation) wins in the Map, but the count is preserved so the classifier can detect overload additions/removals (R15/R16).

---

## 8. Multi-Language Translators

Each language translator follows the same pattern as TypeScript but with language-specific queries and extraction logic:

| Translator | Key Differences |
|-----------|----------------|
| **Python** (`python.ts`) | No type annotations by default → `type: 'any'`. Handles `self`/`cls` first params. Detects `@staticmethod`, `@classmethod`, `@property` decorators. Classes become `InterfaceSignature`. |
| **Go** (`go.ts`) | Methods have receiver types (`func (s *Service) Process()`). No classes — receiver type acts as className. Multiple return values. Exported = capitalised first letter. |
| **Java** (`java.ts`) | Access modifiers (`public`/`private`/`protected`) are first-class. Static methods. Annotations as decorators. No arrow functions. |
| **Rust** (`rust.ts`) | `impl` blocks for methods. `pub` for export. Lifetimes and generics. Trait implementations. `self`/`&self`/`&mut self` receivers. |

**What they all share:**
- Pure functions — no side effects, no file I/O
- Same return type: `Map<string, AnySignature>`
- Same query caching pattern
- Same key conventions (function names, `ClassName#method`, prefix for non-functions)

---

## The Complete Flow

```
FileDiff[]
    │
    ▼
ASTMapper.buildSignatureCache()
    │
    ├── for each diff:
    │     │
    │     ├── getLanguage(code)          ← load WASM grammar (cached)
    │     │     ├── Layer 1: already loaded? return
    │     │     ├── Layer 2: in-flight? wait
    │     │     └── Layer 3: first time? load + cache
    │     │
    │     ├── parser.setLanguage(lang)   ← swap grammar
    │     │
    │     ├── extractFromSource(oldSource)
    │     │     ├── parser.parse(source) → Tree
    │     │     ├── dispatch(tree) → translator
    │     │     │     └── extractTSSignatures / extractPySignatures / ...
    │     │     │           └── Query AST → build FunctionSignature, InterfaceSignature, etc.
    │     │     ├── inject filePath
    │     │     └── tree.delete()        ← WASM memory freed
    │     │
    │     ├── extractFromSource(newSource)  ← same process
    │     │
    │     └── return ParseResult { oldSigs, newSigs }
    │
    ▼
ParseResult[]  →  Classifier Engine (Topic 3)
```

---

## Interview Q&A

### "How does ASTMapper handle multiple languages?"

> "ASTMapper acts as an orchestrator — it doesn't parse code directly. It loads the correct WASM grammar lazily (with three-layer caching and thundering herd prevention), swaps the parser's language per file, and dispatches the parsed AST to a language-specific translator. Each translator is a pure function that takes a Tree-Sitter tree and returns a standardised `Map<string, AnySignature>`. This means adding a new language is a 5-step process without touching existing code."

### "Why sequential parsing instead of parallel?"

> "Tree-Sitter parses at ~100k lines per second — it's CPU-bound, not I/O-bound. Parallel parsing would cause WASM heap fragmentation because the heap is a single contiguous buffer. Sequential processing keeps memory flat and predictable. The throughput gain from parallelisation would be negligible compared to the complexity and memory overhead it introduces."

### "How do you handle WASM memory leaks?"

> "Every `tree.delete()` call is in a `finally` block, so WASM memory is freed even if the translator throws. Query objects are cached at the module level with explicit `disposeQueries()` for cleanup. Grammar instances are cached in the ASTMapper and reused — they're never loaded twice. This gives us deterministic, leak-free memory management."

---

*Next: [Phase 3, Topic 3 — The Classifier Engine](./phase3-topic3-classifier-engine.md)*
