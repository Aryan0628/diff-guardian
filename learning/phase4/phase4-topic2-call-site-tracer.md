# Phase 4, Topic 2: Call-Site Tracing & Validation (`tracer.ts`)

The scanner (Topic 1) found **which files import** a broken function. The tracer answers the next question: **do they call it correctly?**

Code: [`src/tracer/tracer.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/tracer.ts) and [`src/tracer/languages/`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/tracer/languages/).

---

## 1. What the Tracer Does (Big Picture)

Scanner gave us: *"cart.ts and refunds.ts import processPayment"*

But importing ≠ broken. Maybe they already pass the right args. The tracer:

1. **Parses** each file into an AST (tree-sitter)
2. **Finds** every call to the broken function
3. **Counts** arguments at each call site
4. **Compares** against the new signature's valid arg range
5. **Labels** each call: `broken`, `fixed`, or `indeterminate`

```
Input:   ["cart.ts imports processPayment", "refunds.ts imports processPayment as pay"]

Output:  [{ file: "cart.ts:47",    args: 2, isBroken: true  },
          { file: "refunds.ts:12", args: 3, isBroken: false }]
```

---

## 2. The `trace()` Entry Point

```typescript
async trace(
  change:    FunctionChange,    // the broken function
  importers: ImportReference[], // files that import it (from scanner)
  diffs:     FileDiff[],        // the PR's diffs
): Promise<TracerResult>
```

**Flow:**

```
1. buildValidArgCounts(change) → what arg counts are OK for the new signature?
2. For each importer (capped at 100 files for performance):
   ├─ File IS in PR diff → traceChangedFile() (compare old vs new)
   └─ File NOT in diff   → extractCallSites() → classify directly
3. Collect all CallSite[] into TracerResult
```

The cap (100 files) exists because a utility like `formatDate` might have 500 importers — parsing all 500 is wasteful when the first 100 already show the blast radius.

---

## 3. `extractCallSites()` — Finding Calls via AST

This is the core. It parses source code and finds every call to the target function.

### Step 1: Parse

```typescript
tree = grammar.parser.parse(source);  // tree-sitter → concrete syntax tree
```

### Step 2: Query the AST with S-expressions

Each language strategy provides **tree-sitter queries** — pattern-matching expressions for ASTs. TypeScript has two:

```lisp
;; Direct calls: processPayment(x, y)
(call_expression
  function: (identifier) @callee
  arguments: (arguments) @args) @call

;; Method calls: obj.processPayment(x, y)
(call_expression
  function: (member_expression
    property: (property_identifier) @callee)
  arguments: (arguments) @args) @call
```

**Why two?** Because `processPayment(x)` and `obj.processPayment(x)` have different AST node types (`identifier` vs `property_identifier`). One query can't match both.

### Step 3: Filter + Count

For each match:
1. Check if `@callee` text matches our function name → skip if not
2. `verifyCallTarget()` → make sure the namespace is right (more on this below)
3. `countArguments(@args)` → count how many args were passed
4. Record the call site with file path, line number, and arg count

---

## 4. Argument Counting & The Spread Problem

Each language strategy implements `countArguments()`. It iterates over the args node's children and counts them.

**The catch — spread arguments:**

```typescript
processPayment(...args);  // how many args? Could be 0, could be 100
```

When spread is present → `argumentCount = -1` (indeterminate). The tracer **never** flags spread calls as broken. This is central to the "No False Positives" guarantee.

---

## 5. `verifyCallTarget()` — Namespace Check

When someone writes `import * as payments from './payments'`, calls look like `payments.processPayment()`. The tracer needs to verify it's *our* `payments` object, not some unrelated `other.processPayment()`:

```typescript
// For "payments.processPayment":
// 1. Extract namespace → "payments"
// 2. Extract method → "processPayment"
// 3. Check the AST's object node text === "payments"
// If they don't match → skip (it's a different function)
```

This prevents false positives from unrelated objects with same-named methods.

---

## 6. `buildValidArgCounts()` — What's a Valid Call?

Determines which argument counts are acceptable for the new signature.

**For a normal function** like `fn(a: string, b?: number, ...rest: any[])`:

```
min = 1  (only `a` is required)
max = ∞  (rest param accepts anything)
→ Returns { min: 1, max: Infinity }
```

**For overloaded functions:**

```typescript
function parse(input: string): AST;                   // 1 arg
function parse(input: string, opts: Options): AST;     // 2 args
→ Returns Set {1, 2}   // only these exact counts are valid
```

**Validation:**

```typescript
isValidArgCount(count, validCounts):
  count === -1 (spread)?  → always valid (can't determine)
  validCounts is a Set?   → check Set.has(count)
  validCounts is a range? → check min ≤ count ≤ max
```

---

## 7. Old↔New Correlation — Detecting Already-Fixed Call Sites

This is where the tracer gets clever. When a file is **in the PR diff**, both old and new versions exist. The tracer compares them:

### Same number of calls → match by index (1:1)

```
OLD: processPayment(amount)              → 1 arg → invalid
NEW: processPayment(amount, cur, tax)    → 3 args → valid
→ Was wrong, now correct → isFixed = true ✅
```

### Different number of calls → best-effort matching

Calls were added/removed, so 1:1 doesn't work. The tracer checks: *"did any old call have wrong args AND a new call has right args?"* If yes → likely fixed.

This is approximate but avoids flagging sites that were clearly updated.

---

## 8. Enum Tracing — `traceEnum()`

Separate from function tracing because it's a fundamentally different AST operation.

**Function tracing** → finds `call_expression`, counts arguments  
**Enum tracing** → finds `member_expression` like `Status.Active`, checks if that member was removed/changed

```typescript
// Walks the AST looking for: Status.Suspended
// If "Suspended" was removed from the enum → isBroken = true
// If the file was in the diff and "Suspended" is gone in new version → isFixed = true
```

**Not all languages support this.** Go sets `supportsEnumTracing = false` because Go enums are flat `const` blocks with `iota` — there's no `Status.Active` pattern to find.

---

## 9. Lazy Grammar Loading

Grammars (WASM) are loaded **on demand** and cached:

```
First TypeScript file → load TS grammar (~10ms) → cache it
Next TypeScript file  → cache hit (instant)
No Python files?      → Python grammar never loaded
```

This matters because loading all 5 language grammars unconditionally would waste ~50ms. Tree-sitter queries are also compiled once and cached per grammar.

---

## 10. Language Strategy Differences (Tracer Methods)

Each language implements these tracer-specific methods:

| | TypeScript | Python | Java | Go | Rust |
|---|---|---|---|---|---|
| **Call query nodes** | `identifier`, `property_identifier` | `identifier`, `attribute` | `method_invocation`, `identifier` | `identifier`, `selector_expression` | `identifier`, `scoped_identifier` |
| **Spread syntax** | `...args` | `*args`, `**kwargs` | N/A (varargs at definition) | N/A | N/A |
| **Enum access** | `Status.Active` | `Status.ACTIVE` | `Status.ACTIVE` | ❌ not supported | `Status::Active` |

---

## 11. The "No False Positives" Guarantee

Every ambiguous case is resolved in favor of **not flagging**:

| Ambiguous Case | Tracer's Decision |
|---|---|
| Spread args (`...args`) | Indeterminate, never broken |
| Aliased import (`fn as pay`) | Searches for `pay`, not `fn` |
| Namespace import (`payments.fn`) | Verifies the object name matches |
| Overloaded function | Uses Set of exact valid counts |
| File not in diff | Can't be "fixed", only "broken" or clean |
| Grammar fails to load | Skips silently, returns `[]` |

**Philosophy:** Better to miss a real problem than flag a false one. False positives erode trust.

---

## 12. Full Example — End to End

```
Signature changed: processPayment(amount) → processPayment(amount, currency, tax?)
Valid args: { min: 2, max: 3 }

Scanner found:
  cart.ts     → imports processPayment
  refunds.ts  → imports processPayment as "pay"

Tracer processes:

  cart.ts (NOT in diff):
    → Parse → find call → processPayment(amount) → 1 arg
    → isValidArgCount(1, {2,3}) → false
    → Result: ❌ isBroken = true

  refunds.ts (IS in diff):
    → Old source: pay(amount) → 1 arg
    → New source: pay(amount, Currency.USD) → 2 args
    → Old invalid, new valid → isFixed = true
    → Result: ✅ isFixed = true

Final output:
  cart.ts:47     → ❌ broken (1 arg, needs 2-3)
  refunds.ts:12  → ✅ fixed  (updated to 2 args)
```

---

## 13. Interview Angles

> **"How does the tracer validate call sites without running code?"**
>
> Tree-sitter S-expression queries pattern-match call expressions in the AST. For each match, a language-specific strategy counts arguments (handling spread, varargs, etc). The count is checked against the new signature's valid range. Outside the range → broken.

> **"What if the developer already fixed it?"**
>
> The tracer parses both old and new file versions from the diff. It correlates call sites by index and checks: old was invalid + new is valid = fixed. Shows a green ✅ in the report.

> **"How do you avoid false positives?"**
>
> Five mechanisms: spreads → indeterminate, alias tracking via localName, namespace verification via verifyCallTarget(), Set-based overload matching, and graceful grammar failure handling.

---

*Next: [Phase 5, Topic 1 — CLI, Reporters & CI/CD Integration](./phase5-topic1-cli-reporters-cicd.md)*
