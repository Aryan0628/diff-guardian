// src/parsers/git-diff.ts

export interface FileDiff {
  path: string;       // e.g., 'src/payment.ts'
  isNew: boolean;     // True if the file was just created
  isDeleted: boolean; // True if the file was deleted
  oldSource: string;  // The full text from the base branch (empty if isNew)
  newSource: string;  // The full text from the head branch (empty if isDeleted)
}