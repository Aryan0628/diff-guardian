/**
 * src/index.ts
 *
 * Public API entry point for programmatic usage:
 *   const { runPipeline } = require('diff-guardian');
 *
 * Not used by the CLI (which enters via cli.ts).
 * This module re-exports the pipeline and core types
 * so library consumers can integrate DG into custom tooling.
 */

export { runPipeline } from './pipeline';
export { ClassifierEngine } from './classifier/engine';
export { ASTMapper } from './parsers/ast-mapper';
export { extractGitSources, WORKING_TREE, STAGED } from './parsers/git-diff';

export type { PipelineOptions } from './pipeline';
export type { ReporterConfig } from './reporter/types';
export type {
  AnalysisResult,
  FunctionChange,
  FileDiff,
  ParseResult,
  FunctionSignature,
  InterfaceSignature,
  EnumSignature,
} from './core/types';
