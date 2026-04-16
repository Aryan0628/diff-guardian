/**
 * src/core/utils.ts
 *
 * SHARED UTILITIES.
 * Functions used across multiple pipeline stages.
 * Extracted here to prevent duplication between git-diff.ts and the JIT scanner.
 */

import * as path from 'path';
import { SUPPORTED_EXTENSIONS, EXCLUDED_PATH_SEGMENTS, EXCLUDED_FILE_SUFFIXES } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// File filtering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines whether a file path should be analyzed by the pipeline.
 * Checks extension, excluded path segments, and excluded suffixes.
 
 * Used by:
 *  - git-diff.ts to filter changed files
 *  - scanner.ts to filter grep results
 *
 * @param filePath — repo-relative path (e.g., 'src/checkout/cart.ts')
 */
export function isTargetFile(filePath: string): boolean {
  const ext = path.extname(filePath);

  if (!SUPPORTED_EXTENSIONS.has(ext)) return false;

  if (EXCLUDED_FILE_SUFFIXES.some(s => filePath.endsWith(s))) return false;

  const segments = filePath.split(/[\\/]/);
  if (segments.some(seg => EXCLUDED_PATH_SEGMENTS.has(seg))) return false;

  return true;
}

/**
 * Returns the glob patterns for git grep --include filtering.
 * One pattern per supported extension.
 *
 * Example output: ['*.ts', '*.tsx', '*.js', '*.jsx']
 * (filtered to only TS/JS for v1 tracer)
 */
export function getSupportedGlobs(extensions?: string[]): string[] {
  if (extensions) {
    return extensions.map(ext => `*${ext}`);
  }
  return Array.from(SUPPORTED_EXTENSIONS).map(ext => `*${ext}`);
}
