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
 */

export interface FileDiff {
  path: string;       // e.g., 'src/payment.ts'
  isNew: boolean;     // True if the file was just created
  isDeleted: boolean; // True if the file was deleted
  oldSource: string;  // The full text from the base branch (empty if isNew)
  newSource: string;  // The full text from the head branch (empty if isDeleted)
}