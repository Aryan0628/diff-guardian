import { FunctionRule, RuleResult } from '../types';

export const genericConstraintNarrowedRule: FunctionRule = {
  id: 'R13',
  name: 'Generic Constraint Narrowed',
  description: 'Flags when a generic type parameter constraint is restricted.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    if (!oldSig.typeParameters || !newSig.typeParameters) return null;

    for (const oldTp of oldSig.typeParameters) {
      
      const newTp = newSig.typeParameters.find(tp => tp.name === oldTp.name);
      
      if (!newTp) continue; 

      const oldConstraint = normalizeType(oldTp.constraint);
      const newConstraint = normalizeType(newTp.constraint);

      if (oldConstraint === newConstraint) continue;

      if ((oldConstraint === 'any' || oldConstraint === 'unknown') && newConstraint !== 'any' && newConstraint !== 'unknown') {
        return createViolation(oldTp.name, oldTp.constraint, newTp.constraint);
      }

      if (oldConstraint.includes('|')) {
        const oldTypes = new Set(oldConstraint.split('|').map(t => t.trim()));
        const newTypes = new Set(newConstraint.split('|').map(t => t.trim()));

        if (newConstraint !== 'any' && newConstraint !== 'unknown') {
          const isMissingOldType = Array.from(oldTypes).some(t => !newTypes.has(t));
          
          if (isMissingOldType) {
            return createViolation(oldTp.name, oldTp.constraint, newTp.constraint);
          }
        }
      }
    }

    return null;
  }
};

function normalizeType(type: string | undefined): string {
  if (!type) return 'any'; 
  return type.replace(/\s+/g, ' ').trim();
}

function createViolation(paramName: string, oldC: string | undefined, newC: string | undefined): RuleResult {
  return {
    severity: 'breaking',
    changeType: 'signature_change',
    message: `Generic type parameter '${paramName}' constraint was narrowed from '${oldC || 'unconstrained'}' to '${newC}'. Callers using non-conforming types will break.`,
  };
}