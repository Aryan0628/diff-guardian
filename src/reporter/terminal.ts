/**
 * src/reporter/terminal.ts
 *
 * THE TERMINAL REPORTER.
 * Renders the full pipeline result to stdout for local CLI and pre-push hook usage.
 *
 * Edge cases handled:
 *  - null / undefined `result` fields (defensive access throughout)
 *  - `change.message` may be undefined — falls back to change type label
 *  - `change.file` may be an empty string — falls back to 'unknown file'
 *  - `change.lineStart` may be 0 or undefined — omitted in that case
 *  - `change.name` may be empty — falls back to '<anonymous>'
 *  - safeCount can never go below 0 (clamped)
 *  - `failOnWarnings` mode: warnings are printed before the breaking footer
 *  - Quiet mode: suppresses all output
 *  - No chalk if NO_COLOR / CI=true env var is set (chalk respects this natively)
 */

import chalk from 'chalk';
import { AnalysisResult, FunctionChange } from '../core/types';
import { Reporter, ReporterConfig } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DIVIDER = chalk.dim('─'.repeat(60));

// ─────────────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────────────

export const TerminalReporter: Reporter = {
  async render(result: AnalysisResult, config: ReporterConfig): Promise<void> {
    // ── Guard: quiet mode ────────────────────────────────────────────────────
    if (config.quiet) return;

    // ── Guard: malformed result ──────────────────────────────────────────────
    if (!result) {
      console.error(chalk.red('[terminal-reporter] Received null result — pipeline error upstream.'));
      return;
    }

    const breaking  = Array.isArray(result.breaking)  ? result.breaking  : [];
    const warnings  = Array.isArray(result.warnings)  ? result.warnings  : [];
    const allChanges = Array.isArray(result.apiChanges) ? result.apiChanges : [];

    const safeCount = Math.max(0, allChanges.length - breaking.length - warnings.length);
    const baseSha   = result.baseSha ?? 'unknown';
    const headSha   = result.headSha ?? 'HEAD';

    // ── Header ───────────────────────────────────────────────────────────────
    console.log('\n' + chalk.bold.blue('Diff-Guardian API Analysis'));
    console.log(chalk.dim(`Base: ${baseSha} → Head: ${headSha}`));
    console.log(DIVIDER);
    console.log();

    // ── Breaking changes ─────────────────────────────────────────────────────
    if (breaking.length > 0) {
      console.log(chalk.bold.red(`[BREAKING] Changes (${breaking.length})`));
      for (const change of breaking) {
        printChange(change, 'red');
      }
      console.log();
    }

    // ── Warnings ─────────────────────────────────────────────────────────────
    if (warnings.length > 0) {
      console.log(chalk.bold.yellow(`[WARNING] Non-Breaking Issues (${warnings.length})`));
      for (const change of warnings) {
        printChange(change, 'yellow');
      }
      console.log();
    }

    // ── Safe additions ───────────────────────────────────────────────────────
    if (safeCount > 0) {
      console.log(chalk.bold.green(`[SAFE] Additions / Expansions (${safeCount})`));
      console.log(chalk.dim('   Identified harmless API expansions.'));
      console.log();
    }

    // ── Zero changes ─────────────────────────────────────────────────────────
    if (breaking.length === 0 && warnings.length === 0 && safeCount === 0) {
      console.log(chalk.green('No API surface changes detected. All clear.'));
      console.log();
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    console.log(DIVIDER);

    const hasBlockingIssues =
      breaking.length > 0 ||
      (config.failOnWarnings && warnings.length > 0);

    if (hasBlockingIssues) {
      if (config.mode === 'warn') {
        // Advisory mode — never blocks.
        console.log(chalk.bgYellow.black.bold(' [ADVISORY MODE] '));
        console.log(chalk.yellow('Breaking changes found, but pipeline is set to advisory mode (exit 0).'));
      } else {
        // Strict mode — blocks push / merge.
        console.log(chalk.bgRed.white.bold(' [STRICT MODE] '));
        console.log(chalk.red('Breaking changes found. Exiting with code 1.'));
        console.log();

        if (config.hookContext === 'pre-merge-commit') {
          // ── Merge context ─────────────────────────────────────────────
          console.log(
            chalk.white.bold('  ► To bypass this strict check, append ') +
            chalk.cyan.bold('--no-verify') +
            chalk.white.bold(' to your merge command.')
          );
          console.log(
            chalk.dim('    (e.g., git merge --no-verify <branch>)')
          );
          console.log();
          console.log(
            chalk.white.bold('  ► To undo this blocked merge, run:')
          );
          console.log(
            chalk.cyan.bold('      git merge --abort')
          );
          console.log(
            chalk.dim('    Document this change in your CHANGELOG before merging.')
          );
        } else {
          // ── Push context (default) ────────────────────────────────────
          console.log(
            chalk.white.bold('  ► To bypass this strict check, append ') +
            chalk.cyan.bold('--no-verify') +
            chalk.white.bold(' to your git command.')
          );
          console.log(
            chalk.dim('    (e.g., git push --set-upstream origin HEAD --no-verify)')
          );
          console.log(
            chalk.dim('    Document this change in your CHANGELOG before merging.')
          );
        }
      }
    } else if (warnings.length > 0) {
      // Warnings only, not failing
      console.log(chalk.bgYellow.black.bold(' [PASSED WITH WARNINGS] '));
      console.log(chalk.yellow(`${warnings.length} non-breaking issue(s) flagged. Review before merging.`));
    } else {
      // Full pass
      console.log(chalk.bgGreen.black.bold(' [PASSED] '));
      console.log(chalk.green('API contract is intact. Safe to merge.'));
    }
    console.log();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printChange(change: FunctionChange, color: 'red' | 'yellow'): void {
  const colorizer = color === 'red' ? chalk.red : chalk.yellow;

  // Defensive access — all fields may be missing in edge cases
  const name       = change.name?.trim()     || '<anonymous>';
  const file       = change.file?.trim()     || 'unknown file';
  const changeType = change.changeType       || 'unknown_change';
  const message    = change.message?.trim()  || describeChangeType(changeType);
  const line       = change.lineStart > 0 ? `:${change.lineStart}` : '';

  console.log(`  ${colorizer('►')} ${chalk.bold(name)} ${chalk.dim(`(${changeType})`)}`);
  console.log(`    ${chalk.cyan(`${file}${line}`)}`);
  console.log(`    ${message}`);

  // ── Call-site sub-items (populated by the JIT tracer) ──────────────────
  const callers = change.callers;
  if (callers && callers.length > 0) {
    const broken  = callers.filter(c => c.isBroken);
    const fixed   = callers.filter(c => c.isFixed);
    const indeterminate = callers.filter(c => c.isIndeterminate);
    const ok      = callers.filter(c => !c.isBroken && !c.isFixed && !c.isIndeterminate);

    console.log(chalk.dim(`    Affected call sites (${callers.length}):`));

    // Broken call sites — most important, shown first
    for (const site of broken) {
      const expected = change.requiredParamCount !== undefined && change.totalParamCount !== undefined
        ? change.requiredParamCount === change.totalParamCount
          ? `${change.requiredParamCount}`
          : `${change.requiredParamCount}-${change.totalParamCount}`
        : '?';
      console.log(
        `      ${chalk.red('❌')} ${chalk.cyan(`${site.file}:${site.lineStart}`)}` +
        chalk.red(` — provides ${site.argumentCount} arg(s), needs ${expected}`)
      );
    }

    // Fixed call sites — developer already updated these
    for (const site of fixed) {
      console.log(
        `      ${chalk.green('✅')} ${chalk.cyan(`${site.file}:${site.lineStart}`)}` +
        chalk.green(` — Fixed by developer in this PR`)
      );
    }

    // Indeterminate call sites — spread arguments, can't verify
    for (const site of indeterminate) {
      console.log(
        `      ${chalk.yellow('⚠️')} ${chalk.cyan(`${site.file}:${site.lineStart}`)}` +
        chalk.yellow(` — uses spread args (indeterminate)`)
      );
    }

    // OK call sites — correct arg count, not in diff
    if (ok.length > 0) {
      console.log(
        chalk.dim(`      ✓ ${ok.length} other call site(s) have correct arguments`)
      );
    }
  }

  // ── Visual separator between change entries ──────────────────────────────
  console.log();
}

/**
 * Fallback description when `message` is absent from a FunctionChange.
 * Should not happen in practice — rules always set message — but defensive.
 */
function describeChangeType(changeType: string): string {
  const descriptions: Record<string, string> = {
    param_removed:                'A parameter was removed from the public API.',
    param_reordered:              'Parameters were reordered, breaking positional callers.',
    required_param_added:         'A required parameter was added.',
    param_type_narrowed:          'A parameter type was narrowed, restricting accepted inputs.',
    optional_param_added:         'An optional parameter was added.',
    return_type_nullable:         'The return type is now nullable.',
    return_type_narrowed:         'The return type was narrowed.',
    symbol_unexported:            'A previously exported symbol was made internal.',
    symbol_deleted:               'A public symbol was removed entirely.',
    symbol_added:                 'A new symbol was added to the public API.',
    sync_to_async:                'A synchronous function was made asynchronous.',
    return_type_widened:          'The return type was widened (safe).',
    param_type_widened:           'A parameter type was widened (safe).',
    overload_removed:             'A function overload was removed.',
    overload_added:               'A function overload was added.',
    static_changed:               'The static modifier was changed.',
    interface_property_required:  'A previously optional interface property is now required.',
    interface_property_removed:   'A required interface property was removed.',
    enum_value_changed:           'An enum member value changed.',
    symbol_exported:              'A symbol was newly exported.',
    async_to_sync:                'An async function was made synchronous.',
    return_never:                 'The function now returns never.',
    default_value_changed:        'A default parameter value changed.',
    constructor_changed:          'The constructor signature changed.',
    visibility_narrowed:          'Visibility was narrowed.',
    param_mutability_narrowed:    'A parameter mutability was narrowed.',
    param_mutability_widened:     'A parameter mutability was widened (safe).',
    rest_parameter_changed:       'The rest parameter was changed.',
    generic_narrowed:             'A generic constraint was narrowed.',
  };
  return descriptions[changeType] ?? `Change detected: ${changeType}`;
}
