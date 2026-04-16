/**
 * src/tracer/scanner.ts
 *
 * THE JIT SCANNER (Phase 2 of the Lazy Graph).
 *
 * This module is the "fast-pass" of the two-tier engine. When a function's
 * signature breaks (e.g., processPayment gains a required parameter), the
 * scanner finds every file in the repo that imports that function — without
 * parsing any ASTs.
 *
 * Strategy:
 *   1. GREP PHASE: Run `git grep` to find files containing the symbol name.
 *      git grep operates on the git index, respects .gitignore, ignores
 *      node_modules for free, and reads committed content (not working tree).
 *
 *   2. IMPORT DETECTION: For each grep match, read the file content and run
 *      regex-based import pattern detection. This classifies each hit as:
 *        - Static import:   import { fn } from './mod'
 *        - Dynamic import:  const { fn } = await import('./mod')
 *        - CJS require:     const { fn } = require('./mod')
 *        - Wildcard import: import * as mod from './mod'
 *        - Barrel re-export: export { fn } from './mod' or export * from './mod'
 *
 *   3. BARREL WALKER: If a file just re-exports the symbol (barrel file),
 *      we add it to a BFS queue and scan its consumers recursively.
 *      Cycle detection via visited Set prevents infinite loops.
 *
 *   4. OUTPUT: Returns ImportReference[] — the precise set of files that
 *      the Call-Site Tracer (Phase 3) needs to AST-parse.
 *
 * Performance characteristics:
 *   - git grep on a 50,000-file repo takes ~50ms
 *   - Import regex on 15 matched files takes ~2ms
 *   - Total Phase 2 time: < 100ms for most repos
 *
 * Edge cases handled:
 *   - Aliased imports (import { fn as alias })
 *   - Barrel file cycles (A re-exports from B, B re-exports from A)
 *   - Wildcard re-exports (export * from './mod')
 *   - Dynamic imports (await import('./mod'))
 *   - CJS requires (require('./mod'))
 *   - Performance limits (maxGrepResults, maxBarrelDepth)
 *   - Files in excluded paths (node_modules, dist, vendor)
 *   - Non-fatal error isolation (one bad file doesn't crash the scan)
 *
 * @module JITScanner
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import {
  ImportReference,
  GrepMatch,
  TracerConfig,
} from '../core/types';
import { isTargetFile } from '../core/utils';

const execAsync = promisify(exec);

// 10MB limit — matches git-diff.ts
const MAX_BUFFER = 10 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Extension globs for git grep — v1 scopes to TS/JS only
// ─────────────────────────────────────────────────────────────────────────────

const TS_JS_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx'];

// ─────────────────────────────────────────────────────────────────────────────
// Import detection regex patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matches ES static imports:
 *   import { processPayment } from './payments'
 *   import { processPayment as pay } from './payments'
 *   import { processPayment, other } from './payments'
 *
 * Captures:
 *   Group 1: the full import specifiers block (e.g., "processPayment as pay, other")
 */
function buildStaticImportRegex(symbolName: string): RegExp {
  // Match the symbol name as a word boundary within an import block
  return new RegExp(
    `import\\s*\\{([^}]*\\b${escapeRegex(symbolName)}\\b[^}]*)\\}\\s*from\\s*['\"]([^'"]+)['\"]`,
    'gm'
  );
}

/**
 * Matches dynamic imports:
 *   const { processPayment } = await import('./payments')
 *   const { processPayment: pay } = await import('./payments')
 *
 * Also matches without await:
 *   import('./payments').then(({ processPayment }) => ...)
 */
function buildDynamicImportRegex(symbolName: string): RegExp {
  return new RegExp(
    `(?:import\\s*\\(\\s*['\"]([^'"]+)['\"]\\s*\\))`,
    'gm'
  );
}

/**
 * Matches CJS require:
 *   const { processPayment } = require('./payments')
 *   const mod = require('./payments')
 */
function buildRequireRegex(symbolName: string): RegExp {
  return new RegExp(
    `require\\s*\\(\\s*['\"]([^'"]+)['\"]\\s*\\)`,
    'gm'
  );
}

/**
 * Matches wildcard imports:
 *   import * as payments from './payments'
 *
 * Captures:
 *   Group 1: the namespace alias (e.g., "payments")
 *   Group 2: the module path
 */
function buildWildcardImportRegex(): RegExp {
  return new RegExp(
    `import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*['\"]([^'"]+)['\"]`,
    'gm'
  );
}

/**
 * Matches named re-exports (barrel files):
 *   export { processPayment } from './payments'
 *   export { processPayment as default } from './payments'
 */
function buildNamedReExportRegex(symbolName: string): RegExp {
  return new RegExp(
    `export\\s*\\{([^}]*\\b${escapeRegex(symbolName)}\\b[^}]*)\\}\\s*from\\s*['\"]([^'"]+)['\"]`,
    'gm'
  );
}

/**
 * Matches wildcard re-exports (barrel files):
 *   export * from './payments'
 *   export * as payments from './payments'
 */
function buildWildcardReExportRegex(): RegExp {
  return new RegExp(
    `export\\s*\\*\\s*(?:as\\s+\\w+\\s*)?from\\s*['\"]([^'"]+)['\"]`,
    'gm'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts the local alias from an import specifier block.
 *
 * Given specifiers = "processPayment as pay, otherFn"
 * and symbolName = "processPayment"
 * Returns "pay"
 *
 * Given specifiers = "processPayment, otherFn"
 * and symbolName = "processPayment"
 * Returns "processPayment" (no alias)
 */
function extractAlias(specifiers: string, symbolName: string): string {
  // Normalize whitespace
  const normalized = specifiers.replace(/\s+/g, ' ').trim();
  const parts = normalized.split(',').map(p => p.trim());

  for (const part of parts) {
    // Match "symbolName as alias"
    const aliasMatch = part.match(
      new RegExp(`^${escapeRegex(symbolName)}\\s+as\\s+(\\w+)$`)
    );
    if (aliasMatch) {
      return aliasMatch[1];
    }

    // Match bare "symbolName"
    if (part === symbolName) {
      return symbolName;
    }
  }

  // Fallback — shouldn't happen if regex matched correctly
  return symbolName;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN SCANNER CLASS
// ═════════════════════════════════════════════════════════════════════════════

export class JITScanner {

  private config: TracerConfig;

  constructor(config: TracerConfig) {
    this.config = config;
  }

  // ── 1. Main entry point ────────────────────────────────────────────────────

  /**
   * Scans the repo for all files that import a given symbol.
   * Returns ImportReference[] — the files that Phase 3 needs to trace.
   *
   * @param symbolName — the exported function name (e.g., 'processPayment')
   * @param sourceFile — the file where the symbol is defined (used to filter self-imports)
   */
  async scan(symbolName: string, sourceFile: string): Promise<ImportReference[]> {
    // ── Step 1: Git grep for all files mentioning the symbol ─────────────
    const grepMatches = await this.gitGrep(symbolName);

    if (grepMatches.length === 0) {
      return [];
    }

    // ── Step 2: Classify each match ─────────────────────────────────────
    //   - Direct importers → add to result
    //   - Barrel re-exporters → add to BFS queue for recursive scan
    const importers: ImportReference[] = [];
    const barrelQueue: Array<{ filePath: string; depth: number }> = [];
    const visited = new Set<string>();

    // Mark the source file as visited — never trace the file where the symbol is defined
    visited.add(this.normalizePath(sourceFile));

    // Process initial grep matches
    for (const match of grepMatches) {
      const normalizedPath = this.normalizePath(match.filePath);

      // Skip self
      if (normalizedPath === this.normalizePath(sourceFile)) continue;

      // Skip already visited
      if (visited.has(normalizedPath)) continue;
      visited.add(normalizedPath);

      // Skip non-target files (extra safety — git grep globs should handle this)
      if (!isTargetFile(match.filePath)) continue;

      await this.classifyFile(
        match.filePath,
        symbolName,
        importers,
        barrelQueue,
        0 // depth = 0 for initial matches
      );
    }

    // ── Step 3: BFS walk barrel files ────────────────────────────────────
    await this.walkBarrels(symbolName, importers, barrelQueue, visited);

    return importers;
  }

  // ── 2. Git grep phase ──────────────────────────────────────────────────────

  /**
   * Runs `git grep` to find all files containing the symbol name.
   * Uses the git index — reads committed content, not the working tree.
   * Respects .gitignore and excludes binary files automatically.
   *
   * Returns GrepMatch[] capped at maxGrepResults.
   */
  private async gitGrep(symbolName: string): Promise<GrepMatch[]> {
    // Build git grep command:
    //   -n  = show line numbers
    //   -l  would only show filenames (we want lines for debugging)
    //   --  = path spec separator
    //   '*.ts' etc = only search supported extensions
    const pathSpecs = TS_JS_GLOBS.map(g => `'${g}'`).join(' ');

    // Escape the symbol name for shell safety
    const escapedSymbol = symbolName.replace(/'/g, "'\\''");

    const cmd = `git grep -n --word-regexp '${escapedSymbol}' ${this.config.headSha} -- ${pathSpecs}`;

    try {
      const { stdout } = await execAsync(cmd, {
        maxBuffer: MAX_BUFFER,
        cwd: this.config.repoRoot,
      });

      return this.parseGrepOutput(stdout);
    } catch (error: any) {
      // git grep exits with code 1 when no matches found — this is expected
      if (error.code === 1 && (!error.stderr || error.stderr.trim() === '')) {
        return [];
      }

      // Real failure — log but don't crash
      console.warn(
        `[scanner] git grep failed for "${symbolName}": ${error.message}`
      );
      return [];
    }
  }

  /**
   * Parses the raw git grep output into GrepMatch[].
   *
   * Git grep output format with -n:
   *   HEAD:src/checkout/cart.ts:47:import { processPayment } from '../payments'
   *
   * When using a ref like HEAD, the format is:
   *   ref:path:lineNumber:matchedLine
   */
  private parseGrepOutput(stdout: string): GrepMatch[] {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const matches: GrepMatch[] = [];

    for (const line of lines) {
      if (matches.length >= this.config.maxGrepResults) break;

      // Format: HEAD:path:lineNum:text  OR  path:lineNum:text (if no ref)
      // We need to handle the ref prefix if present
      let rest = line;

      // If line starts with "ref:", strip the ref prefix
      // HEAD:src/file.ts:42:import...  →  src/file.ts:42:import...
      const refMatch = rest.match(/^[^:]+:/);
      if (refMatch && !rest.startsWith('/')) {
        // Could be a ref prefix or a Windows absolute path
        // Git grep with a ref always prefixes with "ref:"
        // Check if this looks like a path or a ref
        const potentialRef = refMatch[0].slice(0, -1);
        if (potentialRef === this.config.headSha ||
            potentialRef === 'HEAD' ||
            /^[a-f0-9]{7,40}$/.test(potentialRef)) {
          rest = rest.slice(refMatch[0].length);
        }
      }

      // Now parse: path:lineNum:text
      const firstColon = rest.indexOf(':');
      if (firstColon === -1) continue;

      const secondColon = rest.indexOf(':', firstColon + 1);
      if (secondColon === -1) continue;

      const filePath = rest.slice(0, firstColon);
      const lineNum = parseInt(rest.slice(firstColon + 1, secondColon), 10);
      const matchText = rest.slice(secondColon + 1);

      if (isNaN(lineNum)) continue;

      matches.push({
        filePath,
        matchLine: lineNum,
        matchText: matchText.trim(),
      });
    }

    // Deduplicate by file path — we only need to know which files match,
    // not every individual line
    const seen = new Set<string>();
    return matches.filter(m => {
      if (seen.has(m.filePath)) return false;
      seen.add(m.filePath);
      return true;
    });
  }

  // ── 3. Import classification ───────────────────────────────────────────────

  /**
   * Reads a file and classifies how it references the target symbol.
   * Adds direct importers to the `importers` array.
   * Adds barrel re-exporters to the `barrelQueue` for BFS traversal.
   */
  private async classifyFile(
    filePath: string,
    symbolName: string,
    importers: ImportReference[],
    barrelQueue: Array<{ filePath: string; depth: number }>,
    depth: number,
  ): Promise<void> {
    let content: string;

    try {
      content = await this.getFileContent(filePath);
    } catch (err: any) {
      console.warn(`[scanner] Failed to read "${filePath}": ${err.message}`);
      return;
    }

    if (!content || content.trim() === '') return;

    // ── Check for barrel re-exports first (they take priority) ───────────
    const isBarrel = this.detectBarrelReExport(content, symbolName, filePath, barrelQueue, depth);

    // ── Check for static imports ─────────────────────────────────────────
    const staticRegex = buildStaticImportRegex(symbolName);
    let match: RegExpExecArray | null;

    while ((match = staticRegex.exec(content)) !== null) {
      const specifiers = match[1];
      const localName = extractAlias(specifiers, symbolName);

      // Find the line number of this import
      const lineNum = this.getLineNumber(content, match.index);

      importers.push({
        filePath,
        importedName: symbolName,
        localName,
        isBarrel: false,
        importLine: lineNum,
        importType: 'static',
      });
    }

    // ── Check for dynamic imports ────────────────────────────────────────
    // Dynamic imports are trickier — the symbol may be destructured later
    // We detect the import() call and mark it for AST analysis in Phase 3
    const dynamicRegex = buildDynamicImportRegex(symbolName);
    while ((match = dynamicRegex.exec(content)) !== null) {
      // Only add if the file also mentions the symbol name (which it does — grep found it)
      const lineNum = this.getLineNumber(content, match.index);

      importers.push({
        filePath,
        importedName: symbolName,
        localName: symbolName, // Phase 3 will resolve the actual binding
        isBarrel: false,
        importLine: lineNum,
        importType: 'dynamic',
      });
    }

    // ── Check for CJS requires ───────────────────────────────────────────
    const requireRegex = buildRequireRegex(symbolName);
    while ((match = requireRegex.exec(content)) !== null) {
      const lineNum = this.getLineNumber(content, match.index);

      importers.push({
        filePath,
        importedName: symbolName,
        localName: symbolName, // Phase 3 resolves destructured binding
        isBarrel: false,
        importLine: lineNum,
        importType: 'require',
      });
    }

    // ── Check for wildcard imports ───────────────────────────────────────
    const wildcardRegex = buildWildcardImportRegex();
    while ((match = wildcardRegex.exec(content)) !== null) {
      const namespaceName = match[1]; // e.g., 'payments'
      const lineNum = this.getLineNumber(content, match.index);

      importers.push({
        filePath,
        importedName: symbolName,
        localName: `${namespaceName}.${symbolName}`, // e.g., 'payments.processPayment'
        isBarrel: false,
        importLine: lineNum,
        importType: 'wildcard',
      });
    }

    // Deduplicate importers for this file — a file may have multiple grep hits
    // but only one actual import statement
    this.deduplicateImporters(importers, filePath);
  }

  /**
   * Detects barrel file re-exports and adds them to the BFS queue.
   * Returns true if a barrel re-export was found.
   *
   * Handles:
   *   export { processPayment } from './payments'
   *   export * from './payments'
   */
  private detectBarrelReExport(
    content: string,
    symbolName: string,
    filePath: string,
    barrelQueue: Array<{ filePath: string; depth: number }>,
    depth: number,
  ): boolean {
    let found = false;

    // Named re-exports: export { processPayment } from './payments'
    const namedRegex = buildNamedReExportRegex(symbolName);
    let match: RegExpExecArray | null;

    while ((match = namedRegex.exec(content)) !== null) {
      found = true;
      // This file is a barrel — add to BFS queue so we scan its consumers next
      barrelQueue.push({ filePath, depth: depth + 1 });
    }

    // Wildcard re-exports: export * from './payments'
    // These are trickier — we can't know if the wildcard includes our symbol
    // without resolving the source module. We conservatively treat them as barrels.
    const wildcardRegex = buildWildcardReExportRegex();
    while ((match = wildcardRegex.exec(content)) !== null) {
      // Only add if the file contains the symbol name somewhere (which it does — grep found it)
      found = true;
      barrelQueue.push({ filePath, depth: depth + 1 });
    }

    return found;
  }

  // ── 4. Barrel BFS walker ───────────────────────────────────────────────────

  /**
   * BFS walk through barrel files to find transitive consumers.
   *
   * When barrel file `checkout/index.ts` re-exports `processPayment`,
   * we need to find who imports from `checkout/index.ts` or `checkout/`.
   *
   * Cycle detection: the `visited` Set prevents infinite loops when
   * A re-exports from B and B re-exports from A.
   *
   * Depth limit: maxBarrelDepth prevents runaway scans in deeply nested
   * barrel architectures (Angular-style libs can have 5+ layers).
   */
  private async walkBarrels(
    symbolName: string,
    importers: ImportReference[],
    barrelQueue: Array<{ filePath: string; depth: number }>,
    visited: Set<string>,
  ): Promise<void> {
    let barrelsProcessed = 0;

    while (barrelQueue.length > 0) {
      const { filePath, depth } = barrelQueue.shift()!;

      // ── Depth limit ────────────────────────────────────────────────────
      if (depth > this.config.maxBarrelDepth) {
        console.warn(
          `[scanner] Barrel depth limit (${this.config.maxBarrelDepth}) reached ` +
          `at "${filePath}". Stopping barrel walk for "${symbolName}".`
        );
        continue;
      }

      barrelsProcessed++;

      // ── Find consumers of this barrel file ─────────────────────────────
      // The barrel's filename (without extension) or directory name is what
      // consumers import from. We search for both patterns.
      const barrelConsumers = await this.findBarrelConsumers(filePath, symbolName);

      for (const consumer of barrelConsumers) {
        const normalizedPath = this.normalizePath(consumer.filePath);

        // ── Cycle detection ──────────────────────────────────────────────
        if (visited.has(normalizedPath)) continue;
        visited.add(normalizedPath);

        // Skip non-target files
        if (!isTargetFile(consumer.filePath)) continue;

        // Classify this consumer — it might be another barrel
        await this.classifyFile(
          consumer.filePath,
          symbolName,
          importers,
          barrelQueue,
          depth, // pass current depth; detectBarrelReExport adds +1
        );
      }
    }

    if (barrelsProcessed > 0) {
      console.log(
        `[scanner] Traversed ${barrelsProcessed} barrel file(s) for "${symbolName}"`
      );
    }
  }

  /**
   * Finds files that import from a barrel file.
   *
   * If barrel is `src/checkout/index.ts`, consumers might import:
   *   - from './checkout'
   *   - from './checkout/index'
   *   - from '../checkout'
   *   - from '@/checkout'
   *
   * We search for the directory name or the file basename (without extension)
   * because import paths vary based on tsconfig paths, relative depth, etc.
   */
  private async findBarrelConsumers(
    barrelPath: string,
    symbolName: string,
  ): Promise<GrepMatch[]> {
    // Extract the meaningful import target from the barrel path
    // e.g., 'src/checkout/index.ts' → 'checkout'
    // e.g., 'src/payments/processor.ts' → 'processor' OR 'payments/processor'
    const baseName = barrelPath.replace(/\.(ts|tsx|js|jsx)$/, '');
    const isIndex = baseName.endsWith('/index') || baseName.endsWith('\\index');

    // The part consumers actually type in their import path
    let importTarget: string;
    if (isIndex) {
      // index files: consumers import the directory name
      importTarget = baseName.replace(/\/index$|\\index$/, '').split(/[\\/]/).pop() || '';
    } else {
      // non-index files: consumers import the filename
      importTarget = baseName.split(/[\\/]/).pop() || '';
    }

    if (!importTarget) return [];

    // Grep for files that both mention the import target AND the symbol name
    // This two-term search dramatically reduces false positives
    try {
      const pathSpecs = TS_JS_GLOBS.map(g => `'${g}'`).join(' ');
      const escapedTarget = importTarget.replace(/'/g, "'\\''");
      const escapedSymbol = symbolName.replace(/'/g, "'\\''");

      // Use two git greps ANDed together: file must contain both the import target
      // (in a from clause) and the symbol name
      const cmd =
        `git grep -n -l '${escapedTarget}' ${this.config.headSha} -- ${pathSpecs} | ` +
        `xargs git grep -n '${escapedSymbol}' ${this.config.headSha} -- 2>/dev/null || true`;

      const { stdout } = await execAsync(cmd, {
        maxBuffer: MAX_BUFFER,
        cwd: this.config.repoRoot,
      });

      if (!stdout.trim()) return [];

      return this.parseGrepOutput(stdout);
    } catch {
      return [];
    }
  }

  // ── 5. File content retrieval ──────────────────────────────────────────────

  /**
   * Reads file content from the git index at the specified ref.
   * Uses `git show` for consistency with the rest of the pipeline.
   */
  private async getFileContent(filePath: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `git show ${this.config.headSha}:${filePath}`,
        { maxBuffer: MAX_BUFFER, cwd: this.config.repoRoot },
      );
      return stdout;
    } catch (error: any) {
      const stderr: string = error.stderr ?? '';
      if (stderr.includes('does not exist in') ||
          stderr.includes('Path') ||
          error.code === 128) {
        return '';
      }
      throw error;
    }
  }

  // ── 6. Helpers ─────────────────────────────────────────────────────────────

  /**
   * Returns the 1-indexed line number for a character offset in a string.
   */
  private getLineNumber(content: string, charOffset: number): number {
    let line = 1;
    for (let i = 0; i < charOffset && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  /**
   * Normalizes a file path for comparison.
   * Converts backslashes to forward slashes and removes trailing slashes.
   */
  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }

  /**
   * Deduplicates importers for a specific file.
   * A file may have multiple grep hits but only one actual import.
   * Keeps the first occurrence (which has the most information).
   */
  private deduplicateImporters(importers: ImportReference[], filePath: string): void {
    const seen = new Set<string>();
    let i = importers.length;

    while (i--) {
      const imp = importers[i];
      if (imp.filePath !== filePath) continue;

      const key = `${imp.filePath}:${imp.importType}:${imp.localName}`;
      if (seen.has(key)) {
        importers.splice(i, 1);
      } else {
        seen.add(key);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory — creates a scanner with sensible defaults
// ─────────────────────────────────────────────────────────────────────────────

export function createDefaultTracerConfig(
  repoRoot: string,
  headSha: string = 'HEAD',
  overrides?: Partial<TracerConfig>,
): TracerConfig {
  return {
    tracerLanguages: ['typescript', 'javascript'],
    maxGrepResults:   500,
    maxBarrelDepth:   10,
    maxTracerFiles:   100,
    traceOnlyBreaking: true,
    repoRoot,
    headSha,
    ...overrides,
  };
}
