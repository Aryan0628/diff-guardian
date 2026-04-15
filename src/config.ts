import * as fs from 'fs';
import * as path from 'path';

export interface DgConfig {
  baseBranch?: string;
  failOnWarnings?: boolean;
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
