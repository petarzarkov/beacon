import { timingSafeEqual } from 'node:crypto';

/**
 * How a host proves it is allowed to become an agent, and how the identity it
 * gets back is stored.
 *
 * Two credentials, because they answer different questions. The **enrolment
 * token** is fleet-wide and buys exactly one thing: the right to create an
 * agent. The **agent token** is issued per host at enrolment and is what every
 * later call presents. Separating them is what makes revoking one machine
 * possible without touching the other thirty.
 */

/** 256 bits, hex. Long enough that guessing is not a strategy. */
export const mintToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

export const hashToken = (token: string): string =>
  new Bun.CryptoHasher('sha256').update(token).digest('hex');

/**
 * Constant time, and length-safe. `timingSafeEqual` throws on a length mismatch,
 * which would itself leak the length, so both sides are hashed to a fixed width
 * first.
 */
export const tokenMatches = (
  presented: string | null,
  expected: string,
): boolean => {
  if (presented === null || expected === '') return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(hashToken(expected), 'hex');
  return timingSafeEqual(a, b);
};

/** Distinguishes a grant from the shared token without parsing it. */
const GRANT_PREFIX = 'g1';

/**
 * A **deployment grant**: an enrolment credential scoped to one address and a
 * few minutes.
 *
 * A delegated install has to hand the target machine something it can enrol
 * with, and handing over the fleet-wide token would mean every managed host
 * carries the credential that admits any host. This is the alternative, and it
 * needs no storage: the panel signs `address|expiry` with its own secret and
 * verifies the signature on the way back, so a leaked grant admits one address
 * for the rest of its window and nothing else, ever.
 *
 * Not single use - that would need a table and a write on the hot enrolment
 * path. Scoped and expiring is the property that matters: the window is minutes
 * and the audience is one machine that is being given an agent anyway.
 */
export const mintGrant = (
  secret: string,
  address: string,
  expiresAtMs: number,
): string => {
  const claim = `${GRANT_PREFIX}.${expiresAtMs}.${address}`;
  return `${claim}.${sign(secret, claim)}`;
};

export const isGrant = (token: string): boolean =>
  token.startsWith(`${GRANT_PREFIX}.`);

export interface GrantCheck {
  readonly ok: boolean;
  /** Why not, for the log. Never returned to the caller: it would be an oracle. */
  readonly reason?: string;
  readonly address?: string;
}

/**
 * Verified in one order on purpose: signature first, then expiry, then audience.
 * Checking the claims of an unsigned string would be reading an attacker's own
 * assertions about itself.
 */
export const verifyGrant = (
  secret: string,
  token: string,
  sourceAddress: string | null,
  now: number,
): GrantCheck => {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== GRANT_PREFIX) {
    return { ok: false, reason: 'malformed' };
  }
  const [, expiry, address, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  const expected = sign(secret, `${GRANT_PREFIX}.${expiry}.${address}`);
  if (!constantTimeHex(signature, expected)) {
    return { ok: false, reason: 'bad signature' };
  }
  const expiresAtMs = Number(expiry);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    return { ok: false, reason: 'expired', address };
  }
  // The grant names the host it was minted for, so an agent that copied one off
  // a neighbour cannot spend it. `null` is a panel with no proxy configured, and
  // enrolling then rests on the signature and the window alone.
  if (sourceAddress !== null && sourceAddress !== address) {
    return { ok: false, reason: `issued for ${address}`, address };
  }
  return { ok: true, address };
};

const sign = (secret: string, claim: string): string =>
  new Bun.CryptoHasher('sha256', secret).update(claim).digest('hex');

const constantTimeHex = (a: string, b: string): boolean => {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};
