/**
 *
 * RULE 12: Parameter Type Widened
 * Logs when a parameter's type is broadened to accept more types 
 * (e.g., `string` -> `string | number`, or `string` -> `any`).
 * This is a SAFE change because existing callers passing the previously 
 * strict types will still perfectly satisfy the new signature.
 */

import { FunctionRule, RuleResult } from '../types';

export const paramTypeWidenedRule: FunctionRule = {
  id: 'R12',
  name: 'Parameter Type Widened',
  description: 'Logs when a parameter safely expands its allowed types.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    for (const oldParam of oldSig.params) {
      
      const newParam = newSig.params.find(p => p.name === oldParam.name);
      
      // If it doesn't exist, skip it. R01 (Parameter Removed) handles deletions.
      if (!newParam) continue; 

      const oldType = normalizeType(oldParam.type);
      const newType = normalizeType(newParam.type);

      // If types are identical after normalization, no change
      if (oldType === newType) continue;

      // If the old type was already 'any' or 'unknown', it cannot be widened further mathematically
      if (oldType === 'any' || oldType === 'unknown') continue;

      // Condition 1: Concrete type expanded to a universal type ('any' or 'unknown')
      if (newType === 'any' || newType === 'unknown') {
        results.push(createSafeViolation(oldParam.name, oldParam.type, newParam.type));
        continue;
      }

      // Condition 2: Union type widened (e.g., 'string' -> 'string | number')
      const oldTypes = new Set(oldType.split('|').map(t => t.trim()));
      const newTypes = new Set(newType.split('|').map(t => t.trim()));

      // Verify that EVERY type the caller used to pass is still perfectly valid in the new signature
      const isSuperset = Array.from(oldTypes).every(t => newTypes.has(t));
      const isWidened = isSuperset && newTypes.size > oldTypes.size;
      
      if (isWidened) {
        results.push(createSafeViolation(oldParam.name, oldParam.type, newParam.type));
      }
    }

    return results.length > 0 ? results : null;
  }
};

/**
 * Normalizes spacing so 'string|number' matches 'string | number'
 */
function normalizeType(type: string | undefined): string {
  if (!type) return 'any'; 
  return type.replace(/\s+/g, ' ').trim();
}

function createSafeViolation(paramName: string, oldT: string | undefined, newT: string | undefined): RuleResult {
  return {
    severity: 'safe',
    changeType: 'signature_change',
    message: `Safe change: Parameter '${paramName}' type was widened from '${oldT || 'any'}' to '${newT}'. Existing callers will not be affected.`,
  };
}