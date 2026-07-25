# Phase 1 · Topic 3: Breaking Changes & API Contracts

---

## Part A: What is an API Contract?

An **API contract** is the implicit or explicit promise a function makes to its callers about how it behaves. It includes:

- **What it accepts** — parameter names, types, order, which are required vs optional
- **What it returns** — the return type and shape of the result
- **How to access it** — is it exported? Public or private? A static method or instance method?
- **What guarantees it provides** — is it synchronous or async? Does it throw?

### Example: The Contract of `processPayment()`

```typescript
export function processPayment(amount: number, currency: string): boolean {
  // implementation
}
```

This function's contract is:

| Aspect | Promise |
|--------|---------|
| **Name** | `processPayment` |
| **Parameters** | 2 required: `amount` (number), `currency` (string) |
| **Parameter order** | `amount` first, `currency` second |
| **Return type** | `boolean` |
| **Visibility** | Exported (public API — anyone can import and call it) |
| **Async** | No (synchronous — caller doesn't need `await`) |

Every caller of this function is **relying on this contract**. If any part of it changes, callers might break.

The problem is: **this contract only exists in code structure** — there's no formal document that says "here is my contract." The code IS the contract. And that's why you need a tool that can read code structure to detect when the contract changes.

---

## Part B: Semantic Versioning (SemVer)

Semantic versioning is the standard way to communicate contract changes through version numbers:

```
MAJOR.MINOR.PATCH
  │     │     │
  │     │     └── Bug fixes, no API change        (e.g., 1.2.3 → 1.2.4)
  │     └──────── New features, backward-compatible (e.g., 1.2.3 → 1.3.0)
  └────────────── BREAKING changes                 (e.g., 1.2.3 → 2.0.0)
```

| Version bump | When to use | Example change |
|-------------|-------------|----------------|
| **PATCH** (1.2.3 → 1.2.4) | Fix a bug without changing behavior | Fix off-by-one in calculation |
| **MINOR** (1.2.3 → 1.3.0) | Add new functionality, all old code still works | Add optional `timeout` parameter |
| **MAJOR** (1.2.3 → 2.0.0) | Break existing callers — they must update their code | Remove a required parameter |

The promise of semver: **if I'm on version 1.x, I can safely upgrade to any other 1.x without my code breaking.** Only a MAJOR bump means I might need to change my code.

**Why this matters for Diff-Guardian:** Diff-Guardian detects changes that should trigger a MAJOR bump — the breaking changes that most teams miss because `git diff` can't see them.

---

## Part C: Categories of Breaking Changes

A **breaking change** is any API modification that could cause existing callers to fail at compile time or runtime. Diff-Guardian classifies these into specific categories:

### 1. Parameter Changes

The most common category. Parameters are the #1 source of breaking changes.

```typescript
// ❌ BREAKING: Parameter removed (R01)
// Before
export function createUser(name: string, email: string, role: string) { ... }
// After — callers still passing 3 args will break (or the 3rd arg maps to wrong param)
export function createUser(name: string, email: string) { ... }

// ❌ BREAKING: Required parameter added (R03)
// Before
export function createUser(name: string) { ... }
// After — callers passing only 1 arg will fail
export function createUser(name: string, email: string) { ... }

// ✅ SAFE: Optional parameter added (R05)
// Before
export function createUser(name: string) { ... }
// After — callers passing only 1 arg still work
export function createUser(name: string, email?: string) { ... }

// ❌ BREAKING: Parameter reordered (R02)
// Before
export function createUser(name: string, email: string) { ... }
// After — callers passing (name, email) now have them swapped
export function createUser(email: string, name: string) { ... }

// ⚠️ WARNING: Parameter type narrowed (R04)
// Before — accepts anything
export function createUser(id: string | number) { ... }
// After — callers passing number will fail
export function createUser(id: string) { ... }
```

### 2. Return Type Changes

```typescript
// ❌ BREAKING: Return type gained nullable (R06)
// Before — callers assume they always get a User back
export function getUser(id: string): User { ... }
// After — callers will crash on .name if null is returned
export function getUser(id: string): User | null { ... }

// ⚠️ WARNING: Return type narrowed (R07)
// Before
export function getUser(id: string): any { ... }
// After — technically safer but behavior changed
export function getUser(id: string): User { ... }

// ❌ BREAKING: Return type changed to never (R22)
// Before — function returns normally
export function getUser(id: string): User { ... }
// After — function now always throws (never returns)
export function getUser(id: string): never { throw new Error('removed'); }
```

### 3. Visibility Changes

```typescript
// ❌ BREAKING: Exported → unexported (R08)
// Before — other files can import this
export function processPayment() { ... }
// After — import statements in other files will fail
function processPayment() { ... }

// ⚠️ WARNING: Unexported → exported (R28)
// Before — internal only
function processPayment() { ... }
// After — now part of public API (may be intentional, but worth flagging)
export function processPayment() { ... }

// ❌ BREAKING: Visibility narrowed (R20)
// Before — accessible from outside the class
class PaymentService {
  public charge(amount: number) { ... }
}
// After — external callers can't access anymore
class PaymentService {
  private charge(amount: number) { ... }
}
```

### 4. Modifier Changes

```typescript
// ❌ BREAKING: Sync → async (R11)
// Before — callers use: const result = processPayment()
export function processPayment(): boolean { ... }
// After — callers must use: const result = await processPayment()
export async function processPayment(): Promise<boolean> { ... }

// ❌ BREAKING: Static ↔ instance swap (R17)
// Before — callers use: PaymentService.create()
class PaymentService {
  static create() { ... }
}
// After — callers must use: new PaymentService().create()
class PaymentService {
  create() { ... }  // no longer static
}
```

### 5. Interface and Enum Changes

```typescript
// ❌ BREAKING: Optional property made required (R25)
// Before — callers don't need to provide email
interface User { name: string; email?: string; }
// After — all objects implementing User must now have email
interface User { name: string; email: string; }

// ❌ BREAKING: Interface property removed (R26)
// Before — callers rely on .role existing
interface User { name: string; role: string; }
// After — callers accessing .role will get undefined
interface User { name: string; }

// ❌ BREAKING: Enum member removed/changed (R27)
// Before
enum Status { Active = 'active', Inactive = 'inactive', Suspended = 'suspended' }
// After — anyone using Status.Suspended will fail
enum Status { Active = 'active', Inactive = 'inactive' }
```

### The Enum Value Trap — Silent Data Corruption

This is a particularly nasty one. Consider:

```typescript
// Before
enum Priority { Low, Medium, High }
// Compiled values: Low = 0, Medium = 1, High = 2

// After — someone inserts "Critical" at the beginning
enum Priority { Critical, Low, Medium, High }
// Compiled values: Critical = 0, Low = 1, Medium = 2, High = 3
```

No member was removed. No type error at compile time. But every **value shifted**. If someone stored `Priority.High` (value `2`) in a database, it now maps to `Medium`. Silent data corruption.

---

## Part D: Why Standard `git diff` Can't Detect These

Let's look at what `git diff` actually shows for a breaking change:

```diff
--- a/src/payments/processor.ts
+++ b/src/payments/processor.ts
@@ -1,3 +1,3 @@
-export function processPayment(amount: number, currency: string): boolean {
+export function processPayment(amount: number): boolean {
   return amount > 0;
 }
```

Git diff tells you:
- ✅ A line was removed and a new line was added
- ✅ The file path

Git diff does NOT tell you:
- ❌ **What** changed semantically (a parameter was removed)
- ❌ Whether it's **breaking** (it's a required parameter, so yes)
- ❌ Whether the function is **exported** (it is — public API)
- ❌ **Who** calls this function (3 files import it)
- ❌ **Whether those callers will break** (2 out of 3 still pass the removed arg)

This is the fundamental gap Diff-Guardian fills: the gap between **"what text changed"** and **"what breaks."**

### Text-Level vs Structural-Level Analysis

```
Text-Level (git diff):
  "Line 1 changed from X to Y"
  
Structural-Level (Diff-Guardian):
  "The function 'processPayment' had parameter 'currency' (type: string, required) removed.
   This is BREAKING (R01). 3 call sites affected: 2 broken, 1 already fixed."
```

---

## Part E: Real-World Examples of Silent API Breakages

These are the kinds of bugs that pass code review, pass tests (if tests are weak), and break production:

### Example 1: The Default Value Landmine

```typescript
// PR #142: "Refactor: simplify createOrder"
// Reviewer thinks: "looks cleaner, LGTM 👍"

// Before
export function createOrder(items: Item[], discount: number = 0) { ... }

// After
export function createOrder(items: Item[], discount: number) { ... }
```

The `= 0` default was removed. Every caller that relied on the default (`createOrder(myItems)` without passing discount) now gets `undefined` for `discount`. This passes TypeScript compilation in strict mode but causes runtime `NaN` when discount is used in arithmetic.

### Example 2: The Re-Export Chain Bomb

```typescript
// src/index.ts (barrel file)
export { processPayment } from './payments/processor';

// A developer moves processPayment to a new file and updates the barrel:
export { processPayment } from './payments/new-processor';

// But they also changed the signature in new-processor.ts:
// Was:  processPayment(amount: number, currency: string)
// Now:  processPayment(amount: number, opts: PaymentOptions)

// Every consumer importing from './index.ts' is now broken
// but they never touched their import statements
```

### Example 3: The Async Migration

```typescript
// "Performance improvement: make getUser async for caching"

// Before
export function getUser(id: string): User { ... }

// After
export async function getUser(id: string): Promise<User> { ... }

// Every caller now gets a Promise<User> instead of User
// None of them use await, so they're operating on an unresolved promise
// Everything compiles. Everything runs. Results are silently wrong.
```

All three of these would be caught by Diff-Guardian — R23 (default value changed), R01 (parameter removed) + R04 (type narrowed), and R11 (sync → async) respectively.

---

## Part F: The 26 Rules at a Glance

Diff-Guardian has 26 classification rules. Here's the complete overview — you'll dive deep into each in Phase 3:

| Rule | Name | Severity | What it detects |
|------|------|----------|----------------|
| R01 | Parameter Removed | Breaking | A parameter was deleted from the signature |
| R02 | Parameter Reordered | Breaking | Parameters exist but in different order |
| R03 | Required Param Added | Breaking | New non-optional parameter added |
| R04 | Param Type Narrowed | Warning | Parameter type became more restrictive |
| R05 | Optional Param Added | Safe | New optional parameter added |
| R06 | Return Nullable | Breaking | Return type gained `null` or `undefined` |
| R07 | Return Narrowed | Warning | Return type became more specific |
| R08 | Unexported | Breaking | Exported symbol became unexported |
| R11 | Sync → Async | Breaking | Synchronous function became async |
| R12 | Param Type Widened | Safe | Parameter type became more permissive |
| R13 | Generic Narrowed | Breaking | Generic constraint became more restrictive |
| R14 | Rest Param Changed | Breaking | Rest parameter added/removed/retyped |
| R15 | Overload Removed | Breaking | A function overload signature was removed |
| R16 | Overload Added | Warning | A new overload was added |
| R17 | Static Changed | Breaking | Static ↔ instance swap |
| R18 | Mutability Narrowed | Breaking | Parameter gained `readonly` |
| R19 | Mutability Widened | Warning | Parameter lost `readonly` |
| R20 | Visibility Narrowed | Breaking | Access level became more restrictive |
| R21 | Async → Sync | Breaking | Async function became synchronous |
| R22 | Return Never | Breaking | Return type changed to `never` |
| R23 | Default Changed | Warning | Default parameter value changed |
| R24 | Constructor Changed | Breaking | Class constructor signature changed |
| R25 | Interface Prop Required | Breaking | Optional property became required |
| R26 | Interface Prop Removed | Breaking | Property removed from interface |
| R27 | Enum Changed | Breaking | Enum member removed or value changed |
| R28 | Exported | Warning | Unexported symbol became exported |

**Pattern to notice:** Rules that **remove** something or **restrict** something are almost always `breaking`. Rules that **add** something or **widen** something are usually `safe` or `warning`.

---

## Key Terms

| Term | Definition |
|------|-----------|
| **API Contract** | The implicit promise a function makes about what it accepts, returns, and how to access it |
| **Breaking Change** | Any modification that causes existing callers to fail at compile or runtime |
| **SemVer** | `MAJOR.MINOR.PATCH` versioning where MAJOR = breaking, MINOR = additive, PATCH = fix |
| **Narrowing** | Making a type more restrictive (`string \| number` → `string`). Usually breaking for parameters. |
| **Widening** | Making a type more permissive (`string` → `string \| number`). Usually safe for parameters. |
| **Exported** | Marked with `export` keyword — part of the public API, importable by other files |
| **Severity** | Diff-Guardian's three buckets: `breaking` (callers will fail), `warning` (behavior changed), `safe` (no impact) |
| **Classification Rule** | One specific check the classifier runs (e.g., R01: Parameter Removed) |

---

## 🎤 Interview Q&A

### "What is a breaking change?"

> "A breaking change is any modification to a function, interface, or enum's public API surface that would cause existing callers to fail — either at compile time or at runtime. Examples include removing a parameter, narrowing a type, or making an exported function unexported. The key insight is that the 'contract' between a function and its callers exists only in code structure, and standard git diff only sees text changes, not structural ones."

### "Why can't git diff detect breaking changes?"

> "Git diff operates at the text level — it knows a line was added, removed, or modified, but it has no concept of parameters, return types, or exports. It can't tell you whether a text change removes a required parameter, changes a return type, or affects visibility. It also can't tell you WHO calls that function. You need structural analysis (AST parsing) to understand what a change means semantically, and call-site tracing to understand the blast radius."

### "How did you come up with 26 rules?"

> "We started from real production incidents — every rule maps to a real category of silent breakage we've seen pass code review. The rules follow a pattern: anything that removes or restricts something (parameters, visibility, types) is usually `breaking`, while anything that adds or widens is usually `safe`. We cover functions (R01–R24), interfaces (R25–R26), enums (R27), and visibility (R08, R28). Each rule is a small, focused check — single responsibility principle."

### "Give me a tricky example of a breaking change that's hard to catch"

> "Enum value shifts. If you have `enum Priority { Low, Medium, High }` and someone inserts `Critical` at the beginning, no member is removed and TypeScript compiles fine. But every auto-incremented value shifts — `Low` goes from 0 to 1, `Medium` from 1 to 2, etc. If anyone stored these values in a database, their data now maps to the wrong member. Silent data corruption. Our R27 rule catches this by comparing member values, not just names."

### "What's the difference between narrowing and widening?"

> "Narrowing means restricting what's accepted — going from `string | number` to just `string`. Widening means expanding — going from `string` to `string | number`. For **parameters**, narrowing is breaking (callers passing numbers now fail) and widening is safe (existing callers still work). For **return types**, it's flipped — narrowing is safe (callers get a more specific type) but widening is breaking (callers might get `null` when they expected a value). This is related to the concept of **covariance** and **contravariance** in type theory."

---

*Phase 1 complete! Next: [Phase 2, Topic 1 — Problem Statement, Architecture & Data Flow](./phase2-topic1-architecture-data-flow.md)*
