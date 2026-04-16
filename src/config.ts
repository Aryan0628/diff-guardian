import * as fs from 'fs';
import * as path from 'path';

export interface DgConfig {
  baseBranch?: string;
  failOnWarnings?: boolean;

  // ── Tracer settings ─────────────────────────────────────────────────────
  /** Enable/disable call-site tracing (default: true) */
  enableTracer?: boolean;
  /** Max files returned by git grep per symbol (default: 500) */
  maxGrepResults?: number;
  /** Max recursive barrel file depth (default: 10) */
  maxBarrelDepth?: number;
  /** Max files to AST-parse for call sites per symbol (default: 100) */
  maxTracerFiles?: number;
}

export const CONFIG_FILE = 'dg.config.json';

export function loadConfig(repoRoot: string = process.cwd()): DgConfig {
  const configPath = path.join(repoRoot, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`[dg] Failed to parse ${CONFIG_FILE}: ${(e as Error).message}`);
    }
  }
  return {};
}

export function saveConfig(config: DgConfig, repoRoot: string = process.cwd()): void {
  const configPath = path.join(repoRoot, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
