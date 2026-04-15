/**
 * RULE 20: Class Method Visibility Narrowed
 * Flags when a class method's access modifier becomes more restrictive 
 * (e.g., `public` -> `protected`, or `protected` -> `private`).
 * This is a breaking change because external consumers or inheriting 
 * subclasses will lose access to the method.
 */

import { FunctionRule, RuleResult } from '../types';

/**
 * Assigns a strict numeric hierarchy to access modifiers.
 * Higher number = more restrictive.
 * If undefined, the default in most OOP languages (TS/Java) is public.
 */
function getVisibilityWeight(modifier?: 'public' | 'protected' | 'private'): number {
  if (modifier === 'private') return 3;
  if (modifier === 'protected') return 2;
  return 1; // Default is public
}

export const visibilityNarrowedRule: FunctionRule = {
  id: 'R20',
  name: 'Visibility Narrowed',
  description: 'Flags when a class method access modifier becomes more restrictive.',
  languages: 'all', 
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // 1. Short-circuit: We only care about methods attached to a class
    if (!oldSig.className || !newSig.className) return null;

    const oldWeight = getVisibilityWeight(oldSig.accessModifier);
    const newWeight = getVisibilityWeight(newSig.accessModifier);

    // 2. If the new weight is higher, the visibility was narrowed
    if (newWeight > oldWeight) {
      const oldMod = oldSig.accessModifier || 'public';
      const newMod = newSig.accessModifier || 'public'; // Will never actually be public here, but satisfies TS

      // Differentiate the message based on who is broken
      const impact = oldMod === 'public' && newMod === 'protected'
        ? 'External class instances can no longer access this method.'
        : 'Inheriting subclasses can no longer access this method.';

      return {
        severity: 'breaking',
        changeType: 'visibility_changed',
        message: `Method visibility narrowed from '${oldMod}' to '${newMod}'. ${impact}`,
      };
    }

    return null;
  }
};