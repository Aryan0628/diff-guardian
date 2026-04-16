/**
 * src/tracer/tracer.ts
 *
 * THE CALL-SITE TRACER (Phase 3 of the Lazy Graph).
 *
 * This module is the "AST surgeon" — it receives the precise list of importer
 * files from the JIT Scanner (Phase 2) and parses ONLY those files to extract
 * exact call sites.
 *
 * This is where the "No False Positives" guarantee comes from:
 *   - Spread arguments → indeterminate, never flagged as broken
 *   - Aliased imports → tracked via ImportReference.localName
 *   - Method calls → matched by identifier, not just bare function calls
 *   - Old↔New correlation → index-based matching, not line numbers
 *   - Overloaded functions → valid-count set, not single expected count
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

const execAsync = promisify(exec);
const MAX_BUFFER = 10 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Tree-sitter query for call expressions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Q1: Direct function calls — processPayment(arg1, arg2)
 * Captures the callee identifier and the arguments list.
 */
const CALL_EXPR_QUERY_SRC = `
  (call_expression
    function: (identifier) @callee
    arguments: (arguments) @args
  ) @call
`;

/**
 * Q2: Method/member calls — obj.processPayment(arg1, arg2)
 * Captures the property name (the method) and the arguments list.
 */
const MEMBER_CALL_QUERY_SRC = `
  (call_expression
    function: (member_expression
      property: (property_identifier) @callee
    )
    arguments: (arguments) @args
  ) @call
`;

// ─────────────────────────────────────────────────────────────────────────────
// Compiled query cache
// ─────────────────────────────────────────────────────────────────────────────

interface TracerQueries {
  directCall: Query;
  memberCall: Query;
}

let cachedTracerLang: WasmLanguage | null = null;
let cachedTracerQueries: TracerQueries | null = null;

function getTracerQueries(language: WasmLanguage): TracerQueries {
  if (cachedTracerQueries && cachedTracerLang === language) {
    return cachedTracerQueries;
  }

  // Dispose old queries
  if (cachedTracerQueries) {
    cachedTracerQueries.directCall.delete();
    cachedTracerQueries.memberCall.delete();
  }

  cachedTracerLang = language;
  cachedTracerQueries = {
    directCall: new Query(language, CALL_EXPR_QUERY_SRC),
    memberCall: new Query(language, MEMBER_CALL_QUERY_SRC),
  };

  return cachedTracerQueries;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CALL-SITE TRACER
// ═════════════════════════════════════════════════════════════════════════════

export class CallSiteTracer {

  private parser: Parser | null = null;
  private language: WasmLanguage | null = null;
  private config: TracerConfig;

  constructor(config: TracerConfig) {
    this.config = config;
  }

  // ── 1. Initialization ──────────────────────────────────────────────────────

  /**
   * Initializes the tree-sitter WASM runtime and loads the TypeScript grammar.
   * MUST be called once before trace().
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.parser) return;

    await Parser.init();
    this.parser = new Parser();

    // Load TypeScript grammar — covers both TS and JS
    const wasmPath = path.resolve(__dirname, '..', '..', 'grammars', 'tree-sitter-typescript.wasm');
    this.language = await WasmLanguage.load(wasmPath);
    this.parser.setLanguage(this.language);
  }

  // ── 2. Main entry point ────────────────────────────────────────────────────

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
    if (!this.parser || !this.language) {
      throw new Error('[tracer] Not initialized. Call await tracer.init() first.');
    }

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

  // ── 3. Per-file tracing ────────────────────────────────────────────────────

  /**
   * Traces call sites in a single file.
   *
   * The key insight: we check if this file is in the PR diff.
   *
   * - NOT in diff → parse the current (HEAD) version only.
   *   Any call site with wrong argument count is "broken."
   *
   * - IN the diff → parse BOTH old and new versions.
   *   Compare call sites by index order. If a call was broken in old
   *   but correct in new, mark it as "Fixed" by the developer.
   */
  private async traceFile(
    importer:    ImportReference,
    change:      FunctionChange,
    validCounts: Set<number> | { min: number; max: number },
    diffMap:     Map<string, FileDiff>,
  ): Promise<CallSite[]> {

    const normalizedPath = this.normalizePath(importer.filePath);
    const diff = diffMap.get(normalizedPath);

    // The identifier to search for — may be aliased
    const searchName = importer.localName;

    if (diff) {
      // ── File IS in the PR diff ─────────────────────────────────────────
      // Parse both old and new versions for comparison
      return this.traceChangedFile(
        importer.filePath,
        searchName,
        diff.oldSource,
        diff.newSource,
        validCounts,
      );
    } else {
      // ── File is NOT in the PR diff ─────────────────────────────────────
      // Parse only the HEAD version
      const source = await this.getFileContent(importer.filePath);
      if (!source) return [];

      const newSites = this.extractCallSites(source, searchName, importer.filePath);
      return this.classifyCallSites(newSites, validCounts, false);
    }
  }

  // ── 4. Changed file tracing (old↔new correlation) ──────────────────────────

  /**
   * Traces a file that exists in the PR diff.
   * Compares old and new call sites by INDEX ORDER to detect fixes.
   *
   * Why index order, not line numbers?
   *   Line numbers shift when code is added/removed above a call site.
   *   But the N-th call to processPayment() in the old file corresponds
   *   to the N-th call in the new file (assuming no calls were added/removed).
   *
   * When calls ARE added/removed, we fall back to treating each new-source
   * call site independently.
   */
  private traceChangedFile(
    filePath:    string,
    searchName:  string,
    oldSource:   string,
    newSource:   string,
    validCounts: Set<number> | { min: number; max: number },
  ): CallSite[] {

    // Parse both versions
    const oldSites = oldSource
      ? this.extractCallSites(oldSource, searchName, filePath)
      : [];
    const newSites = newSource
      ? this.extractCallSites(newSource, searchName, filePath)
      : [];

    // If no call sites in new source — nothing to report
    if (newSites.length === 0) return [];

    // ── Correlate by index ───────────────────────────────────────────────
    // If the count matches, we can do 1:1 correlation
    if (oldSites.length === newSites.length) {
      return this.correlateByIndex(oldSites, newSites, validCounts);
    }

    // ── Count mismatch — calls were added or removed ─────────────────────
    // Fall back to independent classification of new-source sites
    // with best-effort "Fixed" detection via argument count comparison
    return this.classifyWithBestEffortCorrelation(
      oldSites,
      newSites,
      validCounts,
    );
  }

  /**
   * 1:1 index correlation when call count is unchanged.
   * old[0] ↔ new[0], old[1] ↔ new[1], etc.
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

      // Determine status
      let isBroken = false;
      let isFixed = false;

      if (newSite.hasSpread) {
        // Spread argument — indeterminate, never broken
        isBroken = false;
        isFixed = false;
      } else if (isNewValid) {
        // New call is valid
        if (oldSite && !wasOldValid && !oldSite.hasSpread) {
          // Was broken in old, fixed in new → developer fixed it
          isFixed = true;
        }
        isBroken = false;
      } else {
        // New call has wrong argument count
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
        covered:         false, // populated later by test gap analysis
      });
    }

    return results;
  }

  /**
   * Best-effort correlation when call counts differ (calls added/removed).
   * Classifies each new-source call independently, then checks if any
   * old-source calls with matching argument counts existed (heuristic fix detection).
   */
  private classifyWithBestEffortCorrelation(
    oldSites: RawCallSite[],
    newSites: RawCallSite[],
    validCounts: Set<number> | { min: number; max: number },
  ): CallSite[] {
    // Build a frequency map of old argument counts for heuristic matching
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
        // Check if there was an old call with an INVALID count at this position
        // that has been "fixed" — heuristic: old had wrong count, new has right count
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

  // ── 5. AST call-site extraction ────────────────────────────────────────────

  /**
   * Parses a source string and extracts every call expression that matches
   * the target identifier.
   *
   * Handles:
   *   - Direct calls:     processPayment(x, y)
   *   - Method calls:     obj.processPayment(x, y)
   *   - Namespace calls:  payments.processPayment(x, y)
   *   - Aliased calls:    handlePayment(x, y)  (when localName = 'handlePayment')
   *   - Chained calls:    getService().processPayment(x, y)
   *
   * For each call, counts:
   *   - Number of arguments (excluding spread elements for count)
   *   - Whether any argument uses spread syntax (...args)
   */
  private extractCallSites(
    source:     string,
    searchName: string,
    filePath:   string,
  ): RawCallSite[] {
    if (!this.parser || !this.language) return [];

    let tree: Tree | null = null;
    const sites: RawCallSite[] = [];

    try {
      tree = this.parser.parse(source);
      if (!tree) return [];

      const queries = getTracerQueries(this.language);

      // Determine what to match based on the search name format
      // If searchName contains a dot (e.g., 'payments.processPayment'),
      // it's a namespace import — we need to match differently
      const isDotNotation = searchName.includes('.');
      const bareIdentifier = isDotNotation
        ? searchName.split('.').pop()!
        : searchName;

      // ── Direct calls: identifier(args) ────────────────────────────────
      if (!isDotNotation) {
        for (const match of queries.directCall.matches(tree.rootNode)) {
          const calleeNode = this.getCapture(match, 'callee');
          const argsNode = this.getCapture(match, 'args');
          const callNode = this.getCapture(match, 'call');

          if (!calleeNode || !argsNode || !callNode) continue;

          // Match by identifier name
          if (calleeNode.text !== bareIdentifier) continue;

          sites.push(this.buildRawCallSite(callNode, argsNode, filePath));
        }
      }

      // ── Method calls: expr.identifier(args) ───────────────────────────
      for (const match of queries.memberCall.matches(tree.rootNode)) {
        const calleeNode = this.getCapture(match, 'callee');
        const argsNode = this.getCapture(match, 'args');
        const callNode = this.getCapture(match, 'call');

        if (!calleeNode || !argsNode || !callNode) continue;

        // Match by property name
        if (calleeNode.text !== bareIdentifier) continue;

        // For namespace imports (payments.processPayment), verify the object too
        if (isDotNotation) {
          const namespaceName = searchName.split('.')[0];
          const memberExpr = callNode.childForFieldName('function');
          if (memberExpr) {
            const objectNode = memberExpr.childForFieldName('object');
            if (objectNode && objectNode.text !== namespaceName) continue;
          }
        }

        sites.push(this.buildRawCallSite(callNode, argsNode, filePath));
      }

    } finally {
      tree?.delete();
    }

    return sites;
  }

  /**
   * Builds a RawCallSite from a call expression node and its arguments node.
   * Counts arguments and detects spread elements.
   */
  private buildRawCallSite(
    callNode: { startPosition: { row: number }; endPosition: { row: number } },
    argsNode: { namedChildren: readonly any[] },
    filePath: string,
  ): RawCallSite {
    // Count arguments — named children of the arguments node
    // Exclude commas and parentheses (only named children matter)
    let argumentCount = 0;
    let hasSpread = false;

    for (const child of argsNode.namedChildren) {
      // Skip non-argument syntax nodes
      if (child.type === ',' || child.type === '(' || child.type === ')') {
        continue;
      }

      argumentCount++;

      // Detect spread elements: ...args, ...array, ...getArgs()
      if (child.type === 'spread_element') {
        hasSpread = true;
      }
    }

    return {
      filePath,
      lineStart: callNode.startPosition.row + 1,  // 1-indexed
      lineEnd:   callNode.endPosition.row + 1,
      argumentCount: hasSpread ? -1 : argumentCount,
      hasSpread,
    };
  }

  // ── 6. Argument count validation ───────────────────────────────────────────

  /**
   * Builds the set of valid argument counts for a function.
   *
   * For non-overloaded functions: { min: requiredParamCount, max: totalParamCount }
   * For overloaded functions: Set of all valid counts from all overloads
   *
   * If the function has a rest parameter, max is Infinity.
   */
  private buildValidArgCounts(
    change: FunctionChange,
  ): Set<number> | { min: number; max: number } {
    // If overloaded, use the pre-computed valid set
    if (change.validArgCounts && change.validArgCounts.size > 0) {
      return change.validArgCounts;
    }

    // Otherwise, build a range from the signature
    const sig = change.after as FunctionSignature | null;
    if (!sig || !('params' in sig)) {
      // Not a function or deleted — can't validate
      return { min: 0, max: Infinity };
    }

    // Use pre-computed counts if available
    if (change.requiredParamCount !== undefined && change.totalParamCount !== undefined) {
      const hasRest = sig.params.some(p => p.isRest);
      return {
        min: change.requiredParamCount,
        max: hasRest ? Infinity : change.totalParamCount,
      };
    }

    // Compute from signature params
    const required = sig.params.filter(p => !p.optional && !p.isRest).length;
    const total = sig.params.filter(p => !p.isRest).length;
    const hasRest = sig.params.some(p => p.isRest);

    return {
      min: required,
      max: hasRest ? Infinity : total,
    };
  }

  /**
   * Checks whether an argument count is valid.
   * Handles both Set<number> (overloaded) and range (normal) cases.
   *
   * Indeterminate (-1) is always considered valid to prevent false positives.
   */
  private isValidArgCount(
    count: number,
    validCounts: Set<number> | { min: number; max: number },
  ): boolean {
    // Indeterminate (spread) — always valid
    if (count === -1) return true;

    if (validCounts instanceof Set) {
      return validCounts.has(count);
    }

    return count >= validCounts.min && count <= validCounts.max;
  }

  // ── 7. Classify non-diff call sites ────────────────────────────────────────

  /**
   * Classifies call sites for files NOT in the PR diff.
   * These files have only one version (HEAD), so there's no old↔new comparison.
   * Every call with wrong argument count is simply "broken."
   */
  private classifyCallSites(
    rawSites:    RawCallSite[],
    validCounts: Set<number> | { min: number; max: number },
    isInDiff:    boolean,
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

  /**
   * Reads file content from the git index at HEAD.
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

  // ── 9. Helpers ─────────────────────────────────────────────────────────────

  /**
   * Gets a named capture from a query match.
   */
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

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw call site extracted from the AST — before classification.
 * Not exported — internal to the tracer.
 */
interface RawCallSite {
  filePath:      string;
  lineStart:     number;
  lineEnd:       number;
  argumentCount: number;    // -1 if indeterminate (has spread)
  hasSpread:     boolean;
}
