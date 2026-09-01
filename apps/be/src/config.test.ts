import { describe, expect, it } from 'bun:test';
import { validate } from './config.js';

/**
 * The config function is the whole `ConfigModule` contract, and whatever it
 * throws is what boot fails with. These pin the two things that matter: a clean
 * checkout boots with no `.env` at all, and a bad value stops the process rather
 * than reaching a route.
 */
describe('config', () => {
  it('boots from an empty environment, so a clean checkout runs', () => {
    const config = validate({});
    expect(config.port).toBe(3000);
    // A file, not `:memory:`: the fleet is the state, and losing it on restart
    // would make every agent re-enrol as a stranger. The tests pass `:memory:`.
    expect(config.database.file).toBe('./data/panel.sqlite');
  });

  it('derives the offline window from the report interval when unset', () => {
    // Three missed reports, so one dropped request is not an outage. Raising the
    // interval must not silently leave the console calling agents offline.
    const config = validate({ AGENT_REPORT_INTERVAL_MS: '10000' });
    expect(config.agents.offlineAfterMs).toBe(30_000);
  });

  it('refuses an agent report interval below a second', () => {
    expect(() => validate({ AGENT_REPORT_INTERVAL_MS: '10' })).toThrow();
  });

  it('coerces PORT, because an environment only holds strings', () => {
    expect(validate({ PORT: '8080' }).port).toBe(8080);
  });

  it('refuses a port outside the range instead of binding to nothing', () => {
    expect(() => validate({ PORT: '70000' })).toThrow();
  });

  it('refuses a log level it does not know', () => {
    expect(() => validate({ LOG_LEVEL: 'chatty' })).toThrow();
  });

  const STRONG_SECRET = 'a'.repeat(64);

  it('refuses the dev auth secret once APP_URL is a real domain', () => {
    expect(() => validate({ APP_URL: 'https://panel.example.com' })).toThrow(
      /AUTH_SECRET/,
    );
  });

  it('refuses the dev auth secret behind a trusted proxy', () => {
    expect(() => validate({ TRUST_PROXY: 'true' })).toThrow(/AUTH_SECRET/);
  });

  it('accepts a real deployment once AUTH_SECRET is set', () => {
    const config = validate({
      APP_URL: 'https://panel.example.com',
      TRUST_PROXY: 'true',
      AUTH_SECRET: STRONG_SECRET,
    });
    expect(config.appUrl).toBe('https://panel.example.com');
    expect(config.trustProxy).toBe(true);
  });

  it('still boots locally on the dev secret, even with an explicit localhost APP_URL', () => {
    expect(() => validate({ APP_URL: 'http://localhost:3000' })).not.toThrow();
    expect(() => validate({ APP_URL: 'http://127.0.0.1:3000' })).not.toThrow();
  });
});
