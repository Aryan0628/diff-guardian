/**
 * src/tracer/languages/python.ts
 *
 * PYTHON LANGUAGE STRATEGY.
 *
 * Handles Python's dual import model:
 *   Style 1 (from-import):  from payments import process_payment
 *   Style 2 (module-import): import payments → payments.process_payment()
 *
 * Gotcha 3 fix:
 *   For Style 2 (module import), the localName is set to 'payments.process_payment'
 *   (composite). The tracer verifies that the `attribute.object.text === 'payments'`
 *   to prevent false matches on `other_module.process_payment()`.
 *
 * Barrel equivalent:
 *   Python's __init__.py files act as barrels when they contain:
 *     from .submodule import process_payment
 *
 * Enum access:
 *   Python uses class-based enums (enum.Enum subclasses).
 *   Access pattern: Status.ACTIVE → attribute node with object=Status, property=ACTIVE
 *
 * @module PythonStrategy
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
 * Q1: Direct call — process_payment(x, y)
 * Used for `from payments import process_payment` style imports.
 */
const DIRECT_CALL_QUERY = `
  (call
    function: (identifier) @callee
    arguments: (argument_list) @args
  ) @call
`;

/**
 * Q2: Attribute call — payments.process_payment(x, y)
 * Used for `import payments` style imports.
 * Gotcha 3: tracer MUST verify object === namespace alias.
 */
const ATTRIBUTE_CALL_QUERY = `
  (call
    function: (attribute
      object: (identifier) @object
      attribute: (identifier) @callee
    )
    arguments: (argument_list) @args
  ) @call
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE PYTHON STRATEGY
// ─────────────────────────────────────────────────────────────────────────────

export const pythonStrategy: LanguageStrategy = {
  id: 'python',
  extensions: ['.py'],
  grammarFile: 'tree-sitter-python.wasm',
  grepGlobs: ['*.py'],

  // ── Scanner: Import patterns ─────────────────────────────────────────────

  buildImportPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── from X import Y ───────────────────────────────────────────────
      // from payments import process_payment
      // from payments import process_payment as pp
      {
        regex: new RegExp(
          `from\\s+\\S+\\s+import\\s+([^\\n]*\\b${escaped}\\b[^\\n]*)`,
          'gm'
        ),
        type: 'from_import' as any,
        extractAlias: (match, sym) => {
          const specifiers = match[1];
          // Check for aliasing: process_payment as pp
          const parts = specifiers.split(',').map(p => p.trim());
          for (const part of parts) {
            const aliasMatch = part.match(
              new RegExp(`^${escapeRegex(sym)}\\s+as\\s+(\\w+)$`)
            );
            if (aliasMatch) return aliasMatch[1];
            if (part === sym || part.startsWith(sym)) return sym;
          }
          return sym;
        },
      },

      // ── import X (module import) ──────────────────────────────────────
      // import payments → usage: payments.process_payment()
      // Gotcha 3: composite localName for tracer verification
      // verifyMatch: confirms payments.process_payment actually appears in file
      {
        regex: new RegExp(
          `^import\\s+(\\w+)\\s*$`,
          'gm'
        ),
        type: 'module_import' as any,
        extractAlias: (match, sym) => `${match[1]}.${sym}`,
        verifyMatch: (_match, content, _sym, localName) => content.includes(localName),
      },

      // ── from X import * (wildcard) ────────────────────────────────────
      // verifyMatch: confirms the symbol name appears as a word in the file
      // (beyond just the import line itself)
      {
        regex: new RegExp(
          `from\\s+\\S+\\s+import\\s+\\*`,
          'gm'
        ),
        type: 'wildcard' as any,
        extractAlias: (_match, sym) => sym,
        verifyMatch: (match, content, sym, _localName) => {
          // Check that the symbol appears somewhere AFTER the import line
          const afterImport = content.slice(match.index + match[0].length);
          return new RegExp(`\\b${escapeRegex(sym)}\\b`).test(afterImport);
        },
      },
    ];
  },

  // ── Scanner: Barrel patterns ─────────────────────────────────────────────

  buildBarrelPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── __init__.py re-export: from .submodule import fn ──────────────
      {
        regex: new RegExp(
          `from\\s+\\.\\S*\\s+import\\s+([^\\n]*\\b${escaped}\\b[^\\n]*)`,
          'gm'
        ),
        type: 'from_import' as any,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },

      // ── __init__.py wildcard: from .submodule import * ────────────────
      {
        regex: new RegExp(
          `from\\s+\\.\\S*\\s+import\\s+\\*`,
          'gm'
        ),
        type: 'wildcard' as any,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },
    ];
  },

  // ── Scanner: Barrel file detection ───────────────────────────────────────

  isBarrelFile(filePath: string): boolean {
    return filePath.endsWith('__init__.py');
  },

  buildBarrelSearchTerm(barrelPath: string): string {
    // __init__.py → directory name
    // e.g., 'src/payments/__init__.py' → 'payments'
    const dir = barrelPath.replace(/__init__\.py$/, '').replace(/\/$/, '');
    return dir.split(/[\\/]/).pop() || '';
  },

  // ── Tracer: Call expression queries ──────────────────────────────────────

  callExpressionQueries: [DIRECT_CALL_QUERY, ATTRIBUTE_CALL_QUERY],

  // ── Tracer: Argument counting ────────────────────────────────────────────

  countArguments(argsNode: any): { count: number; hasSpread: boolean } {
    let count = 0;
    let hasSpread = false;

    for (const child of argsNode.namedChildren) {
      // Skip keyword separator (*, //)
      if (child.type === 'keyword_separator') continue;

      count++;

      // Python *args and **kwargs
      if (child.type === 'list_splat' || child.type === 'dictionary_splat') {
        hasSpread = true;
      }
    }

    return { count: hasSpread ? -1 : count, hasSpread };
  },

  // ── Tracer: Call target verification (Gotcha 3 fix) ──────────────────────

  verifyCallTarget(
    callNode: any,
    searchName: string,
    calleeText: string,
  ): boolean {
    const isDotNotation = searchName.includes('.');

    if (isDotNotation) {
      // Module import: payments.process_payment
      const namespaceName = searchName.split('.')[0];
      const bareIdentifier = searchName.split('.').pop()!;

      if (calleeText !== bareIdentifier) return false;

      // Verify the object matches the module alias
      const funcNode = callNode.childForFieldName('function');
      if (funcNode && funcNode.type === 'attribute') {
        const objectNode = funcNode.childForFieldName('object');
        if (objectNode && objectNode.text !== namespaceName) return false;
      }
      return true;
    }

    return calleeText === searchName;
  },

  // ── Tracer: Enum access ──────────────────────────────────────────────────

  supportsEnumTracing: true,

  walkEnumAccess(
    rootNode: any,
    enumName: string,
    memberSet: Set<string>,
    filePath: string,
  ): RawEnumAccess[] {
    const accesses: RawEnumAccess[] = [];
    walkAttribute(rootNode, enumName, memberSet, filePath, accesses);
    return accesses;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Recursive attribute walker for Python enum access
// Status.ACTIVE → attribute node: object=Status, attribute=ACTIVE
// ─────────────────────────────────────────────────────────────────────────────

function walkAttribute(
  node:      any,
  enumName:  string,
  memberSet: Set<string>,
  filePath:  string,
  accesses:  RawEnumAccess[],
): void {
  if (node.type === 'attribute') {
    const objectNode = node.childForFieldName('object');
    const attrNode = node.childForFieldName('attribute');

    if (objectNode && attrNode) {
      if (objectNode.text === enumName && memberSet.has(attrNode.text)) {
        accesses.push({
          filePath,
          lineStart:  node.startPosition.row + 1,
          lineEnd:    node.endPosition.row + 1,
          memberName: attrNode.text,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      walkAttribute(child, enumName, memberSet, filePath, accesses);
    }
  }
}
