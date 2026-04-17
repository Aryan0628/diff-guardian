import { AnalysisResult } from '../core/types';

export interface ReporterConfig {
  mode: 'strict' | 'warn';
  format?: 'terminal' | 'github' | 'json';
  githubToken?: string;
  prNumber?: number;
  repoSlug?: string;
  failOnWarnings?: boolean; // Added per config
  quiet?: boolean;
  reportFile?: string;      // If set, write JSON AnalysisResult to this path
  hookContext?: 'pre-push' | 'pre-merge-commit' | 'post-merge';  // Set via DG_HOOK env var
}

export interface Reporter {
  render(result: AnalysisResult, config: ReporterConfig): Promise<void>;
}
