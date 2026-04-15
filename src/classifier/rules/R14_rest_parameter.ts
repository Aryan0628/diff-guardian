/**
 * RULE 14: Rest Parameter Changed
 * Evaluates the addition or removal of a rest/variadic parameter (e.g., `...args`).
 * - Removing a rest parameter is BREAKING because callers passing extra args will fail.
 * - Adding a rest parameter is SAFE because existing callers remain valid.
 */

import { FunctionRule, RuleResult } from '../types';

export const restParameterRule: FunctionRule = {
  id: 'R14',
  name: 'Rest Parameter Changed',
  description: 'Flags the addition (safe) or removal (breaking) of a rest parameter.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    // Find the rest parameter in both signatures (it is always the last parameter if it exists)
    const oldRest = oldSig.params.find(p => p.isRest);
    const newRest = newSig.params.find(p => p.isRest);

    // Condition 1: Rest parameter was removed
    if (oldRest && !newRest) {
      results.push({
        severity: 'breaking',
        changeType: 'signature_change',
        message: `Rest parameter '${oldRest.name}' was removed. Callers providing variadic arguments will encounter compilation errors.`,
      });
    }

    // Condition 2: Rest parameter was added
    if (!oldRest && newRest) {
      results.push({
        severity: 'safe',
        changeType: 'signature_change',
        message: `Safe change: Rest parameter '${newRest.name}' was added. Existing callers will not be affected.`,
      });
    }

    // Note: If both exist, any type changes to the rest parameter array 
    // (e.g., `...args: string[]` -> `...args: number[]`) are inherently handled 
    // by R04 (Type Narrowed) and R12 (Type Widened)!

    return results.length > 0 ? results : null;
  }
};