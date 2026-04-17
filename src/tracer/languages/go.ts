/**
 * src/tracer/languages/go.ts
 *
 * GO LANGUAGE STRATEGY.
 *
 * Handles Go's package-based import model:
 *   - Standard import:  import "payments"          → payments.ProcessPayment()
 *   - Aliased import:   import pay "payments"      → pay.ProcessPayment()
 *   - Dot import:       import . "payments"        → ProcessPayment() (bare)
 *   - Multi-line import block:
 *       import (
 *           "fmt"
 *           pay "payments"
 *       )
 *
 * No barrel concept — Go packages ARE the module boundary.
 * No enum tracing — Go uses const blocks with iota, producing flat
 * exported constants (StatusActive, not Status.Active).
 *
 * @module GoStrategy
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
 * Q1: Bare function call — ProcessPayment(x, y)
 * Used for dot imports (import . "payments") where the symbol is unqualified.
 */
const BARE_CALL_QUERY = `
  (call_expression
    function: (identifier) @callee
    arguments: (argument_list) @args
  ) @call
`;

/**
 * Q2: Package-qualified call — payments.ProcessPayment(x, y)
 * The standard Go call pattern.
 */
const SELECTOR_CALL_QUERY = `
  (call_expression
    function: (selector_expression
      operand: (identifier) @object
      field: (field_identifier) @callee
    )
    arguments: (argument_list) @args
  ) @call
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE GO STRATEGY
// ─────────────────────────────────────────────────────────────────────────────

export const goStrategy: LanguageStrategy = {
  id: 'go',
  extensions: ['.go'],
  grammarFile: 'tree-sitter-go.wasm',
  grepGlobs: ['*.go'],

  // ── Scanner: Import patterns ─────────────────────────────────────────────

  buildImportPatterns(symbolName: string): ImportPattern[] {
    // Go import detection is fundamentally different from other languages.
    // You don't import individual symbols — you import the entire package.
    // The scanner's git grep finds files containing the symbol name.
    // We then verify that the file has an import statement for a package
    // that could provide this symbol.
    //
    // For the scanner, we match any import declaration (the tracer will
    // verify via AST that the call target is correct).

    return [
      // ── Standard import: "payments" (in import block or standalone) ────
      // Matches the last path segment as the package name.
      // verifyMatch: confirms payments.SymbolName actually appears in file
      {
        regex: new RegExp(
          `import\\s+"([^"]*)"`,
          'gm'
        ),
        type: 'go_import' as any,
        extractAlias: (match, sym) => {
          const pkgPath = match[1];
          const pkgName = pkgPath.split('/').pop() || pkgPath;
          return `${pkgName}.${sym}`;
        },
        verifyMatch: (_match, content, _sym, localName) => content.includes(localName),
      },

      // ── Aliased import: alias "path" ──────────────────────────────────
      // verifyMatch: confirms alias.SymbolName actually appears in file
      {
        regex: new RegExp(
          `(\\w+)\\s+"([^"]*)"`,
          'gm'
        ),
        type: 'go_import' as any,
        extractAlias: (match, sym) => `${match[1]}.${sym}`,
        verifyMatch: (_match, content, _sym, localName) => content.includes(localName),
      },

      // ── Dot import: . "path" → bare identifier ────────────────────────
      // verifyMatch: confirms the symbol appears as a word in the file body
      {
        regex: new RegExp(
          `\\.\\s+"([^"]*)"`,
          'gm'
        ),
        type: 'dot_import' as any,
        extractAlias: (_match, sym) => sym,
        verifyMatch: (match, content, sym, _localName) => {
          const afterImport = content.slice(match.index + match[0].length);
          return new RegExp(`\\b${escapeRegex(sym)}\\b`).test(afterImport);
        },
      },
    ];
  },

  // ── Scanner: Barrel patterns (none for Go) ───────────────────────────────

  buildBarrelPatterns(_symbolName: string): ImportPattern[] {
    return []; // Go has no barrel/re-export concept
  },

  isBarrelFile(_filePath: string): boolean {
    return false;
  },

  buildBarrelSearchTerm(_barrelPath: string): string {
    return '';
  },

  // ── Tracer: Call expression queries ──────────────────────────────────────

  callExpressionQueries: [BARE_CALL_QUERY, SELECTOR_CALL_QUERY],

  // ── Tracer: Argument counting ────────────────────────────────────────────

  countArguments(argsNode: any): { count: number; hasSpread: boolean } {
    let count = 0;
    let hasSpread = false;

    for (const child of argsNode.namedChildren) {
      count++;
      // Go variadic calls use the ... suffix: args...
      if (child.type === 'variadic_argument') {
        hasSpread = true;
      }
    }

    return { count: hasSpread ? -1 : count, hasSpread };
  },

  // ── Tracer: Call target verification ─────────────────────────────────────

  verifyCallTarget(
    callNode: any,
    searchName: string,
    calleeText: string,
  ): boolean {
    const isDotNotation = searchName.includes('.');

    if (isDotNotation) {
      // Package-qualified: payments.ProcessPayment
      const pkgAlias = searchName.split('.')[0];
      const bareIdentifier = searchName.split('.').pop()!;

      if (calleeText !== bareIdentifier) return false;

      // Verify the operand (package alias) matches
      const funcNode = callNode.childForFieldName('function');
      if (funcNode && funcNode.type === 'selector_expression') {
        const operandNode = funcNode.childForFieldName('operand');
        if (operandNode && operandNode.text !== pkgAlias) return false;
      }
      return true;
    }

    // Dot import: bare identifier
    return calleeText === searchName;
  },

  // ── Tracer: Enum access (disabled for Go) ────────────────────────────────

  supportsEnumTracing: false,

  walkEnumAccess(
    _rootNode: any,
    _enumName: string,
    _memberSet: Set<string>,
    _filePath: string,
  ): RawEnumAccess[] {
    // Go doesn't have namespaced enums. Const iota values are flat
    // exported identifiers (StatusActive, not Status.Active).
    // They are traced as standard symbol changes, not enum member changes.
    return [];
  },
};
