/**
 * RULE 11: Sync -> Async
 * Flags when a synchronous function is converted to return a Promise 
 * (either via the `async` keyword or by explicitly returning a Promise).
 * This is a hard breaking change because callers must update their code 
 * to use `await` or `.then()`.
 */

import { FunctionRule, RuleResult } from '../types';

export const syncToAsyncRule: FunctionRule = {
  id: 'R11',
  name: 'Sync to Async',
  description: 'Flags when a synchronous function becomes asynchronous.',
  languages: 'all',
  target: 'function',

  check(oldSig, newSig): RuleResult | null {
    // Check for the explicit `async` modifier keyword
    const hadAsyncModifier = oldSig.async === true;
    const hasAsyncModifier = newSig.async === true;

    // Check if the return type explicitly wraps a Promise
    // Covers cases where a dev returns a Promise without using the `async` keyword
    const oldReturnedPromise = oldSig.returnType?.startsWith('Promise<') || oldSig.returnType === 'Promise';
    const newReturnedPromise = newSig.returnType?.startsWith('Promise<') || newSig.returnType === 'Promise';

    const wasAsync = hadAsyncModifier || oldReturnedPromise;
    const isNowAsync = hasAsyncModifier || newReturnedPromise;

    if (!wasAsync && isNowAsync) {
      return {
        severity: 'breaking',
        changeType: 'modifier_changed',
        message: `Function was converted from synchronous to asynchronous. Downstream callers will crash unless they are updated to use 'await' or '.then()'.`,
      };
    }

    return null;
  }
};