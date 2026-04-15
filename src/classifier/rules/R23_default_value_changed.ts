/**
 * RULE 23: Default Parameter Value Changed
 * Flags when the default assignment of a parameter is modified 
 * (e.g., `retries = 3` -> `retries = 1`).
 * This does not break compilation, but it introduces a silent behavioral 
 * shift at runtime for any caller omitting that argument.
 */

import { FunctionRule, RuleResult } from '../types';

export const defaultValueChangedRule: FunctionRule = {
  id: 'R23',
  name: 'Default Parameter Value Changed',
  description: 'Flags when a parameter default value is modified.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    for (const oldParam of oldSig.params) {
      const newParam = newSig.params.find(p => p.name === oldParam.name);
      if (!newParam) continue; // Deletions handled by R01

      const oldDefault = oldParam.defaultValue;
      const newDefault = newParam.defaultValue;

      // We specifically look for mutations where both signatures provide a default, 
      // but the underlying value has changed.
      if (oldDefault !== undefined && newDefault !== undefined && oldDefault !== newDefault) {
        results.push({
          severity: 'warning',
          changeType: 'signature_change',
          message: `Warning: Default value for parameter '${oldParam.name}' changed from '${oldDefault}' to '${newDefault}'. This may cause silent behavioral shifts at runtime.`,
        });
      }
    }

    return results.length > 0 ? results : null;
  }
};