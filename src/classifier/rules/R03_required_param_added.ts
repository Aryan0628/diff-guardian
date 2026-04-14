/**
 * RULE 03: Required Parameter Added
 * Flags when a new parameter is added to a function signature WITHOUT 
 * a default value or an optional modifier.
 * This is a breaking change because existing callers will not be 
 * passing this newly required argument.
 */

import { FunctionRule, RuleResult } from '../types';

export const requiredParamAddedRule: FunctionRule = {
  id: 'R03',
  name: 'Required Parameter Added',
  description: 'Flags when a new required parameter is inserted into a signature.',
  languages: 'all',          // Applies universally
  target: 'function',        // Routed to the function bucket

  check(oldSig, newSig): RuleResult | null {
    // Iterate through the NEW parameters to see what was added
    for (const newParam of newSig.params) {
      
      // We only care if the parameter is strictly required
      const isRequired = !newParam.optional && !newParam.hasDefault;

      if (isRequired) {
        // Check if this parameter existed in the old signature
        const existedPreviously = oldSig.params.some(oldParam => oldParam.name === newParam.name);

        // If it is required AND it is brand new, it breaks existing callers
        if (!existedPreviously) {
          return {
            severity: 'breaking',
            changeType: 'signature_change',
            message: `A new required parameter '${newParam.name}' was added. Existing callers will fail because they do not provide this argument.`,
          };
        }
      }
    }

    // If no new required parameters were found, pass!
    return null;
  }
};