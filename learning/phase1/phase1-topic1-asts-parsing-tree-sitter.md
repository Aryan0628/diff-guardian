# Phase 1 · Topic 1: ASTs, Parsing & Tree-Sitter

---

## Part A: What is "Parsing"?

When you write code like this:

```typescript
function processPayment(amount: number, currency: string): boolean {
  return amount > 0;
}
```

Your computer doesn't "understand" this text the way you do. To a computer, this is just a string of characters:

```
f u n c t i o n   p r o c e s s P a y m e n t ( a m o u n t ...
```

**Parsing** is the process of taking this flat string of characters and converting it into a **structured representation** that a program can reason about.

Think of it like reading a sentence in English:

```
"The big dog chased the small cat"
```

A human doesn't read this letter by letter. Your brain automatically recognizes:
- "The big dog" → subject (noun phrase)
- "chased" → verb
- "the small cat" → object (noun phrase)

Parsing code works the same way. The parser reads characters and recognizes **structure**.

---

## Part B: The Two Steps of Parsing

### Step 1: Tokenization (Lexing)

First, the raw characters are grouped into meaningful chunks called **tokens**. This step is called **lexing** or **tokenization**.

```typescript
function processPayment(amount: number, currency: string): boolean {
```

Gets broken into tokens:

```
Token 1:  KEYWORD      → "function"
Token 2:  IDENTIFIER   → "processPayment"
Token 3:  LPAREN       → "("
Token 4:  IDENTIFIER   → "amount"
Token 5:  COLON        → ":"
Token 6:  TYPE         → "number"
Token 7:  COMMA        → ","
Token 8:  IDENTIFIER   → "currency"
Token 9:  COLON        → ":"
Token 10: TYPE         → "string"
Token 11: RPAREN       → ")"
Token 12: COLON        → ":"
Token 13: TYPE         → "boolean"
Token 14: LBRACE       → "{"
...
```

Each token has a **type** (KEYWORD, IDENTIFIER, etc.) and a **value** (the actual text).

> **Analogy**: Tokenization is like separating a sentence into individual words. You go from raw characters to meaningful units.

### Step 2: Parsing — Building the Tree

Now the parser takes these flat tokens and arranges them into a **tree structure** based on the language's grammar rules. This tree is called an **Abstract Syntax Tree (AST)**.

```
                    function_declaration
                    /        |         \
                   /         |          \
              name:       parameters:    return_type:
         "processPayment"    |           "boolean"
                             |
                    formal_parameters
                     /            \
                    /              \
          parameter:            parameter:
           /     \               /     \
       name:    type:        name:    type:
     "amount" "number"    "currency" "string"
```

**This is the AST.** It's a tree where:
- The **root** is the function declaration
- **Branches** represent structural relationships (the function HAS parameters, each parameter HAS a name and type)
- **Leaves** are the actual values ("processPayment", "number", "string")

---

## Part C: Why Is It Called "Abstract"?

The word **abstract** means the tree throws away unimportant syntactic details:
- Parentheses `( )` — the tree already knows what's grouped together
- Commas `,` — the tree already knows the parameters are a list
- Semicolons `;` — the tree already knows where statements end
- Whitespace and formatting — completely irrelevant to structure

The AST captures **meaning**, not **syntax characters**.

> **Key insight**: If you write `2 + 3` or `(2 + 3)` or `2+3`, they all produce the same AST node: `addition(left: 2, right: 3)`. The parentheses are syntax noise, not meaning.

### Concrete Syntax Tree (CST) vs Abstract Syntax Tree (AST)

| Property | CST (Parse Tree) | AST |
|----------|-------------------|-----|
| Includes every grammar rule | ✅ Yes | ❌ No |
| Includes parens, commas, semicolons | ✅ Yes | ❌ No |
| Used for exact text reconstruction | ✅ Yes | ❌ Not designed for it |
| Used for code analysis | ⚠️ Possible but noisy | ✅ Ideal |

**Important nuance**: Tree-Sitter actually produces a **CST** (it keeps everything including commas and parens). But Diff-Guardian's translators walk the CST and extract only the meaningful parts into signature objects — effectively creating an abstracted view. So the pipeline is: CST → selective extraction → Signatures.

---

## Part D: Why Can't We Just Use Regex / grep?

This is the critical question — and the entire reason Diff-Guardian exists.

### The Problem with Text-Based Analysis

Suppose someone on your team changes this function:

```typescript
// BEFORE
export function processPayment(amount: number, currency: string): boolean { ... }

// AFTER
export function processPayment(amount: number): boolean { ... }
```

They removed the `currency` parameter. This is a **breaking change** — every caller that passes a currency argument will fail.

**Can `git diff` tell you this?** Yes, it shows text changed:

```diff
- export function processPayment(amount: number, currency: string): boolean {
+ export function processPayment(amount: number): boolean {
```

But git diff doesn't know:
- ❌ That a **parameter** was removed (it just sees text changed)
- ❌ That it was a **required** parameter (not optional)
- ❌ That the function is **exported** (public API, others depend on it)
- ❌ **Who** calls this function and will break

**Can regex tell you?** Let's try:

```regex
/function processPayment\((.*)\)/
```

This breaks when:
```typescript
// Multi-line — regex doesn't handle this well
function processPayment(
  amount: number,
  currency: string,
): boolean { ... }

// Comment containing the same text — false positive
// function processPayment(amount) was deprecated

// String containing the text — false positive
const log = "function processPayment(amount) called";
```

### What an AST Gives You

With an AST, you can ask precise structural questions:

```
Q: "Find all function_declaration nodes where name = 'processPayment'"
A: Found 1 node at line 5.

Q: "What are its parameters?"
A: [{ name: 'amount', type: 'number', optional: false }]
   ← Only 1 parameter now! Previously had 2.

Q: "Is it exported?"
A: Yes — the parent node is an 'export_statement'.
```

The AST doesn't care about comments, strings, formatting, or multi-line syntax. It gives you the **structural truth** of the code.

---

## Part E: What is Tree-Sitter?

Tree-Sitter is a **parser generator** — a tool that generates fast, incremental parsers for programming languages. It was originally built by GitHub for the Atom editor and now powers syntax highlighting and code analysis in many tools.

### Parser Generator vs Hand-Written Parser

| Approach | How it works | Examples |
|----------|-------------|----------|
| **Hand-written parser** | Developer manually writes code to recognize tokens and build tree. Tedious, error-prone, one language at a time. | V8 (JavaScript), rustc (Rust) |
| **Parser generator** | Developer writes a **grammar file** (the rules), the tool **generates the parser automatically**. | Tree-Sitter, ANTLR, Yacc, Bison |

Tree-Sitter takes a `grammar.js` file (which defines rules like "a function_declaration has a name, parameters, and a body") and generates a C-based parser from it. That parser can then be compiled to different targets.

### Why Tree-Sitter Specifically?

There are many parsers. Here's why Tree-Sitter was chosen for Diff-Guardian over alternatives:

| Parser | Problem for Diff-Guardian |
|--------|--------------------------|
| **Babel** | JavaScript/TypeScript only. Can't parse Python, Go, Java, Rust. |
| **ESLint parser** | JavaScript/TypeScript only. Designed for linting, not structural comparison. |
| **SWC** | JavaScript/TypeScript only. Designed for transpilation speed, not analysis. |
| **ANTLR** | Supports multiple languages but generates Java-based parsers. Heavy runtime. |
| **Tree-Sitter** | ✅ Supports 100+ languages with the **same API**. Compiles to WASM for portability. Incremental parsing. Error recovery. |

The killer feature: **one API to parse all languages**. Diff-Guardian parses TypeScript, JavaScript, Python, Go, Java, and Rust all through the same `parser.parse(sourceCode)` call. Only the grammar changes.

### Three Key Features of Tree-Sitter

#### 1. Incremental Parsing

If you change one line of a 10,000-line file, Tree-Sitter **doesn't re-parse the whole file**. It reuses the parts of the tree that didn't change and only re-parses the affected region.

```
File: 10,000 lines
Changed: line 42 (added a parameter)

Traditional parser: re-parse all 10,000 lines → ~50ms
Tree-Sitter:        re-parse ~20 nodes near line 42 → ~0.5ms
```

This matters when parsing hundreds of files per diff scan.

#### 2. Error Recovery

Most parsers crash or produce garbage when they encounter a syntax error. Tree-Sitter keeps going. It marks the broken region as an `ERROR` node and produces a valid tree for everything else.

```typescript
// This file has a syntax error:
function broken( {    // ← missing closing paren
  return 42;
}

function valid(x: number): number {
  return x + 1;
}
```

Tree-Sitter will:
- Mark `broken` as an `ERROR` node
- Correctly parse `valid` as a `function_declaration`
- Diff-Guardian can still analyze `valid` even though `broken` is malformed

This is critical because **real codebases have syntax errors** — files in progress, experimental branches, template files.

#### 3. S-Expression Queries

Tree-Sitter has a built-in query language for searching the AST. Queries look like this:

```scheme
(function_declaration
  name: (identifier) @name
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return
) @fn
```

This says: "Find every `function_declaration` node. Capture its name as `@name`, its parameters as `@params`, and its return type (if it exists) as `@return`. Capture the whole thing as `@fn`."

This is how Diff-Guardian's [TypeScript translator](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/translators/typescript.ts) finds all functions in a file. Real query from the codebase:

```typescript
const FN_QUERY_SRC = `
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    return_type: (type_annotation)? @return
  ) @fn

  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params
    return_type: (type_annotation)? @return
  ) @fn

  (method_signature
    name: (property_identifier) @name
    parameters: (formal_parameters) @params
    return_type: (type_annotation)? @return
  ) @fn
`;
```

One query matches three different node types — function declarations, class methods, and interface method signatures — all in a single pass.

---

## Part F: What is WebAssembly (WASM)?

### The Problem: Platform Portability

Tree-Sitter's parsers are written in C. C code compiles to **native binaries** — but a binary compiled for macOS won't run on Linux, and neither will run on Windows. And compiling C code requires a C toolchain that most Node.js developers don't have installed.

```
C source code
     ├── compile for macOS → tree-sitter-typescript.dylib  (Mac only)
     ├── compile for Linux → tree-sitter-typescript.so     (Linux only)
     └── compile for Windows → tree-sitter-typescript.dll  (Windows only)
```

This creates a distribution nightmare for an npm package. You'd need to ship different binaries for every OS + architecture combination.

### The Solution: WASM

**WebAssembly (WASM)** is a portable binary format that runs in a sandboxed virtual machine. The same `.wasm` file runs identically on macOS, Linux, and Windows — anywhere that has a WASM runtime (which includes every modern browser and Node.js).

```
C source code
     └── compile to WASM → tree-sitter-typescript.wasm  (runs EVERYWHERE)
```

### How Diff-Guardian Uses WASM

Diff-Guardian compiles each Tree-Sitter grammar into a `.wasm` file:

```
grammars/
  ├── tree-sitter-typescript.wasm    ← compiled from tree-sitter-typescript C code
  ├── tree-sitter-javascript.wasm
  ├── tree-sitter-python.wasm
  ├── tree-sitter-go.wasm
  ├── tree-sitter-java.wasm
  └── tree-sitter-rust.wasm
```

At runtime, the [ASTMapper](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/ast-mapper.ts) loads these WASM files lazily:

```typescript
// Simplified from ast-mapper.ts
const wasmPath = path.join(__dirname, '../../grammars', `tree-sitter-${grammarName}.wasm`);
const language = await Parser.Language.load(wasmPath);
parser.setLanguage(language);
const tree = parser.parse(sourceCode);
```

### Why WASM Over Native C++ Bindings?

Node.js can run C++ code directly through "native addons" (`.node` files). Why not use that?

| Factor | Native C++ addon | WASM |
|--------|-----------------|------|
| **Install** | Requires C++ toolchain, `node-gyp`, Python | Just download a `.wasm` file |
| **Portability** | Different binary per OS/arch | One binary runs everywhere |
| **CI/CD** | Must rebuild per platform | Cache once, use forever |
| **Security** | Full OS access | Sandboxed — can't touch filesystem |
| **Performance** | ~10% faster | Slightly slower but negligible for Diff-Guardian's use case |

The trade-off is clear: WASM sacrifices ~10% raw speed for **zero install friction** and **universal portability**. For a tool that parses diffs (not real-time editor use), this is the right call.

### The `web-tree-sitter` npm Package

Diff-Guardian uses `web-tree-sitter` — the official JavaScript binding for Tree-Sitter's WASM runtime. It provides:

```typescript
import Parser from 'web-tree-sitter';

// Initialize the WASM runtime
await Parser.init();

// Load a language grammar
const Lang = await Parser.Language.load('tree-sitter-typescript.wasm');

// Create a parser and set the language
const parser = new Parser();
parser.setLanguage(Lang);

// Parse source code into a tree
const tree = parser.parse('function foo(x: number) { return x; }');

// Walk the tree
const root = tree.rootNode;
console.log(root.toString());
// → (program (function_declaration name: (identifier) parameters: (formal_parameters ...)))
```

---

## Part G: How Diff-Guardian Puts It All Together

```
Source Code (string)
       │
       ▼
  [ Tree-Sitter WASM Parser ]  ← loads .wasm grammar, parses to CST
       │
       ▼
  Concrete Syntax Tree (CST)
       │
       ▼
  [ Language Translator ]  ← walks CST, extracts only meaningful structure
       │
       ▼
  Signature Map   ← Map<string, AnySignature>
       │
       ▼
  [ Classifier ]  ← compares old signature map vs new signature map
       │
       ▼
  Breaking Changes Detected
```

Diff-Guardian does this **twice** for every changed file:
1. Parse the **old version** (from base branch) → old signatures
2. Parse the **new version** (from feature branch) → new signatures
3. Compare old vs new → detect what changed at a structural level

### A Real Example End-to-End

Given this function:

```typescript
export async function processPayment(
  amount: number,
  currency?: string,
  ...options: PaymentOption[]
): Promise<boolean> {
  // implementation
}
```

Tree-Sitter parses it into a CST. The TypeScript translator walks that CST and produces:

```typescript
{
  name: "processPayment",
  exported: true,
  async: true,
  params: [
    { name: "amount",   type: "number",          optional: false, hasDefault: false },
    { name: "currency", type: "string",          optional: true,  hasDefault: false },
    { name: "options",  type: "PaymentOption[]", optional: false, isRest: true     },
  ],
  returnType: "Promise<boolean>",
  isDefaultExport: false,
  line: 1,
}
```

This is a `FunctionSignature` — a complete, structured snapshot of the function's public API surface. The classifier compares the old signature to the new one to detect exactly what changed.

---

## Key Terms

| Term | Definition |
|------|-----------|
| **Parsing** | Converting a flat string into a structured representation (tree) |
| **Token / Lexeme** | The smallest meaningful unit of code (keyword, identifier, operator) |
| **Lexing / Tokenization** | Step 1 — breaking characters into tokens |
| **AST** | Tree structure representing the structural meaning of code, minus syntax noise |
| **CST (Parse Tree)** | Like AST but keeps everything — parens, commas, semicolons |
| **Node** | One element in the tree (e.g., `function_declaration`, `identifier`) |
| **Grammar** | Rules that define valid syntax for a language |
| **Parser Generator** | Tool that reads a grammar and auto-generates a parser (Tree-Sitter, ANTLR) |
| **Incremental Parsing** | Re-parsing only the changed part of a file, not the whole thing |
| **S-Expression Query** | Tree-Sitter's pattern language for searching the tree structurally |
| **WASM** | Portable binary format that runs the same on all platforms |
| **Signature** | Diff-Guardian's structured object capturing a symbol's public API shape |

---

## 🎤 Interview Q&A

### "How does your tool analyze code?"

> "We use Tree-Sitter, a parser generator that compiles language grammars into WASM binaries. For each changed file, we parse both the old and new versions into syntax trees. Then we walk those trees to extract structural signatures — function parameters, return types, visibility modifiers, etc. The classifier compares old vs new signatures to detect breaking changes. This works across 6 languages through the same API — only the grammar file changes."

### "Why not just use regex?"

> "Regex operates on text — it can't distinguish a function definition from a comment mentioning the function or a string containing the function name. It breaks on multi-line code, nested syntax, and aliased imports. AST parsing gives us structural truth — we know precisely what's a parameter, what's a return type, and whether something is exported. It's the difference between looking at pixels vs understanding the image."

### "What's the difference between a parse tree and an AST?"

> "A parse tree (concrete syntax tree) includes every grammar rule and syntax character — parentheses, commas, semicolons. An AST is simplified to keep only meaningful structure. Tree-Sitter produces a CST, but our translators extract only the meaningful parts into signature objects — effectively creating an abstract view on top of the concrete tree."

### "Why Tree-Sitter over Babel or SWC?"

> "Babel and SWC only handle JavaScript and TypeScript. We needed to analyze 6 languages with one unified pipeline. Tree-Sitter supports 100+ languages through the same API — you just swap the grammar. It also compiles to WASM for zero-install portability and has incremental parsing and error recovery built in."

### "What is WASM and why did you use it?"

> "WebAssembly is a portable binary format — the same .wasm file runs on macOS, Linux, and Windows without recompilation. Tree-Sitter parsers are written in C, which normally means you'd need a C toolchain to install our tool. By compiling to WASM, users just `npm install` and everything works. The ~10% performance cost vs native is negligible for our use case since we're parsing diffs, not running a real-time editor."

### "DSA connection: What data structure is an AST?"

> "An AST is a **rooted, ordered tree** (specifically an n-ary tree — each node can have any number of children). Traversing it uses **DFS** (depth-first search) — we walk down into children before moving to siblings. Tree-Sitter queries are essentially pattern matching on tree structure, similar to how you'd match subtrees in competitive programming. The signature Map we build is a **hash map** for O(1) lookup when the classifier needs to compare old vs new signatures."

---

*Next up: [Phase 1, Topic 2 — Git Internals for Code Analysis](./phase1-topic2-git-internals.md)*
