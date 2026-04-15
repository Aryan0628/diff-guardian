/**
 * RULE 22: Return Type Becomes Never
 * Flags when a function's return type is explicitly changed to `never`.
 * This is a breaking change because it indicates the function now unconditionally 
 * throws an error, halts execution, or loops infinitely. Any downstream code 
 * executing after this call will become unreachable.
 */

import { FunctionRule, RuleResult } from '../types';

export const returnNeverRule: FunctionRule = {
  id: 'R22',
  name: 'Return Type Becomes Never',
  description: 'Flags when a return type transitions to the terminal never type.',
  languages: ['typescript', 'rust'], // TS: 'never'; Rust: '!' (diverging function)
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    const oldReturn = oldSig.returnType;
    const newReturn = newSig.returnType;

    // Short-circuit if identical
    if (oldReturn === newReturn) return null;

    // If it becomes never, execution halts.
    // Note: We flag this even if oldReturn was 'inferred', because transitioning 
    // to 'never' is universally destructive to downstream execution flow.
    if (newReturn === 'never' || newReturn === '!') {
      return {
        severity: 'breaking',
        changeType: 'return_type_narrowed',
        message: `Return type transitioned to 'never'. This function now unconditionally throws or halts. Downstream execution flow will break.`,
      };
    }

    return null;
  }
};