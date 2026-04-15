/**
 * RULE 19: Parameter Mutability Widened
 * Logs when a parameter gains a readonly guarantee 
 * (e.g., `string[]` -> `readonly string[]`, or `T` -> `Readonly<T>`).
 * This is a SAFE change because callers passing mutable data structures 
 * will automatically satisfy the new read-only constraint.
 */

import { FunctionRule, RuleResult } from '../types';

export const paramMutabilityWidenedRule: FunctionRule = {
  id: 'R19',
  name: 'Parameter Mutability Widened',
  description: 'Logs when a parameter safely gains a readonly constraint.',
  languages: ['typescript', 'rust'], // TS: T[] → readonly T[]; Rust: &T → &mut T
  target: 'function',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    for (const oldParam of oldSig.params) {
      const newParam = newSig.params.find(p => p.name === oldParam.name);
      if (!newParam) continue; 

      const oldType = oldParam.type || 'any';
      const newType = newParam.type || 'any';

      if (oldType === newType) continue;

      const oldIsReadonly = isReadonly(oldType);
      const newIsReadonly = isReadonly(newType);

      // If it was mutable before, and is now explicitly readonly
      if (!oldIsReadonly && newIsReadonly) {
        results.push({
          severity: 'safe',
          changeType: 'signature_change',
          message: `Safe change: Parameter '${oldParam.name}' gained a readonly guarantee (changed from '${oldType}' to '${newType}'). Existing callers are unaffected.`,
        });
      }
    }

    return results.length > 0 ? results : null;
  }
};

/**
 * Detects common TypeScript and Rust immutability patterns in type strings.
 */
function isReadonly(typeString: string): boolean {
  // Rust: '&T' is readonly, '&mut T' is mutable.
  if (typeString.startsWith('&') && !typeString.startsWith('&mut ')) {
    return true;
  }

  return (
    typeString.startsWith('readonly ') || 
    typeString.includes('Readonly<') || 
    typeString.includes('ReadonlyArray<')
  );
}