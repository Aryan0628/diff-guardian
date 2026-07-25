# Phase 3, Topic 3: The Classifier Engine — 26 Rules (`engine.ts` + Rules)

This topic covers the **brain** of Diff-Guardian — the Classifier. It takes the `ParseResult[]` from the AST mapper and decides: *"Is this change safe, a warning, or breaking?"*

The code lives in [`src/classifier/engine.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/engine.ts), [`src/classifier/types.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/types.ts), and the [`src/classifier/rules/`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/rules) directory.

---

## What Does the Classifier Do?

The AST mapper gave us two Maps for each file — `oldSigs` (the "before" signatures) and `newSigs` (the "after" signatures). The Classifier compares them symbol by symbol and runs a battery of 26 rules to detect breaking changes.

```
   ParseResult                              FunctionChange[]
┌──────────────────┐                     ┌──────────────────────┐
│ oldSigs:         │    Classifier       │ name: processPayment │
│  processPayment  │ ──────────────────► │ breaking: true       │
│  {params: [...]} │   26 Rules          │ changeType: R01      │
│                  │   compared          │ message: "Parameter  │
│ newSigs:         │   per symbol        │  'userId' removed"   │
│  processPayment  │                     │ severity: 'breaking' │
│  {params: [...]} │                     └──────────────────────┘
└──────────────────┘
```

---

## 1. The `compare()` Algorithm

The core method is [`ClassifierEngine.compare()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/engine.ts#L7-L64). It processes one file at a time. Here's the full logic:

### Step 1: Pre-compute Rule Buckets

```typescript
const allRules = Object.values(rules) as Rule<any>[];
const activeRules = allRules.filter(r =>
    r.languages === 'all' || r.languages.includes(language)
);

const ruleBuckets = {
    function:   activeRules.filter(r => r.target === 'function'),
    interface:  activeRules.filter(r => r.target === 'interface'),
    enum:       activeRules.filter(r => r.target === 'enum'),
    type_alias: activeRules.filter(r => r.target === 'type_alias'),
};
```

**Why pre-compute?** If a file has 50 changed symbols, you don't want to filter the rule list 50 times. By bucketing rules once per file, each symbol lookup is O(1) to find the right bucket.

**Language scoping:** Rules can specify `languages: 'all'` (applies everywhere) or `languages: ['typescript', 'java']` (only specific languages). For example, R27 (enum changed) only applies to TypeScript, Java, and Rust — Python doesn't have enums in the same sense.

### Step 2: Build the Key Union

```typescript
const allKeys = new Set([...oldSigs.keys(), ...newSigs.keys()]);
```

This is the **union** of all symbol names from both the old and new versions. It covers three cases:
- Symbol exists in **both** → it was **modified** (or unchanged)
- Symbol exists only in **old** → it was **deleted**
- Symbol exists only in **new** → it was **added**

### Step 3: The Three Cases

For each key in the union:

```typescript
for (const key of allKeys) {
    const oldSig = oldSigs.get(key);
    const newSig = newSigs.get(key);

    // Case A: Deletion (R09) — symbol removed
    if (oldSig && !newSig) {
        changes.push(/* severity: 'breaking', type: 'symbol_deleted' */);
        continue;
    }

    // Case B: Addition (R10) — new symbol added
    if (!oldSig && newSig) {
        changes.push(/* severity: 'safe', type: 'symbol_added' */);
        continue;
    }

    // Case C: Modification — run all applicable rules
    if (oldSig && newSig) {
        // Deep equality short-circuit
        if (isDeepStrictEqual(oldSig, newSig)) continue;

        const violations = this.runRules(key, oldSig, newSig, ruleBuckets);
        for (const v of violations) {
            changes.push(/* violation details */);
        }
    }
}
```

**Case A (Deletion)** is always `breaking` — if you remove a function, every caller breaks.

**Case B (Addition)** is always `safe` — adding new functions doesn't break existing callers.

**Case C (Modification)** is where it gets interesting — this is where the 26 rules run.

### The `isDeepStrictEqual()` Short-Circuit

```typescript
if (isDeepStrictEqual(oldSig, newSig)) continue;
```

This uses Node.js's built-in deep comparison. If the old and new signatures are **structurally identical** (same params, same return type, same modifiers, everything), we skip running any rules at all. This is a huge performance optimisation — most changed files have many unchanged functions alongside the few that actually changed.

### Step 4: Deterministic Sort

```typescript
return changes.sort((a, b) => a.lineStart - b.lineStart);
```

Results are sorted by line number so the output is deterministic and reads top-to-bottom through the file. Without this, the order would depend on the Map iteration order (insertion order in JS, but non-obvious).

---

## 2. O(1) Key Routing — `runRules()`

When we have a modification, we need to run the **right** rules. A function signature should only be checked by function rules, not enum rules. The [`runRules()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/engine.ts#L66-L95) method uses the key prefix for instant routing:

```typescript
private runRules(key, oldSig, newSig, buckets): RuleResult[] {
    let rulesToRun: Rule<any>[] = [];

    if (key.startsWith('interface:'))  rulesToRun = buckets.interface;
    else if (key.startsWith('enum:'))  rulesToRun = buckets.enum;
    else if (key.startsWith('type:'))  rulesToRun = buckets.type_alias;
    else                               rulesToRun = buckets.function;

    const results: RuleResult[] = [];
    for (const rule of rulesToRun) {
        const triggered = rule.check(oldSig, newSig);
        if (triggered) {
            if (Array.isArray(triggered)) results.push(...triggered);
            else results.push(triggered);
        }
    }
    return results;
}
```

**Why this works:** Remember from Topic 2, the translator uses key prefixes:
- `processPayment` → function (no colon)
- `interface:UserConfig` → interface
- `enum:Status` → enum
- `type:UserId` → type alias

The colon convention was designed specifically for this routing. It's O(1) — a string prefix check instead of inspecting the signature's internal structure.

---

## 3. The `Rule<T>` Interface — The Generic Contract

Every rule implements the [`Rule<T>`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/types.ts#L34-L53) interface:

```typescript
interface Rule<T extends AnySignature> {
    id:          string;              // 'R01'
    name:        string;              // 'Parameter Removed'
    description: string;              // Human-readable explanation
    languages:   Language[] | 'all';  // Which languages this applies to
    target:      'function' | 'interface' | 'enum' | 'type_alias';

    check: (oldSig: T, newSig: T) => RuleResult | RuleResult[] | null;
}
```

**The generic `T`** ensures type safety:
- `FunctionRule = Rule<FunctionSignature>` — the `check()` function receives `FunctionSignature` objects and can safely access `.params`, `.returnType`, etc.
- `EnumRule = Rule<EnumSignature>` — can access `.members`
- `InterfaceRule = Rule<InterfaceSignature>` — can access `.properties`

**Return types:**
- `null` → rule passed, no violation
- `RuleResult` → single violation found
- `RuleResult[]` → multiple violations (e.g., R27 can flag multiple removed enum members in one pass)

---

## 4. Walking Through Example Rules

### R01: Parameter Removed (Simple)

[`R01_param_removed.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/rules/R01_param_removed.ts):

```typescript
export const parameterRemovedRule: FunctionRule = {
    id: 'R01',
    name: 'Parameter Removed',
    languages: 'all',
    target: 'function',

    check(oldSig, newSig): RuleResult | null {
        for (const oldParam of oldSig.params) {
            const stillExists = newSig.params.some(p => p.name === oldParam.name);
            if (!stillExists) {
                return {
                    severity: 'breaking',
                    changeType: 'signature_change',
                    message: `Parameter '${oldParam.name}' was removed.`,
                };
            }
        }
        return null;  // All params still exist
    }
};
```

**Logic:** Loop through old params. If any one is missing from the new signature, it's breaking.

### R04: Parameter Type Narrowed (Medium Complexity)

[`R04_param_type_narrowed.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/rules/R04_param_type_narrowed.ts):

```typescript
check(oldSig, newSig): RuleResult | null {
    for (const oldParam of oldSig.params) {
        const newParam = newSig.params.find(p => p.name === oldParam.name);
        if (!newParam) continue;  // R01 handles removals

        const oldType = normalizeType(oldParam.type);
        const newType = normalizeType(newParam.type);

        if (oldType === newType) continue;

        // Condition 1: 'any' → concrete type
        if ((oldType === 'any' || oldType === 'unknown') &&
            newType !== 'any' && newType !== 'unknown') {
            return createViolation(oldParam.name, oldParam.type, newParam.type);
        }

        // Condition 2: Union narrowed (e.g., 'string | number' → 'string')
        if (oldType.includes('|')) {
            const oldTypes = new Set(oldType.split('|').map(t => t.trim()));
            const newTypes = new Set(newType.split('|').map(t => t.trim()));
            const isMissingOldType = [...oldTypes].some(t => !newTypes.has(t));
            if (isMissingOldType) {
                return createViolation(oldParam.name, oldParam.type, newParam.type);
            }
        }
    }
    return null;
}
```

**Key insight: Rule isolation.** R04 explicitly skips missing params (`if (!newParam) continue`) because that's R01's job. Each rule is responsible for exactly one category of breakage.

### R27: Enum Member Changed (Multiple Violations)

[`R27_enum_changed.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/classifier/rules/R27_enum_changed.ts):

```typescript
export const enumChangedRule: EnumRule = {
    id: 'R27',
    languages: ['typescript', 'java', 'rust'],  // Not all languages!
    target: 'enum',

    check(oldSig, newSig): RuleResult | RuleResult[] | null {
        const results: RuleResult[] = [];

        for (const oldMember of oldSig.members) {
            const newMember = newSig.members.find(m => m.name === oldMember.name);

            // Member removed
            if (!newMember) {
                results.push({ severity: 'breaking', ... });
                continue;
            }

            // Value re-assigned
            if (oldMember.value !== undefined &&
                newMember.value !== undefined &&
                oldMember.value !== newMember.value) {
                results.push({ severity: 'breaking', ... });
            }
        }

        return results.length > 0 ? results : null;
    }
};
```

**Two things to notice:**
1. **Language scoping:** `languages: ['typescript', 'java', 'rust']` — this rule is NOT universal because Python doesn't have traditional enums.
2. **Multiple violations:** If an enum has 3 removed members, this returns an array of 3 `RuleResult` objects. The engine handles both single results and arrays.

---

## 5. The Complete Rule Catalogue

### Parameter Rules (Function)
| Rule | What it detects | Severity |
|------|----------------|----------|
| **R01** | Parameter removed | Breaking |
| **R02** | Parameters reordered | Breaking |
| **R03** | Required parameter added | Breaking |
| **R04** | Parameter type narrowed (`any` → `string`) | Breaking |
| **R05** | Optional parameter added | Safe |
| **R12** | Parameter type widened (`string` → `any`) | Warning |
| **R14** | Rest parameter removed or added | Breaking / Warning |
| **R18** | Param mutability narrowed (`string[]` → `readonly string[]`) | Breaking |
| **R19** | Param mutability widened (`readonly string[]` → `string[]`) | Warning |

### Return Type Rules (Function)
| Rule | What it detects | Severity |
|------|----------------|----------|
| **R06** | Return type gained nullable (`string` → `string \| null`) | Breaking |
| **R07** | Return type narrowed (`any` → `string`) | Warning |
| **R22** | Return type changed to `never` | Breaking |

### Visibility & Modifier Rules (Function)
| Rule | What it detects | Severity |
|------|----------------|----------|
| **R08** | Exported → unexported | Breaking |
| **R28** | Unexported → exported | Safe |
| **R11** | Sync → async | Breaking |
| **R21** | Async → sync | Breaking |
| **R17** | Static ↔ instance swap | Breaking |
| **R20** | Visibility narrowed (`public` → `private`) | Breaking |

### Generic & Overload Rules (Function)
| Rule | What it detects | Severity |
|------|----------------|----------|
| **R13** | Generic constraint narrowed | Breaking |
| **R15** | Overload removed | Breaking |
| **R16** | Overload added | Warning |
| **R23** | Default value changed | Warning |
| **R24** | Constructor signature changed | Breaking |

### Interface, Enum & Type Rules
| Rule | What it detects | Severity |
|------|----------------|----------|
| **R25** | Required property added to interface | Breaking |
| **R26** | Property removed from interface | Breaking |
| **R27** | Enum member removed or value changed | Breaking |

---

## 6. The `FunctionChange` Output

Each violation becomes a [`FunctionChange`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/core/types.ts#L206-L255) object:

```typescript
interface FunctionChange {
    id:         string;           // 'src/payments/processor.ts:processPayment:42'
    name:       string;           // 'processPayment'
    file:       string;           // 'src/payments/processor.ts'
    lineStart:  number;           // 42
    lineEnd:    number;           // 42
    language:   Language;         // 'typescript'
    symbolType: 'function' | 'interface' | 'enum' | 'type_alias';

    before:     AnySignature | null;   // null = symbol was added
    after:      AnySignature | null;   // null = symbol was deleted

    changeType: ChangeType;       // 'signature_change'
    breaking:   boolean;          // true
    severity:   Severity;         // 'breaking'
    message?:   string;           // "Parameter 'userId' was removed"
    callers:    CallSite[];       // empty — populated later by the tracer
}
```

**Notice `callers: []`** — at this stage, the classifier doesn't know who calls this function. That's the tracer's job in Phase 4.

---

## The Complete Classification Flow

```
ParseResult { oldSigs, newSigs }
         │
         ▼
  ┌──────────────────────────┐
  │ Pre-compute rule buckets │ ← filter by language, group by target
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ Key Union: old ∪ new     │ ← covers deletions, additions, modifications
  └──────────────────────────┘
         │
    for each key:
         │
    ┌────┴────┬─────────┐
    ▼         ▼         ▼
 old only   new only   both exist
 (deleted)  (added)       │
    │         │           ▼
  R09       R10    isDeepStrictEqual?
 breaking   safe    ┌──yes──┐  no
                    │ skip  │   │
                    └───────┘   ▼
                         O(1) Key Routing
                         (prefix check)
                              │
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
               function   interface    enum
               rules      rules        rules
               (R01-R24)  (R25-R26)   (R27)
                    │         │          │
                    ▼         ▼          ▼
               RuleResult[] merged
                    │
                    ▼
            FunctionChange[]
          (sorted by lineStart)
```

---

## Interview Q&A

### "Walk me through the classifier algorithm"

> "The classifier takes a `ParseResult` — two Maps of signatures, old and new. First, it pre-computes rule buckets filtered by language and target type. Then it creates a key union of all symbol names from both Maps, which naturally covers three cases: deletions (key only in old), additions (key only in new), and modifications (key in both). For modifications, it short-circuits with `isDeepStrictEqual` — if nothing changed structurally, skip. Otherwise, it routes to the correct rule bucket using the key prefix (`interface:`, `enum:`, `type:`, or bare for functions) and runs every applicable rule."

### "How do the rules work?"

> "Each rule implements a generic `Rule<T>` interface with a `check(oldSig, newSig)` method. The generic ensures type safety — function rules get `FunctionSignature` objects, enum rules get `EnumSignature`. A rule returns `null` if it passes, a `RuleResult` for a single violation, or an array for multiple. Rules are isolated — R04 (type narrowed) explicitly skips missing params because that's R01's responsibility. This makes each rule independently testable."

### "Why pre-compute rule buckets?"

> "Without bucketing, for a file with 50 changed symbols and 26 rules, you'd filter the rule list 50 times — that's 1,300 filter operations. By pre-computing 4 buckets once per file, each symbol does a single `startsWith` check to find its bucket. It's O(1) routing instead of O(n) filtering per symbol."

---

*Next: [Phase 3, Topic 4 — The Data Contract](./phase3-topic4-data-contract.md)*
