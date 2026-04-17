/**
 * src/tracer/languages/index.ts
 *
 * LANGUAGE STRATEGY REGISTRY.
 *
 * Maps file extensions to their LanguageStrategy implementations.
 * The scanner and tracer use this to resolve the correct strategy
 * for any file they encounter.
 *
 * All 5 supported languages are registered:
 *   - TypeScript / JavaScript (shared strategy)
 *   - Python
 *   - Java
 *   - Go
 *   - Rust
 *
 * @module LanguageRegistry
 */

import type { Language } from '../../core/types';
import type { LanguageStrategy } from './types';
import { typescriptStrategy } from './typescript';
import { pythonStrategy } from './python';
import { javaStrategy } from './java';
import { goStrategy } from './go';
import { rustStrategy } from './rust';

// Re-export types for convenience
export type { LanguageStrategy, ImportPattern, RawCallSite, RawEnumAccess } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Strategy registry — one entry per supported language
// ─────────────────────────────────────────────────────────────────────────────

/** All registered language strategies, keyed by Language ID. */
const strategyRegistry = new Map<Language, LanguageStrategy>([
  ['typescript',  typescriptStrategy],
  ['javascript',  typescriptStrategy],  // JS uses the same strategy as TS
  ['python',      pythonStrategy],
  ['java',        javaStrategy],
  ['go',          goStrategy],
  ['rust',        rustStrategy],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Extension → strategy lookup
// ─────────────────────────────────────────────────────────────────────────────

/** Maps every supported file extension to its strategy. */
const extensionMap = new Map<string, LanguageStrategy>();

// Build the extension map from all registered strategies
for (const strategy of strategyRegistry.values()) {
  for (const ext of strategy.extensions) {
    extensionMap.set(ext, strategy);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the LanguageStrategy for a given file path.
 * Resolves based on file extension.
 *
 * @returns the strategy, or undefined if unsupported
 */
export function getStrategyForFile(filePath: string): LanguageStrategy | undefined {
  const ext = filePath.match(/\.[^.]+$/)?.[0] || '';
  return extensionMap.get(ext);
}

/**
 * Returns the LanguageStrategy for a given Language ID.
 */
export function getStrategyForLanguage(language: Language): LanguageStrategy | undefined {
  return strategyRegistry.get(language);
}

/**
 * Returns all registered strategies (deduplicated).
 * Used by the scanner to build the combined grep glob list.
 */
export function getAllStrategies(): LanguageStrategy[] {
  // Deduplicate since TS and JS share the same strategy instance
  return [...new Set(strategyRegistry.values())];
}

/**
 * Returns the merged grep glob patterns for a set of languages.
 * Used by the scanner to restrict git grep to relevant file types.
 *
 * If no languages are specified, returns globs for ALL registered strategies.
 */
export function getGrepGlobs(languages?: Language[]): string[] {
  if (!languages || languages.length === 0) {
    const allGlobs = new Set<string>();
    for (const strategy of getAllStrategies()) {
      for (const glob of strategy.grepGlobs) {
        allGlobs.add(glob);
      }
    }
    return [...allGlobs];
  }

  const globs = new Set<string>();
  for (const lang of languages) {
    const strategy = strategyRegistry.get(lang);
    if (strategy) {
      for (const glob of strategy.grepGlobs) {
        globs.add(glob);
      }
    }
  }
  return [...globs];
}

/**
 * Returns all Language IDs that have registered strategies.
 */
export function getSupportedTracerLanguages(): Language[] {
  return [...new Set(strategyRegistry.keys())];
}
