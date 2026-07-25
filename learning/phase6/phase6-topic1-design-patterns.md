# Phase 6, Topic 1: Design Patterns & Engineering Decisions

This topic examines the **architectural patterns** and **engineering trade-offs** that make Diff-Guardian work. These are the patterns you'd talk about in a system design interview to show you understand not just *what* the code does, but *why* it's structured that way.

---

## 1. Strategy Pattern — Multi-Language Support

### The pattern

The [`LanguageStrategy`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/types.ts#L105-L235) interface is the most important design pattern in the project. It decouples the scanner and tracer from language-specific syntax:

```
┌──────────────────┐     ┌──────────────────┐
│     Scanner      │────▶│ LanguageStrategy  │ ◀── Interface
│  (language-free) │     └──────────────────┘
└──────────────────┘              ▲
                        ┌────────┼────────┐
                   ┌────┴───┐ ┌──┴──┐ ┌───┴───┐
                   │   TS   │ │ Py  │ │ Java  │ ...
                   └────────┘ └─────┘ └───────┘
```

### Why it matters

Without the strategy pattern, every function in scanner.ts and tracer.ts would have a giant `switch` statement:

```typescript
// BAD: without strategy pattern
function detectImport(filePath, symbolName) {
  if (filePath.endsWith('.ts')) {
    // 50 lines of TS import regex
  } else if (filePath.endsWith('.py')) {
    // 50 lines of Python import regex
  } else if (filePath.endsWith('.java')) {
    // 40 lines of Java import regex
  }
  // ... every new language touches this function
}
```

With the strategy pattern, adding a language is **additive** — create a new file, register it, done. Zero changes to scanner.ts or tracer.ts. This is the **Open/Closed Principle** in action.

### The registry

```typescript
const strategyRegistry = new Map<Language, LanguageStrategy>([
  ['typescript',  typescriptStrategy],
  ['javascript',  typescriptStrategy],  // shared
  ['python',      pythonStrategy],
  ['java',        javaStrategy],
  ['go',          goStrategy],
  ['rust',        rustStrategy],
]);
```

Note that TypeScript and JavaScript share the same strategy instance — they have the same module system. This is a natural consequence of the pattern: strategies are about behavior, not file extensions.

---

## 2. Pipeline / Chain Pattern

### The pattern

The entire tool is a **6-phase linear pipeline**:

```
Phase 1: Git Source Extraction
    │  FileDiff[]
    ▼
Phase 2: AST Parsing → Signature Maps
    │  ParseResult[]
    ▼
Phase 3: Classification (26 rules)
    │  FunctionChange[]
    ▼
Phase 4: JIT Tracing (Scanner + Tracer)
    │  FunctionChange[] with callers[]
    ▼
Phase 5: Aggregation
    │  AnalysisResult
    ▼
Phase 6: Reporting (Terminal / GitHub / JSON)
```

### Why linear and not a DAG?

Each phase depends on the previous phase's output and adds to it. There's no parallelism between phases because each one needs the full output of the previous one. This makes the pipeline:

- **Easy to reason about** — data flows in one direction
- **Easy to debug** — you can log the output after any phase
- **Easy to test** — each phase has a clear input/output contract

### Data enrichment at each phase

```
Phase 1: Raw text (old + new file contents)
Phase 2: Structured data (signature Maps)
Phase 3: Semantic data (what changed, severity)
Phase 4: Impact data (who calls it, are they broken?)
Phase 5: Categorized data (breaking/warning/safe buckets)
Phase 6: Rendered output (terminal colors, markdown, JSON)
```

Each phase adds information that the previous phase couldn't compute. Phase 3 can't know who calls a function — that's Phase 4's job. Phase 4 can't know if a change is breaking — that's Phase 3's job.

---

## 3. Visitor Pattern — AST Tree Walking

### The pattern

The translators (Phase 2) and the enum tracer (Phase 4) use recursive tree walking:

```typescript
function walkMemberExpression(node, enumName, memberSet, filePath, accesses) {
  // Visit this node
  if (node.type === 'member_expression') {
    const object = node.childForFieldName('object');
    const property = node.childForFieldName('property');
    if (object.text === enumName && memberSet.has(property.text)) {
      accesses.push({ filePath, memberName: property.text, ... });
    }
  }

  // Recursively visit children
  for (let i = 0; i < node.childCount; i++) {
    walkMemberExpression(node.child(i), enumName, memberSet, filePath, accesses);
  }
}
```

This is a depth-first traversal of the syntax tree. Each translator (TypeScript, Python, Go, etc.) walks the tree looking for specific node types.

### Why not tree-sitter queries for everything?

Tree-sitter S-expression queries work great for **pattern matching** (find all `call_expression` nodes). But they're limited for **structural extraction** (extract all parameters from a function declaration, handling nested defaults, rest params, decorators, etc.). The translators need to walk the tree and extract complex nested structures, which requires the visitor pattern.

---

## 4. Factory Pattern — Default Configuration

### The pattern

```typescript
function createDefaultTracerConfig(
  repoRoot: string,
  headSha:  string = 'HEAD',
  overrides?: Partial<TracerConfig>,
): TracerConfig {
  return {
    tracerLanguages: ['typescript', 'javascript'],
    maxGrepResults: 500,
    maxBarrelDepth: 10,
    maxTracerFiles: 100,
    traceOnlyBreaking: true,
    repoRoot,
    headSha,
    ...overrides,
  };
}
```

The factory provides sensible defaults while allowing customization via the spread operator. The caller can override any field:

```typescript
const config = createDefaultTracerConfig(repoRoot, 'HEAD', {
  maxTracerFiles: 50,  // override just this one
});
```

---

## 5. Lazy Evaluation — JIT Tracing

### The pattern

The JIT tracer is a textbook example of lazy evaluation:

```
Eager (AOT):  Parse ALL files → Build FULL call graph → Query it
Lazy (JIT):   Only parse files that import BROKEN symbols
```

Three levels of laziness:

1. **Symbol-level**: Only trace symbols that are `isTraceable()` — skip safe additions, modifier changes
2. **File-level**: Only parse files that `git grep` + regex confirmed as importers
3. **Grammar-level**: Only load WASM grammars for languages actually encountered

```typescript
// Level 1: Symbol-level
if (!isTraceable(change)) continue;

// Level 2: File-level (scanner already filtered)
const importers = await scanner.scan(symbolName, sourceFile);

// Level 3: Grammar-level
const grammar = await getGrammar(strategy);  // loads only if not cached
```

### Performance impact

```
Eager approach: 50,000 files × 20ms parse = 16 minutes
Lazy approach:  3 files × 20ms parse = 60ms
```

That's a **16,000x speedup** — the difference between "CI takes 16 minutes" and "CI takes 100ms".

---

## 6. Performance Decisions

### Sequential WASM parsing (not parallel)

```typescript
// Sequential — one file at a time
for (const diff of diffs) {
  results.push(await this.processDiff(diff));
}
```

**Why not `Promise.all()`?** Tree-sitter's WASM runtime uses a single shared heap. Concurrent parsing causes non-deterministic heap fragmentation and occasional crashes. Sequential parsing keeps memory usage flat and predictable. At 100k lines/sec, the sequential approach is still fast enough — parallelism would add complexity for negligible throughput gain.

### `git grep` vs file system scanning

```
git grep:      ~50ms on 50,000 files (uses git index)
fs.readdir:    ~500ms on 50,000 files (traverses filesystem)
grep -r:       ~200ms on 50,000 files (reads files from disk)
```

`git grep` is 4–10x faster because it reads from the git index (an in-memory sorted file list) instead of the filesystem. It also automatically excludes `node_modules`, `.git`, and binary files.

### Performance caps

Every unbounded operation has a cap:

| Cap | Default | Why |
|---|---|---|
| `maxGrepResults` | 500 | Common names like `format` match thousands of files |
| `maxBarrelDepth` | 10 | Angular-style libs can have 5+ barrel layers |
| `maxTracerFiles` | 100 | A utility function might be imported by 500 files |
| `MAX_BUFFER` | 10 MB | Prevents OOM on massive git diff output |

Without these caps, the tool would hang or OOM on large monorepos. With them, it degrades gracefully — showing the first N results instead of crashing.

---

## 7. Error Isolation Pattern

Every external operation is wrapped in try/catch with non-fatal fallback:

```typescript
// Scanner: one bad file doesn't crash the scan
try {
  content = await this.getFileContent(filePath);
} catch (err) {
  console.warn(`[scanner] Failed to read "${filePath}": ${err.message}`);
  return;  // skip, continue
}

// Pipeline: tracer failure doesn't block results
try {
  await tracer.init();
} catch (err) {
  console.warn(`Call-site tracer initialization failed: ${err.message}`);
  return;  // skip tracing, still produce classifier output
}

// GitHub reporter: API failure doesn't block pipeline
try {
  await upsertComment(config, markdown);
} catch (e) {
  console.warn(`Failed to post PR comment: ${e.message}`);
  // pipeline continues, exit code not affected
}
```

The philosophy: **degrade gracefully, never crash**. The classifier output (Phase 3) is always correct and complete. The tracer (Phase 4) and reporter (Phase 6) are enrichment layers — if they fail, the core analysis is still valid.

---

## 8. The Layered Architecture

From Phase 2, the dependency layers:

```
┌─────────────────────────────────────────┐
│             CLI (cli.ts)                │  ← Top layer: user input
├─────────────────────────────────────────┤
│          Pipeline (pipeline.ts)         │  ← Orchestration
├─────────────────────────────────────────┤
│  Reporters    │  Classifier  │  Tracer  │  ← Feature modules
├───────────────┤──────────────┤──────────┤
│            Parsers (git-diff, ast-mapper)│  ← Data extraction
├─────────────────────────────────────────┤
│         Core (types, constants, utils)  │  ← Foundation
└─────────────────────────────────────────┘
```

**Rules:**
- Upper layers import from lower layers, never the reverse
- `core/types.ts` is imported by everyone, imports from nobody
- Feature modules (classifier, tracer, reporters) don't import from each other
- Only `pipeline.ts` orchestrates the interaction between modules

---

## 9. The Rule System Architecture

The classifier uses 26 individual rule files (`R01` through `R28`), each implementing a common interface:

```typescript
interface ClassifierRule {
  id:          string;       // "R01"
  name:        string;       // "param_removed"
  target:      string;       // "function" | "interface" | "enum"
  description: string;
  apply(before, after): FunctionChange | null;
}
```

### Why individual files?

Each rule is a self-contained unit with its own:
- Detection logic
- Severity assignment
- Human-readable message generation

Having 26 rules in one file would be a 2000+ line monster. Individual files let you:
- Test each rule independently
- Enable/disable rules via config (future feature)
- Add new rules without touching existing ones
- Code review rules individually

### The engine's dispatch

```typescript
class ClassifierEngine {
  compare(parseResult: ParseResult): FunctionChange[] {
    // For each symbol in old → check against new
    for (const [key, oldSig] of oldSignatures) {
      const newSig = newSignatures.get(key);
      // Route to correct rule bucket based on key format
      if (key.startsWith('interface:')) {
        changes.push(...this.applyInterfaceRules(oldSig, newSig));
      } else if (key.startsWith('enum:')) {
        changes.push(...this.applyEnumRules(oldSig, newSig));
      } else {
        changes.push(...this.applyFunctionRules(oldSig, newSig));
      }
    }
  }
}
```

This is where the map key format (from the earlier lesson) pays off — `key.startsWith('interface:')` is O(1) routing.

---

## 10. Key Engineering Trade-offs

| Decision | What we chose | What we gave up | Why |
|---|---|---|---|
| **Sequential parsing** | Flat memory, no WASM heap bugs | ~2x potential speedup | Reliability > speed for a CI tool |
| **JIT tracing** | 100ms for 3 files | Full dependency graph | We only need the broken subgraph |
| **String union types** | Simple JS output, JSON-friendly | Enum member iteration | Enums add unnecessary complexity |
| **minimist** | 5KB, 0 deps | Auto-generated help | CLI is simple enough |
| **`git show` for file content** | Consistent committed content | Working tree changes | Pipeline must be deterministic |
| **Advisory CI mode** | Developers don't bypass the tool | Automatic merge blocking | Trust > enforcement |
| **No incremental caching** | Simpler code, no cache invalidation | ~50ms on cache hits | Cold analysis is already <100ms |

---

## 11. Interview Angle

> **"What design patterns does this project use?"**
>
> "Five main patterns. Strategy pattern for multi-language support — each of the 5 languages has its own strategy with import regex, AST queries, and argument counting logic. Pipeline pattern for the 6-phase analysis. Visitor pattern for recursive AST tree walking in the translators. Factory pattern for creating default configs with overrides. And lazy evaluation throughout — the JIT tracer only parses files that import broken symbols, grammars are loaded on first use, and queries are compiled once per session."

> **"What's the most interesting engineering decision?"**
>
> "The JIT tracer. The naive approach is to build a full call graph by parsing every file in the repo — that takes 16 minutes. Instead, we use `git grep` as a fast filter to find the 15 files that mention a broken symbol (50ms), then regex to confirm actual imports (2ms), then tree-sitter to count arguments at each call site (20ms). Total: under 100ms. The key insight is that you don't need the full dependency graph — you only need the subgraph reachable from broken symbols."

---

*Next: [Phase 6, Topic 2 — Trade-offs, Scalability & Interview Q&A](./phase6-topic2-tradeoffs-interview.md)*
