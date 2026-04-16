/**
 * The Diff-Guardian Source Provider
 *
 * This module is the entry point for the Source Stage of the pipeline.
 * It is responsible for extracting high-fidelity code snapshots from Git history,
 * ensuring that AST parsers operate on the exact state of the codebase at the
 * time of change.
 *
 * It handles Git plumbing commands and provides a clean interface for
 * reasoning about file-level changes.
 *
 * Key Capabilities:
 * - Change Detection: Uses `git diff --name-status` to identify modified, added, deleted, and renamed files.
 * - Snapshot Extraction: Leverages `git show` to fetch full source text from specific Git refs,
 *   ensuring that classification is based on historical truth rather than the current working tree.
 * - Working Tree Mode: When headSha is 'WORKING_TREE', reads files directly from disk
 *   to enable pre-commit analysis of uncommitted changes.
 * - Staged Mode: When headSha is 'STAGED', reads from the git index (staged files only)
 *   to enable pre-commit hook integration.
 * - Path Scoping: Optional pathFilter restricts analysis to a specific directory or file.
 * - Noise Filtering: Automatically excludes non-source directories (e.g., node_modules, dist) and
 *   unsupported file types based on a centralized system registry.
 * - Concurrency & Scalability: Processes file extractions in parallel with `Promise.allSettled`
 *   and manages large diffs with a 10MB memory buffer.
 *
 * @module SourceProvider
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { FileDiff } from '../core/types';
import { isTargetFile } from '../core/utils';
const execAsync = promisify(exec);

// 10MB limit
const MAX_BUFFER = 10 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Special ref constants — used to signal non-standard source modes
// ─────────────────────────────────────────────────────────────────────────────

/** When headSha is WORKING_TREE, read "new" source from the filesystem. */
export const WORKING_TREE = 'WORKING_TREE';

/** When headSha is STAGED, read "new" source from the git index. */
export const STAGED = 'STAGED';


/**
 * Extracts the full source text for every changed file between two Git refs.
 * Returns one FileDiff per changed file that matches a supported extension.
 *
 * Special headSha values:
 *   - 'WORKING_TREE' — compares baseSha against uncommitted files on disk
 *   - 'STAGED'       — compares baseSha against staged files (git add)
 *
 * @param baseSha    - base ref  (branch name, tag, or full SHA)
 * @param headSha    - head ref  (branch name, tag, SHA, WORKING_TREE, or STAGED)
 * @param repoRoot   - absolute path to the repo root (defaults to cwd)
 * @param pathFilter - optional path prefix to restrict analysis scope
 */

export async function extractGitSources(
  baseSha:     string,
  headSha:     string,
  repoRoot:    string = process.cwd(),
  pathFilter?: string,
): Promise<FileDiff[]> {
  if (!baseSha?.trim() || !headSha?.trim()) {
    throw new Error('[git-diff] baseSha and headSha are required');
  }

  // ── Build the git diff command based on mode ────────────────────────────
  let diffCmd: string;

  if (headSha === WORKING_TREE) {
    // Compare baseSha against working tree (uncommitted files)
    diffCmd = `git diff --name-status ${baseSha}`;
  } else if (headSha === STAGED) {
    // Compare baseSha against staged index (git add'd files)
    diffCmd = `git diff --name-status --cached ${baseSha}`;
  } else {
    // Standard: compare two committed refs
    diffCmd = `git diff --name-status ${baseSha} ${headSha}`;
  }

  // Append path filter if provided (e.g., -- src/payments)
  if (pathFilter) {
    diffCmd += ` -- ${pathFilter}`;
  }

  const { stdout: nameStatus } = await execAsync(
    diffCmd,
    { maxBuffer: MAX_BUFFER, cwd: repoRoot },
  );

  const lines = nameStatus.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  const settled = await Promise.allSettled(
    lines.map(line => processLine(line, baseSha, headSha, repoRoot)),
  );

  const diffs: FileDiff[] = [];

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value !== null) diffs.push(outcome.value);
      // null = file was filtered out (unsupported extension) — silent skip
    } else {
      // Real failure — log but don't crash the entire run
      console.warn('[git-diff] skipped file due to error:', outcome.reason?.message ?? outcome.reason);
    }
  }

  return diffs;
}

/**
 * Parses a single --name-status line into a FileDiff.
 * Returns null for files that should be skipped (unsupported extension).
 */
async function processLine(
  line:     string,
  baseSha:  string,
  headSha:  string,
  repoRoot: string,
): Promise<FileDiff | null> {

  // Git uses TAB as the delimiter — never split on \s+ (breaks paths with spaces)
  const parts  = line.split('\t');
  const status = parts[0][0]; // First char: M, A, D, R, C, T, U, X

  let oldPath = parts[1];
  let newPath = parts[1];

  // R (rename) and C (copy) have two paths: [status, oldPath, newPath]
  const isRenamed = status === 'R' || status === 'C';
  if (isRenamed && parts.length === 3) {
    oldPath = parts[1];
    newPath = parts[2];
  }

  // Deleted files: the relevant path is the old one
  const activePath = status === 'D' ? oldPath : newPath;

  // Filter out unsupported file types early — before any git calls
  if (!isTargetFile(activePath)) return null;

  const isNew     = status === 'A';
  const isDeleted = status === 'D';

  // Fetch full source text — mode-aware
  const [oldSource, newSource] = await Promise.all([
    isNew     ? Promise.resolve('') : runGitShow(baseSha, oldPath, repoRoot),
    isDeleted ? Promise.resolve('') : getNewSource(headSha, newPath, repoRoot),
  ]);

  const ext = path.extname(activePath).slice(1);

  return {
    path:      activePath,
    language:  ext,
    isNew,
    isDeleted,
    isRenamed,
    oldPath,
    oldSource,
    newSource,
  };
}

/**
 * Gets the "new" source content based on the head mode.
 *
 * - WORKING_TREE: reads directly from the filesystem
 * - STAGED:       reads from the git index via `git show :path`
 * - Otherwise:    reads from the git object store via `git show ref:path`
 */
async function getNewSource(
  headSha:  string,
  filePath: string,
  repoRoot: string,
): Promise<string> {
  if (headSha === WORKING_TREE) {
    // Read directly from disk
    const absolutePath = path.resolve(repoRoot, filePath);
    try {
      return fs.readFileSync(absolutePath, 'utf-8');
    } catch (error: any) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }

  if (headSha === STAGED) {
    // Read from the git index (staged snapshot)
    // `:path` is git's syntax for "the version in the index"
    return runGitShow('', `:${filePath}`, repoRoot);
  }

  // Standard: read from a committed ref
  return runGitShow(headSha, filePath, repoRoot);
}

/**
 * Fetches the full file content at a given Git ref.
 * Distinguishes expected misses (file absent at that ref) from real failures.
 */
async function runGitShow(
  sha:      string,
  filePath: string,
  repoRoot: string,
): Promise<string> {
  // For staged mode, filePath is already prefixed with ':'
  const ref = sha ? `${sha}:${filePath}` : filePath;

  try {
    const { stdout } = await execAsync(
      `git show ${ref}`,
      { maxBuffer: MAX_BUFFER, cwd: repoRoot },
    );
    return stdout;
  } catch (error: any) {
    const stderr: string = error.stderr ?? '';

    // Expected: file genuinely did not exist at this SHA
    // git exit code 128 covers "path does not exist in rev"
    const isExpectedMiss =
      stderr.includes('does not exist in')  ||
      stderr.includes('Path')               ||
      stderr.includes('exists on disk')     ||
      error.code === 128;

    if (isExpectedMiss) return '';

    // Unexpected: real infrastructure failure — bubble up so Promise.allSettled captures it
    throw new Error(
      `git show ${ref} failed — ${stderr.trim() || error.message}`,
    );
  }
}

// isTargetFile is now imported from '../core/utils' — single source of truth
// shared between git-diff.ts and the JIT scanner