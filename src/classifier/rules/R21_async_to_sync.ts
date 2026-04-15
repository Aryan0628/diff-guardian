/**
 * RULE 21: Async -> Sync
 * Flags when an asynchronous function is converted to synchronous execution
 * (e.g., removing the `async` keyword and returning a raw value instead of a Promise).
 * This is a breaking change because callers utilizing Promise chaining (`.then()`, `.catch()`)
 * will crash at runtime.
 */

import { FunctionRule, RuleResult } from '../types';

export const asyncToSyncRule: FunctionRule = {
  id: 'R21',
  name: 'Async to Sync',
  description: 'Flags when an asynchronous function becomes synchronous.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Check for the explicit `async` modifier keyword
    const hadAsyncModifier = oldSig.async === true;
    const hasAsyncModifier = newSig.async === true;

    // Check if the return type explicitly wraps a Promise
    const oldReturnedPromise = oldSig.returnType?.startsWith('Promise<') || oldSig.returnType === 'Promise';
    const newReturnedPromise = newSig.returnType?.startsWith('Promise<') || newSig.returnType === 'Promise';

    const wasAsync = hadAsyncModifier || oldReturnedPromise;
    const isNowAsync = hasAsyncModifier || newReturnedPromise;

    if (wasAsync && !isNowAsync) {
      return {
        severity: 'breaking',
        changeType: 'modifier_changed',
        message: `Function was converted from asynchronous to synchronous. Downstream callers utilizing Promise chaining (.then, .catch) will experience runtime crashes.`,
      };
    }

    return null;
  }
};