/**
 * RULE 25: Interface Property Made Required / Added
 * Flags when an interface demands a new required field, either by adding 
 * a completely new required property or by dropping the `?` optional 
 * modifier from an existing property.
 * This is a breaking change because downstream object literals will fail 
 * to satisfy the new interface constraints.
 */

import { InterfaceRule, RuleResult } from '../types';

export const interfacePropertyRequiredRule: InterfaceRule = {
  id: 'R25',
  name: 'Interface Property Made Required',
  description: 'Flags when a required property is added to an interface or an optional property becomes required.',
  languages: ['typescript', 'java', 'go', 'rust'], // TS interfaces, Java interfaces, Go interfaces/structs, Rust traits
  target: 'interface',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    // Note: Assuming your InterfaceSignature has a `properties` array based on the types you shared earlier
    for (const newProp of newSig.properties) {
      
      // We only care about properties that are strictly required in the new signature
      if (newProp.optional) continue;

      const oldProp = oldSig.properties.find(p => p.name === newProp.name);

      // Condition 1: A completely new required property was added
      if (!oldProp) {
        results.push({
          severity: 'breaking',
          changeType: 'interface_property_added', // From your custom ChangeType union!
          message: `A new required property '${newProp.name}' was added to the interface. Consumers instantiating this interface must update their objects.`,
        });
      } 
      // Condition 2: An existing optional property was made required
      else if (oldProp.optional) {
        results.push({
          severity: 'breaking',
          changeType: 'interface_property_added',
          message: `Property '${newProp.name}' was made required (previously optional). Consumers missing this field will encounter compilation errors.`,
        });
      }
    }

    return results.length > 0 ? results : null;
  }
};