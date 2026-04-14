/**
 * src/parsers/translators/go.ts
 *
 * THE GO TRANSLATOR.
 * A pure function. No side effects. No file system access. No logging.
 * Receives a tree-sitter Tree, returns Map<string, AnySignature>.
 *
 * Covers every Go construct that produces a public API:
 *  - Top-level functions           (function_declaration)
 *  - Methods with receiver         (method_declaration)
 *  - Interfaces                    (type_spec → interface_type)
 *  - Structs                       (type_spec → struct_type → TypeAliasSignature)
 *  - Type aliases                  (type_spec → simple type)
 *
 * Returns Map<string, AnySignature> where the key is the unique symbol name.
 * Key format:
 *   Functions: 'ProcessPayment'
 *   Methods:   'PaymentService#Charge'
 *   Interfaces:'interface:Reader'
 *   Structs:   'type:PaymentService'
 *   Aliases:   'type:UserID'
 *
 * Go export convention: capitalized name = exported.
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
  TypeAliasSignature,
  Param,
} from '../../core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** Q1: Top-level functions */
const FN_QUERY_SRC = `
  (function_declaration
    name: (identifier) @name
    parameters: (parameter_list) @params
    result: (_)? @result
  ) @fn
`;

/** Q2: Methods with receiver */
const METHOD_QUERY_SRC = `
  (method_declaration
    receiver: (parameter_list) @receiver
    name: (field_identifier) @name
    parameters: (parameter_list) @params
    result: (_)? @result
  ) @fn
`;

/** Q3: Interface type declarations */
const INTERFACE_QUERY_SRC = `
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (interface_type) @body
    )
  ) @iface
`;

/** Q4: Struct type declarations */
const STRUCT_QUERY_SRC = `
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (struct_type) @body
    )
  ) @struct
`;

/** Q5: Type aliases — non-struct, non-interface type specs */
const TYPE_ALIAS_QUERY_SRC = `
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (_) @value
    )
  ) @alias
`;

// ─────────────────────────────────────────────────────────────────────────────
// Query cache — compile once per Language, reuse forever
// ─────────────────────────────────────────────────────────────────────────────

interface CompiledQueries {
  fn:       Query;
  method:   Query;
  iface:    Query;
  struct:   Query;
  alias:    Query;
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
    fn:       new Query(language, FN_QUERY_SRC),
    method:   new Query(language, METHOD_QUERY_SRC),
    iface:    new Query(language, INTERFACE_QUERY_SRC),
    struct:   new Query(language, STRUCT_QUERY_SRC),
    alias:    new Query(language, TYPE_ALIAS_QUERY_SRC),
  };

  return cachedQueries;
}

/**
 * Frees WASM memory held by cached queries.
 * Call during graceful shutdown or in test teardown.
 */
export function disposeQueries(): void {
  if (cachedQueries) {
    cachedQueries.fn.delete();
    cachedQueries.method.delete();
    cachedQueries.iface.delete();
    cachedQueries.struct.delete();
    cachedQueries.alias.delete();
    cachedQueries = null;
    cachedLanguage = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts all public API signatures from a Go AST.
 * Returns Map<string, AnySignature> keyed by unique symbol name.
 */
export function extractGoSignatures(
  tree:     Tree,
  language: Language,
): Map<string, AnySignature> {

  const result = new Map<string, AnySignature>();
  const overloadCounts = new Map<string, number>();
  const q = getQueries(language);

  // ── Functions ───────────────────────────────────────────────────────────────

  for (const match of q.fn.matches(tree.rootNode)) {
    const sig = buildFunctionSignature(match, overloadCounts);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Methods ─────────────────────────────────────────────────────────────────

  for (const match of q.method.matches(tree.rootNode)) {
    const sig = buildMethodSignature(match, overloadCounts);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Interfaces ──────────────────────────────────────────────────────────────

  for (const match of q.iface.matches(tree.rootNode)) {
    const sig = buildInterfaceSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`interface:${name}`, sig);
  }

  // ── Structs (as TypeAliasSignature) ─────────────────────────────────────────

  for (const match of q.struct.matches(tree.rootNode)) {
    const sig = buildStructSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`type:${name}`, sig);
  }

  // ── Type aliases ────────────────────────────────────────────────────────────

  for (const match of q.alias.matches(tree.rootNode)) {
    const valueNode = getCapture(match, 'value');
    // Skip structs and interfaces — already handled above
    if (valueNode &&
        (valueNode.type === 'struct_type' || valueNode.type === 'interface_type')) {
      continue;
    }
    const sig = buildTypeAliasSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`type:${name}`, sig);
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
  const resultNode = getCapture(match, 'result');
  const fnNode     = getCapture(match, 'fn');

  if (!nameNode || !paramsNode || !fnNode) return null;
  if (fnNode.hasError) return null;

  const rawName = nameNode.text;
  const key     = rawName;

  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params:          extractParams(paramsNode),
    returnType:      extractReturnType(resultNode),
    typeParameters:  undefined,

    exported:        isExported(rawName),
    isDefaultExport: false,
    async:           false,  // Go uses goroutines, not async/await
    isStatic:        undefined,
    isAbstract:      undefined,
    isGenerator:     undefined,
    isConstructor:   undefined,
    isGetter:        undefined,
    isSetter:        undefined,

    className:       undefined,
    accessModifier:  undefined,

    decorators:      undefined,
    overloadIndex:   currentCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Method signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildMethodSignature(
  match:          QueryMatch,
  overloadCounts: Map<string, number>,
): FunctionSignature | null {

  const nameNode     = getCapture(match, 'name');
  const paramsNode   = getCapture(match, 'params');
  const resultNode   = getCapture(match, 'result');
  const fnNode       = getCapture(match, 'fn');
  const receiverNode = getCapture(match, 'receiver');

  if (!nameNode || !paramsNode || !fnNode) return null;
  if (fnNode.hasError) return null;

  const rawName      = nameNode.text;
  const receiverType = extractReceiverType(receiverNode);
  const key          = receiverType ? `${receiverType}#${rawName}` : rawName;

  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params:          extractParams(paramsNode),
    returnType:      extractReturnType(resultNode),
    typeParameters:  undefined,

    exported:        isExported(rawName),
    isDefaultExport: false,
    async:           false,
    isStatic:        undefined,
    isAbstract:      undefined,
    isGenerator:     undefined,
    isConstructor:   undefined,
    isGetter:        undefined,
    isSetter:        undefined,

    className:       receiverType,
    accessModifier:  undefined,

    decorators:      undefined,
    overloadIndex:   currentCount,
  };
}

/**
 * Extracts the receiver type from a method declaration.
 * func (s *Service) Method() → 'Service'
 * func (s Service) Method()  → 'Service'
 */
function extractReceiverType(receiverNode: SyntaxNode | null): string | undefined {
  if (!receiverNode) return undefined;

  // The receiver is a parameter_list containing one parameter_declaration
  for (const child of receiverNode.namedChildren) {
    if (child.type === 'parameter_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) {
        // Strip pointer (*Service → Service)
        return typeNode.text.replace(/^\*/, '').trim();
      }
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildInterfaceSignature(
  match: QueryMatch,
): InterfaceSignature | null {

  const nameNode = getCapture(match, 'name');
  const bodyNode = getCapture(match, 'body');

  if (!nameNode || !bodyNode) return null;

  const properties = extractInterfaceMethods(bodyNode);

  return {
    line:            nameNode.startPosition.row + 1,
    properties,
    exported:        isExported(nameNode.text),
    isDefaultExport: false,
    typeParameters:  undefined,
    extends:         extractEmbeddedInterfaces(bodyNode),
  };
}

/**
 * Extracts method signatures from an interface_type body.
 * Go interfaces contain method_elem nodes.
 */
function extractInterfaceMethods(bodyNode: SyntaxNode): InterfaceProperty[] {
  const props: InterfaceProperty[] = [];

  for (const child of bodyNode.namedChildren) {
    if (child.type === 'method_elem') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        // Represent interface method as a property:
        // Method signature text as the "type"
        const paramsNode = child.childForFieldName('parameters');
        const resultNode = child.childForFieldName('result');
        const sig = paramsNode ? paramsNode.text : '()';
        const ret = resultNode ? ` ${resultNode.text}` : '';

        props.push({
          name:     nameNode.text,
          type:     `func${sig}${ret}`,
          optional: false,
          readonly: undefined,
        });
      }
    }
  }

  return props;
}

/**
 * Extracts embedded interfaces from an interface body.
 * type Reader interface { io.Reader; Close() error }
 */
function extractEmbeddedInterfaces(bodyNode: SyntaxNode): string[] | undefined {
  const embedded: string[] = [];

  for (const child of bodyNode.namedChildren) {
    if (child.type === 'type_elem') {
      embedded.push(child.text);
    }
    // Some grammars use qualified_type or type_identifier directly
    if (child.type === 'qualified_type' || child.type === 'type_identifier') {
      embedded.push(child.text);
    }
  }

  return embedded.length > 0 ? embedded : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Struct → TypeAliasSignature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildStructSignature(
  match: QueryMatch,
): TypeAliasSignature | null {

  const nameNode = getCapture(match, 'name');
  const bodyNode = getCapture(match, 'body');

  if (!nameNode || !bodyNode) return null;

  return {
    line:            nameNode.startPosition.row + 1,
    value:           bodyNode.text,
    exported:        isExported(nameNode.text),
    isDefaultExport: false,
    typeParameters:  undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type alias builder
// ─────────────────────────────────────────────────────────────────────────────

function buildTypeAliasSignature(
  match: QueryMatch,
): TypeAliasSignature | null {

  const nameNode  = getCapture(match, 'name');
  const valueNode = getCapture(match, 'value');

  if (!nameNode || !valueNode) return null;

  return {
    line:            nameNode.startPosition.row + 1,
    value:           valueNode.text,
    exported:        isExported(nameNode.text),
    isDefaultExport: false,
    typeParameters:  undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter extractor
// ─────────────────────────────────────────────────────────────────────────────

function extractParams(paramsNode: SyntaxNode): Param[] {
  const params: Param[] = [];

  for (const child of paramsNode.namedChildren) {

    switch (child.type) {

      // ── parameter_declaration: x int, x, y int ──────────────────────────────
      case 'parameter_declaration': {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        params.push({
          name:       nameNode?.text ?? '?',
          type:       typeNode?.text ?? 'any',
          optional:   false,
          hasDefault: false,
          isRest:     false,
        });
        break;
      }

      // ── variadic_parameter_declaration: args ...int ─────────────────────────
      case 'variadic_parameter_declaration': {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        params.push({
          name:       `...${nameNode?.text ?? 'args'}`,
          type:       typeNode?.text ?? 'any',
          optional:   true,
          hasDefault: false,
          isRest:     true,
        });
        break;
      }

      // ── Unknown — best-effort ───────────────────────────────────────────────
      default: {
        params.push({
          name:       child.text.trim() || '?',
          type:       'unknown',
          optional:   false,
          hasDefault: false,
          isRest:     false,
        });
      }
    }
  }

  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Return type extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the return type from a Go function.
 * Go supports multiple return values: (string, error)
 * A parameter_list result node → multiple returns, use full text.
 * A simple type node → single return.
 */
function extractReturnType(resultNode: SyntaxNode | null): string {
  if (!resultNode) return 'inferred'; // No return type = void-equivalent
  return resultNode.text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Modifier detectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Go export convention: capitalized first letter = exported.
 * 'ProcessPayment' → true
 * 'processPayment' → false
 */
function isExported(name: string): boolean {
  if (!name || name.length === 0) return false;
  return name.charAt(0) === name.charAt(0).toUpperCase() &&
         name.charAt(0) !== name.charAt(0).toLowerCase();
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
