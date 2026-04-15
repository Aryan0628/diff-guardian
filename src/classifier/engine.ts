import { ParseResult, FunctionChange, AnySignature, Language, ChangeType, Severity } from '../core/types';
import { Rule, RuleResult, FunctionRule, InterfaceRule, EnumRule, TypeAliasRule } from './types';
import * as rules from './rules/index';
import { isDeepStrictEqual } from 'util';

export class ClassifierEngine {
  compare(diff: ParseResult): FunctionChange[] {
    const changes: FunctionChange[] = [];
    const { oldSigs, newSigs, file, language } = diff;

    // PERFORMANCE FIX: Pre-compute and bucket the rules ONCE per file.
    const allRules = Object.values(rules) as Rule<any>[];
    const activeRules = allRules.filter(r => r.languages === 'all' || r.languages.includes(language));
    
    const ruleBuckets = {
      function: activeRules.filter((r): r is FunctionRule => r.target === 'function'),
      interface: activeRules.filter((r): r is InterfaceRule => r.target === 'interface'),
      enum: activeRules.filter((r): r is EnumRule => r.target === 'enum'),
      type_alias: activeRules.filter((r): r is TypeAliasRule => r.target === 'type_alias'),
    };

    const allKeys = new Set([...oldSigs.keys(), ...newSigs.keys()]);

    for (const key of allKeys) {
      const oldSig = oldSigs.get(key);
      const newSig = newSigs.get(key);
      // Case A: Deletions (R09: Symbol Deleted)
      if (oldSig && !newSig) {
        changes.push(this.createChangeRecord(
          key, file, language, 
          'breaking', 
          'symbol_deleted', 
          `Symbol was removed from public API.`, 
          oldSig
        ));
        continue;
      }
      // Case B: Additions (R10: Symbol Added)
      if (!oldSig && newSig) {
        changes.push(this.createChangeRecord(
          key, file, language, 
          'safe', 
          'symbol_added', 
          `New symbol added.`, 
          undefined, newSig
        ));
        continue;
      }
      if (oldSig && newSig) {
        // Deep Equality Short-Circuit
        if (isDeepStrictEqual(oldSig, newSig)) continue;

        // O(1) Routing & Rule Execution using pre-computed buckets
        const violations = this.runRules(key, oldSig, newSig, ruleBuckets);
        
        for (const v of violations) {
          changes.push(this.createChangeRecord(key, file, language, v.severity, v.changeType, v.message, oldSig, newSig));
        }
      }
    }

    // Sort deterministically: Line Number ascending
    return changes.sort((a, b) => a.lineStart - b.lineStart);
  }

  private runRules(
    key: string, 
    oldSig: AnySignature, 
    newSig: AnySignature, 
    buckets: Record<string, Rule<any>[]>
  ): RuleResult[] {
    const results: RuleResult[] = [];
    let rulesToRun: Rule<any>[] = [];

    // CRITICAL FIX: Safe, bucketed routing without blind type casting
    if (key.startsWith('interface:')) {
      rulesToRun = buckets.interface;
    } else if (key.startsWith('enum:')) {
      rulesToRun = buckets.enum;
    } else if (key.startsWith('type:')) {
      rulesToRun = buckets.type_alias;
    } else {
      rulesToRun = buckets.function;
    }

    for (const rule of rulesToRun) {
      const triggered = rule.check(oldSig, newSig);
      if (triggered) {
        if (Array.isArray(triggered)) results.push(...triggered);
        else results.push(triggered);
      }
    }

    return results;
  }

  private createChangeRecord(
    key: string, 
    file: string, 
    language: Language,
    severity: Severity, 
    type: ChangeType, 
    msg: string, 
    oldSig?: AnySignature, 
    newSig?: AnySignature
  ): FunctionChange {
    const activeSig = newSig || oldSig;
    let symbolType: 'function' | 'interface' | 'enum' | 'type_alias' = 'function';
    if (key.startsWith('interface:')) symbolType = 'interface';
    else if (key.startsWith('enum:')) symbolType = 'enum';
    else if (key.startsWith('type:')) symbolType = 'type_alias';

    return {
      id: `${file}:${key}:${activeSig?.line || 0}`,
      name: key.split(':').pop() || key,
      file,
      lineStart: activeSig?.line || 0,
      lineEnd: activeSig?.line || 0,
      language,
      symbolType,
      severity,
      changeType: type,
      breaking: severity === 'breaking',
      message: msg,
      before: oldSig ?? null,
      after: newSig ?? null,
      callers: []
    };
  }
}