/**
 * src/reporter/github.ts
 *
 * THE GITHUB REPORTER.
 * Posts a structured PR comment via the GitHub REST API.
 * Requires: GITHUB_TOKEN, PR number, and repo slug.
 *
 * Edge cases handled:
 *  - Missing config (token / prNumber / repoSlug) — warnings printed, fast return
 *  - GitHub API pagination: fetches up to 100 comments to find existing DG comment
 *  - `fetch` network failures — caught, warning printed, pipeline NOT blocked
 *  - `result` fields may be empty arrays — always safe to iterate
 *  - `change.message` may be undefined — falls back to change type label
 *  - `change.file` / `change.name` may be empty — safe fallbacks applied
 *  - Markdown table pipes in messages sanitized to avoid breaking table layout
 *  - baseSha / headSha may be short branch names — no unsafe substring call
 *  - GitHub token never logged — only existence is confirmed
 */

import { AnalysisResult, FunctionChange } from '../core/types';
import { Reporter, ReporterConfig } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Injected into every comment so we can find-and-update instead of spamming. */
const COMMENT_MARKER = '<!-- dg-report -->';

const GITHUB_API_BASE = 'https://api.github.com';

// ─────────────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────────────

export const GithubReporter: Reporter = {
  async render(result: AnalysisResult, config: ReporterConfig): Promise<void> {

    // ── Guard: required config ───────────────────────────────────────────────
    if (!config.githubToken || !config.prNumber || !config.repoSlug) {
      console.warn('[github-reporter] Cannot post PR comment — missing required config:');
      console.warn(`  GITHUB_TOKEN:        ${config.githubToken    ? 'present' : 'MISSING'}`);
      console.warn(`  PR number:           ${config.prNumber       ?? 'MISSING'}`);
      console.warn(`  Repository slug:     ${config.repoSlug       ?? 'MISSING'}`);
      return;
    }

    // ── Guard: malformed result ──────────────────────────────────────────────
    if (!result) {
      console.warn('[github-reporter] Received null result — skipping comment.');
      return;
    }

    const breaking   = Array.isArray(result.breaking)   ? result.breaking   : [];
    const warnings   = Array.isArray(result.warnings)   ? result.warnings   : [];
    const allChanges = Array.isArray(result.apiChanges) ? result.apiChanges : [];
    const safeCount  = Math.max(0, allChanges.length - breaking.length - warnings.length);

    // ── Build markdown ───────────────────────────────────────────────────────
    const markdown = buildMarkdown(result, breaking, warnings, allChanges, safeCount, config);

    // ── Post to GitHub ───────────────────────────────────────────────────────
    try {
      await upsertComment(config, markdown);
    } catch (e: any) {
      // Never block the pipeline over a reporting failure.
      console.warn(`\n[github-reporter] Failed to post PR comment: ${e.message}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Markdown builder
// ─────────────────────────────────────────────────────────────────────────────

function buildMarkdown(
  result:    AnalysisResult,
  breaking:  FunctionChange[],
  warnings:  FunctionChange[],
  allChanges: FunctionChange[],
  safeCount: number,
  config:    ReporterConfig,
): string {
  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  lines.push('');
  lines.push('## Diff-Guardian API Audit');
  lines.push('');

  // ── Breaking ──────────────────────────────────────────────────────────────
  if (breaking.length > 0) {
    lines.push(`### [BREAKING] Changes (${breaking.length})`);
    lines.push('');
    lines.push('| File | Symbol | Type | Message |');
    lines.push('|------|--------|------|---------|');
    for (const c of breaking) {
      lines.push(formatTableRow(c));
    }
    lines.push('');

    // ── Call-site details (populated by the JIT tracer) ─────────────────
    const changesWithCallers = breaking.filter(c => c.callers && c.callers.length > 0);
    if (changesWithCallers.length > 0) {
      lines.push('<details>');
      lines.push('<summary><strong>📍 Affected Call Sites</strong></summary>');
      lines.push('');

      for (const c of changesWithCallers) {
        const name = sanitizeInline(c.name || '<anonymous>');
        const callers = c.callers;

        const broken  = callers.filter(s => s.isBroken);
        const fixed   = callers.filter(s => s.isFixed);
        const indeterminate = callers.filter(s => s.isIndeterminate);
        const ok      = callers.filter(s => !s.isBroken && !s.isFixed && !s.isIndeterminate);

        lines.push(`#### \`${name}\` — ${callers.length} call site(s)`);
        lines.push('');

        // Broken
        for (const site of broken) {
          const expected = c.requiredParamCount !== undefined && c.totalParamCount !== undefined
            ? c.requiredParamCount === c.totalParamCount
              ? `${c.requiredParamCount}`
              : `${c.requiredParamCount}-${c.totalParamCount}`
            : '?';
          lines.push(
            `- ❌ \`${sanitizeInline(site.file)}:${site.lineStart}\` — ` +
            `provides ${site.argumentCount} arg(s), needs ${expected}`
          );
        }

        // Fixed
        for (const site of fixed) {
          lines.push(
            `- ✅ \`${sanitizeInline(site.file)}:${site.lineStart}\` — ` +
            `Fixed by developer in this PR`
          );
        }

        // Indeterminate
        for (const site of indeterminate) {
          lines.push(
            `- ⚠️ \`${sanitizeInline(site.file)}:${site.lineStart}\` — ` +
            `uses spread args (indeterminate)`
          );
        }

        // OK
        if (ok.length > 0) {
          lines.push(`- ✓ ${ok.length} other call site(s) have correct arguments`);
        }

        lines.push('');
      }

      lines.push('</details>');
      lines.push('');
    }
  } else {
    lines.push('### [SAFE] No Breaking API Changes');
    lines.push('');
  }

  // ── Warnings ─────────────────────────────────────────────────────────────
  if (warnings.length > 0) {
    lines.push(`### [WARNING] Non-Breaking Issues (${warnings.length})`);
    lines.push('');
    for (const c of warnings) {
      const name       = sanitizeInline(c.name       || '<anonymous>');
      const changeType = sanitizeInline(c.changeType || 'unknown');
      const message    = sanitizeInline(c.message    || changeType);
      lines.push(`- **${name}** (\`${changeType}\`): ${message}`);
    }
    lines.push('');
  }

  // ── Safe additions ────────────────────────────────────────────────────────
  if (safeCount > 0) {
    lines.push(`### [SAFE] Additions / Expansions: ${safeCount}`);
    lines.push('');
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const mode = config.mode === 'warn' ? 'advisory' : 'strict';
  const hasBlockingIssues =
    breaking.length > 0 ||
    (config.failOnWarnings && warnings.length > 0);

  if (hasBlockingIssues && config.mode !== 'warn') {
    lines.push('> **[STRICT MODE]** This PR introduces breaking API changes.');
    lines.push('> If intentional, document in your CHANGELOG before merging.');
    lines.push('');
  } else if (breaking.length === 0 && warnings.length === 0) {
    lines.push('> **[PASSED]** API contract is intact. Safe to merge.');
    lines.push('');
  }

  // Short display reference for SHAs / branch names
  const baseShaDisplay = abbreviate(result.baseSha ?? 'base');
  const headShaDisplay = abbreviate(result.headSha ?? 'head');

  lines.push('---');
  lines.push(
    `_Analyzed ${allChanges.length} total API surface change(s). ` +
    `Comparing \`${headShaDisplay}\` against \`${baseShaDisplay}\` ` +
    `· Mode: \`${mode}\`_`
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub API — find or create comment
// ─────────────────────────────────────────────────────────────────────────────

async function upsertComment(config: ReporterConfig, markdown: string): Promise<void> {
  const { githubToken, prNumber, repoSlug } = config;
  const commentsUrl = `${GITHUB_API_BASE}/repos/${repoSlug}/issues/${prNumber}/comments`;

  const headers: Record<string, string> = {
    'Authorization': `token ${githubToken}`,
    'Accept':        'application/vnd.github.v3+json',
    'Content-Type':  'application/json',
    'User-Agent':    'diff-guardian',
  };

  // Fetch up to 100 comments (single page is sufficient for most PRs)
  const listUrl = `${commentsUrl}?per_page=100`;
  const listRes = await fetch(listUrl, { headers });

  if (!listRes.ok) {
    throw new Error(
      `GitHub API error fetching PR comments (HTTP ${listRes.status}): ${listRes.statusText}. ` +
      `Ensure the workflow has \`pull-requests: write\` permission.`
    );
  }

  const comments = await listRes.json() as Array<{ id: number; url: string; body?: string }>;
  const existing = comments.find(c => c.body?.includes(COMMENT_MARKER));

  if (existing) {
    const updateRes = await fetch(existing.url, {
      method:  'PATCH',
      headers,
      body:    JSON.stringify({ body: markdown }),
    });
    if (!updateRes.ok) {
      throw new Error(
        `GitHub API error updating comment #${existing.id} (HTTP ${updateRes.status}): ${updateRes.statusText}`
      );
    }
    console.log(`[github-reporter] Updated existing PR comment #${existing.id}`);
  } else {
    const createRes = await fetch(commentsUrl, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ body: markdown }),
    });
    if (!createRes.ok) {
      throw new Error(
        `GitHub API error creating comment (HTTP ${createRes.status}): ${createRes.statusText}`
      );
    }
    console.log('[github-reporter] Created new PR comment.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a single FunctionChange as a Markdown table row.
 * Sanitizes all values to prevent table layout breakage.
 */
function formatTableRow(c: FunctionChange): string {
  const file       = sanitizeInline(c.file       || 'unknown');
  const line       = c.lineStart > 0 ? `:${c.lineStart}` : '';
  const name       = sanitizeInline(c.name       || '<anonymous>');
  const changeType = sanitizeInline(c.changeType || 'unknown');
  const message    = sanitizeInline(c.message    || changeType);

  return `| \`${file}${line}\` | **${name}** | \`${changeType}\` | ${message} |`;
}

/**
 * Sanitizes a string for use inside a Markdown table cell.
 * Pipe characters break the table layout.
 */
function sanitizeInline(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/**
 * Returns the first 7 chars for full SHAs, or the original string for short
 * branch names (e.g. 'main', 'HEAD') to avoid weird truncation.
 */
function abbreviate(ref: string): string {
  // Full SHA hashes are 40 chars; anything ≥ 40 chars gets abbreviated.
  return ref.length >= 40 ? ref.substring(0, 7) : ref;
}
