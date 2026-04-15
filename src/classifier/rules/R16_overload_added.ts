/**
 * RULE 16: Function Overload Added
 * Logs when the number of overload signatures for a function increases.
 * This is a SAFE change because existing callers continue to match one of
 * the existing overloads — the new overload expands the API surface without
 * breaking any existing call sites.
 *
 * Uses the `overloadCount` field (Approach B) — the translator stamps the
 * total count of overloads for each function. When new.overloadCount > old.overloadCount,
 * at least one overload was added.
 */

import { FunctionRule, RuleResult } from '../types';

export const overloadAddedRule: FunctionRule = {
  id: 'R16',
  name: 'Function Overload Added',
  description: 'Logs when a function gains one or more overload signatures.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Only relevant when the new signature has more overloads
    const oldCount = oldSig.overloadCount ?? 1;
    const newCount = newSig.overloadCount ?? 1;

    // If overloads increased, at least one overload was added
    if (newCount > oldCount) {
      const added = newCount - oldCount;

      return {
        severity: 'safe',
        changeType: 'overload_changed',
        message: `Safe change: ${added} function overload${added > 1 ? 's were' : ' was'} added (${oldCount} → ${newCount}). Existing callers are unaffected.`,
      };
    }

    return null;
  }
};
