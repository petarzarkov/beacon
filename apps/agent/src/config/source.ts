import type { ConfigSource } from '@dunx/core';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_PATH } from './settings.js';

/**
 * `key=value` per line, `#` comments. Not JSON, because an operator edits it on
 * a host with whatever is installed.
 */
const readConfigFile = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq !== -1) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
};

const FLAGS: Record<string, string> = {
  'panel-url': 'PANEL_URL',
  token: 'AGENT_TOKEN',
};

/**
 * The precedence, and it is the contract: flags beat the environment, which beats
 * the file `install` wrote. That order so a one-off `--panel-url` wins while
 * debugging a host, and a systemd drop-in can override without rewriting a 0600
 * file.
 */
export const buildSource = (argv: readonly string[]): ConfigSource => {
  const merged: Record<string, string> = {
    ...readConfigFile(CONFIG_PATH),
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    const at = argv.indexOf(`--${flag}`);
    const value = at === -1 ? undefined : argv[at + 1];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};
