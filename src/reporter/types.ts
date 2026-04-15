import { AnalysisResult } from '../core/types';

export interface ReporterConfig {
  mode: 'strict' | 'warn';
  format?: 'terminal' | 'github' | 'json';
  githubToken?: string;
  prNumber?: number;
  repoSlug?: string;
  failOnWarnings?: boolean; // Added per config
  quiet?: boolean;
}

export interface Reporter {
  render(result: AnalysisResult, config: ReporterConfig): Promise<void>;
}
