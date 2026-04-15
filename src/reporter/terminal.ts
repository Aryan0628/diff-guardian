import chalk from 'chalk';
import { AnalysisResult, FunctionChange } from '../core/types';
import { Reporter, ReporterConfig } from './types';

export const TerminalReporter: Reporter = {
  async render(result: AnalysisResult, config: ReporterConfig): Promise<void> {
    if (config.quiet) return;

    console.log('\n' + chalk.bold.blue('Diff-Guardian API Analysis'));
    console.log(chalk.dim(`Base: ${result.baseSha} → Head: ${result.headSha}`));
    console.log();

    if (result.breaking.length > 0) {
      console.log(chalk.bold.red(`[BREAKING] Changes (${result.breaking.length})`));
      for (const change of result.breaking) {
        printChange(change, 'red');
      }
      console.log();
    }

    if (result.warnings.length > 0) {
      console.log(chalk.bold.yellow(`[WARNING] Non-Breaking Issues (${result.warnings.length})`));
      for (const change of result.warnings) {
        printChange(change, 'yellow');
      }
      console.log();
    }

    const safeCount = result.apiChanges.length - result.breaking.length - result.warnings.length;
    if (safeCount > 0) {
      console.log(chalk.bold.green(`[SAFE] Additions / Expansions (${safeCount})`));
      console.log(chalk.dim('   Identified harmless API expansions.'));
      console.log();
    }

    if (result.breaking.length === 0 && result.warnings.length === 0 && safeCount === 0) {
      console.log(chalk.green('No API surface changes detected.'));
      console.log();
    }

    // Footer
    if (result.breaking.length > 0) {
      if (config.mode === 'warn') {
        console.log(chalk.bgYellow.black.bold(' [ADVISORY MODE] '));
        console.log(chalk.yellow('Breaking changes found, but exiting with code 0.'));
      } else {
        console.log(chalk.bgRed.white.bold(' [STRICT MODE] '));
        console.log(chalk.red('Breaking changes found. Exiting with code 1.'));
        console.log(chalk.yellow('\nIf this breaking change is intentional, use the native bypass: `git push --no-verify`'));
      }
    } else {
      console.log(chalk.bgGreen.black.bold(' [PASSED] '));
    }
    console.log();
  }
};

function printChange(change: FunctionChange, color: 'red' | 'yellow') {
  const fileLink = chalk.cyan(`${change.file}:${change.lineStart}`);
  const symbol = chalk.bold(change.name);
  const colorizer = color === 'red' ? chalk.red : chalk.yellow;
  
  console.log(`  ${colorizer('►')} ${symbol} ${chalk.dim(`(${change.changeType})`)}`);
  console.log(`    ${fileLink}`);
  console.log(`    ${change.message}`);
}
