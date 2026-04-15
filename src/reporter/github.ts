import { AnalysisResult } from '../core/types';
import { Reporter, ReporterConfig } from './types';

// Used to identify the DG comment to update instead of spamming
const COMMENT_MARKER = '<!-- dg-report -->';

export const GithubReporter: Reporter = {
  async render(result: AnalysisResult, config: ReporterConfig): Promise<void> {
    if (!config.githubToken || !config.prNumber || !config.repoSlug) {
      console.warn('[github-reporter] Missing githubToken, prNumber, or repoSlug. Skipping PR comment.');
      return;
    }

    let markdown = `${COMMENT_MARKER}\n\n`;
    
    if (result.breaking.length > 0) {
      markdown += `## [BREAKING] API Changes Found (${result.breaking.length})\n\n`;
      markdown += `| File | Symbol | Type | Message |\n`;
      markdown += `|------|--------|------|---------|\n`;
      for (const c of result.breaking) {
        markdown += `| \`${c.file}:${c.lineStart}\` | **${c.name}** | \`${c.changeType}\` | ${c.message} |\n`;
      }
      markdown += '\n';
    } else {
      markdown += `## [SAFE] No Breaking API Changes\n\n`;
    }

    if (result.warnings.length > 0) {
      markdown += `### [WARNINGS] Non-breaking Issues (${result.warnings.length})\n\n`;
      for (const c of result.warnings) {
        markdown += `- **${c.name}** (\`${c.changeType}\`): ${c.message}\n`;
      }
      markdown += '\n';
    }

    const safeCount = result.apiChanges.length - result.breaking.length - result.warnings.length;
    markdown += `_Analyzed ${result.apiChanges.length} total API surface changes (${safeCount} safe). Comparing \`${result.headSha.substring(0,7)}\` to \`${result.baseSha.substring(0,7)}\`._\n`;

    try {
      const url = `https://api.github.com/repos/${config.repoSlug}/issues/${config.prNumber}/comments`;
      const headers = {
        'Authorization': `token ${config.githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'diff-guardian'
      };

      // 1. Find existing
      const listRes = await fetch(url, { headers });
      if (!listRes.ok) throw new Error(`Failed to fetch comments: ${listRes.statusText}`);
      const comments = await listRes.json();
      
      const existing = comments.find((c: any) => c.body && c.body.includes(COMMENT_MARKER));

      if (existing) {
        // 2. Update
        const updateRes = await fetch(existing.url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body: markdown })
        });
        if (!updateRes.ok) throw new Error(`Failed to update comment: ${updateRes.statusText}`);
      } else {
        // 3. Create
        const createRes = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: markdown })
        });
        if (!createRes.ok) throw new Error(`Failed to create comment: ${createRes.statusText}`);
      }
    } catch (e: any) {
      console.warn(`\n[github-reporter] Failed to post PR comment: ${e.message}`);
    }
  }
};
