#!/usr/bin/env node
/**
 * src/cli.ts
 *
 * THE DIFF-GUARDIAN CLI.
 *
 * The single entry point for all developer interactions with the
 * Diff-Guardian API contract enforcement engine.
 *
 * Commands:
 *   (default)                  Smart mode — auto-detects CI vs local
 *   check                     Analyze uncommitted working tree changes
 *   check --staged            Analyze only staged (git add'd) files
 *   check <path>              Scope analysis to a specific directory
 *   compare <base> [head]     Compare two git refs (branches, tags, commits)
 *   trace <symbol>            Show all importers and call sites of a symbol
 *   rules                     List all API classification rules
 *   init                      Scaffold config file + GitHub Actions workflow
 *
 * @module CLI
 */

import minimist from 'minimist';
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runPipeline } from './pipeline';
import { ReporterConfig } from './reporter/types';
import { loadConfig, CONFIG_FILE } from './config';
import * as rules from './classifier/rules/index';
import { WORKING_TREE, STAGED } from './parsers/git-diff';
import { JITScanner, createDefaultTracerConfig } from './tracer';

// ─────────────────────────────────────────────────────────────────────────────
// Known commands — used for routing and unknown-command detection
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_COMMANDS = ['check', 'compare', 'trace', 'rules', 'init', 'list-rules'];

// ─────────────────────────────────────────────────────────────────────────────
// Git helpers
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultBranch(): string {
  try {
    const output = execSync("git remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p'", { encoding: 'utf-8' }).trim();
    if (output) return output;
  } catch (e) {
    // Ignore error
  }

  try {
    const branchesOutput = execSync("git branch --format='%(refname:short)'", { encoding: 'utf-8' });
    const branches = branchesOutput.split('\n').map(b => b.trim());
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';

    const current = execSync("git branch --show-current", { encoding: 'utf-8' }).trim();
    const other = branches.find(b => b && b !== current);
    if (other) return other;
  } catch(e) {
    // Ignore error
  }
  return 'main';
}

function getPrNumber(): number | undefined {
  if (process.env.GITHUB_REF) {
    const match = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/);
    if (match) return parseInt(match[1], 10);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Help text
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${chalk.bold.blue('Diff-Guardian')} — API Contract Enforcement Engine

${chalk.bold('Usage:')} npx dg <command> [options]

${chalk.bold('Commands:')}

  ${chalk.cyan('(no command)')}                     Smart Default: auto-detects CI vs local mode
                                    CI  → compares PR base to merge commit
                                    Local → compares default branch to HEAD

  ${chalk.cyan('check')}                            What did I break? Analyzes uncommitted files
  ${chalk.cyan('check --staged')}                   What am I about to commit? Staged files only
  ${chalk.cyan('check <path>')}                     Scope check to a directory (e.g., src/payments)

  ${chalk.cyan('compare <base> [head]')}            Compare two git refs (branches, tags, commit SHAs)
                                    If head is omitted, defaults to HEAD
                                    Examples:
                                      npx dg compare main
                                      npx dg compare main feature-branch
                                      npx dg compare v1.0.0 v2.0.0
                                      npx dg compare HEAD~3 HEAD

  ${chalk.cyan('trace <symbol>')}                   Who uses this function? Shows all importers
                                    and call sites for a symbol across the repo
                                    Example: npx dg trace processPayment

  ${chalk.cyan('rules')}                            List all API classification rules

  ${chalk.cyan('init')}                             Scaffold config file + GitHub Actions workflow

${chalk.bold('Options:')}

  ${chalk.cyan('--help, -h')}                       Show this help message
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Init scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_TEMPLATE = `name: "Diff-Guardian"

on:
  pull_request:
    branches: [ "main", "master" ]

permissions:
  contents: read
  pull-requests: write

jobs:
  analyze:
    name: API Contract Audit
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install Dependencies
        run: npm ci

      - name: Build WASM Grammars
        run: npm run build:grammars

      - name: Build
        run: npm run build

      - name: Run Diff-Guardian
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: npx dg
`;

const DEFAULT_CONFIG = {
  baseBranch: 'main',
  failOnWarnings: false,
};

function runInit(repoRoot: string): void {
  console.log(chalk.bold.blue('\nDiff-Guardian Init\n'));

  let created = 0;
  let skipped = 0;

  // ── 1. Scaffold GitHub Actions workflow ──────────────────────────────────
  const workflowDir  = path.join(repoRoot, '.github', 'workflows');
  const workflowPath = path.join(workflowDir, 'diff-guardian.yml');

  if (fs.existsSync(workflowPath)) {
    console.log(chalk.dim(`  [skip] ${path.relative(repoRoot, workflowPath)} already exists.`));
    skipped++;
  } else {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(workflowPath, WORKFLOW_TEMPLATE, 'utf-8');
    console.log(chalk.green(`  [created] ${path.relative(repoRoot, workflowPath)}`));
    created++;
  }

  // ── 2. Scaffold dg.config.json ───────────────────────────────────────────
  const configPath = path.join(repoRoot, CONFIG_FILE);

  if (fs.existsSync(configPath)) {
    console.log(chalk.dim(`  [skip] ${CONFIG_FILE} already exists.`));
    skipped++;
  } else {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    console.log(chalk.green(`  [created] ${CONFIG_FILE}`));
    created++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log();
  if (created > 0) {
    console.log(chalk.green.bold(`  Done. ${created} file(s) created, ${skipped} skipped.`));
    console.log(chalk.dim('  Commit these files and push to activate Diff-Guardian on your PRs.'));
  } else {
    console.log(chalk.yellow('  Nothing to do — all files already exist.'));
    console.log(chalk.dim('  Delete a file and re-run if you want to regenerate it.'));
  }
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: rules
// ─────────────────────────────────────────────────────────────────────────────

function runRules(): void {
  console.log(chalk.bold.blue('\nDiff-Guardian Rules\n'));
  for (const rawRule of Object.values(rules)) {
    const rule = rawRule as any;
    console.log(`  ${chalk.cyan(rule.id)} - ${chalk.bold(rule.name)} [Target: ${chalk.yellow(rule.target)}]`);
    console.log(`    ${chalk.dim(rule.description)}`);
    console.log();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: trace <symbol>
// ─────────────────────────────────────────────────────────────────────────────

async function runTrace(symbolName: string, repoRoot: string): Promise<void> {
  console.log(chalk.bold.blue(`\nDiff-Guardian Trace: ${chalk.white(symbolName)}\n`));
  console.log(chalk.dim('  Scanning repo for importers...\n'));

  const tracerConfig = createDefaultTracerConfig(repoRoot, 'HEAD');
  const scanner = new JITScanner(tracerConfig);

  try {
    const importers = await scanner.scan(symbolName, '');

    if (importers.length === 0) {
      console.log(chalk.yellow(`  No importers found for "${symbolName}".`));
      console.log(chalk.dim('  The symbol may not be exported, or no files import it.'));
      console.log();
      return;
    }

    console.log(chalk.green.bold(`  📍 ${symbolName} — ${importers.length} importer(s) found\n`));

    // Group by file
    const byFile = new Map<string, typeof importers>();
    for (const imp of importers) {
      const existing = byFile.get(imp.filePath) || [];
      existing.push(imp);
      byFile.set(imp.filePath, existing);
    }

    for (const [file, imps] of byFile) {
      console.log(`  ${chalk.cyan(file)}`);
      for (const imp of imps) {
        const alias = imp.localName !== imp.importedName
          ? chalk.dim(` as ${imp.localName}`)
          : '';
        const type = chalk.dim(`[${imp.importType}]`);
        console.log(`    L${imp.importLine}  ${chalk.white(imp.importedName)}${alias}  ${type}`);
      }
      console.log();
    }

    console.log(chalk.dim(`  Total: ${importers.length} import(s) across ${byFile.size} file(s)`));
    console.log();
  } catch (err: any) {
    console.error(chalk.red(`  Trace failed: ${err.message}`));
    process.exit(2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: check
// ─────────────────────────────────────────────────────────────────────────────

async function runCheck(
  repoRoot:    string,
  staged:      boolean,
  pathFilter?: string,
  failOnWarnings?: boolean,
  reportFile?: string,
  hookContext?: 'pre-push' | 'pre-merge-commit' | 'post-merge',
): Promise<number> {
  const mode = staged ? 'staged' : 'working tree';
  const headRef = staged ? STAGED : WORKING_TREE;

  console.log(chalk.bold.blue(`\nDiff-Guardian Check (${mode})\n`));

  if (pathFilter) {
    console.log(chalk.dim(`  Scope: ${pathFilter}\n`));
  }

  const reporterConfig: ReporterConfig = {
    mode: 'strict',
    format: 'terminal',
    quiet: false,
    failOnWarnings,
    reportFile,
    hookContext,
  };

  try {
    const exitCode = await runPipeline({
      baseSha: 'HEAD',
      headSha: headRef,
      repoRoot,
      config: reporterConfig,
      pathFilter,
    });
    return exitCode;
  } catch (e: any) {
    console.error(chalk.red(`\n Pipeline Error: ${e.message}`));
    return 2;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: compare <base> [head]
// ─────────────────────────────────────────────────────────────────────────────

async function runCompare(
  baseSha:  string,
  headSha:  string,
  repoRoot: string,
  failOnWarnings?: boolean,
  reportFile?: string,
  hookContext?: 'pre-push' | 'pre-merge-commit' | 'post-merge',
): Promise<number> {
  console.log(chalk.bold.blue(`\nDiff-Guardian Compare\n`));
  console.log(chalk.dim(`  Base: ${baseSha}`));
  console.log(chalk.dim(`  Head: ${headSha}\n`));

  const reporterConfig: ReporterConfig = {
    mode: 'strict',
    format: 'terminal',
    quiet: false,
    failOnWarnings,
    reportFile,
    hookContext,
  };

  try {
    const exitCode = await runPipeline({ baseSha, headSha, repoRoot, config: reporterConfig });
    return exitCode;
  } catch (e: any) {
    console.error(chalk.red(`\n Pipeline Error: ${e.message}`));
    return 2;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Default (no command)
// ─────────────────────────────────────────────────────────────────────────────

async function runSmartDefault(
  repoRoot: string,
  failOnWarnings?: boolean,
  reportFile?: string,
  hookContext?: 'pre-push' | 'pre-merge-commit' | 'post-merge',
): Promise<number> {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // ── CI/CD Mode ─────────────────────────────────────────────────────
    const reporterConfig: ReporterConfig = {
      mode: 'strict',
      format: 'github',
      quiet: false,
      githubToken: process.env.GITHUB_TOKEN,
      prNumber: getPrNumber(),
      repoSlug: process.env.GITHUB_REPOSITORY,
      failOnWarnings,
      reportFile,
      hookContext,
    };

    try {
      // GITHUB_BASE_REF is the bare branch name (e.g. 'main') — needs 'origin/' prefix
      // to be resolvable in the runner's git context.
      // GITHUB_HEAD_SHA is the actual PR head commit; GITHUB_SHA is a merge commit.
      const baseRef = process.env.GITHUB_BASE_REF;
      const baseSha = baseRef ? `origin/${baseRef}` : getDefaultBranch();
      const headSha = process.env.GITHUB_HEAD_SHA || process.env.GITHUB_SHA || 'HEAD';

      await runPipeline({ baseSha, headSha, repoRoot, config: reporterConfig });

      // Always exit 0 — classification results are advisory, never block the PR.
      return 0;
    } catch (e: any) {
      // Infrastructure failure (missing grammars, OOM, etc.) — NOT a clean advisory pass.
      // Exit 2 so the CI check turns red and the team knows something is broken.
      console.error(`Pipeline Error: ${e.message}`);
      return 2;
    }
  } else {
    // ── Local Mode ─────────────────────────────────────────────────────
    const baseSha = getDefaultBranch();
    const headSha = 'HEAD';

    const reporterConfig: ReporterConfig = {
      mode: 'strict',
      format: 'terminal',
      quiet: false,
      failOnWarnings,
      reportFile,
      hookContext,
    };

    try {
      return await runPipeline({ baseSha, headSha, repoRoot, config: reporterConfig });
    } catch (e: any) {
      console.error(chalk.red(`\n Pipeline Error: ${e.message}`));
      return 2;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['help', 'staged'],
    string: ['report-file'],
    alias: { h: 'help' },
  });

  const command    = args._[0];
  const reportFile = args['report-file'] || undefined;

  // ── Hook context (set by husky hooks via DG_HOOK env var) ────────────────
  const hookContext = (process.env.DG_HOOK as 'pre-push' | 'pre-merge-commit' | 'post-merge') || undefined;

  // ── Help ─────────────────────────────────────────────────────────────────
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // ── Unknown command ──────────────────────────────────────────────────────
  if (command && !KNOWN_COMMANDS.includes(command)) {
    console.error(chalk.red(`\n  Unknown command: "${command}"\n`));
    printHelp();
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);

  // ── npx dg init ──────────────────────────────────────────────────────────
  if (command === 'init') {
    runInit(repoRoot);
    process.exit(0);
  }

  // ── npx dg rules (or legacy: npx dg list-rules) ─────────────────────────
  if (command === 'rules' || command === 'list-rules') {
    runRules();
    process.exit(0);
  }

  // ── npx dg trace <symbol> ────────────────────────────────────────────────
  if (command === 'trace') {
    const symbolName = args._[1];
    if (!symbolName) {
      console.error(chalk.red('\n  Error: `trace` requires a symbol name.\n'));
      console.log('  Example: npx dg trace processPayment\n');
      process.exit(1);
    }
    await runTrace(symbolName, repoRoot);
    process.exit(0);
  }

  // ── npx dg check [--staged] [path] ──────────────────────────────────────
  if (command === 'check') {
    const staged = args.staged || false;
    const pathFilter = args._[1] || undefined; // optional path scope
    const exitCode = await runCheck(repoRoot, staged, pathFilter, config.failOnWarnings, reportFile, hookContext);
    process.exit(exitCode);
  }

  // ── npx dg compare <base> [head] ────────────────────────────────────────
  if (command === 'compare') {
    const baseSha = args._[1];
    const headSha = args._[2] || 'HEAD';

    if (!baseSha) {
      console.error(chalk.red('\n  Error: `compare` requires at least a base ref.\n'));
      console.log('  Examples:');
      console.log('    npx dg compare main');
      console.log('    npx dg compare main feature-branch');
      console.log('    npx dg compare v1.0.0 v2.0.0');
      console.log('    npx dg compare HEAD~3 HEAD\n');
      process.exit(1);
    }

    const exitCode = await runCompare(baseSha, headSha, repoRoot, config.failOnWarnings, reportFile, hookContext);
    process.exit(exitCode);
  }

  // ── npx dg (Smart Default) ──────────────────────────────────────────────
  if (!command) {
    const exitCode = await runSmartDefault(repoRoot, config.failOnWarnings, reportFile, hookContext);
    process.exit(exitCode);
  }
}

main();
