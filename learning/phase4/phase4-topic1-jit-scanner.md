# Phase 4, Topic 1: JIT Architecture & The Scanner (`scanner.ts`)

This is the most technically impressive part of Diff-Guardian. Phases 1–3 identified **what** broke. Phase 4 answers: **who cares?** — finding every file in the repo that calls the broken function and checking whether they'll actually break.

The code lives in [`src/tracer/scanner.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts) (the scanner), [`src/tracer/languages/`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/) (language strategies), and is orchestrated by [`src/pipeline.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/pipeline.ts).

---

## 1. The "Lazy Graph" Concept

### The Naive Approach (AOT — Ahead of Time)

Parse every file in the repo → build a complete call graph → query it.

```
50,000 files × ~20ms parse each = ~16 minutes
```

This is what tools like `tsc --noEmit` or full IDE language servers do. It's accurate but brutally slow for a CI gate that needs to finish in seconds.

### The Diff-Guardian Approach (JIT — Just In Time)

**Only trace symbols that are actually broken.** Don't build a whole graph — build the tiny subgraph you need.

```
Phase 3 says:  "processPayment is broken (added required param)"
Scanner says:  "15 files mention processPayment" (git grep: ~50ms)
               "3 of those actually import it"    (regex: ~2ms)
Tracer says:   "2 of those call sites pass wrong arg count" (AST: ~20ms)

Total: ~72ms for the entire blast radius
```

This is the **Lazy Graph** — you never build the full dependency graph. You only trace the paths that matter. This is what makes Diff-Guardian fast enough to run on every `git push`.

### Why "JIT"?

The term comes from JIT compilation (like V8). Just as V8 only compiles functions when they're first called, Diff-Guardian only traces symbols when they're first broken. If nothing breaks, the tracer does zero work.

---

## 2. The Two-Tier Engine

The tracer is split into two phases, each with different performance characteristics:

```
┌─────────────────────────────────────────────────────┐
│ Tier 1: Scanner (this topic)                        │
│   Tool:     git grep + regex                        │
│   Speed:    ~50ms for 50,000 files                  │
│   Output:   ImportReference[] — "who imports this?" │
│   No AST:   Pure text search + regex classification │
├─────────────────────────────────────────────────────┤
│ Tier 2: Call-Site Tracer (Topic 2)                  │
│   Tool:     Tree-sitter AST + S-expression queries  │
│   Speed:    ~20ms per file                          │
│   Output:   CallSite[] — "do they pass enough args?"│
│   AST:      Full structural analysis                │
└─────────────────────────────────────────────────────┘
```

The scanner is the **cheap filter**. It throws away 99% of files so the tracer only has to AST-parse a handful.

---

## 3. `isTraceable()` — Which Changes Are Worth Tracing

Not every breaking change needs call-site tracing. The [`pipeline.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/pipeline.ts#L43-L55) has a gate:

```typescript
const TRACEABLE_FN_CHANGE_TYPES = new Set([
  'signature_change',    // param added/removed/reordered → arg count may be wrong
  'symbol_deleted',      // function gone entirely → every call site is broken
]);

const TRACEABLE_ENUM_CHANGE_TYPES = new Set([
  'enum_member_changed', // member removed/renamed → EnumName.Member is broken
]);

function isTraceable(change: FunctionChange): boolean {
  if (!change.breaking) return false;

  if (change.symbolType === 'function') {
    return TRACEABLE_FN_CHANGE_TYPES.has(change.changeType);
  }
  if (change.symbolType === 'enum') {
    return TRACEABLE_ENUM_CHANGE_TYPES.has(change.changeType);
  }
  return false;
}
```

**Why not trace everything?** Consider `modifier_changed` (a function became `private`). Yes, it's breaking — but tracing call sites won't add useful information. The compiler will catch it. We'd be spending 70ms to tell the developer something TypeScript already tells them instantly.

The traceable set is deliberately small: **signature changes** (wrong arg count at runtime) and **enum member changes** (accessing a deleted member). These are the ones where the tracer adds unique value — counting arguments and checking member access that no compiler catches.

---

## 4. Tracer Metadata Computation

Before tracing, the pipeline computes metadata that the tracer needs. This happens in [`pipeline.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/pipeline.ts#L78-L89):

### For Functions: `computeParamCounts()`

```typescript
function computeParamCounts(change: FunctionChange): void {
  const sig = change.after as FunctionSignature | null;
  if (!sig || !('params' in sig)) return;

  // How many params MUST be provided (not optional, not rest)
  change.requiredParamCount = sig.params.filter(
    p => !p.optional && !p.isRest
  ).length;

  // How many params CAN be provided (not rest)
  change.totalParamCount = sig.params.filter(
    p => !p.isRest
  ).length;
}
```

If a function signature is `fn(a: string, b?: number, ...rest: any[])`:
- `requiredParamCount = 1` (only `a`)
- `totalParamCount = 2` (`a` and `b`, not `rest`)

Later, the tracer checks: does the call site pass between `requiredParamCount` and `totalParamCount` arguments? If not, it's broken.

### For Enums: `computeEnumMetadata()`

```typescript
function computeEnumMetadata(change: FunctionChange): void {
  const oldSig = change.before as EnumSignature | null;
  const newSig = change.after as EnumSignature | null;

  const removed: string[] = [];  // member deleted entirely
  const changed: string[] = [];  // member value changed

  for (const oldMember of oldSig.members) {
    const newMember = newSig?.members.find(m => m.name === oldMember.name);

    if (!newMember) {
      removed.push(oldMember.name);    // Status.Suspended → doesn't exist
    } else if (oldMember.value !== newMember.value) {
      changed.push(oldMember.name);    // Status.Active = 0 → Status.Active = 1
    }
  }

  change.removedEnumMembers = removed;  // ["Suspended"]
  change.changedEnumMembers = changed;  // ["Active"]
}
```

Later, the tracer finds `Status.Suspended` in call sites and flags them as broken.

---

## 5. The Scanner Pipeline

The scanner's [`scan()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L94-L139) method runs three steps:

```
scan("processPayment", "src/payments/index.ts")
  │
  ├─ Step 1: gitGrep("processPayment")
  │   └─ Returns GrepMatch[] — all files mentioning the string
  │
  ├─ Step 2: classifyFile() — for each grep match
  │   ├─ Direct import? → add to importers[]
  │   └─ Barrel re-export? → add to barrelQueue[]
  │
  └─ Step 3: walkBarrels() — BFS through barrel files
      └─ For each barrel consumer → classifyFile() again
```

Let's trace through each step.

---

## 6. Step 1: `git grep` — The Fast Filter

[`gitGrep()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L152-L181) runs a single shell command:

```bash
git grep -n --word-regexp 'processPayment' HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'
```

### Why `git grep` and not `grep -r` or `fs.readdir`?

| Feature | `git grep` | `grep -r` | `fs.readdir` |
|---|---|---|---|
| Respects `.gitignore` | ✅ Free | ❌ Need `--exclude` | ❌ Manual |
| Excludes `node_modules` | ✅ Free | ❌ Need `--exclude-dir` | ❌ Manual |
| Reads committed content | ✅ Uses git index | ❌ Reads disk | ❌ Reads disk |
| Excludes binary files | ✅ Free | ❌ Need `-I` | ❌ Manual |
| Performance (50k files) | ~50ms | ~200ms | ~500ms |

`git grep` uses the git index (a pre-computed sorted list of all tracked files) which makes it dramatically faster than filesystem traversal. And since it uses the index, it automatically skips `node_modules/`, `dist/`, `.git/` — all the noise.

### Why `--word-regexp`?

```bash
# Without --word-regexp: matches 'processPaymentV2', 'unprocessPayment', etc.
git grep 'processPayment'

# With --word-regexp: only matches the exact word 'processPayment'
git grep --word-regexp 'processPayment'
```

This is `\bprocessPayment\b` — word boundary matching. Without it, searching for `map` would match `remap`, `mapper`, `bitmap`. The word boundary eliminates a huge class of false positives before the regex phase even starts.

### Why `-n` (line numbers)?

The output includes line numbers for diagnostics, but the scanner deduplicates by file path anyway. Each file only appears once in the result:

```typescript
// Deduplicate by file path
const seen = new Set<string>();
return matches.filter(m => {
  if (seen.has(m.filePath)) return false;
  seen.add(m.filePath);
  return true;
});
```

### Parsing the output

Git grep output format: `HEAD:src/checkout/cart.ts:47:import { processPayment } from '../payments'`

The [`parseGrepOutput()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L192-L246) parser handles the `ref:path:lineNum:text` format, stripping the SHA prefix and extracting structured `GrepMatch` objects.

### Safety caps

Results are capped at `maxGrepResults` (default: 500). In a massive monorepo, a common symbol like `format` might appear in 10,000 files. The cap prevents the tracer from trying to parse all of them.

---

## 7. Step 2: `classifyFile()` — Import Detection

Git grep found files containing the string `processPayment`. But that includes:
- ✅ `import { processPayment } from './payments'` — a real import
- ❌ `// TODO: implement processPayment` — a comment
- ❌ `function processPayment() { ... }` — the definition itself
- ❌ `export { processPayment } from './payments'` — a barrel re-export

[`classifyFile()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L257-L327) separates these using the **Language Strategy pattern**.

### How it works

```typescript
private async classifyFile(filePath, symbolName, importers, barrelQueue, depth) {
  // 1. Get the right strategy for this file extension
  const strategy = getStrategyForFile(filePath);  // .ts → typescriptStrategy
  
  // 2. Read file content from git
  const content = await this.getFileContent(filePath);
  
  // 3. Check barrel patterns FIRST (they take priority)
  const barrelPatterns = strategy.buildBarrelPatterns(symbolName);
  for (const pattern of barrelPatterns) {
    if (pattern.regex.exec(content)) {
      barrelQueue.push({ filePath, depth: depth + 1 });
      break;  // one barrel match is enough
    }
  }
  
  // 4. Check import patterns
  const importPatterns = strategy.buildImportPatterns(symbolName);
  for (const pattern of importPatterns) {
    while (match = pattern.regex.exec(content)) {
      const localName = pattern.extractAlias(match, symbolName);
      
      // Optional verification — reject false positives
      if (pattern.verifyMatch && !pattern.verifyMatch(match, content, ...)) {
        continue;
      }
      
      importers.push({
        filePath,
        importedName: symbolName,
        localName,         // "pay" if aliased, "processPayment" otherwise
        importLine: lineNum,
        importType: pattern.type,  // 'static', 'dynamic', 'require', 'wildcard'
      });
    }
  }
}
```

### Why barrel patterns are checked first

A file like `checkout/index.ts` might contain:
```typescript
export { processPayment } from '../payments';
```

This matches BOTH a barrel pattern AND an import pattern. But this file doesn't **use** `processPayment` — it just forwards it. We need to follow it to find the real consumers. Checking barrels first ensures we add it to the BFS queue.

---

## 8. The Language Strategy Pattern

The key insight: **the scanner is language-agnostic**. It doesn't know what a TypeScript import looks like. It asks the strategy.

### The contract

The [`LanguageStrategy`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/types.ts#L105-L235) interface has three groups of methods:

```
LanguageStrategy
├── Scanner methods (Phase 2 — this topic)
│   ├── buildImportPatterns(symbolName) → ImportPattern[]
│   ├── buildBarrelPatterns(symbolName) → ImportPattern[]
│   ├── isBarrelFile(filePath)          → boolean
│   └── buildBarrelSearchTerm(barrelPath) → string
│
├── Tracer methods (Phase 3 — Topic 2)
│   ├── callExpressionQueries           → string[]    (tree-sitter S-expressions)
│   ├── countArguments(argsNode)        → { count, hasSpread }
│   └── verifyCallTarget(callNode, ...) → boolean
│
└── Enum methods
    ├── supportsEnumTracing             → boolean
    └── walkEnumAccess(rootNode, ...)   → RawEnumAccess[]
```

### The `ImportPattern` type

Each pattern is a self-contained unit:

```typescript
interface ImportPattern {
  regex:        RegExp;       // the detection regex (must use 'gm' flags)
  type:         string;       // 'static', 'dynamic', 'require', 'wildcard'
  extractAlias: (match, symbolName) => string;  // resolves local binding
  verifyMatch?: (match, content, symbolName, localName) => boolean;  // rejects false positives
  isBarrel?:    boolean;      // if true, this is a re-export, not an import
}
```

### TypeScript import patterns in detail

[`typescriptStrategy.buildImportPatterns()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/typescript.ts#L107-L155) generates 4 patterns:

#### Pattern 1: Static import
```
import { processPayment } from './payments'
import { processPayment as pay } from './payments'
```
Regex: `import\s*\{([^}]*\bprocessPayment\b[^}]*)\}\s*from\s*['"]([^'"]+)['"]`

The `extractAlias` function parses the specifier block: given `"processPayment as pay, otherFn"`, it splits on commas, finds `processPayment as pay`, and returns `"pay"`.

**Why alias extraction matters**: If someone writes `import { processPayment as pay } from ...`, the tracer later needs to search for `pay(...)` call expressions, NOT `processPayment(...)`. Without alias tracking, we'd miss every aliased call site.

#### Pattern 2: Dynamic import
```
const { processPayment } = await import('./payments')
```
Same concept, different syntax. Note: bare `import('./payments')` without destructuring is NOT matched — there's no way to know which exports are used.

#### Pattern 3: CJS require
```
const { processPayment } = require('./payments')
```
Same destructuring requirement. Bare `require('./payments')` is not a match.

#### Pattern 4: Wildcard import
```
import * as payments from './payments'
payments.processPayment(...)
```
This is tricky. The import line doesn't mention `processPayment` at all. So:
1. The regex matches `import * as payments from '...'`
2. `extractAlias` returns `"payments.processPayment"` (the dotted form)
3. `verifyMatch` checks: does `payments.processPayment` appear anywhere in the file content?

If the file imports `* as payments` but only uses `payments.calculateTax`, the `verifyMatch` rejects the match. This eliminates false positives from wildcard imports.

### The strategy registry

[`index.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/index.ts#L36-L43) maps languages to strategies:

```typescript
const strategyRegistry = new Map<Language, LanguageStrategy>([
  ['typescript',  typescriptStrategy],
  ['javascript',  typescriptStrategy],  // JS shares the TS strategy
  ['python',      pythonStrategy],
  ['java',        javaStrategy],
  ['go',          goStrategy],
  ['rust',        rustStrategy],
]);
```

**Why do TypeScript and JavaScript share a strategy?** They share the same module system (ES modules + CJS require). The import syntax is identical. The tree-sitter grammar for TypeScript already handles `.js` files. There's no reason to duplicate 300 lines of regex.

[`getStrategyForFile()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/index.ts#L69-L72) resolves by extension:

```typescript
function getStrategyForFile(filePath: string): LanguageStrategy | undefined {
  const ext = filePath.match(/\.[^.]+$/)?.[0] || '';
  return extensionMap.get(ext);  // '.ts' → typescriptStrategy
}
```

---

## 9. Step 3: Barrel File Walking — BFS with Cycle Detection

### What is a barrel file?

```typescript
// src/checkout/index.ts — this IS a barrel file
export { processPayment } from '../payments';
export { calculateTax }   from '../tax';
export { formatReceipt }  from '../receipts';
```

A barrel re-exports symbols from other modules. Consumers import from the barrel:
```typescript
import { processPayment } from '../checkout';  // imports from the barrel
```

The problem: `git grep processPayment` won't find `cart.ts` because `cart.ts` imports from `checkout`, not from `payments`. The symbol name appears in the barrel file, not the consumer.

### The BFS solution

[`walkBarrels()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L343-L394) implements breadth-first search:

```
Start: barrelQueue = [{ filePath: "checkout/index.ts", depth: 1 }]

Iteration 1:
  Process "checkout/index.ts"
  → findBarrelConsumers("checkout/index.ts", "processPayment")
  → git grep for files containing both "checkout" AND "processPayment"
  → Found: "cart.ts", "admin/index.ts"
  
  cart.ts: classifyFile → direct import → add to importers[]
  admin/index.ts: classifyFile → barrel re-export → add to barrelQueue[]

Iteration 2:
  Process "admin/index.ts"
  → findBarrelConsumers("admin/index.ts", "processPayment")
  → Found: "dashboard.ts"
  
  dashboard.ts: classifyFile → direct import → add to importers[]

Done: barrelQueue is empty
```

### Cycle detection

What if `A` re-exports from `B` and `B` re-exports from `A`? Without protection, the BFS would loop forever.

Solution: a `visited` Set. Before processing any file, check `visited.has(normalizedPath)`. This catches cycles of any length.

```typescript
// From the scan() method:
const visited = new Set<string>();
visited.add(this.normalizePath(sourceFile));  // Never trace the defining file

for (const match of grepMatches) {
  const normalizedPath = this.normalizePath(match.filePath);
  if (visited.has(normalizedPath)) continue;   // ← cycle detection
  visited.add(normalizedPath);
  ...
}
```

### Depth limits

Angular-style libraries can have 5+ layers of barrel files. The `maxBarrelDepth` config (default: 10) prevents runaway scans:

```typescript
if (depth > this.config.maxBarrelDepth) {
  console.warn(`Barrel depth limit reached at "${filePath}"`);
  continue;  // skip, don't crash
}
```

### `findBarrelConsumers()` — The double-grep trick

[`findBarrelConsumers()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L402-L436) needs to find files that import from a barrel. It uses a clever piped git grep:

```bash
# Step 1: Find all files containing the barrel's directory name
git grep -n -l 'checkout' HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'

# Step 2: Of those, find files that ALSO mention the symbol
| xargs git grep -n 'processPayment' HEAD --
```

Why two greps? A file that imports from `checkout` must contain both:
1. The string `"checkout"` (in the `from 'checkout'` clause)
2. The string `"processPayment"` (in the import specifier)

The pipe `|` between them is a logical AND — only files matching BOTH appear in the output.

### `buildBarrelSearchTerm()`

Given a barrel path, extract the directory name that consumers would import from:

```typescript
// "src/checkout/index.ts" → "checkout"
// "src/utils/helpers.ts"  → "helpers"
buildBarrelSearchTerm(barrelPath: string): string {
  const baseName = barrelPath.replace(/\.(ts|tsx|js|jsx)$/, '');
  const isIndex = baseName.endsWith('/index');
  
  if (isIndex) {
    // "src/checkout/index" → strip "/index" → "src/checkout" → last segment → "checkout"
    return baseName.replace(/\/index$/, '').split('/').pop();
  }
  return baseName.split('/').pop();
}
```

---

## 10. File Content Retrieval

[`getFileContent()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L444-L460) reads from the git index, not the filesystem:

```typescript
private async getFileContent(filePath: string): Promise<string> {
  const { stdout } = await execAsync(
    `git show ${this.config.headSha}:${filePath}`,
    { maxBuffer: MAX_BUFFER, cwd: this.config.repoRoot }
  );
  return stdout;
}
```

**Why `git show` and not `fs.readFile`?** Consistency. The entire pipeline works on committed content, not the working tree. If a developer has unsaved changes in their editor, those changes should NOT affect the analysis. `git show HEAD:path` always returns the committed version.

---

## 11. The Complete Data Flow

Let's trace the full scanner flow for one breaking change:

```
Pipeline says: "processPayment signature changed (breaking)"

1. isTraceable(change) → true (it's a signature_change)

2. computeParamCounts(change)
   → after.params = [a: string, b: number, c: Currency]
   → requiredParamCount = 3, totalParamCount = 3

3. scanner.scan("processPayment", "src/payments/index.ts")
   │
   ├─ gitGrep("processPayment")
   │   $ git grep -n --word-regexp 'processPayment' HEAD -- '*.ts' '*.tsx' ...
   │   → HEAD:src/payments/index.ts:15:export function processPayment(...)
   │   → HEAD:src/checkout/cart.ts:3:import { processPayment } from '../payments'
   │   → HEAD:src/checkout/index.ts:2:export { processPayment } from '../payments'
   │   → HEAD:src/admin/refunds.ts:7:import { processPayment as pay } from '../payments'
   │
   ├─ classifyFile("src/payments/index.ts")  → SKIPPED (source file)
   │
   ├─ classifyFile("src/checkout/cart.ts")
   │   ├─ buildImportPatterns("processPayment")
   │   ├─ Regex matches: import { processPayment } from '../payments'
   │   └─ → importers.push({ filePath: "cart.ts", localName: "processPayment" })
   │
   ├─ classifyFile("src/checkout/index.ts")
   │   ├─ buildBarrelPatterns("processPayment")
   │   ├─ Regex matches: export { processPayment } from '../payments'
   │   └─ → barrelQueue.push({ filePath: "checkout/index.ts", depth: 1 })
   │
   ├─ classifyFile("src/admin/refunds.ts")
   │   ├─ buildImportPatterns("processPayment")
   │   ├─ Regex matches: import { processPayment as pay } from '../payments'
   │   ├─ extractAlias → "pay"
   │   └─ → importers.push({ filePath: "refunds.ts", localName: "pay" })
   │
   └─ walkBarrels()
       ├─ Process "checkout/index.ts"
       ├─ findBarrelConsumers → git grep "checkout" AND "processPayment"
       ├─ Found: "src/app/main.ts"
       └─ classifyFile("src/app/main.ts")
           └─ → importers.push({ filePath: "main.ts", localName: "processPayment" })

Result: ImportReference[] = [
  { filePath: "cart.ts",    localName: "processPayment", importType: "static" },
  { filePath: "refunds.ts", localName: "pay",            importType: "static" },
  { filePath: "main.ts",    localName: "processPayment", importType: "static" },
]
```

These 3 files get passed to the **Call-Site Tracer** (Topic 2) for AST parsing.

---

## 12. Performance Characteristics & Safety

### Speed budget

| Operation | Time | Files processed |
|---|---|---|
| `git grep` on 50,000 files | ~50ms | All tracked files |
| Regex on 15 matched files | ~2ms | Only grep matches |
| Barrel BFS (2 layers) | ~20ms | Only barrel consumers |
| **Total scanner time** | **~72ms** | **3 importers found** |

### Safety caps

From [`createDefaultTracerConfig()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/scanner.ts#L510-L525):

```typescript
{
  maxGrepResults: 500,    // cap grep matches (prevents "format" matching 10k files)
  maxBarrelDepth: 10,     // cap barrel BFS depth (prevents infinite Angular chains)
  maxTracerFiles: 100,    // cap files sent to AST tracer (prevents parsing the world)
  traceOnlyBreaking: true // only trace breaking changes, not warnings
}
```

### Non-fatal error isolation

Every `try/catch` in the scanner logs a warning and continues. One bad file doesn't crash the scan:

```typescript
catch (err: any) {
  console.warn(`[scanner] Failed to read "${filePath}": ${err.message}`);
  return;  // skip this file, continue scanning
}
```

The pipeline echoes this philosophy — even if the entire tracer fails to initialize, the pipeline still produces correct classifier output. Call sites are best-effort enrichment, not a critical path.

---

## 13. Multi-Language Strategy Differences

Each language has wildly different import syntax. Here's how the strategies differ at the scanner level:

| Language | Import syntax | Barrel concept | Alias syntax |
|---|---|---|---|
| **TypeScript/JS** | `import { fn } from`, `require()`, `import()` | `index.ts` re-exports | `fn as alias` |
| **Python** | `from mod import fn`, `import mod` | `__init__.py` re-exports | `fn as alias` |
| **Java** | `import pkg.Class`, `import static pkg.Class.method` | None (returns `[]`) | None (no alias) |
| **Go** | `import "path/to/pkg"` | None (returns `[]`) | `.` or alias prefix |
| **Rust** | `use path::sym`, `use path::{sym, ...}`, `use path::*` | `mod.rs`, `lib.rs` re-exports | `sym as alias` |

Notice that Java and Go return empty barrel patterns — they don't have barrel file concepts. The strategy pattern handles this naturally: `buildBarrelPatterns()` returns `[]` and the BFS walker has nothing to process.

---

## 14. Interview Angle

> **"How does the tracer find all callers of a broken function?"**
>
> "It's a two-tier JIT system. First, `git grep --word-regexp` finds every file in the repo mentioning the symbol name — this takes ~50ms on 50,000 files because it uses the git index, not filesystem traversal. Then, language-specific regex patterns classify each match as a direct import, a barrel re-export, or a false positive. Barrel files trigger a BFS walk with cycle detection to find transitive consumers. The output is a precise set of importing files — usually 3–15 — that get passed to the AST-based call-site tracer. The whole scanner phase costs under 100ms."

> **"Why not use the TypeScript compiler's reference graph?"**
>
> "Three reasons. First, it only works for TypeScript — we support 5 languages. Second, it requires a full `tsc` initialization (~5 seconds) which is too slow for a CI gate. Third, we don't need the full graph — we only need the subgraph for broken symbols. The JIT approach gives us the same precision at 1% of the cost."

---

*Phase 4, Topic 1 complete! Next: [Phase 4, Topic 2 — Call-Site Tracing & Validation](./phase4-topic2-call-site-tracer.md)*
