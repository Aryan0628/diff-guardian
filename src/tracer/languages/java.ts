/**
 * src/tracer/languages/java.ts
 *
 * JAVA LANGUAGE STRATEGY.
 *
 * Handles Java's import model:
 *   - Type import:   import com.example.Status;
 *   - Static import: import static com.example.Status.ACTIVE;
 *   - Wildcard:      import com.example.*;
 *
 * Gotcha 2 fix:
 *   Java static imports cause the member to appear as a bare identifier
 *   (NOT Status.ACTIVE). When importType === 'static_import', the tracer
 *   must search for bare identifier matches, not just field_access.
 *   verifyCallTarget() always returns true for bare identifiers since
 *   the import was already validated in Phase 2.
 *
 * No barrel concept — Java packages are flat.
 *
 * Enum access:
 *   Status.ACTIVE → field_access node with object=Status, field=ACTIVE
 *   (or bare ACTIVE when statically imported)
 *
 * @module JavaStrategy
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
 * Q1: Standard method invocation — service.process(x, y)
 * Also catches static method calls: Status.valueOf("ACTIVE")
 */
const METHOD_INVOCATION_QUERY = `
  (method_invocation
    name: (identifier) @callee
    arguments: (argument_list) @args
  ) @call
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE JAVA STRATEGY
// ─────────────────────────────────────────────────────────────────────────────

export const javaStrategy: LanguageStrategy = {
  id: 'java',
  extensions: ['.java'],
  grammarFile: 'tree-sitter-java.wasm',
  grepGlobs: ['*.java'],

  // ── Scanner: Import patterns ─────────────────────────────────────────────

  buildImportPatterns(symbolName: string): ImportPattern[] {
    const escaped = escapeRegex(symbolName);

    return [
      // ── Type import: import com.example.Status; ───────────────────────
      {
        regex: new RegExp(
          `import\\s+[\\w.]+\\.${escaped}\\s*;`,
          'gm'
        ),
        type: 'java_import' as any,
        extractAlias: (_match, sym) => sym,
      },

      // ── Static import: import static com.example.Status.ACTIVE; ──────
      // Gotcha 2: bare identifier in usage
      {
        regex: new RegExp(
          `import\\s+static\\s+[\\w.]+\\.${escaped}\\s*;`,
          'gm'
        ),
        type: 'static_import' as any,
        extractAlias: (_match, sym) => sym,
      },

      // ── Wildcard import: import com.example.*; ────────────────────────
      {
        regex: new RegExp(
          `import\\s+[\\w.]+\\.\\*\\s*;`,
          'gm'
        ),
        type: 'wildcard' as any,
        extractAlias: (_match, sym) => sym,
      },
    ];
  },

  // ── Scanner: Barrel patterns (none for Java) ─────────────────────────────

  buildBarrelPatterns(_symbolName: string): ImportPattern[] {
    return []; // Java has no barrel/re-export concept
  },

  isBarrelFile(_filePath: string): boolean {
    return false; // No barrels in Java
  },

  buildBarrelSearchTerm(_barrelPath: string): string {
    return '';
  },

  // ── Tracer: Call expression queries ──────────────────────────────────────

  callExpressionQueries: [METHOD_INVOCATION_QUERY],

  // ── Tracer: Argument counting ────────────────────────────────────────────

  countArguments(argsNode: any): { count: number; hasSpread: boolean } {
    let count = 0;
    let hasSpread = false;

    for (const child of argsNode.namedChildren) {
      count++;
      // Java doesn't have spread syntax in calls, but varargs
      // are passed as normal arguments — no special detection needed
    }

    return { count, hasSpread };
  },

  // ── Tracer: Call target verification ─────────────────────────────────────

  verifyCallTarget(
    _callNode: any,
    _searchName: string,
    _calleeText: string,
  ): boolean {
    // Java method invocations capture the method name directly.
    // The scanner already verified the import exists in Phase 2.
    // No namespace verification needed — Java's type system handles it.
    return true;
  },

  // ── Tracer: Enum access (Gotcha 2 aware) ─────────────────────────────────

  supportsEnumTracing: true,

  walkEnumAccess(
    rootNode: any,
    enumName: string,
    memberSet: Set<string>,
    filePath: string,
  ): RawEnumAccess[] {
    const accesses: RawEnumAccess[] = [];
    walkFieldAccess(rootNode, enumName, memberSet, filePath, accesses);
    return accesses;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Recursive field_access walker for Java enum access
// Status.ACTIVE → field_access: object=Status, field=ACTIVE
//
// Note: For static imports (bare ACTIVE), the scanner detected importType
// === 'static_import'. The pipeline should handle this at the orchestration
// level — this walker only handles the standard Status.ACTIVE pattern.
// The traceEnum() pipeline produces a separate bare-identifier scan when needed.
// ─────────────────────────────────────────────────────────────────────────────

function walkFieldAccess(
  node:      any,
  enumName:  string,
  memberSet: Set<string>,
  filePath:  string,
  accesses:  RawEnumAccess[],
): void {
  if (node.type === 'field_access') {
    const objectNode = node.childForFieldName('object');
    const fieldNode = node.childForFieldName('field');

    if (objectNode && fieldNode) {
      if (objectNode.text === enumName && memberSet.has(fieldNode.text)) {
        accesses.push({
          filePath,
          lineStart:  node.startPosition.row + 1,
          lineEnd:    node.endPosition.row + 1,
          memberName: fieldNode.text,
        });
      }
    }
  }

  // Also detect bare identifiers that match broken enum members
  // (from static imports: import static Status.ACTIVE → bare ACTIVE)
  if (node.type === 'identifier' && memberSet.has(node.text)) {
    // Don't match if this identifier is the object of a field_access
    // (that would be caught by the field_access case above)
    const parent = node.parent;
    if (parent && parent.type === 'field_access') {
      const objectOfParent = parent.childForFieldName('object');
      if (objectOfParent === node) {
        // This is the object side (Status in Status.ACTIVE) — skip
      } else {
        // This is the field side — skip too, handled by field_access
      }
    } else {
      // Bare identifier usage — statically imported enum member
      accesses.push({
        filePath,
        lineStart:  node.startPosition.row + 1,
        lineEnd:    node.endPosition.row + 1,
        memberName: node.text,
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      walkFieldAccess(child, enumName, memberSet, filePath, accesses);
    }
  }
}
