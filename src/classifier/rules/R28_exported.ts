/**
 * RULE 28: Unexported -> Exported (Visibility Widened)
 * Flags when a previously internal symbol is exposed to the public API.
 * This is a safe change from a compilation standpoint, but it is flagged as a 
 * warning because expanding the public API surface increases the maintenance burden.
 */

import { FunctionRule, RuleResult } from '../types';

export const exportedRule: FunctionRule = {
  id: 'R28',
  name: 'Visibility Widened (Exported)',
  description: 'Flags when a previously internal function becomes exported.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Safely cast undefined to false for explicit boolean evaluation
    const oldWasExported = oldSig.exported === true;
    const newIsExported = newSig.exported === true;

    // If it was internal before, but is now publicly exported
    if (!oldWasExported && newIsExported) {
      return {
        severity: 'warning',
        changeType: 'visibility_changed',
        message: `Warning: Function is now exported. This expands the public API surface area and introduces a new backward-compatibility contract.`,
      };
    }

    return null;
  }
};