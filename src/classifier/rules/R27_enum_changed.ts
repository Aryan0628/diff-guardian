/**
 * RULE 27: Enum Member Changed
 * Flags when an enum member is removed, renamed, or has its underlying value modified.
 * This is a hard breaking change because consumers referencing the missing member 
 * will fail to compile, and value re-assignments will cause silent data corruption.
 */

import { EnumRule, RuleResult } from '../types';

export const enumChangedRule: EnumRule = {
  id: 'R27',
  name: 'Enum Member Changed',
  description: 'Flags destructive mutations to Enum members and values.',
  languages: ['typescript', 'java', 'rust'], // TS enums, Java enums, Rust ADT enums
  target: 'enum',

  check(oldSig, newSig): RuleResult | RuleResult[] | null {
    const results: RuleResult[] = [];

    // Iterate through the BASE enum to see if any existing members were destroyed or altered
    for (const oldMember of oldSig.members) {
      
      const newMember = newSig.members.find(m => m.name === oldMember.name);

      // Condition 1: Member was removed or renamed
      if (!newMember) {
        results.push({
          severity: 'breaking',
          changeType: 'enum_member_changed',
          message: `Enum member '${oldMember.name}' was removed or renamed. Downstream consumers referencing this member will fail to compile.`,
        });
        continue;
      }

      // Condition 2: Member value was re-assigned
      // Note: We only flag explicit value changes to prevent false positives if the AST 
      // relies on implicit index incrementing and a new member was inserted above it.
      if (
        oldMember.value !== undefined && 
        newMember.value !== undefined && 
        oldMember.value !== newMember.value
      ) {
        results.push({
          severity: 'breaking',
          changeType: 'enum_member_changed',
          message: `Enum member '${oldMember.name}' value changed from '${oldMember.value}' to '${newMember.value}'. This may cause severe, silent data corruption in databases or API payloads.`,
        });
      }
    }

    // Note: If an entirely new member is added (oldMember is undefined), it is a safe API expansion 
    // and requires no breaking change notification.

    return results.length > 0 ? results : null;
  }
};