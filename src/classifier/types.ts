/**
 * THE RULE CONTRACT.
 * Every breaking change rule must implement this interface.
 * The Engine uses this contract to blindly execute rules without needing
 * to know their internal logic.
 */

import {
  AnySignature,
  FunctionSignature,
  InterfaceSignature,
  EnumSignature,
  TypeAliasSignature,
  ChangeType,
  Severity,
  Language,
} from '../core/types';

/**
 * The output of a triggered rule.
 * Translated directly into the final PR comment or terminal output.
 */
export interface RuleResult {
  severity: Severity;
  changeType: ChangeType;
  message: string;
}

/**
 * The generic blueprint for a Breaking Change Rule.
 * Uses TypeScript generics to ensure that Function rules only receive Function signatures,
 * Interface rules only receive Interface signatures, etc.
 */
export interface Rule<T extends AnySignature> {
  id: string;           // e.g., 'R01'
  name: string;         // e.g., 'Parameter Removed'
  description: string;  // Detailed explanation for contributors and documentation
  
  /** * Which languages this rule applies to.
   * Use 'all' if universal, or an array like ['typescript', 'java'] if specific.
   * The Engine will skip this rule entirely if the file's language isn't listed.
   */
  languages: Language[] | 'all';
  target: 'function' | 'interface' | 'enum' | 'type_alias';
  
  /**
   * The core logic of the rule.
   * @param oldSig The signature from the base branch.
   * @param newSig The signature from the feature branch.
   * @returns A single RuleResult, an array of RuleResults (if multiple violations occurred), or null if the rule passed.
   */
  check: (oldSig: T, newSig: T) => RuleResult | RuleResult[] | null;
}

// ── Strict Type Aliases for Rule Authors ──────────────────────────────────────
// Open-source contributors should use these specific types to get full IDE autocomplete
// for the correct signature properties (e.g., `oldSig.params` vs `oldSig.members`).

export type FunctionRule   = Rule<FunctionSignature>;
export type InterfaceRule  = Rule<InterfaceSignature>;
export type EnumRule       = Rule<EnumSignature>;
export type TypeAliasRule  = Rule<TypeAliasSignature>;