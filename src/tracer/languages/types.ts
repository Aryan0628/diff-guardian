/**
 * src/tracer/languages/types.ts
 *
 * LANGUAGE STRATEGY CONTRACT.
 *
 * This interface decouples the scanner (Phase 2) and tracer (Phase 3) from
 * language-specific import syntax, call expression grammar, and enum access
 * patterns. Each supported language (TS, Python, Java, Go, Rust) provides
 * its own implementation.
 *
 * The scanner and tracer become pure orchestrators — they call into the
 * strategy for every language-specific decision.
 *
 * Design principles:
 *   - Strategies are stateless — all state lives in the scanner/tracer
 *   - Strategies are synchronous — no I/O, no file system access
 *   - One strategy per Language enum value
 *   - Go's strategy sets supportsEnumTracing = false (no enum namespace)
 *
 * @module LanguageStrategy
 */

import type { Language, ImportReference } from '../../core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Raw extraction types — shared across strategies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw call site extracted from the AST — before classification.
 * Used by the tracer to collect all call expressions matching a target symbol.
 */
export interface RawCallSite {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  argumentCount: number;    // -1 if indeterminate (has spread/splat)
  hasSpread: boolean;
}

/**
 * Raw enum member access extracted from the AST — before classification.
 * Used by the tracer to collect all EnumName.Member (or EnumName::Member) accesses.
 */
export interface RawEnumAccess {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  memberName: string;       // the accessed member: 'Active'
}

// ─────────────────────────────────────────────────────────────────────────────
// Import pattern — one per regex the scanner tests against each file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single import detection regex pattern.
 * The scanner iterates through a strategy's patterns to classify each file.
 *
 * `extractAlias` resolves the local binding name from the regex match.
 * For example, given `import { fn as alias } from './mod'`, it returns 'alias'.
 */
export interface ImportPattern {
  /** The regex to test against the file content. Must use 'gm' flags. */
  regex: RegExp;

  /** Import type classification for this pattern. */
  type: ImportReference['importType'];

  /**
   * Extracts the local alias from a regex match.
   * @param match     — the RegExpExecArray from regex.exec()
   * @param symbolName — the original exported symbol name
   * @returns the local binding name (may differ from symbolName if aliased)
   */
  extractAlias: (match: RegExpExecArray, symbolName: string) => string;

  /**
   * If true, this pattern detects a barrel re-export (not a direct import).
   * The file will be added to the BFS barrel queue instead of the tracer queue.
   */
  isBarrel?: boolean;

  /**
   * Optional secondary verification. If provided, a regex match is only
   * accepted as valid when this returns true. Used to eliminate false positives
   * from patterns that don't embed the symbol name (e.g., wildcard imports).
   */
  verifyMatch?: (match: RegExpExecArray, content: string, symbolName: string, localName: string) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The main strategy interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Language-specific strategy for the JIT Scanner (Phase 2) and
 * Call-Site Tracer (Phase 3).
 *
 * Each supported language implements this interface to teach the tracer:
 *   1. How to detect imports via regex (scanner phase)
 *   2. How to find call expressions via tree-sitter queries (tracer phase)
 *   3. How to find enum member access via AST walking (tracer phase)
 */
export interface LanguageStrategy {
  /** Language identifier — must match the Language type from core/types. */
  readonly id: Language;

  /** File extensions this strategy handles. e.g., ['.ts', '.tsx', '.js', '.jsx'] */
  readonly extensions: string[];

  /** WASM grammar filename. e.g., 'tree-sitter-typescript.wasm' */
  readonly grammarFile: string;

  /** Glob patterns for git grep. e.g., ['*.ts', '*.tsx', '*.js', '*.jsx'] */
  readonly grepGlobs: string[];

  // ── Scanner (Phase 2) ────────────────────────────────────────────────────

  /**
   * Builds regex patterns for detecting imports of a symbol.
   * The scanner tests each pattern against the file content.
   *
   * Must handle all import syntaxes for this language:
   *   TS:     import {}, import *, require(), import()
   *   Python: from X import Y, import X
   *   Java:   import X.Y, import static X.Y
   *   Go:     "path" in import block
   *   Rust:   use path::sym, use path::{sym, ...}, use path::*
   */
  buildImportPatterns(symbolName: string): ImportPattern[];

  /**
   * Builds regex patterns for detecting barrel/re-export patterns.
   * Files matching these are added to the BFS barrel queue.
   *
   * TS:     export {} from, export * from
   * Python: from .sub import sym (in __init__.py)
   * Rust:   pub use path::sym
   * Java/Go: not applicable (return [])
   */
  buildBarrelPatterns(symbolName: string): ImportPattern[];

  /**
   * Returns true if the file path represents a barrel/index file.
   *
   * TS:     index.ts, index.js
   * Python: __init__.py
   * Rust:   mod.rs, lib.rs
   * Java/Go: false (no barrel concept)
   */
  isBarrelFile(filePath: string): boolean;

  /**
   * Extracts the search term for finding consumers of a barrel file.
   * e.g., 'src/checkout/index.ts' → 'checkout'
   */
  buildBarrelSearchTerm(barrelPath: string): string;

  // ── Tracer: Call expressions (Phase 3) ────────────────────────────────────

  /**
   * Tree-sitter S-expression queries for matching call expressions.
   * Returns an array because some languages need multiple queries:
   *   - Java needs both method_invocation and bare identifier (static imports)
   *   - Go needs both identifier and selector_expression
   *
   * Each query MUST capture:
   *   @callee — the function/method name identifier
   *   @args   — the arguments node
   *   @call   — the full call expression (for line numbers)
   *
   * Optional captures:
   *   @object — the object/namespace (for verification: payments.fn vs other.fn)
   */
  readonly callExpressionQueries: string[];

  /**
   * Counts arguments in an arguments node.
   * Language-specific because:
   *   - Python has *args and **kwargs spread
   *   - Rust has no spread but has trailing closures
   *   - Java has varargs
   *
   * @returns { count, hasSpread }
   */
  countArguments(argsNode: any): { count: number; hasSpread: boolean };

  /**
   * Verifies that a matched call expression actually refers to the target symbol.
   * Used for namespace/module imports where the object must match.
   *
   * e.g., Python: `payments.process_payment()` matches only when
   *        the import was `import payments`, not `from other import process_payment`.
   *
   * @param callNode     — the full call expression AST node
   * @param searchName   — the local name to search for (may include namespace: 'payments.fn')
   * @param calleeText   — the text of the @callee capture
   * @returns true if this call is a genuine match
   */
  verifyCallTarget(
    callNode: any,
    searchName: string,
    calleeText: string,
  ): boolean;

  // ── Tracer: Enum/member access ────────────────────────────────────────────

  /**
   * Whether this language supports enum member access tracing.
   * false for Go (uses flat const, not namespaced enums).
   */
  readonly supportsEnumTracing: boolean;

  /**
   * Walks the AST tree to find all EnumName.MemberName access patterns
   * where MemberName is in the brokenMembers set.
   *
   * Language-specific AST patterns:
   *   TS/Python/Java:  member_expression / attribute / field_access
   *   Rust:            scoped_identifier (Status::Active)
   *   Go:              N/A (supportsEnumTracing = false)
   *
   * @param rootNode   — the root AST node of the parsed file
   * @param enumName   — the enum identifier: 'Status'
   * @param memberSet  — the set of broken member names: {'Active', 'Suspended'}
   * @param filePath   — for populating RawEnumAccess.filePath
   */
  walkEnumAccess(
    rootNode: any,
    enumName: string,
    memberSet: Set<string>,
    filePath: string,
  ): RawEnumAccess[];
}
