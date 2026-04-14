/**
 *
 * RULE 07: Return Type Narrowed
 * Logs when a return type is strictly narrowed (e.g., `string | null` -> `string`).
 * This is a SAFE change because existing callers handling the broader type 
 * (like doing null-checks) will still function perfectly.
 */

import { FunctionRule, RuleResult } from '../types';

export const returnNarrowedRule: FunctionRule = {
  id: 'R07',
  name: 'Return Type Narrowed',
  description: 'Logs when a return type is safely narrowed, removing possibilities like null.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    const oldReturn = oldSig.returnType;
    const newReturn = newSig.returnType;

    // 1. Short-circuit if types are identical
    if (oldReturn === newReturn) return null;

    // 2. If we lack explicit type data, we cannot prove narrowing
    if (oldReturn === 'inferred' || oldReturn === 'any' || newReturn === 'inferred') return null;

    // 3. Parse the unions
    const oldTypes = new Set(oldReturn.split('|').map(t => t.trim()));
    const newTypes = new Set(newReturn.split('|').map(t => t.trim()));

    // 4. Check if the new return type is a strict subset of the old return type
    // Meaning: It has fewer types, and every type it DOES have was in the old signature.
    const isSubset = Array.from(newTypes).every(t => oldTypes.has(t));
    const isNarrowed = isSubset && newTypes.size < oldTypes.size;

    if (isNarrowed) {
      // Find exactly what was removed so we can log it clearly
      const removedTypes = Array.from(oldTypes).filter(t => !newTypes.has(t));

      return {
        severity: 'safe',
        changeType: 'return_type_narrowed', // From your matrix!
        message: `Safe change: Return type was narrowed. Callers no longer need to handle '${removedTypes.join(' or ')}'.`,
      };
    }

    return null;
  }
};