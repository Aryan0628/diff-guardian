/**
 * RULE 15: Function Overload Removed
 * Flags when the number of overload signatures for a function decreases.
 * This is a breaking change because callers relying on the removed overload's
 * specific parameter/return type combination will fail to compile.
 *
 * Uses the `overloadCount` field (Approach B) — the translator stamps the
 * total count of overloads for each function. When old.overloadCount > new.overloadCount,
 * at least one overload was removed.
 */

import { FunctionRule, RuleResult } from '../types';

export const overloadRemovedRule: FunctionRule = {
  id: 'R15',
  name: 'Function Overload Removed',
  description: 'Flags when a function loses one or more overload signatures.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Only relevant when the old signature was overloaded
    const oldCount = oldSig.overloadCount ?? 1;
    const newCount = newSig.overloadCount ?? 1;

    // If overloads decreased, at least one overload was removed
    if (oldCount > newCount) {
      const removed = oldCount - newCount;

      return {
        severity: 'breaking',
        changeType: 'overload_changed',
        message: `${removed} function overload${removed > 1 ? 's were' : ' was'} removed (${oldCount} → ${newCount}). Callers using the removed overload signature will fail to compile.`,
      };
    }

    return null;
  }
};
