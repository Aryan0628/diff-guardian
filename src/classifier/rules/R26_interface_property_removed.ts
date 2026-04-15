/**
 * RULE 26: Interface Property Removed Entirely
 * Flags when a property (required or optional) is completely deleted 
 * from an interface definition.
 * This is a breaking change because consumers relying on the existence 
 * of this property will experience compilation errors or runtime `undefined` values.
 */

import { InterfaceRule, RuleResult } from '../types';

export const interfacePropertyRemovedRule: InterfaceRule = {
  id: 'R26',
  name: 'Interface Property Removed',
  description: 'Flags when a property is completely deleted from an interface.',
  languages: ['typescript', 'java', 'go', 'rust'], // TS interfaces, Java interfaces, Go interfaces/structs, Rust traits
  target: 'interface',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    // Iterate through the BASE signature to see what went missing
    for (const oldProp of oldSig.properties) {
      
      const newProp = newSig.properties.find(p => p.name === oldProp.name);

      // If the property is completely absent in the new signature
      if (!newProp) {
        // We include whether it was optional or required in the message for better context
        const strictness = oldProp.optional ? 'optional' : 'required';

        results.push({
          severity: 'breaking',
          changeType: 'interface_property_removed',
          message: `The ${strictness} property '${oldProp.name}' was removed from the interface. Callers attempting to access this property will fail to compile.`,
        });
      }
    }

    return results.length > 0 ? results : null;
  }
};