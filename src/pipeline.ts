import * as fs from 'fs';
import * as path from 'path';
import { extractGitSources } from './parsers/git-diff';
import { ASTMapper } from './parsers/ast-mapper';
import { ClassifierEngine } from './classifier/engine';
import { AnalysisResult, FunctionChange, FunctionSignature, EnumSignature, FileDiff } from './core/types';
import { TerminalReporter } from './reporter/terminal';
import { GithubReporter } from './reporter/github';
import { JsonReporter } from './reporter/json';
import { ReporterConfig } from './reporter/types';
import { JITScanner, CallSiteTracer, createDefaultTracerConfig } from './tracer';

export interface PipelineOptions {
  baseSha: string;
  headSha: string;
  repoRoot?: string;
  config: ReporterConfig;
  pathFilter?: string;       // optional path prefix to scope analysis (e.g., 'src/payments')
}

// ─────────────────────────────────────────────────────────────────────────────
// Change types that warrant call-site tracing.
// Functions: argument count mismatches (signature_change, symbol_deleted)
// Enums:     removed/changed member access (enum_member_changed)
// Tracing `symbol_added` (safe) or `modifier_changed` is wasted work.
// ─────────────────────────────────────────────────────────────────────────────

const TRACEABLE_FN_CHANGE_TYPES = new Set([
  'signature_change',
  'symbol_deleted',
]);

const TRACEABLE_ENUM_CHANGE_TYPES = new Set([
  'enum_member_changed',
]);

/**
 * Determines whether a FunctionChange should be traced for call sites.
 *
 * Functions: trace when argument count may be wrong.
 * Enums:     trace when members were removed or values changed.
 */
function isTraceable(change: FunctionChange): boolean {
  if (!change.breaking) return false;

  if (change.symbolType === 'function') {
    return TRACEABLE_FN_CHANGE_TYPES.has(change.changeType);
  }

  if (change.symbolType === 'enum') {
    return TRACEABLE_ENUM_CHANGE_TYPES.has(change.changeType);
  }

  return false;
}

export async function runPipeline(opts: PipelineOptions): Promise<number> {
  const repoRoot = opts.repoRoot || process.cwd();

  // ── 1. Extract sources ─────────────────────────────────────────────────────
  const diffs = await extractGitSources(opts.baseSha, opts.headSha, repoRoot, opts.pathFilter);
  
  // ── 2. Parse ASTs ──────────────────────────────────────────────────────────
  const mapper = new ASTMapper();
  await mapper.init();
  const parsedDiffs = await mapper.buildSignatureCache(diffs);

  // ── 3. Classify changes ────────────────────────────────────────────────────
  const engine = new ClassifierEngine();
  const allChanges: FunctionChange[] = [];
  
  for (const diff of parsedDiffs) {
    if (diff.skipped) continue;
    const fileChanges = engine.compare(diff);
    allChanges.push(...fileChanges);
  }

  // ── 3.5 Compute tracer metadata for traceable changes ──────────────────────
  // Functions: expected argument range from 'after' signature
  // Enums: removed/changed member names from before/after signatures
  for (const change of allChanges) {
    if (!isTraceable(change)) continue;

    if (change.symbolType === 'function') {
      computeParamCounts(change);
    } else if (change.symbolType === 'enum') {
      computeEnumMetadata(change);
    }
  }

  // ── 3.6 JIT Trace: Scan → Trace call sites ────────────────────────────────
  // This is the Lazy Graph in action. For each breaking change:
  //   Functions: Scanner finds importers → Tracer counts arguments
  //   Enums:    Scanner finds importers → Tracer finds EnumName.Member access
  const traceableChanges = allChanges.filter(isTraceable);

  if (traceableChanges.length > 0) {
    await traceCallSites(traceableChanges, diffs, repoRoot, opts.headSha);
  }

  // ── 4. Aggregate ───────────────────────────────────────────────────────────
  const result: AnalysisResult = {
    from: opts.baseSha,
    to: opts.headSha,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    breaking: allChanges.filter(c => c.severity === 'breaking'),
    warnings: allChanges.filter(c => c.severity === 'warning'),
    apiChanges: allChanges,
    testGaps: [],
    riskFiles: []
  };

  // ── 5. Report ──────────────────────────────────────────────────────────────
  if (opts.config.format === 'github') {
    await GithubReporter.render(result, opts.config);
  } else if (opts.config.format === 'json') {
    await JsonReporter.render(result, opts.config);
  } else {
    await TerminalReporter.render(result, opts.config);
  }

  // ── 5.5 Write JSON report file (if requested) ──────────────────────────────
  if (opts.config.reportFile) {
    try {
      const reportPath = path.resolve(repoRoot, opts.config.reportFile);
      fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`[pipeline] Report written to ${opts.config.reportFile}`);
    } catch (err: any) {
      console.warn(`[pipeline] Failed to write report file: ${err.message}`);
    }
  }

  // ── 6. Return exit code ────────────────────────────────────────────────────
  const hasBreaks = result.breaking.length > 0;
  if (hasBreaks && opts.config.mode === 'strict') {
    return 1;
  }
  if (opts.config.failOnWarnings && result.warnings.length > 0) {
    return 1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracer metadata computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes requiredParamCount and totalParamCount from the function's
 * 'after' signature. Consumed by the tracer to determine
 * whether each call site has the right number of arguments.
 */
function computeParamCounts(change: FunctionChange): void {
  const sig = change.after as FunctionSignature | null;
  if (!sig || !('params' in sig)) return;

  change.requiredParamCount = sig.params.filter(
    p => !p.optional && !p.isRest
  ).length;

  change.totalParamCount = sig.params.filter(
    p => !p.isRest
  ).length;
}

/**
 * Computes removedEnumMembers and changedEnumMembers by diffing the
 * before/after EnumSignatures. Consumed by the tracer to find
 * broken EnumName.MemberName access patterns.
 */
function computeEnumMetadata(change: FunctionChange): void {
  const oldSig = change.before as EnumSignature | null;
  const newSig = change.after as EnumSignature | null;

  if (!oldSig || !('members' in oldSig)) return;

  const removed: string[] = [];
  const changed: string[] = [];

  for (const oldMember of oldSig.members) {
    const newMember = newSig?.members.find(m => m.name === oldMember.name);

    if (!newMember) {
      // Member was deleted — any EnumName.MemberName usage is a compile error
      removed.push(oldMember.name);
    } else if (
      oldMember.value !== undefined &&
      newMember.value !== undefined &&
      oldMember.value !== newMember.value
    ) {
      // Member value changed — runtime data corruption risk
      changed.push(oldMember.name);
    }
  }

  if (removed.length > 0) change.removedEnumMembers = removed;
  if (changed.length > 0) change.changedEnumMembers = changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Call-site tracing orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orchestrates the Scanner (Phase 2) and Tracer (Phase 3) for all
 * traceable breaking changes — both functions and enums.
 *
 * This function:
 *   1. Creates the scanner and tracer instances
 *   2. For each breaking change, scans for importers
 *   3. Traces exact call sites (functions) or member access (enums)
 *   4. Attaches the resolved call sites back to the FunctionChange
 */
async function traceCallSites(
  changes:  FunctionChange[],
  diffs:    FileDiff[],
  repoRoot: string,
  headSha:  string,
): Promise<void> {
  // Create config with sensible defaults
  const tracerConfig = createDefaultTracerConfig(repoRoot, headSha);

  // Initialize scanner and tracer
  const scanner = new JITScanner(tracerConfig);
  const tracer  = new CallSiteTracer(tracerConfig);

  try {
    await tracer.init();
  } catch (err: any) {
    // If tracer init fails (missing grammar, etc.), log and skip gracefully.
    // The pipeline still produces correct classifier output — just without call sites.
    console.warn(
      `[pipeline] Call-site tracer initialization failed: ${err.message}\n` +
      `   Call-site tracking will be disabled for this run.`
    );
    return;
  }

  let totalCallSites = 0;

  for (const change of changes) {
    try {
      // ── Resolve the scannable symbol name ──────────────────────────────
      // Function names are bare: 'processPayment'
      // Enum names have a prefix: 'enum:Status' → strip to 'Status'
      const symbolName = change.name.startsWith('enum:')
        ? change.name.slice(5)
        : change.name;

      // Phase 2: Scan for importers
      const importers = await scanner.scan(symbolName, change.file);
      if (importers.length === 0) continue;

      // Phase 3: Trace — strategy depends on symbol type
      if (change.symbolType === 'enum') {
        // ── Enum tracing: find EnumName.RemovedMember access patterns ────
        const allBrokenMembers = [
          ...(change.removedEnumMembers || []),
          ...(change.changedEnumMembers || []),
        ];

        if (allBrokenMembers.length === 0) continue;

        const tracerResult = await tracer.traceEnum(
          symbolName,
          allBrokenMembers,
          change.removedEnumMembers || [],
          change.changedEnumMembers || [],
          importers,
          diffs,
        );

        change.callers = tracerResult.callSites;
        totalCallSites += tracerResult.callSites.length;

        for (const err of tracerResult.errors) {
          console.warn(`[pipeline] ${err}`);
        }
      } else {
        // ── Function tracing: count arguments ────────────────────────────
        const tracerResult = await tracer.trace(change, importers, diffs);

        change.callers = tracerResult.callSites;
        totalCallSites += tracerResult.callSites.length;

        for (const err of tracerResult.errors) {
          console.warn(`[pipeline] ${err}`);
        }
      }
    } catch (err: any) {
      // Non-fatal — one symbol failing doesn't block the rest
      console.warn(
        `[pipeline] Failed to trace call sites for "${change.name}": ${err.message}`
      );
    }
  }

  if (totalCallSites > 0) {
    console.log(
      `[pipeline] Traced ${totalCallSites} call site(s) across ${changes.length} breaking change(s)`
    );
  }
}
