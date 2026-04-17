/**
 * src/parsers/translators/typescript.ts
 *
 * THE TYPESCRIPT/JAVASCRIPT TRANSLATOR.
 * A pure function. No side effects. No file system access. No logging.
 * Receives a tree-sitter Tree, returns Map<string, AnySignature>.
 *
 * Covers every TypeScript/JavaScript construct that produces a public API:
 *  - Top-level functions            (function_declaration)
 *  - Class methods                  (method_definition)
 *  - Interface method signatures    (method_signature)
 *  - Exported arrow functions       (lexical_declaration → arrow_function)
 *  - Class constructors             (constructor)
 *  - Getters and setters            (get/set method_definition)
 *  - Interfaces                     (interface_declaration)
 *  - Enums                          (enum_declaration)
 *  - Type aliases                   (type_alias_declaration)
 *
 * Returns Map<string, AnySignature> where the key is the unique symbol name.
 * Key format:
 *   Functions:    'processPayment'
 *   Methods:      'PaymentService#charge'
 *   Constructors: 'PaymentService#constructor'
 *   Statics:      'PaymentService.create'
 *   Interfaces:   'UserInterface'  (prefixed to avoid collision with fn names)
 *   Enums:        'Status'
 *   Type aliases: 'UserId'
 *
 * Overload handling:
 *   Overloads share the same key. Each gets a unique overloadIndex (0,1,2...).
 *   The implementation signature (last match, no body = false) wins for the map.
 *   overloadIndex is preserved so the classifier can detect R15/R16.
 */

import {
  Query,
  type Node as SyntaxNode,
  type Language,
  type Tree,
  type QueryMatch,
} from 'web-tree-sitter';
import {
  AnySignature,
  FunctionSignature,
  InterfaceSignature,
  InterfaceProperty,
  EnumSignature,
  EnumMember,
  TypeAliasSignature,
  Param,
  TypeParameter,
} from '../../core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** Q1: Top-level functions, class methods, interface method signatures */
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

/** Q2: Exported arrow functions assigned to const/let */
const ARROW_QUERY_SRC = `
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function
        parameters: (formal_parameters) @params
        return_type: (type_annotation)? @return
      ) @fn
    )
  ) @decl
`;

/** Q3: Class constructors — required for R24 */
const CTOR_QUERY_SRC = `
  (class_declaration
    name: (type_identifier) @class_name
    body: (class_body
      (method_definition
        name: (property_identifier) @ctor_marker
        (#eq? @ctor_marker "constructor")
        parameters: (formal_parameters) @params
      ) @fn
    )
  )
`;

/** Q4: Interface declarations — required for R25/R26 */
const INTERFACE_QUERY_SRC = `
  (interface_declaration
    name: (type_identifier) @name
    body: (interface_body) @body
  ) @iface
`;

/** Q5: Enum declarations — required for R27 */
const ENUM_QUERY_SRC = `
  (enum_declaration
    name: (identifier) @name
    body: (enum_body) @body
  ) @enum
`;

/** Q6: Type alias declarations */
const TYPE_ALIAS_QUERY_SRC = `
  (type_alias_declaration
    name: (type_identifier) @name
    value: (_) @value
  ) @alias
`;

// ─────────────────────────────────────────────────────────────────────────────
// Query cache — compile once per Language, reuse forever
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compiled query cache keyed by Language instance.
 * Queries are stateless WASM bytecode — safe to share across all parse calls.
 * Compiling from S-expression → WASM bytecode is expensive; this ensures
 * each query string is compiled exactly once per grammar.
 */
interface CompiledQueries {
  fn:    Query;
  arrow: Query;
  ctor:  Query;
  iface: Query;
  enum:  Query;
  alias: Query;
}

let cachedLanguage: Language | null = null;
let cachedQueries: CompiledQueries | null = null;

/**
 * Returns compiled queries for the given language, reusing the cache
 * if the language instance hasn't changed.
 *
 * In production, ASTMapper uses a single Language instance per grammar
 * (see ASTMapper.languages Map), so this compiles exactly once.
 */
function getQueries(language: Language): CompiledQueries {
  if (cachedQueries && cachedLanguage === language) {
    return cachedQueries;
  }

  // Language changed (rare) — delete old queries to free WASM memory
  disposeQueries();

  cachedLanguage = language;
  cachedQueries = {
    fn:    new Query(language, FN_QUERY_SRC),
    arrow: new Query(language, ARROW_QUERY_SRC),
    ctor:  new Query(language, CTOR_QUERY_SRC),
    iface: new Query(language, INTERFACE_QUERY_SRC),
    enum:  new Query(language, ENUM_QUERY_SRC),
    alias: new Query(language, TYPE_ALIAS_QUERY_SRC),
  };

  return cachedQueries;
}

/**
 * Frees WASM memory held by cached queries.
 * Call during graceful shutdown or in test teardown.
 * Safe to call multiple times or when no cache exists.
 */
export function disposeQueries(): void {
  if (cachedQueries) {
    cachedQueries.fn.delete();
    cachedQueries.arrow.delete();
    cachedQueries.ctor.delete();
    cachedQueries.iface.delete();
    cachedQueries.enum.delete();
    cachedQueries.alias.delete();
    cachedQueries = null;
    cachedLanguage = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts all public API signatures from a TypeScript/JavaScript AST.
 * Returns Map<string, AnySignature> keyed by unique symbol name.
 *
 * Called by ASTMapper for both oldSource and newSource trees.
 * ASTMapper injects filePath after this returns.
 */
export function extractTSSignatures(
  tree:     Tree,
  language: Language,
): Map<string, AnySignature> {

  const result = new Map<string, AnySignature>();

  // Track overload counts per function name
  const overloadCounts = new Map<string, number>();

  // Compile-once, reuse-forever query cache
  const q = getQueries(language);

  // ── Functions, methods, arrow functions ────────────────────────────────────

  const allFnMatches = [
    ...q.fn.matches(tree.rootNode),
    ...q.arrow.matches(tree.rootNode),
    ...q.ctor.matches(tree.rootNode),
  ];

  for (const match of allFnMatches) {
    const sig = buildFunctionSignature(match, overloadCounts);
    if (!sig) continue;
    // Last definition wins (implementation over overload stubs)
    // overloadIndex is preserved so classifier sees the full picture
    result.set(sig.name, sig);
  }

  // ── Inject overloadCount into stored signatures ────────────────────────────
  // overloadCounts tracks how many times each function name appeared.
  // For functions with >1 occurrence (overloaded), stamp the final count
  // so the classifier (R15/R16) can detect overload additions/removals.
  for (const [name, count] of overloadCounts) {
    if (count > 1) {
      const sig = result.get(name);
      if (sig && 'params' in sig) {
        (sig as FunctionSignature).overloadCount = count;
      }
    }
  }

  // ── Interfaces ─────────────────────────────────────────────────────────────

  for (const match of q.iface.matches(tree.rootNode)) {
    const sig = buildInterfaceSignature(match);
    if (!sig) continue;
    // Prefix to prevent collision with function named identically
    result.set(`interface:${sig.properties.length >= 0 ? getCapture(match, 'name')?.text : ''}`, sig);
  }

  // ── Enums ──────────────────────────────────────────────────────────────────

  for (const match of q.enum.matches(tree.rootNode)) {
    const sig = buildEnumSignature(match);
    if (!sig) continue;
    result.set(`enum:${getCapture(match, 'name')?.text}`, sig);
  }

  // ── Type aliases ───────────────────────────────────────────────────────────

  for (const match of q.alias.matches(tree.rootNode)) {
    const sig = buildTypeAliasSignature(match);
    if (!sig) continue;
    result.set(`type:${getCapture(match, 'name')?.text}`, sig);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Function signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildFunctionSignature(
  match:          QueryMatch,
  overloadCounts: Map<string, number>,
): FunctionSignature | null {

  const nameNode   = getCapture(match, 'name');
  const paramsNode = getCapture(match, 'params');
  const returnNode = getCapture(match, 'return');
  const fnNode     = getCapture(match, 'fn');
  const classNode  = getCapture(match, 'class_name');
  const ctorMarker = getCapture(match, 'ctor_marker');

  if (!nameNode || !paramsNode || !fnNode) return null;

  // Skip nodes with parse errors — unreliable data
  if (fnNode.hasError) return null;

  const rawName    = nameNode.text;
  const isCtorNode = ctorMarker !== null;
  const isStatic   = hasModifier(fnNode, 'static');

  // Build the unique map key
  // Format: 'ClassName#constructor' | 'ClassName.staticMethod' | 'ClassName#method' | 'functionName'
  let key: string;
  if (isCtorNode && classNode) {
    key = `${classNode.text}#constructor`;
  } else if (classNode) {
    key = isStatic
      ? `${classNode.text}.${rawName}`
      : `${classNode.text}#${rawName}`;
  } else {
    key = rawName;
  }

  // Overload tracking — each overload of the same function gets a unique index
  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  // returnType sentinel: 'inferred' when no annotation present.
  // NEVER default to 'any' — 'any' is a real TypeScript type.
  // 'inferred' signals the classifier to skip R6/R7 for this function.
  const returnType: string = returnNode
    ? returnNode.text.replace(/^:\s*/, '').trim()
    : 'inferred';

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1, // 1-indexed
    // filePath: injected by ASTMapper after this returns

    params:          extractParams(paramsNode),
    returnType,
    typeParameters:  extractTypeParameters(fnNode),

    exported:        isExported(fnNode),
    isDefaultExport: isDefaultExport(fnNode),
    async:           hasModifier(fnNode, 'async'),
    isStatic:        isStatic || undefined,
    isAbstract:      hasModifier(fnNode, 'abstract') || undefined,
    isGenerator:     isGeneratorFn(fnNode) || undefined,
    isConstructor:   isCtorNode || undefined,
    isGetter:        isAccessor(fnNode, 'get') || undefined,
    isSetter:        isAccessor(fnNode, 'set') || undefined,

    className:       classNode?.text,
    accessModifier:  getAccessModifier(fnNode),

    decorators:      extractDecorators(fnNode),
    overloadIndex:   currentCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildInterfaceSignature(
  match: QueryMatch,
): InterfaceSignature | null {

  const ifaceNode = getCapture(match, 'iface');
  const bodyNode  = getCapture(match, 'body');

  if (!ifaceNode || !bodyNode) return null;

  return {
    line:            ifaceNode.startPosition.row + 1,
    properties:      extractInterfaceProperties(bodyNode),
    exported:        isExported(ifaceNode),
    isDefaultExport: isDefaultExport(ifaceNode),
    typeParameters:  extractTypeParameters(ifaceNode),
    extends:         extractExtends(ifaceNode),
  };
}

function extractInterfaceProperties(bodyNode: SyntaxNode): InterfaceProperty[] {
  const props: InterfaceProperty[] = [];

  for (const child of bodyNode.namedChildren) {
    // property_signature: name?: Type
    // method_signature: name(params): Return — tracked separately via FN_QUERY
    if (child.type !== 'property_signature') continue;

    const nameNode = child.childForFieldName('name');
    const typeNode = child.childForFieldName('type');
    if (!nameNode) continue;

    const isReadonly = child.children.some(c => c.type === 'readonly');
    const isOptional = child.text.includes('?');

    props.push({
      name:     nameNode.text,
      type:     typeNode ? typeNode.text.replace(/^:\s*/, '').trim() : 'any',
      optional: isOptional,
      readonly: isReadonly || undefined,
    });
  }

  return props;
}

function extractExtends(ifaceNode: SyntaxNode): string[] | undefined {
  const extendsClause = ifaceNode.children.find(
    c => c.type === 'extends_type_clause' || c.type === 'heritage_clause'
  );
  if (!extendsClause) return undefined;

  const parents: string[] = [];
  for (const child of extendsClause.namedChildren) {
    if (child.type === 'type_identifier' || child.type === 'generic_type') {
      parents.push(child.text);
    }
  }
  return parents.length > 0 ? parents : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enum signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildEnumSignature(
  match: QueryMatch,
): EnumSignature | null {

  const enumNode = getCapture(match, 'enum');
  const bodyNode = getCapture(match, 'body');

  if (!enumNode || !bodyNode) return null;

  const members: EnumMember[] = [];

  for (const child of bodyNode.namedChildren) {
    if (child.type !== 'enum_assignment' && child.type !== 'property_identifier') {
      continue;
    }

    if (child.type === 'property_identifier') {
      // Auto-incremented member: Active
      members.push({ name: child.text });
    } else {
      // Explicit value: Active = 1 | Active = 'active'
      const nameNode  = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (nameNode) {
        members.push({
          name:  nameNode.text,
          value: valueNode?.text,
        });
      }
    }
  }

  return {
    line:            enumNode.startPosition.row + 1,
    members,
    exported:        isExported(enumNode),
    isDefaultExport: isDefaultExport(enumNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type alias signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildTypeAliasSignature(
  match: QueryMatch,
): TypeAliasSignature | null {

  const aliasNode = getCapture(match, 'alias');
  const valueNode = getCapture(match, 'value');

  if (!aliasNode || !valueNode) return null;

  return {
    line:            aliasNode.startPosition.row + 1,
    value:           valueNode.text,
    exported:        isExported(aliasNode),
    isDefaultExport: isDefaultExport(aliasNode),
    typeParameters:  extractTypeParameters(aliasNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter extractor — the most complex part
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts Param[] from a formal_parameters node.
 * Handles every TypeScript parameter variant:
 *   - required_parameter:   x: string
 *   - optional_parameter:   x?: string  |  x = 'default'
 *   - rest_parameter:       ...args: string[]
 *   - object_pattern:       { id, name }: User
 *   - array_pattern:        [a, b]: string[]
 *   - constructor shorthand: private/public/readonly name: Type
 */
function extractParams(paramsNode: SyntaxNode): Param[] {
  const params: Param[] = [];

  for (const child of paramsNode.namedChildren) {

    // Skip punctuation tree-sitter includes as named children
    if (child.type === ',' || child.type === '(' || child.type === ')') {
      continue;
    }

    switch (child.type) {

      // ── Required parameter: x: string  |  x: number = 3 ──────────────────────
      // NOTE: tree-sitter classifies `x: Type = value` as required_parameter
      // (not optional_parameter) when there's no `?`. The `value` field holds
      // the default assignment if present.
      case 'required_parameter': {
        const nameNode  = child.childForFieldName('pattern');
        const typeNode  = child.childForFieldName('type');
        const valueNode = child.childForFieldName('value');
        const isRest = nameNode?.type === 'rest_pattern' || (nameNode?.text || '').startsWith('...');
        
        params.push({
          name:         isRest && nameNode ? '...' + sanitizeName(nameNode).replace(/^\.\.\./, '') : sanitizeName(nameNode),
          type:         extractType(typeNode),
          optional:     valueNode !== null,  // has default → effectively optional
          hasDefault:   valueNode !== null,
          defaultValue: valueNode?.text,
          isRest,
        });
        break;
      }

      // ── Optional parameter: x?: string  |  x = 'val'  |  x?: string = 'v' ─
      case 'optional_parameter': {
        const nameNode  = child.childForFieldName('pattern');
        const typeNode  = child.childForFieldName('type');
        const valueNode = child.childForFieldName('value');
        params.push({
          name:         sanitizeName(nameNode),
          type:         extractType(typeNode),
          optional:     true,
          hasDefault:   valueNode !== null,
          defaultValue: valueNode?.text,
          isRest:       false,
        });
        break;
      }

      // ── Rest parameter: ...args: string[] (fallback for older TS grammars) ─
      case 'rest_parameter': {
        const nameNode = child.childForFieldName('pattern') || child;
        const typeNode = child.childForFieldName('type');
        params.push({
          name:       '...' + sanitizeName(nameNode).replace(/^\.\.\./, ''),
          type:       extractType(typeNode),
          optional:   true,  // rest params are always optional
          hasDefault: false,
          isRest:     true,
        });
        break;
      }

      // ── Destructured object: { id, name }: User ─────────────────────────────
      case 'object_pattern': {
        const typeAnnotation = findSiblingTypeAnnotation(child);
        const valueNode      = findSiblingDefaultValue(child);
        params.push({
          name:         '{...}',
          type:         typeAnnotation ?? 'object',
          optional:     valueNode !== null,
          hasDefault:   valueNode !== null,
          defaultValue: valueNode?.text,
          isRest:       false,
        });
        break;
      }

      // ── Destructured array: [a, b]: string[] ────────────────────────────────
      case 'array_pattern': {
        const typeAnnotation = findSiblingTypeAnnotation(child);
        const valueNode      = findSiblingDefaultValue(child);
        params.push({
          name:         '[...]',
          type:         typeAnnotation ?? 'array',
          optional:     valueNode !== null,
          hasDefault:   valueNode !== null,
          defaultValue: valueNode?.text,
          isRest:       false,
        });
        break;
      }

      // ── Constructor parameter shorthand: private/public/readonly name: Type ─
      // These are property declarations disguised as parameters.
      // The readonly/access modifier belongs to the CLASS PROPERTY, not the param.
      // We extract just the param shape — name and type.
      case 'public_field_definition': {
        const inner = child.namedChildren.find(n =>
          n.type === 'required_parameter' || n.type === 'optional_parameter'
        );
        if (inner) {
          const nested = extractParams({
            namedChildren: [inner],
          } as unknown as SyntaxNode);
          params.push(...nested);
        }
        break;
      }

      // ── Accessibility modifier wrapping a param: private name: string ───────
      // tree-sitter represents constructor(private name: string) as:
      // accessibility_modifier → required_parameter
      default: {
        if (child.type.includes('accessibility') || child.type.includes('modifier')) {
          const inner = child.namedChildren.find(n =>
            n.type === 'required_parameter' || n.type === 'optional_parameter'
          );
          if (inner) {
            const nested = extractParams({
              namedChildren: [inner],
            } as unknown as SyntaxNode);
            params.push(...nested);
            break;
          }
        }

        // Unknown node type — extract best-effort, never crash
        // Covers future TypeScript syntax not yet mapped
        const typeNode = child.children.find(n => n.type === 'type_annotation');
        const rawText  = child.text;

        params.push({
          name:       sanitizeRawText(rawText),
          type:       typeNode
                        ? typeNode.text.replace(/^:\s*/, '').trim()
                        : 'unknown',
          optional:   rawText.includes('?'),
          hasDefault: rawText.includes('='),
          isRest:     rawText.startsWith('...'),
        });
      }
    }
  }

  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modifier detectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a function node is exported.
 * Handles: export function foo() | class method in exported class | export default
 */
function isExported(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // export function foo() {} | export class Foo {} | export interface Foo {}
  if (parent.type === 'export_statement') return true;

  // export { foo } — harder to detect at parse time, covered by export_statement
  // Class method — check if the parent class is exported
  if (parent.type === 'class_body') {
    const classDecl   = parent.parent;
    const classParent = classDecl?.parent;
    return classParent?.type === 'export_statement';
  }

  return false;
}

function isDefaultExport(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type !== 'export_statement') return false;
  // export default function foo() {}
  return parent.children.some(c => c.type === 'default');
}

/**
 * Checks for a keyword modifier as a direct child of the function node.
 * Used for: async, static, abstract, readonly
 */
function hasModifier(node: SyntaxNode, keyword: string): boolean {
  return node.children.some(c => c.type === keyword);
}

function isGeneratorFn(node: SyntaxNode): boolean {
  // Generator functions have a '*' token as a direct child
  return node.children.some(c => c.type === '*');
}

function isAccessor(node: SyntaxNode, kind: 'get' | 'set'): boolean {
  // Getter/setter: the 'get' or 'set' keyword appears before the method name
  return node.children.some(c => c.type === kind);
}

function getAccessModifier(
  node: SyntaxNode
): 'public' | 'protected' | 'private' | undefined {
  for (const child of node.children) {
    if (child.type === 'public')    return 'public';
    if (child.type === 'protected') return 'protected';
    if (child.type === 'private')   return 'private';
    // Handle accessibility_modifier wrapper node
    if (child.type === 'accessibility_modifier') {
      const inner = child.firstChild?.type;
      if (inner === 'public')    return 'public';
      if (inner === 'protected') return 'protected';
      if (inner === 'private')   return 'private';
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic / decorator / type parameter extractors
// ─────────────────────────────────────────────────────────────────────────────

function extractTypeParameters(node: SyntaxNode): TypeParameter[] | undefined {
  const typeParams = node.children.find(
    c => c.type === 'type_parameters'
  );
  if (!typeParams) return undefined;

  const params: TypeParameter[] = [];
  for (const child of typeParams.namedChildren) {
    if (child.type === 'type_parameter') {
      const nameNode = child.childForFieldName('name') || child;
      const constraintNode = child.childForFieldName('constraint');
      params.push({
        name: nameNode.text,
        constraint: constraintNode ? constraintNode.text : undefined,
      });
    }
  }
  return params.length > 0 ? params : undefined;
}

function extractDecorators(node: SyntaxNode): string[] | undefined {
  const decorators: string[] = [];

  // Walk upward — decorators appear as siblings before the function declaration
  let current = node.parent;
  if (!current) return undefined;

  for (const sibling of current.children) {
    if (sibling === node) break;
    if (sibling.type === 'decorator') {
      // Extract name: @Injectable() → 'Injectable'
      const nameNode = sibling.children.find(
        c => c.type === 'identifier' || c.type === 'call_expression'
      );
      if (nameNode) {
        // Strip call args: Injectable() → Injectable
        decorators.push(nameNode.text.replace(/\(.*\)$/, '').trim());
      }
    }
  }

  return decorators.length > 0 ? decorators : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractType(typeNode: SyntaxNode | null | undefined): string {
  if (!typeNode) return 'any';
  // type_annotation node includes the leading colon — strip it
  return typeNode.text.replace(/^:\s*/, '').trim();
}

/**
 * For destructured params, the type annotation is a SIBLING of the pattern node,
 * not a child. Walks the parent's children to find it.
 *
 * function foo({ id }: User)    → parent is formal_parameters
 *   child[0] = object_pattern  → {id}
 *   child[1] = type_annotation → : User   ← what we want
 */
function findSiblingTypeAnnotation(
  patternNode: SyntaxNode
): string | null {
  const parent = patternNode.parent;
  if (!parent) return null;

  const siblings = parent.children;
  const idx = siblings.indexOf(patternNode);

  for (let i = idx + 1; i < siblings.length; i++) {
    if (siblings[i].type === 'type_annotation') {
      return siblings[i].text.replace(/^:\s*/, '').trim();
    }
  }
  return null;
}

/**
 * Finds a default value node that is a sibling of a destructured pattern.
 * function foo({ id } = {})  → the '= {}' is a sibling
 */
function findSiblingDefaultValue(
  patternNode: SyntaxNode
): SyntaxNode | null {
  const parent = patternNode.parent;
  if (!parent) return null;

  const siblings = parent.children;
  const idx = siblings.indexOf(patternNode);

  // Look for '=' followed by a value
  for (let i = idx + 1; i < siblings.length; i++) {
    if (siblings[i].type === '=') {
      return siblings[i + 1] ?? null;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name sanitisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts a clean parameter name from a tree-sitter name node.
 * Handles constructor shorthand modifiers: private/public/readonly/protected
 *
 * NOTE: These modifiers appear in the name node text in some grammar versions.
 * We strip them because they are property declaration modifiers, not param names.
 */
function sanitizeName(nameNode: SyntaxNode | null | undefined): string {
  if (!nameNode) return '?';
  return nameNode.text
    .replace(/^(private|public|protected|readonly)\s+/, '')
    .replace('?', '')
    .trim() || '?';
}

/**
 * Fallback name extractor when only raw text is available (default case).
 * More aggressive sanitisation.
 */
function sanitizeRawText(rawText: string): string {
  if (rawText.startsWith('{')) return '{...}';
  if (rawText.startsWith('[')) return '[...]';
  return rawText
    .replace(/^(private|public|protected|readonly)\s+/, '')
    .split(':')[0]
    .split('=')[0]
    .replace('?', '')
    .replace(/^\.\.\./, '')
    .trim() || '?';
}

// ─────────────────────────────────────────────────────────────────────────────
// Query capture helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts a named capture from a query match.
 * Returns null if the capture is not present (optional captures use ? in query).
 */
function getCapture(
  match: QueryMatch,
  name:  string,
): SyntaxNode | null {
  return match.captures.find(c => c.name === name)?.node ?? null;
}