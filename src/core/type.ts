/**
 * src/core/types.ts
 * * THE DIFF-GUARDIAN DATA CONTRACT
 * This file is the absolute source of truth for the entire diff-guardian architecture.
 * It serves as the bridge between the AST Parsers (which read raw code) and the 
 * Classifier Engine (which calculates risk). Every single TypeScript feature that 
 * could potentially cause a breaking change—across all 28+ classification rules—is 
 * mathematically represented in these interfaces. 
 */

export interface Param {
  name: string;          // The name of the parameter (e.g., 'userId')
  type: string;          // The TypeScript type annotation as a raw string (e.g., 'string | number')
  optional: boolean;     // True if the parameter has a '?' modifier, indicating it can be omitted
  hasDefault: boolean;   // True if the parameter has an assignment operator '='
  defaultValue?: string; // The actual default value string (Required for Rule R23: Default param value changed)
  isRest?: boolean;      // True if it uses the spread syntax '...args' (Required for Rule R14: Rest param added)
  readonly: boolean;     // True if marked 'readonly' (Required for Rules R18/R19: Param mutability narrowed)
}

export interface FunctionSignature {
  params: Param[];         // Array of all parameters in the exact order they appear
  returnType: string;      // The return type annotation as a string (e.g., 'Promise<void>')
  exported: boolean;       // True if part of the public API via 'export' (Required for Rule R8)
  isDefaultExport: boolean;// True if 'export default' (Catches named vs default import breakages)
  async: boolean;          // True if marked 'async' (Required for Rule R11: Async/Sync swap)
  isGenerator?: boolean;   // True if function*/method* (Required for Rule R12: Generator toggle)
  className?: string;      // The name of the parent class, if any (Prevents class method naming collisions)
  accessModifier?: 'public' | 'protected' | 'private'; // (Required for Rule R20: Visibility narrowed)
  isStatic?: boolean;      // True if marked 'static' (Required for Rule R17: Static <-> instance swap)
  isAbstract?: boolean;    // True if marked 'abstract' (Required for Rule R21: Abstract toggle)
  isConstructor?: boolean; // True if this is a class 'constructor' (Required for Rule R24)
  isGetter?: boolean;      // True if this is a 'get' accessor (Catches property -> method conversions)
  isSetter?: boolean;      // True if this is a 'set' accessor
  decorators?: string[];   // Raw decorator names like ['Injectable', 'deprecated'] (Required for Rule R16: Decorator removed/changed)
  typeParameters?: string[];// Tracks generic constraints like '<T extends Record>' (Required for Rule R13)
  overloadIndex?: number;  // The index (0, 1, 2) of the signature (Prevents overloaded functions from overwriting each other)
}

export interface InterfaceProperty {
  name: string;      // The name of the interface key
  type: string;      // The type of the interface key
  optional: boolean; // True if the key has a '?' modifier (Required for Rules R25/R26)
  readonly?: boolean;// True if marked 'readonly' (Removing readonly from a prop is a breaking change)
}

export interface InterfaceSignature {
  properties: InterfaceProperty[]; // Array of all properties defined in the interface
  exported: boolean;               // True if the interface is exported
  isDefaultExport?: boolean;       // True if 'export default interface' (Edge Case 5)
  typeParameters?: string[];       // Tracks generics on the interface like 'interface Response<T>'
  extends?: string[];              // Parent interfaces (e.g., ['Base', 'Auditable']) — tracks inheritance changes
}

export interface EnumMember {
  name: string;        // The enum key (e.g., 'Active')
  value?: string;      // The explicit initializer (e.g., '1'), undefined if auto-incremented
}

export interface EnumSignature {
  members: EnumMember[]; // Array of enum members with names and values (Required for Rule R27)
  exported: boolean;     // True if the enum is exported
  isDefaultExport?: boolean; // True if 'export default enum' (Edge Case 5)
}

export interface TypeAliasSignature {
  value: string;             // The raw string of what the type equals (e.g., "'active' | 'inactive'")
  exported: boolean;         // True if the type alias is exported
  isDefaultExport?: boolean; // True if 'export default type' (Edge Case 5)
  typeParameters?: string[]; // Tracks generics on the type like 'type Node<T> = ...'
}

export type ChangeType = 
  | 'signature_change'         // Params changed, generics narrowed, async swapped, etc.
  | 'return_type_widened'      // Gained null/undefined/never (Breaking)
  | 'return_type_narrowed'     // any -> string (Non-breaking but flagged)
  | 'visibility_changed'       // exported <-> unexported, static <-> instance, public -> private
  | 'function_deleted'         // Symbol removed entirely from the codebase
  | 'function_added'           // New symbol added to the codebase (Non-breaking)
  | 'interface_property_added' // New required property added to an interface (Breaking)
  | 'interface_property_removed' // Property removed from an interface (Breaking)
  | 'enum_member_changed'      // Enum value removed, renamed, or re-assigned (Breaking)
  | 'type_alias_changed';      // Type alias union narrowed or structurally changed (Breaking)

export type Language = 'javascript' | 'typescript' | 'python' | 'go' | 'java' | 'rust';

export interface CallSite {
  file: string;      // The relative path to the file making the function call
  lineStart: number; // The exact starting line number of the call (1-indexed)
  lineEnd: number;   // The exact ending line number (Required to highlight multi-line calls in PR comments)
  covered: boolean;  // True if a unit test file references this specific caller
}

export interface FunctionChange {
  id: string;          // Unique identifier format: 'src/file.ts:ClassName.methodName:42'
  name: string;        // The name of the function, interface, enum, or type alias
  fingerprint?: string;// Structural hash of the AST body to correlate renames across line moves (Edge Case 1)
  file: string;        // The relative path from the repository root
  lineStart: number;   // The starting line number in the new file (0 if the symbol was deleted)
  lineEnd: number;     // The ending line number in the new file
  language: Language;  // The AST parser that generated this object (e.g., 'typescript')
  symbolType: 'function' | 'interface' | 'enum' | 'type_alias'; // Tells the classifier which union type to expect below
  before: FunctionSignature | InterfaceSignature | EnumSignature | TypeAliasSignature | null; // The state of the symbol in the base branch
  after: FunctionSignature | InterfaceSignature | EnumSignature | TypeAliasSignature | null;  // The state of the symbol in the feature branch
  changeType: ChangeType; // The finalized category assigned by the Classifier engine
  breaking: boolean;      // True if the Classifier determined this change will crash downstream callers
  callers: CallSite[];    // Array of files calling this symbol (Populated by the Tracer engine in Stage 4)
}

export interface RiskFile {
  path: string;   // The file path that is deemed risky
  reason: string; // The human-readable explanation of why it is risky (e.g., 'Contains 4 broken call sites')
}

export interface AnalysisResult {
  from: string;               // The human-readable base branch name (e.g., 'main')
  to: string;                 // The human-readable head branch name (e.g., 'feat/update-api')
  baseSha: string;            // The exact git commit hash of the base branch (Ensures CI/CD report immutability)
  headSha: string;            // The exact git commit hash of the feature branch
  riskScore: number;          // The final calculated integer from 0 to 100
  breaking: FunctionChange[]; // Array of all symbols that had breaking changes
  apiChanges: FunctionChange[];// Array of all symbols that changed (breaking and non-breaking)
  testGaps: FunctionChange[]; // Array of broken symbols whose downstream callers lack unit tests
  riskFiles: RiskFile[];      // Array of files flagged for high risk
}