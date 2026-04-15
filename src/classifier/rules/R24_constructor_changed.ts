/**
 * RULE 24: Constructor Signature Changed
 * Flags breaking parameter mutations specifically on class constructors.
 * This ensures developers receive targeted feedback regarding `new ClassName()` 
 * instantiation failures.
 */

import { FunctionRule, RuleResult } from '../types';

export const constructorChangedRule: FunctionRule = {
  id: 'R24',
  name: 'Constructor Signature Changed',
  description: 'Flags incompatible structural changes to class constructors.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Short-circuit: We only care if this function is a class constructor
    if (!oldSig.isConstructor && !newSig.isConstructor) return null;

    // Calculate required parameter counts
    const oldRequiredCount = oldSig.params.filter(p => !p.optional && !p.hasDefault).length;
    const newRequiredCount = newSig.params.filter(p => !p.optional && !p.hasDefault).length;

    // Heuristic 1: A parameter was completely removed
    const paramRemoved = oldSig.params.some(
      oldP => !newSig.params.find(newP => newP.name === oldP.name)
    );

    // Heuristic 2: A strictly required parameter was added
    const requiredAdded = newRequiredCount > oldRequiredCount;

    if (paramRemoved || requiredAdded) {
      const className = oldSig.className || newSig.className || 'Class';
      
      return {
        severity: 'breaking',
        changeType: 'signature_change',
        message: `Constructor signature for '${className}' changed incompatibly. Downstream consumers calling 'new ${className}()' will encounter compilation errors.`,
      };
    }

    return null;
  }
};