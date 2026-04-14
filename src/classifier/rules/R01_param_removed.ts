/**
 *
 * RULE 01: Parameter Removed
 * Flags when a parameter (required or optional) is entirely removed 
 * from a function's signature.
 */

import { FunctionRule, RuleResult } from '../types';

export const parameterRemovedRule: FunctionRule = {
  id: 'R01',
  name: 'Parameter Removed',
  description: 'Flags when a parameter is removed from a function signature.',
  languages: 'all',          // Applies to TS, Python, Go, Java, Rust
  target: 'function',        // The Engine puts this in the Function bucket

  check(oldSig, newSig): RuleResult | null {
    // 1. Loop through the old parameters
    for (const oldParam of oldSig.params) {
      
      // 2. Check if this parameter still exists in the new signature
      const stillExists = newSig.params.some(newParam => newParam.name === oldParam.name);
      
      // 3. If it's gone, that's a breaking change!
      if (!stillExists) {
        return {
          severity: 'breaking',
          changeType: 'signature_change',
          message: `Parameter '${oldParam.name}' was removed. Callers providing this argument will fail.`,
        };
      }
    }

    // 4. If we checked everything and found no missing params, pass!
    return null;
  }
};