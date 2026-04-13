import type { Language } from './types';

export const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx',
  '.js', '.jsx',
  '.py',
  '.go',
  '.java',
  '.rs',
]);

export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.js':   'javascript',
  '.jsx':  'javascript',
  '.py':   'python',
  '.go':   'go',
  '.java': 'java',
  '.rs':   'rust',
};
export const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
  'third_party',
  'external',
  'generated',
  'generated-sources',
  'gen',
]);

export const EXCLUDED_FILE_SUFFIXES = [
  '.d.ts',
  '.d.tsx',
  '_pb2.py',
  '.pyi',
  '.min.js',
  'bundle.js',
];