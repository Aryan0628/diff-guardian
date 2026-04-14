/**
 * src/parsers/translators/python.ts
 *
 * THE PYTHON TRANSLATOR.
 * A pure function. No side effects. No file system access. No logging.
 * Receives a tree-sitter Tree, returns Map<string, AnySignature>.
 *
 * Covers every Python construct that produces a public API:
 *  - Top-level functions           (function_definition)
 *  - Decorated functions           (decorated_definition → function_definition)
 *  - Class methods                 (function_definition inside class_definition)
 *  - Constructors                  (__init__)
 *  - Static/class methods          (@staticmethod / @classmethod)
 *  - Properties                    (@property)
 *  - Async functions               (async keyword)
 *  - Classes                       (class_definition → InterfaceSignature)
 *
 * Returns Map<string, AnySignature> where the key is the unique symbol name.
 * Key format:
 *   Functions:    'process_payment'
 *   Methods:      'PaymentService#charge'
 *   Constructors: 'PaymentService#__init__'
 *   Statics:      'PaymentService.create'
 *   Classes:      'class:PaymentService'
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
  Param,
} from '../../core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** Q1: Top-level and class-level functions (undecorated) */
const FN_QUERY_SRC = `
  (function_definition
    name: (identifier) @name
    parameters: (parameters) @params
    return_type: (type)? @return
  ) @fn
`;

/** Q2: Decorated functions — decorator wraps function_definition */
const DECORATED_FN_QUERY_SRC = `
  (decorated_definition
    (function_definition
      name: (identifier) @name
      parameters: (parameters) @params
      return_type: (type)? @return
    ) @fn
  ) @decorated
`;

/** Q3: Class definitions — for extracting class structure as InterfaceSignature */
const CLASS_QUERY_SRC = `
  (class_definition
    name: (identifier) @name
    body: (block) @body
  ) @class
`;

// ─────────────────────────────────────────────────────────────────────────────
// Query cache — compile once per Language, reuse forever
// ─────────────────────────────────────────────────────────────────────────────

interface CompiledQueries {
  fn:        Query;
  decorated: Query;
  cls:       Query;
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
    fn:        new Query(language, FN_QUERY_SRC),
    decorated: new Query(language, DECORATED_FN_QUERY_SRC),
    cls:       new Query(language, CLASS_QUERY_SRC),
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
    cachedQueries.decorated.delete();
    cachedQueries.cls.delete();
    cachedQueries = null;
    cachedLanguage = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts all public API signatures from a Python AST.
 * Returns Map<string, AnySignature> keyed by unique symbol name.
 */
export function extractPySignatures(
  tree:     Tree,
  language: Language,
): Map<string, AnySignature> {

  const result = new Map<string, AnySignature>();
  const overloadCounts = new Map<string, number>();
  const q = getQueries(language);

  // ── Functions (undecorated) ─────────────────────────────────────────────────

  for (const match of q.fn.matches(tree.rootNode)) {
    // Skip functions that are children of a decorated_definition —
    // those are handled by the decorated query to avoid double-counting.
    const fnNode = getCapture(match, 'fn');
    if (fnNode && fnNode.parent?.type === 'decorated_definition') continue;

    const sig = buildFunctionSignature(match, overloadCounts, []);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Decorated functions ─────────────────────────────────────────────────────

  for (const match of q.decorated.matches(tree.rootNode)) {
    const decoratedNode = getCapture(match, 'decorated');
    const decorators = decoratedNode ? extractDecorators(decoratedNode) : [];
    const sig = buildFunctionSignature(match, overloadCounts, decorators);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Classes ─────────────────────────────────────────────────────────────────

  for (const match of q.cls.matches(tree.rootNode)) {
    const sig = buildClassSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`class:${name}`, sig);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Function signature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildFunctionSignature(
  match:          QueryMatch,
  overloadCounts: Map<string, number>,
  decorators:     string[],
): FunctionSignature | null {

  const nameNode   = getCapture(match, 'name');
  const paramsNode = getCapture(match, 'params');
  const returnNode = getCapture(match, 'return');
  const fnNode     = getCapture(match, 'fn');

  if (!nameNode || !paramsNode || !fnNode) return null;
  if (fnNode.hasError) return null;

  const rawName   = nameNode.text;
  const className = getEnclosingClassName(fnNode);
  const isInit    = rawName === '__init__';

  // Detect static/classmethod/property from decorators
  const isStatic    = decorators.includes('staticmethod');
  const isClassMeth = decorators.includes('classmethod');
  const isProperty  = decorators.includes('property');
  const isAbstract  = decorators.includes('abstractmethod');

  // Detect async — async functions have 'async' as the first keyword
  const isAsync = fnNode.parent?.type === 'decorated_definition'
    ? fnNode.parent.text.trimStart().startsWith('async')
    : fnNode.text.trimStart().startsWith('async');

  // Build the unique map key
  let key: string;
  if (className) {
    key = (isStatic || isClassMeth)
      ? `${className}.${rawName}`
      : `${className}#${rawName}`;
  } else {
    key = rawName;
  }

  // Overload tracking
  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  // Return type
  const returnType: string = returnNode
    ? returnNode.text.replace(/^->\s*/, '').trim()
    : 'inferred';

  // Extract params — skip 'self' and 'cls' for instance/class methods
  const allParams = extractParams(paramsNode);
  const params = (className && !isStatic)
    ? allParams.filter(p => p.name !== 'self' && p.name !== 'cls')
    : allParams;

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params,
    returnType,
    typeParameters:  undefined,

    exported:        isExported(rawName),
    isDefaultExport: false, // Python has no default exports
    async:           isAsync,
    isStatic:        (isStatic || isClassMeth) || undefined,
    isAbstract:      isAbstract || undefined,
    isGenerator:     isGeneratorFn(fnNode) || undefined,
    isConstructor:   isInit || undefined,
    isGetter:        isProperty || undefined,
    isSetter:        hasSetter(decorators) || undefined,

    className,
    accessModifier:  getAccessModifier(rawName),

    decorators:      decorators.length > 0 ? decorators : undefined,
    overloadIndex:   currentCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Class → InterfaceSignature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildClassSignature(
  match: QueryMatch,
): InterfaceSignature | null {

  const classNode = getCapture(match, 'class');
  const bodyNode  = getCapture(match, 'body');
  const nameNode  = getCapture(match, 'name');

  if (!classNode || !bodyNode || !nameNode) return null;

  const properties = extractClassProperties(bodyNode);
  const extendsParents = extractBaseClasses(classNode);

  return {
    line:            classNode.startPosition.row + 1,
    properties,
    exported:        isExported(nameNode.text),
    isDefaultExport: false,
    typeParameters:  undefined,
    extends:         extendsParents,
  };
}

/**
 * Extracts class-level typed assignments as interface properties.
 * Looks for:
 *  - type: annotation  (name: Type)
 *  - expression_statement with assignment having type annotation
 */
function extractClassProperties(bodyNode: SyntaxNode): InterfaceProperty[] {
  const props: InterfaceProperty[] = [];

  for (const child of bodyNode.namedChildren) {
    // Type annotation: name: Type
    if (child.type === 'expression_statement') {
      const inner = child.namedChildren[0];
      if (inner?.type === 'type' || inner?.type === 'assignment') {
        // assignment: name: Type = value
        const nameNode = inner.childForFieldName('name')
                      ?? inner.namedChildren[0];
        const typeNode = inner.childForFieldName('type');
        if (nameNode && nameNode.type === 'identifier') {
          props.push({
            name:     nameNode.text,
            type:     typeNode ? typeNode.text : 'Any',
            optional: false,
            readonly: undefined,
          });
        }
      }
    }
  }

  return props;
}

function extractBaseClasses(classNode: SyntaxNode): string[] | undefined {
  const superclasses = classNode.childForFieldName('superclasses');
  if (!superclasses) return undefined;

  const parents: string[] = [];
  for (const child of superclasses.namedChildren) {
    if (child.type === 'identifier' || child.type === 'attribute') {
      parents.push(child.text);
    }
  }
  return parents.length > 0 ? parents : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter extractor
// ─────────────────────────────────────────────────────────────────────────────

function extractParams(paramsNode: SyntaxNode): Param[] {
  const params: Param[] = [];

  for (const child of paramsNode.namedChildren) {

    switch (child.type) {

      // ── identifier: bare parameter (no type, no default) ────────────────────
      case 'identifier': {
        params.push({
          name:       child.text,
          type:       'Any',
          optional:   false,
          hasDefault: false,
          isRest:     false,
        });
        break;
      }

      // ── typed_parameter: x: int ─────────────────────────────────────────────
      case 'typed_parameter': {
        const nameChild = child.namedChildren.find(n =>
          n.type === 'identifier' || n.type === 'list_splat_pattern' || n.type === 'dictionary_splat_pattern'
        );
        const typeChild = child.childForFieldName('type');

        const isArgs   = nameChild?.type === 'list_splat_pattern';
        const isKwargs = nameChild?.type === 'dictionary_splat_pattern';
        const name     = isArgs
          ? `*${nameChild?.namedChildren[0]?.text ?? 'args'}`
          : isKwargs
            ? `**${nameChild?.namedChildren[0]?.text ?? 'kwargs'}`
            : (nameChild?.text ?? '?');

        params.push({
          name,
          type:       typeChild?.text ?? 'Any',
          optional:   isArgs || isKwargs,
          hasDefault: false,
          isRest:     isArgs || isKwargs,
        });
        break;
      }

      // ── default_parameter: x=5 ─────────────────────────────────────────────
      case 'default_parameter': {
        const nameNode  = child.childForFieldName('name');
        const valueNode = child.childForFieldName('value');
        params.push({
          name:         nameNode?.text ?? '?',
          type:         'Any',
          optional:     true,
          hasDefault:   true,
          defaultValue: valueNode?.text,
          isRest:       false,
        });
        break;
      }

      // ── typed_default_parameter: x: int = 5 ────────────────────────────────
      case 'typed_default_parameter': {
        const nameNode  = child.childForFieldName('name');
        const typeNode  = child.childForFieldName('type');
        const valueNode = child.childForFieldName('value');
        params.push({
          name:         nameNode?.text ?? '?',
          type:         typeNode?.text ?? 'Any',
          optional:     true,
          hasDefault:   true,
          defaultValue: valueNode?.text,
          isRest:       false,
        });
        break;
      }

      // ── list_splat_pattern: *args ───────────────────────────────────────────
      case 'list_splat_pattern': {
        const inner = child.namedChildren[0];
        params.push({
          name:       `*${inner?.text ?? 'args'}`,
          type:       'Any',
          optional:   true,
          hasDefault: false,
          isRest:     true,
        });
        break;
      }

      // ── dictionary_splat_pattern: **kwargs ──────────────────────────────────
      case 'dictionary_splat_pattern': {
        const inner = child.namedChildren[0];
        params.push({
          name:       `**${inner?.text ?? 'kwargs'}`,
          type:       'Any',
          optional:   true,
          hasDefault: false,
          isRest:     true,
        });
        break;
      }

      // ── Unknown node — best-effort extraction ──────────────────────────────
      default: {
        params.push({
          name:       child.text.split(':')[0].split('=')[0].trim() || '?',
          type:       'unknown',
          optional:   child.text.includes('='),
          hasDefault: child.text.includes('='),
          isRest:     child.text.startsWith('*'),
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
 * Python export convention: names starting with underscore are private.
 * Single underscore = internal, double underscore = name-mangled.
 * No underscore prefix = public API.
 */
function isExported(name: string): boolean {
  return !name.startsWith('_');
}

/**
 * Python access modifier from naming convention:
 *   __method → private (name mangled)
 *   _method  → protected (internal by convention)
 *   method   → public
 */
function getAccessModifier(
  name: string,
): 'public' | 'protected' | 'private' | undefined {
  // Dunder methods (__init__, __str__) are special — they are public
  if (name.startsWith('__') && name.endsWith('__')) return 'public';
  if (name.startsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return 'public';
}

function isGeneratorFn(node: SyntaxNode): boolean {
  // Generator functions contain yield expressions in their body
  const body = node.childForFieldName('body');
  if (!body) return false;
  return containsNodeType(body, 'yield');
}

function containsNodeType(node: SyntaxNode, type: string): boolean {
  if (node.type === type) return true;
  for (const child of node.namedChildren) {
    if (containsNodeType(child, type)) return true;
  }
  return false;
}

function getEnclosingClassName(fnNode: SyntaxNode): string | undefined {
  let current = fnNode.parent;
  while (current) {
    if (current.type === 'class_definition') {
      return current.childForFieldName('name')?.text;
    }
    // Walk up through decorated_definition, block, etc.
    current = current.parent;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decorator extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractDecorators(decoratedNode: SyntaxNode): string[] {
  const decorators: string[] = [];
  for (const child of decoratedNode.namedChildren) {
    if (child.type === 'decorator') {
      // @staticmethod → 'staticmethod'
      // @app.route('/') → 'app.route'
      const content = child.text.replace(/^@/, '').replace(/\(.*\)$/, '').trim();
      if (content) decorators.push(content);
    }
  }
  return decorators;
}

function hasSetter(decorators: string[]): boolean {
  return decorators.some(d => d.endsWith('.setter'));
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
