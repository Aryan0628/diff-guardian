/**
 * src/parsers/translators/java.ts
 *
 * THE JAVA TRANSLATOR.
 * A pure function. No side effects. No file system access. No logging.
 * Receives a tree-sitter Tree, returns Map<string, AnySignature>.
 *
 * Covers every Java construct that produces a public API:
 *  - Methods                       (method_declaration)
 *  - Constructors                  (constructor_declaration)
 *  - Interfaces                    (interface_declaration)
 *  - Enums                         (enum_declaration)
 *  - Classes                       (class_declaration, for context)
 *  - Annotations                   (annotation / marker_annotation → decorators)
 *  - Modifiers                     (public/private/protected/static/abstract/final/synchronized)
 *
 * Returns Map<string, AnySignature> where the key is the unique symbol name.
 * Key format:
 *   Methods:      'PaymentService#charge'
 *   Constructors: 'PaymentService#constructor'
 *   Statics:      'PaymentService.create'
 *   Interfaces:   'interface:Payable'
 *   Enums:        'enum:Status'
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
  Param,
  TypeParameter,
} from '../../core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** Q1: Method declarations */
const METHOD_QUERY_SRC = `
  (method_declaration
    type: (_) @return_type
    name: (identifier) @name
    parameters: (formal_parameters) @params
  ) @fn
`;

/** Q2: Constructor declarations */
const CTOR_QUERY_SRC = `
  (constructor_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
  ) @fn
`;

/** Q3: Interface declarations */
const INTERFACE_QUERY_SRC = `
  (interface_declaration
    name: (identifier) @name
    body: (interface_body) @body
  ) @iface
`;

/** Q4: Enum declarations */
const ENUM_QUERY_SRC = `
  (enum_declaration
    name: (identifier) @name
    body: (enum_body) @body
  ) @enum
`;

/** Q5: Class declarations — for context (class name, modifiers) */
const CLASS_QUERY_SRC = `
  (class_declaration
    name: (identifier) @name
    body: (class_body) @body
  ) @class
`;

// ─────────────────────────────────────────────────────────────────────────────
// Query cache — compile once per Language, reuse forever
// ─────────────────────────────────────────────────────────────────────────────

interface CompiledQueries {
  method: Query;
  ctor:   Query;
  iface:  Query;
  enum:   Query;
  cls:    Query;
}

let cachedLanguage: Language | null = null;
let cachedQueries: CompiledQueries | null = null;

function getQueries(language: Language): CompiledQueries {
  if (cachedQueries && cachedLanguage === language) {
    return cachedQueries;
  }

  disposeQueries();

  cachedLanguage = language;
  cachedQueries = {
    method: new Query(language, METHOD_QUERY_SRC),
    ctor:   new Query(language, CTOR_QUERY_SRC),
    iface:  new Query(language, INTERFACE_QUERY_SRC),
    enum:   new Query(language, ENUM_QUERY_SRC),
    cls:    new Query(language, CLASS_QUERY_SRC),
  };

  return cachedQueries;
}

/**
 * Frees WASM memory held by cached queries.
 * Call during graceful shutdown or in test teardown.
 */
export function disposeQueries(): void {
  if (cachedQueries) {
    cachedQueries.method.delete();
    cachedQueries.ctor.delete();
    cachedQueries.iface.delete();
    cachedQueries.enum.delete();
    cachedQueries.cls.delete();
    cachedQueries = null;
    cachedLanguage = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts all public API signatures from a Java AST.
 * Returns Map<string, AnySignature> keyed by unique symbol name.
 */
export function extractJavaSignatures(
  tree:     Tree,
  language: Language,
): Map<string, AnySignature> {

  const result = new Map<string, AnySignature>();
  const overloadCounts = new Map<string, number>();
  const q = getQueries(language);

  // ── Methods ─────────────────────────────────────────────────────────────────

  for (const match of q.method.matches(tree.rootNode)) {
    const sig = buildMethodSignature(match, overloadCounts);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Constructors ────────────────────────────────────────────────────────────

  for (const match of q.ctor.matches(tree.rootNode)) {
    const sig = buildConstructorSignature(match, overloadCounts);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Inject overloadCount into stored signatures ────────────────────────────
  // Java supports real method overloading (e.g., void foo(int) and void foo(String)).
  // overloadCounts tracks how many times each method key appeared.
  // For methods with >1 occurrence (overloaded), stamp the final count
  // so the classifier (R15/R16) can detect overload additions/removals.
  for (const [name, count] of overloadCounts) {
    if (count > 1) {
      const sig = result.get(name);
      if (sig && 'params' in sig) {
        (sig as FunctionSignature).overloadCount = count;
      }
    }
  }

  // ── Interfaces ──────────────────────────────────────────────────────────────

  for (const match of q.iface.matches(tree.rootNode)) {
    const sig = buildInterfaceSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`interface:${name}`, sig);
  }

  // ── Enums ───────────────────────────────────────────────────────────────────

  for (const match of q.enum.matches(tree.rootNode)) {
    const sig = buildEnumSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`enum:${name}`, sig);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Method signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildMethodSignature(
  match:          QueryMatch,
  overloadCounts: Map<string, number>,
): FunctionSignature | null {

  const nameNode       = getCapture(match, 'name');
  const paramsNode     = getCapture(match, 'params');
  const returnTypeNode = getCapture(match, 'return_type');
  const fnNode         = getCapture(match, 'fn');

  if (!nameNode || !paramsNode || !fnNode) return null;
  if (fnNode.hasError) return null;

  const rawName   = nameNode.text;
  const className = getEnclosingClassName(fnNode);
  const modifiers = getModifiers(fnNode);
  const isStatic  = modifiers.has('static');

  // Build map key
  let key: string;
  if (className) {
    key = isStatic
      ? `${className}.${rawName}`
      : `${className}#${rawName}`;
  } else {
    key = rawName;
  }

  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  const returnType = returnTypeNode
    ? returnTypeNode.text.trim()
    : 'inferred';

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params:          extractParams(paramsNode),
    returnType,
    typeParameters:  extractTypeParameters(fnNode),

    exported:        modifiers.has('public'),
    isDefaultExport: false,
    async:           false, // Java has no language-level async/await
    isStatic:        isStatic || undefined,
    isAbstract:      modifiers.has('abstract') || undefined,
    isGenerator:     undefined,
    isConstructor:   undefined,
    isGetter:        undefined,
    isSetter:        undefined,

    className,
    accessModifier:  getAccessModifier(modifiers),

    decorators:      extractAnnotations(fnNode),
    overloadIndex:   currentCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildConstructorSignature(
  match:          QueryMatch,
  overloadCounts: Map<string, number>,
): FunctionSignature | null {

  const nameNode   = getCapture(match, 'name');
  const paramsNode = getCapture(match, 'params');
  const fnNode     = getCapture(match, 'fn');

  if (!nameNode || !paramsNode || !fnNode) return null;
  if (fnNode.hasError) return null;

  const className = nameNode.text; // Constructor name = class name in Java
  const key       = `${className}#constructor`;
  const modifiers = getModifiers(fnNode);

  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params:          extractParams(paramsNode),
    returnType:      className,  // Constructor returns its own type
    typeParameters:  extractTypeParameters(fnNode),

    exported:        modifiers.has('public'),
    isDefaultExport: false,
    async:           false,
    isStatic:        undefined,
    isAbstract:      undefined,
    isGenerator:     undefined,
    isConstructor:   true,
    isGetter:        undefined,
    isSetter:        undefined,

    className,
    accessModifier:  getAccessModifier(modifiers),

    decorators:      extractAnnotations(fnNode),
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
  const nameNode  = getCapture(match, 'name');
  const bodyNode  = getCapture(match, 'body');

  if (!ifaceNode || !nameNode || !bodyNode) return null;

  const modifiers = getModifiers(ifaceNode);

  return {
    line:            ifaceNode.startPosition.row + 1,
    properties:      extractInterfaceMethods(bodyNode),
    exported:        modifiers.has('public'),
    isDefaultExport: false,
    typeParameters:  extractTypeParameters(ifaceNode),
    extends:         extractExtendsInterfaces(ifaceNode),
  };
}

/**
 * Extracts method signatures from an interface body as InterfaceProperty[].
 * Java interface methods are abstract by default.
 */
function extractInterfaceMethods(bodyNode: SyntaxNode): InterfaceProperty[] {
  const props: InterfaceProperty[] = [];

  for (const child of bodyNode.namedChildren) {
    if (child.type === 'method_declaration') {
      const nameNode = child.childForFieldName('name');
      const typeNode = child.childForFieldName('type');
      const paramsNode = child.childForFieldName('parameters');

      if (nameNode) {
        const returnType = typeNode?.text ?? 'void';
        const paramsSig  = paramsNode?.text ?? '()';
        props.push({
          name:     nameNode.text,
          type:     `${returnType} ${paramsSig}`,
          optional: false,
          readonly: undefined,
        });
      }
    }

    // Constant declarations in interfaces
    if (child.type === 'constant_declaration') {
      const decls = child.namedChildren.filter(n => n.type === 'variable_declarator');
      for (const decl of decls) {
        const nameNode = decl.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        if (nameNode) {
          props.push({
            name:     nameNode.text,
            type:     typeNode?.text ?? 'Object',
            optional: false,
            readonly: true, // interface constants are implicitly final
          });
        }
      }
    }
  }

  return props;
}

function extractExtendsInterfaces(ifaceNode: SyntaxNode): string[] | undefined {
  const extendsNode = ifaceNode.children.find(
    c => c.type === 'extends_interfaces'
  );
  if (!extendsNode) return undefined;

  const parents: string[] = [];
  for (const child of extendsNode.namedChildren) {
    if (child.type === 'type_identifier' || child.type === 'generic_type') {
      parents.push(child.text);
    }
    // type_list in some grammar versions
    if (child.type === 'type_list') {
      for (const t of child.namedChildren) {
        parents.push(t.text);
      }
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
  const modifiers = getModifiers(enumNode);

  for (const child of bodyNode.namedChildren) {
    if (child.type === 'enum_constant') {
      const nameNode = child.childForFieldName('name');
      const argsNode = child.childForFieldName('arguments');
      if (nameNode) {
        members.push({
          name:  nameNode.text,
          value: argsNode?.text,
        });
      }
    }
  }

  return {
    line:            enumNode.startPosition.row + 1,
    members,
    exported:        modifiers.has('public'),
    isDefaultExport: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter extractor
// ─────────────────────────────────────────────────────────────────────────────

function extractParams(paramsNode: SyntaxNode): Param[] {
  const params: Param[] = [];

  for (const child of paramsNode.namedChildren) {

    switch (child.type) {

      // ── formal_parameter: String name ───────────────────────────────────────
      case 'formal_parameter': {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        const dims     = child.childForFieldName('dimensions');
        const typeText = typeNode
          ? typeNode.text + (dims ? dims.text : '')
          : 'Object';

        params.push({
          name:       nameNode?.text ?? '?',
          type:       typeText,
          optional:   false,
          hasDefault: false,
          isRest:     false,
        });
        break;
      }

      // ── spread_parameter: String... args (varargs) ──────────────────────────
      case 'spread_parameter': {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        params.push({
          name:       `...${nameNode?.text ?? 'args'}`,
          type:       typeNode?.text ?? 'Object',
          optional:   true,
          hasDefault: false,
          isRest:     true,
        });
        break;
      }

      // ── receiver_parameter: this in inner class constructors ────────────────
      case 'receiver_parameter': {
        // Skip 'this' receiver — not a real user-facing parameter
        break;
      }

      // ── Unknown — best-effort extraction ────────────────────────────────────
      default: {
        params.push({
          name:       child.text.split(/\s+/).pop() ?? '?',
          type:       child.text.split(/\s+/).slice(0, -1).join(' ') || 'unknown',
          optional:   false,
          hasDefault: false,
          isRest:     child.text.includes('...'),
        });
      }
    }
  }

  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modifier & annotation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts modifiers from a Java declaration.
 * The 'modifiers' node contains public, private, protected, static,
 * abstract, final, synchronized, etc.
 */
function getModifiers(node: SyntaxNode): Set<string> {
  const mods = new Set<string>();

  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.namedChildren) {
        if (mod.type !== 'annotation' && mod.type !== 'marker_annotation') {
          mods.add(mod.text);
        }
      }
      // Also check anonymous children for keywords
      for (const mod of child.children) {
        if (!mod.isNamed && mod.text.match(/^(public|private|protected|static|abstract|final|synchronized|native|strictfp|default|transient|volatile)$/)) {
          mods.add(mod.text);
        }
      }
    }
  }

  return mods;
}

function getAccessModifier(
  modifiers: Set<string>,
): 'public' | 'protected' | 'private' | undefined {
  if (modifiers.has('public'))    return 'public';
  if (modifiers.has('protected')) return 'protected';
  if (modifiers.has('private'))   return 'private';
  return undefined; // package-private (Java default)
}

/**
 * Extracts annotations from a Java declaration as decorator equivalents.
 * @Override → 'Override'
 * @Service("name") → 'Service'
 */
function extractAnnotations(node: SyntaxNode): string[] | undefined {
  const annotations: string[] = [];

  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.namedChildren) {
        if (mod.type === 'annotation' || mod.type === 'marker_annotation') {
          const nameNode = mod.childForFieldName('name') ?? mod.namedChildren[0];
          if (nameNode) {
            annotations.push(nameNode.text);
          }
        }
      }
    }
  }

  return annotations.length > 0 ? annotations : undefined;
}

function extractTypeParameters(node: SyntaxNode): TypeParameter[] | undefined {
  const typeParams = node.children.find(
    c => c.type === 'type_parameters'
  );
  if (!typeParams) return undefined;

  const params: TypeParameter[] = [];
  for (const child of typeParams.namedChildren) {
    if (child.type === 'type_parameter') {
      params.push({ name: child.text });
    }
  }
  return params.length > 0 ? params : undefined;
}

function getEnclosingClassName(fnNode: SyntaxNode): string | undefined {
  let current = fnNode.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'enum_declaration') {
      return current.childForFieldName('name')?.text;
    }
    if (current.type === 'class_body' || current.type === 'enum_body') {
      current = current.parent;
      continue;
    }
    current = current.parent;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query capture helper
// ─────────────────────────────────────────────────────────────────────────────

function getCapture(
  match: QueryMatch,
  name:  string,
): SyntaxNode | null {
  return match.captures.find(c => c.name === name)?.node ?? null;
}
