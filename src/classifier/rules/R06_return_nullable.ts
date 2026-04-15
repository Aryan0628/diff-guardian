/**
 * RULE 06: Return Type Gained Null/Undefined
 * Flags when a function's return type is widened to include `null` or `undefined`.
 * This is a highly dangerous breaking change because existing callers will try to 
 * access properties on the returned object without doing null-checks.
 */

import { FunctionRule, RuleResult } from '../types';

export const returnNullableRule: FunctionRule = {
  id: 'R06',
  name: 'Return Type Gained Null/Undefined',
  description: 'Flags when a return type introduces null or undefined.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    const oldReturn = oldSig.returnType;
    const newReturn = newSig.returnType;

    // 1. Short-circuit if types are identical
    if (oldReturn === newReturn) return null;

    // 2. If the parser couldn't infer the old type, we can't safely prove it broke
    if (oldReturn === 'inferred' || oldReturn === 'any') return null;

    // 3. Parse the unions (e.g., 'string | null' -> ['string', 'null'])
    const oldTypes = new Set(oldReturn.split('|').map(t => t.trim()));
    const newTypes = new Set(newReturn.split('|').map(t => t.trim()));

    // 4. Check if the danger keywords were added
    const gainedNull = !oldTypes.has('null') && newTypes.has('null');
    const gainedUndefined = !oldTypes.has('undefined') && newTypes.has('undefined');

    if (gainedNull || gainedUndefined) {
      const addedTerm = gainedNull && gainedUndefined ? 'null and undefined' : gainedNull ? 'null' : 'undefined';
      
      return {
        severity: 'breaking',
        changeType: 'return_type_widened',
        message: `Return type widened to include '${addedTerm}'. Callers lacking null-checks will crash at runtime.`,
      };
    }

    return null;
  }
};