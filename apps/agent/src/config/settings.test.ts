import { describe, expect, it } from 'bun:test';
import { validate } from './settings';
import { buildSource } from './source';

describe('agent config', () => {
  it('resolves with no panel set, so `version` and `probe` still work', () => {
    const config = validate({});
    expect(config.panelUrl).toBeUndefined();
    expect(config.reportIntervalMs).toBe(30_000);
  });

  it('refuses a panel URL that is not one', () => {
    expect(() => validate({ PANEL_URL: 'not-a-url' })).toThrow();
  });

  it('refuses a report interval below a second', () => {
    expect(() => validate({ REPORT_INTERVAL_MS: '10' })).toThrow();
  });
});

/**
 * The precedence is the contract: a one-off flag has to beat the environment, or
 * debugging a host means editing a 0600 file it wrote.
 */
describe('settings precedence', () => {
  it('prefers a flag over the environment', () => {
    process.env['PANEL_URL'] = 'http://from-env:3000';
    try {
      const source = buildSource(['--panel-url', 'http://from-flag:3000']);
      expect(validate(source).panelUrl).toBe('http://from-flag:3000');
    } finally {
      delete process.env['PANEL_URL'];
    }
  });

  it('falls back to the environment when no flag is given', () => {
    process.env['AGENT_TOKEN'] = 'from-env';
    try {
      expect(validate(buildSource([])).token).toBe('from-env');
    } finally {
      delete process.env['AGENT_TOKEN'];
    }
  });
});
