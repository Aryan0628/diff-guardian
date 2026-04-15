import { AnalysisResult } from '../core/types';
import { Reporter, ReporterConfig } from './types';

// Used to identify the DG comment to update instead of spamming
const COMMENT_MARKER = '<!-- dg-report -->';

export const GithubReporter: Reporter = {
  async render(result: AnalysisResult, config: ReporterConfig): Promise<void> {
    if (!config.githubToken || !config.prNumber || !config.repoSlug) {
      console.warn('[github-reporter] Missing githubToken, prNumber, or repoSlug. Skipping PR comment.');
      console.warn(`  githubToken: ${config.githubToken ? 'present' : 'MISSING'}`);
      console.warn(`  prNumber: ${config.prNumber ?? 'MISSING'}`);
      console.warn(`  repoSlug: ${config.repoSlug ?? 'MISSING'}`);
      return;
    }

    let markdown = `${COMMENT_MARKER}\n\n`;
    markdown += `## Diff-Guardian API Audit\n\n`;
    
    if (result.breaking.length > 0) {
      markdown += `### [BREAKING] Changes (${result.breaking.length})\n\n`;
      markdown += `| File | Symbol | Type | Message |\n`;
      markdown += `|------|--------|------|---------|` + '\n';
      for (const c of result.breaking) {
        markdown += `| \`${c.file}:${c.lineStart}\` | **${c.name}** | \`${c.changeType}\` | ${c.message || ''} |\n`;
      }
      markdown += '\n';
    } else {
      markdown += `### [SAFE] No Breaking API Changes\n\n`;
    }

    if (result.warnings.length > 0) {
      markdown += `### [WARNING] Non-Breaking Issues (${result.warnings.length})\n\n`;
      for (const c of result.warnings) {
        markdown += `- **${c.name}** (\`${c.changeType}\`): ${c.message || ''}\n`;
      }
      markdown += '\n';
    }

    const safeCount = result.apiChanges.length - result.breaking.length - result.warnings.length;
    if (safeCount > 0) {
      markdown += `### [SAFE] Additions / Expansions: ${safeCount}\n\n`;
    }

    const baseShaDisplay = result.baseSha.length > 7 ? result.baseSha.substring(0, 7) : result.baseSha;
    const headShaDisplay = result.headSha.length > 7 ? result.headSha.substring(0, 7) : result.headSha;
    markdown += `---\n`;
    markdown += `_Analyzed ${result.apiChanges.length} total API surface changes. Comparing \`${headShaDisplay}\` against \`${baseShaDisplay}\`._\n`;

    try {
      const url = `https://api.github.com/repos/${config.repoSlug}/issues/${config.prNumber}/comments`;
      const headers: Record<string, string> = {
        'Authorization': `token ${config.githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'diff-guardian'
      };

      // 1. Find existing DG comment
      const listRes = await fetch(url, { headers });
      if (!listRes.ok) {
        throw new Error(`Failed to fetch PR comments (${listRes.status}): ${listRes.statusText}`);
      }
      const comments = await listRes.json() as any[];
      
      const existing = comments.find((c: any) => c.body && c.body.includes(COMMENT_MARKER));

      if (existing) {
        // 2. Update existing comment (no spam)
        const updateRes = await fetch(existing.url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body: markdown })
        });
        if (!updateRes.ok) {
          throw new Error(`Failed to update comment (${updateRes.status}): ${updateRes.statusText}`);
        }
        console.log(`[github-reporter] Updated existing PR comment #${existing.id}`);
      } else {
        // 3. Create new comment
        const createRes = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: markdown })
        });
        if (!createRes.ok) {
          throw new Error(`Failed to create comment (${createRes.status}): ${createRes.statusText}`);
        }
        console.log(`[github-reporter] Created new PR comment`);
      }
    } catch (e: any) {
      console.warn(`\n[github-reporter] Failed to post PR comment: ${e.message}`);
    }
  }
};
