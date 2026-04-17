/**
 * src/tracer/languages/typescript.ts
 *
 * TYPESCRIPT / JAVASCRIPT LANGUAGE STRATEGY.
 *
 * This is a pure extraction of the existing TS/JS-specific logic from
 * scanner.ts and tracer.ts into the LanguageStrategy interface.
 * Zero behavioral change — the exact same regexes, queries, and walk logic.
 *
 * Covers both TypeScript (.ts, .tsx) and JavaScript (.js, .jsx) because
 * they share the same module system (ES modules + CJS require).
 *
 * Import patterns handled:
 *   - Static:    import { fn } from './mod'
 *   - Aliased:   import { fn as alias } from './mod'
 *   - Wildcard:  import * as mod from './mod'
 *   - Dynamic:   const { fn } = await import('./mod')
 *   - CJS:       const { fn } = require('./mod')
 *
 * Barrel patterns handled:
 *   - Named:     export { fn } from './mod'
 *   - Wildcard:  export * from './mod'
 *
 * @module TypeScriptStrategy
 */

import type { LanguageStrategy, ImportPattern, RawEnumAccess } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Regex utilities
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts the local alias from an import specifier block.
 *
 * Given specifiers = "processPayment as pay, otherFn"
 * and symbolName = "processPayment"
 * Returns "pay"
 *
 * Given specifiers = "processPayment, otherFn"
 * and symbolName = "processPayment"
 * Returns "processPayment" (no alias)
 */
function extractAliasFromSpecifiers(specifiers: string, symbolName: string): string {
  const normalized = specifiers.replace(/\s+/g, ' ').trim();
  const parts = normalized.split(',').map(p => p.trim());

  for (const part of parts) {
    const aliasMatch = part.match(
      new RegExp(`^${escapeRegex(symbolName)}\\s+as\\s+(\\w+)$`)
    );
    if (aliasMatch) {
      return aliasMatch[1];
    }
    if (part === symbolName) {
      return symbolName;
    }
  }

  return symbolName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree-sitter query sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Q1: Direct function calls — processPayment(arg1, arg2)
 * Captures the callee identifier and the arguments list.
 */
const DIRECT_CALL_QUERY = `
  (call_expression
    function: (identifier) @callee
    arguments: (arguments) @args
  ) @call
`;

/**
 * Q2: Method/member calls — obj.processPayment(arg1, arg2)
 * Captures the property name (the method) and the arguments list.
 */
const MEMBER_CALL_QUERY = `
  (call_expression
    function: (member_expression
      property: (property_identifier) @callee
    )
    arguments: (arguments) @args
  ) @call
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE TYPESCRIPT/JAVASCRIPT STRATEGY
// ─────────────────────────────────────────────────────────────────────────────

export const typescriptStrategy: LanguageStrategy = {
  id: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  grammarFile: 'tree-sitter-typescript.wasm',
  grepGlobs: ['*.ts', '*.tsx', '*.js', '*.jsx'],

  // ── Scanner: Import patterns ─────────────────────────────────────────────

  buildImportPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── Static import: import { fn } from './mod' ─────────────────────
      {
        regex: new RegExp(
          `import\\s*\\{([^}]*\\b${escaped}\\b[^}]*)\\}\\s*from\\s*['"]([^'"]+)['"]`,
          'gm'
        ),
        type: 'static' as const,
        extractAlias: (match, sym) => extractAliasFromSpecifiers(match[1], sym),
      },

      // ── Dynamic import: const { fn } = await import('./mod') ─────────
      // Must destructure the symbol name — bare import() is NOT a match
      {
        regex: new RegExp(
          `\\{([^}]*\\b${escaped}\\b[^}]*)\\}\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`,
          'gm'
        ),
        type: 'dynamic' as const,
        extractAlias: (match, sym) => extractAliasFromSpecifiers(match[1], sym),
      },

      // ── CJS require: const { fn } = require('./mod') ──────────────────
      // Must destructure the symbol name — bare require() is NOT a match
      {
        regex: new RegExp(
          `\\{([^}]*\\b${escaped}\\b[^}]*)\\}\\s*=\\s*require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`,
          'gm'
        ),
        type: 'require' as const,
        extractAlias: (match, sym) => extractAliasFromSpecifiers(match[1], sym),
      },

      // ── Wildcard import: import * as mod from './mod' ─────────────────
      // verifyMatch confirms mod.symbolName actually appears in the file
      {
        regex: new RegExp(
          `import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*['"]([^'"]+)['"]`,
          'gm'
        ),
        type: 'wildcard' as const,
        extractAlias: (match, sym) => `${match[1]}.${sym}`,
        verifyMatch: (_match, content, _sym, localName) => content.includes(localName),
      },
    ];
  },

  // ── Scanner: Barrel patterns ─────────────────────────────────────────────

  buildBarrelPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── Named re-export: export { fn } from './mod' ───────────────────
      {
        regex: new RegExp(
          `export\\s*\\{([^}]*\\b${escaped}\\b[^}]*)\\}\\s*from\\s*['"]([^'"]+)['"]`,
          'gm'
        ),
        type: 'static' as const,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },

      // ── Wildcard re-export: export * from './mod' ─────────────────────
      {
        regex: new RegExp(
          `export\\s*\\*\\s*(?:as\\s+\\w+\\s*)?from\\s*['"]([^'"]+)['"]`,
          'gm'
        ),
        type: 'wildcard' as const,
        extractAlias: (_match, sym) => sym,
        isBarrel: true,
      },
    ];
  },

  // ── Scanner: Barrel file detection ───────────────────────────────────────

  isBarrelFile(filePath: string): boolean {
    const base = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
    return base.endsWith('/index') || base.endsWith('\\index');
  },

  buildBarrelSearchTerm(barrelPath: string): string {
    const baseName = barrelPath.replace(/\.(ts|tsx|js|jsx)$/, '');
    const isIndex = baseName.endsWith('/index') || baseName.endsWith('\\index');

    if (isIndex) {
      return baseName.replace(/\/index$|\\index$/, '').split(/[\\/]/).pop() || '';
    }
    return baseName.split(/[\\/]/).pop() || '';
  },

  // ── Tracer: Call expression queries ──────────────────────────────────────

  callExpressionQueries: [DIRECT_CALL_QUERY, MEMBER_CALL_QUERY],

  // ── Tracer: Argument counting ────────────────────────────────────────────

  countArguments(argsNode: any): { count: number; hasSpread: boolean } {
    let count = 0;
    let hasSpread = false;

    for (const child of argsNode.namedChildren) {
      if (child.type === ',' || child.type === '(' || child.type === ')') {
        continue;
      }
      count++;
      if (child.type === 'spread_element') {
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
      // Namespace import: payments.processPayment
      // Verify the object node matches the namespace
      const namespaceName = searchName.split('.')[0];
      const bareIdentifier = searchName.split('.').pop()!;

      if (calleeText !== bareIdentifier) return false;

      const memberExpr = callNode.childForFieldName('function');
      if (memberExpr) {
        const objectNode = memberExpr.childForFieldName('object');
        if (objectNode && objectNode.text !== namespaceName) return false;
      }
      return true;
    }

    // Non-namespace: just check identifier matches
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
    walkMemberExpression(rootNode, enumName, memberSet, filePath, accesses);
    return accesses;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Recursive member_expression walker (extracted from tracer.ts)
// ─────────────────────────────────────────────────────────────────────────────

function walkMemberExpression(
  node: any,
  enumName: string,
  memberSet: Set<string>,
  filePath: string,
  accesses: RawEnumAccess[],
): void {
  if (node.type === 'member_expression') {
    const objectNode = node.childForFieldName('object');
    const propertyNode = node.childForFieldName('property');

    if (objectNode && propertyNode) {
      if (objectNode.text === enumName && memberSet.has(propertyNode.text)) {
        accesses.push({
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          memberName: propertyNode.text,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      walkMemberExpression(child, enumName, memberSet, filePath, accesses);
    }
  }
}
