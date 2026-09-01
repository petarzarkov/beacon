import { describe, expect, it } from 'bun:test';
import { mintGrant, normalizeAddress, verifyGrant } from './enrolment.js';

const SECRET = 'test-secret-at-least-32-characters-long!!';

describe('normalizeAddress', () => {
  it('folds an IPv4-mapped IPv6 address back to its IPv4 form', () => {
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('::ffff:10.0.4.31')).toBe('10.0.4.31');
  });

  it('folds IPv6 loopback onto IPv4 loopback', () => {
    expect(normalizeAddress('::1')).toBe('127.0.0.1');
  });

  it('leaves a plain IPv4 address and a real IPv6 address untouched', () => {
    expect(normalizeAddress('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1');
  });

  it('passes null through', () => {
    expect(normalizeAddress(null)).toBeNull();
  });
});

describe('verifyGrant with a normalized source address', () => {
  const future = (): number => Date.now() + 60_000;

  it('accepts the address it was minted for', () => {
    const grant = mintGrant(SECRET, '10.0.4.31', future());
    expect(verifyGrant(SECRET, grant, '10.0.4.31', Date.now()).ok).toBe(true);
  });

  it('accepts once the mapped peer has been normalized to that address', () => {
    // The bug this guards: a grant for 127.0.0.1 checked against the mapped form
    // the socket reported was rejected. Normalizing the peer first is the fix.
    const grant = mintGrant(SECRET, '127.0.0.1', future());
    const peer = normalizeAddress('::ffff:127.0.0.1');
    expect(verifyGrant(SECRET, grant, peer, Date.now()).ok).toBe(true);
  });

  it('still rejects a genuinely different address', () => {
    const grant = mintGrant(SECRET, '10.0.4.31', future());
    const check = verifyGrant(SECRET, grant, '10.0.4.99', Date.now());
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('issued for');
  });

  it('skips the audience check when there is no source address', () => {
    const grant = mintGrant(SECRET, '10.0.4.31', future());
    expect(verifyGrant(SECRET, grant, null, Date.now()).ok).toBe(true);
  });
});
