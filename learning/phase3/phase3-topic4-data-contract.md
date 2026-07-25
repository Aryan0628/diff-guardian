# Phase 3, Topic 4: The Data Contract (`types.ts`, `constants.ts`, `utils.ts`)

This topic covers the **foundation layer** of the entire project — the types, constants, and utilities that every other module depends on. The code lives in [`src/core/types.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/types.ts), [`src/core/constants.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/constants.ts), and [`src/core/utils.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/utils.ts).

---

## Why a "Data Contract" Matters

Diff-Guardian has 6 pipeline phases. Data flows from Phase 1 (source extraction) through Phase 6 (reporting). At every boundary between phases, data changes shape. **If there is no single source of truth for these shapes, phases will disagree on what data looks like, and bugs will be impossible to find.**

[`types.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/types.ts) is that single source of truth — a 389-line file that defines every interface, type, and enum in the system. It is imported by **every other module** and imports from **none of them**.

```
core/types.ts ← imported by everyone
                imports from nobody in src/
```

This is the bottom of the layered architecture from Phase 2.

---

## 1. The Enum Foundations

### `Language`

```typescript
export type Language =
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'go'
    | 'java'
    | 'rust';
```

A string union type, not a TypeScript `enum`. Why? String unions produce simpler compiled JS and work better with JSON serialisation. Every file in the system is tagged with exactly one of these values.

### `Severity`

```typescript
export type Severity =
    | 'breaking'    // Callers WILL break at runtime or compile time
    | 'warning'     // Behaviorally different, callers may not break immediately
    | 'safe';       // No existing caller affected
```

**Three buckets, not two.** The temptation is to make it binary (breaking or not). But `warning` captures a middle ground — things like a default value changing (R23) or a function becoming exported (R28). These won't crash callers but signal that behavior changed.

### `ChangeType`

```typescript
export type ChangeType =
    | 'signature_change'            // R1-R5, R12-R14
    | 'return_type_widened'         // R6
    | 'return_type_narrowed'        // R7
    | 'visibility_changed'          // R8, R20, R28
    | 'modifier_changed'            // R11, R17, R21, R22
    | 'decorator_changed'           // R16
    | 'overload_changed'            // R15, R16
    | 'interface_property_added'    // R25
    | 'interface_property_removed'  // R26
    | 'enum_member_changed'         // R27
    | 'type_alias_changed'
    | 'symbol_deleted'              // R9
    | 'symbol_added';               // R10
```

Each `ChangeType` maps directly to one or more of the 26 rules. This creates a clean link between what the classifier detects and what the reporter displays.

---

## 2. `Param` — Representing Function Arguments

```typescript
export interface Param {
    name:          string;    // 'userId', '{...}', '[...]', '...args'
    type:          string;    // 'string', 'User | null', 'readonly string[]'
    optional:      boolean;   // true if ? modifier OR has default value
    hasDefault:    boolean;   // true if = someValue specifically
    defaultValue?: string;    // the actual default text
    isRest?:       boolean;   // true if ...rest param
}
```

### The `optional` vs `hasDefault` Distinction

This is subtle but critical for the classifier:

| Code | `optional` | `hasDefault` | Why |
|------|-----------|-------------|-----|
| `x: string` | `false` | `false` | Required param — callers must provide it |
| `x?: string` | `true` | `false` | Optional with `?` — callers can skip it |
| `x = 'hello'` | `true` | `true` | Has default — callers can skip it but it has a specific default |
| `x?: string = 'hello'` | `true` | `true` | Both optional and defaulted |

**Why this matters for rules:**
- **R01 (param removed):** If an `optional` param is removed, it's less severe than a required one.
- **R05 (optional param added):** A new optional param is safe because existing callers don't pass it.
- **R23 (default value changed):** Only fires when `hasDefault: true` AND `defaultValue` changed — it uses `hasDefault` to know there was a default to compare.

### Destructured Parameters

When you write `function foo({ id, name }: User)`, the translator can't know the individual destructured names at the AST level without deep analysis. Instead, it normalises to `{...}`:

```typescript
// { id, name }: User → Param { name: '{...}', type: 'User' }
// [a, b]: number[]   → Param { name: '[...]', type: 'number[]' }
```

This is a deliberate trade-off — tracking individual destructured fields would dramatically increase complexity with minimal classifier benefit.

---

## 3. `FunctionSignature` — The Big One

This is the most complex type in the system at [15+ fields](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/types.ts#L69-L117):

```typescript
export interface FunctionSignature {
    // ── Identity ──
    name:            string;             // 'processPayment' | 'Service#constructor'
    line:            number;             // 1-indexed start line
    filePath?:       string;             // injected by ASTMapper, not set by translator

    // ── Shape ──
    params:          Param[];            // ordered — order matters for R02/R03
    returnType:      string | 'inferred';// 'inferred' = no annotation
    typeParameters?: TypeParameter[];    // generics: T extends Record<string, unknown>

    // ── Modifiers ──
    exported:        boolean;            // R08: export removed
    isDefaultExport: boolean;            // default vs named export
    async:           boolean;            // R11/R21: async toggle
    isStatic?:       boolean;            // R17: static ↔ instance
    isAbstract?:     boolean;            // abstract keyword
    isGenerator?:    boolean;            // function* toggle
    isConstructor?:  boolean;            // R24: constructor change
    isGetter?:       boolean;            // get accessor
    isSetter?:       boolean;            // set accessor

    // ── Class context ──
    className?:      string;             // parent class name
    accessModifier?: 'public' | 'protected' | 'private';  // R20

    // ── Metadata ──
    decorators?:     string[];           // R16: decorator changed
    overloadIndex?:  number;             // position in overload sequence
    overloadCount?:  number;             // total overloads (R15/R16)
}
```

### Why `filePath` is Optional

The translator is a pure function — it takes a Tree-Sitter tree and has **no knowledge** of which file it came from. The `ASTMapper` injects `filePath` after the translator returns. Making it optional prevents the translator from needing fake file paths during extraction.

### Why `returnType: 'inferred'` Instead of `undefined`

```typescript
returnType: string | 'inferred';
```

When a function has no return type annotation, the translator sets `'inferred'` instead of `undefined`. This is an **explicit sentinel value** that tells the classifier: *"This function has no type annotation — skip R06/R07."*

Using `undefined` would be ambiguous — it could mean "we forgot to set it" or "the function has no annotation." The string `'inferred'` is unambiguous.

**Critical:** The translator NEVER defaults to `'any'`. The type `any` is a real TypeScript type — someone might write `function foo(): any`. Defaulting to `'any'` would make `'any'` indistinguishable from "no annotation."

### Why Modifier Fields Are Optional Booleans

```typescript
isStatic?:   boolean;   // undefined when not applicable (e.g., top-level function)
isAbstract?: boolean;
```

A top-level function can't be `static` — the concept doesn't apply. Instead of setting `isStatic: false` (which implies "we checked and it's not static"), we leave it `undefined` (which means "this concept is irrelevant for this symbol"). The classifier handles both `false` and `undefined` as "not static."

---

## 4. `InterfaceSignature`, `EnumSignature`, `TypeAliasSignature`

### InterfaceSignature

```typescript
export interface InterfaceSignature {
    line:            number;
    properties:      InterfaceProperty[];   // R25/R26: property changes
    exported:        boolean;
    isDefaultExport?: boolean;
    typeParameters?: TypeParameter[];       // interface Response<T>
    extends?:        string[];             // ['Base', 'Auditable']
}

export interface InterfaceProperty {
    name:      string;     // property key
    type:      string;     // raw type string
    optional:  boolean;    // has ? modifier
    readonly?: boolean;    // readonly property
}
```

**`extends?`:** If an interface extends another (`interface User extends Base`), removing a parent is breaking — callers relying on inherited properties lose them.

### EnumSignature

```typescript
export interface EnumSignature {
    line:             number;
    members:          EnumMember[];   // R27: member changes
    exported:         boolean;
    isDefaultExport?: boolean;
}

export interface EnumMember {
    name:    string;   // 'Active'
    value?:  string;   // '1' or undefined (auto-incremented)
}
```

**`value?: string`:** When an enum member has no explicit value, TypeScript auto-increments from the previous member. If `value` is `undefined`, it means auto-incremented. The classifier (R27) only flags explicit value changes to prevent false positives from insertion-based reordering.

### TypeAliasSignature

```typescript
export interface TypeAliasSignature {
    line:             number;
    value:            string;             // raw string: "'active' | 'inactive'"
    exported:         boolean;
    isDefaultExport?: boolean;
    typeParameters?:  TypeParameter[];    // type Node<T> = ...
}
```

The `value` is stored as a raw string because type aliases can be arbitrarily complex. Deep structural comparison of types is extremely hard — the raw text comparison catches most real-world changes.

---

## 5. The `AnySignature` Union

```typescript
export type AnySignature =
    | FunctionSignature
    | InterfaceSignature
    | EnumSignature
    | TypeAliasSignature;
```

This is the type used in the signature Map: `Map<string, AnySignature>`. The classifier uses TypeScript's discriminated unions (checked via key prefix) to narrow the type before passing it to rules.

---

## 6. Pipeline Data Types

### `FileDiff` — Phase 1 Output

```typescript
export interface FileDiff {
    path:      string;     // 'src/payments/processor.ts'
    language:  string;     // 'ts', 'py', 'go' (raw extension)
    isNew:     boolean;
    isDeleted: boolean;
    isRenamed: boolean;
    oldPath:   string;     // original path before rename
    oldSource: string;     // full text at baseSha
    newSource: string;     // full text at headSha
}
```

### `ParseResult` — Phase 2 Output

```typescript
export interface ParseResult {
    file:        string;
    language:    Language;
    oldSigs:     Map<string, AnySignature>;   // signatures at baseSha
    newSigs:     Map<string, AnySignature>;   // signatures at headSha
    skipped:     boolean;
    skipReason?: string;
}
```

### `FunctionChange` — Phase 3 Output

The classifier output. See Topic 3 for the full interface. Key fields:
- `before: AnySignature | null` — null if symbol was added
- `after: AnySignature | null` — null if symbol was deleted
- `callers: CallSite[]` — empty after classification, populated by the tracer
- Tracer metadata fields (`requiredParamCount`, `totalParamCount`, `removedEnumMembers`, etc.) — populated by the pipeline between classification and tracing

### `AnalysisResult` — Final Pipeline Output

```typescript
export interface AnalysisResult {
    from:        string;             // 'main'
    to:          string;             // 'feature/payment-refactor'
    baseSha:     string;             // exact commit hash
    headSha:     string;             // exact commit hash
    breaking:    FunctionChange[];   // severity: 'breaking'
    warnings:    FunctionChange[];   // severity: 'warning'
    apiChanges:  FunctionChange[];   // all changes (breaking + warning + safe)
    testGaps:    FunctionChange[];   // breaking changes whose callers lack tests
    riskFiles:   RiskFile[];         // files ranked by risk
}
```

This is what the reporters consume to produce terminal output, GitHub PR comments, or JSON files.

---

## 7. Tracer Domain Types

These are covered in depth in Phase 4, but here's a brief overview:

### `CallSite` — One Call to a Changed Function

```typescript
export interface CallSite {
    file:             string;     // 'src/checkout/index.ts'
    lineStart:        number;     // line of the call expression
    lineEnd:          number;     // end line (for multi-line calls)
    argumentCount:    number;     // actual args at call site (-1 if spread)
    isBroken:         boolean;    // true if arg count doesn't match
    isFixed:          boolean;    // true if dev already updated the call
    isIndeterminate:  boolean;    // true if call uses ...spread
    covered:          boolean;    // true if a test file references the caller
}
```

### `ImportReference` — How a Symbol is Imported

```typescript
export interface ImportReference {
    filePath:     string;     // importing file
    importedName: string;     // 'processPayment'
    localName:    string;     // 'handlePayment' (alias) or same as importedName
    isBarrel:     boolean;    // true if just re-exports
    importLine:   number;
    importType:   'static' | 'dynamic' | 'require' | 'wildcard' | 
                  'from_import' | 'module_import' | 'java_import' | 
                  'static_import' | 'go_import' | 'dot_import' |
                  'use' | 'use_glob' | 'use_group';
}
```

The `importType` union covers every import style across all 6 supported languages.

### `TracerConfig` — Performance Limits

```typescript
export interface TracerConfig {
    tracerLanguages:  Language[];   // default: ['typescript', 'javascript']
    maxGrepResults:   number;       // cap at 500 files
    maxBarrelDepth:   number;       // max 10 recursive barrel walks
    maxTracerFiles:   number;       // max 100 files to AST-parse
    traceOnlyBreaking: boolean;     // only trace breaking changes
    repoRoot:         string;
    headSha:          string;
}
```

These caps prevent runaway scans on massive monorepos.

---

## 8. Constants & Utils

### [`constants.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/constants.ts) — Configuration as Code

```typescript
// Which file extensions we support
export const SUPPORTED_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs',
]);

// Maps extension → Language enum
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python',     '.go': 'go',
    '.java': 'java',     '.rs': 'rust',
};

// Paths to ignore — these contain generated or third-party code
export const EXCLUDED_PATH_SEGMENTS = new Set([
    'node_modules', 'vendor', 'dist', 'build', 'target',
    '.git', '__pycache__', '.venv', 'venv', 'site-packages',
    'third_party', 'external', 'generated', 'gen',
]);

// File suffixes to ignore — type definitions, compiled files
export const EXCLUDED_FILE_SUFFIXES = [
    '.d.ts', '.d.tsx', '_pb2.py', '.pyi', '.min.js', 'bundle.js',
];
```

**Why exclude `.d.ts` files?** Declaration files (`.d.ts`) are type definitions, not source code. They're generated, and analysing them would produce duplicate signatures for every function.

**Why exclude `_pb2.py`?** These are protobuf-generated Python files — auto-generated code that shouldn't trigger breaking change alerts.

### [`utils.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/utils.ts) — Shared Filtering

```typescript
export function isTargetFile(filePath: string): boolean {
    const ext = path.extname(filePath);

    // Must be a supported extension
    if (!SUPPORTED_EXTENSIONS.has(ext)) return false;

    // Must not be an excluded suffix (e.g., .d.ts)
    if (EXCLUDED_FILE_SUFFIXES.some(s => filePath.endsWith(s))) return false;

    // Must not be inside an excluded directory
    const segments = filePath.split(/[\\/]/);
    if (segments.some(seg => EXCLUDED_PATH_SEGMENTS.has(seg))) return false;

    return true;
}
```

**Used by two separate modules:**
1. `git-diff.ts` — to filter which changed files to process
2. `scanner.ts` — to filter grep results during tracing

This is why it lives in `core/` — it's shared infrastructure.

```typescript
export function getSupportedGlobs(extensions?: string[]): string[] {
    if (extensions) {
        return extensions.map(ext => `*${ext}`);
    }
    return Array.from(SUPPORTED_EXTENSIONS).map(ext => `*${ext}`);
}
```

Converts extensions to glob patterns for `git grep --include` filtering.

---

## The Data Journey — Complete Picture

```
Phase 1 (git-diff.ts)
    Output: FileDiff[]
    Shape: { path, oldSource, newSource, isNew, isDeleted, isRenamed }
              │
              ▼
Phase 2 (ast-mapper.ts + translators)
    Output: ParseResult[]
    Shape: { file, language, oldSigs: Map<string, AnySignature>, newSigs }
              │
              ▼
Phase 3 (classifier/engine.ts)
    Output: FunctionChange[]
    Shape: { name, before, after, changeType, severity, breaking, callers: [] }
              │
              ▼
Phase 4 (tracer)
    Mutates: FunctionChange.callers → CallSite[]
    Adds: requiredParamCount, totalParamCount, removedEnumMembers
              │
              ▼
Phase 5 (pipeline.ts)
    Output: AnalysisResult
    Shape: { breaking[], warnings[], apiChanges[], testGaps[], riskFiles[] }
              │
              ▼
Phase 6 (reporters)
    Consumes: AnalysisResult → terminal output | GitHub PR comment | JSON file
```

---

## Interview Q&A

### "Why is types.ts so important?"

> "It's the single source of truth — the data contract between all 6 pipeline phases. Every module imports from it; it imports from no other module. This means if someone changes a type, TypeScript immediately shows every file that's affected. Without it, each phase would define its own types, and we'd get shape mismatches that only surface at runtime."

### "What's the difference between `optional` and `hasDefault` on `Param`?"

> "`optional: true` means the caller doesn't have to provide this argument. `hasDefault: true` means there's a specific default value if they don't. A param with `x?: string` is optional but has no default — it's `undefined` if omitted. A param with `x = 'hello'` is optional AND has a default. The classifier uses `hasDefault` specifically in R23 to detect when a default value was changed, which is a warning-level change."

### "Why string union types instead of TypeScript enums?"

> "String unions produce simpler compiled JavaScript — they're just string comparisons, no reverse mapping objects. They also serialise cleanly to JSON for the JSON reporter output. TypeScript enums generate additional runtime objects that add overhead with no benefit for our use case."

---

*Phase 3 complete! Next: [Phase 4, Topic 1 — JIT Architecture & The Scanner](./phase4-topic1-jit-scanner.md)*
