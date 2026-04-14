/**
 *
 * RULE 02: Parameter Reordered
 * Flags when an existing parameter changes its index position in the signature.
 * This is a breaking change because positional arguments will be applied to
 * the wrong parameters by downstream callers.
 */

import { FunctionRule, RuleResult } from '../types';

export const parameterReorderedRule: FunctionRule = {
  id: 'R02',
  name: 'Parameter Reordered',
  description: 'Flags when a parameter changes its positional index.',
  languages: 'all',          // Applies universally to all supported languages
  target: 'function',        // Routed to the function bucket

  check(oldSig, newSig): RuleResult | null {
    // Loop through the old parameters to track their original positions
    for (let oldIndex = 0; oldIndex < oldSig.params.length; oldIndex++) {
      const oldParam = oldSig.params[oldIndex];
      
      // Find where this exact parameter lives in the new signature
      const newIndex = newSig.params.findIndex(p => p.name === oldParam.name);

      // If it doesn't exist at all, skip it. R01 (Parameter Removed) will catch it.
      if (newIndex === -1) continue;

      // If the index changed, the caller's arguments will map incorrectly.
      if (oldIndex !==        newIndex) {
        return {
          severity: 'breaking',
          changeType: 'signature_change',
          message: `Parameter '${oldParam.name}' was moved from position ${oldIndex + 1} to ${newIndex + 1}. Positional arguments will break.`,
        };
      }
    }

    // If all existing parameters maintained their exact positions, pass!
    return null;
  }
};