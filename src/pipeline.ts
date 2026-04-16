import { extractGitSources } from './parsers/git-diff';
import { ASTMapper } from './parsers/ast-mapper';
import { ClassifierEngine } from './classifier/engine';
import { AnalysisResult, FunctionChange, FunctionSignature, FileDiff } from './core/types';
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Change types that warrant call-site tracing.
// We only trace breaking function changes where argument count matters.
// Tracing `symbol_added` (safe) or `modifier_changed` is wasted work.
// ─────────────────────────────────────────────────────────────────────────────

const TRACEABLE_CHANGE_TYPES = new Set([
  'signature_change',
  'symbol_deleted',
]);

/**
 * Determines whether a FunctionChange should be traced for call sites.
 * Only function-type breaking changes with signature modifications are traceable.
 */
function isTraceable(change: FunctionChange): boolean {
  return (
    change.breaking &&
    change.symbolType === 'function' &&
    TRACEABLE_CHANGE_TYPES.has(change.changeType)
  );
}

export async function runPipeline(opts: PipelineOptions): Promise<number> {
  const repoRoot = opts.repoRoot || process.cwd();

  // ── 1. Extract sources ─────────────────────────────────────────────────────
  const diffs = await extractGitSources(opts.baseSha, opts.headSha, repoRoot);
  
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

  // ── 3.5 Compute param counts for traceable changes ─────────────────────────
  // The tracer needs to know the expected argument range for each broken function.
  // We compute this from the classifier's output — the 'after' signature.
  for (const change of allChanges) {
    if (!isTraceable(change)) continue;
    computeParamCounts(change);
  }

  // ── 3.6 JIT Trace: Scan → Trace call sites ────────────────────────────────
  // This is the Lazy Graph in action. For each breaking function change:
  //   1. Scanner (Phase 2): git grep for files importing the function
  //   2. Tracer  (Phase 3): AST-parse only those files for exact call sites
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
// Param count computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes requiredParamCount and totalParamCount from the function's
 * 'after' signature. These are consumed by the tracer to determine
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

  // If the function has overloads, build the valid argument count set
  // by looking at the overload count. For now, we use the range approach
  // since we only have the implementation signature in 'after'.
  // Full overload set computation would require access to all overload sigs.
}

// ─────────────────────────────────────────────────────────────────────────────
// Call-site tracing orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orchestrates the Scanner (Phase 2) and Tracer (Phase 3) for all
 * traceable breaking changes.
 *
 * This function:
 *   1. Creates the scanner and tracer instances
 *   2. For each breaking function change, scans for importers
 *   3. Traces exact call sites in each importer file
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
      // Phase 2: Scan for importers
      const importers = await scanner.scan(change.name, change.file);

      if (importers.length === 0) continue;

      // Phase 3: Trace exact call sites
      const tracerResult = await tracer.trace(change, importers, diffs);

      // Attach resolved call sites back to the FunctionChange
      change.callers = tracerResult.callSites;
      totalCallSites += tracerResult.callSites.length;

      // Log non-fatal tracer errors
      for (const err of tracerResult.errors) {
        console.warn(`[pipeline] ${err}`);
      }
    } catch (err: any) {
      // Non-fatal — one function failing doesn't block the rest
      console.warn(
        `[pipeline] Failed to trace call sites for "${change.name}": ${err.message}`
      );
    }
  }

  if (totalCallSites > 0) {
    console.log(
      `[pipeline] Traced ${totalCallSites} call site(s) across ${changes.length} breaking function(s)`
    );
  }
}
