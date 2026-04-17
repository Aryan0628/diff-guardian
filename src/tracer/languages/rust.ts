/**
 * src/tracer/languages/rust.ts
 *
 * RUST LANGUAGE STRATEGY.
 *
 * Handles Rust's `use` import model:
 *   - use item:       use crate::payments::process_payment;
 *   - use alias:      use crate::payments::process_payment as pp;
 *   - use glob:       use crate::payments::*;
 *   - use group:      use crate::payments::{process_payment, refund};
 *
 * Gotcha 1 fix (multi-line use groups):
 *   Rust's `rustfmt` aggressively wraps `use` groups across multiple lines:
 *     use crate::payments::{
 *         process_payment,    // regex fails on \n
 *         refund_payment,
 *     };
 *   Fix: Scanner does NOT regex-match use {} blocks. It uses simple
 *   `git grep "sym"` + a simpler single-line regex. The tracer's AST
 *   parser confirms the actual import in Phase 3.
 *
 * Barrel equivalent:
 *   mod.rs / lib.rs files with `pub use` re-exports.
 *
 * Enum access:
 *   Rust uses :: for enum member access: Status::Active
 *   This is a `scoped_identifier` node, NOT `member_expression`.
 *
 * @module RustStrategy
 */

import type { LanguageStrategy, ImportPattern, RawEnumAccess } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Regex utilities
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree-sitter query sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Q1: Bare function call — process_payment(x, y)
 * Used when the function was brought into scope via `use`.
 */
const BARE_CALL_QUERY = `
  (call_expression
    function: (identifier) @callee
    arguments: (arguments) @args
  ) @call
`;

/**
 * Q2: Path-qualified call — payments::process_payment(x, y)
 * Used when calling via module path without a use import.
 */
const SCOPED_CALL_QUERY = `
  (call_expression
    function: (scoped_identifier
      name: (identifier) @callee
    )
    arguments: (arguments) @args
  ) @call
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE RUST STRATEGY
// ─────────────────────────────────────────────────────────────────────────────

export const rustStrategy: LanguageStrategy = {
  id: 'rust',
  extensions: ['.rs'],
  grammarFile: 'tree-sitter-rust.wasm',
  grepGlobs: ['*.rs'],

  // ── Scanner: Import patterns ─────────────────────────────────────────────

  buildImportPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── use item: use crate::payments::process_payment; ───────────────
      // Also matches: use crate::payments::process_payment as pp;
      {
        regex: new RegExp(
          `use\\s+[\\w:]+::${escaped}(?:\\s+as\\s+(\\w+))?\\s*;`,
          'gm'
        ),
        type: 'use' as any,
        extractAlias: (match, sym) => match[1] || sym,
      },

      // ── use glob: use crate::payments::*; ─────────────────────────────
      // verifyMatch: confirms the symbol appears as a word in the file
      {
        regex: new RegExp(
          `use\\s+[\\w:]+::\\*\\s*;`,
          'gm'
        ),
        type: 'use_glob' as any,
        extractAlias: (_match, sym) => sym,
        verifyMatch: (_match, content, sym, _localName) => {
          return new RegExp(`\\b${escapeRegex(sym)}\\b`).test(content);
        },
      },

      // ── use group (single-line only): use path::{sym, other}; ─────────
      {
        regex: new RegExp(
          `use\\s+[\\w:]+::\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*;`,
          'gm'
        ),
        type: 'use_group' as any,
        extractAlias: (match, sym) => {
          // Check for alias: {process_payment as pp, other}
          const braceContent = match[0].match(/\{([^}]+)\}/)?.[1] || '';
          const parts = braceContent.split(',').map(p => p.trim());
          for (const part of parts) {
            const aliasMatch = part.match(
              new RegExp(`^${escapeRegex(sym)}\\s+as\\s+(\\w+)$`)
            );
            if (aliasMatch) return aliasMatch[1];
          }
          return sym;
        },
      },

      // ── Fallback: multi-line use group (Gotcha 1 fix) ─────────────────
      // rustfmt wraps use groups across lines. The regex above can't match
      // multi-line blocks. This fallback catches: any line containing `use`
      // followed by `{` (opening a group). verifyMatch then confirms the
      // symbol actually appears as a word in the file.
      // This is intentionally broad — the tracer (Phase 3) AST-verifies.
      {
        regex: new RegExp(
          `use\\s+[\\w:]+::\\{`,
          'gm'
        ),
        type: 'use_group' as any,
        extractAlias: (_match, sym) => sym,
        verifyMatch: (_match, content, sym, _localName) => {
          return new RegExp(`\\b${escapeRegex(sym)}\\b`).test(content);
        },
      },
    ];
  },

  // ── Scanner: Barrel patterns ─────────────────────────────────────────────

  buildBarrelPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── pub use re-export: pub use crate::payments::process_payment; ──
      {
        regex: new RegExp(
          `pub\\s+use\\s+[\\w:]+::${escaped}\\s*;`,
          'gm'
        ),
        type: 'use' as any,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },

      // ── pub use glob: pub use crate::payments::*; ─────────────────────
      {
        regex: new RegExp(
          `pub\\s+use\\s+[\\w:]+::\\*\\s*;`,
          'gm'
        ),
        type: 'use_glob' as any,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },

      // ── pub use group: pub use path::{sym, ...}; ──────────────────────
      {
        regex: new RegExp(
          `pub\\s+use\\s+[\\w:]+::\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*;`,
          'gm'
        ),
        type: 'use_group' as any,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },
    ];
  },

  // ── Scanner: Barrel file detection ───────────────────────────────────────

  isBarrelFile(filePath: string): boolean {
    return filePath.endsWith('mod.rs') || filePath.endsWith('lib.rs');
  },

  buildBarrelSearchTerm(barrelPath: string): string {
    // mod.rs / lib.rs → parent directory name
    // e.g., 'src/payments/mod.rs' → 'payments'
    const dir = barrelPath
      .replace(/mod\.rs$/, '')
      .replace(/lib\.rs$/, '')
      .replace(/\/$/, '');
    return dir.split(/[\\/]/).pop() || '';
  },

  // ── Tracer: Call expression queries ──────────────────────────────────────

  callExpressionQueries: [BARE_CALL_QUERY, SCOPED_CALL_QUERY],

  // ── Tracer: Argument counting ────────────────────────────────────────────

  countArguments(argsNode: any): { count: number; hasSpread: boolean } {
    let count = 0;
    const hasSpread = false;

    for (const child of argsNode.namedChildren) {
      count++;
      // Rust doesn't have spread syntax in function calls.
      // Closures as arguments are counted as normal args.
    }

    return { count, hasSpread };
  },

  // ── Tracer: Call target verification ─────────────────────────────────────

  verifyCallTarget(
    _callNode: any,
    searchName: string,
    calleeText: string,
  ): boolean {
    // For `use` imports, the symbol is brought into local scope.
    // The callee is a bare identifier — just check it matches.
    // For scoped calls (path::fn), the callee capture already extracted
    // just the function name from scoped_identifier.
    const bareIdentifier = searchName.includes('.')
      ? searchName.split('.').pop()!
      : searchName;
    return calleeText === bareIdentifier;
  },

  // ── Tracer: Enum access (:: syntax) ──────────────────────────────────────

  supportsEnumTracing: true,

  walkEnumAccess(
    rootNode: any,
    enumName: string,
    memberSet: Set<string>,
    filePath: string,
  ): RawEnumAccess[] {
    const accesses: RawEnumAccess[] = [];
    walkScopedIdentifier(rootNode, enumName, memberSet, filePath, accesses);
    return accesses;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Recursive scoped_identifier walker for Rust enum access
// Status::Active → scoped_identifier: path=Status, name=Active
// ─────────────────────────────────────────────────────────────────────────────

function walkScopedIdentifier(
  node:      any,
  enumName:  string,
  memberSet: Set<string>,
  filePath:  string,
  accesses:  RawEnumAccess[],
): void {
  if (node.type === 'scoped_identifier') {
    const pathNode = node.childForFieldName('path');
    const nameNode = node.childForFieldName('name');

    if (pathNode && nameNode) {
      // Match: Status::Active where pathNode = "Status" and nameNode = "Active"
      // Also handle nested paths: crate::Status::Active → last path segment
      const pathText = pathNode.text;
      const lastSegment = pathText.split('::').pop() || pathText;

      if (lastSegment === enumName && memberSet.has(nameNode.text)) {
        accesses.push({
          filePath,
          lineStart:  node.startPosition.row + 1,
          lineEnd:    node.endPosition.row + 1,
          memberName: nameNode.text,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      walkScopedIdentifier(child, enumName, memberSet, filePath, accesses);
    }
  }
}
