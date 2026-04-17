/**
 * src/core/types.ts
 * * THE DIFF-GUARDIAN DATA CONTRACT
 * This file is the absolute source of truth for the entire diff-guardian architecture.
 * It serves as the bridge between the AST Parsers (which read raw code) and the 
 * Classifier Engine (which calculates risk). Every single TypeScript feature that 
 * could potentially cause a breaking change—across all 28+ classification rules—is 
 * mathematically represented in these interfaces. 
 */

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'rust';

// ── Severity ──────────────────────────────────────────────────────────────────
// Three-bucket model.
// 'breaking' → callers break at runtime or compile time
// 'warning'  → behaviorally different, callers may not break immediately
//              e.g. R23 default value changed, R28 unexported→exported
// 'safe'     → no existing caller affected

export type Severity =
  | 'breaking'
  | 'warning'
  | 'safe';

// ── ChangeType ────────────────────────────────────────────────────────────────
// Every category of API surface change the classifier can produce.
// Maps directly to the 28 classification rules.

export type ChangeType =
  | 'signature_change'           // R1-R5, R12-R14: params added/removed/reordered/retyped
  | 'return_type_widened'        // R6:  gained null | undefined | never
  | 'return_type_narrowed'       // R7:  any → string (non-breaking but flagged)
  | 'visibility_changed'         // R8, R20, R28: exported↔unexported, public↔protected↔private
  | 'modifier_changed'           // R11, R17, R21, R22: async/static/abstract/generator toggled
  | 'decorator_changed'          // R16: decorator added, removed, or modified
  | 'overload_changed'           // R15, R16: overload removed or added
  | 'interface_property_added'   // R25: new required property added to interface
  | 'interface_property_removed' // R26: property removed from interface
  | 'enum_member_changed'        // R27: enum value removed, renamed, or re-assigned
  | 'type_alias_changed'         // type alias union narrowed or structurally changed
  | 'symbol_deleted'             // R9:  symbol removed entirely
  | 'symbol_added';              // R10: new symbol added (non-breaking)

export interface TypeParameter {
  name: string;        // e.g., 'T'
  constraint?: string; // e.g., 'Record<string, unknown>'
}
export interface Param {
  name:          string;    // 'userId', '{...}', '[...]', '...args'
  type:          string;    // raw text: 'string', 'User | null', 'readonly string[]'
  optional:      boolean;   // true if param has ? modifier OR has default value
  hasDefault:    boolean;   // true if param has = someValue specifically
                            // optional=true + hasDefault=false → x?: T
                            // optional=true + hasDefault=true  → x = val
                            // classifier uses hasDefault to distinguish R1 vs R5
  defaultValue?: string;    // the actual default value text — R23: default value changed
  isRest?:       boolean;   // true if ...rest param — R14 depends on this
}

// ── FunctionSignature ─────────────────────────────────────────────────────────
// Represents the complete, extractable shape of one function at one point in time.
// Produced by the parser. Consumed by the classifier.
export interface FunctionSignature {

  // ── Identity ────────────────────────────────────────────────────────────────
  name:            string;              // 'processPayment' | 'Service#constructor'
  line:            number;              // 1-indexed start line — used by reporter
  filePath?:       string;              // optional — parser has no file knowledge
                                        // injected by ASTMapper after parsing

  // ── Signature shape ──────────────────────────────────────────────────────────
  params:          Param[];             // ordered — order matters for R3
  returnType:      string | 'inferred';// 'inferred' = no annotation present
                                        // classifier skips R6/R7 when 'inferred'
                                        // NEVER default to 'any' — that is a real type
  typeParameters?: TypeParameter[];     // ['T extends Record<string,unknown>']
                                        // R13: generic constraint narrowed

  // ── Modifiers ────────────────────────────────────────────────────────────────
  exported:        boolean;             // R8:  exported → unexported
  isDefaultExport: boolean;             // named vs default export
                                        // different import syntax = different breakage
  async:           boolean;             // R11: sync → async (breaking)
                                        // R21: async → sync (breaking)
  isStatic?:       boolean;             // R17: static ↔ instance swap
  isAbstract?:     boolean;             // adding abstract forces subclasses to implement
  isGenerator?:    boolean;             // function* toggle — changes iteration protocol
                                        // callers using .next() break
  isConstructor?:  boolean;             // R24: constructor sig change
                                        // keyed as 'ClassName#constructor'
  isGetter?:       boolean;             // get accessor — property read semantics
  isSetter?:       boolean;             // set accessor — property write semantics

  // ── Class context ────────────────────────────────────────────────────────────
  className?:      string;              // parent class name
                                        // prevents collisions when two classes
                                        // both have a method called 'find'
  accessModifier?: 'public'             // R20: visibility narrowed
                 | 'protected'          // protected → private = breaking
                 | 'private';           // public → protected = breaking

  // ── Metadata ─────────────────────────────────────────────────────────────────
  decorators?:     string[];            // ['Injectable', 'deprecated']
                                        // R16: decorator removed or changed
  overloadIndex?:  number;             // 0, 1, 2 — position in overload sequence
                                        // prevents overloads overwriting each other
                                        // in the signature Map
  overloadCount?:  number;             // total number of overload signatures for this name
                                        // R15/R16 compare old vs new counts to detect
                                        // overload additions and removals
}

// ── InterfaceProperty ─────────────────────────────────────────────────────────

export interface InterfaceProperty {
  name:      string;    // the property key name
  type:      string;    // raw type string
  optional:  boolean;   // has ? modifier — R25/R26
  readonly?: boolean;   // interface property readonly IS valid TypeScript
                        // removing readonly from a property = breaking change
                        // callers that relied on immutability guarantee break
}

// ── InterfaceSignature ────────────────────────────────────────────────────────

export interface InterfaceSignature {
  line:            number;     // 1-indexed start line
  properties:      InterfaceProperty[];
  exported:        boolean;
  isDefaultExport?: boolean;
  typeParameters?: TypeParameter[];   // 'interface Response<T>'
  extends?:        string[];   // ['Base', 'Auditable']
                               // removing a parent interface = breaking
                               // callers relying on inherited properties break
}

// ── EnumMember ────────────────────────────────────────────────────────────────

export interface EnumMember {
  name:    string;   // the enum key: 'Active'
  value?:  string;   // explicit initializer: '1'
                     // undefined = auto-incremented
                     // auto-incremented values shift when members are inserted
                     // mid-enum — a silent but real breakage
}

// ── EnumSignature ─────────────────────────────────────────────────────────────

export interface EnumSignature {
  line:             number;    // 1-indexed start line
  members:          EnumMember[];
  exported:         boolean;
  isDefaultExport?: boolean;
}

// ── TypeAliasSignature ────────────────────────────────────────────────────────

export interface TypeAliasSignature {
  line:             number;    // 1-indexed start line
  value:            string;    // raw string: "'active' | 'inactive'"
  exported:         boolean;
  isDefaultExport?: boolean;
  typeParameters?:  TypeParameter[];  // 'type Node<T> = ...'
}

// ── CallSite ──────────────────────────────────────────────────────────────────
// Produced by the JIT tracer for each caller of a changed function.
// Merges reporter needs (lineEnd, covered) with tracer needs (argumentCount, isBroken).
//
// Lifecycle:
//   1. Scanner (Phase 2) finds importer files
//   2. Tracer  (Phase 3) parses each file and produces one CallSite per call expression
//   3. Reporter (Phase 4) renders each CallSite with line-level precision

export interface CallSite {
  file:             string;    // 'src/checkout/index.ts'
  lineStart:        number;    // 1-indexed start line of the call expression
  lineEnd:          number;    // end line — needed for multi-line call highlighting in PR comments

  // ── Tracer fields ─────────────────────────────────────────────────────────
  argumentCount:    number;    // actual number of arguments at this call site
                               // -1 = indeterminate (contains spread element)
  isBroken:         boolean;   // true if argumentCount does not match required range
  isFixed:          boolean;   // true if this call was broken in oldSource but
                               // the developer updated it correctly in newSource
  isIndeterminate:  boolean;   // true if call uses spread args (...args)
                               // indeterminate calls are never marked as broken
                               // to prevent false positives — the developer may
                               // be correctly spreading the right number of args

  // ── Test coverage ─────────────────────────────────────────────────────────
  covered:          boolean;   // true if a test file references this caller
                               // used by testGaps detection in AnalysisResult
}

// ── FunctionChange ────────────────────────────────────────────────────────────
// Output of the classifier. One entry per changed symbol.
// 'symbol' covers functions, interfaces, enums, and type aliases.

export interface FunctionChange {
  id:           string;     // unique: 'src/payments/processor.ts:processPayment:42'
  name:         string;     // 'processPayment' | 'UserInterface' | 'Status'
  fingerprint?: string;     // structural AST hash — correlates renames across line moves
                            // v0.2 feature, optional in v0.1
  file:         string;     // 'src/payments/processor.ts'
  lineStart:    number;     // start line in new file (0 if deleted)
  lineEnd:      number;     // end line in new file
  language:     Language;   // which parser produced this
  symbolType:   'function'  // discriminator — tells classifier which
              | 'interface' // union branch to cast before/after to
              | 'enum'
              | 'type_alias';

  before: FunctionSignature            // state at baseSha
        | InterfaceSignature
        | EnumSignature
        | TypeAliasSignature
        | null;                        // null = symbol was added (no before state)

  after:  FunctionSignature            // state at headSha
        | InterfaceSignature
        | EnumSignature
        | TypeAliasSignature
        | null;                        // null = symbol was deleted (no after state)

  changeType: ChangeType;
  breaking:   boolean;      // true if classifier determined callers will break
  severity:   Severity;     // breaking | warning | safe — reporter bucketing
  message?:   string;       // reason for the violation reported by the classifier rule
  callers:    CallSite[];   // populated by tracer (empty array after classifier)

  // ── Tracer metadata ───────────────────────────────────────────────────────
  // Populated by the pipeline after classification, consumed by the tracer.

  // Function-specific (symbolType === 'function')
  requiredParamCount?: number;  // minimum args the new signature requires
                                // = params.filter(p => !p.optional && !p.isRest).length
  totalParamCount?:    number;  // maximum args (including optional, excluding rest)
                                // = params.filter(p => !p.isRest).length
  validArgCounts?:     Set<number>;  // for overloaded functions: the set of valid
                                     // argument counts across ALL overload signatures
                                     // undefined = not overloaded, use requiredParamCount..totalParamCount range

  // Enum-specific (symbolType === 'enum')
  removedEnumMembers?: string[];   // member names that were deleted: ['Active', 'Suspended']
                                   // tracer greps for EnumName.MemberName to find broken usages
  changedEnumMembers?: string[];   // member names whose VALUE changed: ['Status']
                                   // same tracing strategy — runtime behavior corruption
}

// ── RiskFile ──────────────────────────────────────────────────────────────────

export interface RiskFile {
  path:    string;                         // 'src/api/routes/payment.ts'
  risk:    'critical' | 'high' | 'medium'; // risk tier
  reason:  string;                         // 'Contains 4 broken call sites'
  changes: number;                         // number of changed symbols in this file
}

// ── AnalysisResult ────────────────────────────────────────────────────────────
// The complete output of the full pipeline. Consumed by all reporters.

export interface AnalysisResult {
  from:        string;           // 'main'
  to:          string;           // 'feature/payment-refactor'
  baseSha:     string;           // exact commit hash — ensures report immutability
  headSha:     string;           // exact commit hash
  breaking:    FunctionChange[]; // severity: 'breaking'
  warnings:    FunctionChange[]; // severity: 'warning'  ← was missing
  apiChanges:  FunctionChange[]; // all changes breaking + warning + safe
  testGaps:    FunctionChange[]; // breaking changes whose callers lack tests
  riskFiles:   RiskFile[];
}

// ── FileDiff ──────────────────────────────────────────────────────────────────
// Output of git-diff.ts. Input to ast-mapper.ts.

export interface FileDiff {
  path:      string;   // 'src/payments/processor.ts'
  language:  string;   // raw extension: 'ts', 'py', 'go'
  isNew:     boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  oldPath:   string;   // original path before rename (= path if not renamed)
  oldSource: string;   // full text at baseSha (empty string if isNew)
  newSource: string;   // full text at headSha (empty string if isDeleted)
}

// ── ParseResult ───────────────────────────────────────────────────────────────
// Output of ast-mapper.ts per file. Input to classifier.ts.
// The Map key is the symbol name — sig.name for functions,
// property name for interfaces, member name for enums.

export type AnySignature =
  | FunctionSignature
  | InterfaceSignature
  | EnumSignature
  | TypeAliasSignature;

export interface ParseResult {
  file:        string;
  language:    Language;
  oldSigs:     Map<string, AnySignature>;
  newSigs:     Map<string, AnySignature>;
  skipped:     boolean;
  skipReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRACER DOMAIN TYPES
// These interfaces define the data contract between the JIT Scanner (Phase 2)
// and the Call-Site Tracer (Phase 3).
// ═══════════════════════════════════════════════════════════════════════════════

// ── ImportReference ──────────────────────────────────────────────────────────
// Represents a single import of a target symbol found by the scanner.
// Tracks aliases so the tracer knows which identifier to search for.

export interface ImportReference {
  filePath:     string;    // absolute or repo-relative path of the importing file
  importedName: string;    // original exported name: 'processPayment'
  localName:    string;    // local binding: 'handlePayment' (or same as importedName if no alias)
  isBarrel:     boolean;   // true if this file just re-exports the symbol
                           // barrel files are added to the scanner queue, not the tracer queue
  importLine:   number;    // 1-indexed line of the import statement
  importType:   'static'          // TS/JS:   import { x } from './mod'
              | 'dynamic'         // TS/JS:   const { x } = await import('./mod')
              | 'require'         // TS/JS:   const { x } = require('./mod')
              | 'wildcard'        // TS/JS:   import * as mod from './mod'
              | 'from_import'     // Python:  from payments import process_payment
              | 'module_import'   // Python:  import payments → payments.process_payment()
              | 'java_import'     // Java:    import com.example.Status;
              | 'static_import'   // Java:    import static com.example.Status.ACTIVE;
              | 'go_import'       // Go:      import "payments" / alias "payments"
              | 'dot_import'      // Go:      import . "payments" → bare identifier
              | 'use'             // Rust:    use crate::payments::process_payment;
              | 'use_glob'        // Rust:    use crate::payments::*;
              | 'use_group';      // Rust:    use crate::payments::{process_payment, ...};
}

// ── GrepMatch ────────────────────────────────────────────────────────────────
// Raw output from the git grep phase. One per file that contains the symbol name.
// Lightweight — no AST parsing yet.

export interface GrepMatch {
  filePath:   string;     // 'src/checkout/cart.ts'
  matchLine:  number;     // line number of the grep hit (approximate — for debugging only)
  matchText:  string;     // the matched line text (for debugging)
}

// ── TracerResult ─────────────────────────────────────────────────────────────
// Complete output of the tracer for one FunctionChange.
// Contains all resolved call sites and metadata about the scan.

export interface TracerResult {
  functionName:    string;        // 'processPayment'
  totalFilesGrepped: number;      // how many files the grep phase scanned
  importersFound:  number;        // how many files actually import the symbol
  barrelsTraversed: number;       // how many barrel files were walked
  callSites:       CallSite[];    // all resolved call sites across all importer files
  errors:          string[];      // non-fatal errors encountered during tracing
}

// ── TracerConfig ─────────────────────────────────────────────────────────────
// Configuration for the JIT tracer. Controls which languages are traced,
// performance limits, and behavior flags.

export interface TracerConfig {
  // Language scoping — supports TS/JS, Python, Java, Go, and Rust.
  // Each language has its own LanguageStrategy in src/tracer/languages/.
  tracerLanguages:  Language[];   // default: ['typescript', 'javascript']

  // Performance limits — prevents runaway scans on massive repos
  maxGrepResults:   number;       // max files returned by grep (default: 500)
  maxBarrelDepth:   number;       // max recursive barrel file depth (default: 10)
  maxTracerFiles:   number;       // max files to AST-parse in Phase 3 (default: 100)

  // Behavior
  traceOnlyBreaking: boolean;     // if true, only trace breaking changes (default: true)
                                  // if false, also trace warnings for completeness
  repoRoot:         string;       // absolute path to repo root
  headSha:          string;       // git ref for committed content (used by git grep)
}