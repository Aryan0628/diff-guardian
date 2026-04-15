/**
 * RULE 18: Parameter Mutability Narrowed
 * Flags when a parameter loses its readonly guarantee 
 * (e.g., `readonly string[]` -> `string[]`, or `Readonly<T>` -> `T`).
 * This is a breaking change because downstream consumers passing frozen 
 * or readonly data structures will fail to compile.
 */

import { FunctionRule, RuleResult } from '../types';

export const paramMutabilityNarrowedRule: FunctionRule = {
  id: 'R18',
  name: 'Parameter Mutability Narrowed',
  description: 'Flags when a parameter loses its readonly constraint.',
  languages: ['typescript', 'rust'], // TS: readonly T[] → T[]; Rust: &mut T → &T
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    for (const oldParam of oldSig.params) {
      const newParam = newSig.params.find(p => p.name === oldParam.name);
      if (!newParam) continue; // R01 handles deletions

      const oldType = oldParam.type || 'any';
      const newType = newParam.type || 'any';

      if (oldType === newType) continue;

      // Heuristic to detect TypeScript readonly modifiers and utility types
      const oldIsReadonly = isReadonly(oldType);
      const newIsReadonly = isReadonly(newType);

      if (oldIsReadonly && !newIsReadonly) {
        return {
          severity: 'breaking',
          changeType: 'signature_change',
          message: `Parameter '${oldParam.name}' lost its readonly guarantee (changed from '${oldType}' to '${newType}'). Callers passing readonly data will fail to compile.`,
        };
      }
    }

    return null;
  }
};

/**
 * Detects common TypeScript immutability patterns in type strings.
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