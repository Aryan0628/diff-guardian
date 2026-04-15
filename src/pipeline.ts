import { extractGitSources } from './parsers/git-diff';
import { ASTMapper } from './parsers/ast-mapper';
import { ClassifierEngine } from './classifier/engine';
import { AnalysisResult, FunctionChange } from './core/types';
import { TerminalReporter } from './reporter/terminal';
import { GithubReporter } from './reporter/github';
import { JsonReporter } from './reporter/json';
import { ReporterConfig } from './reporter/types';

export interface PipelineOptions {
  baseSha: string;
  headSha: string;
  repoRoot?: string;
  config: ReporterConfig;
}

export async function runPipeline(opts: PipelineOptions): Promise<number> {
  // 1. Extract sources
  const diffs = await extractGitSources(opts.baseSha, opts.headSha, opts.repoRoot);
  
  // 2. Parse ASTs
  const mapper = new ASTMapper();
  await mapper.init();
  const parsedDiffs = await mapper.buildSignatureCache(diffs);

  // 3. Classify changes
  const engine = new ClassifierEngine();
  const allChanges: FunctionChange[] = [];
  
  for (const diff of parsedDiffs) {
    if (diff.skipped) continue;
    const fileChanges = engine.compare(diff);
    allChanges.push(...fileChanges);
  }

  // 4. Aggregate
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

  // 5. Report
  if (opts.config.format === 'github') {
    await GithubReporter.render(result, opts.config);
  } else if (opts.config.format === 'json') {
    await JsonReporter.render(result, opts.config);
  } else {
    await TerminalReporter.render(result, opts.config);
  }

  // 6. Return exit code
  const hasBreaks = result.breaking.length > 0;
  if (hasBreaks && opts.config.mode === 'strict') {
    return 1;
  }
  if (opts.config.failOnWarnings && result.warnings.length > 0) {
    return 1;
  }
  return 0;
}
