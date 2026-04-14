/**
 * RULE 04: Parameter Type Narrowed
 * Flags when a parameter's type is restricted (e.g., `any` -> `string`,
 * or `string | number` -> `string`).
 * This is a breaking change because callers passing the previously allowed
 * types will now face compilation errors.
 */

import { FunctionRule, RuleResult } from '../types';

export const paramTypeNarrowedRule: FunctionRule = {
  id: 'R04',
  name: 'Parameter Type Narrowed',
  description: 'Flags when a parameter type is narrowed to accept fewer types.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    for (const oldParam of oldSig.params) {
      
      const newParam = newSig.params.find(p => p.name === oldParam.name);
      
      // If it doesn't exist, skip it. R01 (Parameter Removed) will catch it.
      if (!newParam) continue; 

      const oldType = normalizeType(oldParam.type);
      const newType = normalizeType(newParam.type);

      // If types are identical after normalization, no change
      if (oldType === newType) continue;

      // Condition 1: 'any' or 'unknown' replaced by a strict concrete type
      if ((oldType === 'any' || oldType === 'unknown') && newType !== 'any' && newType !== 'unknown') {
        return createViolation(oldParam.name, oldParam.type, newParam.type);
      }

      // Condition 2: Union type narrowed (e.g., 'string | number' -> 'string')
      if (oldType.includes('|')) {
        const oldTypes = new Set(oldType.split('|').map(t => t.trim()));
        const newTypes = new Set(newType.split('|').map(t => t.trim()));

        // If the new type is 'any', that is widening (safe), not narrowing
        if (newType !== 'any' && newType !== 'unknown') {
          // Check if any allowable type from the old union is missing in the new type
          const isMissingOldType = Array.from(oldTypes).some(t => !newTypes.has(t));
          
          if (isMissingOldType) {
            return createViolation(oldParam.name, oldParam.type, newParam.type);
          }
        }
      }
    }

    return null;
  }
};

/**
 * Normalizes spacing so 'string|number' matches 'string | number'
 */
function normalizeType(type: string | undefined): string {
  if (!type) return 'any'; // TypeScript implicitly defaults un-annotated params to 'any'
  return type.replace(/\s+/g, ' ').trim();
}

function createViolation(paramName: string, oldT: string | undefined, newT: string | undefined): RuleResult {
  return {
    severity: 'breaking',
    changeType: 'signature_change',
    message: `Parameter '${paramName}' type was narrowed from '${oldT || 'any'}' to '${newT}'. Callers passing previously allowed types will break.`,
  };
}