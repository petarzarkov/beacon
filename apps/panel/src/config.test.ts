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
    expect(config.database.file).toBe(':memory:');
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
});
