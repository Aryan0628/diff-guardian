/**
 * RULE 17: Static <-> Instance Method Swap
 * Flags when a class method adds or removes the `static` modifier.
 * This is a breaking change in both directions because downstream consumers 
 * must rewrite their invocation syntax.
 */

import { FunctionRule, RuleResult } from '../types';

export const staticChangedRule: FunctionRule = {
  id: 'R17',
  name: 'Static Modifier Changed',
  description: 'Flags when a method swaps between static and instance execution.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Normalize undefined to false for safe boolean comparison
    const oldWasStatic = oldSig.isStatic === true;
    const newIsStatic = newSig.isStatic === true;

    if (oldWasStatic !== newIsStatic) {
      const direction = newIsStatic ? 'instance to static' : 'static to instance';
      
      return {
        severity: 'breaking',
        changeType: 'modifier_changed',
        message: `Method execution context changed from ${direction}. Downstream callers will fail due to invalid invocation syntax.`,
      };
    }

    return null;
  }
};