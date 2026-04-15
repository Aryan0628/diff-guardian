#!/usr/bin/env node
import minimist from 'minimist';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { runPipeline } from './pipeline';
import { ReporterConfig } from './reporter/types';
import { loadConfig } from './config';
import * as rules from './classifier/rules/index';

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

function printHelp() {
  console.log(`
Usage: npx dg <command> [options]

Commands:
  (no command)      The Smart Default: Auto-detects mode (CI/CD vs Local)
  compare <b> <h>   Compare specific base and head refs (e.g. v1.0 v2.0)
  list-rules        List all API classification rules and their severities

Options:
  --help, -h        Show this help message
  `);
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['help'],
    alias: { h: 'help' }
  });

  const command = args._[0];

  // 4. dg --help or -h or unrecognized
  if (args.help || (command && !['compare', 'list-rules'].includes(command))) {
    if (command && !['compare', 'list-rules'].includes(command)) {
      console.error(chalk.red(`Command not found: ${command}`));
    }
    printHelp();
    process.exit(0);
  }

  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);

  // 3. npx dg list-rules
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

  // 2. npx dg compare <base> <head>
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

  // 1. npx dg (The Smart Default)
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
