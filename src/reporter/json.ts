import { AnalysisResult } from '../core/types';
import { Reporter, ReporterConfig } from './types';

export const JsonReporter: Reporter = {
  async render(result: AnalysisResult, config: ReporterConfig): Promise<void> {
    if (!config.quiet) {
      console.log(JSON.stringify(result, null, 2));
    }
  }
};
