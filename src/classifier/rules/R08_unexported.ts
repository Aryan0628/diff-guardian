/**
 *
 * RULE 08: Exported -> Unexported (Visibility Narrowed)
 * Flags when a previously exported function is no longer exported.
 * This is a hard breaking change because the function is completely
 * removed from the public API surface, breaking all external imports.
 */

import { FunctionRule, RuleResult } from '../types';

export const unexportedRule: FunctionRule = {
  id: 'R08',
  name: 'Visibility Narrowed (Unexported)',
  description: 'Flags when a function loses its export modifier.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // If it was explicitly exported before, but is no longer exported in the new AST
    if (oldSig.exported && !newSig.exported) {
      return {
        severity: 'breaking',
        changeType: 'visibility_changed',
        message: `Function is no longer exported. Downstream consumers will fail to import this symbol.`,
      };
    }

    return null;
  }
};