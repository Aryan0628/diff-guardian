/**
 * src/tracer/tracer.ts
 *
 * THE CALL-SITE TRACER (Phase 3 of the Lazy Graph).
 *
 * This module is the "AST surgeon" — it receives the precise list of importer
 * files from the JIT Scanner (Phase 2) and parses ONLY those files to extract
 * exact call sites.
 *
 * Multi-language support:
 *   The tracer is language-agnostic. All language-specific behavior (AST queries,
 *   argument counting, enum access walking) is delegated to LanguageStrategy
 *   implementations. Grammars are loaded lazily on first use per language.
 *
 * This is where the "No False Positives" guarantee comes from:
 *   - Spread arguments → indeterminate, never flagged as broken
 *   - Aliased imports → tracked via ImportReference.localName
 *   - Method calls → matched by identifier, not just bare function calls
 *   - Old↔New correlation → index-based matching, not line numbers
 *   - Overloaded functions → valid-count set, not single expected count
 *   - Namespace verification → strategy.verifyCallTarget() prevents false matches
 *
 * The tracer NEVER touches files that aren't in Phase 2's output.
 * If the repo has 10,000 files and only 15 import the broken function,
 * the tracer parses exactly 15 files.
 *
 * Performance characteristics:
 *   - 15 files × ~100 lines avg = 1,500 lines of AST parsing
 *   - tree-sitter parses at ~100k lines/sec
 *   - Total Phase 3 time: < 20ms for most PRs
 *
 * @module CallSiteTracer
 */

import { Parser, Language as WasmLanguage, Tree, Query } from 'web-tree-sitter';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

import {
  CallSite,
  FunctionChange,
  FunctionSignature,
  ImportReference,
  TracerResult,
  TracerConfig,
  FileDiff,
} from '../core/types';

import {
  getStrategyForFile,
  type LanguageStrategy,
  type RawCallSite,
  type RawEnumAccess,
} from './languages';

const execAsync = promisify(exec);
const MAX_BUFFER = 10 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Lazy grammar cache — one entry per language, loaded on first use
// ─────────────────────────────────────────────────────────────────────────────

interface GrammarEntry {
  parser:   Parser;
  language: WasmLanguage;
  queries:  Map<string, Query>;   // query source → compiled Query
}

const grammarCache = new Map<string, GrammarEntry>();
let parserInitialized = false;

/**
 * Loads (or retrieves from cache) the grammar for a language strategy.
 * JIT loading — first call for a language pays the ~10ms WASM load cost,
 * subsequent calls return instantly from the cache.
 */
async function getGrammar(strategy: LanguageStrategy): Promise<GrammarEntry> {
  const cached = grammarCache.get(strategy.id);
  if (cached) return cached;

  // Ensure Parser.init() has been called (idempotent)
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }

  const parser = new Parser();
  const wasmPath = path.resolve(__dirname, '..', '..', 'grammars', strategy.grammarFile);
  const language = await WasmLanguage.load(wasmPath);
  parser.setLanguage(language);

  const entry: GrammarEntry = { parser, language, queries: new Map() };
  grammarCache.set(strategy.id, entry);

  return entry;
}

/**
 * Compiles (or retrieves from cache) a tree-sitter query for a grammar.
 */
function getQuery(grammar: GrammarEntry, querySrc: string): Query {
  const cached = grammar.queries.get(querySrc);
  if (cached) return cached;

  const query = new Query(grammar.language, querySrc);
  grammar.queries.set(querySrc, query);
  return query;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CALL-SITE TRACER
// ═════════════════════════════════════════════════════════════════════════════

export class CallSiteTracer {

  private config: TracerConfig;

  constructor(config: TracerConfig) {
    this.config = config;
  }

  // ── 1. Initialization ──────────────────────────────────────────────────────

  /**
   * Initializes the tree-sitter WASM runtime.
   * Grammars are loaded lazily per language — this just ensures the runtime is ready.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    if (!parserInitialized) {
      await Parser.init();
      parserInitialized = true;
    }
  }

  // ── 2. Main entry point: Function tracing ──────────────────────────────────

  /**
   * Traces all call sites for a single FunctionChange.
   *
   * @param change    — the broken function (from the classifier)
   * @param importers — files that import this function (from the scanner)
   * @param diffs     — the PR's FileDiff[] (needed for old↔new correlation)
   *
   * @returns TracerResult with all resolved call sites
   */
  async trace(
    change:    FunctionChange,
    importers: ImportReference[],
    diffs:     FileDiff[],
  ): Promise<TracerResult> {
    const result: TracerResult = {
      functionName:      change.name,
      totalFilesGrepped: 0,
      importersFound:    importers.length,
      barrelsTraversed:  0,
      callSites:         [],
      errors:            [],
    };

    // Build the set of valid argument counts
    const validCounts = this.buildValidArgCounts(change);

    // Build a quick lookup of PR diffs by file path
    const diffMap = new Map<string, FileDiff>();
    for (const diff of diffs) {
      diffMap.set(this.normalizePath(diff.path), diff);
    }

    // Cap the number of files we trace — performance safety net
    const filesToTrace = importers
      .filter(imp => !imp.isBarrel)
      .slice(0, this.config.maxTracerFiles);

    // Process each importer file
    for (const importer of filesToTrace) {
      try {
        const sites = await this.traceFile(
          importer,
          change,
          validCounts,
          diffMap,
        );
        result.callSites.push(...sites);
      } catch (err: any) {
        result.errors.push(
          `Failed to trace "${importer.filePath}": ${err.message}`
        );
      }
    }

    return result;
  }

  // ── 2b. Enum tracing entry point ───────────────────────────────────────────

  /**
   * Traces all access sites for a broken enum.
   *
   * Unlike function tracing (which counts arguments), enum tracing finds
   * every EnumName.MemberName access where MemberName was removed or changed.
   *
   * Checks strategy.supportsEnumTracing — skips Go (flat const, no namespace).
   *
   * @param enumName       — the enum identifier: 'Status'
   * @param brokenMembers  — all affected member names: ['Active', 'Suspended']
   * @param removedMembers — members that were deleted
   * @param changedMembers — members whose values changed
   * @param importers      — files that import this enum (from the scanner)
   * @param diffs          — the PR's FileDiff[] (for old↔new correlation)
   */
  async traceEnum(
    enumName:       string,
    brokenMembers:  string[],
    removedMembers: string[],
    changedMembers: string[],
    importers:      ImportReference[],
    diffs:          FileDiff[],
  ): Promise<TracerResult> {
    const result: TracerResult = {
      functionName:      enumName,
      totalFilesGrepped: 0,
      importersFound:    importers.length,
      barrelsTraversed:  0,
      callSites:         [],
      errors:            [],
    };

    const removedSet = new Set(removedMembers);
    const changedSet = new Set(changedMembers);
    const memberSet  = new Set(brokenMembers);

    // Build diff lookup
    const diffMap = new Map<string, FileDiff>();
    for (const diff of diffs) {
      diffMap.set(this.normalizePath(diff.path), diff);
    }

    // Cap files traced
    const filesToTrace = importers
      .filter(imp => !imp.isBarrel)
      .slice(0, this.config.maxTracerFiles);

    for (const importer of filesToTrace) {
      try {
        // ── Resolve strategy for this file ─────────────────────────────
        const strategy = getStrategyForFile(importer.filePath);
        if (!strategy || !strategy.supportsEnumTracing) continue;

        const grammar = await getGrammar(strategy);
        const normalizedPath = this.normalizePath(importer.filePath);
        const diff = diffMap.get(normalizedPath);

        // Get new source (HEAD version)
        const newSource = diff
          ? diff.newSource
          : await this.getFileContent(importer.filePath);

        if (!newSource) continue;

        // Extract all EnumName.MemberName access patterns in new source
        const newAccess = this.extractEnumAccess(
          grammar, strategy, newSource, enumName, memberSet, importer.filePath
        );

        // If file is in the diff, also parse old source for "Fixed" detection
        let oldAccess: RawEnumAccess[] = [];
        if (diff && diff.oldSource) {
          oldAccess = this.extractEnumAccess(
            grammar, strategy, diff.oldSource, enumName, memberSet, importer.filePath
          );
        }

        // Classify each access point
        for (const access of newAccess) {
          const isBroken = removedSet.has(access.memberName) || changedSet.has(access.memberName);

          let isFixed = false;
          if (diff && !isBroken) {
            const oldHadThis = oldAccess.some(
              o => o.memberName === access.memberName
            );
            isFixed = oldHadThis;
          }

          result.callSites.push({
            file:            access.filePath,
            lineStart:       access.lineStart,
            lineEnd:         access.lineEnd,
            argumentCount:   0,
            isBroken,
            isFixed,
            isIndeterminate: false,
            covered:         false,
          });
        }

        // Detect fixed accesses — old source had the broken member, new source doesn't
        if (diff && diff.oldSource) {
          for (const oldAcc of oldAccess) {
            const stillExists = newAccess.some(
              n => n.memberName === oldAcc.memberName &&
                   n.lineStart === oldAcc.lineStart
            );
            if (!stillExists) {
              result.callSites.push({
                file:            oldAcc.filePath,
                lineStart:       oldAcc.lineStart,
                lineEnd:         oldAcc.lineEnd,
                argumentCount:   0,
                isBroken:        false,
                isFixed:         true,
                isIndeterminate: false,
                covered:         false,
              });
            }
          }
        }
      } catch (err: any) {
        result.errors.push(
          `Failed to trace enum "${enumName}" in "${importer.filePath}": ${err.message}`
        );
      }
    }

    return result;
  }

  // ── 3. Per-file tracing ────────────────────────────────────────────────────

  /**
   * Traces call sites in a single file.
   * Resolves the language strategy from file extension and uses
   * the strategy's queries for call expression detection.
   */
  private async traceFile(
    importer:    ImportReference,
    change:      FunctionChange,
    validCounts: Set<number> | { min: number; max: number },
    diffMap:     Map<string, FileDiff>,
  ): Promise<CallSite[]> {

    // ── Resolve strategy and grammar ──────────────────────────────────────
    const strategy = getStrategyForFile(importer.filePath);
    if (!strategy) return [];

    const grammar = await getGrammar(strategy);

    const normalizedPath = this.normalizePath(importer.filePath);
    const diff = diffMap.get(normalizedPath);

    // The identifier to search for — may be aliased
    const searchName = importer.localName;

    if (diff) {
      // ── File IS in the PR diff ─────────────────────────────────────────
      return this.traceChangedFile(
        grammar, strategy, importer.filePath, searchName,
        diff.oldSource, diff.newSource, validCounts,
      );
    } else {
      // ── File is NOT in the PR diff ─────────────────────────────────────
      const source = await this.getFileContent(importer.filePath);
      if (!source) return [];

      const newSites = this.extractCallSites(grammar, strategy, source, searchName, importer.filePath);
      return this.classifyCallSites(newSites, validCounts, false);
    }
  }

  // ── 4. Changed file tracing (old↔new correlation) ──────────────────────────

  /**
   * Traces a file that exists in the PR diff.
   * Compares old and new call sites by INDEX ORDER to detect fixes.
   */
  private traceChangedFile(
    grammar:     GrammarEntry,
    strategy:    LanguageStrategy,
    filePath:    string,
    searchName:  string,
    oldSource:   string,
    newSource:   string,
    validCounts: Set<number> | { min: number; max: number },
  ): CallSite[] {

    const oldSites = oldSource
      ? this.extractCallSites(grammar, strategy, oldSource, searchName, filePath)
      : [];
    const newSites = newSource
      ? this.extractCallSites(grammar, strategy, newSource, searchName, filePath)
      : [];

    if (newSites.length === 0) return [];

    // ── Correlate by index ───────────────────────────────────────────────
    if (oldSites.length === newSites.length) {
      return this.correlateByIndex(oldSites, newSites, validCounts);
    }

    // ── Count mismatch — calls were added or removed ─────────────────────
    return this.classifyWithBestEffortCorrelation(oldSites, newSites, validCounts);
  }

  /**
   * 1:1 index correlation when call count is unchanged.
   */
  private correlateByIndex(
    oldSites: RawCallSite[],
    newSites: RawCallSite[],
    validCounts: Set<number> | { min: number; max: number },
  ): CallSite[] {
    const results: CallSite[] = [];

    for (let i = 0; i < newSites.length; i++) {
      const oldSite = oldSites[i];
      const newSite = newSites[i];

      const isNewValid = this.isValidArgCount(newSite.argumentCount, validCounts);
      const wasOldValid = oldSite
        ? this.isValidArgCount(oldSite.argumentCount, validCounts)
        : true;

      let isBroken = false;
      let isFixed = false;

      if (newSite.hasSpread) {
        isBroken = false;
        isFixed = false;
      } else if (isNewValid) {
        if (oldSite && !wasOldValid && !oldSite.hasSpread) {
          isFixed = true;
        }
        isBroken = false;
      } else {
        isBroken = true;
        isFixed = false;
      }

      results.push({
        file:            newSite.filePath,
        lineStart:       newSite.lineStart,
        lineEnd:         newSite.lineEnd,
        argumentCount:   newSite.argumentCount,
        isBroken,
        isFixed,
        isIndeterminate: newSite.hasSpread,
        covered:         false,
      });
    }

    return results;
  }

  /**
   * Best-effort correlation when call counts differ.
   */
  private classifyWithBestEffortCorrelation(
    oldSites: RawCallSite[],
    newSites: RawCallSite[],
    validCounts: Set<number> | { min: number; max: number },
  ): CallSite[] {
    const oldArgCounts = new Map<number, number>();
    for (const old of oldSites) {
      if (!old.hasSpread) {
        oldArgCounts.set(old.argumentCount, (oldArgCounts.get(old.argumentCount) || 0) + 1);
      }
    }

    const results: CallSite[] = [];

    for (const newSite of newSites) {
      const isValid = this.isValidArgCount(newSite.argumentCount, validCounts);

      let isFixed = false;
      if (isValid && !newSite.hasSpread) {
        const oldInvalidCount = oldSites.find(
          o => !o.hasSpread && !this.isValidArgCount(o.argumentCount, validCounts)
        );
        if (oldInvalidCount) {
          isFixed = true;
        }
      }

      results.push({
        file:            newSite.filePath,
        lineStart:       newSite.lineStart,
        lineEnd:         newSite.lineEnd,
        argumentCount:   newSite.argumentCount,
        isBroken:        newSite.hasSpread ? false : !isValid,
        isFixed,
        isIndeterminate: newSite.hasSpread,
        covered:         false,
      });
    }

    return results;
  }

  // ── 5. AST call-site extraction (strategy-driven) ──────────────────────────

  /**
   * Parses a source string and extracts every call expression that matches
   * the target identifier. Delegates query patterns and argument counting
   * to the language strategy.
   */
  private extractCallSites(
    grammar:    GrammarEntry,
    strategy:   LanguageStrategy,
    source:     string,
    searchName: string,
    filePath:   string,
  ): RawCallSite[] {
    let tree: Tree | null = null;
    const sites: RawCallSite[] = [];

    try {
      tree = grammar.parser.parse(source);
      if (!tree) return [];

      // Determine the bare identifier to match
      const isDotNotation = searchName.includes('.');
      const bareIdentifier = isDotNotation
        ? searchName.split('.').pop()!
        : searchName;

      // Run each call expression query from the strategy
      for (const querySrc of strategy.callExpressionQueries) {
        const query = getQuery(grammar, querySrc);

        for (const match of query.matches(tree.rootNode)) {
          const calleeNode = this.getCapture(match, 'callee');
          const argsNode = this.getCapture(match, 'args');
          const callNode = this.getCapture(match, 'call');

          if (!calleeNode || !argsNode || !callNode) continue;

          // Match by identifier name
          if (calleeNode.text !== bareIdentifier) continue;

          // Verify the call target using the strategy
          // (handles namespace imports, static imports, etc.)
          if (!strategy.verifyCallTarget(callNode, searchName, calleeNode.text)) {
            continue;
          }

          // Count arguments using the strategy
          const { count, hasSpread } = strategy.countArguments(argsNode);

          sites.push({
            filePath,
            lineStart: callNode.startPosition.row + 1,
            lineEnd:   callNode.endPosition.row + 1,
            argumentCount: hasSpread ? -1 : count,
            hasSpread,
          });
        }
      }
    } finally {
      tree?.delete();
    }

    return sites;
  }

  // ── 5b. Enum member access extraction (strategy-driven) ────────────────────

  /**
   * Parses source and finds all EnumName.MemberName access patterns.
   * Delegates the actual AST walking to the language strategy.
   */
  private extractEnumAccess(
    grammar:    GrammarEntry,
    strategy:   LanguageStrategy,
    source:     string,
    enumName:   string,
    memberSet:  Set<string>,
    filePath:   string,
  ): RawEnumAccess[] {
    let tree: Tree | null = null;

    try {
      tree = grammar.parser.parse(source);
      if (!tree) return [];

      return strategy.walkEnumAccess(tree.rootNode, enumName, memberSet, filePath);
    } finally {
      tree?.delete();
    }
  }

  // ── 6. Argument count validation ───────────────────────────────────────────

  private buildValidArgCounts(
    change: FunctionChange,
  ): Set<number> | { min: number; max: number } {
    if (change.validArgCounts && change.validArgCounts.size > 0) {
      return change.validArgCounts;
    }

    const sig = change.after as FunctionSignature | null;
    if (!sig || !('params' in sig)) {
      return { min: 0, max: Infinity };
    }

    if (change.requiredParamCount !== undefined && change.totalParamCount !== undefined) {
      const hasRest = sig.params.some(p => p.isRest);
      return {
        min: change.requiredParamCount,
        max: hasRest ? Infinity : change.totalParamCount,
      };
    }

    const required = sig.params.filter(p => !p.optional && !p.isRest).length;
    const total = sig.params.filter(p => !p.isRest).length;
    const hasRest = sig.params.some(p => p.isRest);

    return {
      min: required,
      max: hasRest ? Infinity : total,
    };
  }

  private isValidArgCount(
    count: number,
    validCounts: Set<number> | { min: number; max: number },
  ): boolean {
    if (count === -1) return true;

    if (validCounts instanceof Set) {
      return validCounts.has(count);
    }

    return count >= validCounts.min && count <= validCounts.max;
  }

  // ── 7. Classify non-diff call sites ────────────────────────────────────────

  private classifyCallSites(
    rawSites:    RawCallSite[],
    validCounts: Set<number> | { min: number; max: number },
    _isInDiff:   boolean,
  ): CallSite[] {
    return rawSites.map(site => ({
      file:            site.filePath,
      lineStart:       site.lineStart,
      lineEnd:         site.lineEnd,
      argumentCount:   site.argumentCount,
      isBroken:        site.hasSpread ? false : !this.isValidArgCount(site.argumentCount, validCounts),
      isFixed:         false,
      isIndeterminate: site.hasSpread,
      covered:         false,
    }));
  }

  // ── 8. File content retrieval ──────────────────────────────────────────────

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

  // ── 9. Helpers ─────────────────────────────────────────────────────────────

  private getCapture(
    match: { captures: Array<{ name: string; node: any }> },
    name: string,
  ): any | null {
    const capture = match.captures.find(c => c.name === name);
    return capture?.node ?? null;
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
}
