#!/usr/bin/env node
import minimist from 'minimist';
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runPipeline } from './pipeline';
import { ReporterConfig } from './reporter/types';
import { loadConfig, CONFIG_FILE } from './config';
import * as rules from './classifier/rules/index';

// ─────────────────────────────────────────────────────────────────────────────
// Known commands — used for both routing and unknown-command detection
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_COMMANDS = ['compare', 'list-rules', 'init'];

// ─────────────────────────────────────────────────────────────────────────────
// Git helpers
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultBranch(): string {
  try {
    // Attempt to get the remote HEAD branch
    const output = execSync("git remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p'", { encoding: 'utf-8' }).trim();
    if (output) return output;
  } catch (e) {
    // Ignore error
  }
  
  // Local fallback: try main, then master
  try {
    const branchesOutput = execSync("git branch --format='%(refname:short)'", { encoding: 'utf-8' });
    const branches = branchesOutput.split('\n').map(b => b.trim());
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
    
    // As a last-resort safety, grab the first available branch that isn't the current
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
// Init scaffolding
// ─────────────────────────────────────────────────────────────────────────────

/** The battle-tested workflow template — includes every hard-won fix. */
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

      - name: Build
        run: npm run build

      - name: Run Diff-Guardian
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
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
// Help
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: npx dg <command> [options]

Commands:
  (no command)      The Smart Default: Auto-detects mode (CI/CD vs Local)
  compare <b> <h>   Compare specific base and head refs (e.g. v1.0 v2.0)
  init              Scaffold GitHub Actions workflow + config file
  list-rules        List all API classification rules

Options:
  --help, -h        Show this help message
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['help'],
    alias: { h: 'help' }
  });

  const command = args._[0];

  // ── Help or unknown command ────────────────────────────────────────────────
  if (args.help || (command && !KNOWN_COMMANDS.includes(command))) {
    if (command && !KNOWN_COMMANDS.includes(command)) {
      console.error(chalk.red(`Command not found: ${command}`));
    }
    printHelp();
    process.exit(0);
  }

  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);

  // ── npx dg init ────────────────────────────────────────────────────────────
  if (command === 'init') {
    runInit(repoRoot);
    process.exit(0);
  }

  // ── npx dg list-rules ──────────────────────────────────────────────────────
  if (command === 'list-rules') {
    console.log(chalk.bold.blue('\nDiff-Guardian Rules\n'));
    for (const rawRule of Object.values(rules)) {
      const rule = rawRule as any;
      console.log(`  ${chalk.cyan(rule.id)} - ${chalk.bold(rule.name)} [Target: ${chalk.yellow(rule.target)}]`);
      console.log(`    ${chalk.dim(rule.description)}`);
      console.log();
    }
    process.exit(0);
  }

  // ── npx dg compare <base> <head> ──────────────────────────────────────────
  if (command === 'compare') {
    const baseSha = args._[1];
    const headSha = args._[2];
    
    if (!baseSha || !headSha) {
      console.error(chalk.red('Error: `compare` requires <base> and <head> arguments.'));
      console.log('Example: npx dg compare v1.0 v2.0');
      process.exit(1);
    }
    
    const reporterConfig: ReporterConfig = {
      mode: 'strict',
      format: 'terminal',
      quiet: false,
      failOnWarnings: config.failOnWarnings
    };

    try {
      const exitCode = await runPipeline({ baseSha, headSha, repoRoot, config: reporterConfig });
      process.exit(exitCode);
    } catch (e: any) {
      console.error(chalk.red(`\n Pipeline Error: ${e.message}`));
      process.exit(2);
    }
  }

  // ── npx dg (The Smart Default) ─────────────────────────────────────────────
  if (!command) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      // CI/CD Mode
      const reporterConfig: ReporterConfig = {
        mode: 'strict',
        format: 'github',
        quiet: false,
        githubToken: process.env.GITHUB_TOKEN,
        prNumber: getPrNumber(),
        repoSlug: process.env.GITHUB_REPOSITORY,
        failOnWarnings: config.failOnWarnings
      };

      try {
        const baseSha = process.env.GITHUB_BASE_REF || getDefaultBranch();
        const headSha = process.env.GITHUB_SHA || 'HEAD';
        
        await runPipeline({ baseSha, headSha, repoRoot, config: reporterConfig });
        
        // Always exit 0 to not block PR artificially (advisory only)
        process.exit(0);
      } catch (e: any) {
        console.error(`Pipeline Error: ${e.message}`);
        // Ensure the CI doesn't crash to keep PR green
        process.exit(0);
      }
    } else {
      // Local Mode
      const baseSha = getDefaultBranch();
      const headSha = 'HEAD';
      
      const reporterConfig: ReporterConfig = {
        mode: 'strict',
        format: 'terminal',
        quiet: false,
        failOnWarnings: config.failOnWarnings
      };

      try {
        const exitCode = await runPipeline({ baseSha, headSha, repoRoot, config: reporterConfig });
        process.exit(exitCode); // Exits 1 if breaking changes found.
      } catch (e: any) {
        console.error(chalk.red(`\n Pipeline Error: ${e.message}`));
        process.exit(2);
      }
    }
  }
}

main();
