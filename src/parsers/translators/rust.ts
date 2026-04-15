/**
 * src/parsers/translators/rust.ts
 *
 * THE RUST TRANSLATOR.
 * A pure function. No side effects. No file system access. No logging.
 * Receives a tree-sitter Tree, returns Map<string, AnySignature>.
 *
 * Covers every Rust construct that produces a public API:
 *  - Functions                     (function_item)
 *  - Impl methods                  (function_item inside impl_item)
 *  - Trait method signatures       (function_signature_item inside trait_item)
 *  - Traits                        (trait_item → InterfaceSignature)
 *  - Enums                         (enum_item with enum_variant children)
 *  - Structs                       (struct_item → TypeAliasSignature)
 *  - Type aliases                  (type_item → TypeAliasSignature)
 *
 * Returns Map<string, AnySignature> where the key is the unique symbol name.
 * Key format:
 *   Functions: 'process_payment'
 *   Methods:   'PaymentService#charge'
 *   Traits:    'interface:Payable'
 *   Enums:     'enum:Status'
 *   Structs:   'type:PaymentService'
 *   Aliases:   'type:UserId'
 *
 * Visibility: pub = exported, everything else = not exported.
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

/** Q1: Top-level function items */
const FN_QUERY_SRC = `
  (function_item
    name: (identifier) @name
    parameters: (parameters) @params
    return_type: (_)? @return
  ) @fn
`;

/** Q2: Trait definitions */
const TRAIT_QUERY_SRC = `
  (trait_item
    name: (type_identifier) @name
    body: (declaration_list) @body
  ) @trait
`;

/** Q3: Impl blocks */
const IMPL_QUERY_SRC = `
  (impl_item
    type: (_) @impl_type
    body: (declaration_list) @body
  ) @impl
`;

/** Q4: Enum items */
const ENUM_QUERY_SRC = `
  (enum_item
    name: (type_identifier) @name
    body: (enum_variant_list) @body
  ) @enum
`;

/** Q5: Struct items */
const STRUCT_QUERY_SRC = `
  (struct_item
    name: (type_identifier) @name
  ) @struct
`;

/** Q6: Type alias items */
const TYPE_ALIAS_QUERY_SRC = `
  (type_item
    name: (type_identifier) @name
    type: (_) @value
  ) @alias
`;

// ─────────────────────────────────────────────────────────────────────────────
// Query cache — compile once per Language, reuse forever
// ─────────────────────────────────────────────────────────────────────────────

interface CompiledQueries {
  fn:     Query;
  trait:  Query;
  impl:   Query;
  enum:   Query;
  struct: Query;
  alias:  Query;
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
    fn:     new Query(language, FN_QUERY_SRC),
    trait:  new Query(language, TRAIT_QUERY_SRC),
    impl:   new Query(language, IMPL_QUERY_SRC),
    enum:   new Query(language, ENUM_QUERY_SRC),
    struct: new Query(language, STRUCT_QUERY_SRC),
    alias:  new Query(language, TYPE_ALIAS_QUERY_SRC),
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
    cachedQueries.trait.delete();
    cachedQueries.impl.delete();
    cachedQueries.enum.delete();
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
 * Extracts all public API signatures from a Rust AST.
 * Returns Map<string, AnySignature> keyed by unique symbol name.
 */
export function extractRustSignatures(
  tree:     Tree,
  language: Language,
): Map<string, AnySignature> {

  const result = new Map<string, AnySignature>();
  const overloadCounts = new Map<string, number>();
  const q = getQueries(language);

  // ── Top-level functions ─────────────────────────────────────────────────────
  // Only match functions NOT inside an impl or trait block

  for (const match of q.fn.matches(tree.rootNode)) {
    const fnNode = getCapture(match, 'fn');
    if (!fnNode) continue;
    // Skip functions inside impl_item or trait_item — handled separately
    if (isInsideImplOrTrait(fnNode)) continue;

    const sig = buildFunctionSignature(match, overloadCounts, undefined);
    if (!sig) continue;
    result.set(sig.name, sig);
  }

  // ── Impl blocks — extract methods ──────────────────────────────────────────

  for (const match of q.impl.matches(tree.rootNode)) {
    const implTypeNode = getCapture(match, 'impl_type');
    const bodyNode     = getCapture(match, 'body');
    const implNode     = getCapture(match, 'impl');

    if (!implTypeNode || !bodyNode || !implNode) continue;

    // Extract the type name being implemented (strip generics)
    const implTypeName = implTypeNode.type === 'type_identifier'
      ? implTypeNode.text
      : implTypeNode.text.split('<')[0].trim();

    // Check if this is a trait impl: impl Trait for Type
    const traitName = extractTraitForImpl(implNode);

    // Process each function_item inside the impl body
    for (const child of bodyNode.namedChildren) {
      if (child.type === 'function_item') {
        const methodSig = buildImplMethodSignature(
          child, overloadCounts, implTypeName, traitName
        );
        if (methodSig) {
          result.set(methodSig.name, methodSig);
        }
      }
    }
  }

  // ── Traits ──────────────────────────────────────────────────────────────────

  for (const match of q.trait.matches(tree.rootNode)) {
    const sig = buildTraitSignature(match);
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

  // ── Structs ─────────────────────────────────────────────────────────────────

  for (const match of q.struct.matches(tree.rootNode)) {
    const sig = buildStructSignature(match);
    if (!sig) continue;
    const name = getCapture(match, 'name')?.text ?? '';
    result.set(`type:${name}`, sig);
  }

  // ── Type aliases ────────────────────────────────────────────────────────────

  for (const match of q.alias.matches(tree.rootNode)) {
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
  className:      string | undefined,
): FunctionSignature | null {

  const nameNode   = getCapture(match, 'name');
  const paramsNode = getCapture(match, 'params');
  const returnNode = getCapture(match, 'return');
  const fnNode     = getCapture(match, 'fn');

  if (!nameNode || !paramsNode || !fnNode) return null;
  if (fnNode.hasError) return null;

  const rawName = nameNode.text;
  const key     = className ? `${className}#${rawName}` : rawName;

  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  // Extract function modifiers (async, unsafe)
  const fnModifiers = extractFnModifiers(fnNode);

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params:          extractParams(paramsNode),
    returnType:      returnNode ? returnNode.text.trim() : 'inferred',
    typeParameters:  extractTypeParameters(fnNode),

    exported:        hasVisibilityModifier(fnNode),
    isDefaultExport: false,
    async:           fnModifiers.has('async'),
    isStatic:        undefined,
    isAbstract:      undefined,
    isGenerator:     undefined,
    isConstructor:   rawName === 'new' || undefined,
    isGetter:        undefined,
    isSetter:        undefined,

    className,
    accessModifier:  hasVisibilityModifier(fnNode) ? 'public' : 'private',

    decorators:      extractAttributes(fnNode),
    overloadIndex:   currentCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Impl method builder
// ─────────────────────────────────────────────────────────────────────────────

function buildImplMethodSignature(
  fnNode:         SyntaxNode,
  overloadCounts: Map<string, number>,
  implTypeName:   string,
  _traitName:     string | undefined,
): FunctionSignature | null {

  const nameNode   = fnNode.childForFieldName('name');
  const paramsNode = fnNode.childForFieldName('parameters');
  const returnNode = fnNode.childForFieldName('return_type');

  if (!nameNode || !paramsNode) return null;
  if (fnNode.hasError) return null;

  const rawName = nameNode.text;

  // Check if first param is self/&self/&mut self → instance method
  const allParams  = extractParams(paramsNode);
  const hasSelf    = allParams.length > 0 &&
    (allParams[0].name === 'self' || allParams[0].name === '&self' || allParams[0].name === '&mut self');
  const isStatic   = !hasSelf;

  // Build map key
  const key = isStatic
    ? `${implTypeName}.${rawName}`
    : `${implTypeName}#${rawName}`;

  const currentCount = overloadCounts.get(key) ?? 0;
  overloadCounts.set(key, currentCount + 1);

  // Strip self from params for the signature
  const params = hasSelf ? allParams.slice(1) : allParams;

  const fnModifiers = extractFnModifiers(fnNode);

  return {
    name:            key,
    line:            fnNode.startPosition.row + 1,

    params,
    returnType:      returnNode ? returnNode.text.trim() : 'inferred',
    typeParameters:  extractTypeParameters(fnNode),

    exported:        hasVisibilityModifier(fnNode),
    isDefaultExport: false,
    async:           fnModifiers.has('async'),
    isStatic:        isStatic || undefined,
    isAbstract:      undefined,
    isGenerator:     undefined,
    isConstructor:   rawName === 'new' || undefined,
    isGetter:        undefined,
    isSetter:        undefined,

    className:       implTypeName,
    accessModifier:  hasVisibilityModifier(fnNode) ? 'public' : 'private',

    decorators:      extractAttributes(fnNode),
    overloadIndex:   currentCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trait → InterfaceSignature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildTraitSignature(
  match: QueryMatch,
): InterfaceSignature | null {

  const traitNode = getCapture(match, 'trait');
  const nameNode  = getCapture(match, 'name');
  const bodyNode  = getCapture(match, 'body');

  if (!traitNode || !nameNode || !bodyNode) return null;

  const properties = extractTraitMethods(bodyNode);
  const bounds     = extractTraitBounds(traitNode);

  return {
    line:            traitNode.startPosition.row + 1,
    properties,
    exported:        hasVisibilityModifier(traitNode),
    isDefaultExport: false,
    typeParameters:  extractTypeParameters(traitNode),
    extends:         bounds,
  };
}

/**
 * Extracts method signatures from a trait body as InterfaceProperty[].
 * Trait methods are either function_signature_item (abstract) or function_item (default impl).
 */
function extractTraitMethods(bodyNode: SyntaxNode): InterfaceProperty[] {
  const props: InterfaceProperty[] = [];

  for (const child of bodyNode.namedChildren) {
    // Abstract method (no body)
    if (child.type === 'function_signature_item') {
      const nameNode   = child.childForFieldName('name');
      const paramsNode = child.childForFieldName('parameters');
      const retNode    = child.childForFieldName('return_type');

      if (nameNode) {
        const paramsSig = paramsNode?.text ?? '()';
        const retSig    = retNode ? ` -> ${retNode.text}` : '';
        props.push({
          name:     nameNode.text,
          type:     `fn${paramsSig}${retSig}`,
          optional: false, // required — must implement
          readonly: undefined,
        });
      }
    }

    // Default method (has body) — still part of the trait interface
    if (child.type === 'function_item') {
      const nameNode   = child.childForFieldName('name');
      const paramsNode = child.childForFieldName('parameters');
      const retNode    = child.childForFieldName('return_type');

      if (nameNode) {
        const paramsSig = paramsNode?.text ?? '()';
        const retSig    = retNode ? ` -> ${retNode.text}` : '';
        props.push({
          name:     nameNode.text,
          type:     `fn${paramsSig}${retSig}`,
          optional: true, // has default impl — optional to override
          readonly: undefined,
        });
      }
    }
  }

  return props;
}

function extractTraitBounds(traitNode: SyntaxNode): string[] | undefined {
  const boundsNode = traitNode.childForFieldName('bounds');
  if (!boundsNode) return undefined;

  const bounds: string[] = [];
  for (const child of boundsNode.namedChildren) {
    bounds.push(child.text);
  }
  return bounds.length > 0 ? bounds : undefined;
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
    if (child.type === 'enum_variant') {
      const nameNode  = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      const bodyField = child.childForFieldName('body');

      if (nameNode) {
        // Variant value could be an explicit discriminant or tuple/struct fields
        const value = valueNode?.text ?? bodyField?.text;
        members.push({
          name:  nameNode.text,
          value,
        });
      }
    }
  }

  return {
    line:            enumNode.startPosition.row + 1,
    members,
    exported:        hasVisibilityModifier(enumNode),
    isDefaultExport: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Struct → TypeAliasSignature builder
// ─────────────────────────────────────────────────────────────────────────────

function buildStructSignature(
  match: QueryMatch,
): TypeAliasSignature | null {

  const structNode = getCapture(match, 'struct');
  const nameNode   = getCapture(match, 'name');

  if (!structNode || !nameNode) return null;

  // Use the full struct text as the "value" — preserves field definitions
  // This is a structural representation; field-level diffing happens in the classifier
  const bodyNode = structNode.children.find(
    c => c.type === 'field_declaration_list' || c.type === 'ordered_field_declaration_list'
  );

  return {
    line:            structNode.startPosition.row + 1,
    value:           bodyNode?.text ?? '()',
    exported:        hasVisibilityModifier(structNode),
    isDefaultExport: false,
    typeParameters:  extractTypeParameters(structNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type alias builder
// ─────────────────────────────────────────────────────────────────────────────

function buildTypeAliasSignature(
  match: QueryMatch,
): TypeAliasSignature | null {

  const aliasNode = getCapture(match, 'alias');
  const nameNode  = getCapture(match, 'name');
  const valueNode = getCapture(match, 'value');

  if (!aliasNode || !nameNode || !valueNode) return null;

  return {
    line:            aliasNode.startPosition.row + 1,
    value:           valueNode.text,
    exported:        hasVisibilityModifier(aliasNode),
    isDefaultExport: false,
    typeParameters:  extractTypeParameters(aliasNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter extractor
// ─────────────────────────────────────────────────────────────────────────────

function extractParams(paramsNode: SyntaxNode): Param[] {
  const params: Param[] = [];

  for (const child of paramsNode.namedChildren) {

    switch (child.type) {

      // ── self_parameter: self, &self, &mut self ──────────────────────────────
      case 'self_parameter': {
        params.push({
          name:       child.text.trim(),
          type:       'Self',
          optional:   false,
          hasDefault: false,
          isRest:     false,
        });
        break;
      }

      // ── parameter: pattern: Type ────────────────────────────────────────────
      case 'parameter': {
        const patternNode = child.childForFieldName('pattern');
        const typeNode    = child.childForFieldName('type');

        // Check for mutable_specifier
        const isMut = child.children.some(c => c.type === 'mutable_specifier');

        params.push({
          name:       patternNode?.text ?? '?',
          type:       typeNode?.text ?? 'unknown',
          optional:   false,
          hasDefault: false,
          isRest:     false,
        });

        // If mutable, we note it but don't change the name — it's a Rust-specific concept
        void isMut;
        break;
      }

      // ── variadic_parameter: ... in extern "C" functions ─────────────────────
      case 'variadic_parameter': {
        params.push({
          name:       '...',
          type:       'c_variadic',
          optional:   true,
          hasDefault: false,
          isRest:     true,
        });
        break;
      }

      // ── attribute_item: #[...] on parameter ─────────────────────────────────
      case 'attribute_item': {
        // Skip — not a parameter itself
        break;
      }

      // ── Unknown — best-effort ───────────────────────────────────────────────
      default: {
        // Could be a raw type (for function pointers)
        params.push({
          name:       '_',
          type:       child.text.trim() || 'unknown',
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
// Modifier detectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a node has a visibility_modifier (pub, pub(crate), pub(super)).
 * Any form of pub = exported.
 */
function hasVisibilityModifier(node: SyntaxNode): boolean {
  return node.children.some(c => c.type === 'visibility_modifier');
}

/**
 * Extracts function modifiers: async, unsafe, const, extern.
 */
function extractFnModifiers(fnNode: SyntaxNode): Set<string> {
  const mods = new Set<string>();

  for (const child of fnNode.children) {
    if (child.type === 'function_modifiers') {
      for (const mod of child.children) {
        mods.add(mod.text);
      }
    }
    // Direct modifiers like 'unsafe' or 'async' may also appear as children
    if (child.type === 'async' || child.text === 'async') mods.add('async');
    if (child.type === 'unsafe' || child.text === 'unsafe') mods.add('unsafe');
  }

  return mods;
}

/**
 * Extracts #[...] attributes as decorator equivalents.
 * #[derive(Debug, Clone)] → ['derive(Debug, Clone)']
 * #[test] → ['test']
 */
function extractAttributes(node: SyntaxNode): string[] | undefined {
  const attrs: string[] = [];

  // Look at previous siblings for attribute_item nodes
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'attribute_item') {
    // Strip #[ and ]
    const text = prev.text.replace(/^#\[/, '').replace(/\]$/, '').trim();
    if (text) attrs.unshift(text); // prepend to maintain order
    prev = prev.previousNamedSibling;
  }

  return attrs.length > 0 ? attrs : undefined;
}

function extractTypeParameters(node: SyntaxNode): TypeParameter[] | undefined {
  const typeParams = node.children.find(
    c => c.type === 'type_parameters'
  );
  if (!typeParams) return undefined;

  const params: TypeParameter[] = [];
  for (const child of typeParams.namedChildren) {
    // type_identifier, constrained_type_parameter, lifetime, etc.
    params.push({ name: child.text });
  }
  return params.length > 0 ? params : undefined;
}

/**
 * Checks if a function_item is nested inside an impl_item or trait_item.
 */
function isInsideImplOrTrait(fnNode: SyntaxNode): boolean {
  let current = fnNode.parent;
  while (current) {
    if (current.type === 'impl_item' || current.type === 'trait_item') return true;
    if (current.type === 'declaration_list') {
      current = current.parent;
      continue;
    }
    break;
  }
  return false;
}

/**
 * For `impl Trait for Type`, extracts the trait name.
 * Returns undefined for inherent impls (no trait).
 */
function extractTraitForImpl(implNode: SyntaxNode): string | undefined {
  const traitNode = implNode.childForFieldName('trait');
  if (!traitNode) return undefined;
  return traitNode.text.split('<')[0].trim();
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
