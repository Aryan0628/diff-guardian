/**
 * RULE 05: Optional Parameter Added
 * Flags when a new parameter is added to a function signature, but it is 
 * safely marked as optional or provided with a default value.
 * This is a SAFE change because existing callers do not need to update their code.
 */

import { FunctionRule, RuleResult } from '../types';

export const optionalParamAddedRule: FunctionRule = {
  id: 'R05',
  name: 'Optional Parameter Added',
  description: 'Logs when a new optional parameter is safely added to a signature.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    // Iterate through the NEW parameters to see what was added
    for (const newParam of newSig.params) {
      
      // We only care if the parameter is safe (optional or has default)
      const isOptional = newParam.optional || newParam.hasDefault;

      if (isOptional) {
        // Check if this parameter existed in the old signature
        const existedPreviously = oldSig.params.some(oldParam => oldParam.name === newParam.name);

        // If it is new and optional, it's a safe addition
        if (!existedPreviously) {
          results.push({
            severity: 'safe',
            changeType: 'signature_change',
            message: `Safe addition: Optional parameter '${newParam.name}' was added. Existing callers will not be affected.`,
          });
        }
      }
    }

    // Return the array of results if we found any, otherwise null
    return results.length > 0 ? results : null;
  }
};