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
import { SUPPORTED_EXTENSIONS, EXCLUDED_PATH_SEGMENTS, EXCLUDED_FILE_SUFFIXES } from '../core/constants';
import { FileDiff } from '../core/types';
const execAsync = promisify(exec);

// 10MB limit
const MAX_BUFFER = 10 * 1024 * 1024;


/**
 * Extracts the full source text for every changed file between two Git refs.
 * Returns one FileDiff per changed file that matches a supported extension.
 *
 * @param baseSha  - base ref  (branch name, tag, or full SHA)
 * @param headSha  - head ref  (branch name, tag, or full SHA)
 * @param repoRoot - absolute path to the repo root (defaults to cwd)
 */

export async function extractGitSources(
  baseSha:  string,
  headSha:  string,
  repoRoot: string = process.cwd(),
): Promise<FileDiff[]> {
  if (!baseSha?.trim() || !headSha?.trim()) {
    throw new Error('[git-diff] baseSha and headSha are required');
  }

  const { stdout: nameStatus } = await execAsync(
    `git diff --name-status ${baseSha} ${headSha}`,
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

  // Fetch full source text from git object store
  // Both calls run independently — no sequential dependency
  const [oldSource, newSource] = await Promise.all([
    isNew     ? Promise.resolve('') : runGitShow(baseSha, oldPath, repoRoot),
    isDeleted ? Promise.resolve('') : runGitShow(headSha, newPath, repoRoot),
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
 * Fetches the full file content at a given Git ref.
 * Distinguishes expected misses (file absent at that ref) from real failures.
 */
async function runGitShow(
  sha:      string,
  filePath: string,
  repoRoot: string,
): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `git show ${sha}:${filePath}`,
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
      `git show ${sha}:${filePath} failed — ${stderr.trim() || error.message}`,
    );
  }
}

function isTargetFile(filePath: string): boolean {
  const ext = path.extname(filePath);

  if (!SUPPORTED_EXTENSIONS.has(ext)) return false;

  if (EXCLUDED_FILE_SUFFIXES.some(s => filePath.endsWith(s))) return false;

  const segments = filePath.split(/[\\/]/);
  if (segments.some(seg => EXCLUDED_PATH_SEGMENTS.has(seg))) return false;

  return true;
}